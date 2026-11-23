'use strict';
/* #1508 live check and the #1511 lead design ruling (2026-11-21): a linked bill whose Lunch Money item sits on another
 * day must never re-date its recorded history. The cutover is the link's recorded `linkedFrom` (a first of a month in
 * transaction-identity.json), never derived from the observation date, the pay period or the item start: before it the
 * bill keeps its own timing (timingBefore); from it the item's timing applies. A link with no linkedFrom changes no
 * timing (refused, link-anchor-missing). Invented bills, items and payments only; dates and statuses only. */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe.js');
const F = require('../public/forecast.js');
const data = require('../data.json');
const identity = require('../docs/connectivity/transaction-identity.json');
let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => { checks++; if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); };
const J = JSON.stringify;
const ID = '7123470';
const BILL = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 15, firstDue: '2026-08-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
const item = (startDate, extra = {}) => ({ providerId: ID, status: 'reviewed', unavailableFields: [],
  criteria: { startDate, endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-11-16',
    currency: 'CAD', plaidAccountId: '9001', manualAccountId: null, ...extra },
  matches: { expectedOccurrenceDates: [], foundTransactions: [] } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-10-14' }, items } });
const RULE = { eventId: 'band', lunchMoneyRecurringIds: [ID], linkedFrom: '2026-11-01', atlasAccountId: 'chequing-a', direction: 'debit',
  payeePatterns: ['Invented band'], requiredCurrency: 'cad', requiredPostingEvidence: 'posted', postingDateRule: 'same-day-or-weekend-next-business-day' };
const pay = date => H.lm({ date, amount: 80, account: 'chequing-a', payee: 'Invented band' });

function serve(items, rules, asOf, payments, bill = BILL) {
  const w = H.baseWorld(asOf);
  w.bills = [{ ...bill }];
  w.identityRules = w.identityRules.concat(rules);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...payments.map(pay)];
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  const r = Live.fromObservation({ data: canonical, payload: { ...H.rawPayload(w), recurringItems: read(items) },
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const plan = r.data.plan;
  const adv = F.recommend(plan, w.asOf, { currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals, debts: r.data.debts });
  const rows = [];
  const published = [];
  for (const p of adv.defaultView.calendarPeriods || []) for (const b of p.bills || []) if (b.id === 'band') {
    rows.push({ date: b.date, status: b.status, period: p.start });
    published.push(b);
  }
  return { bill: plan.bills.find(b => b.id === 'band'), rows, published, refusals: r.report.recurringScheduleRefusals || r.report.recurringBillScheduleRefusals || null };
}
const paid = (s, date) => s.rows.some(b => b.date === date && /paid/i.test(b.status || ''));

console.log('0. Matching cadence: provider date confidence starts at linkedFrom');
{
  const same = item('2025-01-01', { anchorDate: '2026-11-15' });
  // A known amount must not conceal a less certain date on the published row.
  const estimated = { ...BILL, confidence: 'confirmed' };
  const { dateConfidence, ...untagged } = estimated;
  const tagAt = (s, date) => s.published.filter(b => b.date === date).map(b => [b.date, b.dateConfidence]);
  const expected = pre => [['2026-10-15', pre], ['2026-11-15', 'confirmed']];
  for (const [label, bill, pre] of [['estimated', estimated, 'estimated'], ['absent', untagged, 'estimated'],
    ['confirmed', { ...BILL, dateConfidence: 'confirmed' }, 'confirmed']]) {
    const linked = serve([same], [RULE], '2026-10-21', [], bill);
    const unlinked = serve([same], [], '2026-10-21', [], bill);
    const later = serve([same], [RULE], '2026-10-23', [], bill);
    const dates = [...tagAt(linked, '2026-10-15'), ...tagAt(later, '2026-11-15')];
    ok(J(dates) === J(expected(pre)),
      label + ': past Oct 15 keeps plan trust and Nov 15 is provider-confirmed', J(dates));
    ok(J(linked.rows) === J(unlinked.rows), label + ': dates, periods and statuses are unchanged');
    ok(J(unlinked.bill) === J(bill), label + ': unlinked plan bill is unchanged');
  }
  const moved = serve([item('2025-01-01')], [RULE], '2026-10-21', []);
  const movedLater = serve([item('2025-01-01')], [RULE], '2026-10-23', []);
  ok(J([...tagAt(moved, '2026-10-15'), ...tagAt(movedLater, '2026-11-16')])
    === J([['2026-10-15', 'estimated'], ['2026-11-16', 'confirmed']]),
  'different cadence: prior day and trust are preserved, new day and trust start at the cutover');
}

console.log('1. Reviewer case: a payment inside the current period, item start long before it (linkedFrom Nov 1)');
for (const start of ['2025-01-01', '2026-08-01', null]) {
  const s = serve([item(start)], [RULE], '2026-10-21', ['2026-10-15']);
  ok(J(s.bill.timingBefore) === J({ from: '2026-11-01', frequency: 'monthly', day: 15, dateConfidence: 'estimated' }), `start ${start}: cutover is linkedFrom Nov 1, with the plan's estimated date tag`, J(s.bill.timingBefore));
  ok(paid(s, '2026-10-15') && !s.rows.some(b => b.date === '2026-10-16'), `start ${start}: Oct 15, paid on the 15th, is paid; no Oct 16 row`, J(s.rows));
}

console.log('2. Reviewer case: the period rolls (Oct 23) and nothing paid moves or is carried');
for (const start of ['2025-01-01', null]) {
  const before = serve([item(start)], [RULE], '2026-10-21', ['2026-10-15']);
  const after = serve([item(start)], [RULE], '2026-10-23', ['2026-10-15']);
  ok(J(before.bill.timingBefore) === J(after.bill.timingBefore), `start ${start}: the same cutover on Oct 21 and Oct 23`, J([before.bill.timingBefore, after.bill.timingBefore]));
  ok(!after.rows.some(b => b.date < '2026-10-23' && !/paid/i.test(b.status || '') && b.period >= '2026-10-23'),
    `start ${start}: no earlier occurrence is carried into the Oct 23 period`, J(after.rows));
  ok(after.rows.some(b => b.date === '2026-11-16'), `start ${start}: the item's 16th applies from November`, J(after.rows));
}

console.log('3. A missing or malformed linkedFrom changes no timing (fails closed)');
for (const [label, rule] of [['missing', (({ linkedFrom, ...r }) => r)(RULE)], ['not a first of month', { ...RULE, linkedFrom: '2026-11-16' }],
  ['not a date', { ...RULE, linkedFrom: 'soon' }]]) {
  const got = O.recurringBillScheduleReview({ status: 'read', items: [{ recurringId: ID, startDate: '2025-01-01', endDate: null, currency: 'cad',
    accountRole: 'household-cash', expectedDates: [], foundTransactionLocalIds: [], granularity: 'month', quantity: 1, anchorDate: '2026-11-16' }] },
    [rule], { bills: [{ ...BILL }], obligations: [] }, '2026-10-21', {});
  ok(got.schedules.length === 0 && J(got.refused) === J([{ billId: 'band', obligationId: null, reasonCode: 'link-anchor-missing' }]),
    `${label}: refused link-anchor-missing, plan day stands`, J(got));
}
ok(O.RECURRING_REFUSAL_CODES.includes('link-anchor-missing'), 'link-anchor-missing is a closed refusal code');

console.log('4. Every committed bill link records linkedFrom: 2026-12-01 for the #1508 links; spotify and rehearsal-space, live before #1508, from their first month');
const EARLIER = { spotify: '2026-09-01', 'rehearsal-space': '2026-11-01' };
{
  const billIds = new Set(data.plan.bills.map(b => b.id));
  const links = identity.rules.filter(r => (r.lunchMoneyRecurringIds || []).length && billIds.has(r.eventId));
  const bad = links.filter(r => r.linkedFrom !== (EARLIER[r.eventId] || '2026-12-01')).map(r => [r.eventId, r.linkedFrom]);
  ok(links.length > 0 && bad.length === 0, `${links.length} bill links, each with its linkedFrom`, J(bad));
  for (const id of Object.keys(EARLIER)) {
    const b = data.plan.bills.find(x => x.id === id);
    ok(b && EARLIER[id] <= b.firstDue, `${id}: linkedFrom ${EARLIER[id]} is on or before its firstDue (no occurrence keeps the plan day)`, b && b.firstDue);
  }
}

console.log('5. Every 2026-12-01 link, any item start, any observation date: nothing before Dec 1 is re-dated and the cutover never moves');
{
  const ids = {};
  for (const r of identity.rules) for (const x of r.lunchMoneyRecurringIds || []) ids[x] = r.eventId;
  const bills = data.plan.bills.filter(b => Object.values(ids).includes(b.id));
  let moved = 0;
  for (const startDate of ['2026-11-01', '2025-11-01', '2026-08-01', null]) for (const day of [1, 2, 5, 13, 14, 16, 17, 18, 28, 30]) {
    const items = Object.entries(ids).filter(([, id]) => bills.some(b => b.id === id)).map(([rid, id]) => {
      const b = bills.find(x => x.id === id);
      const g = b.frequency === 'quarterly' ? { granularity: 'month', quantity: 3 } : b.frequency === 'biweekly' ? { granularity: 'week', quantity: 2 }
        : { granularity: 'month', quantity: 1 };
      const anchor = b.frequency === 'biweekly' ? '2026-11-0' + (day % 7 + 2) : '2026-11-' + String(day).padStart(2, '0');
      return { recurringId: rid, startDate, endDate: null, currency: 'cad', accountRole: 'household-cash', expectedDates: [],
        foundTransactionLocalIds: [], ...g, anchorDate: anchor };
    });
    const at = asOf => O.recurringBillSchedules({ status: 'read', items }, identity.rules, data.plan, asOf, {});
    const a = at('2026-11-21'), b2 = at('2026-11-28');
    for (const s of a.filter(x => x.billId && !EARLIER[x.billId])) {
      const b = bills.find(x => x.id === s.billId);
      const served = O.applyRecurringSchedule(b, s);
      const other = b2.find(x => x.billId === s.billId);
      const was = F.occurrences(b, '2025-01-01', '2026-11-30');
      const now = F.occurrences(served, '2025-01-01', '2026-11-30');
      if (served.day !== b.day || served.anchor !== b.anchor) moved++;
      const months = {};
      for (const d of F.occurrences(served, '2026-06-01', '2027-06-30')) months[d.slice(0, 7)] = (months[d.slice(0, 7)] || 0) + 1;
      const monthly = served.frequency === 'monthly';
      ok(J(was) === J(now) && J(s.timing) === J(other && other.timing) && (!monthly || Object.values(months).every(n => n === 1)),
        `${b.id}, start ${startDate}, item day ${day}: history through Nov unchanged, same cutover on Nov 21 and Nov 28${monthly ? ', one a month' : ''}`,
        J({ was: was.slice(-2), now: now.slice(-2), before: s.timing.timingBefore }));
    }
  }
  ok(moved > 0, 'the loop exercises moved days', String(moved));
}

console.log('6. The committed plan with bcaa, icbc, resp items on the 16th (any start): Aug-Nov events, the Aug 15 outstanding rows included, equal the unlinked plan; the 16th from Dec');
{
  const ids = {};
  for (const r of identity.rules) for (const x of r.lunchMoneyRecurringIds || []) ids[r.eventId] = x;
  for (const startDate of ['2026-11-01', '2025-11-01', null]) {
    const items = ['bcaa', 'icbc', 'resp'].map(id => ({ recurringId: ids[id], startDate, endDate: null, currency: 'cad',
      accountRole: 'household-cash', expectedDates: [], foundTransactionLocalIds: [], granularity: 'month', quantity: 1, anchorDate: '2026-11-16' }));
    const got = O.recurringBillSchedules({ status: 'read', items }, identity.rules, data.plan, '2026-11-21', {});
    ok(got.filter(x => x.billId).length === 3, `start ${startDate}: all three take a schedule`, J(got.map(x => x.billId)));
    const served = { ...data.plan, bills: data.plan.bills.map(b => { const s = got.find(x => x.billId === b.id); return s ? O.applyRecurringSchedule(b, s) : b; }) };
    const key = plan => F.expandEvents({ ...plan, opening: { ...plan.opening, asOf: '2026-08-01', representedEvents: [] } }, '2026-08-01', '2026-11-30', {})
      .filter(e => /^(bcaa|icbc|resp)/.test(e.id)).map(e => e.id + '@' + e.date).sort();
    ok(J(key(served)) === J(key(data.plan)), `start ${startDate}: Aug to Nov events identical to the unlinked plan`, J([key(served), key(data.plan)]));
    ok(key(served).filter(k => /aug15-outstanding@2026-08-16/.test(k)).length === 3, `start ${startDate}: the three Aug 15 outstanding rows keep their own date`, J(key(served)));
    const dec = F.occurrences(served.bills.find(b => b.id === 'bcaa'), '2026-11-01', '2027-01-31');
    ok(J(dec) === J(['2026-11-15', '2026-12-16', '2027-01-16']), `start ${startDate}: Nov 15 kept, the 16th from Dec`, J(dec));
  }
}

console.log('7. Cadence changes at linkedFrom: a monthly bill on the 25th with a quarterly, monthly-on-the-16th or biweekly item');
{
  const b = { id: 'inv', label: 'Invented', amount: 1, frequency: 'monthly', day: 25, firstDue: '2026-01-01', payingAccount: 'chequing-a' };
  for (const [g, q, a, want] of [['month', 3, '2026-11-16', ['2026-10-25', '2026-11-25', '2027-02-16']],
    ['month', 1, '2026-11-16', ['2026-10-25', '2026-11-25', '2026-12-16', '2027-01-16', '2027-02-16']],
    ['week', 2, '2026-11-13', ['2026-10-25', '2026-11-25', '2026-12-11', '2026-12-25', '2027-01-08', '2027-01-22', '2027-02-05', '2027-02-19']]]) {
    const got = O.recurringBillSchedules({ status: 'read', items: [{ recurringId: '1', startDate: '2025-11-01', endDate: null, currency: 'cad',
      accountRole: 'household-cash', expectedDates: [], foundTransactionLocalIds: [], granularity: g, quantity: q, anchorDate: a }] },
      [{ eventId: 'inv', lunchMoneyRecurringIds: ['1'], linkedFrom: '2026-12-01' }], { bills: [b], obligations: [] }, '2026-11-21', { amounts: new Map([['1', 1]]) });
    const s = O.applyRecurringSchedule(b, got[0]);
    const dates = F.occurrences(s, '2026-10-01', '2027-02-28');
    ok(J(dates) === J(want), `${q} ${g}: the 25th through Nov, then the item's timing from Dec 1`, J(dates));
  }
}

console.log('8. Card rows (obligation cutover path, unchanged): triangle-td3 and mbna-auto30 keep their dated history');
{
  const ids = {};
  for (const r of identity.rules) for (const x of r.lunchMoneyRecurringIds || []) ids[r.eventId] = x;
  const items = [['triangle-td3', '2026-12-03'], ['mbna-auto30', '2026-12-30']].map(([id, a]) => ({ recurringId: ids[id], startDate: '2026-11-01', endDate: null,
    currency: 'cad', accountRole: 'household-cash', expectedDates: [], foundTransactionLocalIds: [], granularity: 'month', quantity: 1, anchorDate: a }));
  const got = O.recurringBillSchedules({ status: 'read', items }, identity.rules, data.plan, '2026-11-21', {});
  for (const id of ['triangle-td3', 'mbna-auto30']) {
    const row = data.plan.obligations.find(o => o.id === id);
    const s = got.find(x => x.obligationId === id);
    const served = s ? { ...row, ...s.fields } : row;
    ok(J(F.occurrences(row, '2025-01-01', '2026-11-21')) === J(F.occurrences(served, '2025-01-01', '2026-11-21')), `${id}: no occurrence on or before the observation date moves`);
  }
}

console.log('9. spotify and rehearsal-space serve exactly the occurrences main serves (no cutover effect), for invented item days');
{
  const ids = {};
  for (const r of identity.rules) for (const x of r.lunchMoneyRecurringIds || []) ids[r.eventId] = x;
  for (const day of [1, 5, 9, 16, 23, 28]) {
    const items = Object.keys(EARLIER).map(id => ({ recurringId: ids[id], startDate: '2026-09-01', endDate: null, currency: 'cad', accountRole: 'household-cash',
      expectedDates: [], foundTransactionLocalIds: [], granularity: 'month', quantity: 1, anchorDate: '2026-11-' + String(day).padStart(2, '0') }));
    const got = O.recurringBillSchedules({ status: 'read', items }, identity.rules, data.plan, '2026-11-21', {});
    for (const id of Object.keys(EARLIER)) {
      const b = data.plan.bills.find(x => x.id === id);
      const s = got.find(x => x.billId === id);
      const served = O.applyRecurringSchedule(b, s);
      const { timingBefore, ...mainTiming } = s.timing;
      const main = O.applyRecurringSchedule(b, { ...s, timing: mainTiming });
      ok(J(F.occurrences(served, '2026-01-01', '2027-06-30')) === J(F.occurrences(main, '2026-01-01', '2027-06-30')),
        `${id}, item day ${day}: occurrences identical to main's`, J(F.occurrences(served, '2026-08-01', '2026-12-31')));
    }
  }
}

console.log('10. Reviewer case (date tag, owner stop 2): plan day 20 estimated, item on the 25th, linkedFrom Nov 1, as of Oct 14');
{
  const b = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 20, firstDue: '2026-09-01',
    confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
  const got = O.recurringBillSchedules({ status: 'read', items: [{ recurringId: ID, startDate: '2026-01-01', endDate: null, currency: 'cad',
    accountRole: 'household-cash', expectedDates: [], foundTransactionLocalIds: [], granularity: 'month', quantity: 1, anchorDate: '2026-10-25' }] },
    [{ ...RULE, eventId: 'band' }], { bills: [b], obligations: [] }, '2026-10-14', {});
  const served = { ...O.applyRecurringSchedule(b, got[0]), dateConfidence: got[0].dateConfidence };
  ok(served.dateConfidence === 'confirmed' && served.timingBefore.dateConfidence === 'estimated', 'served: the item\'s confirmed tag; timingBefore keeps the plan\'s estimated', J(served));
  const plan = { ...data.plan, bills: [served], obligations: [], commitments: [], opening: { ...data.plan.opening, asOf: '2026-10-01', representedEvents: [] } };
  const ev = F.expandEvents(plan, '2026-10-01', '2026-12-31', {}).filter(e => e.id === 'band').map(e => [e.date, e.dateConfidence]);
  ok(J(ev) === J([['2026-10-20', 'estimated'], ['2026-11-25', 'confirmed'], ['2026-12-25', 'confirmed']]),
    'October (plan day 20) stays estimated; November and December (the 25th) are confirmed', J(ev));
  const plain = { ...b };
  const ev0 = F.expandEvents({ ...plan, bills: [plain] }, '2026-10-01', '2026-11-30', {}).filter(e => e.id === 'band');
  ok(ev0.every(e => !Object.hasOwn(e, 'dateConfidence')), 'a bill with no cutover carries no per-occurrence date tag (unchanged)', J(ev0.map(e => e.dateConfidence)));
  const odd = { ...served, timingBefore: { ...served.timingBefore, dateConfidence: 'verified' } };
  const ev1 = F.expandEvents({ ...plan, bills: [odd] }, '2026-10-01', '2026-10-31', {}).filter(e => e.id === 'band').map(e => e.dateConfidence);
  ok(J(ev1) === J(['estimated']), 'an unknown earlier tag reads estimated, never more certain', J(ev1));
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
