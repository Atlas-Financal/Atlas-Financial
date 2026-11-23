'use strict';
/* A linked bill's Lunch Money amount applies from the link's cutover, as its timing does (#1583 review
 * 7100673283). A rule's `linkedFrom` keeps the plan's own cadence for occurrences before it (timingBefore); the
 * served amount used to replace the plan's for every occurrence, so an occurrence before the cutover took the
 * item's amount. Now the plan's amount stands before the cutover, and the item's from it.
 *
 * Invented world (test/acceptance/harness.js): payday anchor 2026-10-09, as of 2026-10-14; periods Oct 9-22 and
 * Oct 23-Nov 5. An invented plan bill of 70.00, monthly on the 20th; its reviewed item, monthly on the 1st, carries
 * an invented 93.00; the link's cutover is 2026-11-01. Hand-derived: Oct 20 (before the cutover, the plan's day)
 * is 70.00; Nov 1 and Dec 1 (from the cutover, the item's day) are 93.00 each.
 *
 * `node test/test-recurring-amount-cutover.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe.js');
const F = require('../public/forecast.js');
let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => { checks++; if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); };
const J = JSON.stringify;
const ID = '7123461';
const BILL = { id: 'studio', label: 'Invented studio', amount: 70, frequency: 'monthly', day: 20, firstDue: '2026-10-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
const item = (amount, anchor = '2026-01-01', expected = ['2026-11-01']) => ({ providerId: ID, status: 'reviewed', unavailableFields: [],
  criteria: { startDate: anchor, endDate: null, granularity: 'month', quantity: 1, anchorDate: anchor,
    currency: 'CAD', plaidAccountId: '9001', manualAccountId: null, ...(amount === undefined ? {} : { amount }) },
  matches: { expectedOccurrenceDates: expected, foundTransactions: [] } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-10-14' }, items } });
const rule = linkedFrom => ({ eventId: 'studio', lunchMoneyRecurringIds: [ID], linkedFrom, atlasAccountId: 'chequing-a',
  direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
  postingDateRule: 'covers-early-or-due-on-or-before-posting' });

function serve(items, { bill = {}, linkedFrom = '2026-11-01' } = {}) {
  const w = H.baseWorld();
  w.bills = [{ ...BILL, ...bill }];
  w.identityRules = w.identityRules.concat([rule(linkedFrom)]);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  const before = J(canonical);
  const r = Live.fromObservation({ data: canonical, payload: { ...H.rawPayload(w), recurringItems: read(items) },
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const plan = r.data.plan;
  const adv = F.recommend(plan, w.asOf, { currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals, debts: r.data.debts });
  const rows = start => ((adv.defaultView.calendarPeriods.find(p => p.start === start) || {}).bills || []).filter(b => b.id === 'studio');
  return { bill: plan.bills.find(b => b.id === 'studio'), rows, unchanged: J(canonical) === before,
    schedules: r.report.recurringBillSchedules || [] };
}
const at = (bill, date) => F.billOccurrenceAmount(bill, date).amount;

console.log('1. Served through the live plan: the plan amount before the cutover, the item amount from it');
{
  const s = serve([item('93.0000')]);
  ok(s.schedules.length === 1 && s.schedules[0].timing.timingBefore && s.schedules[0].timing.timingBefore.from === '2026-11-01',
    'the link carries its cutover (timingBefore from 2026-11-01)', J(s.schedules.map(x => x.timing)));
  ok(at(s.bill, '2026-10-20') === 70, 'Oct 20, before the cutover: 70.00 (the plan\'s)', String(at(s.bill, '2026-10-20')));
  ok(at(s.bill, '2026-10-31') === 70, 'the day before the cutover: 70.00');
  ok(at(s.bill, '2026-11-01') === 93, 'Nov 1, the cutover day: 93.00 (the item\'s)', String(at(s.bill, '2026-11-01')));
  ok(at(s.bill, '2026-12-01') === 93, 'Dec 1, after it: 93.00');
  const oct = s.rows('2026-10-09'), nov = s.rows('2026-10-23');
  ok(oct.length === 1 && oct[0].date === '2026-10-20' && oct[0].amount === 70,
    'the Oct 9-22 period lists Oct 20 at 70.00', J(oct.map(b => [b.date, b.amount])));
  ok(nov.length === 1 && nov[0].date === '2026-11-01' && nov[0].amount === 93,
    'the Oct 23-Nov 5 period lists Nov 1 at 93.00', J(nov.map(b => [b.date, b.amount])));
  ok(s.bill.confidence === 'estimated', 'the amount tag stays the plan\'s estimated (no promotion)');
  ok(s.unchanged, 'the canonical document is not written');
}

console.log('2. The previous behaviour is reproduced: one scalar amount took Oct 20 to 93.00');
{
  const s = serve([item('93.0000')]);
  const previous = { ...s.bill, amount: 93 };
  delete previous.amountSchedule;
  ok(at(previous, '2026-10-20') === 93, 'the previous served bill priced Oct 20 at the item\'s 93.00');
}

console.log('3. A price-only change (same day and cadence): the link date still applies (review 7102068014)');
{
  // Plan and item both monthly on the 20th; the link starts 2026-11-01. No timingBefore (nothing in the timing changed),
  // but the price still changes only from the link: Oct 20 70.00, Nov 20 93.00.
  const s = serve([item('93.0000', '2026-01-20', ['2026-11-20'])], { bill: { day: 20 }, linkedFrom: '2026-11-01' });
  ok(s.schedules.length === 1 && !s.schedules[0].timing.timingBefore && s.schedules[0].amountFrom === '2026-11-01',
    'no timing cutover, and the schedule carries the link date with its amount (amountFrom 2026-11-01)', J(s.schedules[0]));
  ok(at(s.bill, '2026-10-20') === 70 && at(s.bill, '2026-11-20') === 93, 'Oct 20: 70.00 (the plan\'s); Nov 20: 93.00 (the item\'s)',
    J([at(s.bill, '2026-10-20'), at(s.bill, '2026-11-20')]));
  const oct = s.rows('2026-10-09');
  ok(oct.length === 1 && oct[0].date === '2026-10-20' && oct[0].amount === 70, 'the Oct 9-22 period lists Oct 20 at 70.00, through recommend',
    J(oct.map(b => [b.date, b.amount])));
}

console.log('3b. A link that starts before every occurrence: the item amount throughout, as before');
{
  const s = serve([item('93.0000', '2026-01-20', ['2026-10-20'])], { bill: { day: 20 }, linkedFrom: '2026-10-01' });
  ok(at(s.bill, '2026-10-20') === 93 && at(s.bill, '2026-11-20') === 93, 'Oct 20 and Nov 20: 93.00');
  // The previous applyRecurringAmount, verbatim, against the current one, for a schedule with no link date.
  const previousApply = (bill, schedule) => (!bill || !schedule || schedule.billId !== bill.id) ? bill
    : !(typeof schedule.amount === 'number' && Number.isFinite(schedule.amount) && schedule.amount > 0) ? bill
      : { ...bill, amount: schedule.amount };
  const plain = { ...BILL, day: 20 }, noDate = { billId: 'studio', amount: 93, timing: { frequency: 'monthly', day: 20 } };
  ok(J(O.applyRecurringAmount(plain, noDate)) === J(previousApply(plain, noDate)),
    'without a link date, applyRecurringAmount equals the previous function byte for byte');
}

console.log('4. The same amount on both sides adds no schedule');
{
  const s = serve([item('70.0000')]);
  ok(s.bill.amount === 70 && s.bill.amountSchedule === undefined && at(s.bill, '2026-10-20') === 70 && at(s.bill, '2026-11-01') === 70,
    'item 70.00 = plan 70.00: no amountSchedule, 70.00 throughout', J(s.bill.amountSchedule));
}

console.log('5. A bill that already has an amountSchedule never takes an item amount (explicit, both layers)');
{
  const owner = [{ from: '2026-10-01', until: '2026-12-01', amount: 55 }];
  const s = serve([item('93.0000')], { bill: { amountSchedule: owner } });
  ok(s.bill.amount === 70 && J(s.bill.amountSchedule) === J(owner), 'live plan: the plan amount and the owner\'s schedule stand',
    J([s.bill.amount, s.bill.amountSchedule]));
  ok(s.schedules.length === 1 && s.schedules[0].amount === undefined && s.schedules[0].amountReason === 'amount-schedule-present',
    'the observer refuses the item amount with amount-schedule-present');
  const forced = O.applyRecurringAmount({ ...BILL, amountSchedule: owner },
    { billId: 'studio', amount: 93, amountFrom: '2026-11-01', timing: { timingBefore: { from: '2026-11-01' } } });
  ok(forced.amount === 70 && J(forced.amountSchedule) === J(owner), 'applyRecurringAmount itself leaves an owner schedule alone');
}

console.log('6. No item amount: the plan amount stands on both sides');
{
  const s = serve([item(undefined)]);
  ok(s.bill.amount === 70 && s.bill.amountSchedule === undefined && at(s.bill, '2026-10-20') === 70 && at(s.bill, '2026-11-01') === 70,
    'plan 70.00 throughout, no schedule');
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
