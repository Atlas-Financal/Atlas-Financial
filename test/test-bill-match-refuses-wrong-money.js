'use strict';
/* Finish-line audit finding 2 (#821 6788704527): bill matching never takes
 * money that is not the bill's, and never counts a bill payment twice.
 *
 * (a) A same-day identity match or a near-due hold refuses a debit whose
 *     amount is inconsistent with the bill. For a default rule, that means
 *     more than 1.5 times the occurrence's scheduled amount. A 400.00
 *     Groceries purchase at a shop whose name contains a 15.00 bill's payee
 *     stays Groceries spending.
 * (b) Two or more same-day identity debits for one occurrence (left
 *     ambiguous by the matcher) are named to Forecast as that bill's
 *     to-confirm candidates. The bill stays To confirm and reserved, instead
 *     of every debit landing in Other as well.
 * (c) Each debit is counted once. The debits held for one occurrence never
 *     total more than its reserve. Largest first, a debit is held only while
 *     the running total stays within the scheduled amount; the rest stay
 *     ordinary spending.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js
 * fromObservation (harness) -> packet -> Forecast.recommend's current-period
 * bill rows, household budget and balance after deductions. Every expected
 * value is hand-written. Invented numbers only. Invented pay: 1,400 on
 * Oct 9; household budget 400 (Groceries 300, Eating out 100).
 *
 * `node test/test-bill-match-refuses-wrong-money.js`
 */
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const payroll = () => H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
  payee: 'Invented employer' });
const debit = (date, amount, payee, category = 'Utilities', extra = {}) =>
  H.lm({ date, amount, category, account: 'chequing-a', payee, ...extra });
const STREAM = { id: 'stream', label: 'Invented stream', amount: 15, frequency: 'monthly', day: 12,
  confidence: 'confirmed', payee: 'Invented mart' };
const BIG = { id: 'big', label: 'Invented big bill', amount: 400, frequency: 'monthly', day: 12,
  confidence: 'confirmed', payee: 'Invented biller' };

function run(bills, txs, asOf) {
  const w = H.baseWorld(asOf);
  w.bills = bills;
  w.transactions = [payroll()].concat(txs);
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const periods = (rec.defaultView && rec.defaultView.calendarPeriods) || [];
  const current = periods.find(p => p.start <= w.asOf && p.end >= w.asOf) || periods[0];
  const view = (rec.payPeriodViews || []).find(v => v.start <= w.asOf && v.end >= w.asOf) || {};
  const budget = id => {
    const row = ((current && current.householdBudget) || []).find(x => x && (id === 'other' ? x.otherSpending : x.id === id));
    return row && typeof row.spent === 'number' ? row.spent : 0;
  };
  const debits = (r.packet.transactions || []).filter(t => Number(t.amount) > 0);
  return {
    plan: r.plan, packet: r.packet, rec, period: current, debits, budget,
    bad: view.balanceAfterDeductions,
    bill: id => ((current && current.bills) || []).find(b => b.id === id) || null,
    held: id => debits.filter(t => t.nearDueBillCandidate && t.nearDueBillCandidate.id === id)
      .map(t => Number(t.amount)).sort((a, b) => b - a),
    represented: id => (r.packet.representedActuals || []).filter(a => a.id === id),
    classify: t => F.classifyCurrentPeriodTransaction(t, r.plan, { packet: r.packet, currentPeriodActuals: r.packet }),
  };
}
const toConfirm = (b, remaining) => !!(b && b.status !== 'PAID' && b.settlement === 'unverified' && b.remaining === remaining);
const desc = b => b ? `${b.status}/${b.settlement}/${b.remaining}` : 'missing';

console.log('(a) A purchase at a shop whose name contains the bill payee stays that shop\'s spending');
{
  const res = run([{ ...STREAM }], [debit('2026-10-12', 400, 'Invented mart superstore', 'Groceries')]);
  ok(res.represented('stream').length === 0, 'on the due date, the 400 purchase does not settle the 15 bill',
    JSON.stringify(res.represented('stream')));
  ok(toConfirm(res.bill('stream'), 15), 'the 15 bill stays To confirm with 15 reserved (was Paid at 400)', desc(res.bill('stream')));
  ok(res.budget('groceries') === 400, 'Groceries spending counts the 400 (was 0)', String(res.budget('groceries')));
  ok(res.bad === 885, 'balance after deductions 885 = 1,400 - 15 bill - 400 budget - 100 Groceries over budget (was 985)', String(res.bad));
}
{
  const res = run([{ ...STREAM }], [debit('2026-10-14', 400, 'Invented mart superstore', 'Groceries')]);
  ok(res.held('stream').length === 0, 'two days after the due date, the 400 purchase is not held for the bill',
    JSON.stringify(res.held('stream')));
  ok(res.budget('groceries') === 400 && toConfirm(res.bill('stream'), 15),
    'Groceries counts the 400 and the bill stays To confirm', `${res.budget('groceries')} ${desc(res.bill('stream'))}`);
}
console.log('(a) The tolerance is 1.5 times the scheduled amount, upper bound only');
for (const [amount, paid] of [[15, true], [10, true], [22.5, true], [22.51, false], [23, false]]) {
  const res = run([{ ...STREAM }], [debit('2026-10-12', amount, 'Invented mart', 'Subscriptions')]);
  const b = res.bill('stream');
  ok(paid ? (b && b.status === 'PAID') : toConfirm(b, 15),
    `a ${amount} same-day payment ${paid ? 'settles' : 'does not settle'} the 15 bill`, desc(b));
}
{
  // A rule that states its own amount semantics keeps them: amount-at-least
  // settles on a payment above the scheduled amount.
  const res = run([{ ...STREAM, rule: { settlesWhen: 'amount-at-least' } }],
    [debit('2026-10-12', 60, 'Invented mart', 'Subscriptions')]);
  ok(res.bill('stream') && res.bill('stream').status === 'PAID',
    'an amount-at-least rule still settles on 60 against 15', desc(res.bill('stream')));
}

console.log('(b) Two same-day payments for one bill hold the bill To confirm; neither lands in Other');
{
  const res = run([{ ...BIG }], [debit('2026-10-12', 200, 'Invented biller'), debit('2026-10-12', 200, 'Invented biller')]);
  ok(JSON.stringify(res.held('big')) === '[200,200]', 'both 200 payments are named as the bill\'s candidates',
    JSON.stringify(res.held('big')));
  ok(res.debits.every(t => t.nearDueBillCandidate && t.nearDueBillCandidate.ambiguous === true
    && t.nearDueBillCandidate.date === '2026-10-12' && t.nearDueBillCandidate.offsetDays === 0),
  'each names the Oct 12 occurrence, offset 0, ambiguous', JSON.stringify(res.debits.map(t => t.nearDueBillCandidate)));
  ok(res.debits.every(t => res.classify(t).householdSpending === false),
    'neither is household spending');
  ok(res.budget('other') === 0, 'Other spending 0 (was 400)', String(res.budget('other')));
  ok(toConfirm(res.bill('big'), 400) && res.represented('big').length === 0,
    'the bill stays To confirm with 400 reserved; nothing settles', desc(res.bill('big')));
  ok(res.bad === 600, 'balance after deductions 600 = 1,400 - 400 bill - 400 budget (was 200)', String(res.bad));
}
{
  const res = run([{ ...BIG }], [debit('2026-10-12', 400, 'Invented biller'), debit('2026-10-12', 35, 'Invented biller')]);
  ok(JSON.stringify(res.held('big')) === '[400]', 'a full payment plus a same-day 35 fee: only the 400 is held',
    JSON.stringify(res.held('big')));
  ok(res.budget('other') === 35, 'the 35 fee stays in Other, counted once (was 435)', String(res.budget('other')));
  ok(toConfirm(res.bill('big'), 400), 'the bill stays To confirm with 400 reserved', desc(res.bill('big')));
  ok(res.bad === 565, 'balance after deductions 565 = 1,400 - 400 - 400 - 35 (was 165)', String(res.bad));
}

console.log('(c) Each debit is counted once: held debits never exceed the bill\'s reserve');
{
  // Control: a clean payment on the due date, then a fee two days later.
  const clean = run([{ ...BIG }], [debit('2026-10-12', 400, 'Invented biller'), debit('2026-10-14', 35, 'Invented biller')]);
  ok(clean.bill('big') && clean.bill('big').status === 'PAID' && clean.budget('other') === 35 && clean.bad === 565,
    'control: Paid 400 plus a 35 fee in Other, balance 565 (same as the same-day pair above)',
    `${desc(clean.bill('big'))} ${clean.budget('other')} ${clean.bad}`);
}
{
  const res = run([{ ...BIG }], [debit('2026-10-12', 150, 'Invented biller'), debit('2026-10-12', 150, 'Invented biller'),
    debit('2026-10-12', 150, 'Invented biller')]);
  ok(JSON.stringify(res.held('big')) === '[150,150]', 'three 150 payments on a 400 bill: two are held (300 of 400)',
    JSON.stringify(res.held('big')));
  ok(res.budget('other') === 150, 'the third stays in Other (was 450)', String(res.budget('other')));
}
{
  // #962 D3's two near-due charges: the 90 payment is held, the 25 charge
  // beyond the 90 reserve is counted as spending, not hidden.
  const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12,
    confidence: 'confirmed', payee: 'Invented hydro' };
  const res = run([HYDRO], [debit('2026-10-10', 90, 'Invented hydro'), debit('2026-10-13', 25, 'Invented hydro')]);
  ok(JSON.stringify(res.held('hydro')) === '[90]', 'near due: the 90 is held for the 90 bill', JSON.stringify(res.held('hydro')));
  ok(res.budget('other') === 25 && toConfirm(res.bill('hydro'), 90),
    'the 25 charge stays in Other (was hidden); the bill stays To confirm', `${res.budget('other')} ${desc(res.bill('hydro'))}`);
  const late = run([HYDRO], [debit('2026-10-14', 120, 'Invented hydro')]);
  ok(late.held('hydro').length === 0 && late.budget('other') === 120,
    'a 120 payment two days late on a 90 bill is not hidden behind the 90 reserve', `${JSON.stringify(late.held('hydro'))} ${late.budget('other')}`);
  const exact = run([HYDRO], [debit('2026-10-14', 90, 'Invented hydro')]);
  ok(JSON.stringify(exact.held('hydro')) === '[90]' && exact.budget('other') === 0,
    'a 90 payment two days late is still held, as before', `${JSON.stringify(exact.held('hydro'))} ${exact.budget('other')}`);
}
{
  // Two bills from one biller, paid the same day at their own amounts.
  const A = { id: 'pa', label: 'Invented plan A', amount: 50, frequency: 'monthly', day: 12, confidence: 'confirmed',
    payee: 'Invented biller' };
  const B = { ...A, id: 'pb', label: 'Invented plan B', amount: 120 };
  const res = run([A, B], [debit('2026-10-12', 50, 'Invented biller'), debit('2026-10-12', 120, 'Invented biller')]);
  ok(res.bill('pa') && res.bill('pa').status === 'PAID' && res.bill('pa').actual === 50,
    'the 50 payment settles plan A (the 120 is inconsistent with a 50 bill)', desc(res.bill('pa')));
  ok(JSON.stringify(res.held('pb')) === '[120]' && toConfirm(res.bill('pb'), 120),
    'the 120 payment is held for plan B, which stays To confirm', `${JSON.stringify(res.held('pb'))} ${desc(res.bill('pb'))}`);
  ok(res.budget('other') === 0 && res.bad === 830, 'Other 0 and balance 830 = 1,400 - 50 - 120 - 400 (was 170 and 660)',
    `${res.budget('other')} ${res.bad}`);
}

console.log('Self-check: consecutive months, a single payment, a fixed input run twice');
{
  // October pair stays ambiguous; November's single payment settles November only.
  const res = run([{ ...BIG }], [debit('2026-10-12', 200, 'Invented biller'), debit('2026-10-12', 200, 'Invented biller'),
    debit('2026-11-12', 400, 'Invented biller')], '2026-11-14');
  const nov = res.debits.find(t => t.date === '2026-11-12');
  ok(nov && nov.representedBill === true && !nov.nearDueBillCandidate, 'November\'s single 400 settles November',
    JSON.stringify(nov && { rb: nov.representedBill, nd: nov.nearDueBillCandidate }));
  const oct = res.debits.filter(t => t.date === '2026-10-12');
  ok(oct.length === 2 && oct.every(t => t.nearDueBillCandidate && t.nearDueBillCandidate.date === '2026-10-12'),
    'the October pair names October only, never November', JSON.stringify(oct.map(t => t.nearDueBillCandidate)));
}
{
  const res = run([{ ...BIG }], [debit('2026-10-12', 400, 'Invented biller')]);
  ok(res.bill('big') && res.bill('big').status === 'PAID' && res.held('big').length === 0,
    'a single same-day 400 payment still settles Paid', desc(res.bill('big')));
}
{
  const txs = [debit('2026-10-12', 400, 'Invented biller'), debit('2026-10-12', 35, 'Invented biller')];
  const before = JSON.stringify(txs);
  const one = run([{ ...BIG }], txs);
  const two = run([{ ...BIG }], txs);
  // The harness mints a fresh provider id for each payroll row, so the
  // coverage reference (a hash of that id) is left out of the comparison.
  const stable = res => JSON.stringify({ txs: res.packet.transactions.map(({ coverageRef, ...rest }) => rest),
    represented: res.packet.representedActuals });
  ok(stable(one) === stable(two) && one.bad === two.bad,
    'the same input observed twice gives the same transactions, settlements and balance');
  ok(JSON.stringify(txs) === before, 'the input transactions are not mutated');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll bill-match amount and ambiguity checks pass.');
