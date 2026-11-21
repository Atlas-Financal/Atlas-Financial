'use strict';
/* Spotify's schedule follows its reviewed Lunch Money recurring item (lead dispatch 2026-11-21; Dale's go-ahead for
 * recurring ids in the identity file on #1495, 7053045943; Grok Bot matched the item to the Nov 18 Spotify payment).
 * The identity rule names the item (lunchMoneyRecurringIds), as rehearsal-space does, so the item's anchor day leads
 * and the date tag is confirmed; amount, firstDue and settlement stay the plan's. Spotify keeps its owner-set
 * schedule-trust-on-due settlement (Owner 2026-09-23); the link changes the schedule only.
 *
 * Invented world (test/acceptance/harness.js): payday anchor 2026-10-09, biweekly, as of 2026-10-14; periods
 * Oct 9-22 and Oct 23-Nov 5. An invented $12 stream bill, monthly, plan day 23, firstDue 2026-09-23, paid from Bills,
 * with a schedule-trust-on-due rule; an invented $30 control bill on the 15th. Hand-derived:
 *   - plan day 23: Oct 23 is the first day of the next period, so the current period holds no stream bill;
 *   - reviewed item anchored on the 12th: Oct 12 is in the current period and on or before 10-14, so schedule-trust
 *     settles it on its due date; Nov 12 is after the next period (ends Nov 5), so the next period holds none;
 *   - the control bill stays on Oct 15 in the current period either way. */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');
const identity = require('../docs/connectivity/transaction-identity.json');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => { checks++; if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); };
const J = JSON.stringify;
const ID = '7123499';
const STREAM = { id: 'stream', label: 'Invented stream', amount: 12, frequency: 'monthly', day: 23, firstDue: '2026-09-23',
  confidence: 'confirmed', payingAccount: 'chequing-a', householdObligation: true };
const CONTROL = { id: 'control', label: 'Invented control', amount: 30, frequency: 'monthly', day: 15, firstDue: '2026-09-15',
  confidence: 'confirmed', payingAccount: 'chequing-a', householdObligation: true };
const rule = ids => ({ eventId: 'stream', settlesWhen: 'schedule-trust-on-due', ...(ids ? { lunchMoneyRecurringIds: ids } : {}) });
const item = { providerId: ID, status: 'reviewed', unavailableFields: [],
  criteria: { startDate: '2026-09-12', endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-09-12',
    currency: 'CAD', plaidAccountId: '9001', manualAccountId: null },
  matches: { expectedOccurrenceDates: ['2026-10-12'], foundTransactions: [] } };
const read = { status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-10-14' }, items: [item] } };

function serve(ids, extraTx) {
  const w = H.baseWorld();
  w.bills = [{ ...STREAM }, { ...CONTROL }];
  w.identityRules = w.identityRules.concat([rule(ids)]);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }), ...(extraTx || [])];
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  const r = Live.fromObservation({ data: canonical, payload: { ...H.rawPayload(w), recurringItems: read },
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const plan = r.data.plan;
  const adv = F.recommend(plan, w.asOf, { currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals, debts: r.data.debts });
  const periods = adv.defaultView.calendarPeriods;
  const rows = (start, id) => (periods.find(p => p.start === start).bills || []).filter(b => b.id === id);
  return { stream: plan.bills.find(b => b.id === 'stream'), control: plan.bills.find(b => b.id === 'control'),
    cur: rows('2026-10-09', 'stream'), next: rows('2026-10-23', 'stream'), ctl: rows('2026-10-09', 'control') };
}

console.log('1. The named item moves the stream bill to its anchor day, confirmed');
const linked = serve([ID]);
ok(linked.stream.day === 12 && linked.stream.dateConfidence === 'confirmed', 'served day 12, date tag confirmed',
  J([linked.stream.day, linked.stream.dateConfidence]));
ok(linked.stream.amount === 12 && linked.stream.firstDue === '2026-09-23' && linked.stream.confidence === 'confirmed',
  'amount, firstDue and amount tag stay the plan\'s');
ok(linked.cur.length === 1 && linked.cur[0].date === '2026-10-12' && linked.next.length === 0,
  '$12 on Oct 12 in the current period; none in the next', J([linked.cur.map(b => b.date), linked.next.map(b => b.date)]));
ok(linked.cur[0] && /^paid$/i.test(linked.cur[0].status), 'schedule-trust still settles it on its due date (Oct 12 ≤ Oct 14)',
  linked.cur[0] && linked.cur[0].status);

{
  // A posted Bills debit Lunch Money links to the item (recurring_id) on the due day: still one $12 occurrence, paid
  // once, and the period's bills hold one stream row (no second settlement from the link).
  const tx = H.lm({ date: '2026-10-12', amount: 12, account: 'chequing-a', payee: 'Invented stream', raw: { recurring_id: Number(ID) } });
  const s = serve([ID], [tx]);
  ok(s.cur.length === 1 && s.cur[0].amount === 12 && /^paid$/i.test(s.cur[0].status) && s.next.length === 0,
    'a linked posted payment on the due day leaves one paid $12 occurrence (not counted twice)',
    J([s.cur.map(b => [b.date, b.amount, b.status]), s.next.length]));
}
console.log('2. Other bills are untouched');
ok(linked.control.day === 15 && !Object.hasOwn(linked.control, 'dateConfidence'),
  'the control bill keeps day 15', J(linked.control));
ok(linked.ctl.length === 1 && linked.ctl[0].date === '2026-10-15', 'control on Oct 15 in the current period', J(linked.ctl.map(b => b.date)));

console.log('3. Without the id, the plan\'s day stands');
const plain = serve(null);
ok(plain.stream.day === 23 && plain.stream.dateConfidence !== 'confirmed', 'plan day 23, not confirmed by the read',
  J([plain.stream.day, plain.stream.dateConfidence]));
ok(plain.cur.length === 0 && plain.next.length === 1 && plain.next[0].date === '2026-10-23',
  'Oct 23 opens the next period; none in the current one', J([plain.cur.map(b => b.date), plain.next.map(b => b.date)]));
ok(J(plain.control) === J(linked.control), 'the control bill is identical with and without the link');

console.log('4. The committed rule');
const spotify = identity.rules.filter(r => r.eventId === 'spotify');
ok(spotify.length === 1 && J(spotify[0].lunchMoneyRecurringIds) === J(['3709355'])
  && spotify[0].settlesWhen === 'schedule-trust-on-due', 'spotify names item 3709355 and keeps schedule-trust-on-due',
  J(spotify.map(r => [r.lunchMoneyRecurringIds, r.settlesWhen])));
ok(identity.rules.filter(r => (r.lunchMoneyRecurringIds || []).includes('3709355')).length === 1,
  'no other rule names item 3709355');
console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
