'use strict';
// Lead decision 2026-11-07: an unproven RECURRING joint-cash bill from the
// immediately preceding closed pay period is carried into the current pay
// period as "to pay or confirm", exactly once, like an unproven one-off.
// Older occurrences are history only. Evidence (a posted identity match, or
// the owner's represented record) clears it; a pending debit does not.
// The cash walk already deducts an unrepresented occurrence after the dated
// opening (opening.priorAsOf); on main the Budget list, remaining bills and
// the assistant list omitted it once its pay period closed. An occurrence on
// or before the dated opening stays inside that opening.
//
// Invented household from test/acceptance/harness.js in the production shape:
// a dated opening on Sep 20 (Sep 1 for the two-periods-old case) and a live
// observation on Oct 14, so the real live overlay rolls the opening forward
// and sets priorAsOf. Current pay period Oct 9 - Oct 22, previous Sep 25 -
// Oct 8. Through the real observer, live overlay, Forecast and the assistant
// packet. Every expectation is written by hand; no household figure enters.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');
const Assistant = require('../scripts/assistant-packet.js');

const WATER = { id: 'water', label: 'Invented water', amount: 120, frequency: 'monthly', day: 1,
  confidence: 'confirmed', payee: 'Invented water co' };
const PAYROLL = { date: '2026-10-09', amount: -1400, payee: 'Invented employer', account: 'chequing-a', category: 'Payroll' };

function run(patch) {
  const w = H.baseWorld();
  w.bills = [Object.assign({}, WATER)];
  w.transactions = [H.lm(PAYROLL)];
  w.savingsPool = true; // Savings is a required live-cash identity; the pool maps it.
  w.datedOpening = '2026-09-20';
  w.ownerRepresented = [];
  if (patch) patch(w);
  w.planPatch = p => {
    p.opening.asOf = w.datedOpening;
    delete p.opening.priorAsOf;
    p.opening.representedEvents.push(...w.ownerRepresented);
  };
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null, 'the observation is applied');
  const plan = data.plan;
  assert.equal(plan.opening.asOf, '2026-10-14', 'the live overlay advanced the opening');
  assert.equal(plan.opening.priorAsOf, w.datedOpening, 'priorAsOf is the dated opening');
  const opts = { debts: data.debts, currentPeriodActuals: packet };
  const advice = F.recommend(plan, w.asOf, opts);
  const current = advice.payPeriodViews.find(r => r.start === '2026-10-09');
  const walk = F.expandEvents(plan, plan.opening.asOf, '2026-10-22', { debts: data.debts })
    .filter(e => e && e.id === 'water');
  const assistant = Assistant.buildPacket({ data, periods: null, questionsMarkdown: '' });
  const actionBills = assistant.forecast && assistant.forecast.currentPeriodAction
    ? assistant.forecast.currentPeriodAction.bills : assistant.currentPeriodAction.bills;
  return { plan, current, walk, actionBills };
}
const rowsFor = (period, id) => (period.bills || []).filter(r => r && r.id === id);

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('  ok ' + name); }

console.log('=== carried unproven recurring bill (lead decision 2026-11-07) ===');

check('an unpaid recurring bill from the previous closed period is carried once', () => {
  const r = run();
  const rows = rowsFor(r.current, 'water');
  assert.equal(rows.length, 1, 'one current-period row');
  assert.equal(rows[0].date, '2026-10-01', 'keeps its real due date');
  assert.equal(rows[0].settlement, 'unverified', 'to pay or confirm, not paid');
  assert.equal(rows[0].remaining, 120);
  assert.equal(r.current.remainingBills, 120, 'counted in remaining bills');
  // Cash walk: deducted once, at this opening.
  assert.deepEqual(r.walk.map(e => [e.date, e.amount]), [['2026-10-01', -120]], 'one walk deduction');
  // Assistant packet: the same row, once.
  const p = r.actionBills.filter(b => b.id === 'water');
  assert.equal(p.length, 1, 'one assistant row');
  assert.equal(p[0].date, '2026-10-01');
  assert.equal(p[0].remaining, 120);
  assert.equal(p[0].settlement, 'unverified');
});

check('a recurring bill with a posted matching debit is not carried', () => {
  const r = run(w => w.transactions.push(H.lm({ date: '2026-10-01', amount: 120, payee: 'Invented water co',
    account: 'chequing-a', category: 'Utilities' })));
  assert.equal(rowsFor(r.current, 'water').length, 0, 'no current-period row');
  assert.equal(r.current.remainingBills, 0);
  assert.equal(r.walk.length, 0, 'no walk deduction');
  assert.ok(r.plan.opening.representedEvents.some(e => e.id === 'water' && e.date === '2026-10-01'),
    'the posted match is named on representedEvents');
  assert.ok(r.actionBills.filter(b => b.id === 'water').every(b => b.settlement === 'represented' && b.remaining === 0),
    'the assistant list owes nothing for it');
});

check('an owner-confirmed paid recurring bill is not carried', () => {
  const r = run(w => { w.ownerRepresented = [{ id: 'water', date: '2026-10-01' }]; });
  assert.equal(rowsFor(r.current, 'water').length, 0, 'no current-period row');
  assert.equal(r.current.remainingBills, 0);
  assert.equal(r.walk.length, 0, 'no walk deduction');
  assert.ok(r.actionBills.filter(b => b.id === 'water').every(b => b.settlement === 'represented' && b.remaining === 0),
    'the assistant list owes nothing for it');
});

check('a recurring bill two periods old is not listed in the current period', () => {
  // Dated opening Sep 1, day 15: Sep 15 sits in Sep 11 - Sep 24, two periods
  // back. The incumbent priorAsOf carry still deducts it in the cash walk
  // (unchanged here); the bounded list does not name it. Oct 15 is a normal
  // current-period occurrence.
  const r = run(w => { w.bills[0].day = 15; w.datedOpening = '2026-09-01'; });
  const rows = rowsFor(r.current, 'water');
  assert.deepEqual(rows.map(row => row.date), ['2026-10-15'], 'only the current occurrence');
  // currentPeriodAction (unchanged here) already lists every occurrence since
  // the dated opening, in agreement with the walk; only this bound is tested.
  assert.equal(F.carriedRecurringJointCashBill(r.plan, 'water', '2026-09-15', '2026-10-14'), false, 'outside the bound');
});

check('a recurring bill inside the dated opening is not carried', () => {
  // Dated opening Sep 20, day 15: Sep 15 is on or before the dated opening.
  const r = run(w => { w.bills[0].day = 15; });
  assert.deepEqual(rowsFor(r.current, 'water').map(row => row.date), ['2026-10-15'], 'only the current occurrence');
  assert.equal(r.current.remainingBills, 120);
  assert.deepEqual(r.walk.map(e => e.date), ['2026-10-15'], 'Sep 15 is not deducted');
});

check('a pending matching debit does not clear the carried bill', () => {
  const r = run(w => w.transactions.push(H.lm({ date: '2026-10-13', amount: 120, payee: 'Invented water co',
    account: 'chequing-a', category: 'Utilities', pending: true })));
  const rows = rowsFor(r.current, 'water');
  assert.equal(rows.length, 1, 'still carried once');
  assert.equal(rows[0].settlement, 'unverified');
  assert.equal(r.current.remainingBills, 120);
  assert.equal(r.walk.length, 1, 'still one walk deduction');
  assert.equal(r.actionBills.filter(b => b.id === 'water').length, 1);
});

check('the list and the cash walk name the same occurrences, once', () => {
  for (const r of [run(), run(w => w.transactions.push(H.lm({ date: '2026-10-13', amount: 120,
    payee: 'Invented water co', account: 'chequing-a', category: 'Utilities', pending: true })))]) {
    const listed = rowsFor(r.current, 'water').filter(row => row.settlement !== 'represented').map(row => row.date).sort();
    const deducted = r.walk.map(e => e.date).sort();
    assert.deepEqual(listed, deducted, 'every walk deduction this period is one listed row');
  }
});

check('the carried recurring row matches the one-off carry it mirrors', () => {
  const recurring = run();
  const once = run(w => { w.bills = [{ id: 'water', label: 'Invented water', amount: 120, frequency: 'once',
    date: '2026-10-01', confidence: 'confirmed', payee: 'Invented water co' }]; });
  const a = rowsFor(recurring.current, 'water')[0], b = rowsFor(once.current, 'water')[0];
  for (const k of ['date', 'settlement', 'status', 'glanceKind', 'remaining', 'planned']) {
    assert.deepEqual(a[k], b[k], 'same ' + k + ' as the one-off');
  }
  assert.equal(recurring.current.remainingBills, once.current.remainingBills);
});

check('the predicate fails closed outside its bound and for non-cash bills', () => {
  const plan = run().plan;
  assert.equal(F.carriedRecurringJointCashBill(plan, 'water', '2026-10-01', '2026-10-14'), true);
  assert.equal(F.carriedRecurringJointCashBill(plan, 'water', '2026-09-01', '2026-10-14'), false, 'two periods back');
  assert.equal(F.carriedRecurringJointCashBill(plan, 'water', '2026-10-02', '2026-10-14'), false, 'not an occurrence');
  assert.equal(F.carriedRecurringJointCashBill(plan, 'water', '2026-11-01', '2026-10-14'), false, 'future');
  const later = Object.assign({}, plan, { opening: Object.assign({}, plan.opening, { priorAsOf: '2026-10-05' }) });
  assert.equal(F.carriedRecurringJointCashBill(later, 'water', '2026-10-01', '2026-10-14'), false, 'inside the dated opening');
  assert.equal(F.carriedRecurringJointCashBill(plan, 'water', '2026-10-01', '2026-10-13'), false, 'not this opening');
  const bill = plan.bills[0];
  const held = Object.assign({}, plan, { startingCash: Object.assign({}, plan.startingCash, { heldElsewhere: [{ id: 'held-x', value: 0 }] }),
    bills: [Object.assign({}, bill, { payingAccount: 'held-x' })] });
  assert.equal(F.carriedRecurringJointCashBill(held, 'water', '2026-10-01', '2026-10-14'), false, 'held-elsewhere payer');
  const undated = Object.assign({}, plan, { bills: [Object.assign({}, bill, { needsDate: true })] });
  assert.equal(F.carriedRecurringJointCashBill(undated, 'water', '2026-10-01', '2026-10-14'), false, 'undated bill');
  const once = Object.assign({}, plan, { bills: [Object.assign({}, bill, { frequency: 'once', date: '2026-10-01' })] });
  assert.equal(F.carriedRecurringJointCashBill(once, 'water', '2026-10-01', '2026-10-14'), false, 'one-offs keep their own carry');
});

console.log(`${passed} passed`);
