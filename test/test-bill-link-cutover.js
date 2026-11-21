'use strict';
/* #1508 live check (lead, 2026-11-21): a linked bill whose Lunch Money item sits on another day must not re-date its
 * recorded history. The item's timing applies from its start month; earlier occurrences keep the bill's own day
 * (timingBefore), so a payment that settled the old day stays settled. Invented bills, items and payments only. */
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
const BILL = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 15, firstDue: '2026-09-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
const item = (extra = {}) => ({ providerId: ID, status: 'reviewed', unavailableFields: [],
  criteria: { startDate: '2026-10-01', endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-10-16',
    currency: 'CAD', plaidAccountId: '9001', manualAccountId: null, ...extra },
  matches: { expectedOccurrenceDates: [], foundTransactions: [] } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-10-14' }, items } });
const RULE = { eventId: 'band', lunchMoneyRecurringIds: [ID], atlasAccountId: 'chequing-a', direction: 'debit', payeePatterns: ['Invented band'],
  requiredCurrency: 'cad', requiredPostingEvidence: 'posted', postingDateRule: 'same-day-or-weekend-next-business-day' };
const pay = date => H.lm({ date, amount: 80, account: 'chequing-a', payee: 'Invented band' });

function serve(items, rules) {
  const w = H.baseWorld();
  w.bills = [{ ...BILL }];
  w.identityRules = w.identityRules.concat(rules);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    pay('2026-09-15')];
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  const r = Live.fromObservation({ data: canonical, payload: { ...H.rawPayload(w), recurringItems: read(items) },
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const plan = r.data.plan;
  const adv = F.recommend(plan, w.asOf, { currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals, debts: r.data.debts });
  const rows = [];
  for (const p of adv.defaultView.calendarPeriods || []) for (const b of p.bills || []) if (b.id === 'band') rows.push({ ...b, period: p.start });
  return { bill: plan.bills.find(b => b.id === 'band'), rows, schedules: r.report.recurringBillSchedules || [] };
}
const summary = rows => rows.filter(b => b.status !== 'carried').map(b => b.date + ':' + (b.status || '')).sort();

console.log('1. Invented 15th bill paid Sep 15, item on the 16th from Oct: September stays settled, nothing is carried');
const linked = serve([item()], [RULE]);
const plain = serve([item()], [{ ...RULE, lunchMoneyRecurringIds: undefined }]);
ok(J(linked.bill.timingBefore) === J({ from: '2026-10-01', frequency: 'monthly', day: 15 }), 'served cutover keeps day 15 before Oct 1', J(linked.bill.timingBefore));
ok(linked.bill.day === 16, 'served day is the item\'s 16th', String(linked.bill.day));
const past = rows => rows.filter(b => b.date < '2026-10-01').map(b => [b.date, b.status, b.settlement]);
ok(!linked.rows.some(b => b.date === '2026-09-16'), 'no Sep 16 occurrence', J(linked.rows.map(b => b.date)));
ok(J(past(linked.rows)) === J(past(plain.rows)), 'every September row reads as unlinked (settled, not carried)', J([past(linked.rows), past(plain.rows)]));
ok(!linked.rows.some(b => b.date < '2026-10-01' && /unverified|still due|overdue/i.test((b.status || '') + (b.settlement || ''))),
  'no September occurrence is carried as owed', J(past(linked.rows)));
ok(linked.rows.some(b => b.date === '2026-10-16'), 'Oct 16 is the current occurrence', J(linked.rows.map(b => b.date)));

console.log('2. From the cutover the item\'s day applies');
const dates = F.occurrences(linked.bill, '2026-09-01', '2027-01-31');
ok(J(dates) === J(['2026-09-15', '2026-10-16', '2026-11-16', '2026-12-16', '2027-01-16']), 'Sep 15, then the 16th', J(dates));

console.log('3. A same-day item needs no cutover');
{
  const s = serve([item({ anchorDate: '2026-10-15' })], [RULE]);
  ok(s.bill.day === 15 && !s.bill.timingBefore, 'day 15 item: no timingBefore', J(s.bill));
}

console.log('4. Every committed link: no occurrence before its item start is re-dated (invented anchors, every day 1-28 and the 29th-31st)');
{
  const ids = {};
  for (const r of identity.rules) for (const x of r.lunchMoneyRecurringIds || []) ids[x] = r.eventId;
  const bills = data.plan.bills.filter(b => Object.values(ids).includes(b.id));
  let moved = 0;
  for (const day of [1, 2, 5, 13, 14, 16, 17, 18, 28, 29, 30, 31]) {
    const items = Object.entries(ids).filter(([, id]) => bills.some(b => b.id === id)).map(([rid, id]) => {
      const b = bills.find(x => x.id === id);
      const g = b.frequency === 'quarterly' ? { granularity: 'month', quantity: 3 } : b.frequency === 'biweekly' ? { granularity: 'week', quantity: 2 }
        : b.frequency === 'annual' ? { granularity: 'year', quantity: 1 } : { granularity: 'month', quantity: 1 };
      const anchor = b.frequency === 'biweekly' ? '2026-11-0' + (day % 7 + 2) : '2026-11-' + String(Math.min(day, 30)).padStart(2, '0');
      return { recurringId: rid, startDate: '2026-11-01', endDate: null, currency: 'cad', accountRole: 'household-cash', expectedDates: [],
        foundTransactionLocalIds: [], ...g, anchorDate: anchor };
    });
    const got = O.recurringBillSchedules({ status: 'read', items }, identity.rules, data.plan, '2026-11-21', {});
    for (const s of got.filter(x => x.billId)) {
      const b = bills.find(x => x.id === s.billId);
      const served = O.applyRecurringSchedule(b, s);
      const from = served.timingBefore ? served.timingBefore.from : '2026-11-01';
      const was = F.occurrences(b, '2025-01-01', F.addDays(from, -1));
      const now = F.occurrences(served, '2025-01-01', F.addDays(from, -1));
      if (served.day !== b.day || served.anchor !== b.anchor) moved++;
      ok(J(was) === J(now) && from >= '2026-11-01', `${b.id}, item day ${day}: history before ${from} unchanged`, J({ was: was.slice(-2), now: now.slice(-2) }));
    }
  }
  ok(moved > 0, 'the loop exercises moved days', String(moved));
}

console.log('5. triangle-td3 and mbna-auto30 keep their dated history (obligation cutover path, unchanged)');
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
    const was = F.occurrences(row, '2025-01-01', '2026-11-21');
    const now = F.occurrences(served, '2025-01-01', '2026-11-21');
    ok(J(was) === J(now), `${id}: no occurrence on or before the observation date moves`, J([was.slice(-2), now.slice(-2)]));
  }
}

console.log('6. The committed plan with the live days (bcaa, icbc, resp on the 16th from Nov 1): every event before Nov 1, the Aug 15 outstanding rows included, is exactly the unlinked plan\'s');
{
  const ids = {};
  for (const r of identity.rules) for (const x of r.lunchMoneyRecurringIds || []) ids[r.eventId] = x;
  const items = ['bcaa', 'icbc', 'resp'].map(id => ({ recurringId: ids[id], startDate: '2026-11-01', endDate: null, currency: 'cad',
    accountRole: 'household-cash', expectedDates: [], foundTransactionLocalIds: [], granularity: 'month', quantity: 1, anchorDate: '2026-11-16' }));
  const got = O.recurringBillSchedules({ status: 'read', items }, identity.rules, data.plan, '2026-11-21', {});
  ok(got.filter(x => x.billId).length === 3, 'all three take a schedule', J(got.map(x => x.billId)));
  const served = { ...data.plan, bills: data.plan.bills.map(b => { const s = got.find(x => x.billId === b.id); return s ? O.applyRecurringSchedule(b, s) : b; }) };
  const key = plan => F.expandEvents({ ...plan, opening: { ...plan.opening, asOf: '2026-08-01', representedEvents: [] } }, '2026-08-01', '2026-10-31', {})
    .filter(e => /^(bcaa|icbc|resp)/.test(e.id)).map(e => e.id + '@' + e.date).sort();
  ok(J(key(served)) === J(key(data.plan)), 'Aug to Oct events identical to the unlinked plan', J([key(served), key(data.plan)]));
  ok(key(served).filter(k => /aug15-outstanding@2026-08-16/.test(k)).length === 3, 'the three Aug 15 outstanding rows keep their own date (Aug 16)', J(key(served)));
  const nov = F.occurrences(served.bills.find(b => b.id === 'bcaa'), '2026-11-01', '2026-12-31');
  ok(J(nov) === J(['2026-11-16', '2026-12-16']), 'from Nov the 16th applies', J(nov));
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
