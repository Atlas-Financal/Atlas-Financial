'use strict';
/* S2 (owner decision #821 6956651970 (a)/(b), lead ruling 2026-11-17): a
 * REVIEWED Lunch Money recurring item is the authority for its bill's
 * schedule, and "reviewed" confirms the schedule only. For a monthly bill
 * whose identity rule names the item (lunchMoneyRecurringIds), the item's
 * anchor day leads every future occurrence and the date tag becomes
 * confirmed, even when it differs from the plan's day (owner decision, Dale
 * 2026-11-17: "no friction if the date drifts"; this retires #1281's
 * anchor-equals-plan cross-check). Amount, firstDue, the amount tag and
 * settlement stay the plan's. Any doubt keeps the plan's own day and tags.
 *
 * Invented world (test/acceptance/harness.js): payday anchor 2026-10-09,
 * biweekly, as of 2026-10-14; pay periods Oct 9-22, Oct 23-Nov 5. An
 * invented $80 band-room bill, monthly, plan day 20, firstDue 2026-10-01,
 * estimated amount and date, paid from Bills (chequing-a).
 * Hand-derived: Oct 20 is in the current period (Oct 9-22), and Nov 5 ends
 * the next period before Nov 20, so the next period holds none. $80, still
 * due, amount tag still estimated. Only the date tag differs between the
 * confirmed path (reviewed item anchored on the 20th) and every fallback.
 *
 * `node test/test-lunchmoney-recurring-bill-day.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe.js');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const ID = '7123457';
const BILL = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 20, firstDue: '2026-10-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
const criteria = extra => ({ startDate: '2026-01-20', endDate: null, granularity: 'month', quantity: 1,
  anchorDate: '2026-01-20', currency: 'CAD', plaidAccountId: '9001', manualAccountId: null, ...extra });
const readItem = (id, extra = {}) => ({ providerId: id, status: 'reviewed', unavailableFields: [],
  criteria: criteria(extra.criteria), matches: { expectedOccurrenceDates: extra.expected || ['2026-10-20'], foundTransactions: [] } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-10-14' }, items } });

function world(opts = {}) {
  const w = H.baseWorld();
  w.bills = [{ ...BILL, ...(opts.bill || {}) }];
  w.identityRules = w.identityRules.concat(opts.rules || [{ eventId: 'band', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID],
    atlasAccountId: 'chequing-a', direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
    postingDateRule: 'covers-early-or-due-on-or-before-posting' }]);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...(opts.transactions || [])];
  return w;
}
function serveRaw(w) {
  H.productionOpening(w);
  return Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) }).data;
}
function serve(w, recurringItems) {
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  const before = JSON.stringify(canonical);
  const payload = { ...H.rawPayload(w), ...(recurringItems === undefined ? {} : { recurringItems }) };
  const r = Live.fromObservation({ data: canonical, payload, accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const plan = r.data.plan;
  const adv = F.recommend(plan, w.asOf, { currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals, debts: r.data.debts });
  const periods = adv.defaultView.calendarPeriods;
  const band = p => (p.bills || []).filter(b => b.id === 'band' || /band room/i.test(b.label || ''));
  return { canonicalUnchanged: JSON.stringify(canonical) === before, bill: plan.bills.find(b => b.id === 'band'),
    noWithheldKey: !Object.hasOwn(r.report, 'recurringBillSchedulesWithheld'), scheduled: r.report.recurringBillSchedules || [],
    current: band(periods.find(p => p.start === '2026-10-09')), next: band(periods.find(p => p.start === '2026-10-23')),
    applied: r.data.liveOverlay.applied };
}
const planDay = (s, why, day = 20) => {
  ok(s.applied === true, why + ': the overlay still applies');
  ok(s.bill.day === day && s.bill.dateConfidence === 'estimated' && s.bill.confidence === 'estimated',
    why + ': the plan\'s own day ' + day + ' and estimated tags stand', JSON.stringify([s.bill.day, s.bill.dateConfidence]));
  ok(s.scheduled.length === 0, why + ': no schedule applied');
  if (day === 20) ok(s.current.length === 1 && s.current[0].date === '2026-10-20' && s.next.length === 0,
    why + ': $80 on Oct 20, current period', JSON.stringify([s.current.map(b => b.date), s.next.map(b => b.date)]));
};

console.log('1. No recurring read: the plan\'s day, estimated');
planDay(serve(world(), undefined), 'no read');

console.log('2. A reviewed item anchored on the plan\'s day (20th) confirms it; only the date tag changes');
{
  const s = serve(world(), read([readItem(ID)]));
  ok(s.bill.day === 20 && s.scheduled.length === 1 && s.noWithheldKey, 'served day is the agreed anchor day',
    String(s.bill.day));
  ok(s.bill.dateConfidence === 'confirmed', 'the date tag is confirmed (reviewed confirms the schedule)');
  ok(s.bill.confidence === 'estimated', 'the amount tag stays estimated');
  ok(s.bill.amount === 80 && s.bill.firstDue === '2026-10-01' && s.bill.payingAccount === 'chequing-a'
    && s.bill.label === 'Invented band room', 'amount, firstDue, account and label are the plan\'s');
  ok(s.canonicalUnchanged, 'the canonical document is not written');
  ok(s.current.length === 1 && s.current[0].date === '2026-10-20' && s.current[0].amount === 80,
    '$80 on Oct 20, in the current period', JSON.stringify(s.current.map(b => [b.date, b.amount])));
  ok(s.current[0] && s.current[0].status === 'still due', 'still due: the read settles nothing', s.current[0] && s.current[0].status);
  ok(s.next.length === 0, 'no band-room bill in the next period');
}

console.log('2a. Day leads: an anchor day that differs from the plan\'s day wins, confirmed');
{
  // Plan day 20, reviewed item anchored on the 4th, linked from Jan 1: the
  // served day is the 4th, confirmed. Hand-derived: Oct 4 is before the Oct 9
  // opening, so the next occurrence is Nov 4, in the Oct 23-Nov 5 period; the
  // current period holds none.
  const s = serve(world(), read([readItem(ID, { criteria: { anchorDate: '2026-01-04' }, expected: ['2026-10-04'] })]));
  ok(s.bill.day === 4 && s.bill.dateConfidence === 'confirmed' && s.bill.confidence === 'estimated',
    'served day 4, date confirmed, amount still estimated', JSON.stringify([s.bill.day, s.bill.dateConfidence, s.bill.confidence]));
  ok(s.scheduled.length === 1 && s.noWithheldKey, 'applied, nothing withheld');
  ok(s.current.length === 0 && s.next.length === 1 && s.next[0].date === '2026-11-04', '$80 on Nov 4, next period',
    JSON.stringify([s.current.map(b => b.date), s.next.map(b => b.date)]));
  // And the other way: plan day 4, anchor on the 4th, agrees and confirms.
  const agree = serve(world({ bill: { day: 4 } }), read([readItem(ID, { criteria: { anchorDate: '2026-01-04' }, expected: ['2026-10-04'] })]));
  ok(agree.bill.day === 4 && agree.bill.dateConfidence === 'confirmed' && agree.noWithheldKey,
    'plan day 4 and anchor 4th agree: confirmed', JSON.stringify([agree.bill.day, agree.bill.dateConfidence]));
}

console.log('2a-ii. Owner fact (Dale 2026-11-17): due on the 1st; an item anchored on the 1st confirms it');
{
  // Plan day 1 (as data.json's rehearsal-space), firstDue Oct 1, reviewed item
  // anchored on the 1st: the days agree, so the date is confirmed and nothing
  // is withheld. Hand-derived: Nov 1 is the next occurrence, in Oct 23-Nov 5.
  const s = serve(world({ bill: { day: 1 } }), read([readItem(ID, { criteria: { anchorDate: '2026-01-01', startDate: '2026-01-01' },
    expected: ['2026-10-01'] })]));
  ok(s.bill.day === 1 && s.bill.dateConfidence === 'confirmed' && s.bill.confidence === 'estimated',
    'day 1 confirmed, amount still estimated', JSON.stringify([s.bill.day, s.bill.dateConfidence, s.bill.confidence]));
  ok(s.scheduled.length === 1 && s.noWithheldKey, 'scheduled, not withheld', JSON.stringify(s.scheduled));
  ok(s.current.length === 0 && s.next.length === 1 && s.next[0].date === '2026-11-01', '$80 on Nov 1, next period',
    JSON.stringify(s.next.map(b => b.date)));
}

console.log('2b. A linked posted payment on the reviewed day settles THAT occurrence (Codex P1, #1281)');
{
  // The $80 Bills debit linked to the recurring item posts on Oct 20, the
  // reviewed day. Matching runs on the same timed plan Forecast reads, so the
  // Oct 20 occurrence is paid; nothing is still due on the band room.
  const paid = [H.lm({ date: '2026-10-20', amount: 80, account: 'chequing-a', payee: 'Invented e-transfer',
    raw: { recurring_id: Number(ID) } })];
  const w = world({ transactions: paid });
  w.asOf = '2026-10-21';
  const s = serve(w, read([readItem(ID)]));
  const row = s.current[0];
  ok(s.current.length === 1 && row.date === '2026-10-20', 'one Oct 20 occurrence in the current period',
    JSON.stringify(s.current.map(b => [b.date, b.status])));
  ok(row && /paid/i.test(row.status) && !/still due/i.test(row.status), 'it reads paid, not still due', row && row.status);
}

console.log('2c. Grok Bot (c): an early linked payment, inside the existing early-pay window, settles that month');
{
  // rehearsal-space's real rule is covers-early-or-due-on-or-before-posting
  // with no earlyPayLookaheadDays, so the window is the default 7 days: a
  // posting settles the nearest due within 7 calendar days AFTER it.
  // Scheduled day 20: Oct 14 is 6 days early (inside), Oct 12 is 8 days early
  // (outside). With day 20 and firstDue Oct 1 there is no earlier due the
  // Oct 12 posting could cover instead.
  const early = date => {
    const w = world({ transactions: [H.lm({ date, amount: 80, account: 'chequing-a', payee: 'Invented e-transfer',
      raw: { recurring_id: Number(ID) } })] });
    w.asOf = '2026-10-21';
    return serve(w, read([readItem(ID)])).current;
  };
  const inside = early('2026-10-14');
  ok(inside.length === 1 && inside[0].date === '2026-10-20' && /paid/i.test(inside[0].status)
    && !/still due/i.test(inside[0].status), 'paid Oct 14, due Oct 20 (6 days early): that occurrence is paid, not reserved again',
  JSON.stringify(inside.map(b => [b.date, b.status])));
  const outside = early('2026-10-12');
  ok(outside.length === 1 && outside[0].date === '2026-10-20' && /still due/i.test(outside[0].status)
    && outside[0].amount === 80, 'paid Oct 12, due Oct 20 (8 days early, outside the 7-day window): still due, $80',
  JSON.stringify(outside.map(b => [b.date, b.status, b.amount])));
}

console.log('3. Any doubt keeps the plan\'s cadence, day and tags');
planDay(serve(world(), { status: 'unavailable', reason: 'recurring-read-failed' }), 'read unavailable');
planDay(serve(world(), read([readItem(ID, { criteria: { quantity: 2 } })])), 'every two months');
planDay(serve(world(), read([readItem(ID, { criteria: { granularity: 'week' }, expected: ['2026-10-06'] })])), 'weekly');
// An ended item now stops the bill (test-lunchmoney-recurring-cadence.js);
// one whose expected dates fall after its own end is inconsistent.
planDay(serve(world(), read([readItem(ID, { criteria: { endDate: '2026-09-30' } })])), 'ended Sep 30, yet LM expects Oct 20');
planDay(serve(world(), read([readItem(ID, { criteria: { startDate: '2026-11-01', anchorDate: '2026-11-20' } })])), 'not yet started');
planDay(serve(world(), read([readItem(ID, { expected: ['2026-10-21'] })])), 'expected dates disagree with the anchor day');
planDay(serve(world(), read([readItem(ID, { criteria: { plaidAccountId: '9999' } })])), 'paid from an unmapped account');
planDay(serve(world({ rules: [{ eventId: 'band', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID, '7123458'], atlasAccountId: 'chequing-a',
  direction: 'debit' }] }), read([readItem(ID), readItem('7123458', { criteria: { anchorDate: '2026-01-25' }, expected: ['2026-10-25'] })])),
'two items name one bill');
planDay(serve(world({ rules: [{ eventId: 'band', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID], atlasAccountId: 'chequing-a', direction: 'debit' },
  { eventId: 'payroll', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID], atlasAccountId: 'chequing-a', direction: 'credit' }] }),
read([readItem(ID)])), 'one item named by two rules');
planDay(serve(world({ bill: { payingAccount: 'travelvisa' } }), read([readItem(ID)])), 'a bill not paid from household cash');
planDay(serve(world(), read([{ ...readItem(ID), status: 'suggested' }])), 'a suggestion, not reviewed');
planDay(serve(world({ rules: [{ eventId: 'band', payeePattern: 'Invented band room', atlasAccountId: 'chequing-a',
  direction: 'debit' }] }), read([readItem(ID)])), 'no rule names the item');

console.log('4. Short months: an anchor on the 31st matches a Nov 30 expected date');
{
  const sched = O.recurringBillSchedules({ status: 'read', items: [{ recurringId: ID, granularity: 'month', quantity: 1,
    anchorDate: '2026-01-31', startDate: '2026-01-31', endDate: null, currency: 'cad', accountRole: 'household-cash',
    expectedDates: ['2026-10-31', '2026-11-30'], foundTransactionLocalIds: [] }] },
  [{ eventId: 'band', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID] }], { bills: [{ ...BILL, day: 31 }] }, '2026-10-14');
  ok(sched.length === 1 && sched[0].timing.frequency === 'monthly' && sched[0].timing.day === 31, 'day 31 with a clamped Nov 30', JSON.stringify(sched));
}

// Owner decision (Dale, 2026-11-18) retires Grok Bot's cadence guard: the
// reviewed item's cadence leads (test-lunchmoney-recurring-cadence.js). A
// once bill is never rescheduled.
console.log('4b. Cadence leads: a monthly item reschedules a bill Atlas plans on another cadence; never a once bill');
{
  const item = { recurringId: ID, granularity: 'month', quantity: 1, anchorDate: '2026-01-20', startDate: '2026-01-20', endDate: null,
    currency: 'cad', accountRole: 'household-cash', expectedDates: ['2026-10-20'], foundTransactionLocalIds: [] };
  for (const frequency of ['biweekly', 'weekly', 'quarterly', 'yearly']) {
    // The item expects $80 a time, the plan's amount (#1289 blocker 1).
    const sched = O.recurringBillSchedules({ status: 'read', items: [item] }, [{ eventId: 'band', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID] }],
      { bills: [{ ...BILL, frequency }] }, '2026-10-14', { amounts: new Map([[ID, 80]]) });
    ok(sched.length === 1 && JSON.stringify(sched[0].timing) === JSON.stringify({ frequency: 'monthly', day: 20,
      timingBefore: { from: '2026-01-01', frequency, day: 20, dateConfidence: 'estimated' } }),
      'Atlas ' + frequency + ' vs LM monthly: monthly on the 20th from linkedFrom Jan 1 (earlier history keeps ' + frequency + ')', JSON.stringify(sched));
  }
  const once = O.recurringBillSchedules({ status: 'read', items: [item] }, [{ eventId: 'band', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID] }],
    { bills: [{ ...BILL, frequency: 'once', date: '2026-10-20' }] }, '2026-10-14');
  ok(once.length === 0, 'a once bill: no schedule', JSON.stringify(once));
}

console.log('5. The owner-policy guard: only timing fields and dateConfidence, only on a scheduled bill');
{
  const before = { plan: { bills: [BILL, { ...BILL, id: 'other' }] } };
  const moved = patch => ({ plan: { bills: [{ ...BILL, ...patch }, { ...BILL, id: 'other' }] } });
  const throws = (after, set) => { try { Live.assertOwnerPolicyUntouched(before, after, set); return false; } catch (_) { return true; } };
  ok(!throws(moved({ dateConfidence: 'confirmed' }), new Set(['band'])), 'a scheduled bill\'s date tag may become confirmed');
  ok(throws(moved({ dateConfidence: 'confirmed' }), new Set()), 'no schedule: the date tag may not differ');
  ok(!throws(moved({ day: 4, dateConfidence: 'confirmed' }), new Set(['band'])), 'a scheduled bill\'s day may differ (day leads)');
  ok(throws(moved({ dateConfidence: 'verified' }), new Set(['band'])), 'the date tag may become nothing but confirmed');
  ok(throws(moved({ day: 4 }), new Set()), 'no schedule: the day may not differ');
  ok(throws(moved({ amount: 90 }), new Set(['band'])), 'the amount may not differ');
  ok(throws(moved({ confidence: 'confirmed' }), new Set(['band'])), 'the amount tag may not differ');
  ok(throws(moved({ firstDue: '2026-10-20' }), new Set(['band'])), 'firstDue may not differ');
  ok(throws({ plan: { bills: [BILL, { ...BILL, id: 'other', day: 9 }] } }, new Set(['band'])), 'another bill may not differ');
  ok(throws({ plan: { bills: [BILL] } }, new Set(['band'])), 'a bill may not be removed');
}

console.log('6. The schedule records stay internal: not served, not in the assistant packet or the figures snapshot');
{
  // Two applied schedules (#1281 note): the report carries them, and none of
  // the served outputs does.
  const two = world({ rules: [{ eventId: 'band', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID], atlasAccountId: 'chequing-a', direction: 'debit' }] });
  two.bills.push({ ...BILL, id: 'other', label: 'Invented other room', day: 9 });
  two.identityRules.push({ eventId: 'other', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: ['7123459'], atlasAccountId: 'chequing-a', direction: 'debit' });
  H.productionOpening(two);
  const r = Live.fromObservation({ data: H.canonicalOf(two, H.planOf(two)),
    payload: { ...H.rawPayload(two), recurringItems: read([readItem(ID), readItem('7123459', { criteria: { anchorDate: '2026-01-12' }, expected: ['2026-10-12'] })]) },
    accountMap: H.accountMapOf(two), identity: H.identityOf(two) });
  ok((r.report.recurringBillSchedules || []).length === 2, 'positive control: the report holds two applied schedules');
  const leak = blob => /recurringBillSchedules|anchor-day-differs-from-plan|lunchmoney-recurring"/.test(blob);
  ok(!leak(JSON.stringify(r.data)), 'the served document carries neither');
  const Assistant = require('../scripts/assistant-packet.js');
  const Snapshot = require('../scripts/figures-snapshot.js');
  let packet = null, snap = null;
  try { packet = Assistant.buildPacket({ data: r.data, periods: [], questionsMarkdown: '' }); } catch (_) {}
  try { snap = Snapshot.buildFiguresSnapshot(r.data, []); } catch (_) {}
  ok(packet && !leak(JSON.stringify(packet)), 'the assistant packet builds and carries neither');
  ok(snap && !leak(JSON.stringify(snap)), 'the figures snapshot builds and carries neither');
}

console.log('7. Forward walk: an anchor on the 31st leads every future occurrence, clamped in short months');
{
  // Plan day 1; the reviewed item anchors on the 31st. Hand-derived months:
  // Nov has 30 days, Dec 31, Jan 31, Feb 2027 28 (not a leap year).
  const w = world({ bill: { day: 1 } });
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)),
    payload: { ...H.rawPayload(w), recurringItems: read([readItem(ID, { criteria: { anchorDate: '2026-01-31', startDate: '2026-01-31' },
      expected: ['2026-10-31'] })]) }, accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const bill = r.data.plan.bills.find(b => b.id === 'band');
  ok(bill.day === 31 && bill.dateConfidence === 'confirmed', 'served day 31, confirmed', JSON.stringify([bill.day, bill.dateConfidence]));
  const dates = F.expandEvents(r.data.plan, '2026-11-01', '2027-02-28').filter(e => e.id === 'band').map(e => e.date);
  ok(JSON.stringify(dates) === JSON.stringify(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']),
    'Nov 30, Dec 31, Jan 31, Feb 28', JSON.stringify(dates));
  const fallback = F.expandEvents(serveRaw(world({ bill: { day: 1 } })).plan, '2026-11-01', '2027-02-28')
    .filter(e => e.id === 'band').map(e => e.date);
  ok(JSON.stringify(fallback) === JSON.stringify(['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']),
    'control, no read: the plan\'s day 1 every month', JSON.stringify(fallback));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Lunch Money recurring bill-day checks passed.');
