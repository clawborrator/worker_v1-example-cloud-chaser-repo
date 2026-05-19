#!/usr/bin/env node
// render.js — regenerate public/index.html and public/server/<name>.html
// from data/<server>/latest.json + the 168-hour history per server.
//
// Deterministic over its input. Two concurrent workers running this
// against the same files produce byte-identical output, so we don't
// get commit churn from formatting drift.
//
// No npm dependencies — plain Node 18+.

const fs = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SERVER_DIR = path.join(PUBLIC_DIR, 'server');

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(SERVER_DIR, { recursive: true });

function safeRead(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function listServers() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(n => !n.startsWith('.'))
    .filter(n => fs.statSync(path.join(DATA_DIR, n)).isDirectory())
    .sort();
}

function loadHistory(server) {
  const dir = path.join(DATA_DIR, server);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'latest.json')
    .sort()
    .map(f => ({ name: f, snap: safeRead(path.join(dir, f)) }))
    .filter(x => x.snap);
}

function tierColor(t) {
  return { green: '#3a9a4a', amber: '#c4881e', red: '#c4392e' }[t] || '#888';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtAgo(iso) {
  if (!iso) return '?';
  const ts = Date.parse(iso);
  if (isNaN(ts)) return '?';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function renderIndex(rows) {
  const ts = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>cloud-chaser fleet</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
  <h1>cloud-chaser fleet</h1>
  <p class="generated">regenerated ${escapeHtml(ts)}</p>
</header>
<main>
<table class="fleet">
  <thead>
    <tr>
      <th>server</th>
      <th>health</th>
      <th>summary</th>
      <th>cpu</th>
      <th>mem</th>
      <th>disks (max)</th>
      <th>containers</th>
      <th>last cycle</th>
    </tr>
  </thead>
  <tbody>
${rows.map(r => `    <tr>
      <td><a href="server/${escapeHtml(r.server)}.html">${escapeHtml(r.server)}</a></td>
      <td><span class="badge" style="background:${tierColor(r.health)}">${escapeHtml(r.health)}</span></td>
      <td class="summary">${escapeHtml(r.summary)}</td>
      <td>${escapeHtml(r.cpu)}%</td>
      <td>${escapeHtml(r.mem)}%</td>
      <td>${escapeHtml(r.diskMax)}%</td>
      <td>${escapeHtml(r.containers)}</td>
      <td title="${escapeHtml(r.ts)}">${escapeHtml(r.ago)}</td>
    </tr>`).join('\n')}
  </tbody>
</table>
</main>
</body>
</html>
`;
}

function renderServer(server, latest, history) {
  const ts = new Date().toISOString();
  const containers = (latest.docker && latest.docker.containers) || [];
  const disks = latest.disks || [];
  const errors = latest.kernel_errors_last_hour || [];

  const historyBar = history.slice(-168).map(h => {
    const tier = h.snap.overall_health || 'unknown';
    return `<span class="tick" style="background:${tierColor(tier)}" title="${escapeHtml(h.snap.ts)} ${escapeHtml(tier)}"></span>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(server)} — cloud-chaser</title>
<link rel="stylesheet" href="../style.css">
</head>
<body>
<header>
  <h1>${escapeHtml(server)}</h1>
  <p class="generated">regenerated ${escapeHtml(ts)}</p>
  <p><a href="../index.html">← fleet</a></p>
</header>
<main>

<section>
  <h2>now</h2>
  <p>
    <span class="badge" style="background:${tierColor(latest.overall_health)}">${escapeHtml(latest.overall_health || 'unknown')}</span>
    ${escapeHtml(latest.summary || '')}
  </p>
  <ul>
    <li>cpu: ${escapeHtml((latest.cpu && latest.cpu.pct) || 0)}% (${escapeHtml((latest.cpu && latest.cpu.ncores) || 0)} cores)</li>
    <li>mem: ${escapeHtml((latest.mem && latest.mem.pct) || 0)}% (${escapeHtml((latest.mem && latest.mem.used_mb) || 0)} / ${escapeHtml((latest.mem && latest.mem.total_mb) || 0)} MB)</li>
    <li>load: ${escapeHtml((latest.load && latest.load['1m']) || 0)} / ${escapeHtml((latest.load && latest.load['5m']) || 0)} / ${escapeHtml((latest.load && latest.load['15m']) || 0)}</li>
    <li>uptime: ${escapeHtml(Math.floor((latest.uptime_s || 0) / 3600))}h</li>
    <li>kernel hostname: <code>${escapeHtml(latest.kernel_host || '?')}</code></li>
  </ul>
</section>

<section>
  <h2>history (7d, hourly)</h2>
  <div class="history">${historyBar}</div>
</section>

<section>
  <h2>disks</h2>
  <table>
    <thead><tr><th>mount</th><th>size MB</th><th>used MB</th><th>%</th></tr></thead>
    <tbody>
${disks.map(d => `      <tr><td><code>${escapeHtml(d.mount)}</code></td><td>${escapeHtml(d.size_mb)}</td><td>${escapeHtml(d.used_mb)}</td><td>${escapeHtml(d.pct)}%</td></tr>`).join('\n')}
    </tbody>
  </table>
</section>

<section>
  <h2>containers</h2>
  ${(latest.docker && latest.docker.available)
    ? `<table>
    <thead><tr><th>name</th><th>image</th><th>state</th><th>health</th><th>restarts</th><th>err lines (last 100)</th></tr></thead>
    <tbody>
${containers.map(c => `      <tr><td><code>${escapeHtml(c.name)}</code></td><td>${escapeHtml(c.image)}</td><td>${escapeHtml(c.state)}</td><td>${escapeHtml(c.health)}</td><td>${escapeHtml(c.restart_count)}</td><td>${escapeHtml(c.err_lines_last_100)}</td></tr>`).join('\n')}
    </tbody>
  </table>`
    : '<p><em>docker socket unreachable</em></p>'}
</section>

<section>
  <h2>kernel errors (last hour, last 50)</h2>
  ${errors.length
    ? `<pre>${errors.map(e => escapeHtml(e)).join('\n')}</pre>`
    : '<p><em>none</em></p>'}
</section>

</main>
</body>
</html>
`;
}

const STYLE = `body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #222; background: #fafafa; }
header h1 { margin-bottom: 0; }
header .generated { color: #888; font-size: 0.85rem; margin-top: 0.2rem; }
table { border-collapse: collapse; width: 100%; background: white; }
th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #f0f0f0; font-weight: 600; }
.badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 3px; color: white; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; }
.summary { font-size: 0.9rem; color: #444; }
.history { display: flex; gap: 1px; margin: 1rem 0; }
.tick { width: 8px; height: 18px; display: inline-block; background: #ccc; border-radius: 1px; }
code { background: #eee; padding: 0 0.3rem; border-radius: 2px; }
pre { background: #1e1e1e; color: #eee; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: 0.8rem; }
section { margin: 1.5rem 0; }
table.fleet td.summary { max-width: 30rem; }
`;

function main() {
  const servers = listServers();
  const rows = [];
  for (const server of servers) {
    const latest = safeRead(path.join(DATA_DIR, server, 'latest.json'));
    const history = loadHistory(server);
    if (!latest) continue;

    const diskMax = (latest.disks || []).reduce((m, d) => Math.max(m, d.pct || 0), 0);

    rows.push({
      server,
      health:    latest.overall_health || 'unknown',
      summary:   latest.summary || '',
      cpu:       (latest.cpu && latest.cpu.pct) || 0,
      mem:       (latest.mem && latest.mem.pct) || 0,
      diskMax,
      containers: ((latest.docker && latest.docker.containers) || []).length,
      ts:        latest.ts,
      ago:       fmtAgo(latest.ts),
    });

    fs.writeFileSync(
      path.join(SERVER_DIR, server + '.html'),
      renderServer(server, latest, history),
    );
  }

  rows.sort((a, b) => {
    const order = { red: 0, amber: 1, green: 2, unknown: 3 };
    return (order[a.health] - order[b.health]) || a.server.localeCompare(b.server);
  });

  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), renderIndex(rows));
  fs.writeFileSync(path.join(PUBLIC_DIR, 'style.css'), STYLE);

  console.log(`rendered fleet of ${rows.length} servers → ${PUBLIC_DIR}`);
}

main();
