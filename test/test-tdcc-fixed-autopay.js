'use strict';
/* Owner fact 2026-11-21 (Dale, consolidated list relayed in the lead session; lead dispatch): the TD credit card
 * (Emerald, debt tdcc) is paid by a fixed automatic payment on the 17th, Lunch Money recurring item 3722415.
 *
 * `tdcc` ends at its 2026-11-17 occurrence (lastDue) and the successor `tdcc-auto17` plans the fixed amount from
 * 2026-12-17, the dated-row pattern of triangle-td3 (#1498/#1508). Earlier occurrences are unchanged and the trust
 * tag is not promoted. The recurring link moves to the successor (lead's call, 2026-11-21).
 *
 * Pinned from the household's own dated rows in data.json, on the opening the live page uses (the committed opening
 * as priorAsOf, advanced to 2026-11-21). Expected amounts are read from the committed rows, never written here, and
 * no household figure is printed. A statement minimum on record after the fixed payment starts that is above the
 * fixed amount is reported as a WARNING (the autopay would underpay), not a failure.
 *   node test/test-tdcc-fixed-autopay.js
 */
const F = require('../public/forecast.js');
const Snap = require('../scripts/figures-snapshot.js');
const identity = require('../docs/connectivity/transaction-identity.json');

let checks = 0, failures = 0;
const ok = (cond, label, detail) => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? ' — ' + detail : ''}`);
};
const J = JSON.stringify;
const cents = n => Math.round(Math.abs(n) * 100);

const AS_OF = '2026-11-21';
const { data, periods } = Snap.loadCanonicalInputs();
const obligation = (plan, id) => plan.obligations.find(o => o.id === id);
function livePlan(edit) {
  const plan = JSON.parse(JSON.stringify(data.plan));
  plan.opening = { ...plan.opening, priorAsOf: plan.opening.asOf, asOf: AS_OF };
  if (edit) edit(plan);
  return plan;
}
const tdRows = plan => F.recommend(plan, AS_OF, Snap.pageOptions(data, periods)).payPeriodViews
  .flatMap(v => (v.bills || []).filter(r => /^tdcc/.test(r.id)).map(r => ({ ...r, periodStart: v.start })));
const expand = plan => F.expandEvents({ ...plan, opening: { ...plan.opening, representedEvents: [] } }, '2026-09-01', '2027-06-30', {})
  .filter(e => e.kind === 'obligation' && /^tdcc/.test(e.id));

console.log('1. The committed rows');
const tdcc = obligation(data.plan, 'tdcc'), auto = obligation(data.plan, 'tdcc-auto17');
// Future minimums carry the row's latest published minimum (Dale, #821 7173859561, 2026-11-25), which supersedes
// tdcc's own estimate for occurrences after its latest statement; the trust tag stays estimated.
const tdccCarried = (tdcc.statementOccurrences || []).reduce((best, o) => (!best || o.scheduledDate > best.scheduledDate ? o : best), null);
ok(tdcc && tdcc.lastDue === '2026-11-17' && tdcc.day === 17 && tdcc.firstDue === '2026-09-17',
  'tdcc ends at its 2026-11-17 occurrence (lastDue)');
ok(auto && auto.debtId === 'tdcc' && auto.effect === 'payment' && auto.frequency === 'monthly' && auto.day === 17
  && auto.firstDue === '2026-12-17' && !auto.lastDue && auto.payingAccount === tdcc.payingAccount,
  'tdcc-auto17: the same card, monthly on the 17th from 2026-12-17, paid from the same account');
ok(auto && auto.amount > 0 && !auto.statementOccurrences && !auto.sentPayments && !auto.fixedInterestMinimum,
  'tdcc-auto17: a plain dated amount (no statement, payment or interest-minimum record)');
ok(auto && auto.confidence === tdcc.confidence && tdcc.confidence === 'estimated',
  'the trust tag is unchanged (estimated; no promotion)');
const rule = id => identity.rules.filter(r => r.eventId === id);
const strip = r => { const c = { ...r }; delete c.eventId; delete c.lunchMoneyRecurringIds; return c; };
ok(rule('tdcc-auto17').length === 1 && rule('tdcc').length === 1 && J(strip(rule('tdcc-auto17')[0])) === J(strip(rule('tdcc')[0])),
  'tdcc-auto17 alias rule is an exact copy of tdcc\'s');
ok(J(rule('tdcc-auto17')[0].lunchMoneyRecurringIds) === J(['3722415']) && !rule('tdcc')[0].lunchMoneyRecurringIds,
  'the recurring link 3722415 is on tdcc-auto17 only');

console.log('2. The schedule: one TD payment a month, the dated amount from Dec 17');
const events = expand(data.plan);
const dates = id => events.filter(e => e.id === id).map(e => e.date);
ok(J(dates('tdcc')) === J(['2026-09-17', '2026-10-17', '2026-11-17']), 'tdcc: Sep 17 to Nov 17 only', J(dates('tdcc')));
ok(J(dates('tdcc-auto17')) === J(['2026-12-17', '2027-01-17', '2027-02-17', '2027-03-17', '2027-04-17', '2027-05-17', '2027-06-17']),
  'tdcc-auto17: Dec 17 onward on the 17th', J(dates('tdcc-auto17')));
const perMonth = {}; for (const e of events) perMonth[e.date.slice(0, 7)] = (perMonth[e.date.slice(0, 7)] || 0) + 1;
ok(Object.values(perMonth).every(n => n === 1), 'one TD payment per month', J(perMonth));
ok(events.filter(e => e.id === 'tdcc-auto17').every(e => cents(e.amount) === cents(auto.amount)),
  'each payment from Dec 17 is the dated row\'s amount');
ok(tdccCarried && tdccCarried.scheduledDate < '2026-11-17' && events.some(e => e.id === 'tdcc' && e.date === '2026-11-17')
  && events.filter(e => e.id === 'tdcc' && e.date === '2026-11-17').every(e => cents(e.amount) === cents(tdccCarried.minimum)),
  'the Nov 17 occurrence carries tdcc\'s latest statement minimum (#821 7173859561)');

console.log('3. The live page (committed opening as priorAsOf, advanced to 2026-11-21)');
const live = tdRows(livePlan());
const dec17 = live.filter(r => r.date === '2026-12-17');
ok(dec17.length === 1 && dec17[0].id === 'tdcc-auto17' && dec17[0].periodStart === '2026-12-04',
  'Dec 17: one TD row, tdcc-auto17, in the Dec 4–17 period', J(dec17.map(r => [r.id, r.periodStart])));
ok(dec17[0] && cents(dec17[0].amount) === cents(auto.amount) && dec17[0].confidence === auto.confidence,
  'Dec 17 is planned at the dated row\'s amount, with the row\'s own tag');
const oct17 = live.find(r => r.id === 'tdcc' && r.date === '2026-10-17');
const oct17Statement = (tdcc.statementOccurrences || []).find(o => o.scheduledDate === '2026-10-17');
ok(oct17 && oct17Statement && cents(oct17.planned != null ? oct17.planned : oct17.amount) === cents(oct17Statement.minimum)
  && oct17.status === 'PAID' && oct17.confidence === 'confirmed',
  'an earlier occurrence (Oct 17) is unchanged: its statement minimum, confirmed, paid');
const nov17 = live.find(r => r.id === 'tdcc' && r.date === '2026-11-17');
ok(nov17 && tdccCarried && cents(nov17.amount) === cents(tdccCarried.minimum) && nov17.confidence === 'estimated',
  'Nov 17 carries tdcc\'s latest statement minimum, still estimated (#821 7173859561)');
ok(live.filter(r => r.id === 'tdcc').every(r => r.date <= '2026-11-17'), 'no tdcc occurrence after Nov 17');

console.log('4. Removal checks');
const noLast = expand(livePlan(p => { delete obligation(p, 'tdcc').lastDue; }));
const months = {}; for (const e of noLast) months[e.date.slice(0, 7)] = (months[e.date.slice(0, 7)] || 0) + 1;
ok(months['2026-12'] === 2, 'without lastDue, Dec has two TD payments (the guard bites)', J(months));
const noAuto = tdRows(livePlan(p => { p.obligations = p.obligations.filter(o => o.id !== 'tdcc-auto17'); }));
ok(!noAuto.some(r => r.date === '2026-12-17'), 'without the successor row, nothing is planned on Dec 17');

console.log('5. One payment settles one TD occurrence (invented ledger, through the live path)');
{
  // Invented: categorized TD payments from Bills, close day 23, the two rows shaped as in data.json (2035 dates,
  // invented amounts). tdcc and tdcc-auto17 share one alias rule shape; a posting must settle one occurrence only.
  const Live = require('../scripts/live-plan');
  const Category = require('../scripts/card-minimum-category');
  const source = require('./fixtures/card-backfill-data');
  const settledBy = (now, posted) => {
    const x = source('tdcc', 'tdcc');
    const name = Object.keys(Category.CATEGORIES).find(k => Category.CATEGORIES[k] === 'tdcc');
    x.data.meta.asOf = x.data.plan.opening.asOf = '2035-11-01';
    x.data.plan.opening.representedEvents = [];
    x.data.plan.income[0].anchor = '2035-11-01'; x.data.plan.income[0].amount = 0;
    x.data.plan.budget = { categories: [] };
    x.data.debts[0].statementCloseDay = 23;
    x.data.plan.obligations = [
      { id: 'tdcc', debtId: 'tdcc', effect: 'payment', frequency: 'monthly', day: 17, firstDue: '2035-10-17', lastDue: '2035-11-17',
        payingAccount: 'chequing-a', amount: 31.07, confidence: 'estimated' },
      { id: 'tdcc-auto17', debtId: 'tdcc', effect: 'payment', frequency: 'monthly', day: 17, firstDue: '2035-12-17',
        payingAccount: 'chequing-a', amount: 37.5, confidence: 'estimated' }];
    x.data.plan.startingCash.breakdown[0].value = 1000; x.data.debts[0].balance = 800;
    x.payload.accounts.forEach(a => { a.updated_at = now + 'T17:00:00Z'; a.balance_last_update = now + 'T17:00:00Z'; });
    x.payload.fetchedAt = now + 'T18:00:00Z';
    x.payload.transactionWindow = { startDate: '2035-11-01', endDate: now, complete: true, hasMore: false, truncated: false };
    x.payload.categories = [{ id: 9001, name, is_income: false, is_group: false, exclude_from_totals: true, exclude_from_budget: true }];
    x.payload.transactions = posted.map((d, i) => ({ id: 98001 + i, account_id: 3001, date: d, amount: 37.5, currency: 'cad',
      payee: 'TFR-TO C/C', category_id: 9001, is_pending: false, status: 'reviewed' }));
    x.asOf = now;
    const live = Live.fromObservation(x);
    return { applied: !!(live.data.liveOverlay && live.data.liveOverlay.applied),
      settled: ((live.data.plan.cardMinimumCategoryEvidence || {}).payments || []).map(p => p.id + '@' + p.scheduledDate) };
  };
  const one = settledBy('2035-12-20', ['2035-11-17']);
  ok(one.applied && J(one.settled) === J(['tdcc@2035-11-17']),
    'a Nov 17 payment settles tdcc@Nov 17 only; tdcc-auto17@Dec 17 is not settled by it', J(one));
  const two = settledBy('2035-12-20', ['2035-11-17', '2035-12-17']);
  ok(two.applied && J(two.settled) === J(['tdcc@2035-11-17', 'tdcc-auto17@2035-12-17']),
    'two payments settle the two occurrences, one each', J(two));
  const none = settledBy('2035-12-20', []);
  ok(none.applied && none.settled.length === 0, 'with no payment, nothing is settled', J(none));
}

console.log('6. Statement minimum against the fixed amount (warning only)');
const minimums = [tdcc, auto].flatMap(r => (r.statementOccurrences || []).map(o => ({ due: o.dueDate || o.scheduledDate, minimum: o.minimum })));
const over = minimums.filter(m => Number.isFinite(m.minimum) && cents(m.minimum) > cents(auto.amount) && m.due >= '2026-10-17');
if (over.length) console.log(`  WARN  ${over.length} statement minimum(s) on record from ${over.map(m => m.due).join(', ')} exceed the fixed autopay (it would underpay); tell the owner`);
else console.log('  INFO  no statement minimum on record from 2026-10-17 exceeds the fixed autopay');

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
