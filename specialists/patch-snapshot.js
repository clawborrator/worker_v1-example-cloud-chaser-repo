#!/usr/bin/env node
// Patch a snapshot file in place with overall_health + summary.
// The agent computes the tier and summary in its turn, then calls
// this helper so the JSON stays valid (hand-editing snapshots from
// the agent's turn is fragile — agents drift on commas, indentation,
// trailing whitespace).
//
// Usage:
//   node specialists/patch-snapshot.js <file> <health> <summary>

const fs = require('fs');

const [, , file, health, summary] = process.argv;

if (!file || !health || summary === undefined) {
  console.error('usage: patch-snapshot.js <file> <health> <summary>');
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
let snap;
try {
  snap = JSON.parse(raw);
} catch (err) {
  console.error('patch-snapshot: snapshot is not valid JSON:', err.message);
  console.error('falling back to error wrapper');
  snap = { error: 'snapshot_unparseable', raw_length: raw.length };
}

snap.overall_health = health;
snap.summary = summary;

fs.writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
console.log(`patched ${file}: ${health}`);
