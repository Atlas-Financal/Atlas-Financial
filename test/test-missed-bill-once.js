'use strict';
// A missed occurrence remains visible and counted in its own pay period.
// `node test/test-missed-bill-once.js`
//
// Dale's period rule: the scheduled occurrence stays in its own period.
// A later observation changes settlement only when there is evidence.
// This harness uses only invented accounts, schedules and transactions.
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
  return { all, closed: at('2026-09-25'), current: at('2026-10-09'), advice, data };
}
const rows = (view, id, date) => ((view && view.bills) || []).filter(r => r && r.id === id && (!date || r.date === date));
const holders = (all, id, date) => all.filter(v => rows(v, id, date).length).map(v => v.start);
// Count the same occurrence across every period the household can select.
const unpaidPeriods = (all, id, date) => all.filter(v => rows(v, id, date).some(r => r.paidState === 'not-paid')).map(v => v.start);

let passed = 0;
function check(name, fn) { H.resetCaptures(); fn(); passed += 1; console.log('  ok ' + name); }

console.log('=== item 12: a missed bill occurrence stays in its own period ===');

check('a missed subscription stays Not paid in its own period, even with an older opening', () => {
  const r = views(world());
  assert.deepEqual(holders(r.all, 'stream', '2026-10-05'), ['2026-09-25']);
  assert.deepEqual(unpaidPeriods(r.all, 'stream', '2026-10-05'), ['2026-09-25']);
  const [row] = rows(r.closed, 'stream', '2026-10-05');
  assert.equal(row.actual, null);
  assert.equal(row.remaining, 18);
  assert.equal(r.closed.totalBillsThisPeriod, 18);
  assert.equal(r.closed.unconfirmedBills, 18);
  assert.equal(r.closed.periodBillLoad, 18);
  assert.equal(r.closed.budgetProgress.bills.planned.amount, 18);
  assert.equal(r.current.periodBillLoad, 0);
  assert.equal(r.current.remainingBills, 0);
  assert.deepEqual(rows(r.all.find(v => v.start === '2026-07-31'), 'stream').map(x => [x.date, x.status]), [['2026-08-05', 'PAID']]);
  assert.deepEqual(unpaidPeriods(r.all, 'stream', '2026-09-05'), ['2026-08-28']);
});

check('bill, card minimum and HELOC cash minimum respect the last day of a pay period', () => {
  const r = views(world(w => {
    w.bills = [
      { ...STREAM, day: 8, firstDue: '2026-10-08' },
      { id: 'current-fee', label: 'Invented payday fee', amount: 7, frequency: 'once',
        date: '2026-10-09', confidence: 'confirmed' },
    ];
    w.obligations = [
      { id: 'card-a', debtId: 'mbna', label: 'Invented card minimum', effect: 'payment',
        frequency: 'monthly', day: 8, firstDue: '2026-10-08', amount: 31,
        confidence: 'confirmed', payingAccount: 'chequing-a' },
      { id: 'heloc', debtId: 'heloc', label: 'Invented capitalised interest', effect: 'capitalise',
        nonCash: true, frequency: 'monthly', day: 31, amount: 5, confidence: 'estimated',
        cashDay: 8, cashFirstDue: '2026-10-08', cashPayment: 53,
        cashLabel: 'Invented HELOC cash minimum', payingAccount: 'chequing-a' },
    ];
  }));
  for (const [id, amount] of [['stream', 18], ['card-a', 31], ['heloc', 53]]) {
    assert.deepEqual(holders(r.all, id, '2026-10-08'), ['2026-09-25']);
    const [row] = rows(r.closed, id, '2026-10-08');
    assert.equal(row.paidState, 'not-paid');
    assert.equal(row.remaining, amount);
    assert.equal(row.actual, null);
    // The next monthly occurrence is independently due in November.
    assert.deepEqual(holders(r.all, id, '2026-11-08'), ['2026-11-06']);
  }
  assert.equal(r.closed.periodBillLoad, 102); // 18 + 31 + 53
  assert.equal(r.closed.unconfirmedBills, 102);
  assert.equal(r.current.periodBillLoad, 7);
  assert.equal(r.current.stackSummary.surplus.amount, 993); // 1,400 income - 7 - 400 household
  assert.equal(r.current.stackSummary.surplus.terms.credit, 0);
  const nextDue = r.all.find(v => v.start === '2026-11-06');
  assert.equal(nextDue.stackSummary.surplus.terms.credit, 84); // card 31 + HELOC 53
  assert.equal(nextDue.stackSummary.surplus.amount, 898); // 1,400 - 102 - 400
  assert.equal(r.advice.paydayAllocation.obligations.wanted, 7);
  assert.deepEqual(r.advice.currentPeriodAction.bills.map(row => [row.id, row.remaining]), [['current-fee', 7]]);
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

check('an unverified one-off stays in its closed period', () => {
  const r = views(world(w => {
    w.bills = [{ id: 'fee', label: 'Invented fee', amount: 40, frequency: 'once', date: '2026-10-05',
      confidence: 'confirmed', payee: 'Invented fee co' }];
  }));
  assert.deepEqual(holders(r.all, 'fee', '2026-10-05'), ['2026-09-25']);
  assert.deepEqual(unpaidPeriods(r.all, 'fee', '2026-10-05'), ['2026-09-25']);
  assert.equal(r.closed.totalBillsThisPeriod, 40);
  assert.equal(r.closed.unconfirmedBills, 40);
  assert.equal(r.closed.periodBillLoad, 40);
  assert.equal(r.current.periodBillLoad, 0);
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

check('a new saved close retains the unverified bill and its own bill load', () => {
  // An earlier refresh the household made on Oct 14 captures the closing
  // for Sep 25 - Oct 8; today's page reads that saved close.
  const w = world();
  w.capturedHistory = [world()];
  const r = views(w);
  assert.ok(r.data.periodHistory.some(rec => rec.content.kind === 'closing' && rec.content.period.start === '2026-09-25'),
    'positive control: the closed period was captured');
  assert.ok(r.closed.capturedClose, 'the closed period is read from the saved close');
  assert.deepEqual(holders(r.all, 'stream', '2026-10-05'), ['2026-09-25']);
  assert.deepEqual(unpaidPeriods(r.all, 'stream', '2026-10-05'), ['2026-09-25']);
  assert.equal(r.closed.totalBillsThisPeriod, 18);
  assert.equal(r.closed.periodBillLoad, 18);
  assert.equal(r.current.periodBillLoad, 0);
});

console.log(`  ${passed} checks passed`);
