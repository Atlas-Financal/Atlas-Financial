'use strict';
/* Lead dispatch 2026-11-18 (after #1325): one path for late pay. Since #1325
 * the matcher settles a plain payroll credit one business day late itself, so
 * #1290's late-posting hold-off in futureIncomeUncertainty never sees it (a
 * settled credit is `used`). The hold-off remains for exactly the cases the
 * matcher declines, where it keeps the plan live without settling anything:
 *   (a) another credit of the same identity competes for the payday;
 *   (b) the credit also fits another income's occurrence;
 *   (c) the payroll rule is not the plain shape (a posting-date rule or a
 *       settlement mode), which the matcher's late cover does not read.
 * Removing the hold-off blanks the plan in each (checked by mutation), so it is
 * narrowed and named here, not deleted. Naming Dale's pay item (BACKLOG) is the
 * closure step, when Lunch Money's own pairing decides these.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> served data -> Forecast.recommend.
 *
 * Invented world: salary 1400 every second Friday from Oct 9 (Oct 9, Oct 23,
 * Nov 6), identified by its payee, into Bills; plan date Tue Oct 27. Hand-
 * derived: on time or settled late, the Oct 23 payday reads received and the
 * period's income is calculated; held off, it reads relied upon (To confirm),
 * the plan stays live, nothing settles from the late credit, and income stays
 * estimated (never more certain than before #1325).
 *
 *   node test/test-payroll-late-hold-off-remaining.js
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

let id = 884000;
function serve(dates, { amounts = {}, rule = {}, extraIncome = [], extraRules = [] } = {}) {
  const w = H.baseWorld('2026-10-27');
  w.windowStart = '2026-10-01';
  w.income = w.income.concat(extraIncome);
  w.identityRules = w.identityRules.map(r => (r.eventId === 'payroll' ? { ...r, ...rule } : r)).concat(extraRules);
  w.transactions = ['2026-10-09', ...dates].map(date => H.lm({ id: ++id, date, amount: -(amounts[date] || 1400),
    category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }));
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (r.error) throw r.error;
  const overlay = r.data.liveOverlay;
  const packet = overlay.currentPeriodActuals;
  const out = { live: overlay.operatingPlan === 'live',
    settled: (packet.representedActuals || []).filter(x => x.id === 'payroll').map(x => x.date + '@' + x.postedOn) };
  if (!out.live) return out;
  const adv = F.recommend(r.data.plan, '2026-10-27', { currentPeriodActuals: packet, debts: r.data.debts });
  const current = adv.defaultView.calendarPeriods.find(p => p.start <= '2026-10-27' && p.end >= '2026-10-27');
  const view = adv.payPeriodViews.find(v => v.start === '2026-10-23');
  out.pay = (view.income.find(i => i.id === 'payroll') || {}).status;
  out.incomeTrust = current.incomeTrust;
  return out;
}
const heldOff = s => s.live && same(s.settled, ['2026-10-09@2026-10-09']) && s.pay === 'relied-upon'
  && s.incomeTrust === 'estimated';

console.log('1. One path: a late credit the matcher settles never needs the hold-off');
{
  const onTime = serve(['2026-10-23']);
  ok(onTime.live && onTime.pay === 'received' && onTime.incomeTrust === 'calculated', 'control: on time, received, calculated',
    JSON.stringify(onTime));
  const late = serve(['2026-10-24']);
  ok(late.live && same(late.settled, ['2026-10-09@2026-10-09', '2026-10-23@2026-10-24']) && late.pay === 'received'
    && late.incomeTrust === onTime.incomeTrust,
  'a plain late Saturday credit is settled by the matcher (#1325), read exactly as on time', JSON.stringify(late));
}

console.log('2. What the hold-off still covers: live, To confirm, estimated, nothing settled');
{
  ok(heldOff(serve(['2026-10-22', '2026-10-24'])),
    '(a) an early Thursday 1400 and a late Saturday 1400 compete: the plan stays live and neither settles Oct 23');
  ok(heldOff(serve(['2026-10-22', '2026-10-24'], { amounts: { '2026-10-22': 500 } })),
    '(a) an early Thursday 500 beside a late Saturday 1400: the same');
  const bonus = serve(['2026-10-24'], {
    extraIncome: [{ id: 'bonus', label: 'Invented bonus', frequency: 'monthly', day: 24, firstDue: '2026-10-24', amount: 1400, confidence: 'confirmed' }],
    extraRules: [{ eventId: 'bonus', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' }] });
  ok(heldOff(bonus), '(b) a late credit that also fits a same-payee bonus on its own date: live, both unresolved', JSON.stringify(bonus));
  ok(heldOff(serve(['2026-10-26'], { rule: { postingDateRule: 'same-day-or-weekend-next-business-day' } })),
    '(c) a payroll rule with a posting-date rule, pay landing Monday: live, not settled');
  ok(heldOff(serve(['2026-10-24'], { rule: { settlesWhen: 'exact-scheduled-amount' } })),
    '(c) a payroll rule with an exact-amount settlement mode: live, not settled');
  ok(heldOff(serve(['2026-10-24'], { rule: { settlesWhen: 'amount-at-least' } })),
    '(c) a payroll rule with an at-least settlement mode: live, not settled');
}

console.log('3. Outside the hold-off: still holds, as on main');
{
  ok(!serve(['2026-10-22', '2026-10-24'], { amounts: { '2026-10-24': 300 } }).live,
    'a late credit that is not the exact pay, beside an early one, still holds the plan');
  ok(!serve(['2026-10-27'], { rule: { settlesWhen: 'exact-scheduled-amount' } }).live,
    'two business days late under a non-plain rule still holds the plan');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll payroll late hold-off checks passed.');
