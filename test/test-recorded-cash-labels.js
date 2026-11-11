'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const F = require('../public/forecast'), H = require('../public/balance-history'), fx = require('./fixtures/recorded-cash-labels-data');
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
let checks = 0; const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const context = { Forecast: F, console, module: { exports: {} }, escapeHtml: require('./app-escape-html') };
vm.createContext(context); vm.runInContext(read('public/plan.js'), context);
const note = context.module.exports.currentCashScopeNote;
eq(note('Chequing A, Chequing B and Savings — as observed 2026-08-20. Business excluded.'),
  'Chequing A and Chequing B (designated Savings is reserve evidence, excluded from spendable cash) — as observed 2026-08-20. Business excluded.', 'current copy retains date and exclusions');
eq(note('No cash evidence.'), 'No cash evidence.', 'unrelated unavailable wording retained');
eq(note(null), '', 'missing note does not invent account evidence');
const planSource = read('public/plan.js');
eq(planSource.includes("$('hero-note').textContent = currentCashScopeNote(plan.startingCash.note)"), true, 'active Budget opening note corrected');
eq(planSource.includes('currentCashScopeNote(a)'), true, 'active Budget assumptions corrected');
const index = read('public/index.html');
eq((index.match(/id="balance-history"/g) || []).length, 1, 'one history mount and renderer');
eq(index.indexOf('id="recorded-balances"') < index.indexOf('id="road-ahead" hidden'), true, 'recorded evidence reachable outside legacy hidden section');
eq(index.includes('<summary>Recorded account balances</summary>'), true, 'native Budget evidence disclosure');
const data = fx.data(), before = JSON.stringify(data);
eq(F.startingCashAmount(data.plan), 1375, 'independent native Bills1215 plus Weekly160; Reserve973.58 excluded');
eq(F.deepDive(data).cashAmount, 1375, 'Deep Dive prints the identical native scope');
const advice = F.recommend(data.plan, data.meta.asOf, { debts: data.debts,
  operatingPlan: data.liveOverlay.operatingPlan, observedCash: data.liveOverlay.observedCash,
  currentPeriodActuals: data.liveOverlay.currentPeriodActuals });
eq(advice.paydayAllocation.liveCurrentBalance, 1215, 'Bills-only Current Balance remains separate');
for (const long of [false, true]) {
  const history = fx.history(long), original = JSON.stringify(history), points = H.spendableSeries(history);
  eq(points.map(p => p.balance), [2507.31, 2507.31], 'independent broader balances unchanged');
  const aggregate = H.accountRows(history).find(row => row.kind === 'aggregate');
  eq(aggregate.move.delta, 0, 'recorded transfer conserves broader cash');
  eq(aggregate.label, 'Recorded cash balances', 'history makes no spendable claim');
  const rendered = H.render(history);
  eq(rendered.includes('Spendable household cash'), false, 'obsolete history claim absent');
  eq(rendered.includes('does not show what is safe to spend'), true, 'account total not spending permission');
  eq(rendered.includes('<summary>Included accounts</summary>'), true, 'native keyboard disclosure');
  for (const snapshot of history.snapshots) {
    eq(rendered.includes('datetime="' + snapshot.asOf + '"'), true, 'scope qualified to exact reading date');
    eq(points.find(p => p.asOf === snapshot.asOf).includedAccounts.map(a => a.id), snapshot.spendableCoverage.expectedIds, 'only captured declared membership');
    for (const account of snapshot.accounts) eq(rendered.includes(account.label), true, 'all captured names retained');
  }
  eq(JSON.stringify(history), original, 'archived balances, deltas and coverage not rewritten');
}
const incomplete = fx.history(); incomplete.snapshots.forEach(s => { s.accounts.pop(); s.spendableCoverage.complete = false; });
eq(H.spendableSeries(incomplete).length, 0, 'missing member still withholds aggregate');
eq(H.render(incomplete).includes('Recorded cash balances'), false, 'incomplete render never labels total complete');
eq(H.accountRows(incomplete).length, 2, 'known individual chequing observations survive');
eq(H.render({ snapshots: [] }).includes('No dated account openings have been stored yet.'), true, 'empty history remains unavailable, not zero');
const changed = fx.history(); changed.snapshots[1].spendableCoverage.expectedIds = ['chequing-a', 'chequing-b'];
eq(H.accountRows(changed).find(r => r.kind === 'aggregate').move.sufficient, false, 'different membership does not invent trend');
const escaped = fx.history(); escaped.snapshots[1].accounts[2].label = 'Invented <reserve> & "scope"';
eq(H.render(escaped).includes('Invented &lt;reserve&gt; &amp; &quot;scope&quot;'), true, 'included names escaped in new disclosure');
eq(JSON.stringify(data), before, 'renderer and selectors leave canonical-shaped fixture immutable');
console.log('PASS recorded cash labels: ' + checks + ' assertions; native chequing scope, preserved recorded cash, dated membership, unchanged stocks');
