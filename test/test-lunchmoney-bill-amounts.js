'use strict';
/* Amounts from Lunch Money (owner, Dale 2026-11-21; lead plan approved 2026-11-21): a bill linked by
 * lunchMoneyRecurringIds is served at its reviewed item's amount when that amount is a positive whole-cent CAD
 * amount; otherwise the plan's amount stands with a closed reason. Served plan only; the amount tag stays the plan's;
 * card/obligation rows and Bell never take an item amount.
 *
 * Invented world (test/acceptance/harness.js): payday anchor 2026-10-09, as of 2026-10-14; periods Oct 9-22 and
 * Oct 23-Nov 5. An invented $80 band-room bill, monthly on the 20th, estimated, from Bills; its item, also on the
 * 20th, carries an invented amount. Hand-derived: Oct 20 is in the current period; the served amount is the item's
 * (e.g. 64.25), the plan document still says 80, and the amount tag stays estimated. */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe.js');
const F = require('../public/forecast.js');
let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => { checks++; if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); };
const J = JSON.stringify;
const ID = '7123460';
const BILL = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 20, firstDue: '2026-10-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
const item = (id, amount, extra = {}) => ({ providerId: id, status: 'reviewed', unavailableFields: [],
  criteria: { startDate: '2026-01-20', endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-01-20',
    currency: 'CAD', plaidAccountId: '9001', manualAccountId: null, ...(amount === undefined ? {} : { amount }), ...(extra.criteria || {}) },
  matches: { expectedOccurrenceDates: ['2026-10-20'], foundTransactions: [] } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-10-14' }, items } });
const rule = (eventId, rid) => ({ eventId, lunchMoneyRecurringIds: [rid], atlasAccountId: 'chequing-a', direction: 'debit',
  requiredCurrency: 'cad', requiredPostingEvidence: 'posted', postingDateRule: 'covers-early-or-due-on-or-before-posting' });

function serve(items, opts = {}) {
  const w = H.baseWorld();
  w.bills = [{ ...BILL, ...(opts.bill || {}) }, ...(opts.extraBills || [])];
  w.identityRules = w.identityRules.concat(opts.rules || [rule(opts.bill && opts.bill.id || 'band', ID)]);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...(opts.transactions || [])];
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  const before = J(canonical);
  const r = Live.fromObservation({ data: canonical, payload: { ...H.rawPayload(w), recurringItems: read(items) },
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const plan = r.data.plan;
  const adv = F.recommend(plan, w.asOf, { currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals, debts: r.data.debts });
  const cur = (adv.defaultView.calendarPeriods.find(p => p.start === '2026-10-09').bills || []).filter(b => b.id === (opts.bill && opts.bill.id || 'band'));
  return { bill: plan.bills.find(b => b.id === (opts.bill && opts.bill.id || 'band')), cur, unchanged: J(canonical) === before,
    schedules: r.report.recurringBillSchedules || [] };
}

console.log('1. A whole-cent CAD item amount is the served amount; the plan document and the tag stay');
{
  const s = serve([item(ID, '64.2500')]);
  ok(s.bill.amount === 64.25, 'served amount 64.25 (the item\'s), not the plan\'s 80', String(s.bill.amount));
  ok(s.bill.confidence === 'estimated', 'the amount tag stays the plan\'s estimated (no promotion)');
  ok(s.unchanged, 'the canonical document is not written');
  ok(s.cur.length === 1 && s.cur[0].amount === 64.25, 'the Oct 20 occurrence carries 64.25', J(s.cur.map(b => [b.date, b.amount])));
}

console.log('2. Anything else keeps the plan\'s 80, with a closed reason');
for (const [label, items, opts, reason] of [
  ['no amount', [item(ID, undefined)], {}, 'amount-unavailable'],
  ['zero', [item(ID, '0.00')], {}, 'amount-unavailable'],
  ['negative', [item(ID, '-5.00')], {}, 'amount-unavailable'],
  ['fraction of a cent', [item(ID, '12.345')], {}, 'amount-unavailable'],
  ['not a number', [item(ID, 'twelve')], {}, 'amount-unavailable'],
  ['owner promotional terms', [item(ID, '64.25')], { bill: { amountSchedule: [{ from: '2026-11-01', until: '2027-01-01', amount: 50 }] } }, 'amount-schedule-present'],
]) {
  const s = serve(items, opts);
  const sched = s.schedules.find(x => x.billId === 'band');
  ok(s.bill.amount === 80 && sched && sched.amountReason === reason, `${label}: plan 80 stands (${reason})`, J([s.bill.amount, sched && sched.amountReason]));
}

console.log('3. Bell never takes an item amount (two payments, one item)');
{
  const s = serve([item(ID, '75.00')], { bill: { id: 'bell', label: 'Invented phone', amount: 160 } });
  const sched = s.schedules.find(x => x.billId === 'bell');
  ok(s.bill.amount === 160 && sched && sched.amountReason === 'amount-excluded', 'bell stays 160 (amount-excluded)', J([s.bill.amount, sched && sched.amountReason]));
  ok(O.RECURRING_AMOUNT_EXCLUDED_BILL_IDS.has('bell') && O.RECURRING_AMOUNT_EXCLUDED_BILL_IDS.size === 1, 'the excluded list is exactly bell');
}

console.log('4. Removing the link restores the plan amount');
{
  const s = serve([item(ID, '64.25')], { rules: [] });
  ok(s.bill.amount === 80 && !s.schedules.some(x => x.billId === 'band'), 'unlinked: no schedule, plan 80');
}

console.log('5. A settled occurrence keeps what was paid');
{
  const paid = H.lm({ date: '2026-10-14', amount: 79.5, account: 'chequing-a', payee: 'Invented band', raw: { recurring_id: Number(ID) } });
  const s = serve([item(ID, '64.25')], { transactions: [paid] });
  const row = s.cur[0];
  ok(row && /paid/i.test(row.status || row.householdPaymentStatus || '') && Math.abs(Number(row.cashPaid ?? row.actual) - 79.5) < 0.005,
    'the linked posted 79.50 on Oct 14 (inside the 7-day early window) settles Oct 20 at what was paid, not the item amount', J(row && { status: row.status, cashPaid: row.cashPaid, actual: row.actual }));
}

console.log('6. Card and obligation rows never take an item amount');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../scripts/provider-observe.js'), 'utf8');
  const obl = src.slice(src.indexOf('function recurringObligationSchedule'), src.indexOf('function applyRecurringObligationSchedule'));
  ok(!/recurringBillAmount|amounts/.test(obl), 'the card/obligation schedule path reads no item amount');
}
console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
