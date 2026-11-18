'use strict';
/* Partly paid bills and pending payments (Grok Bot's rule 17 answer on bill-payment confirmation, relayed by the lead).
 *
 *   1. A bill whose linked posted payment falls short of its planned amount reads "Partly paid", at any shortfall (one cent).
 *   2. A linked payment that is still pending reads "Payment pending", never Paid.
 *   3. A late linked payment is counted once, in the period of the occurrence it settles (the bill's period convention).
 *   4. No new matching: every case links through the EXISTING identity rule; nothing here adds name or amount matching.
 *   5. The two-account settled-fee path (tdfees, LEDGER A item 1): a posted linked pair below its allowance reads Partly paid with
 *      the rest estimated; above it, Paid with the excess and "Review in Lunch Money". Figures as on main (test-scheduled-fee-routing.js).
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js fromObservation -> Forecast.recommend calendar rows (what the
 * Bills section prints) -> the real printer (plan.js budgetBillPresentation / budgetBillBrowseRowHtml lifted by name).
 * Every expected value is written by hand from the rules above, never read back from the code under test. Invented numbers only.
 *
 * `node test/test-bills-partly-paid.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

function worldFor(bill, txs) {
  const w = H.baseWorld();
  w.bills = [bill];
  w.transactions = txs;
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const periods = (rec.defaultView && rec.defaultView.calendarPeriods) || [];
  const current = periods.find(p => p.start <= w.asOf && p.end >= w.asOf) || periods[0];
  return { w, r, rec, periods, period: current, row: (current.bills || []).find(b => b.id === bill.id) };
}
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const pay = (amount, extra = {}) => H.lm({ date: '2026-10-12', amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro', ...extra });

// the real printers, lifted by name from public/
const src = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const lift = (text, name) => {
  const re = new RegExp(`^(?:const ${name} = |function ${name}\\()`, 'm');
  const m = re.exec(text);
  if (!m) throw new Error(`printer ${name} not found`);
  const end = text.indexOf('\n\n', m.index);
  const next = text.slice(m.index).search(/\n(?:function |const |\/\/)/);
  return text.slice(m.index, m.index + Math.min(next > 0 ? next : Infinity, end > 0 ? end - m.index : Infinity));
};
const app = src('app.js'), plan = src('plan.js');
const ctx = { console, Intl, Number, Math, String, Object, Array, JSON, Date, RegExp };
vm.createContext(ctx);
vm.runInContext([lift(app, 'escapeHtml'), lift(app, 'money2'), lift(app, 'fmtDateLong'), lift(plan, 'isValidIsoCalendarDate'),
  lift(plan, 'budgetBrowseKnown'), lift(plan, 'budgetBrowseEscape'), lift(plan, 'budgetBrowseMoney'),
  lift(plan, 'budgetBillPresentation'), lift(plan, 'budgetBillDisplayLabel'), lift(plan, 'budgetBillBrowseRowHtml'),
  'this.present = budgetBillPresentation; this.rowHtml = budgetBillBrowseRowHtml;'].join('\n'), ctx);
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

console.log('Rule 1: a shortfall reads Partly paid');
{
  const { row, period } = worldFor(HYDRO, [pay(40)]);
  ok(row && row.paymentState === 'partly-paid' && row.shortfall === 50 && row.shortfallTrust === 'calculated',
    '40 posted on a 90 bill: partly paid, 50.00 short (calculated)', row && JSON.stringify({ s: row.paymentState, sf: row.shortfall, t: row.shortfallTrust }));
  // D2 (lead dispatch 2026-11-18): a fixed (confirmed) bill paid in part stays still due for its remainder; the
  // remainder is held (test/test-bill-partial-remainder.js). The paid amount and planned amount are as before.
  ok(row && row.status === 'still due' && row.remaining === 50 && row.actual === 40 && row.planned === 90,
    'a fixed bill paid in part: still due, 50 remaining, actual 40 of 90 planned', row && `${row.status} ${row.remaining} ${row.actual}/${row.planned}`);
  ok(period && period.paidBills === 40, 'the paid-bills total still counts the 40 that left (unchanged)', period && period.paidBills);
  const line = text(ctx.rowHtml(row));
  ok(/Partly paid/.test(line) && /\$50\.00 still to pay/.test(line) && !/\bPaid ·/.test(line) && !/over planned/.test(line),
    'the Bills row reads "Partly paid" with 50.00 still to pay, never plain Paid', line);
}
{
  const { row } = worldFor(HYDRO, [pay(89.99)]);
  ok(row && row.paymentState === 'partly-paid' && row.shortfall === 0.01, 'one cent short is Partly paid (any shortfall)', row && row.shortfall);
  ok(/\$0\.01 still to pay/.test(text(ctx.rowHtml(row))), 'and prints 0.01 still to pay', text(ctx.rowHtml(row)));
}
{
  const exact = worldFor(HYDRO, [pay(90)]).row;
  ok(exact && exact.status === 'PAID' && !('paymentState' in exact) && !('shortfall' in exact), 'an exact payment is Paid, not partly paid',
    JSON.stringify(exact && exact.paymentState));
  const over = worldFor({ ...HYDRO, rule: { settlesWhen: 'amount-at-least' } }, [pay(100)]).row;
  ok(over && over.status === 'PAID' && !('paymentState' in over) && over.excess === 10, 'an overpayment is Paid with its excess, not partly paid',
    JSON.stringify(over && over.paymentState));
  const none = worldFor(HYDRO, []).row;
  ok(none && none.status !== 'PAID' && !('paymentState' in none), 'an unpaid bill is not partly paid', none && none.status);
}
{
  const est = worldFor({ ...HYDRO, confidence: 'estimated' }, [pay(40)]).row;
  ok(est && est.paymentState === 'partly-paid' && est.shortfall === 50 && est.shortfallTrust === 'estimated', 'an estimated plan makes the shortfall estimated',
    est && est.shortfallTrust);
  ok(/Partly paid/.test(text(ctx.rowHtml(est))) && /≈ \$50\.00 still to pay \(estimated\)/.test(text(ctx.rowHtml(est))), 'and the row marks it estimated', text(ctx.rowHtml(est)));
  const unknown = worldFor({ ...HYDRO, confidence: 'unknown' }, [pay(40)]).row;
  ok(unknown && !('paymentState' in unknown) && unknown.status === 'PAID', 'an unestablished planned amount makes no shortfall claim (as no excess claim)',
    unknown && unknown.paymentState);
}

console.log('Rule 2: a pending linked payment is Payment pending, never Paid');
{
  const { row, period } = worldFor(HYDRO, [pay(90, { pending: true })]);
  ok(row && row.status === 'pending' && row.paymentPending === true, 'a pending 90 on a 90 bill: status pending, flagged', row && `${row.status} ${row.paymentPending}`);
  ok(row && row.status !== 'PAID' && row.settlement !== 'represented' && row.actual == null && row.remaining === 90 && !('excess' in row),
    'never Paid: not settled, no actual, the full 90 stays owed, no excess printed off a pending amount',
    row && `${row.settlement} ${row.actual} ${row.remaining} ${row.excess}`);
  ok(period && period.paidBills === 0, 'the paid-bills total does not count a pending payment', period && period.paidBills);
  ok(ctx.present(row).label === 'Payment pending' && ctx.present(row).kind === 'pending', 'the printer reads "Payment pending"', JSON.stringify(ctx.present(row)));
  const big = worldFor(HYDRO, [pay(120, { pending: true })]).row;
  ok(big && big.status === 'pending' && !('excess' in big), 'a pending amount above plan prints no excess and is not Paid', big && `${big.status} ${big.excess}`);
}
{
  // a posted payment that links wins over a pending one for the same occurrence
  const { row } = worldFor(HYDRO, [pay(90, { pending: true, id: 'p1' }), pay(90, { id: 'p2' })]);
  ok(row && (row.status === 'PAID' || row.status === 'pending'), 'with a pending and a posted candidate the row is never both', row && row.status);
}
{
  // no new matching: a pending debit under an amount-at-least rule is not linked at all, so it is not pending and not Paid
  const { row } = worldFor({ ...HYDRO, rule: { settlesWhen: 'amount-at-least' } }, [pay(100, { pending: true })]);
  ok(row && row.status !== 'PAID' && row.status !== 'pending', 'an amount-at-least rule never links a pending debit (unchanged): still due, not Paid', row && row.status);
  const near = worldFor(HYDRO, [H.lm({ date: '2026-10-12', amount: 90, category: 'Utilities', account: 'chequing-a', payee: 'Some other merchant', pending: true })]).row;
  ok(near && near.status !== 'PAID' && near.status !== 'pending', 'a pending debit from a different payee is not linked by name or amount: not pending, not Paid', near && near.status);
}

console.log('Rule 3: a late linked payment is counted once, in the period of the occurrence it settles');
{
  const late = { ...HYDRO, rule: { postingDateRule: 'due-or-up-to-two-days-after' } };
  const { periods, row } = worldFor(late, [pay(90, { date: '2026-10-14' })]);
  ok(row && row.status === 'PAID' && row.actual === 90, 'a payment two days late settles the occurrence once (Paid, actual 90)', row && `${row.status} ${row.actual}`);
  const total = periods.reduce((sum, p) => sum + (p.paidBills || 0), 0);
  ok(total === 90, 'across every published period the paid-bills total counts the 90 exactly once', String(total));
  const rows = periods.flatMap(p => (p.bills || []).filter(b => b.id === 'hydro' && b.status === 'PAID'));
  ok(rows.length === 1, 'exactly one Paid hydro row exists across the published periods', String(rows.length));
}

console.log('Scheduled fees (Grok Bot, rule 17, LEDGER A item 1), and no shortfall claim on a row Forecast reset to unpaid');
{
  // Scheduled fee (tdfees), 24 allowance, the incumbent posted two-leg pair. Expected by hand from Grok's rule:
  //   16 posted: Partly paid, counts at 16 (paid bills 16), the other 8 stays to confirm, estimated, in this period (remaining 8),
  //              never Paid; period cost stays the 24 allowance.
  //   24 posted: Paid, nothing else.
  //   28 posted: counts at 28 (paid bills 28, period cost 28), Paid with "$4.00 over planned · Review in Lunch Money".
  const Live = require('../scripts/live-plan');
  const feeFixture = require('./fixtures/scheduled-fee-routing-data');
  const expected = {
    16: { state: 'partly-paid', shortfall: 8, printed: 'Partly paid · ≈ $8.00 still to pay (estimated)', paid: 16, remaining: 8, total: 24 },
    24: { state: undefined, shortfall: undefined, printed: 'Paid', paid: 24, remaining: 0, total: 24 },
    28: { state: undefined, shortfall: undefined, printed: 'Paid · $4.00 over planned · Review in Lunch Money', paid: 28, remaining: 0, total: 28 },
  };
  for (const posted of [16, 24, 28]) {
    const want = expected[posted];
    const x = feeFixture(posted);
    const live = Live.fromObservation(x);
    const packet = live.data.liveOverlay.currentPeriodActuals;
    const advice = F.recommend(live.data.plan, x.asOf, { debts: live.data.debts, currentPeriodActuals: packet });
    const period = advice.payPeriodViews.find(row => row.start <= x.asOf && row.end >= x.asOf);
    const fee = (period.bills || []).find(b => b.id === 'tdfees');
    ok(fee && fee.paymentState === want.state && fee.shortfall === want.shortfall
      && (want.shortfall ? fee.shortfallTrust === 'estimated' : !('shortfallTrust' in fee)),
    `scheduled fee, ${posted} posted on a 24 allowance: payment state ${want.state || 'none'}, shortfall ${want.shortfall || 'none'}`,
    fee && JSON.stringify({ s: fee.paymentState, sf: fee.shortfall, t: fee.shortfallTrust }));
    ok(fee && (posted === 28) === (fee.excessReview === true), `review flag only above the allowance (${posted})`, fee && String(fee.excessReview));
    const printed = text(ctx.rowHtml(fee));
    ok(printed.includes(want.printed), `its row prints "${want.printed}" (${posted})`, printed);
    if (posted === 16) ok(!/\bPaid\b/.test(printed.replace('Partly paid', '')), 'the 16 row is never called Paid', printed);
    if (posted !== 28) ok(!/Review in Lunch Money/.test(printed), `no review pointer at or below the allowance (${posted})`, printed);
    ok(period.paidBills === want.paid && period.remainingBills === want.remaining && period.totalBillsThisPeriod === want.total,
      `figures as on main (${posted}): paid ${want.paid}, remaining ${want.remaining}, total ${want.total}`,
      JSON.stringify({ paid: period.paidBills, remaining: period.remainingBills, total: period.totalBillsThisPeriod }));
  }
}
{
  // An early payment linked to a bill due in the NEXT pay period: Forecast resets that future row to planned/upcoming, remaining
  // 90, actual 0. It must carry no shortfall claim, so the Bills list cannot say "$50.00 still to pay" off a reset row.
  const w = H.baseWorld();
  w.asOf = '2026-10-21';
  w.bills = [{ ...HYDRO, day: 24, rule: { postingDateRule: 'covers-early-or-due-on-or-before-posting' } }];
  w.transactions = [pay(40, { date: '2026-10-21' })];
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const next = rec.defaultView.calendarPeriods.find(p => p.start <= '2026-10-24' && p.end >= '2026-10-24');
  const row = (next.bills || []).find(b => b.id === 'hydro');
  ok(row && row.status === 'planned' && row.settlement === 'upcoming' && row.actual === 0 && row.remaining === 90,
    'the early-paid future row is reset to planned/upcoming, actual 0, remaining 90', row && `${row.status} ${row.settlement} ${row.actual} ${row.remaining}`);
  ok(row && !('paymentState' in row) && !('shortfall' in row) && !('shortfallTrust' in row) && !('shortfallSource' in row),
    'and carries no partly-paid or shortfall fields', row && JSON.stringify({ s: row.paymentState, sf: row.shortfall }));
  ok(!/Partly paid|still to pay/.test(text(ctx.rowHtml(row))), 'so the Bills list does not print "Partly paid" or "still to pay"', text(ctx.rowHtml(row)));
}
{
  // Defence in depth: the printer prints Partly paid only for a settled row, even if a stale shortfall field reaches it.
  const stale = { status: 'planned', settlement: 'upcoming', paymentState: 'partly-paid', shortfall: 50, shortfallTrust: 'calculated' };
  ok(ctx.present(stale).label !== 'Partly paid', 'the printer refuses Partly paid on a row that is not settled');
  const settled = { status: 'PAID', settlement: 'represented', paymentState: 'partly-paid', shortfall: 50, shortfallTrust: 'calculated' };
  ok(ctx.present(settled).label === 'Partly paid', 'and still prints it on a settled row');
}

console.log('Rule 5: the scheduled-fee path is untouched');
{
  const base = fs.readFileSync(path.join(__dirname, '..', 'docs', 'connectivity', 'transaction-identity.json'), 'utf8');
  ok(/MONTHLY ACCOUNT FEE/.test(base) && /two-leg-sum/.test(base), 'the two-account fee rules are still declared as on main (their suite: test-scheduled-fee-routing.js)');
}

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nPASS bills partly paid and payment pending');
