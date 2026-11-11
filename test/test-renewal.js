'use strict';
/* Focused proof for Forecast.renewal(). `node test/test-renewal.js`
 *
 * The May 2027 renewal is the largest decision the site models: whether to fold
 * a $201,586 interest-only HELOC into a $546,027 mortgage at maturity. Until
 * this move `public/modellers.js` computed the whole comparison itself — the
 * HELOC's compounded balance, both interest totals, today's household cash and
 * the difference against it — so the arithmetic behind that decision sat where
 * the node suite could not reach it. That is `B73`.
 *
 * Five kinds of check, and they prove different things:
 *
 *   0. PUBLISHED BENCHMARKS. Canada quotes fixed and variable mortgage rates on
 *      different compounding, and the modeller used to price every rate as if
 *      it were variable — including the fixed quotes TD will offer in April
 *      2027. The two conventions are checked against figures published outside
 *      this repository: TD's own $300,000-at-3.00% example ($2,069.07 over 15
 *      years, $1,419.74 over 25) and the standard Canadian $100,000-at-6.00%
 *      figure ($639.81, against $644.30 compounded monthly). A benchmark
 *      derived from the code it checks would prove nothing.
 *   1. INDEPENDENT DERIVATION. Every expected figure is a literal in this file,
 *      and every literal is confirmed a second time by a method the engine does
 *      not use: the loan is walked month by month and has to land on zero, and
 *      an unpaid HELOC is grown by repeated multiplication rather than by
 *      `Math.pow`. A declared cash minimum is walked the same way as the
 *      mortgage — charge, then subtract cash — and has to land below the
 *      unpaid compound. Nothing here re-runs the production expression to
 *      find out what the answer should be.
 *   2. PROPAGATION. This is one coupled model, not a renewal calculator with a
 *      private copy of the debt picture. Move the authoritative opening HELOC
 *      balance, its pending charges, or the mortgage payment in the plan, and
 *      the renewal the household reads has to move with it.
 *   3. MUTATION. Each material formula and branch is broken on purpose in the
 *      engine source, and the answer has to change. A formula that cannot be
 *      broken was not being tested.
 *   4. MIGRATION EQUIVALENCE, for the variable scenario. The exact expression
 *      `public/modellers.js` ran before this move, against the real published
 *      inputs, at every one of the 3,822 slider positions the page can reach.
 *      Variable must match to the cent and fixed must not — a fixed option that
 *      produced the same numbers would be a label with no arithmetic behind it.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const money = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-CA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// A cent is the unit a household reads. Two derivations of the same figure by
// different methods do not agree bit for bit, and requiring that they did would
// be testing float representation rather than money.
const CENT = 0.005;
const near = (a, b, tol = CENT) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------- independent maths */
/* Neither of these is the engine's method. `walkLoan` steps a real amortisation
 * schedule — charge interest, take the payment, repeat — and reports where the
 * balance lands and what interest was actually charged on the way. A level
 * payment is correct exactly when that walk ends at zero. `growMonthly` grows a
 * balance by repeated multiplication instead of by an exponent. */
function walkLoan(principal, monthlyRate, months, payment) {
  let balance = principal, interest = 0;
  for (let k = 0; k < months; k++) {
    const charge = balance * monthlyRate;
    interest += charge;
    balance = balance + charge - payment;
  }
  return { balance, interest };
}
/* The two Canadian conventions, written here from their DEFINITIONS rather than
 * imported from the engine — a test that borrows the engine's table proves only
 * that the table equals itself. Fixed rates are quoted "calculated half-yearly,
 * not in advance", so twelve months of growth must equal two half-years of it;
 * variable rates are quoted compounded monthly. */
const monthlyFixed = annualPct => Math.pow(1 + annualPct / 100 / 2, 1 / 6) - 1;
const monthlyVariable = annualPct => annualPct / 100 / 12;
function growMonthly(balance, annualPct, months) {
  const i = annualPct / 100 / 12;
  let b = balance;
  for (let k = 0; k < months; k++) b *= (1 + i);
  return b;
}

/* ---------------------------------------------------------------- fixtures */
/* Round literal facts, so the expected figures below can be reasoned about
 * rather than looked up. A $300,000 mortgage paid $1,000 bi-weekly, and a
 * $100,000 HELOC at 6.00% whose interest capitalises and costs no cash. */
const debtsWith = over => [
  { id: 'mortgage', label: 'Mortgage', secured: true, balance: 300000, pending: 0,
    rate: 6, interestTreatment: 'paid-in-payment' },
  Object.assign({
    id: 'heloc', label: 'HELOC', secured: true, balance: 100000, pending: 0,
    rate: 6, limit: 120000, interestTreatment: 'capitalised',
    cashPayment: 0, monthlyInterest: 500,
  }, over || {}),
];
const DEBTS = debtsWith();
const planWith = over => ({
  obligations: [
    Object.assign({ id: 'mortgage', debtId: 'mortgage', effect: 'payment',
      frequency: 'biweekly', anchor: '2026-08-14', amount: 1000 }, (over || {}).mortgage || {}),
    Object.assign({ id: 'heloc', debtId: 'heloc', effect: 'capitalise',
      frequency: 'monthly', day: 31, amount: 500, nonCash: true }, (over || {}).heloc || {}),
  ].concat((over || {}).extra || []),
});
const PLAN = planWith();
const CASH_PLAN = planWith({ heloc: { cashPayment: 400 } });
const IO_PLAN = planWith({ heloc: { cashPayment: 500 } });
// Every fixture below was hand-computed under MONTHLY compounding, which is
// now the explicit 'variable' basis. Cases that mean 'fixed' say so.
const run = (opts, debts, plan) =>
  F.renewal(plan || PLAN, debts || DEBTS, Object.assign({ basis: 'variable' }, opts));

console.log('\n=== today, from the schedule rather than from a second copy ===');
/* $1,000 bi-weekly is 26 payments a year, so 26,000 / 12 = $2,166.67 a month.
 * The HELOC's obligation is non-cash, so it contributes nothing — that $0.00 is
 * DERIVED from the schedule, not asserted by a field somebody has to remember
 * to keep at zero. Adding the $500 charge here is the $814-a-month bill that
 * nobody pays, which is the defect the cash/economic split was introduced for. */
{
  const r = run({ rate: 6, years: 10, consolidate: false, basis: 'variable' });
  ok(near(r.today.mortgageCash, 26000 / 12),
    'a $1,000 bi-weekly mortgage is $2,166.67 a month', money(r.today.mortgageCash));
  ok(r.today.helocCash === 0,
    'the capitalising HELOC costs no household cash', money(r.today.helocCash));
  ok(near(r.today.householdCash, 2166.6666666667),
    'so today\'s household cash is the mortgage alone', money(r.today.householdCash));
  ok(r.today.helocEconomic === 500,
    'while its economic cost is reported separately', money(r.today.helocEconomic));
  ok(r.today.id === 'capitalised' && r.today.capitalised === true,
    'and the picture is labelled as a capitalising one, not a bill', r.today.id);
  ok(r.today.unmodelled.length === 0,
    'every cash obligation on these debts has a monthly equivalent');
}

console.log('\n=== the amortised payment, proved by walking the loan ===');
/* $300,000 at 6.00% over 120 months. The engine says $3,330.6150582495; a real
 * amortisation schedule run at that payment has to finish at zero, and the
 * interest it charges on the way has to be the interest reported. */
{
  const r = run({ rate: 6, years: 10, consolidate: false, basis: 'variable' });
  ok(near(r.payment, 3330.6150582495 + 0, 1e-6),
    'the level payment is $3,330.62 a month', r.payment.toFixed(10));
  const walk = walkLoan(300000, monthlyVariable(6), 120, r.payment);
  ok(Math.abs(walk.balance) < 0.000001,
    'walking 120 months at that payment clears the loan exactly',
    walk.balance.toExponential(3));
  ok(near(r.interest.amortising, 99673.80699, 0.001),
    'and charges $99,673.81 of interest', money(r.interest.amortising));
  ok(near(walk.interest, r.interest.amortising, 0.0001),
    'which is what the walk independently accrued', money(walk.interest));
  // A payment even a cent short cannot clear the loan; a cent over overshoots.
  ok(walkLoan(300000, monthlyVariable(6), 120, r.payment - 0.01).balance > 1,
    'a cent less does not clear it',
    walkLoan(300000, monthlyVariable(6), 120, r.payment - 0.01).balance.toFixed(2));
  ok(walkLoan(300000, monthlyVariable(6), 120, r.payment + 0.01).balance < -1,
    'and a cent more overshoots');
}

console.log('\n=== the rate convention, against published benchmarks ===');
/* Canada quotes fixed and variable mortgage rates on different compounding, and
 * the renewal used to price every rate the slider could reach as if it were
 * variable — including the fixed quotes TD will actually offer in April 2027.
 *
 * The benchmarks here are EXTERNAL and published, not derived from this engine:
 * TD's own fixed-rate example, and the standard Canadian textbook figure. A
 * benchmark computed from the code it is checking proves nothing. */
{
  const cents = n => n.toFixed(2);
  // TD's published fixed-rate example: a $300,000 mortgage at 3.00%.
  const td15 = run({ rate: 3, years: 15, consolidate: false, basis: 'fixed' });
  const td25 = run({ rate: 3, years: 25, consolidate: false, basis: 'fixed' });
  ok(cents(td15.payment) === '2069.07',
    'TD\'s $300,000 at 3.00% over 15 years is $2,069.07 — matched to the cent', cents(td15.payment));
  ok(cents(td25.payment) === '1419.74',
    'and over 25 years is $1,419.74 — matched to the cent', cents(td25.payment));
  // The same inputs on the convention the engine used to apply to everything.
  const v15 = run({ rate: 3, years: 15, consolidate: false, basis: 'variable' });
  const v25 = run({ rate: 3, years: 25, consolidate: false, basis: 'variable' });
  ok(cents(v15.payment) === '2071.74' && cents(v25.payment) === '1422.63',
    'pricing that same fixed quote as variable answers $2,071.74 and $1,422.63 — the defect',
    `${cents(v15.payment)} / ${cents(v25.payment)}`);
  ok(v15.payment > td15.payment && v25.payment > td25.payment,
    'and it does so in the OVERSTATING direction, on every one of them',
    `+${cents(v15.payment - td15.payment)} / +${cents(v25.payment - td25.payment)}`);

  // The independent textbook benchmark: $100,000 at 6.00% over 25 years is
  // $639.81 in Canada and $644.30 under monthly compounding.
  const cdn = run({ rate: 6, years: 25, consolidate: false, basis: 'fixed' },
    debtsWith({ balance: 0 }).map(x => x.id === 'mortgage' ? Object.assign({}, x, { balance: 100000 }) : x));
  const usa = run({ rate: 6, years: 25, consolidate: false, basis: 'variable' },
    debtsWith({ balance: 0 }).map(x => x.id === 'mortgage' ? Object.assign({}, x, { balance: 100000 }) : x));
  ok(cents(cdn.payment) === '639.81',
    '$100,000 at 6.00% over 25 years is $639.81 on the Canadian fixed convention', cents(cdn.payment));
  ok(cents(usa.payment) === '644.30',
    'and $644.30 compounded monthly — a second, independent pair', cents(usa.payment));

  // The DEFINITION of the fixed convention: twelve months of growth must equal
  // two half-years of it. This is the identity the whole thing rests on, and it
  // is checked against the engine's own monthly rate, not against a copy.
  for (const rate of [0, 3, 3.65, 6, 7.5]) {
    const f = run({ rate, years: 18, consolidate: false, basis: 'fixed' });
    ok(near(Math.pow(1 + f.rateMonthly, 12), Math.pow(1 + rate / 100 / 2, 2), 1e-12),
      `at ${rate}% fixed, (1 + monthly)^12 equals (1 + annual/2)^2`,
      Math.pow(1 + f.rateMonthly, 12).toFixed(12));
    ok(near(f.rateMonthly, monthlyFixed(rate), 1e-15),
      `and the monthly rate is the sixth root, independently derived`, f.rateMonthly.toFixed(12));
    const v = run({ rate, years: 18, consolidate: false, basis: 'variable' });
    ok(near(v.rateMonthly, monthlyVariable(rate), 1e-15),
      `at ${rate}% variable it is a plain twelfth`, v.rateMonthly.toFixed(12));
  }
  // And the payment those rates imply still clears a real amortisation walk.
  ok(Math.abs(walkLoan(300000, monthlyFixed(3), 180, td15.payment).balance) < 0.000001,
    'walking 180 months at the fixed periodic rate clears TD\'s example exactly',
    walkLoan(300000, monthlyFixed(3), 180, td15.payment).balance.toExponential(3));
}

console.log('\n=== the convention is chosen, never assumed ===');
/* A renewal rate with no stated convention is the defect. The engine has no
 * default: a caller that forgets gets an exception, not a plausible figure. */
{
  const threw = fn => { try { fn(); return null; } catch (e) { return e.message; } };
  ok(/needs a rate basis/.test(threw(() => F.renewal(PLAN, DEBTS, { rate: 3, years: 10 })) || ''),
    'omitting the basis throws rather than picking one');
  ok(/needs a rate basis/.test(threw(() => F.renewal(PLAN, DEBTS, { rate: 3, years: 10, basis: 'teaser' })) || ''),
    'and an unknown basis throws rather than falling back');
  ok(threw(() => F.renewal(PLAN, DEBTS, { rate: 3, years: 10, basis: 'fixed' })) === null
    && threw(() => F.renewal(PLAN, DEBTS, { rate: 3, years: 10, basis: 'variable' })) === null,
  'while both real conventions are accepted');
  ok(run({ rate: 3, years: 10, consolidate: false, basis: 'fixed' }).basis === 'fixed'
    && run({ rate: 3, years: 10, consolidate: false, basis: 'variable' }).basis === 'variable',
  'and the answer carries the convention it was priced under');
}

console.log('\n=== the convention reaches every downstream figure ===');
/* Payment, interest, consolidation and the comparison all move with it — and
 * the HELOC, which is prime-linked whatever the mortgage renews into, does not. */
{
  const f = run({ rate: 3, years: 10, consolidate: false, basis: 'fixed' });
  const v = run({ rate: 3, years: 10, consolidate: false, basis: 'variable' });
  ok(f.payment < v.payment, 'the monthly payment moves', `${money(f.payment)} < ${money(v.payment)}`);
  ok(f.interest.amortising < v.interest.amortising,
    'the mortgage interest moves', `${money(f.interest.amortising)} < ${money(v.interest.amortising)}`);
  ok(f.interest.total < v.interest.total, 'so the total moves');
  ok(f.delta < v.delta, 'and so does the comparison against today',
    `${money(f.delta)} < ${money(v.delta)}`);
  const cf = run({ rate: 3, years: 10, consolidate: true, basis: 'fixed' });
  const cv = run({ rate: 3, years: 10, consolidate: true, basis: 'variable' });
  ok(cf.payment < cv.payment && cf.interest.total < cv.interest.total,
    'consolidating prices the folded-in HELOC on the renewal convention too',
    `${money(cf.payment)} < ${money(cv.payment)}`);
  ok(cf.principal === cv.principal,
    'while the principal financed is a balance, not a rate, and does not move');

  // The facility that stays OUTSIDE the mortgage keeps its own convention.
  ok(f.helocOwed === v.helocOwed && f.interest.heloc === v.interest.heloc,
    'choosing a fixed renewal does not reprice the variable HELOC beside it',
    money(f.helocOwed));
  ok(near(f.helocOwed, growMonthly(100000, 6, 120), 1e-6),
    'which still compounds monthly at its own prime-linked rate', money(f.helocOwed));
}

console.log('\n=== HELOC compounding over the renewal horizon ===');
/* Nothing repays the HELOC and its interest capitalises MONTHLY, so $100,000 at
 * 6.00% is 100,000 × 1.005^120. Grown by repeated multiplication instead of by
 * an exponent that is $181,939.6734032290 — the balance has grown 81.9% and the
 * interest is the difference, not a simple-interest figure. */
{
  const r = run({ rate: 6, years: 10, consolidate: false, basis: 'variable' });
  ok(near(r.helocOwed, 181939.6734032290, 1e-6),
    'a $100,000 capitalising HELOC at 6.00% becomes $181,939.67 in ten years',
    money(r.helocOwed));
  ok(near(growMonthly(100000, 6, 120), r.helocOwed, 1e-6),
    'which is what 120 successive monthly charges independently produce',
    money(growMonthly(100000, 6, 120)));
  ok(near(r.interest.heloc, 81939.6734032290, 1e-6),
    'and the interest is the growth, $81,939.67', money(r.interest.heloc));
  // Simple interest is the defect this replaced: 100,000 × 0.06 × 10 = $60,000,
  // which understates the cost by $21,939.67 and leaves $100,000 "still owed".
  ok(r.interest.heloc - 60000 > 21939,
    'compounding is $21,939.67 more than the simple-interest answer it replaced',
    money(r.interest.heloc - 60000));
  ok(near(r.interest.total, r.interest.amortising + r.interest.heloc),
    'the total is the two costs and nothing else', money(r.interest.total));
  ok(near(r.interest.total, 181613.4803931733, 0.001),
    'so $181,613.48 over ten years', money(r.interest.total));
}

console.log('\n=== a declared cash minimum is a payment against the capitalising HELOC ===');
/* Household cash already counts monthlyCashFor('heloc'). Keep-separate must
 * apply that same figure to the balance. The engine's unpaid path uses
 * Math.pow; this proof walks charge-then-cash and does not. */
{
  const unpaid = run({ rate: 6, years: 10, consolidate: false, basis: 'variable' });
  const cash = run({ rate: 6, years: 10, consolidate: false, basis: 'variable' },
    DEBTS, CASH_PLAN);
  const io = run({ rate: 6, years: 10, consolidate: false, basis: 'variable' },
    DEBTS, IO_PLAN);
  ok(cash.today.helocCash === 400 && near(cash.today.householdCash, 2166.6666666667 + 400),
    'household cash includes the declared HELOC cash minimum', money(cash.today.householdCash));
  ok(near(cash.payment, unpaid.payment + 400, 1e-9),
    'and that cash keeps leaving beside the renewed mortgage', money(cash.payment));
  const walked = walkLoan(100000, monthlyVariable(6), 120, 400);
  ok(near(cash.helocOwed, walked.balance, 1e-6),
    'the horizon matches an independent charge-then-cash walk', money(cash.helocOwed));
  ok(near(cash.interest.heloc, walked.interest, 1e-6),
    'and the interest is the gross charged on that walk, not net growth',
    money(cash.interest.heloc));
  ok(cash.helocOwed < unpaid.helocOwed,
    'so the owed balance is strictly below unpaid compounding',
    `${money(cash.helocOwed)} < ${money(unpaid.helocOwed)}`);
  ok(near(unpaid.helocOwed, 181939.6734032290, 1e-6),
    'while capitalise with no cash payment still compounds as before',
    money(unpaid.helocOwed));
  ok(io.today.helocCash === 500 && near(io.helocOwed, 100000, 1e-6),
    'cash covering the monthly charge is interest-only: the opening is still owed',
    money(io.helocOwed));
  ok(near(io.interest.heloc, 500 * 120, 1e-6),
    'and the interest is 120 charges of $500', money(io.interest.heloc));
}

console.log('\n=== consolidating, and what it removes ===');
/* $300,000 + $100,000 amortised together at 6.00% over 120 months. The HELOC
 * principal is genuinely repaid, so nothing is owed at the horizon and no
 * capitalised interest is charged at all. */
{
  const r = run({ rate: 6, years: 10, consolidate: true });
  ok(r.principal === 400000, 'both balances are financed', money(r.principal));
  ok(near(r.payment, 4440.8200776660, 1e-6),
    'the payment is $4,440.82 a month', r.payment.toFixed(10));
  ok(Math.abs(walkLoan(400000, monthlyVariable(6), 120, r.payment).balance) < 0.000001,
    'walking 120 months at that payment clears the combined loan exactly');
  ok(r.helocOwed === 0 && r.interest.heloc === 0,
    'nothing is left owing on the HELOC and it charges no capitalised interest');
  ok(near(r.interest.total, 132898.4093199258, 0.001),
    'total interest is $132,898.41', money(r.interest.total));
  // The whole trade, in one line: consolidating costs $1,110.20 a month more
  // and saves $48,715.07 of interest on this fixture.
  const keep = run({ rate: 6, years: 10, consolidate: false, basis: 'variable' });
  ok(near(r.payment - keep.payment, 1110.2050194165, 1e-6),
    'it costs $1,110.21 a month more than keeping them apart',
    money(r.payment - keep.payment));
  ok(near(keep.interest.total - r.interest.total, 48715.0710732475, 0.001),
    'and saves $48,715.07 of interest', money(keep.interest.total - r.interest.total));
  ok(r.outcome === 'consolidated' && r.capitalisation.id === 'stopped',
    'the capitalising charge is reported as stopped, and only here', r.capitalisation.id);
  ok(keep.outcome === 'interestOnlyCapitalising' && keep.capitalisation.id === 'continues',
    'while keeping them apart says it continues', keep.capitalisation.id);
}

console.log('\n=== the zero-rate boundary ===');
/* At 0.00% the annuity formula divides by zero, so the payment is the principal
 * spread evenly and no interest is charged. Both figures are exact by hand. */
{
  const keep = run({ rate: 0, years: 10, consolidate: false });
  ok(keep.payment === 300000 / 120 && keep.payment === 2500,
    'at 0.00% a $300,000 loan over ten years is exactly $2,500 a month',
    money(keep.payment));
  ok(keep.interest.amortising === 0, 'and charges no mortgage interest at all');
  ok(near(keep.helocOwed, 181939.6734032290, 1e-6),
    'the HELOC still compounds at its own rate, untouched by the renewal rate',
    money(keep.helocOwed));
  const both = run({ rate: 0, years: 10, consolidate: true });
  ok(near(both.payment, 400000 / 120, 1e-9) && both.interest.total === 0,
    'and consolidating at 0.00% is $3,333.33 a month with no interest anywhere',
    money(both.payment));
  // A zero-rate HELOC is the other boundary: nothing compounds, nothing accrues.
  const flat = run({ rate: 6, years: 10, consolidate: false },
    debtsWith({ rate: 0 }));
  ok(flat.helocOwed === 100000 && flat.interest.heloc === 0,
    'a 0.00% HELOC still owes exactly its opening balance and no more',
    money(flat.helocOwed));
}

console.log('\n=== a materially different HELOC rate reorders the answer ===');
/* The renewal rate prices the mortgage; the HELOC rate prices what is left
 * outside it. Only the keep-separate side can move, and it has to move in one
 * direction — a dearer HELOC is never cheaper. */
{
  const at = pctRate => run({ rate: 6, years: 10, consolidate: false }, debtsWith({ rate: pctRate }));
  const cheap = at(2), mid = at(6), dear = at(12);
  ok(cheap.helocOwed < mid.helocOwed && mid.helocOwed < dear.helocOwed,
    'a dearer HELOC owes strictly more at the horizon',
    [cheap, mid, dear].map(x => money(x.helocOwed)).join(' < '));
  ok(cheap.interest.total < mid.interest.total && mid.interest.total < dear.interest.total,
    'and costs strictly more in total interest',
    [cheap, mid, dear].map(x => money(x.interest.total)).join(' < '));
  ok(cheap.payment === mid.payment && mid.payment === dear.payment,
    'while the monthly cash is unchanged — the HELOC is not a bill in any of them',
    money(mid.payment));
  // 12% doubles roughly every six years, so ten years is more than triple.
  ok(near(dear.helocOwed, growMonthly(100000, 12, 120), 1e-6) && dear.helocOwed > 300000,
    'at 12.00% the balance more than triples in ten years', money(dear.helocOwed));
  // Consolidating removes the HELOC rate from the answer entirely, because
  // there is no longer a HELOC to charge it on.
  const both = pctRate => run({ rate: 6, years: 10, consolidate: true }, debtsWith({ rate: pctRate }));
  ok(both(2).interest.total === both(12).interest.total,
    'once folded in, the HELOC rate cannot affect the total at all',
    money(both(12).interest.total));
  // Which side wins on total interest is a real reordering, not a fixed answer:
  // against a 2.00% HELOC, keeping them apart is the cheaper total.
  ok(cheap.interest.total < both(2).interest.total,
    'against a 2.00% HELOC, keeping them apart costs less total interest',
    `${money(cheap.interest.total)} vs ${money(both(2).interest.total)}`);
  ok(mid.interest.total > both(6).interest.total,
    'and against a 6.00% one, folding it in does',
    `${money(mid.interest.total)} vs ${money(both(6).interest.total)}`);
}

console.log('\n=== the opening HELOC balance propagates ===');
/* One coupled model. The renewal opens on the same balance the debt walk opens
 * on and headroom is measured against — posted plus pending, because a pending
 * charge is already incurred. */
{
  const base = run({ rate: 6, years: 10, consolidate: false, basis: 'variable' });
  const bigger = run({ rate: 6, years: 10, consolidate: false }, debtsWith({ balance: 200000 }));
  ok(near(bigger.helocOwed, base.helocOwed * 2, 1e-6),
    'doubling the opening balance doubles what is owed at the horizon',
    money(bigger.helocOwed));
  ok(near(bigger.interest.heloc, base.interest.heloc * 2, 1e-6),
    'and doubles the interest', money(bigger.interest.heloc));

  const pending = debtsWith({ pending: 5000 });
  const withPending = run({ rate: 6, years: 10, consolidate: false }, pending);
  ok(withPending.heloc.opening === 105000,
    'a $5,000 pending charge is part of what the HELOC owes today',
    money(withPending.heloc.opening));
  ok(near(withPending.helocOwed, growMonthly(105000, 6, 120), 1e-6),
    'and compounds from that opening, not from the posted balance',
    money(withPending.helocOwed));
  ok(withPending.helocOwed > base.helocOwed,
    'so ignoring it would understate the horizon by $9,096.98',
    money(withPending.helocOwed - base.helocOwed));
  ok(run({ rate: 6, years: 10, consolidate: true }, pending).principal === 405000,
    'and consolidating has to finance it too', money(405000));

  // The coupling proof: the three consumers of the opening-balance rule agree
  // on the same record. They were three inline copies of one expression, and
  // two copies of this rule have already disagreed once in this repository.
  const util = F.utilisation(pending).rows.find(x => x.id === 'heloc');
  const walk = F.projectDebts(
    { windowDays: 1, income: [], obligations: [], bills: [], commitments: [] },
    pending, '2026-08-09', {});
  const dayZero = walk.marks.find(m => m.day === 0).debts.find(x => x.id === 'heloc');
  ok(util.used === withPending.heloc.opening,
    'the renewal opens on the balance headroom is measured against', money(util.used));
  ok(dayZero.balance === withPending.heloc.opening,
    'and on the balance the coupled debt walk opens on', money(dayZero.balance));
}

console.log('\n=== payment assumptions propagate ===');
/* Today's household cash comes from the schedule, so changing what the
 * household actually pays moves the comparison it reads. */
{
  const base = run({ rate: 6, years: 10, consolidate: false, basis: 'variable' });
  const dearer = run({ rate: 6, years: 10, consolidate: false }, DEBTS,
    planWith({ mortgage: { amount: 1200 } }));
  ok(near(dearer.today.householdCash, 1200 * 26 / 12) && near(dearer.today.householdCash, 2600),
    'raising the bi-weekly mortgage payment to $1,200 raises today to $2,600',
    money(dearer.today.householdCash));
  ok(near(base.delta - dearer.delta, 2600 - 26000 / 12, 1e-9),
    'and moves the comparison by exactly that much, in the right direction',
    `${money(base.delta)} → ${money(dearer.delta)}`);
  ok(dearer.payment === base.payment,
    'without touching what the renewal itself costs', money(dearer.payment));

  const monthly = run({ rate: 6, years: 10, consolidate: false }, DEBTS,
    planWith({ mortgage: { frequency: 'monthly', day: 1 } }));
  ok(monthly.today.householdCash === 1000,
    'the same $1,000 paid monthly is $1,000 a month, not $2,166.67',
    money(monthly.today.householdCash));

  // A HELOC that is genuinely paid rather than capitalised raises BOTH sides:
  // it is $500 of cash today and $500 that still leaves after the renewal, so
  // the difference the household reads is unchanged.
  const paid = run({ rate: 6, years: 10, consolidate: false },
    debtsWith({ interestTreatment: 'paid-in-payment', cashPayment: 500 }),
    planWith({ heloc: { nonCash: false } }));
  ok(paid.today.helocCash === 500 && near(paid.today.householdCash, 2666.6666666667),
    'a paid HELOC charge is household cash', money(paid.today.householdCash));
  ok(near(paid.payment, base.payment + 500, 1e-9),
    'and keeps leaving the account after the renewal too', money(paid.payment));
  ok(near(paid.delta, base.delta, 1e-9),
    'so the comparison is unchanged by it', money(paid.delta));
  ok(paid.today.id === 'paid' && paid.capitalisation === null
    && paid.outcome === 'interestOnlyFlat',
    'and the picture is a paid one, with no capitalisation row', paid.outcome);
  ok(paid.helocOwed === 100000 && paid.interest.heloc === 100000 * 0.06 * 10,
    'a paid interest-only balance stands still and costs simple interest',
    money(paid.interest.heloc));

  // A cash obligation with no monthly equivalent is REPORTED, never dropped.
  const oneOff = run({ rate: 6, years: 10, consolidate: false }, DEBTS,
    planWith({ extra: [{ id: 'mortgage-lump', debtId: 'mortgage', effect: 'payment',
      frequency: 'once', date: '2026-09-01', amount: 5000 }] }));
  ok(oneOff.today.unmodelled.join(',') === 'mortgage-lump',
    'a one-off cash obligation is named rather than silently omitted',
    oneOff.today.unmodelled.join(',') || 'none');
  ok(near(oneOff.today.householdCash, base.today.householdCash),
    'and does not quietly inflate the monthly baseline',
    money(oneOff.today.householdCash));
  // Naming it is not enough. A baseline short of a real cash obligation
  // understates what the household already pays, so a difference measured
  // against it flatters the renewal — the comparison is withheld, not shown
  // with a caveat somewhere else on the page.
  ok(oneOff.direction === 'unknown',
    'and the comparison against that baseline is withheld', oneOff.direction);
  ok(base.direction !== 'unknown',
    'while a complete baseline still reports a direction', base.direction);
  ok(oneOff.delta === base.delta,
    'the arithmetic difference is still returned; direction is what gates it',
    money(oneOff.delta));
}

console.log('\n=== the comparison itself ===');
{
  const cheapRenewal = run({ rate: 1, years: 30, consolidate: false });
  ok(cheapRenewal.direction === 'less' && cheapRenewal.delta < 0,
    'a renewal that costs less than today is reported as less',
    money(cheapRenewal.delta));
  ok(run({ rate: 6, years: 10, consolidate: true }).direction === 'more',
    'and one that costs more, as more');
  // Half a cent either way is not a change in what the household pays.
  const flat = F.renewal({ obligations: [] }, [
    { id: 'mortgage', balance: 0, pending: 0, rate: 0 },
    { id: 'heloc', balance: 0, pending: 0, rate: 0, interestTreatment: 'capitalised', monthlyInterest: 0 },
  ], { rate: 6, years: 10, consolidate: false, basis: 'variable' });
  ok(flat.direction === 'same' && flat.delta === 0,
    'and no change at all is neither', flat.direction);
}

console.log('\n=== mutation: breaking the engine breaks the answer ===');
/* Mutate the engine source, load the mutant, and require it to disagree with
 * the real engine on a case above. A formula that still produces the right
 * answer when it is removed was not producing it. */
const FORECAST_SRC = read('public/forecast.js');
function mutant(from, to) {
  from = sourceText(from);
  to = sourceText(to);
  const count = FORECAST_SRC.split(from).length - 1;
  if (count !== 1) return { error: `target appears ${count} time(s)` };
  const sandbox = { module: { exports: {} } };
  try {
    vm.runInNewContext(FORECAST_SRC.replace(from, to), sandbox, { filename: 'forecast-mutant.js' });
  } catch (e) { return { error: e.message }; }
  return { engine: sandbox.module.exports };
}
const PENDING_DEBTS = debtsWith({ pending: 5000 });
const PAID_DEBTS = debtsWith({ interestTreatment: 'paid-in-payment', cashPayment: 500 });
const PAID_PLAN = planWith({ heloc: { nonCash: false } });

const MUTATIONS = [
  { label: 'pricing a fixed rate on the variable convention breaks TD\'s published example',
    from: '    fixed: annualPct => Math.pow(1 + annualPct / 100 / 2, 1 / 6) - 1,',
    to: '    fixed: annualPct => annualPct / 100 / 12,',
    differs: m => m.renewal(PLAN, DEBTS, { rate: 3, years: 15, consolidate: false, basis: 'fixed' })
      .payment.toFixed(2) !== '2069.07' },

  { label: 'letting the renewal convention reprice the HELOC beside it moves its horizon',
    from: '      const helocMonthlyRate = RATE_BASIS.variable(heloc ? heloc.rate : 0);',
    to: '      const helocMonthlyRate = rateMonthly;',
    differs: m => m.renewal(PLAN, DEBTS, { rate: 3, years: 10, consolidate: false, basis: 'fixed' })
      .helocOwed !== run({ rate: 3, years: 10, consolidate: false, basis: 'fixed' }).helocOwed },

  { label: 'compounding the HELOC annually instead of monthly changes the horizon',
    from: '          helocOwed = helocOpening * Math.pow(1 + helocMonthlyRate, helocMonths);',
    to: '          helocOwed = helocOpening * Math.pow(1 + (heloc ? heloc.rate : 0) / 100, years);',
    differs: m => !near(m.renewal(PLAN, DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' }).helocOwed,
      181939.6734032290, 1) },

  { label: 'charging simple interest instead understates what is owed',
    from: '          helocInterest = helocOwed - helocOpening;',
    to: '          helocInterest = helocOpening * helocRate * years;',
    differs: m => !near(m.renewal(PLAN, DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' }).interest.total,
      181613.4803931733, 1) },

  { label: 'dropping the cash minimum from a capitalising walk leaves unpaid compound',
    from: '            owed += charge - helocCash;',
    to: '            owed += charge;',
    differs: m => near(m.renewal(CASH_PLAN, DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' }).helocOwed,
      181939.6734032290, 1) },

  { label: 'dropping pending charges moves the opening balance the renewal runs on',
    from: 'const openingBalance = debt => debt.balance + (debt.pending || 0);',
    to: 'const openingBalance = debt => debt.balance;',
    differs: m => m.renewal(PLAN, PENDING_DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' })
      .heloc.opening !== 105000 },

  { label: 'counting the capitalised charge as cash invents a bill nobody pays',
    from: `        if (o.nonCash) {
          const cashAmt = Number(o.cashPayment) || 0;`,
    to: `        if (false && o.nonCash) {
          const cashAmt = Number(o.cashPayment) || 0;`,
    differs: m => !near(m.renewal(PLAN, DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' })
      .today.householdCash, 2166.6666666667, 1) },

  { label: 'annualising a bi-weekly payment as monthly understates today',
    from: '  const PAYMENTS_PER_YEAR = { biweekly: 26, monthly: 12 };',
    to: '  const PAYMENTS_PER_YEAR = { biweekly: 12, monthly: 12 };',
    differs: m => !near(m.renewal(PLAN, DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' })
      .today.householdCash, 2166.6666666667, 1) },

  { label: 'dropping the HELOC cash from the renewal payment understates it',
    from: '      payment = mortgagePayment + helocCash;',
    to: '      payment = mortgagePayment;',
    differs: m => !near(m.renewal(PAID_PLAN, PAID_DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' })
      .payment, 3830.6150582495, 1) },

  { label: 'consolidating without the HELOC principal finances the wrong loan',
    from: '      principal = mortgageOpening + helocOpening;',
    to: '      principal = mortgageOpening;',
    differs: m => m.renewal(PLAN, DEBTS, { rate: 6, years: 10, consolidate: true, basis: 'variable' }).principal !== 400000 },

  { label: 'swallowing an un-annualisable obligation hides an incomplete baseline',
    from: '        if (!perYear) { unmodelled.push(o.id); return sum; }',
    to: '        if (!perYear) { return sum; }',
    differs: m => m.renewal(planWith({ extra: [{ id: 'mortgage-lump', debtId: 'mortgage',
      frequency: 'once', date: '2026-09-01', amount: 5000 }] }), DEBTS,
    { rate: 6, years: 10, consolidate: false, basis: 'variable' }).today.unmodelled.length !== 1 },

  { label: 'showing the stopped-capitalisation row without consolidating contradicts the note',
    from: '        ? { id: consolidate ? \'stopped\' : \'continues\', amount: helocEconomic }',
    to: '        ? { id: \'stopped\', amount: helocEconomic }',
    differs: m => m.renewal(PLAN, DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' })
      .capitalisation.id !== 'continues' },

  { label: 'publishing a comparison against an incomplete baseline flatters the renewal',
    from: `      direction: unmodelled.length ? 'unknown'
        : delta > EPSILON ? 'more' : delta < -EPSILON ? 'less' : 'same',`,
    to: `      direction: delta > EPSILON ? 'more' : delta < -EPSILON ? 'less' : 'same',`,
    differs: m => m.renewal(planWith({ extra: [{ id: 'mortgage-lump', debtId: 'mortgage',
      effect: 'payment', frequency: 'once', date: '2026-09-01', amount: 5000 }] }), DEBTS,
    { rate: 6, years: 10, consolidate: false, basis: 'variable' }).direction !== 'unknown' },

  { label: 'comparing the renewal against nothing loses the comparison',
    from: '    const delta = payment - householdCash;',
    to: '    const delta = payment;',
    differs: m => !near(m.renewal(PLAN, DEBTS, { rate: 1, years: 30, consolidate: false, basis: 'variable' }).delta,
      run({ rate: 1, years: 30, consolidate: false }).delta, 1) },
];
for (const m of MUTATIONS) {
  const built = mutant(m.from, m.to);
  if (built.error) { ok(false, m.label, built.error); continue; }
  ok(m.differs(built.engine), m.label);
}

console.log('\n=== the ids the engine can return ===');
/* The Modellers page that rendered the renewal was removed under #822. The
 * page-source and wording-map checks went with it; what the engine may return
 * is still pinned here, read from the production source. */
const renewalSrc = /\n  function renewal\(plan, debts, opts\) \{[\s\S]*?\n  \}\n/.exec(FORECAST_SRC);
ok(!!renewalSrc, 'the renewal function is readable from forecast.js');
ok(/function amortisedPayment/.test(FORECAST_SRC), 'the engine defines the renewal amortisation');
ok(!/amortisedPayment\s*\(/.test(read('public/app.js')),
  'the renewal amortisation is defined and called nowhere in the shared page script');
// The formatter the delta row used, so the legacy figure below is built with
// the same function the browser used rather than with a lookalike.
const appMoney2 = vm.runInNewContext(`${/^const money2 = .*$/m.exec(read('public/app.js'))[0]}\nmoney2;`);

/* Every id the returned object can carry, read out of the field that produces
 * it: slice from the field to the next field at the same indent, drop the
 * comments, and collect the string literals that are left. */
function emitted(field) {
  const at = renewalSrc[0].indexOf(`\n      ${field}:`);
  if (at < 0) return [];
  const rest = renewalSrc[0].slice(at + 1);
  const end = rest.search(/\n      [A-Za-z]+[:,]|\n    \};/);
  const expr = (end >= 0 ? rest.slice(0, end) : rest).replace(/\/\/.*$/gm, '');
  return [...new Set([...expr.matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]))].sort();
}
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const OUTCOMES = ['consolidated', 'interestOnlyCapitalising', 'interestOnlyFlat'];
ok(sameSet(emitted('outcome'), OUTCOMES),
  'the engine emits no outcome beyond those three', emitted('outcome').join(', '));
ok(sameSet(emitted('today'), ['capitalised', 'paid']),
  'no picture of today beyond those two', emitted('today').join(', '));
ok(sameSet(emitted('capitalisation'), ['continues', 'stopped']),
  'no capitalisation state beyond those two', emitted('capitalisation').join(', '));
ok(sameSet(emitted('direction'), ['less', 'more', 'same', 'unknown']),
  'and no direction beyond those four', emitted('direction').join(', '));
{
  const engineBases = [...new Set([...(/const RATE_BASIS = \{[\s\S]*?\n  \};/.exec(FORECAST_SRC) || [''])[0]
    .matchAll(/^\s{4}([a-z]+):/gm)].map(m => m[1]))].sort();
  ok(sameSet(engineBases, ['fixed', 'variable']),
    'the engine offers exactly the fixed and variable conventions, no more', engineBases.join(', '));
}

/* The withheld state. An incomplete baseline must not reach a consumer as a
 * confident figure, and the missing payment has to be named. */
{
  const withheld = F.renewal(planWith({ extra: [{ id: 'mortgage-lump', debtId: 'mortgage',
    effect: 'payment', frequency: 'once', date: '2026-09-01', amount: 5000 }] }), DEBTS,
  { rate: 6, years: 10, consolidate: false, basis: 'variable' });
  ok(withheld.direction === 'unknown',
    'the comparison reports unknown, not a direction, when a payment is unmodelled', withheld.direction);
  ok(JSON.stringify(withheld.today.unmodelled).includes('mortgage-lump'),
    'and names the payment that is missing', JSON.stringify(withheld.today.unmodelled).slice(0, 120));
}

console.log('\n=== migration equivalence on the real published inputs ===');
/* Payment, principal, today's cash and the comparison must still match the
 * expression public/modellers.js ran before the B73 move, copied from
 * 7119401751178272a9277355fe2f297ea2f696d2, at every slider position the
 * page can reach: 91 renewal rates × 21 amortisations × both modes.
 *
 * Equivalence is claimed for the VARIABLE scenario only, and that is the whole
 * point of the blocking finding: the old page applied monthly compounding to
 * every rate the slider could reach, which is right for a variable renewal and
 * wrong for a fixed one. So the variable side must match to the cent, and the
 * fixed side must NOT — a fixed option that produced the same numbers would be
 * a label with no arithmetic behind it.
 *
 * Keep-separate HELOC owed is the exception this repair closes. The historical
 * page compounded the facility as if no cash left chequing. A declared cash
 * minimum is now a payment against that balance; unpaid compound remains the
 * independent upper bound, not the published horizon. */
const m0 = data.mortgage;
const mort0 = data.debts.find(x => x.id === 'mortgage');
const heloc0 = data.debts.find(x => /HELOC/i.test(x.label));
// The page picked the HELOC by matching its LABEL; the engine picks it by the
// `heloc` id, which is the key `projectDebts` and `plan.obligations` already
// use. On the published data those are the same record, and this is the check
// that says so rather than leaving it to be assumed.
ok(heloc0 === data.debts.find(x => x.id === 'heloc'),
  'the label the page matched and the id the engine uses name one record',
  heloc0.label);
ok(data.plan.obligations.filter(o => o.debtId === 'heloc').length === 1,
  'and the plan schedules exactly one charge against it');
function legacyAmortisedPayment(principal, annualPct, years) {
  const i = annualPct / 100 / 12, n = years * 12;
  if (i === 0) return principal / n;
  return principal * i / (1 - Math.pow(1 + i, -n));
}
function legacy(r, years, consolidate) {
  const mortgageNow = mort0.payment * 26 / 12;
  const helocObl0 = data.plan.obligations.find(o => o && o.debtId === 'heloc');
  const helocCash = Number(helocObl0 && helocObl0.cashPayment) > 0
    ? Number(helocObl0.cashPayment)
    : (heloc0.cashPayment != null ? heloc0.cashPayment : heloc0.payment);
  const helocEconomic = heloc0.monthlyInterest != null ? heloc0.monthlyInterest : heloc0.payment;
  const helocCapitalised = heloc0.interestTreatment === 'capitalised';
  const baselineCash = mortgageNow + helocCash;
  const baselineMonthly = baselineCash;
  let payment, totalInterest, principal, helocOwed = 0;
  if (consolidate) {
    principal = mort0.balance + heloc0.balance;
    payment = legacyAmortisedPayment(principal, r, years);
    totalInterest = payment * years * 12 - principal;
  } else {
    principal = mort0.balance;
    payment = legacyAmortisedPayment(principal, r, years) + helocCash;
    const mortgageInterest = (payment - helocCash) * years * 12 - principal;
    const helocRate = heloc0.rate / 100;
    const perYear = 12;
    helocOwed = helocCapitalised
      ? heloc0.balance * Math.pow(1 + helocRate / perYear, perYear * years)
      : heloc0.balance;
    const helocInterest = helocCapitalised
      ? helocOwed - heloc0.balance
      : heloc0.balance * helocRate * years;
    totalInterest = mortgageInterest + helocInterest;
  }
  const delta = payment - baselineMonthly;
  return { payment, totalInterest, principal, helocOwed, delta, mortgageNow,
    helocCash, helocEconomic, baselineCash,
    deltaClass: delta > 0 ? 'neg' : 'pos',
    // What the row read before the move: the sign and the formatted figure.
    deltaText: (delta > 0 ? '+' : '') + appMoney2(delta) };
}
{
  let cases = 0;
  const drift = [];
  const exact = (a, b) => Math.abs(a - b) < 1e-9;
  for (let slider = 300; slider <= 750; slider += 5) {
    for (let years = 10; years <= 30; years++) {
      for (const consolidate of [false, true]) {
        const rate = slider / 100;
        const was = legacy(rate, years, consolidate);
        const now = F.renewal(data.plan, data.debts, { rate, years, consolidate, basis: 'variable' });
        cases++;
        const bad = [];
        if (!exact(was.payment, now.payment)) bad.push('payment');
        if (!exact(was.principal, now.principal)) bad.push('principal');
        if (!exact(was.delta, now.delta)) bad.push('delta');
        if (!exact(was.mortgageNow, now.today.mortgageCash)) bad.push('mortgage today');
        if (!exact(was.helocCash, now.today.helocCash)) bad.push('HELOC cash');
        if (!exact(was.helocEconomic, now.today.helocEconomic)) bad.push('HELOC economic');
        if (!exact(was.baselineCash, now.today.householdCash)) bad.push('household cash');
        // The row was red exactly when the renewal costs more than today.
        if ((was.deltaClass === 'neg') !== (now.direction === 'more')) bad.push('delta direction');
        if (was.deltaText !== (now.delta > 0 ? '+' : '') + appMoney2(now.delta)) bad.push('delta figure');
        if (consolidate) {
          if (!exact(was.helocOwed, now.helocOwed)) bad.push('HELOC owed');
          if (!exact(was.totalInterest, now.interest.total)) bad.push('total interest');
        } else {
          const walked = walkLoan(heloc0.balance, monthlyVariable(heloc0.rate),
            years * 12, was.helocCash);
          if (!near(now.helocOwed, walked.balance, 1e-6)) bad.push('HELOC owed');
          if (!near(now.interest.heloc, walked.interest, 1e-6)) bad.push('HELOC interest');
          if (!(was.helocCash > 0) || !(now.helocOwed < was.helocOwed - 1)) {
            bad.push('HELOC owed below unpaid compound');
          }
          const mortgageInterest = (now.payment - now.today.helocCash) * years * 12 - now.principal;
          if (!near(now.interest.total, mortgageInterest + walked.interest, 1e-6)) {
            bad.push('total interest');
          }
        }
        if (bad.length) drift.push(`${rate}% / ${years}y / ${consolidate ? 'fold' : 'keep'}: ${bad.join(', ')}`);
      }
    }
  }
  ok(cases === 3822, 'every slider position the page can reach is covered', `${cases} cases`);
  ok(drift.length === 0,
    'cash, payment and comparison still match; keep-separate HELOC owed is the cash-applied walk',
    drift.slice(0, 3).join(' | ') || 'no drift');
}

console.log('\n=== the published renewal, at the settings the page opens on ===');
/* The two answers the household actually sees first. Independently confirmed:
 * the mortgage walk clears, and the HELOC is a charge-then-cash walk of 216
 * months, not unpaid compounding. */
{
  const rate = Math.round(mort0.rate * 100) / 100;
  const years = Math.round(m0.remainingYears);
  ok(rate === 3.64 && years === 18,
    'the sliders open at the mortgage\'s own rate and remaining amortisation',
    `${rate}% / ${years} years`);
  const keep = F.renewal(data.plan, data.debts, { rate, years, consolidate: false, basis: 'variable' });
  const fold = F.renewal(data.plan, data.debts, { rate, years, consolidate: true, basis: 'variable' });
  const helocLive = data.debts.find(x => x.id === 'heloc');
  const unpaidHorizon = growMonthly(helocLive.balance, 4.9, 216);
  const cashWalk = walkLoan(helocLive.balance, monthlyVariable(4.9), 216, keep.today.helocCash);
  ok(near(keep.today.mortgageCash, 3466.67, 0.005)
      && near(keep.today.helocCash, 814.18)
      && near(keep.today.householdCash, 3466.67 + 814.18, 0.005),
    'today is the mortgage plus the encoded HELOC cash minimum', money(keep.today.householdCash));
  ok(keep.direction === 'less' && keep.payment < keep.today.householdCash,
    'keeping them apart renews for less than today', money(keep.payment));
  ok(keep.helocOwed > 0,
    'and still leaves a HELOC balance after 18 years', money(keep.helocOwed));
  ok(near(keep.helocOwed, cashWalk.balance, 0.005),
    'which is the independent charge-then-cash walk of 216 months', money(keep.helocOwed));
  ok(near(keep.interest.heloc, cashWalk.interest, 0.005),
    'and the interest is the gross charged on that walk', money(keep.interest.heloc));
  ok(keep.helocOwed < unpaidHorizon,
    'so it is strictly below unpaid compounding',
    `${money(keep.helocOwed)} < ${money(unpaidHorizon)}`);
  ok(Math.abs(walkLoan(keep.principal, monthlyVariable(rate), years * 12,
    keep.payment - keep.today.helocCash).balance) < 0.000001,
    'the mortgage walk clears at the mortgage portion of the keep-apart payment');
  ok(fold.direction === 'more' && fold.payment > keep.today.householdCash,
    'folding the HELOC in costs more than today', money(fold.payment));
  ok(keep.interest.total > fold.interest.total,
    'and saves interest over the 18 years',
    money(keep.interest.total - fold.interest.total));
  ok(fold.helocOwed === 0, 'with nothing left owing on the HELOC');

  /* The same real balance priced as a FIXED renewal — the quote TD's April 2027
   * offer letter will actually carry. This is the figure the household could
   * not previously get, and the size of the error it was reading instead. */
  const keepFixed = F.renewal(data.plan, data.debts,
    { rate, years, consolidate: false, basis: 'fixed' });
  ok(Math.abs(walkLoan(keepFixed.principal, monthlyFixed(rate), years * 12,
    keepFixed.payment - keepFixed.today.helocCash).balance) < 0.000001,
  'a fixed renewal on the real balance clears its own amortisation walk');
  ok(keepFixed.payment < keep.payment,
    'and costs less each month than the variable pricing the page used to apply',
    `${money(keepFixed.payment)} vs ${money(keep.payment)}`);
  ok(keep.payment - keepFixed.payment > 0,
    'by a positive monthly amount at the opening 3.64%',
    money(keep.payment - keepFixed.payment));
  ok(near((keep.payment - keepFixed.payment) * years * 12,
    (keep.payment - keepFixed.payment) * 216, 0.005),
    'which is that monthly difference times 18 years',
    money((keep.payment - keepFixed.payment) * years * 12));
  ok(keepFixed.helocOwed === keep.helocOwed,
    'while the HELOC beside it is untouched by the mortgage\'s convention',
    money(keepFixed.helocOwed));
}

console.log('\n' + '═'.repeat(60));
if (failures) {
  console.log(`FAILED — ${failures} renewal check(s)`);
  process.exit(1);
}
console.log('THE RENEWAL AUTHORITY IS THE ENGINE\'S, AND IT RECONCILES');
