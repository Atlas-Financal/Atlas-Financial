'use strict';
// OD-3 (#821, owner 2026-11-11) on the payday cash glance: a dated or
// retained view shows the small "Last updated" line in place of the
// "Latest complete refresh ... Dated plan, not current balances" note
// whenever a Last updated line can print, and keeps the note when it cannot.
// Invented household only (test/fixtures/budget-surface-data.js), loaded
// through the existing Budget page VM harness (real app.js and plan.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const Fixture = require('./fixtures/budget-surface-data');
const Live = require('../scripts/live-plan');

let checks = 0;
const eq = (actual, expected, label) => { assert.deepStrictEqual(actual, expected, label); checks++; };
const yes = (actual, label) => { assert.ok(actual, label); checks++; };

const rendererFile = path.join(__dirname, 'test-atlas-077-malformed-amounts.js');
const marker = 'const budgetPage = createBudgetPage();';
const harness = fs.readFileSync(rendererFile, 'utf8');
yes(harness.includes(marker), 'Budget VM harness marker present');
const renderer = new Module(rendererFile, module); renderer.filename = rendererFile;
renderer.paths = Module._nodeModulePaths(__dirname);
renderer._compile(harness.split(marker)[0] + '\nmodule.exports = { createBudgetPage, strip };', rendererFile);
const page = renderer.exports.createBudgetPage();
const quiet = fn => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };

const SYNC = '2026-08-20T17:30:00.000Z';
const failure = { source: 'provider', qualified: false, checkedAt: null,
  attemptedAt: '2026-08-21T07:02:00.000Z', reason: 'provider-unavailable' };
const served = (() => {
  const p = Fixture.payload(); p.accounts.forEach(a => { a.plaid_last_successful_update = SYNC; });
  return quiet(() => Live.fromObservation({ data: Fixture.canonical(), payload: p, accountMap: Fixture.map, identity: Fixture.identity }).data);
})();
eq(served.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt, SYNC, 'fixture carries a successful-sync instant');
const retained = Live.withLatestCompleteRefresh({ data: served, checkedAt: Fixture.payload().fetchedAt }, failure);
const noSync = structuredClone(retained); delete noSync.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt;
const invalidSync = structuredClone(retained); invalidSync.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt = '2026-08-20';
const unapplied = structuredClone(retained); unapplied.liveOverlay.applied = false;

quiet(() => page.render(retained)); // load the real page context once
const call = (expr, overlay) => { page.context.__overlay = overlay; return vm.runInContext(expr, page.context); };
// Independent expectation: the household-time formatting written out here,
// not the page's own formatter.
const expectedTime = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: 'short',
  day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(SYNC));
const dated = overlay => call('latestCompleteRefreshNote(__overlay)', overlay);

// 1. With a Last updated line: the glance shows that line only.
const withLine = call('glanceUpdatedNote(null, __overlay)', retained.liveOverlay);
eq(withLine, 'Last updated ' + expectedTime, 'retained view with a successful-sync instant shows only the Last updated line');
yes(!/Latest complete refresh|Dated plan, not current balances/.test(withLine), 'no dated-plan note when Last updated can print');
// 2. Without one: the note stays (never a dated view with no freshness line).
for (const [label, overlay] of [['no sync instant', noSync.liveOverlay], ['date-only sync value', invalidSync.liveOverlay],
  ['unapplied overlay', unapplied.liveOverlay]]) {
  const note = call('glanceUpdatedNote(null, __overlay)', overlay);
  eq(note, dated(overlay), label + ': the dated-plan note stays');
  yes(/Dated plan, not current balances/.test(note), label + ': the note still discloses the dated view');
}
// 3. Byte proof on the printed glance: only the note text changes.
const alloc = { available: 1375, asOf: Fixture.AS_OF };
const glanceWith = call('cashGlanceHtml(' + JSON.stringify(alloc) + ', __overlay)', retained.liveOverlay);
const glanceWithout = call('cashGlanceHtml(' + JSON.stringify(alloc) + ', __overlay)', noSync.liveOverlay);
eq(glanceWith.replace('Last updated ' + expectedTime, '@'), glanceWithout.replace(dated(noSync.liveOverlay), '@'),
  'cash glance: only the note text is replaced; amount and markup are unchanged');
// 4. The Current Balance date line and its dated heading are unchanged.
const balanceWith = call('liveCurrentBalanceHtml({ liveCurrentBalance: 1215, asOf: "' + Fixture.AS_OF + '" }, __overlay, null)', retained.liveOverlay);
const balanceWithout = call('liveCurrentBalanceHtml({ liveCurrentBalance: 1215, asOf: "' + Fixture.AS_OF + '" }, __overlay, null)', noSync.liveOverlay);
eq(balanceWith, balanceWithout, 'Current Balance card (heading, amount, date line) is byte-identical with or without the sync line');
yes(balanceWith.includes('Balance at this refresh'), 'the dated balance heading stays');
// 5. Live (non-retained) views are untouched.
eq(call('glanceUpdatedNote(null, __overlay)', served.liveOverlay), call('glanceUpdatedNote(null, __overlay)', (() => {
  const o = structuredClone(served.liveOverlay); delete o.currentPeriodActuals.lastSuccessfulSyncAt; return o; })()),
  'a current (non-retained) view does not change with sync metadata');

console.log('PASS payday glance dated note (OD-3): ' + checks + ' checks');
