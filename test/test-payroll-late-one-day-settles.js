'use strict';
/* Lead dispatch 2026-11-18 (the #1313 answer key's known gap): a payroll
 * credit that uniquely matches its pay rule but posts one business day after
 * payday settles that payday once, at its actual amount. It is not Other
 * income, and the period's received income is not partial. Two candidates, or
 * a credit that could fit two paydays, stay To confirm.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> served data -> Forecast.recommend.
 *
 * Invented world: an invented salary of 1400 every second Friday from Oct 9
 * (Oct 9, Oct 23, Nov 6), identified by its payee, paid into Bills; plan date
 * Tue Oct 27. Hand-derived for the Oct 23 pay period: on time, income received
 * 1400 and complete; one business day late (Sat Oct 24 or Mon Oct 26) must
 * read the same; two business days late (Tue Oct 27) is outside the window.
 *
 *   node test/test-payroll-late-one-day-settles.js
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function serve(dates, { amounts = {}, extraIncome = [], extraRules = [] } = {}) {
  let id = 883000;
  const pay = (date, amount = 1400) => H.lm({ id: ++id, date, amount: -amount, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' });
  const w = H.baseWorld('2026-10-27');
  w.windowStart = '2026-10-01';
  w.income = w.income.concat(extraIncome);
  w.identityRules = w.identityRules.concat(extraRules);
  w.transactions = [pay('2026-10-09'), ...dates.map(d => pay(d, amounts[d]))];
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (r.error) throw r.error;
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, '2026-10-27', { currentPeriodActuals: packet, debts: r.data.debts });
  const view = adv.payPeriodViews.find(v => v.start === '2026-10-23');
  const item = id => view.income.find(i => i.id === id) || {};
  const tags = {};
  (function walk(o, p) {
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
      if (/(trust|Trust|confidence|Confidence|claim|Claim|completeness|status)$/.test(k) && typeof v === 'string') tags[p + k] = v;
      if (typeof v === 'object') walk(v, p + k + '.');
    }
  })(adv, '');
  return { applied: r.data.liveOverlay.applied, view, pay: item('payroll'), item,
    income: view.budgetProgress.income.actual.amount, completeness: view.budgetProgress.income.actual.completeness,
    other: view.income.filter(i => i.id.startsWith('other-income:')),
    settled: (packet.representedActuals || []).filter(x => x.id === 'payroll').map(x => x.date + '@' + x.postedOn), tags };
}
const received = (s, amount) => s.pay.status === 'received' && s.pay.actual === -amount && s.income === amount
  && s.completeness === 'complete' && s.other.length === 0;

console.log('1. On time (control): received once, complete');
const onTime = serve(['2026-10-23']);
ok(received(onTime, 1400) && same(onTime.settled, ['2026-10-09@2026-10-09', '2026-10-23@2026-10-23']), 'Oct 23 pay received on Oct 23',
  JSON.stringify([onTime.pay.status, onTime.income, onTime.completeness, onTime.settled]));

console.log('2. One business day late settles the payday once, at its actual amount');
for (const [label, date] of [['Saturday Oct 24', '2026-10-24'], ['Monday Oct 26', '2026-10-26']]) {
  const s = serve([date]);
  ok(received(s, 1400), label + ': received 1400, complete, not Other income',
    JSON.stringify([s.pay.status, s.pay.actual, s.income, s.completeness, s.other.length]));
  ok(same(s.settled, ['2026-10-09@2026-10-09', '2026-10-23@' + date]), label + ': settles the Oct 23 payday once, posted ' + date,
    JSON.stringify(s.settled));
  ok(same(s.tags, onTime.tags), label + ': every trust, confidence, claim and status tag equals the on-time case');
}
{
  // Lead 2026-11-18: a late pay settles at what actually arrived, as on time.
  for (const amount of [1350, 2800]) {
    const s = serve(['2026-10-24'], { amounts: { '2026-10-24': amount } });
    const t = serve(['2026-10-23'], { amounts: { '2026-10-23': amount } });
    ok(received(s, amount) && same(s.settled, ['2026-10-09@2026-10-09', '2026-10-23@2026-10-24']) && s.income === t.income,
      `a late credit of ${amount} settles the payday once at its actual ${amount}, as on time`, JSON.stringify([s.pay.actual, s.income, t.income, s.settled]));
  }
}

console.log('3. Outside the window, or not unique: never settled');
{
  const tue = serve(['2026-10-27']);
  ok(tue.pay.status !== 'received' && !tue.settled.some(x => x.startsWith('2026-10-23')),
    'two business days late (Tue Oct 27): not settled', JSON.stringify([tue.pay.status, tue.settled]));
  // The late path never adds a second candidate: with an on-time credit
  // present, the late one gets no late cover and main's same-day match stands.
  const both = serve(['2026-10-23', '2026-10-24']);
  ok(same(both.settled, ['2026-10-09@2026-10-09', '2026-10-23@2026-10-23']),
    'an on-time and a late credit for one payday: the late one is never matched; the on-time match is as on main',
    JSON.stringify([both.pay.status, both.settled]));
  const twoLate = serve(['2026-10-24', '2026-10-26']);
  ok(!twoLate.settled.some(x => x.startsWith('2026-10-23')) && twoLate.pay.status !== 'received',
    'two late credits for one payday: neither settles', JSON.stringify([twoLate.pay.status, twoLate.settled]));
  // A credit that fits both the late payday and another income's same-day
  // occurrence (an invented monthly bonus on the 24th, same employer).
  const bonus = serve(['2026-10-24'], {
    extraIncome: [{ id: 'bonus', label: 'Invented bonus', frequency: 'monthly', day: 24, firstDue: '2026-10-24', amount: 1400, confidence: 'confirmed' }],
    extraRules: [{ eventId: 'bonus', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' }] });
  ok(bonus.pay.status !== 'received' && bonus.item('bonus').status === 'unresolved'
    && bonus.other.length === 1 && bonus.other[0].status === 'unresolved',
  'a credit that could fit two paydays settles neither: both read unresolved (To confirm)',
  JSON.stringify([bonus.pay.status, bonus.item('bonus').status, bonus.other.map(o => o.status)]));
}

console.log('3b. Schedule edges (invented one-off extra payroll occurrences)');
{
  const once = date => ({ id: 'payroll', label: 'Invented extra pay', frequency: 'once', date, amount: 1400, confidence: 'confirmed' });
  const sameDay = serve(['2026-10-26'], { extraIncome: [once('2026-10-26')] });
  ok(same(sameDay.settled, ['2026-10-09@2026-10-09', '2026-10-26@2026-10-26']),
    'a credit on a payday of its own settles only that payday, never also the one before', JSON.stringify(sameDay.settled));
  const dup = serve(['2026-10-24'], { extraIncome: [once('2026-10-23')] });
  ok(!dup.settled.some(x => x.startsWith('2026-10-23')),
    'two payroll occurrences on the late payday: the late credit settles neither', JSON.stringify(dup.settled));
  const nearer = serve(['2026-10-26'], { extraIncome: [once('2026-10-27')] });
  ok(!nearer.settled.some(x => x.startsWith('2026-10-23')) && nearer.pay.status !== 'received',
    'a Monday credit nearer the next payday (Tue) than the late one (Fri) is not a late posting',
    JSON.stringify([nearer.pay.status, nearer.settled]));
}

console.log('4. No payment: unchanged');
{
  const none = serve([]);
  ok(none.pay.status === 'relied-upon' && none.completeness === 'partial' && none.other.length === 0,
    'no Oct 23 credit: relied upon, partial', JSON.stringify([none.pay.status, none.completeness]));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll payroll one-business-day-late checks passed.');
