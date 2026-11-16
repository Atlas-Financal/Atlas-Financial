'use strict';
// Household acceptance item 12: a missed bill occurrence reads "To confirm"
// once, in one pay period, and is counted in one period's figures.
// `node test/test-missed-bill-once.js`
//
// The live shape: a monthly subscription is due on the 5th. Its last real
// charge posted Aug 5, two months earlier. The Oct 5 occurrence falls in the
// closed pay period Sep 25 - Oct 8 and has no posted charge. The plan is
// dated Sep 20 and the observation is Oct 14 (production's opening shape),
// so the cash walk still deducts Oct 5 and #953 lists it on the current
// period Oct 9 - Oct 22, to confirm.
//
// On main the same occurrence was also listed, To confirm, in the closed
// period's own view (and counted in that period's bill total and Not
// confirmed paid figure). Every view is printed from the same published
// payPeriodViews the Budget page steps through, and a saved close captured
// from that view (#818) kept the second copy. An unpaid overdue one-off bill
// had the same second copy. Expected values are written by hand from the
// invented inputs below; nothing is read back from the code under test.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

const STREAM = { id: 'stream', label: 'Invented stream', amount: 18, frequency: 'monthly', day: 5,
  confidence: 'confirmed', payee: 'Invented stream co' };
const charge = date => H.lm({ date, amount: 18, category: 'Internet', account: 'chequing-a', payee: 'Invented stream co' });

function world(patch) {
  const w = H.baseWorld();
  w.windowStart = '2026-07-01';
  w.bills = [Object.assign({}, STREAM)];
  w.transactions = [
    H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    charge('2026-08-05'),
  ];
  if (patch) patch(w);
  H.productionOpening(w);
  // Production's dated plan: Sep 20, before the closed period.
  const own = w.planPatch;
  w.canonicalAsOf = '2026-09-20';
  w.planPatch = plan => {
    own(plan);
    plan.opening = { asOf: '2026-09-20', representedEvents: [] };
    for (const row of plan.startingCash.breakdown) row.evidenceDate = '2026-09-20';
  };
  return w;
}

// The page's own inputs: Forecast.budgetRecommendInputs over the served
// document, as public/plan.js calls it.
function views(w) {
  const { data, error } = H.dataOf(w);
  assert.equal(error, null, 'the live overlay is applied');
  assert.equal(data.plan.opening.asOf, '2026-10-14');
  assert.equal(data.plan.opening.priorAsOf, '2026-09-20');
  const advice = F.recommend(data.plan, data.plan.opening.asOf, F.budgetRecommendInputs(data, {}));
  const all = advice.payPeriodViews || [];
  const at = start => all.find(v => v.start === start);
  return { all, closed: at('2026-09-25'), current: at('2026-10-09'), data };
}
const rows = (view, id, date) => ((view && view.bills) || []).filter(r => r && r.id === id && (!date || r.date === date));
const holders = (all, id, date) => all.filter(v => rows(v, id, date).length).map(v => v.start);

let passed = 0;
function check(name, fn) { H.resetCaptures(); fn(); passed += 1; console.log('  ok ' + name); }

console.log('=== item 12: a missed bill occurrence is to confirm once ===');

check('a missed monthly subscription (last charge two months earlier) is listed once, on the current period', () => {
  const r = views(world());
  assert.ok(r.closed && r.current, 'positive control: the closed and current periods are published');
  assert.deepEqual(holders(r.all, 'stream', '2026-10-05'), ['2026-10-09'], 'Oct 5 is in exactly one period: the current one');
  const [row] = rows(r.current, 'stream', '2026-10-05');
  assert.equal(row.settlement, 'unverified', 'to confirm');
  assert.notEqual(row.status, 'PAID');
  assert.equal(row.remaining, 18);
  // By hand, Oct 9 - Oct 22: the carried 18 is the period's only bill.
  assert.equal(r.current.periodBillLoad, 18, 'counted once, in the current period bill load');
  assert.equal(r.current.remainingBills, 18);
  // The closed period Sep 25 - Oct 8 holds no other bill, so it now plans none.
  assert.deepEqual(rows(r.closed, 'stream'), [], 'the closed period does not list it again');
  assert.equal(r.closed.totalBillsThisPeriod, 0, 'not counted in the closed period total');
  assert.equal(r.closed.unconfirmedBills, 0, 'not counted in the closed period Not confirmed paid');
  // History is otherwise unchanged: Aug 5 is Paid in its own period, and the
  // older Sep 5 miss (before the dated opening, not carried) stays history.
  assert.deepEqual(rows(r.all.find(v => v.start === '2026-07-31'), 'stream').map(x => [x.date, x.status]), [['2026-08-05', 'PAID']]);
  assert.deepEqual(holders(r.all, 'stream', '2026-09-05'), ['2026-08-28'], 'Sep 5 stays in its own period only');
});

check('control: a charge on Oct 5 keeps the row in its own closed period, Paid, and nothing is carried', () => {
  const r = views(world(w => w.transactions.push(charge('2026-10-05'))));
  assert.deepEqual(holders(r.all, 'stream', '2026-10-05'), ['2026-09-25']);
  assert.equal(rows(r.closed, 'stream', '2026-10-05')[0].status, 'PAID');
  assert.equal(r.closed.totalBillsThisPeriod, 18, 'the closed period counts its paid 18');
  assert.equal(r.current.periodBillLoad, 0);
});

check('control: with a payday-dated plan nothing is carried; the miss stays once, in its own period', () => {
  const w = H.baseWorld();
  w.windowStart = '2026-07-01';
  w.bills = [Object.assign({}, STREAM)];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    charge('2026-08-05')];
  const { data, error } = H.dataOf(w);
  assert.equal(error, null);
  const all = F.recommend(data.plan, data.plan.opening.asOf, F.budgetRecommendInputs(data, {})).payPeriodViews;
  assert.deepEqual(holders(all, 'stream', '2026-10-05'), ['2026-09-25']);
});

check('an unpaid overdue one-off bill is listed once, on the current period', () => {
  const r = views(world(w => {
    w.bills = [{ id: 'fee', label: 'Invented fee', amount: 40, frequency: 'once', date: '2026-10-05',
      confidence: 'confirmed', payee: 'Invented fee co' }];
  }));
  assert.deepEqual(holders(r.all, 'fee', '2026-10-05'), ['2026-10-09']);
  assert.equal(r.current.periodBillLoad, 40);
  assert.equal(r.closed.totalBillsThisPeriod, 0);
  assert.equal(r.closed.unconfirmedBills, 0);
});

check('a paid one-off keeps its row in its own closed period', () => {
  const r = views(world(w => {
    w.bills = [{ id: 'fee', label: 'Invented fee', amount: 40, frequency: 'once', date: '2026-10-05',
      confidence: 'confirmed', payee: 'Invented fee co' }];
    w.transactions.push(H.lm({ date: '2026-10-05', amount: 40, category: 'Utilities', account: 'chequing-a', payee: 'Invented fee co' }));
  }));
  assert.deepEqual(holders(r.all, 'fee', '2026-10-05'), ['2026-09-25']);
  assert.equal(rows(r.closed, 'fee')[0].status, 'PAID');
});

check('a saved close captured from this view (#818) does not keep a second copy', () => {
  // An earlier refresh the household made on Oct 14 captures the closing
  // for Sep 25 - Oct 8; today's page reads that saved close.
  const w = world();
  w.capturedHistory = [world()];
  const r = views(w);
  assert.ok(r.data.periodHistory.some(rec => rec.content.kind === 'closing' && rec.content.period.start === '2026-09-25'),
    'positive control: the closed period was captured');
  assert.ok(r.closed.capturedClose, 'the closed period is read from the saved close');
  assert.deepEqual(holders(r.all, 'stream', '2026-10-05'), ['2026-10-09']);
  assert.equal(r.closed.totalBillsThisPeriod, 0);
});

console.log(`  ${passed} checks passed`);
