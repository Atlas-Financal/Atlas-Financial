'use strict';
/* LEDGER B: an early or split salary credit is held To confirm over the run-up and its payday is counted once.
 * Invented world as test-amanda-pay-early-plain-credit (Dale 1400 biweekly from Fri Oct 9; Amanda 2000 on the 15th
 * and 2200 at month-end), via the acceptance harness and live-plan. Every expected figure is the control's own
 * published value or hand-derived above. `node test/test-early-salary-credit-counted-once.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const IDENTITY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'connectivity', 'transaction-identity.json'), 'utf8'));
const RULES = IDENTITY.rules.filter(rule => ['amandaSalary15', 'amandaSalaryMonthEnd'].includes(rule.eventId));
ok(RULES.length === 2 && RULES.every(rule => rule.settlesWhen === 'near-scheduled-amount-and-payday'
  && rule.amountToleranceDollars === 5 && rule.postingBusinessDays === 3), 'the shipped rules are the owner\'s: $5, 3 business days');

const TENNIS = 9010;
let nextId = 800000;
// A deposit into Bills: by default from the invented salary payee alias (a sign of salary) in the Payroll category, not a transfer.
const bills = (date, amount, extra = {}) => H.lm({ id: ++nextId, date, amount: -amount, category: extra.category || 'Payroll',
  account: 'chequing-a', payee: extra.payee || 'Invented Tennis PAY', pending: extra.pending, raw: extra.raw,
  notes: extra.notes, tagIds: extra.tagIds });

function serve({ asOf = '2026-10-22', txs = [], monthEndDay = 31, monthEndAmount = 2200, categories = [], tags = [], shippedPatterns = false, monthEndFirstDue = null }) {
  const w = H.baseWorld(asOf);
  w.categories = w.categories.concat(categories);
  w.tags = tags;
  w.windowStart = '2026-08-02';
  w.accounts.push({ id: 'tennis', providerId: TENNIS, role: 'household-external', collection: 'cash',
    label: 'Invented tennis income', value: 0, held: true, externalId: 'tennis-income' });
  w.income.push(
    { id: 'amandaSalary15', label: 'Invented salary (15th)', frequency: 'monthly', day: 15, firstDue: '2026-08-15', amount: 2000, confidence: 'confirmed' },
    { id: 'amandaSalaryMonthEnd', label: 'Invented salary (month-end)', frequency: 'monthly', day: monthEndDay, amount: monthEndAmount, confidence: 'confirmed', ...(monthEndFirstDue ? { firstDue: monthEndFirstDue } : {}) });
  // The shipped rules, with an invented employer alias for the early-receipt hold's salary source.
  w.identityRules = w.identityRules.concat(JSON.parse(JSON.stringify(RULES))
    .map(rule => shippedPatterns ? rule : ({ ...rule, salaryReceiptPayeePatterns: ['Invented Tennis PAY'] })));
  w.transactions = [H.lm({ id: 799999, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' }), ...txs];
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (r.error) throw r.error;
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const current = adv.defaultView.calendarPeriods.find(p => p.start <= asOf && p.end >= asOf);
  const rowOf = (id, date) => adv.defaultView.calendarPeriods.flatMap(p => p.income || [])
    .find(row => row.id === id && row.date === date) || null;
  const views = adv.payPeriodViews || [];
  const next = views.find(v => v.timelineRole === 'next') || null;
  return {
    current, next,
    bad: current.balanceAfterDeductions, close: current.plannedPeriodClose,
    live: r.data.liveOverlay.operatingPlan === 'live',
    held: r.data.liveOverlay.operatingPlan === 'unavailable',
    settled: (packet.representedActuals || []).filter(x => /^amandaSalary/.test(x.id))
      .map(x => x.id.replace('amandaSalary', '') + '@' + x.date + ':' + Math.abs(x.actual)).sort(),
    rowOf,
    income: current.incomeTotal,
    incomeTrust: current.incomeTrust,
    otherIncome: current.otherIncome && current.otherIncome.amount,
    future: F.expandEvents(r.data.plan, asOf, '2026-12-31', {}).filter(e => /^amandaSalary/.test(e.id)).map(e => e.date + ':' + e.amount),
    served: r.data,
  };
}

// ----------------------------------------------------------------------------------------------------------------
// LEDGER B (ATLAS LEAD 11, 2026-11-19; BACKLOG "Amanda's early pay can still count twice when it carries no sign of
// salary or arrives split"). Forecast's own hold (calendarIncomeSections, scheduledIncomeHeldIds) keeps a credit that
// could be an unproven salary occurrence To confirm, not relied on, so the occurrence is counted once. It read only 3
// calendar days either side; her pay can arrive earlier in the run-up, and Tue Oct 27 is 3 business days but 4
// calendar days before Sat Oct 31, so an early or split pay counted twice. The hold now starts the day after the
// income's previous occurrence (one cadence interval back for a first occurrence); the late side is unchanged. Each
// credit belongs to its nearest unproven occurrence only. Hand-derived control for the current period (Oct 23 to Nov
// 5, as of Wed Oct 28): income 1400 (Dale Oct 23) + 2200 (Oct 31) = 3600; BAD 3200 and planned close 7700 as the
// shipped control publishes them, and every case below must read exactly those.
const oct15 = () => bills('2026-10-15', 2000);
const payroll = (date, amount, payee = 'Invented deposit') => H.lm({ id: ++nextId, date, amount: -amount, category: 'Payroll',
  account: 'chequing-a', payee });
const once = (s, control, why) => ok(s.live && s.income === control.income && s.bad === control.bad && s.close === control.close,
  why + ': counted once (income ' + control.income + ', BAD ' + control.bad + ', close ' + control.close + ')',
  JSON.stringify([s.live, s.income, s.bad, s.close]));
const heldRow = (s, amount) => (s.current.income || []).find(row => /^other-income:/.test(row.id) && row.amount === amount
  && row.notReliedUpon === true && row.notReliedUponReason === 'possible-scheduled-income-receipt' && row.status === 'unresolved');

console.log('1. (a) an early pay with no sign of salary, outside the owner window');
const control = serve({ asOf: '2026-10-28', txs: [oct15()] });
ok(control.live && control.income === 3600, 'control: income 3600 (1400 + 2200)', JSON.stringify([control.income, control.bad, control.close]));
{
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), payroll('2026-10-27', 2190)] });
  once(s, control, 'a Payroll-filed 2190 from a non-salary payee, Tue Oct 27 ($10 off, 3 business days early)');
  ok(!!heldRow(s, 2190), 'it is listed To confirm, not relied on, as a possible receipt of Oct 31');
  ok(!!s.rowOf('amandaSalaryMonthEnd', '2026-10-31') && s.rowOf('amandaSalaryMonthEnd', '2026-10-31').amount === 2200,
    'Oct 31 is still projected once at 2200');
}
// A credit before the current period (Oct 23) is already inside its opening cash. With Dale's Oct 23 received, only
// Oct 31's run-up (from Oct 16) holds it, so Oct 31 is not added again at the close.
const dale = () => payroll('2026-10-23', 1400, 'Invented employer');
const paid = serve({ asOf: '2026-10-28', txs: [oct15(), dale()] });
ok(paid.live, 'control with Dale\'s Oct 23 received', JSON.stringify([paid.income, paid.bad, paid.close]));
{
  const earlier = serve({ asOf: '2026-10-28', txs: [oct15(), dale(), payroll('2026-10-20', 2200)] });
  ok(earlier.live && earlier.income === paid.income && earlier.bad === paid.bad && earlier.close === paid.close,
    'the same pay on Tue Oct 20, 8 business days early, before the period: income and BAD as the control; the close does '
    + 'not add Oct 31 again (its cash is in the opening, so the close is the control\'s)',
    JSON.stringify([earlier.income, earlier.bad, earlier.close, paid.close]));
}

console.log('2. (b) a pay split into two credits, each under half');
for (const [why, txs] of [
  ['salary-alias 1000 + 1050, Tue Oct 27', () => [bills('2026-10-27', 1000), bills('2026-10-27', 1050)]],
  ['Payroll-filed non-salary 1100 + 1100, Tue Oct 27', () => [payroll('2026-10-27', 1100), payroll('2026-10-27', 1100)]],
]) {
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), ...txs()] });
  once(s, control, why);
}
{
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), dale(), payroll('2026-10-19', 1000), payroll('2026-10-27', 1200)] });
  ok(s.live && s.income === paid.income && s.bad === paid.bad && s.close === paid.close,
    'Payroll-filed non-salary 1000 Mon Oct 19 (before the period) + 1200 Tue Oct 27: counted once; the close does not '
    + 'add Oct 31 again, and the 1000 already in the opening is not added either',
    JSON.stringify([s.income, s.bad, s.close, paid.close]));
}

console.log('3. The Mon Oct 26 case, for the right reason');
{
  // With Dale's Oct 23 pay received, nothing else is near Oct 26: Amanda's run-up holds it.
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), dale(), payroll('2026-10-26', 2200)] });
  once(s, paid, 'a Payroll-filed 2200 on Mon Oct 26 with Dale\'s Oct 23 already received');
  ok(!!heldRow(s, 2200), 'held To confirm as a possible receipt of Oct 31, not of Dale\'s Oct 23');
}

console.log('4. Unchanged: an on-time pay, a credit under half, and two incomes keep their own credits');
{
  const onTime = serve({ asOf: '2026-10-30', txs: [oct15(), bills('2026-10-30', 2200)] });
  ok(onTime.live && onTime.settled.includes('MonthEnd@2026-10-31:2200') && onTime.income === 3600,
    'a salary-payee 2200 on Fri Oct 30 settles Oct 31 once (received), income 3600', JSON.stringify([onTime.settled, onTime.income]));
  const small = serve({ asOf: '2026-10-28', txs: [oct15(), bills('2026-10-27', 1050)] });
  ok(small.live && small.income === 3600 + 1050 && !heldRow(small, 1050),
    'a single 1050 (under half of 2200) is ordinary Other income, counted; Dale\'s Nov 6 (1050 is over half of 1400) does not take it',
    JSON.stringify([small.income, small.otherIncome]));
}

console.log('5. A first occurrence holds over one cadence interval back');
{
  // Oct 31 is the stream's first occurrence (firstDue), so no previous one is in the data: one month back (Oct 1).
  const first = serve({ asOf: '2026-10-28', monthEndFirstDue: '2026-10-31', txs: [oct15(), dale()] });
  const s = serve({ asOf: '2026-10-28', monthEndFirstDue: '2026-10-31', txs: [oct15(), dale(), payroll('2026-10-20', 2200)] });
  ok(s.live && s.income === first.income && s.bad === first.bad && s.close === first.close,
    'a Payroll-filed 2200 on Tue Oct 20 before the stream\'s first occurrence (a 3-day window would miss it): held, '
    + 'and Oct 31 is not added again at the close', JSON.stringify([s.income, s.bad, s.close, first.close]));
}

console.log('6. Known cautious limit: a payday that passes unproven, beside a held credit, is counted by neither');
{
  // As of Mon Nov 2 the Oct 27 credit is still held (Oct 31 never proven) and Oct 31 itself is To confirm.
  const s = serve({ asOf: '2026-11-02', txs: [oct15(), payroll('2026-10-27', 2190)] });
  const row = s.rowOf('amandaSalaryMonthEnd', '2026-10-31');
  ok(s.live && !!heldRow(s, 2190) && row && row.status !== 'received' && row.alreadyInCash !== true,
    'the credit stays To confirm and Oct 31 is not received: neither is relied on (understates, never overstates)',
    JSON.stringify([s.live, row && row.status]));
}

console.log('7. The next period carries the same cash as the control');
{
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), payroll('2026-10-27', 2190)] });
  ok(s.next && control.next && s.next.balanceAfterDeductions === control.next.balanceAfterDeductions
    && s.next.plannedPeriodClose === control.next.plannedPeriodClose,
    'next period BAD and close equal the control\'s', JSON.stringify([s.next && s.next.balanceAfterDeductions, control.next && control.next.balanceAfterDeductions]));
}

if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll early salary credit run-up checks passed.');
