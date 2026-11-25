'use strict';
/* The HELOC minimum's settlement derives from the paying-side evidence the Credit line reads (lead 13 on the live
 * contradiction after #1641: the Credit row read the HELOC minimum covered while currentPeriodAction.bills, nextDue and
 * nextPaymentOut still read it unverified and overdue). One authority: Dale's ruling (#821 7161929211, "It can be counted
 * when it leaves the bills account") and Grok Bot's note line `card payment: HELOC` (rule 17, Plan #6), as #1641 reads them
 * (cardPeriodMovements → periodPayerPayments → payingSidePayment). The Bills row, the cash walk, nextDue and nextPaymentOut
 * now read that same figure through coveredCardMinimum, so they cannot disagree with the Credit line.
 *   1. A noted Bills payment above the minimum: Credit covered, and the HELOC minimum row settled ('represented') at the
 *      paid amount with nothing remaining, on the action list and the period view; the walk no longer carries it, so
 *      nextPaymentOut counts one overdue payment (the card minimum), not two.
 *   2. The same payment un-noted: unverified on both sides, carried and overdue, as before.
 *   3. A noted payment below the minimum: not covered on Credit, and partly covered on the row (the remainder still due).
 *   4. Mutant: the HELOC branch removed restores the independent verdict (the noted payment reads unverified again).
 * Invented data only: the #1641 fixture world, as of 2026-08-24 with a prior cash reading on 2026-08-20, so the walk
 * carries the HELOC minimum due 2026-08-22 (planned 210) as it does live. Expectations are written by hand. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Forecast = require('../public/forecast');
const { fixture } = require('./fixtures/card-posted-period-movement-data');
const { loadStackPage } = require('./lib/budget-page-harness');

const PAID = '2026-08-18';
const AS_OF = '2026-08-24';
const PRIOR = '2026-08-20';
const billsDebit = (amount, extra = {}) => ({ id: 'to-heloc', date: PAID, atlasAccountId: 'chequing-a', accountRole: 'household-cash',
  categoryLabel: 'Payment, Transfer', amount, currency: 'cad', pending: false,
  original_name: 'EF789 TFR-TO 7654321', displayedPayee: 'EF789 TFR-TO 7654321', ...extra });
const NOTE = { notes: 'HELOC payment\ncard payment: HELOC' };

function world(rows) {
  const { plan, debts, overlay, packet } = fixture();
  debts.push({ id: 'heloc', label: 'Example HELOC', structure: 'Interest-only revolving — never amortises', secured: true,
    balance: 42025.35, evidenceDate: AS_OF, limit: 60000, pending: 0, rate: 4.9 });
  const travel = plan.obligations.find(o => o.debtId === 'travelvisa');
  travel.amount = 20;
  plan.obligations.push({ ...JSON.parse(JSON.stringify(travel)), id: 'heloc-minimum', debtId: 'heloc', name: 'HELOC minimum', amount: 210 });
  plan.cardPurchaseCoverage.opening.asOf = '2026-08-13';
  plan.opening = { asOf: AS_OF, priorAsOf: PRIOR };
  packet.syncEvidence.push({ id: 'chequing-a', role: 'household-cash', syncEvidence: 'proven', fields: { last_fetch: true } });
  packet.syncEvidence.push({ id: 'heloc', role: 'heloc', syncEvidence: 'proven', fields: { last_fetch: true } });
  packet.observationAsOf = AS_OF;
  packet.coverageThrough = AS_OF;
  packet.transactionWindow.endDate = AS_OF;
  packet.transactions = rows.map(raw => {
    const { notes, original_name, ...row } = raw;
    return { ...row, ...Forecast.classifyCurrentPeriodTransaction.derivedFlags(raw, plan),
      coverageRef: 'invented-' + row.id, savingsPostingEvidence: 'posted' };
  });
  overlay.overlays = overlay.overlays.map(item => ({ ...item, evidenceDate: AS_OF }));
  overlay.overlays.push({ locator: 'debts:heloc', field: 'balance', proposedValue: 42025.35, evidenceDate: AS_OF });
  return { meta: { asOf: AS_OF }, accounts: [], revolvingExtra: [], plan, debts,
    liveOverlay: { ...overlay, operatingPlan: 'live', currentPeriodActuals: packet } };
}

async function read(rows, Engine) {
  const page = await loadStackPage({ data: world(rows), ...(Engine ? { Forecast: Engine } : {}) });
  assert.equal(page.status(), 'rendered');
  const rec = page.context().recommendation;
  const view = rec.payPeriodViews.find(v => v.timelineRole === 'current');
  const line = view.stackSummary.credit.lines.find(l => l.id === 'heloc');
  const action = (rec.currentPeriodAction.bills || []).filter(b => b.id === 'heloc-minimum');
  const shown = (view.bills || []).filter(b => b.id === 'heloc-minimum');
  assert.equal(action.length, 1, 'one HELOC minimum row on the action list');
  assert.equal(shown.length, 1, 'one HELOC minimum row on the period view');
  const carried = rec.sim.events.filter(e => e.debtId === 'heloc' && e.date === '2026-08-22' && e.amount < 0);
  return { line, row: action[0], shown: shown[0], carried, nextDue: Forecast.nextDue(rec.sim.events, AS_OF),
    nextOut: Forecast.nextPaymentOut(rec.sim.events, AS_OF) };
}

test('1. a noted Bills payment above the minimum settles the HELOC minimum at the paid amount, on every reading', async () => {
  const r = await read([billsDebit(300, NOTE)]);
  assert.equal(r.line.paidBack.amount, 300);
  assert.equal(r.line.minimumCovered.value, true, 'Credit: covered');
  assert.equal(r.row.settlement, 'represented', 'action list: settled');
  assert.equal(r.row.actual, 300, 'at the paid amount, not the plan 210');
  assert.equal(r.row.remaining, 0);
  assert.equal(r.row.minimumCoverage.source, 'Forecast.periodPayerPayments');
  assert.equal(r.row.minimumCoverage.trust, 'calculated');
  assert.equal(r.shown.status, 'PAID', 'period view: PAID');
  assert.equal(r.shown.settlement, 'represented');
  assert.equal(r.shown.actual, 300);
  assert.equal(r.carried.length, 0, 'the walk no longer carries it');
  // Due today: the card minimum 20 (carried from 08-22) and Internet 85. 20 + 85 = 105; the HELOC's 210 is gone.
  assert.equal(r.nextOut.amount, 105);
  assert.equal(r.nextOut.overdueCount, 1, 'one overdue payment (the card minimum), not two');
  assert.notEqual(r.nextDue.what, 'HELOC minimum');
});

test('2. the same payment un-noted stays unverified on both sides, carried and overdue', async () => {
  const r = await read([billsDebit(300)]);
  assert.equal(r.line.minimumCovered.value, false, 'Credit: not covered');
  assert.equal(r.row.settlement, 'unverified');
  assert.equal(r.row.actual, null);
  assert.equal(r.row.remaining, 210);
  assert.equal(r.row.minimumCoverage, undefined);
  assert.equal(r.shown.status, 'still due');
  assert.equal(r.carried.length, 1, 'carried');
  assert.equal(r.nextOut.amount, 20 + 85 + 210);
  assert.equal(r.nextOut.overdueCount, 2);
});

test('3. a noted payment below the minimum is partly covered: the remainder stays due', async () => {
  const r = await read([billsDebit(150, NOTE)]);
  assert.equal(r.line.paidBack.amount, 150);
  assert.equal(r.line.minimumCovered.value, false, 'Credit: not covered');
  assert.notEqual(r.row.settlement, 'represented', 'never settled below the minimum');
  assert.equal(r.row.actual, 150);
  assert.equal(r.row.remaining, 60, '210 − 150');
  assert.equal(r.row.minimumCoverage.status, 'partial');
  assert.notEqual(r.shown.status, 'PAID');
  // The walk carries only the remainder: 20 + 85 + 60.
  assert.equal(r.nextOut.amount, 165);
});

test('4. mutant: removing the HELOC branch restores the independent verdict and is caught', async () => {
  const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
  const source = fs.readFileSync(FILE, 'utf8');
  const anchor = "    if (event.debtId === 'heloc') {\n";
  assert.equal(source.split(anchor).length, 2, 'anchor found exactly once');
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(source.replace(anchor, "    if (false) {\n"), FILE.replace(/\.js$/, '-no-heloc-branch.js'));
  const r = await read([billsDebit(300, NOTE)], mod.exports);
  assert.equal(r.line.minimumCovered.value, true, 'Credit still covered');
  assert.equal(r.row.settlement, 'unverified', 'the mutant reads the noted payment unverified: test 1 rejects it');
  assert.equal(r.nextOut.overdueCount, 2);
});
