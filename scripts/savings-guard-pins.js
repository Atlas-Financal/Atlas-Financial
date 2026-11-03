#!/usr/bin/env node
'use strict';
/* Savings consumer source guard: per-entry diff and re-pin helper.
 *
 *   node scripts/savings-guard-pins.js [--check]   print the per-entry diff against the
 *                                                  committed manifest; exit 1 on any difference
 *   node scripts/savings-guard-pins.js --write     update test/fixtures/savings-consumer-manifest.json
 *                                                  in place for the differing entries, print the diff
 *
 * The guard is computed by the contract's own computeGuard (test/lib/savings-consumer-contract.js);
 * this file holds no second implementation. CI and test-savings-consumer-contract.js keep comparing
 * the COMMITTED manifest with the source; nothing in CI calls --write. Running --write does not
 * discharge the review obligation: paste the printed diff into the merge card for the single review.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_REL = 'test/fixtures/savings-consumer-manifest.json';

// Every comparable entry of a guard: key -> { value, covers }. A value is a hash or a short
// structural string; covers says what the entry protects.
function entries(guard) {
  const out = new Map();
  const put = (key, value, covers) => out.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), covers });
  for (const [file, m] of Object.entries(guard.modules || {})) {
    put(file + ' [mode]', m.mode, 'how ' + file + ' is protected (function pins or whole module)');
    if (m.mode === 'module') put(file + ' [module]', m.sha256, 'the whole module source (' + m.reason + ')');
    else put(file + ' [residual]', m.residual, 'module-scope code outside the pinned functions (data and glue)');
    put(file + ' [deferred]', m.deferred || [], 'callbacks registered but never invoked by the capture');
    for (const p of m.pins || []) put(p.id, p.sha256, 'function or data binding ' + p.id.split('#')[1] + ' in ' + file);
  }
  for (const p of guard.selectorRegion || []) put('selector region: ' + p.id, p.sha256, 'selector region function ' + p.id.split('#')[1]);
  for (const [page, v] of Object.entries(guard.pages || {})) {
    put('page ' + page + ' [scripts]', v.scripts, 'script list the ' + page + ' page loads');
    put('page ' + page + ' [html]', v.html, 'the ' + page + ' page HTML');
  }
  for (const [f, h] of Object.entries(guard.machinery || {})) put('machinery: ' + f, h, 'review machinery file ' + f);
  return out;
}

function diff(oldGuard, newGuard) {
  const a = entries(oldGuard), b = entries(newGuard), rows = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(key), y = b.get(key);
    if (x && y && x.value === y.value) continue;
    rows.push({ key, old: x ? x.value : null, new: y ? y.value : null, covers: (y || x).covers,
      change: !x ? 'added' : !y ? 'removed' : 'changed' });
  }
  return rows;
}

const short = v => (v === null ? '(none)' : /^[0-9a-f]{64}$/.test(v) ? v.slice(0, 12) : v);
function format(rows) {
  return rows.map(r => `${r.change.toUpperCase()}  ${r.key}\n    old ${short(r.old)}  ->  new ${short(r.new)}\n    covers: ${r.covers}`).join('\n');
}

// deps: { root, computeGuard, inputs() } — injectable so the tests can run on a tiny invented tree.
async function main(argv, deps = {}, log = console.log) {
  const write = argv.includes('--write');
  if (write && argv.includes('--check')) { log('use either --check or --write, not both'); return 2; }
  const root = deps.root || ROOT;
  const manifestPath = path.join(root, MANIFEST_REL);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let compute = deps.computeGuard, inputs = deps.inputs;
  if (!compute) {
    compute = require('../test/lib/savings-consumer-contract.js').computeGuard;
    const Snapshot = require('./figures-snapshot.js');
    inputs = () => [Snapshot.loadCanonicalInputs(), ...Snapshot.loadInventedInputs().map(i => ({ data: i.doc.data, periods: i.doc.periods }))];
  }
  const guard = await compute(root, inputs());
  const rows = diff(manifest.guard, guard);
  if (!rows.length) { log('Savings guard pins: no differences from the committed manifest.'); return 0; }
  log(`Savings guard pins: ${rows.length} differing entr${rows.length === 1 ? 'y' : 'ies'}\n${format(rows)}`);
  if (!write) {
    log('\nNot written (--check). Review the Savings consumer inventory, then run with --write in the same push as the change.');
    return 1;
  }
  manifest.guard = guard;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
  log(`\nWrote ${MANIFEST_REL}. Paste the diff above into the merge card; the single review covers it.`);
  return 0;
}

module.exports = { main, diff, entries, format, MANIFEST_REL };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.stack || error); process.exitCode = 2; });
}
