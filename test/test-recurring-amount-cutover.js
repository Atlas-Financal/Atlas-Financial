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
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true,
  budgetCategory: 'utilities' };
const item = (amount, anchor = '2026-01-01', expected = ['2026-11-01'], endDate = null) => ({ providerId: ID, status: 'reviewed', unavailableFields: [],
  criteria: { startDate: anchor, endDate, granularity: 'month', quantity: 1, anchorDate: anchor,
    currency: 'CAD', plaidAccountId: '9001', manualAccountId: null, ...(amount === undefined ? {} : { amount }) },
  matches: { expectedOccurrenceDates: expected, foundTransactions: [] } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-10-14' }, items } });
const rule = linkedFrom => ({ eventId: 'studio', lunchMoneyRecurringIds: [ID], linkedFrom, atlasAccountId: 'chequing-a',
  direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
  postingDateRule: 'covers-early-or-due-on-or-before-posting' });

function serve(items, { bill = {}, linkedFrom = '2026-11-01', asOf = null, transactions = [] } = {}) {
  const w = H.baseWorld();
  if (asOf) w.asOf = asOf;
  w.bills = [{ ...BILL, ...bill }];
  w.budget = w.budget.concat([{ id: 'utilities', label: 'Utilities', class: 'essential', plannedPayday: 0, confidence: 'confirmed', from: ['Utilities'] }]);
  w.identityRules = w.identityRules.concat([rule(linkedFrom)]);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })]
    .concat(transactions);
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  const before = J(canonical);
  const r = Live.fromObservation({ data: canonical, payload: { ...H.rawPayload(w), recurringItems: read(items) },
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const plan = r.data.plan;
  const adv = F.recommend(plan, w.asOf, { currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals, debts: r.data.debts });
  const rows = start => ((adv.defaultView.calendarPeriods.find(p => p.start === start) || {}).bills || []).filter(b => b.id === 'studio');
  // The Budget category the bill sits in (budgetBreakdown, the Budget page's categorized figures).
  const bd = F.budgetBreakdown(plan, { periods: { ytd: { months: 6, spending: [] } } }, { asOf: w.asOf });
  const utilities = (bd.categories || []).find(c => c.id === 'utilities');
  return { bill: plan.bills.find(b => b.id === 'studio'), rows, unchanged: J(canonical) === before,
    schedules: r.report.recurringBillSchedules || [], utilities, plan, asOf: w.asOf };
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
  delete previous.providerPriceCutover;
  ok(at(previous, '2026-10-20') === 93, 'the previous served bill priced Oct 20 at the item\'s 93.00');
}

console.log('3. A price-only change (same day and cadence): the link date still applies (review 7102068014)');
{
  // Plan and item both monthly on the 20th; the link starts 2026-11-01. No timingBefore (nothing in the timing changed),
  // but the price still changes only from the link: Oct 20 70.00, Nov 20 93.00.
  const s = serve([item('93.0000', '2026-01-20', ['2026-11-20'])], { bill: { day: 20 }, linkedFrom: '2026-11-01' });
  // The timing is the same on both sides (monthly on the 20th). Since #1605 a link keeps the plan's own date tag before its
  // cutover (timingBefore with the same cadence), so the timing may carry one; the price still changes only from the link.
  const tb = s.schedules[0] && s.schedules[0].timing.timingBefore;
  ok(s.schedules.length === 1 && (!tb || (tb.frequency === 'monthly' && tb.day === 20)) && s.schedules[0].amountFrom === '2026-11-01',
    'same cadence on both sides, and the schedule carries the link date with its amount (amountFrom 2026-11-01)', J(s.schedules[0]));
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

console.log('7. The Budget category (desk ruling (b)): one side of the cutover takes its monthly equivalent; a window across it takes its date-priced occurrences');
{
  // The window is [as of, as of + windowDays - 1]: Oct 14 to Jan 12 with the invented 91 days, 91 / (365.25 / 12) months.
  const months = s => (s.plan.windowDays || 91) / (365.25 / 12);
  const near = (a, b) => a != null && Math.abs(a - b) < 0.005;
  // Timing and price (plan on the 20th, item on the 1st, cutover Nov 1): Oct 20 at 70.00; Nov 1, Dec 1, Jan 1 at 93.00.
  const both = serve([item('93.0000')]);
  ok(both.utilities && near(both.utilities.dated, (70 + 3 * 93) / months(both)) && both.utilities.datedItems[0].amount != null,
    'timing and price across the window: (70.00 + 3 x 93.00) / the window\'s months', J(both.utilities && both.utilities.dated));
  // Price only (both on the 20th, cutover Nov 1): Oct 20 at 70.00; Nov 20, Dec 20 at 93.00.
  const price = serve([item('93.0000', '2026-01-20', ['2026-11-20'])], { bill: { day: 20 } });
  ok(near(price.utilities.dated, (70 + 2 * 93) / months(price)), 'price only across the window: (70.00 + 2 x 93.00) / months',
    J(price.utilities.dated));
  // Wholly after the cutover: the item's monthly equivalent.
  const after = serve([item('93.0000', '2026-01-20', ['2026-10-20'])], { bill: { day: 20 }, linkedFrom: '2026-10-01' });
  ok(near(after.utilities.dated, 93), 'wholly after the cutover: 93.00 a month', J(after.utilities.dated));
  // Wholly before the cutover (Feb 1): the plan's own monthly equivalent and cadence.
  const before = serve([item('93.0000', '2026-01-01', ['2027-02-01'])], { linkedFrom: '2027-02-01' });
  ok(before.bill.providerPriceCutover && near(before.utilities.dated, 70), 'wholly before the cutover: 70.00 a month (the plan\'s)',
    J([before.bill.providerPriceCutover, before.utilities.dated]));
  // The same served bill reaches the pay-period views at the same prices (section 1), and the Budget figure is published,
  // not withheld as an amount schedule's would be (the reviewed head's shape).
  ok(both.utilities.dated != null && !both.utilities.datedItems.some(i => i.reason === 'amount-schedule-unsupported'),
    'the cutover is not an amount schedule: the categorized figure is published');
  // Controls. The owner's schedule keeps precedence: no item amount, no cutover, ATLAS-075 unchanged.
  const owner = [{ from: '2026-10-01', until: '2026-12-01', amount: 55 }];
  const owned = serve([item('93.0000')], { bill: { amountSchedule: owner } });
  ok(owned.bill.providerPriceCutover === undefined && owned.bill.amount === 70
    && owned.utilities.dated === null && owned.utilities.datedItems[0].reason === 'amount-schedule-unsupported',
    'an owner amountSchedule: no cutover, and its Budget figure withholds exactly as ATLAS-075 does today');
  // In Forecast itself, an owner schedule beside a cutover wins (precedence, not a merge).
  const both2 = { ...both.bill, amountSchedule: owner };
  ok(at(both2, '2026-10-20') === 55 && at(both2, '2026-12-20') === 93, 'Forecast: an owner schedule beside a cutover prices from the schedule');
  // And in the Budget figure: an owner schedule whose term lies outside the window keeps the regular monthly price, and
  // the cutover beside it is ignored (not the cutover's date-priced sum).
  const outside = [{ from: '2025-01-01', until: '2025-02-01', amount: 55 }];
  const plan2 = { ...both.plan, bills: both.plan.bills.map(b => b.id === 'studio' ? { ...b, amountSchedule: outside } : b) };
  const u2 = F.budgetBreakdown(plan2, { periods: { ytd: { months: 6, spending: [] } } }, { asOf: both.asOf }).categories.find(c => c.id === 'utilities');
  ok(near(u2.dated, 93), 'Budget: an owner schedule outside the window beside a cutover takes the regular 93.00, not the cutover', J(u2.dated));
  // An unknown price on the earlier side: unknown, never 0 and never the item's price.
  const unknown = serve([item('93.0000')], { bill: { amount: null } });
  ok(unknown.bill.providerPriceCutover && unknown.bill.providerPriceCutover.amountBefore === null
    && at(unknown.bill, '2026-10-20') === null && unknown.utilities.dated === null
    && unknown.utilities.datedItems[0].reason === 'scheduled-amount-unknown',
    'an unknown plan price before the cutover: that occurrence and the Budget figure are unknown', J(unknown.utilities.datedItems));
  // A malformed cutover fails closed.
  const bad = { ...both.bill, providerPriceCutover: { from: '2026-11-31', amountBefore: 70 } };
  ok(at(bad, '2026-10-20') === null && at(bad, '2026-11-20') === null, 'a malformed cutover: every occurrence unknown');
}

console.log('8. A posted payment settles its occurrence at the price that occurrence carries');
{
  // As of Oct 21, a posted 70.00 on Oct 20 tied to the item settles Oct 20 (before the cutover, priced 70.00).
  const paid = H.lm({ id: 78124, date: '2026-10-20', amount: 70, account: 'chequing-a', payee: 'Invented studio', raw: { recurring_id: Number(ID) } });
  const s = serve([item('93.0000')], { asOf: '2026-10-21', transactions: [paid] });
  const oct = s.rows('2026-10-09');
  ok(oct.length === 1 && oct[0].date === '2026-10-20' && oct[0].amount === 70 && oct[0].status === 'PAID' && oct[0].remaining === 0,
    'the posted 70.00 settles Oct 20 at its 70.00 price, nothing remaining', J(oct.map(b => [b.date, b.amount, b.status, b.actual, b.remaining])));
  const nov = s.rows('2026-10-23');
  ok(nov.length === 1 && nov[0].date === '2026-11-01' && nov[0].amount === 93 && nov[0].status !== 'PAID',
    'Nov 1 is still owed at 93.00', J(nov.map(b => [b.date, b.amount, b.status])));
}

console.log('9. A linked schedule cannot extend an owner-ended bill');
{
  const lastDue = '2026-10-31';
  const linkedFrom = '2026-12-01';
  const dates = s => F.expandEvents(s.plan, '2026-10-14', '2027-01-31')
    .filter(e => e.id === 'studio').map(e => [e.date, -e.amount]);
  const run = (endDate, bound = { lastDue }) => serve([
    item('93.0000', '2026-01-22', ['2026-12-22'], endDate)
  ], { bill: { day: 31, ...bound }, linkedFrom });
  for (const endDate of [null, '2027-01-22']) {
    const s = run(endDate);
    ok(s.schedules.length === 1 && s.bill.lastDue === lastDue,
      'accepted provider schedule keeps the owner end over ' + (endDate || 'an open item'));
    ok(J(dates(s)) === J([['2026-10-31', 70]]) && s.unchanged,
      'served calendar keeps the final October bill at the plan price, no November or later', J(dates(s)));
  }
  const active = run(null, {});
  ok(J(dates(active)) === J([['2026-10-31', 70], ['2026-11-30', 70], ['2026-12-22', 93], ['2027-01-22', 93]]),
    'no owner end: November and the provider date and price still appear', J(dates(active)));
  const shorter = serve([item('93.0000', '2026-01-01', ['2026-11-01'], '2026-11-01')],
    { bill: { lastDue: '2026-12-31' } });
  ok(shorter.bill.lastDue === '2026-11-01' && J(dates(shorter)) === J([['2026-10-20', 70], ['2026-11-01', 93]]),
    'an earlier provider end still applies, inclusive of its final occurrence', J(dates(shorter)));
  const overlapping = serve([item('93.0000', '2026-01-01', ['2026-11-01', '2026-12-01'])],
    { bill: { lastDue: '2026-11-01' } });
  ok(J(dates(overlapping)) === J([['2026-10-20', 70], ['2026-11-01', 93]]),
    'provider timing and price still apply at the inclusive owner end; later expected dates are excluded',
    J(dates(overlapping)));
}

console.log('10. The operating answer uses the forecast day only for bounded bill schedules');
{
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');
  const OA = require('../scripts/operating-answer');
  const periodsFile = path.resolve(__dirname, '../public/periods.json');
  const periods = { periods: { ytd: { months: 6, spending: [] } } };
  const asOf = '2026-10-14';
  const w = H.baseWorld(asOf);
  w.bills = [{ ...BILL, day: 1, lastDue: '2026-10-01' }];
  w.budget = [{ id: 'utilities', label: 'Utilities', class: 'essential', plannedMonthly: 304.38 }];
  const data = H.canonicalOf(w, H.planOf(w));
  const opts = { mode: 'canonical' };

  // Replace only the OS read for the known fixture path: exercise the real
  // operating-answer entry point with invented periods and no household file.
  function operating(data, forecast) {
    const { existsSync, readFileSync } = fs;
    const realRecommend = F.recommend;
    let advice;
    try {
      fs.existsSync = (file, ...args) => file === periodsFile || existsSync.call(fs, file, ...args);
      fs.readFileSync = (file, ...args) => file === periodsFile
        ? J(periods) : readFileSync.call(fs, file, ...args);
      F.recommend = (...args) => (advice = forecast(...args));
      return { packet: OA.fromRefreshedState(data, opts), advice };
    } finally {
      F.recommend = realRecommend;
      fs.existsSync = existsSync;
      fs.readFileSync = readFileSync;
    }
  }
  const args = F.budgetRecommendInputs(data, { periods });
  const budget = F.budgetBreakdown(data.plan, periods, { ...args, asOf });
  const direct = F.recommend(data.plan, asOf, { ...args, asOf });
  const actual = operating(data, F.recommend);
  const cat = r => r.currentPeriodAction.categories.find(c => c.id === 'utilities') || {};
  const budgetRow = budget.categories.find(c => c.id === 'utilities');
  const cap = r => [r.weekly, r.weeklyCap, r.spendPermission];
  ok(budgetRow.dated === 0 && budgetRow.planned === 304.38 && cat(actual.advice).planned === 90
    && J(cat(actual.advice)) === J(cat(direct)),
    'ended bill draws zero; the invented 304.38 monthly Budget target yields 90 for the nine remaining days in the operating answer');
  ok(J(cap(actual.packet.currentSpendingPermission)) === J([direct.weekly,
    direct.currentPeriodAction.weeklyCap, direct.currentPeriodAction.spendPermission]),
    'operating-answer spending permission matches the explicitly dated Budget recommendation');
  ok(F.budgetBreakdown(data.plan, periods, args).categories[0].dated === null,
    'without an explicit or carried forecast day the bounded bill still withholds');

  const forecastFile = require.resolve('../public/forecast.js');
  const src = fs.readFileSync(forecastFile, 'utf8');
  const marker = 'scheduleWindow(opts.budgetTargetAsOf)';
  const mutant = new Module(forecastFile, module);
  mutant.filename = forecastFile;
  mutant.paths = module.paths;
  ok(src.includes(marker), 'mutant removes the schedule date propagation');
  mutant._compile(src.replace(marker, 'defaultSchedule'), forecastFile);
  ok(cat(operating(data, mutant.exports.recommend).advice).planned !== 90,
    'dropping the forecast date fails the same operating-answer Budget expectation');

  const active = structuredClone(data);
  delete active.plan.bills[0].lastDue;
  // Give the active bill a provider cutover too, to catch a broadened fallback.
  active.plan.bills[0].providerPriceCutover = { from: '2026-11-01', amountBefore: 50 };
  ok(J(operating(active, F.recommend)) === J(operating(active, mutant.exports.recommend)),
    'no ended bill: the complete operating answer and Forecast advice are byte-identical to the pre-repair behavior');
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
