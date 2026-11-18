'use strict';
/* Cadence from Lunch Money (owner decision, Dale 2026-11-18, recorded on
 * #821 by the lead). A bill's reviewed Lunch Money recurring item leads its
 * cadence (granularity and quantity), not only its day, wherever Forecast
 * expands that cadence exactly:
 *   month x1 -> monthly, month x3 -> quarterly, week x2 -> biweekly,
 *   year x1 -> yearly (anchor's month and day).
 * An item that has ended stops the bill after its end date (lastDue). Any
 * cadence Atlas cannot map, and every doubt case, keeps the plan's cadence and
 * day, estimated. Served plan only (data.json is never written); amount,
 * firstDue and the amount tag stay the plan's. The owner-policy guard widens
 * only to frequency and its phase fields on a scheduled bill.
 *
 * Invented world (test/acceptance/harness.js), as of 2026-10-14: an invented
 * $80 band-room bill planned monthly on the 20th, firstDue 2026-10-01,
 * estimated, paid from Bills (chequing-a). Every forward walk is hand-derived
 * in its comment.
 *
 * `node test/test-lunchmoney-recurring-cadence.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const ID = '7123457';
const BILL = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 20, firstDue: '2026-10-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
const item = ({ granularity = 'month', quantity = 1, anchorDate = '2026-01-20', endDate = null, expected = ['2026-10-20'] } = {}) => ({
  providerId: ID, status: 'reviewed', unavailableFields: [],
  criteria: { startDate: '2026-01-01', endDate, granularity, quantity, anchorDate, currency: 'CAD', plaidAccountId: '9001', manualAccountId: null },
  matches: { expectedOccurrenceDates: expected, foundTransactions: [], missingTransactionDates: expected } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-11-14' }, items } });

function serve(recurringItems) {
  const w = H.baseWorld('2026-10-14');
  w.bills = [{ ...BILL }];
  w.identityRules = w.identityRules.concat([{ eventId: 'band', lunchMoneyRecurringIds: [ID], atlasAccountId: 'chequing-a',
    direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
    postingDateRule: 'covers-early-or-due-on-or-before-posting' }]);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)),
    payload: { ...H.rawPayload(w), ...(recurringItems ? { recurringItems } : {}) },
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const bill = r.data.plan.bills.find(b => b.id === 'band');
  const walk = (from, to) => F.expandEvents(r.data.plan, from, to).filter(e => e.id === 'band').map(e => e.date);
  return { applied: r.data.liveOverlay.applied, bill, walk };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const planStands = (s, why) => {
  ok(s.applied === true, why + ': the overlay applies');
  ok(s.bill.frequency === 'monthly' && s.bill.day === 20 && s.bill.dateConfidence === 'estimated',
    why + ': the plan\'s monthly-on-the-20th stands, estimated', JSON.stringify([s.bill.frequency, s.bill.day, s.bill.dateConfidence]));
  // Plan monthly on the 20th, Nov 1-Jan 31: Nov 20, Dec 20, Jan 20.
  ok(same(s.walk('2026-11-01', '2027-01-31'), ['2026-11-20', '2026-12-20', '2027-01-20']),
    why + ': Nov 20, Dec 20, Jan 20', JSON.stringify(s.walk('2026-11-01', '2027-01-31')));
};

console.log('1. Monthly -> biweekly: LM every 2 weeks from Fri Oct 16 leads');
{
  // Oct 16 + 14 days: Oct 30, Nov 13, Nov 27, Dec 11, Dec 25 (and Jan 8).
  const s = serve(read([item({ granularity: 'week', quantity: 2, anchorDate: '2026-10-16', expected: ['2026-10-02', '2026-10-16'] })]));
  ok(s.bill.frequency === 'biweekly' && s.bill.anchor === '2026-10-16' && !Object.hasOwn(s.bill, 'day'),
    'served biweekly from Oct 16, no monthly day', JSON.stringify(s.bill));
  ok(s.bill.dateConfidence === 'confirmed' && s.bill.confidence === 'estimated' && s.bill.amount === 80 && s.bill.firstDue === '2026-10-01',
    'date tag confirmed; amount $80, its tag and firstDue are the plan\'s');
  ok(same(s.walk('2026-11-01', '2026-12-31'), ['2026-11-13', '2026-11-27', '2026-12-11', '2026-12-25']),
    'Nov 13, Nov 27, Dec 11, Dec 25', JSON.stringify(s.walk('2026-11-01', '2026-12-31')));
}

console.log('2. Yearly: LM once a year on Mar 15 leads');
{
  // Nothing expected inside the read window. Nov 1 2026-Dec 31 2028:
  // Mar 15 2027 and Mar 15 2028.
  const s = serve(read([item({ granularity: 'year', anchorDate: '2026-03-15', expected: [] })]));
  ok(s.bill.frequency === 'yearly' && s.bill.month === 3 && s.bill.day === 15 && s.bill.dateConfidence === 'confirmed',
    'served yearly, March 15, confirmed', JSON.stringify(s.bill));
  ok(same(s.walk('2026-11-01', '2028-12-31'), ['2027-03-15', '2028-03-15']), 'Mar 15 2027, Mar 15 2028',
    JSON.stringify(s.walk('2026-11-01', '2028-12-31')));
}

console.log('3. Quarterly: LM every 3 months from Jan 5 leads');
{
  // Phase Jan 5: Jan, Apr, Jul, Oct. Nov 1 2026-Dec 31 2027: Jan 5, Apr 5,
  // Jul 5, Oct 5 2027.
  const s = serve(read([item({ quantity: 3, anchorDate: '2026-01-05', expected: ['2026-10-05'] })]));
  ok(s.bill.frequency === 'quarterly' && s.bill.day === 5 && s.bill.anchor === '2026-01-05', 'served quarterly on the 5th from Jan 5',
    JSON.stringify(s.bill));
  ok(same(s.walk('2026-11-01', '2027-12-31'), ['2027-01-05', '2027-04-05', '2027-07-05', '2027-10-05']),
    'Jan 5, Apr 5, Jul 5, Oct 5 2027', JSON.stringify(s.walk('2026-11-01', '2027-12-31')));
}

console.log('4. Ended items stop the bill after their end date');
{
  // Ends Dec 31: monthly on the 20th through Dec 20; nothing in Jan-Mar.
  const s = serve(read([item({ endDate: '2026-12-31' })]));
  ok(s.bill.lastDue === '2026-12-31' && s.bill.frequency === 'monthly' && s.bill.day === 20, 'served monthly on the 20th, last due Dec 31',
    JSON.stringify(s.bill));
  ok(same(s.walk('2026-11-01', '2027-03-31'), ['2026-11-20', '2026-12-20']), 'Nov 20, Dec 20, then none',
    JSON.stringify(s.walk('2026-11-01', '2027-03-31')));
  // Ended Oct 10, before today, nothing expected after: no occurrence from
  // Oct 14 on (Oct 20 would have been next).
  const gone = serve(read([item({ endDate: '2026-10-10', expected: [] })]));
  ok(same(gone.walk('2026-10-14', '2027-03-31'), []), 'ended Oct 10: no occurrence from Oct 14 on',
    JSON.stringify(gone.walk('2026-10-14', '2027-03-31')));
}

console.log('5. Any cadence Atlas cannot map, and any doubt, keeps the plan\'s cadence and day, estimated');
planStands(serve(), 'no read (control)');
planStands(serve(read([item({ granularity: 'week', quantity: 1, anchorDate: '2026-10-06', expected: ['2026-10-06', '2026-10-13'] })])), 'weekly');
planStands(serve(read([item({ quantity: 2 })])), 'every two months');
planStands(serve(read([item({ granularity: 'day', quantity: 10, anchorDate: '2026-10-05', expected: ['2026-10-05'] })])), 'every ten days');
// Biweekly from Oct 16 cannot produce Oct 9 (one week off phase).
planStands(serve(read([item({ granularity: 'week', quantity: 2, anchorDate: '2026-10-16', expected: ['2026-10-09'] })])),
  'expected dates off the mapped cadence');
planStands(serve(read([{ ...item(), status: 'suggested' }])), 'a suggestion, not reviewed');

console.log('6. The owner-policy guard widens only to frequency and its phase fields on a scheduled bill');
{
  const before = { plan: { bills: [BILL] } };
  const after = patch => ({ plan: { bills: [Object.fromEntries(Object.entries({ ...BILL, ...patch }).filter(([, v]) => v !== undefined))] } });
  const throws = (a, set) => { try { Live.assertOwnerPolicyUntouched(before, a, set); return false; } catch (_) { return true; } };
  const band = new Set(['band']);
  ok(!throws(after({ frequency: 'biweekly', day: undefined, anchor: '2026-10-16', dateConfidence: 'confirmed' }), band),
    'scheduled: frequency, anchor and a removed day may differ');
  ok(!throws(after({ frequency: 'yearly', month: 3, day: 15, dateConfidence: 'confirmed' }), band), 'scheduled: yearly month and day may differ');
  ok(!throws(after({ lastDue: '2026-12-31', dateConfidence: 'confirmed' }), band), 'scheduled: an end date may be added');
  ok(throws(after({ frequency: 'biweekly', anchor: '2026-10-16' }), new Set()), 'not scheduled: the cadence may not differ');
  ok(throws(after({ frequency: 'biweekly', amount: 40 }), band), 'scheduled: the amount still may not differ');
  ok(throws(after({ firstDue: '2026-11-01' }), band), 'scheduled: firstDue still may not differ');
  ok(throws(after({ dateConfidence: 'verified' }), band), 'scheduled: the date tag may become nothing but confirmed');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Lunch Money recurring cadence checks passed.');
