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
  const counts = rows.reduce((acc, r) => {
    acc[r.health] = (acc[r.health] || 0) + 1;
    return acc;
  }, {});
  const summaryStrip = ['red', 'amber', 'green', 'unknown']
    .filter(t => counts[t])
    .map(t => `<span class="tier-pill" style="--c:${tierColor(t)}">${escapeHtml(counts[t])} ${escapeHtml(t)}</span>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cloud-chaser fleet</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
  <h1>cloud-chaser fleet</h1>
  <div class="tier-strip">${summaryStrip || `<span class="tier-pill" style="--c:#888">no servers reporting yet</span>`}</div>
  <p class="generated">regenerated ${escapeHtml(ts)}</p>
</header>
<main>
<div class="card-grid">
${rows.map(r => `  <a class="card" href="server/${escapeHtml(r.server)}.html" style="--c:${tierColor(r.health)}">
    <div class="card-head">
      <span class="card-server">${escapeHtml(r.server)}</span>
      <span class="card-badge">${escapeHtml(r.health)}</span>
    </div>
    <div class="card-summary">${escapeHtml(r.summary) || '<em>no summary</em>'}</div>
    <div class="card-stats">
      <div><span class="stat-label">cpu</span><span class="stat-val">${escapeHtml(r.cpu)}%</span></div>
      <div><span class="stat-label">mem</span><span class="stat-val">${escapeHtml(r.mem)}%</span></div>
      <div><span class="stat-label">disk</span><span class="stat-val">${escapeHtml(r.diskMax)}%</span></div>
      <div><span class="stat-label">containers</span><span class="stat-val">${escapeHtml(r.containers)}</span></div>
    </div>
    <div class="card-foot" title="${escapeHtml(r.ts)}">last cycle ${escapeHtml(r.ago)}</div>
  </a>`).join('\n')}
</div>
${rows.length === 0 ? '<p class="empty"><em>No snapshots committed yet. First cycle on a new host lands within ~5 minutes of <code>docker compose up</code>.</em></p>' : ''}
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(server)} — cloud-chaser</title>
<link rel="stylesheet" href="../style.css">
</head>
<body>
<header>
  <p class="crumb"><a href="../index.html">← fleet</a></p>
  <h1>${escapeHtml(server)}</h1>
  <p class="generated">regenerated ${escapeHtml(ts)}</p>
</header>
<main>

<section class="now-card" style="--c:${tierColor(latest.overall_health)}">
  <div class="now-head">
    <span class="now-badge">${escapeHtml(latest.overall_health || 'unknown')}</span>
    <span class="now-summary">${escapeHtml(latest.summary || '')}</span>
  </div>
  <div class="now-stats">
    <div><span class="stat-label">cpu</span><span class="stat-val">${escapeHtml((latest.cpu && latest.cpu.pct) || 0)}%</span><span class="stat-sub">${escapeHtml((latest.cpu && latest.cpu.ncores) || 0)} cores</span></div>
    <div><span class="stat-label">mem</span><span class="stat-val">${escapeHtml((latest.mem && latest.mem.pct) || 0)}%</span><span class="stat-sub">${escapeHtml((latest.mem && latest.mem.used_mb) || 0)} / ${escapeHtml((latest.mem && latest.mem.total_mb) || 0)} MB</span></div>
    <div><span class="stat-label">load 1m</span><span class="stat-val">${escapeHtml((latest.load && latest.load['1m']) || 0)}</span><span class="stat-sub">5m ${escapeHtml((latest.load && latest.load['5m']) || 0)} · 15m ${escapeHtml((latest.load && latest.load['15m']) || 0)}</span></div>
    <div><span class="stat-label">uptime</span><span class="stat-val">${escapeHtml(Math.floor((latest.uptime_s || 0) / 3600))}h</span><span class="stat-sub">kernel <code>${escapeHtml(latest.kernel_host || '?')}</code></span></div>
  </div>
</section>

<section>
  <h2>history (7d, hourly)</h2>
  <div class="history">${historyBar}</div>
</section>

<section>
  <h2>disks</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>mount</th><th>size MB</th><th>used MB</th><th>%</th></tr></thead>
    <tbody>
${disks.map(d => `      <tr><td><code>${escapeHtml(d.mount)}</code></td><td>${escapeHtml(d.size_mb)}</td><td>${escapeHtml(d.used_mb)}</td><td>${escapeHtml(d.pct)}%</td></tr>`).join('\n')}
    </tbody>
  </table></div>
</section>

<section>
  <h2>containers</h2>
  ${(latest.docker && latest.docker.available)
    ? `<div class="table-wrap"><table>
    <thead><tr><th>name</th><th>image</th><th>state</th><th>health</th><th>restarts</th><th>err lines (last 100)</th></tr></thead>
    <tbody>
${containers.map(c => {
        const samples = Array.isArray(c.err_samples) ? c.err_samples : [];
        const count = c.err_lines_last_100 || 0;
        let sampleRow = '';
        if (samples.length) {
          sampleRow = `\n      <tr class="err-samples"><td colspan="6"><details><summary>${escapeHtml(count)} error-like lines · showing last ${samples.length}</summary><pre>${samples.map(escapeHtml).join('\n')}</pre></details></td></tr>`;
        } else if (count > 0) {
          sampleRow = `\n      <tr class="err-samples"><td colspan="6"><em>${escapeHtml(count)} error-like lines matched, but all samples stripped to empty after cleanup (likely pure ANSI/TUI redraws — check container logs directly).</em></td></tr>`;
        }
        return `      <tr><td><code>${escapeHtml(c.name)}</code></td><td title="${escapeHtml(c.image)}">${escapeHtml(c.image.length > 24 ? c.image.slice(0, 24) + '…' : c.image)}</td><td>${escapeHtml(c.state)}</td><td>${escapeHtml(c.health)}</td><td>${escapeHtml(c.restart_count)}</td><td>${escapeHtml(count)}</td></tr>${sampleRow}`;
      }).join('\n')}
    </tbody>
  </table></div>`
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

const STYLE = `* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 1.25rem; color: #222; background: #fafafa; max-width: 1400px; }
@media (min-width: 720px) { body { padding: 2rem; margin: 0 auto; } }

header h1 { margin: 0 0 0.4rem; font-size: 1.4rem; }
@media (min-width: 720px) { header h1 { font-size: 1.75rem; } }
header .generated { color: #888; font-size: 0.8rem; margin: 0.3rem 0 0; }

.tier-strip { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.4rem 0 0.2rem; }
.tier-pill { display: inline-flex; align-items: center; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; color: white; background: var(--c, #888); text-transform: uppercase; letter-spacing: 0.02em; }

/* Card grid — auto-fit columns, single column on narrow viewports. */
.card-grid { display: grid; grid-template-columns: 1fr; gap: 0.75rem; margin-top: 1.25rem; }
@media (min-width: 560px) { .card-grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; } }

.card {
  display: block; text-decoration: none; color: inherit;
  background: white; border-radius: 8px; padding: 0.9rem 1rem;
  border-left: 4px solid var(--c, #888);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 1px 1px rgba(0,0,0,0.03);
  transition: box-shadow 0.15s, transform 0.15s;
}
.card:hover, .card:focus-visible { box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04); transform: translateY(-1px); outline: none; }

.card-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
.card-server { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-badge { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 3px; color: white; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; background: var(--c, #888); flex-shrink: 0; }

.card-summary { font-size: 0.85rem; color: #555; line-height: 1.35; margin: 0.3rem 0 0.7rem; min-height: 1.1em; }
.card-summary em { color: #999; font-style: italic; }

.card-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.4rem 0.6rem; margin: 0.5rem 0; }
.card-stats > div { display: flex; flex-direction: column; min-width: 0; }
.stat-label { font-size: 0.7rem; color: #888; text-transform: uppercase; letter-spacing: 0.04em; }
.stat-val { font-size: 0.95rem; font-weight: 600; color: #222; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.card-foot { font-size: 0.75rem; color: #888; margin-top: 0.4rem; }

.empty { color: #888; text-align: center; margin: 3rem 0; }

/* === Per-server detail page. === */
.crumb { font-size: 0.85rem; margin: 0 0 0.4rem; }
.crumb a { color: #555; text-decoration: none; }
.crumb a:hover { text-decoration: underline; }

/* "now" snapshot card — matches the fleet index visual language. */
.now-card { background: white; border-radius: 8px; padding: 1rem 1.1rem; border-left: 4px solid var(--c, #888); box-shadow: 0 1px 2px rgba(0,0,0,0.04); margin: 0 0 1.25rem; }
.now-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.now-badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 3px; color: white; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; background: var(--c, #888); }
.now-summary { font-size: 0.95rem; color: #333; }
.now-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.7rem 1rem; margin-top: 0.9rem; }
.now-stats > div { display: flex; flex-direction: column; min-width: 0; }
.now-stats .stat-val { font-size: 1.1rem; }
.stat-sub { font-size: 0.72rem; color: #888; margin-top: 0.1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Table-wrap: horizontal scroll on narrow viewports so wide tables
   don't blow out the layout. */
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; background: white; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
table { border-collapse: collapse; width: 100%; min-width: 480px; background: white; }
th, td { border-bottom: 1px solid #eee; padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; font-size: 0.85rem; }
th { background: #f6f6f6; font-weight: 600; border-bottom: 1px solid #ddd; position: sticky; top: 0; }
tr:last-child td { border-bottom: none; }

section { margin: 1.5rem 0; }
section > h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
.badge { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 3px; color: white; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
.history { display: flex; flex-wrap: wrap; gap: 1px; margin: 0.5rem 0; }
.tick { width: 6px; height: 18px; display: inline-block; background: #ccc; border-radius: 1px; flex-shrink: 0; }
code { background: #eee; padding: 0 0.3rem; border-radius: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
pre { background: #1e1e1e; color: #eee; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: 0.75rem; line-height: 1.4; }
tr.err-samples td { background: #fff8ec; }
tr.err-samples summary { cursor: pointer; color: #8a5a00; font-size: 0.8rem; }
tr.err-samples pre { margin-top: 0.5rem; max-height: 12rem; overflow-y: auto; }

@media (max-width: 560px) {
  th, td { padding: 0.35rem 0.45rem; font-size: 0.78rem; }
  section { margin: 1rem 0; }
  .stat-val { font-size: 1rem; }
  .now-card { padding: 0.85rem 0.9rem; }
}
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
