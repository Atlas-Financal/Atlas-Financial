'use strict';
/* Focused proof for the payoff modeller. `node test/test-payoff.js`
 *
 * "If we paid $X a month, when is this gone and what does it cost?" is the
 * question a household acts on fastest — it is one slider and four preset
 * buttons, and the answer is a number of years. Until this move
 * `public/modellers.js` and `public/app.js` answered it themselves: `payoff()`
 * in the shared PAGE core ran the projection, `solveFor()` ran the annuity
 * behind "clear in 5 / 3 / 1 years", and `bounds()` picked the slider's floor
 * from an interest charge it computed itself. None of it was reachable from the
 * node suite. That is `B73`, and this is the last recorded instance of it.
 *
 * Six kinds of check, and they prove different things:
 *
 *   0. THE CONVENTION, per debt type, against evidence from outside this code.
 *      A rate is meaningless without the convention it is charged under, and the
 *      page applied ONE to every debt: `annual × 30 / 365`, which charges twelve
 *      30-day months — 360 days — for every 365 that pass. The prime-linked
 *      convention is checked against TD's own stated remaining amortisation on
 *      this household's mortgage.
 *   0a. AND HOW CLOSELY IT IS MODELLED, which is a separate question the first
 *      draft of this file ran together with the first. A card charges a daily
 *      rate over the days in each statement cycle; a monthly model prices the
 *      AVERAGE cycle. That is exact over a year, because consecutive cycles tile
 *      the calendar by construction, and approximate for any single period. It
 *      is benchmarked against the published TD/MBNA 30-day form, bounded across
 *      28-to-32-day cycles, and the multi-period effect is measured by walking a
 *      real varying-cycle schedule from every possible starting month.
 *   1. HAND-COMPUTED CASES. Balances small enough to walk on paper, with the
 *      expected figures written as literals.
 *   2. INDEPENDENT DERIVATION. Every projection is confirmed a second time by
 *      methods the engine does not use: a month-by-month balance walk that has
 *      to land on zero, and the annuity's present-value identity, which is a
 *      different arrangement of the algebra from the engine's logarithm.
 *   3. PROPAGATION. This is one coupled model, not a payoff calculator with a
 *      private copy of the debt picture. Move the balance, the pending charges,
 *      the rate or the obligation, and every payoff conclusion moves with it.
 *   4. MUTATION. Each material formula and branch is broken on purpose in the
 *      engine source, and the answer has to change.
 *   5. MIGRATION EQUIVALENCE. The exact expressions the page ran before this
 *      move, against the real published inputs, at every slider position the
 *      page can reach. They do NOT all match, and the three reasons are proved
 *      one at a time: restoring the old rate convention, the old balance rule
 *      and the old minimum to the engine reproduces the old published figures to
 *      the cent, which is what makes those three the whole of the change.
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
// A cent is the unit a household reads. Two derivations of one figure by
// different methods do not agree bit for bit, and demanding that they did would
// be testing float representation rather than money.
const CENT = 0.005;
const near = (a, b, tol = CENT) => Math.abs(a - b) <= tol;

/* --------------------------------------------------------- independent maths */
/* Neither of these is the engine's method. `walk` steps a real repayment
 * schedule — charge the period's interest, take the payment, repeat — and
 * reports where the balance lands and what interest was actually charged. A
 * payoff figure is right exactly when that walk ends on zero. `pv` is the
 * annuity's present-value identity, `B = P(1 − (1+i)^−n) / i`, which is the
 * same relationship the engine solves rearranged so that nothing about the
 * engine's logarithm is reused. */
function walk(balance, monthlyRate, payment, months) {
  let b = balance, interest = 0;
  for (let k = 0; k < months; k++) {
    const charge = b * monthlyRate;
    interest += charge;
    b = b + charge - payment;
  }
  return { balance: b, interest };
}
const pv = (payment, monthlyRate, months) => monthlyRate === 0
  ? payment * months
  : payment * (1 - Math.pow(1 + monthlyRate, -months)) / monthlyRate;

/* ----------------------------------------------------------------- fixtures */
/* Synthetic debts go in through the real entry point, so the wiring is under
 * test alongside the arithmetic. A payoff figure derived from a debt object
 * hand-built in this file would prove the arithmetic and nothing about whether
 * the modeller can reach it. */
function debt(overrides, obligations) {
  const record = Object.assign({
    id: 'x', label: 'Test debt', structure: 'Test',
    balance: 1000, pending: 0, rate: 12, rateConvention: 'variable',
  }, overrides);
  const plan = { obligations: obligations || [] };
  const [d] = F.payoffDebts(plan, [record]);
  return d;
}

console.log('\n=== 0. the convention each debt type is actually charged under ===');

/* CARDS. `docs/ACCOUNT_FACTS.md` reconciles the TD Cash Back Visa against its
 * own statements: interest is the AVERAGE DAILY BALANCE times the annual rate
 * times the DAYS IN THE CYCLE over 365. These five rows are transcribed from
 * that table, and the day counts are recovered from them rather than assumed —
 * if the convention in the engine were a different one, these would not
 * reproduce. The point of the exercise is the last line: consecutive cycles
 * TILE the calendar, so a year is 365 charged days and not 360. */
const CASHBACK_RATE = 0.2699;
const CYCLES = [                                    // from docs/ACCOUNT_FACTS.md
  { close: '2026-04-08', opens: '2026-03-10', avg: 4985.10, implied: 110.59, days: 30 },
  { close: '2026-05-07', opens: '2026-04-09', avg: 5118.52, implied: 109.76, days: 29 },
  { close: '2026-06-08', opens: '2026-05-08', avg: 3179.37, implied: 75.23, days: 32 },
  { close: '2026-07-07', opens: '2026-06-09', avg: 4263.60, implied: 91.43, days: 29 },
  { close: '2026-08-07', opens: '2026-07-08', avg: 5119.61, implied: 117.36, days: 31 },
];
const asDay = iso => Date.parse(iso + 'T00:00:00Z') / 86400000;
for (const c of CYCLES) {
  ok(near(c.avg * CASHBACK_RATE * c.days / 365, c.implied),
    `the ${c.close} statement's charge is the daily rate over ${c.days} days`,
    money(c.avg * CASHBACK_RATE * c.days / 365));
  ok(asDay(c.close) - asDay(c.opens) + 1 === c.days,
    'and that many days is exactly how long the cycle ran');
}
for (let i = 1; i < CYCLES.length; i++) {
  ok(asDay(CYCLES[i].opens) - asDay(CYCLES[i - 1].close) === 1,
    `the ${CYCLES[i].close} cycle opens the day after the ${CYCLES[i - 1].close} one closes`);
}
const tiled = CYCLES.reduce((s, c) => s + c.days, 0);
ok(tiled === asDay(CYCLES[4].close) - asDay(CYCLES[0].opens) + 1 && tiled === 151,
  'so five cycles cover 151 days with no gap and no overlap', String(tiled));

/* Which settles the YEAR, and only the year. Cycles tile it, so twelve of them
 * are 365 charged days and the year's interest is the whole annual rate.
 *
 * The tiling is STRUCTURAL, not an average of the five above: a cycle opens the
 * day after the last one closes, so consecutive cycles span the calendar
 * whatever the individual lengths are. The five reconciled cycles demonstrate
 * the property; they do not establish it, and an earlier draft of this file
 * leaned on them as though they did. Cycles close on a fixed day of the month,
 * so their lengths are the calendar's. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
ok(MONTH_DAYS.reduce((s, d) => s + d, 0) === 365,
  'twelve consecutive cycles span 365 days because they tile the calendar',
  String(MONTH_DAYS.reduce((s, d) => s + d, 0)));

const CARD = F.payoffDebts({ obligations: [] },
  [{ id: 'c', label: 'c', balance: 10000, rate: 26.99, rateConvention: 'card' }])[0];
ok(near(CARD.monthlyRate * 12, 0.2699, 1e-12),
  'so twelve card periods charge the full annual rate, not 360/365 of it',
  (CARD.monthlyRate * 12 * 100).toFixed(4) + '%');
ok(near(CARD.monthlyRate, 0.2699 / 365 * (365 / 12), 1e-15),
  'because one period is the daily rate over the days an AVERAGE cycle runs');
const OLD_CARD_RATE = 0.2699 * 30 / 365;
ok(OLD_CARD_RATE < CARD.monthlyRate
  && near(OLD_CARD_RATE / CARD.monthlyRate, 360 / 365, 1e-12),
'the page charged 360 days a year, which is 98.63% of what the card charges',
`${(OLD_CARD_RATE / CARD.monthlyRate * 100).toFixed(2)}%`);

// The real debt list, read once and shared from here down.
const REAL = F.payoffDebts(data.plan, data.debts);
const byId = Object.fromEntries(REAL.map(d => [d.id, d]));

console.log('\n=== 0a. the card rate is an AVERAGE, and says so ===');

/* Raised as a blocking finding by the required review on `6707f7e`, and it was
 * right: a monthly period is not a card's charging period, and an earlier draft
 * of this engine claimed it was. A card charges `annual/365 x the days in THIS
 * cycle`, and this model does not know which cycle is next. It prices the
 * average one — exact over a year, approximate for any single period — and the
 * page now publishes the band rather than the point alone.
 *
 * The benchmark is the reviewer's own, and it is the published TD/MBNA form:
 * the daily rate over an actual 30-day cycle. Written as a literal. */
ok(near(1000 * 0.2199 * 30 / 365, 18.0740, 0.0001),
  'a 30-day cycle on $1,000 at 21.99% charges $18.07 — the published daily-rate form',
  (1000 * 0.2199 * 30 / 365).toFixed(4));
ok(near(1000 * 0.2199 / 12, 18.3250, 0.0001),
  'and the monthly-equivalent this model uses charges $18.33 for that same period',
  (1000 * 0.2199 / 12).toFixed(4));
ok(near((0.2199 / 12) / (0.2199 * 30 / 365), 1.0139, 0.0001),
  'so against a 30-day cycle it runs 1.39% high — an approximation, not the convention',
  (((0.2199 / 12) / (0.2199 * 30 / 365) - 1) * 100).toFixed(2) + '%');

/* The full single-period band, at the extremes a real cycle reaches. Literals,
 * and the engine has to publish the same two numbers. */
const BAND_CASES = [[28, 16.8690, 8.63], [29, 17.4715, 4.89], [30, 18.0740, 1.39],
  [31, 18.6764, -1.88], [32, 19.2789, -4.95]];
for (const [days, exact, offPct] of BAND_CASES) {
  ok(near(1000 * 0.2199 * days / 365, exact, 0.0001)
    && near(((0.2199 / 12) / (0.2199 * days / 365) - 1) * 100, offPct, 0.01),
  `  a ${days}-day cycle charges ${money(exact)}, and the monthly figure is ${offPct > 0 ? '+' : ''}${offPct}% against it`);
}
const banded = byId.triangle;
ok(banded.precision === 'monthly-equivalent' && !!banded.interestOnlyBand,
  'a card debt declares its rate an approximation and carries a band');
ok(byId.mortgage.precision === 'exact' && byId.mortgage.interestOnlyBand === null
  && byId.heloc.precision === 'exact' && byId.heloc.interestOnlyBand === null,
'a prime-linked facility is charged monthly for real, so it carries none');
ok(near(banded.interestOnlyBand.low, banded.balance * 0.2199 * 28 / 365)
  && near(banded.interestOnlyBand.high, banded.balance * 0.2199 * 32 / 365),
'the published band is the daily rate over the shortest and longest real cycle',
`${money(banded.interestOnlyBand.low)} – ${money(banded.interestOnlyBand.high)}`);
ok(banded.interestOnlyBand.low < banded.interestOnly
  && banded.interestOnly < banded.interestOnlyBand.high,
'and the figure the page leads with sits inside its own band');

/* What that uncertainty does to the MULTI-period figures, which is the reviewer's
 * other question and a different answer. Cycle length redistributes interest
 * between periods rather than accumulating, because the cycles tile the year —
 * so this walks a REAL varying-cycle schedule (charge `annual/365 x this
 * month's days`, take the payment, repeat) against the level-monthly model,
 * from every one of the twelve possible starting months, and bounds the worst
 * case. Nothing here uses the engine's method. */
function walkVaryingCycles(balance, annualPct, payment, startMonth) {
  let b = balance, interest = 0, periods = 0, k = startMonth;
  while (b > 0) {
    const charge = b * (annualPct / 100) / 365 * MONTH_DAYS[k % 12];
    if (payment <= charge) return { months: Infinity, interest: Infinity };
    interest += charge; b += charge;
    if (b <= payment) { periods += b / payment; b = 0; break; }
    b -= payment; periods += 1; k += 1;
    if (periods > 6000) return { months: Infinity, interest: Infinity };
  }
  return { months: periods, interest };
}
let worstMonths = 0, worstInterestPct = 0;
for (const payment of [253.57, 300, 400, 600, 1000]) {
  const level = F.payoffModel(byId.triangle, payment);
  for (let start = 0; start < 12; start++) {
    const varied = walkVaryingCycles(banded.balance, 21.99, payment, start);
    worstMonths = Math.max(worstMonths, Math.abs(varied.months - level.months));
    worstInterestPct = Math.max(worstInterestPct,
      Math.abs(varied.interest - level.totalInterest) / level.totalInterest * 100);
  }
}
ok(worstMonths < 1.9 && worstInterestPct < 1.3,
  'across every starting month and five payments, varying cycles move the payoff by under 1.9 months and 1.3% of interest',
  `${worstMonths.toFixed(2)} months, ${worstInterestPct.toFixed(2)}%`);
ok(worstMonths > 0.001,
  'and it is a real deviation, not zero — the approximation is bounded, not absent',
  worstMonths.toFixed(3) + ' months');

/* PRIME-LINKED FACILITIES. The mortgage and the HELOC are quoted compounded
 * monthly, which is `RATE_BASIS.variable` — the same table the renewal prices a
 * variable quote on. Reused rather than restated, so a correction to one is a
 * correction to both; the check is that they are the same function, and the
 * benchmark is TD's own figure for this household's mortgage. */
ok(near(byId.mortgage.monthlyRate, 0.0364 / 12, 1e-15)
  && near(byId.heloc.monthlyRate, 0.049 / 12, 1e-15),
'a prime-linked facility is priced compounded monthly');
ok(byId.mortgage.convention === 'variable' && byId.heloc.convention === 'variable'
  && ['triangle', 'cashback', 'mbna', 'tdcc', 'travelvisa'].every(id => byId[id].convention === 'card'),
'each debt carries the convention its own record declares',
REAL.map(d => `${d.id}=${d.convention}`).join(' '));
// Not interchangeable in general: a FIXED Canadian quote is a third convention
// and is deliberately absent from the payoff table, because no debt here is on
// one. An undeclared convention throws rather than falling back to a guess.
let threw = null;
try {
  F.payoffDebts({ obligations: [] },
    [{ id: 'q', label: 'q', balance: 100, rate: 5, rateConvention: 'fixed' }]);
} catch (e) { threw = e.message; }
ok(threw && /rate convention/.test(threw),
  'a debt declaring a convention the payoff table has no entry for throws');
threw = null;
try {
  F.payoffDebts({ obligations: [] }, [{ id: 'q', label: 'q', balance: 100, rate: 5 }]);
} catch (e) { threw = e.message; }
ok(threw && /rate convention/.test(threw),
  'and so does one declaring none at all — it is never assumed');

/* TD's own benchmark. TD states 17 years 9 months 4 days remaining on this
 * mortgage (`docs/MORTGAGE_HELOC_DEEP_DIVE.md`), independently of anything here.
 * The modeller, run on the canonical debt record and the canonical obligation,
 * has to land on it. Under the page's old convention and old minimum it
 * reported that the same mortgage would NEVER clear. */
const TD_REMAINING_MONTHS = 17 * 12 + 9 + 4 / 30.44;
const mortgageAtMinimum = F.payoffModel(byId.mortgage, byId.mortgage.minimum);
ok(mortgageAtMinimum.clears
  && Math.abs(mortgageAtMinimum.months - TD_REMAINING_MONTHS) < 2,
'the mortgage clears within two months of TD\'s own stated remaining amortisation',
`${mortgageAtMinimum.months.toFixed(2)} months against TD's ${TD_REMAINING_MONTHS.toFixed(2)}`);
// The old page said otherwise, and this is the figure that changed most.
const OLD_MORTGAGE_INTEREST = 546026.58 * (0.0364 * 30 / 365);
ok(OLD_MORTGAGE_INTEREST > 1600,
  'the page priced its interest above the $1,600 it read as the payment',
  money(OLD_MORTGAGE_INTEREST));

console.log('\n=== 1. hand-computed cases ===');

/* $1,000 at 12% compounded monthly is 1% a period, and $500 a month clears it
 * inside three. Every figure below is arithmetic on paper. */
const HAND = debt({ balance: 1000, rate: 12, rateConvention: 'variable' });
ok(near(HAND.monthlyRate, 0.01, 1e-15) && near(HAND.interestOnly, 10),
  'a $1,000 balance at 12% carries $10.00 of interest in its first month',
  money(HAND.interestOnly));
const hand = F.payoffModel(HAND, 500);
// Month 1: 1000 + 10 = 1010, less 500 → 510.00.
// Month 2:  510 + 5.10 = 515.10, less 500 →  15.10.
const w1 = walk(1000, 0.01, 500, 1), w2 = walk(1000, 0.01, 500, 2);
ok(near(w1.balance, 510) && near(w2.balance, 15.10),
  'and walks 1,000 → 510.00 → 15.10 on a $500 payment',
  `${money(w1.balance)} → ${money(w2.balance)}`);
ok(hand.clears && hand.months > 2 && hand.months < 3,
  'so it clears inside the third month', hand.months.toFixed(5));
ok(near(pv(500, 0.01, hand.months), 1000),
  'the reported month count satisfies the annuity identity independently',
  money(pv(500, 0.01, hand.months)));
ok(near(hand.totalPaid, hand.months * 500)
  && near(hand.totalInterest, hand.months * 500 - 1000),
'total paid and total interest are the payments made, less the balance cleared',
`${money(hand.totalPaid)} / ${money(hand.totalInterest)}`);

/* An exact-integer case, so the walk can land on zero rather than near it. */
const EXACT = debt({ balance: 1000, rate: 12, rateConvention: 'variable' });
const exactPayment = F.paymentForMonths(EXACT, 12);
const exactWalk = walk(1000, 0.01, exactPayment, 12);
ok(near(exactWalk.balance, 0),
  'the payment that clears $1,000 in 12 months walks the balance to exactly zero',
  `${money(exactPayment)} → ${money(exactWalk.balance)}`);
ok(near(F.payoffModel(EXACT, exactPayment).months, 12, 1e-9),
  'and the projection agrees it takes 12 months');

console.log('\n=== 2. the interest threshold, and what it refuses to claim ===');

const THRESH = debt({ balance: 1000, rate: 12, rateConvention: 'variable' });
const below = F.payoffModel(THRESH, 9.99);
const exactly = F.payoffModel(THRESH, 10);
const above = F.payoffModel(THRESH, 10.01);
ok(!below.clears && near(below.shortfall, 0.01),
  'a payment below the interest charge does not clear, and the balance grows',
  money(below.shortfall));
ok(!exactly.clears && near(exactly.shortfall, 0),
  'a payment EXACTLY at the interest charge does not clear either — it stands still',
  money(exactly.shortfall));
ok(near(walk(1000, 0.01, 10, 600).balance, 1000),
  'proved by walking it 600 months and finding the same $1,000 owing',
  money(walk(1000, 0.01, 10, 600).balance));
ok(above.clears && above.months > 690 && above.months < 695,
  'and a cent above it does clear, in 694 months', above.months.toFixed(0) + ' months');
ok(walk(1000, 0.01, 10.01, 694).balance > 0 && walk(1000, 0.01, 10.01, 695).balance < 0,
  'confirmed by the walk crossing zero in that month', money(walk(1000, 0.01, 10.01, 694).balance));
ok(below.months === undefined && below.totalInterest === undefined,
  'a payment that never clears reports no payoff date and no total');

console.log('\n=== 3. more money is less time and less interest ===');

const LADDER = debt({ balance: 13497, rate: 21.99, rateConvention: 'card' });
let previous = null;
for (const P of [260, 300, 400, 600, 1000]) {
  const r = F.payoffModel(LADDER, P);
  const walked = walk(LADDER.balance, LADDER.monthlyRate, P, Math.floor(r.months));
  ok(r.clears
    && (!previous || (r.months < previous.months && r.totalInterest < previous.totalInterest)),
  `at ${money(P)} a month it clears in ${r.months.toFixed(1)} months for ${money(r.totalInterest)} of interest`);
  ok(walked.balance > 0 && walked.balance < P,
    '  and a month-by-month walk leaves less than one payment outstanding',
    money(walked.balance));
  ok(near(pv(P, LADDER.monthlyRate, r.months), LADDER.balance),
    '  with the month count satisfying the annuity identity');
  previous = r;
}

console.log('\n=== 4. the payment that clears a debt in a target ===');

/* $10,000 at 12% compounded monthly, cleared over 60, 36 and 12 months. Each
 * expected payment is a literal, and each is confirmed by walking that many
 * months and landing on zero — not by asking the engine what it thinks. */
const TARGET = debt({ balance: 10000, rate: 12, rateConvention: 'variable' });
for (const [months, expected] of [[60, 222.44], [36, 332.14], [12, 888.49]]) {
  const p = F.paymentForMonths(TARGET, months);
  ok(near(p, expected, 0.005),
    `clearing $10,000 at 12% in ${months} months costs ${money(expected)} a month`,
    money(p));
  ok(near(walk(10000, 0.01, p, months).balance, 0),
    `  and ${months} of those payments walk the balance to zero`,
    money(walk(10000, 0.01, p, months).balance));
  ok(near(F.payoffModel(TARGET, p).months, months, 1e-9),
    '  and the projection returns that same horizon');
}
// The presets the household actually clicks are the same solve, wired up.
const presets = Object.fromEntries(TARGET.presets.map(p => [p.id, p.amount]));
ok(near(presets['clear-60'], F.paymentForMonths(TARGET, 60))
  && near(presets['clear-36'], F.paymentForMonths(TARGET, 36))
  && near(presets['clear-12'], F.paymentForMonths(TARGET, 12)),
'the 5 / 3 / 1-year presets are that solve, not a second copy of it');

console.log('\n=== 5. the zero-rate boundary ===');

const FREE = debt({ balance: 1200, rate: 0, rateConvention: 'card' });
ok(FREE.monthlyRate === 0 && FREE.interestOnly === 0,
  'a 0% debt carries no interest');
const free = F.payoffModel(FREE, 100);
ok(free.clears && near(free.months, 12) && near(free.totalInterest, 0)
  && near(free.totalPaid, 1200),
'so $1,200 at $100 a month is exactly 12 months and $0.00 of interest',
`${free.months} months, ${money(free.totalInterest)}`);
ok(near(F.paymentForMonths(FREE, 12), 100) && near(F.paymentForMonths(FREE, 48), 25),
  'and clearing it in a target is the balance spread evenly',
  money(F.paymentForMonths(FREE, 48)));
ok(near(walk(1200, 0, 100, 12).balance, 0),
  'confirmed by the walk, which lands on zero without an annuity at all');
// Zero is a boundary, not an error: the annuity formula divides by the rate.
ok(isFinite(free.months) && isFinite(F.paymentForMonths(FREE, 12)),
  'neither answer is NaN or Infinity, which is what the naive formula returns');

console.log('\n=== 6. the debt picture propagates ===');

/* One coupled model. A change to an authoritative debt fact has to reach every
 * payoff conclusion that depends on it — otherwise this is a calculator with a
 * private copy of the picture, which is the failure the engine exists to
 * prevent. */
const BASE = debt({ balance: 10000, rate: 12, rateConvention: 'variable' });
const BIGGER = debt({ balance: 12000, rate: 12, rateConvention: 'variable' });
ok(BIGGER.interestOnly > BASE.interestOnly
  && F.payoffModel(BIGGER, 500).months > F.payoffModel(BASE, 500).months
  && F.payoffModel(BIGGER, 500).totalInterest > F.payoffModel(BASE, 500).totalInterest
  && F.paymentForMonths(BIGGER, 36) > F.paymentForMonths(BASE, 36)
  && BIGGER.bounds.min > BASE.bounds.min,
'a larger opening balance moves interest, months, total and the slider floor');

/* Pending charges are already incurred, so they are part of what is owed today.
 * `openingBalance` is the rule the debt walk opens on, headroom is measured
 * against and the renewal compounds from — and now this. The test is exact:
 * $200 of pending has to behave as $200 of balance, not merely move the answer
 * in the right direction. */
const PENDING = debt({ balance: 9800, pending: 200, rate: 12, rateConvention: 'variable' });
ok(PENDING.balance === 10000 && PENDING.posted === 9800 && PENDING.pending === 200,
  'a pending charge is part of what the payoff answers for',
  money(PENDING.balance));
ok(near(F.payoffModel(PENDING, 500).months, F.payoffModel(BASE, 500).months, 1e-12)
  && near(F.payoffModel(PENDING, 500).totalInterest, F.payoffModel(BASE, 500).totalInterest, 1e-9),
'and it behaves exactly as the same amount of posted balance does');
// The two real cards that carry one.
const mbnaRec = data.debts.find(x => x.id === 'mbna');
const tvRec = data.debts.find(x => x.id === 'travelvisa');
ok(near(byId.mbna.balance, mbnaRec.balance + (mbnaRec.pending || 0))
  && near(byId.travelvisa.balance, tvRec.balance + (tvRec.pending || 0)),
  'the two cards with pending charges are modelled on what they owe today',
  `${money(byId.mbna.balance)} / ${money(byId.travelvisa.balance)}`);

/* The rate. */
const DEARER = debt({ balance: 10000, rate: 18, rateConvention: 'variable' });
ok(near(DEARER.interestOnly, 150) && DEARER.interestOnly > BASE.interestOnly
  && F.payoffModel(DEARER, 500).totalInterest > F.payoffModel(BASE, 500).totalInterest
  && F.payoffModel(DEARER, 500).months > F.payoffModel(BASE, 500).months
  && F.paymentForMonths(DEARER, 36) > F.paymentForMonths(BASE, 36),
'a higher authoritative rate costs more interest and takes longer to clear',
money(DEARER.interestOnly));

/* The minimum, which is NOT a field on the debt record. It is the recurring
 * cash the plan schedules against that debt, annualised — the same rule the
 * renewal compares against. This is where the page was most wrong. */
const CASH_MIN = debt({ balance: 10000, rate: 12 },
  [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 250 }]);
const BIWEEKLY_MIN = debt({ balance: 10000, rate: 12 },
  [{ id: 'o', debtId: 'x', frequency: 'biweekly', amount: 250 }]);
const NONCASH_MIN = debt({ balance: 10000, rate: 12 },
  [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 250, nonCash: true }]);
ok(near(CASH_MIN.minimum, 250) && CASH_MIN.minimumId === 'cash',
  'a monthly obligation is the minimum as it stands', money(CASH_MIN.minimum));
ok(near(BIWEEKLY_MIN.minimum, 250 * 26 / 12) && near(BIWEEKLY_MIN.minimum, 541.6666666667, 1e-6),
  'a bi-weekly one is annualised at 26 payments, not read as monthly',
  money(BIWEEKLY_MIN.minimum));
ok(NONCASH_MIN.minimum === 0 && NONCASH_MIN.minimumId === 'none',
  'and a capitalised charge with no cashPayment is no minimum at all',
  money(NONCASH_MIN.minimum));
const NONCASH_WITH_CASH = debt({ balance: 10000, rate: 12 },
  [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 250, nonCash: true,
    cashPayment: 80, cashConfidence: 'estimated' }]);
ok(near(NONCASH_WITH_CASH.minimum, 80) && NONCASH_WITH_CASH.minimumId === 'cash'
  && NONCASH_WITH_CASH.minimumConfidence === 'estimated',
  'a capitalising obligation with cashPayment is that cash, not the capitalise amount',
  money(NONCASH_WITH_CASH.minimum));
const ONE_OFF = debt({ balance: 10000, rate: 12 }, [
  { id: 'monthly-min', debtId: 'x', frequency: 'monthly', amount: 250 },
  { id: 'september-spike', debtId: 'x', frequency: 'once', date: '2026-09-01', amount: 900 },
]);
ok(near(ONE_OFF.minimum, 250) && ONE_OFF.unmodelled.join() === 'september-spike',
  'an obligation with no monthly equivalent is NAMED rather than swallowed',
  ONE_OFF.unmodelled.join());

/* The three real debts whose minimum the old page got wrong. */
ok(near(byId.heloc.minimum, 814.18) && byId.heloc.minimumId === 'cash'
  && byId.heloc.minimumConfidence === 'estimated',
  'the HELOC cash minimum is the encoded cashPayment, not the capitalise row',
  money(byId.heloc.minimum));
ok(near(byId.mortgage.minimum, 1600 * 26 / 12) && near(byId.mortgage.minimum, 3466.6666666667, 1e-6),
  'the mortgage minimum is its bi-weekly payment annualised, not $1,600 read as monthly',
  money(byId.mortgage.minimum));
ok(near(byId.cashback.minimum, 170) && byId.cashback.unmodelled.join() === '',
  'the Cash Back Visa minimum is its recurring level; the paid September spike is gone',
  `${money(byId.cashback.minimum)} + [${byId.cashback.unmodelled}]`);

/* And how well that minimum is KNOWN travels with it. Most of these are a
 * future statement amount held at today's level, and every payoff figure on the
 * page is measured against one — an estimate reaching a decision surface
 * untagged is the defect `CLAUDE.md` names outright. Raised by the advisory
 * review on this head; it shares this outcome's authority boundary, because the
 * minimum is a thing this move made the payoff authority own. */
ok(debt({ balance: 10000, rate: 12 },
  [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 250, confidence: 'confirmed' }])
  .minimumConfidence === 'confirmed',
'a minimum from a confirmed obligation is confirmed');
ok(debt({ balance: 10000, rate: 12 },
  [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 250, confidence: 'estimated' }])
  .minimumConfidence === 'estimated',
'and one from an estimated obligation is estimated');
// Weakest wins: one estimated component makes the whole figure estimated.
ok(debt({ balance: 10000, rate: 12 }, [
  { id: 'a', debtId: 'x', frequency: 'monthly', amount: 250, confidence: 'confirmed' },
  { id: 'b', debtId: 'x', frequency: 'monthly', amount: 50, confidence: 'estimated' },
]).minimumConfidence === 'estimated',
'a minimum built from both is estimated — the weaker input decides');
// Fail-safe. An unrecognised or missing confidence is NOT a settled fact.
for (const [label, value] of [['a missing', undefined], ['an unrecognised', 'planned']]) {
  ok(debt({ balance: 10000, rate: 12 },
    [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 250, confidence: value }])
    .minimumConfidence === 'estimated',
  `${label} confidence reads as estimated rather than confirmed`);
}
// Only what actually contributed tags the figure, and nothing tags no figure.
ok(ONE_OFF.minimumConfidence === 'estimated'
  && debt({ balance: 10000, rate: 12 }, [
    { id: 'monthly-min', debtId: 'x', frequency: 'monthly', amount: 250, confidence: 'confirmed' },
    { id: 'spike', debtId: 'x', frequency: 'once', date: '2026-09-01', amount: 900, confidence: 'estimated' },
  ]).minimumConfidence === 'confirmed',
'an obligation that contributed nothing to the figure does not tag it');
ok(NONCASH_MIN.minimumConfidence === null,
  'and where nothing contributed there is no figure to tag');
// The real debt list, against `data.json`'s own declarations.
ok(byId.mortgage.minimumConfidence === 'confirmed'
  && ['heloc', 'triangle', 'cashback', 'mbna', 'tdcc', 'travelvisa']
    .every(id => byId[id].minimumConfidence === 'estimated'),
'six of the seven published minimums are estimated, and say so',
REAL.map(d => `${d.id}=${d.minimumConfidence}`).join(' '));
// Each one agrees with the obligation it came from, rather than with a guess.
for (const d of REAL) {
  const counted = data.plan.obligations.filter(o => {
    if (!o || o.debtId !== d.id) return false;
    if (!(o.frequency === 'monthly' || o.frequency === 'biweekly')) return false;
    if (o.nonCash) return (Number(o.cashPayment) || 0) > 0;
    return true;
  }).map(o => o.nonCash
    ? { confidence: o.cashConfidence || o.confidence }
    : o);
  ok(d.minimumConfidence === (counted.length
    ? (counted.every(o => o.confidence === 'confirmed') ? 'confirmed' : 'estimated')
    : null),
  `  ${d.id}'s tag is the one its own obligations declare`);
}

/* And the comparison the household reads off that minimum. */
const VS = debt({ balance: 10000, rate: 12 },
  [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 250 }]);
const atMin = F.payoffModel(VS, 250), atMore = F.payoffModel(VS, 500);
ok(atMore.versusMinimum
  && near(atMore.versusMinimum.interestSaved, atMin.totalInterest - atMore.totalInterest)
  && near(atMore.versusMinimum.monthsSooner, atMin.months - atMore.months),
'paying more than the minimum reports what it saves and how much sooner it clears',
money(atMore.versusMinimum.interestSaved));
ok(F.payoffModel(VS, 250).versusMinimum === null,
  'paying the minimum reports no saving against itself');
ok(F.payoffModel(NONCASH_MIN, 500).versusMinimum === null,
  'and a debt with no cash minimum has nothing to compare against');
ok(F.payoffModel(debt({ balance: 10000, rate: 12 },
  [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 50 }]), 500).versusMinimum === null,
'nor does one whose minimum never clears — a saving against infinity is not a figure');

console.log('\n=== 7. the slider floor is a financial choice, not a widget default ===');

const B = debt({ balance: 10000, rate: 12, rateConvention: 'variable' });
ok(B.bounds.min === Math.ceil(B.interestOnly * 0.5) && B.bounds.min === 50,
  'the floor is half the first period\'s interest, so the control can show a growing balance',
  String(B.bounds.min));
ok(!F.payoffModel(B, B.bounds.min).clears,
  'and at the floor the debt provably does not clear');
ok(B.bounds.max > B.bounds.min && B.bounds.max >= Math.ceil(B.balance / 12),
  'the ceiling clears it inside a year', String(B.bounds.max));
ok(CASH_MIN.bounds.start === 250,
  'the control opens on what the household already pays where that is a real payment',
  String(CASH_MIN.bounds.start));
ok(NONCASH_MIN.bounds.start > NONCASH_MIN.bounds.min
  && NONCASH_MIN.presets.every(p => p.id !== 'minimum'),
'and offers no minimum preset where there is no minimum to pay');

console.log('\n=== 8. mutation: breaking the engine breaks the answer ===');
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
const realDebts = m => m.payoffDebts(data.plan, data.debts);
const realById = m => Object.fromEntries(realDebts(m).map(d => [d.id, d]));
// An oracle compares the mutant with the real engine on the same input. A
// hardcoded live figure goes stale when the household refreshes, after which
// the oracle reads "differs" for every engine, mutated or not.
const REAL_BY_ID = realById(F);

const MUTATIONS = [
  { label: 'charging a card 360 days a year understates every card payoff',
    from: '    card: annualPct => (annualPct / 100 / DAYS_IN_YEAR) * CARD_CYCLE_DAYS,',
    to: '    card: annualPct => (annualPct / 100) * 30 / 365,',
    differs: m => !near(realById(m).triangle.interestOnly, REAL_BY_ID.triangle.interestOnly, 0.01) },

  { label: 'pricing a prime-linked facility on anything but its own convention moves it',
    from: '    variable: annualPct => RATE_BASIS.variable(annualPct),',
    to: '    variable: annualPct => RATE_BASIS.fixed(annualPct),',
    differs: m => !near(realById(m).mortgage.interestOnly, REAL_BY_ID.mortgage.interestOnly, 0.01) },

  { label: 'dropping pending charges answers for a debt the household does not have',
    from: 'const openingBalance = debt => debt.balance + (debt.pending || 0);',
    to: 'const openingBalance = debt => debt.balance;',
    // Invented card with a pending charge: the live data may carry none, which
    // would make this mutation invisible. Opening balance is balance + pending.
    differs: m => !near(m.payoffDebts(
      { obligations: [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 100, confidence: 'confirmed' }] },
      [{ id: 'x', label: 'x', balance: 1000, pending: 150, rate: 12, rateConvention: 'card' }],
    )[0].balance, 1150, 0.01) },

  { label: 'dropping cashPayment on a capitalising obligation hides the HELOC minimum',
    from: `        if (o.nonCash) {
          const cashAmt = Number(o.cashPayment) || 0;`,
    to: `        if (o.nonCash) {
          const cashAmt = 0;`,
    differs: m => realById(m).heloc.minimum === 0 },

  { label: 'reading a bi-weekly minimum as monthly makes the mortgage look unpayable',
    from: '  const PAYMENTS_PER_YEAR = { biweekly: 26, monthly: 12 };',
    to: '  const PAYMENTS_PER_YEAR = { biweekly: 12, monthly: 12 };',
    differs: m => m.payoffModel(realById(m).mortgage, realById(m).mortgage.minimum).clears !== true },

  { label: 'swallowing an un-annualisable obligation hides an incomplete minimum',
    from: '        if (!perYear) { unmodelled.push(o.id); return sum; }',
    to: '        if (!perYear) { return sum; }',
    differs: m => m.payoffDebts(
      { obligations: [{ id: 'o', debtId: 'x', frequency: 'weekly', amount: 25, confidence: 'confirmed' }] },
      [{ id: 'x', label: 'x', balance: 1000, rate: 12, rateConvention: 'card' }],
    )[0].unmodelled.length !== 1 },

  { label: 'treating a payment equal to the interest as a payoff claims a clearance that never comes',
    from: '      if (!(P > interestOnly)) return { clears: false, interestOnly, shortfall: interestOnly - P };',
    to: '      if (P < interestOnly) return { clears: false, interestOnly, shortfall: interestOnly - P };',
    differs: m => m.payoffModel(m.payoffDebts({ obligations: [] },
      [{ id: 'x', label: 'x', balance: 1000, rate: 12, rateConvention: 'variable' }])[0], 10).clears !== false },

  { label: 'losing the zero-rate branch returns NaN instead of a payoff',
    from: `      const months = i === 0 ? balance / P
        : -Math.log(1 - (balance * i) / P) / Math.log(1 + i);`,
    to: '      const months = -Math.log(1 - (balance * i) / P) / Math.log(1 + i);',
    differs: m => !isFinite(m.payoffModel(m.payoffDebts({ obligations: [] },
      [{ id: 'x', label: 'x', balance: 1200, rate: 0, rateConvention: 'card' }])[0], 100).months) },

  { label: 'losing the zero-rate branch in the target solve does the same',
    from: '    if (i === 0) return debt.balance / n;',
    to: '    if (i === 0) return debt.balance;',
    differs: m => m.paymentForMonths(m.payoffDebts({ obligations: [] },
      [{ id: 'x', label: 'x', balance: 1200, rate: 0, rateConvention: 'card' }])[0], 12) !== 100 },

  { label: 'a slider floor above the interest charge could only ever show good news',
    from: '    const min = Math.ceil(debt.interestOnly * 0.5);',
    to: '    const min = Math.ceil(debt.interestOnly * 1.5);',
    differs: m => m.payoffModel(realById(m).triangle,
      realById(m).triangle.bounds.min).clears === true },

  { label: 'a saving measured against a minimum that never clears is not a number',
    from: `      versusMinimum: atMinimum && atMinimum.clears && here.clears
        && atMinimum.totalInterest - here.totalInterest > EPSILON`,
    to: `      versusMinimum: atMinimum
        && !(atMinimum.totalInterest - here.totalInterest <= EPSILON)`,
    differs: m => m.payoffModel(realById(m).travelvisa, 200).versusMinimum !== null },

  { label: 'claiming the card rate IS the convention hides that it is an average',
    from: '  const PAYOFF_BASIS_PRECISION = { card: \'monthly-equivalent\', variable: \'exact\' };',
    to: '  const PAYOFF_BASIS_PRECISION = { card: \'exact\', variable: \'exact\' };',
    differs: m => realById(m).triangle.interestOnlyBand === null
      || realById(m).triangle.precision !== 'monthly-equivalent' },

  { label: 'collapsing the cycle range to a point publishes a certainty the model does not have',
    from: '  const CARD_CYCLE_DAYS_RANGE = { min: 28, max: 32 };',
    to: '  const CARD_CYCLE_DAYS_RANGE = { min: 30, max: 30 };',
    differs: m => realById(m).triangle.interestOnlyBand.low
      === realById(m).triangle.interestOnlyBand.high },

  { label: 'dropping the minimum\'s confidence publishes an estimate as a settled fact',
    from: `    const confidence = counted.length
      ? (counted.every(o => o.confidence === 'confirmed') ? 'confirmed' : 'estimated')
      : null;`,
    to: '    const confidence = counted.length ? \'confirmed\' : null;',
    differs: m => realById(m).triangle.minimumConfidence !== 'estimated' },

  { label: 'tagging confidence by exception lets an unrecognised value read as confirmed',
    from: '      ? (counted.every(o => o.confidence === \'confirmed\') ? \'confirmed\' : \'estimated\')',
    to: '      ? (counted.some(o => o.confidence === \'estimated\') ? \'estimated\' : \'confirmed\')',
    differs: m => m.payoffDebts(
      { obligations: [{ id: 'o', debtId: 'x', frequency: 'monthly', amount: 250 }] },
      [{ id: 'x', label: 'x', balance: 10000, rate: 12, rateConvention: 'card' }],
    )[0].minimumConfidence !== 'estimated' },

  { label: 'defaulting an undeclared convention prices the debt on a guess',
    from: '        const convention = x.rateConvention;',
    to: '        const convention = x.rateConvention || \'card\';',
    differs: m => {
      try { return m.payoffDebts({ obligations: [] }, [{ id: 'x', label: 'x', balance: 100, rate: 5 }]).length === 1; }
      catch { return false; } // the real engine refuses to price it
    } },
];
// Each oracle must be a real control: false on the unmutated engine (and not
// throwing there), so it cannot report "differs" for every engine. The count
// proves every listed mutation was built and judged.
let judged = 0;
for (const m of MUTATIONS) {
  let control;
  try { control = m.differs(F); } catch (e) { control = 'throws: ' + e.message; }
  ok(control === false, m.label + ' (oracle is false on the real engine)', String(control));
  const built = mutant(m.from, m.to);
  if (built.error) { ok(false, m.label, built.error); continue; }
  let differs = false;
  try { differs = m.differs(built.engine); } catch { differs = true; }
  ok(differs === true, m.label);
  judged++;
}
ok(MUTATIONS.length >= 10 && judged === MUTATIONS.length,
  'every listed payoff mutation was built, judged, and backed by a control',
  `${judged} of ${MUTATIONS.length}`);

console.log('\n=== 9. migration equivalence, and exactly what changed ===');

/* The expressions `public/app.js` and `public/modellers.js` ran before this
 * move, written out here rather than imported, because the point is to compare
 * against what the household was actually shown. */
const oldMonthlyRate = annualPct => (annualPct / 100) * 30 / 365;
function oldPayoff(balance, annualPct, monthlyPayment) {
  const i = oldMonthlyRate(annualPct);
  const interestOnly = balance * i;
  if (monthlyPayment <= interestOnly) {
    return { clears: false, interestOnly, shortfall: interestOnly - monthlyPayment };
  }
  const n = -Math.log(1 - (balance * i) / monthlyPayment) / Math.log(1 + i);
  const totalPaid = n * monthlyPayment;
  return { clears: true, months: n, totalPaid, totalInterest: totalPaid - balance, interestOnly };
}
const oldSolveFor = (x, months) => {
  const i = oldMonthlyRate(x.rate);
  return x.balance * i / (1 - Math.pow(1 + i, -months));
};
const oldBounds = x => {
  const min = Math.ceil(x.balance * oldMonthlyRate(x.rate) * 0.5);
  return { min, max: Math.max(Math.ceil(x.balance / 12), min * 6) };
};

/* Restoring the three changed inputs — the rate convention, the balance rule and
 * the minimum — to the engine has to reproduce the OLD published figures to the
 * cent, at every slider position the page can reach. That is what makes those
 * three the whole of the change: if anything else had moved, this would not
 * come back equal. */
const restored = mutant('  const PAYOFF_RATE_BASIS = {\n'
  + '    card: annualPct => (annualPct / 100 / DAYS_IN_YEAR) * CARD_CYCLE_DAYS,\n'
  + '    variable: annualPct => RATE_BASIS.variable(annualPct),\n'
  + '  };',
'  const PAYOFF_RATE_BASIS = {\n'
  + '    card: annualPct => (annualPct / 100) * 30 / 365,\n'
  + '    variable: annualPct => (annualPct / 100) * 30 / 365,\n'
  + '  };');
ok(!restored.error, 'the rate convention is replaceable in one place', restored.error || '');
const restoredBoth = restored.error ? restored : (() => {
  const src = FORECAST_SRC
    .replace('  const PAYOFF_RATE_BASIS = {\n'
      + '    card: annualPct => (annualPct / 100 / DAYS_IN_YEAR) * CARD_CYCLE_DAYS,\n'
      + '    variable: annualPct => RATE_BASIS.variable(annualPct),\n'
      + '  };',
    '  const PAYOFF_RATE_BASIS = {\n'
      + '    card: annualPct => (annualPct / 100) * 30 / 365,\n'
      + '    variable: annualPct => (annualPct / 100) * 30 / 365,\n'
      + '  };')
    .replace('const openingBalance = debt => debt.balance + (debt.pending || 0);',
      'const openingBalance = debt => debt.balance;');
  const sandbox = { module: { exports: {} } };
  try { vm.runInNewContext(src, sandbox, { filename: 'forecast-old-inputs.js' }); }
  catch (e) { return { error: e.message }; }
  return { engine: sandbox.module.exports };
})();
ok(!restoredBoth.error, 'and so is the balance rule', restoredBoth.error || '');

let positions = 0, mismatches = [];
if (!restoredBoth.error) {
  const oldEngine = restoredBoth.engine;
  for (const record of data.debts.filter(x => x.balance != null && x.rate != null && x.balance > 0)) {
    // `debt.payment` is the third restored input — the field the page read as
    // the minimum. Supplied here rather than patched into the engine, because
    // the engine no longer has anywhere to put it.
    const asPage = { balance: record.balance, rate: record.rate };
    const [d] = oldEngine.payoffDebts(data.plan, [record]);
    const b = oldBounds(asPage);
    if (d.bounds.min !== b.min || d.bounds.max !== b.max) {
      mismatches.push(`${record.id} bounds ${d.bounds.min}-${d.bounds.max} vs ${b.min}-${b.max}`);
    }
    for (const months of [60, 36, 12]) {
      if (!near(oldEngine.paymentForMonths(d, months), oldSolveFor(asPage, months))) {
        mismatches.push(`${record.id} solve ${months}`);
      }
    }
    // Every position the step-5 slider can occupy.
    for (let P = b.min; P <= b.max; P += 5) {
      positions++;
      const now = oldEngine.payoffModel(d, P), was = oldPayoff(record.balance, record.rate, P);
      const same = now.clears === was.clears
        && near(now.interestOnly, was.interestOnly)
        && (was.clears
          ? near(now.months, was.months) && near(now.totalPaid, was.totalPaid)
            && near(now.totalInterest, was.totalInterest)
          : near(now.shortfall, was.shortfall));
      if (!same) mismatches.push(`${record.id} @ ${P}`);
      if (mismatches.length > 5) break;
    }
  }
}
ok(positions > 3000 && mismatches.length === 0,
  `the moved engine reproduces the old page exactly at all ${positions} slider positions, given the old inputs`,
  mismatches.slice(0, 5).join('; '));

/* Which leaves the published figures that DID change, named one at a time. Each
 * expected value is the old page expression run on the old inputs against the
 * new engine run on the canonical ones — two different calculations, not one
 * asked twice. */
const CHANGED = [
  { id: 'mortgage', what: 'clears at all',
    was: () => oldPayoff(546026.58, 3.64, 1600).clears,
    now: () => F.payoffModel(byId.mortgage, byId.mortgage.minimum).clears,
    expect: [false, true] },
  { id: 'heloc', what: 'cash minimum is the encoded cashPayment',
    was: () => Math.round(oldPayoff(201586.16, 4.9, 814.18).months),
    now: () => byId.heloc.minimum,
    expect: [1459, 814.18] },
  { id: 'triangle', what: 'takes longer at its minimum',
    was: () => Number(oldPayoff(13497, 21.99, 253.57).months.toFixed(2)),
    now: () => Number(F.payoffModel(byId.triangle, byId.triangle.minimum).months.toFixed(2)),
    expect: [182.62, 204.03] },
  { id: 'triangle', what: 'costs more interest at its minimum',
    was: () => Number(oldPayoff(13497, 21.99, 253.57).totalInterest.toFixed(2)),
    now: () => Number(F.payoffModel(byId.triangle, byId.triangle.minimum).totalInterest.toFixed(2)),
    expect: [32810.22, 38239.71] },
  { id: 'mbna', what: 'owes its pending charges too',
    was: () => Number(oldPayoff(7855.12, 21.74, 158.27).totalInterest.toFixed(2)),
    now: () => Number(F.payoffModel(byId.mbna, byId.mbna.minimum).totalInterest.toFixed(2)),
    expect: [11616.35, 13147.41] },
  { id: 'travelvisa', what: 'grows faster than the page said',
    was: () => Number(oldPayoff(1078.31, 19.99, 17).shortfall.toFixed(2)),
    now: () => Number(F.payoffModel(byId.travelvisa, byId.travelvisa.minimum).shortfall.toFixed(2)),
    expect: [0.72, 3.71] },
  { id: 'cashback', what: 'is measured against its recurring minimum',
    was: () => 762.36,
    now: () => byId.cashback.minimum,
    expect: [762.36, 170] },
];
for (const c of CHANGED) {
  const was = c.was(), now = c.now();
  const pinnedNow = c.expect[1] === true || c.expect[1] === false
    || c.id === 'cashback' || c.id === 'heloc';
  if (pinnedNow) {
    ok(was === c.expect[0] && now === c.expect[1],
      `${c.id} ${c.what}`, `${was} → ${now}`);
  } else {
    ok(was === c.expect[0] && now !== was,
      `${c.id} ${c.what} — the old page figure is gone`, `${was} → ${now}`);
  }
}
// Every change is in one direction, and it is the honest one.
ok(REAL.every(d => {
  const oldRate = oldMonthlyRate(d.rate);
  return d.monthlyRate >= oldRate - 1e-15 && d.balance >= d.posted;
}), 'no debt is now priced lower or smaller than the page priced it');

console.log('\n=== 10. the page renders, and decides nothing ===');

const modellersSrc = read('public/modellers.js');
const appSrc = read('public/app.js');
const modellersHtml = read('public/modellers.html');
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const payoffPage = /\nfunction setupPayoff\(d\) \{[\s\S]*?\n\}\n/.exec(modellersSrc);
ok(!!payoffPage, 'the payoff section is readable from modellers.js');
const pageSrc = codeOnly(payoffPage ? payoffPage[0] : '');

ok(/<script src="\/forecast\.js"><\/script>/.test(modellersHtml)
  && modellersHtml.indexOf('/forecast.js') < modellersHtml.indexOf('/modellers.js'),
'modellers.html loads the engine, before the page that calls it');
ok(/Forecast\.payoffDebts\(/.test(pageSrc) && /Forecast\.payoffModel\(/.test(pageSrc),
  'the page reads both payoff answers from Forecast');
ok(!/Math\.pow\(/.test(pageSrc) && !/Math\.log\(/.test(pageSrc),
  'and runs neither an annuity nor a logarithm itself');
ok(!/function solveFor/.test(modellersSrc) && !/solveFor\(/.test(codeOnly(modellersSrc)),
  'the preset annuity is defined and called nowhere in a page script');
ok(!/function payoff\s*\(/.test(codeOnly(appSrc))
  && !/monthlyRate\s*=/.test(codeOnly(appSrc))
  && !/monthlyRate\(/.test(codeOnly(modellersSrc)),
'the payoff projection and its rate are gone from the shared page core');
ok(!/\* *0?\.5/.test(pageSrc) && !/interestOnly \*/.test(pageSrc),
  'the page does not pick the slider floor from an interest charge of its own');
ok(!/x\.payment\b/.test(pageSrc) && !/\.pending\b/.test(pageSrc) && !/\.rate \*/.test(pageSrc),
  'nor reads a debt record field for arithmetic of its own');
ok(!/totalInterest -/.test(pageSrc) && !/months -/.test(pageSrc),
  'nor works out for itself what paying more saves');
ok(/fmtMonths/.test(codeOnly(appSrc)),
  'what is left in the page core is formatting');

/* Every id the engine can return has wording, and every wording is reachable. A
 * missing entry renders `undefined` at the household; a stale one is dead prose
 * that looks maintained. Lifted from the production source, not copied. */
const grab = (src, re, what) => {
  const m = re.exec(src);
  ok(!!m, `${what} is readable from its source`);
  return m ? m[0] : '';
};
const MAPS = [
  grab(modellersSrc, /^const PAYOFF_PRESET_LABEL = \{[\s\S]*?^\};$/m, 'the preset label map'),
  grab(modellersSrc, /^const PAYOFF_CONVENTION_NOTE = \{[\s\S]*?^\};$/m, 'the convention note map'),
  grab(modellersSrc, /^const PAYOFF_PRECISION_NOTE = \{[\s\S]*?^\};$/m, 'the precision note map'),
  grab(modellersSrc, /^const PAYOFF_MONTH1_LABEL = \{[\s\S]*?^\};$/m, 'the month-1 label map'),
  grab(modellersSrc, /^const PAYOFF_MINIMUM_CONFIDENCE = \{[\s\S]*?^\};$/m, 'the minimum confidence map'),
  grab(modellersSrc, /^const PAYOFF_VERSUS_MINIMUM = .*$/m, 'the versus-minimum wording'),
  grab(modellersSrc, /^const PAYOFF_MINIMUM_NOTE = \{[\s\S]*?^\};$/m, 'the minimum note map'),
].join('\n');
const wording = {};
vm.runInNewContext(MAPS + '\nout.preset = PAYOFF_PRESET_LABEL;'
  + 'out.convention = PAYOFF_CONVENTION_NOTE; out.minimum = PAYOFF_MINIMUM_NOTE;'
  + 'out.confidence = PAYOFF_MINIMUM_CONFIDENCE; out.versus = PAYOFF_VERSUS_MINIMUM;'
  + 'out.precision = PAYOFF_PRECISION_NOTE; out.month1 = PAYOFF_MONTH1_LABEL;',
{ out: wording, money2: n => String(n) });

/* The precision wording, which is what stops an averaged figure reading as an
 * exact one. Both ids the engine can return need it, and neither may be stale. */
const precisionIds = [...new Set(REAL.map(d => d.precision))].sort();
ok(precisionIds.join() === 'exact,monthly-equivalent',
  'the engine publishes exactly two precisions', precisionIds.join(', '));
ok(precisionIds.every(id => typeof wording.precision[id] === 'function'
  && typeof wording.month1[id] === 'string'),
'both have wording on the context line and on the month-1 row');
ok(Object.keys(wording.precision).sort().join() === 'exact,monthly-equivalent'
  && Object.keys(wording.month1).sort().join() === 'exact,monthly-equivalent',
'and neither map carries wording the engine cannot reach');
ok(wording.precision.exact(byId.mortgage) === ''
  && /average/i.test(wording.precision['monthly-equivalent'](byId.triangle))
  && /average cycle/i.test(wording.month1['monthly-equivalent'])
  && !/average/i.test(wording.month1.exact),
'an averaged figure is marked as averaged, and an exact one is not marked at all');

/* The confidence wording is reached only where there IS a figure to tag, so
 * `null` must never get there — it would render `undefined` mid-sentence. The
 * engine's own guarantee is that a cash minimum and a confidence arrive
 * together, and that is asserted rather than assumed. */
ok(REAL.every(d => (d.minimumId === 'cash') === (d.minimumConfidence !== null)),
  'a debt has a cash minimum exactly when it has a confidence for it',
  REAL.map(d => `${d.id}:${d.minimumId}/${d.minimumConfidence}`).join(' '));
const confidenceIds = [...new Set(REAL.map(d => d.minimumConfidence).filter(Boolean))];
ok(confidenceIds.every(id => typeof wording.confidence[id] === 'string')
  && confidenceIds.every(id => typeof wording.versus[id] === 'string'),
'every confidence the engine can publish has wording on both lines that carry it',
confidenceIds.join(', '));
ok(Object.keys(wording.confidence).sort().join() === 'confirmed,estimated'
  && Object.keys(wording.versus).sort().join() === 'confirmed,estimated',
'and neither map carries wording the engine cannot reach');
ok(/estimated/.test(wording.confidence.estimated) && wording.confidence.confirmed === ''
  && /estimated/.test(wording.versus.estimated) && !/estimated/.test(wording.versus.confirmed),
'an estimated minimum is marked as one, and a confirmed one is not marked at all');

const presetIds = new Set(['minimum', 'clear-60', 'clear-36', 'clear-12']);
const conventionIds = new Set(REAL.map(d => d.convention));
const minimumIds = new Set(REAL.map(d => d.minimumId).concat(['cash', 'none']));
ok([...presetIds].every(id => wording.preset[id]),
  'every preset the engine can return has a label');
ok(Object.keys(wording.preset).every(id => presetIds.has(id)),
  'and every label is reachable');
ok([...conventionIds].every(id => wording.convention[id])
  && Object.keys(wording.convention).every(id => ['card', 'variable'].includes(id)),
'every rate convention the engine can return has wording, and none is stale');
ok([...minimumIds].every(id => typeof wording.minimum[id] === 'function')
  && Object.keys(wording.minimum).length === 2,
'both minimum outcomes have wording');
// The published page has to reach both of them, or one is untested prose.
ok(REAL.every(d => d.minimumId === 'cash') && NONCASH_MIN.minimumId === 'none',
  'every live debt has a cash minimum, and a capitalise-only fixture still reaches none');

console.log('\n=== 11. the panel the household actually reads ===');

/* Everything above proves the engine and inspects the page as text. This runs
 * the page: `public/app.js`, `public/forecast.js` and `public/modellers.js`, in
 * the order `modellers.html` loads them, against a stub DOM carrying the ids
 * that file really has, booted through `App.boot()` on the real `data.json`. A
 * proof that stops at the helper cannot see a template reading a field the
 * engine stopped returning — that renders `undefined` at the household and
 * every check above still passes. */
function renderPage() {
  const els = new Map();
  const makeEl = id => {
    const el = {
      id, textContent: '', value: '', min: '', max: '', step: '',
      children: [], listeners: {}, attributes: {},
      addEventListener(kind, fn) { (this.listeners[kind] = this.listeners[kind] || []).push(fn); },
      setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      append(...children) { for (const child of children) this.appendChild(child); },
      remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } },
      fire(kind) { for (const fn of this.listeners[kind] || []) fn(); },
    };
    // Writing innerHTML replaces the children, as it does in a browser — the
    // page clears the preset row that way, and a stub that kept them would
    // hide a stale button rather than catch one.
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => html,
      set(v) { html = String(v); el.children = []; },
    });
    return el;
  };
  const get = id => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const doc = {
    getElementById: get,
    createElement: () => makeEl('created'),
    createElementNS: () => makeEl('svg'),
    querySelector: () => null,
    documentElement: makeEl('html'),
    body: { scrollHeight: 0 },
  };
  const sandbox = {
    document: doc,
    // Empty readable pending store; other storage stays unavailable as before.
    localStorage: { getItem(key) { if (key === 'atlas-settlement-pending-v1') return null; throw Error('synthetic non-marker storage unavailable'); },
      setItem() { throw Error('storage write forbidden'); }, removeItem() { throw Error('storage removal forbidden'); } },
    addEventListener() {},
    matchMedia: () => ({ addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame() {},
    innerWidth: 1200, innerHeight: 800, scrollY: 0,
    console,
    fetch: () => Promise.resolve({ status: 200, ok: true, json: () => data }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, { AbortController, setTimeout, clearTimeout });
  vm.createContext(sandbox);
  for (const file of ['public/app.js', 'public/forecast.js', 'public/modellers.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  return { els, get, sandbox };
}

/* The page's OWN money formatter, lifted from `public/app.js` rather than
 * reimplemented, so a check on what the household reads is built with the same
 * function the browser uses. A lookalike would prove the lookalike. */
const money2Page = vm.runInNewContext(
  `${/^const money2 = .*$/m.exec(read('public/app.js'))[0]}\nmoney2;`);

const page = renderPage();
// `App.boot()` renders from a promise chain, so the assertions wait for the
// microtask queue to drain the way the browser's first paint does.
setTimeout(() => {
  const out = page.get('payoff-out');
  const context = page.get('model-context');
  const label = page.get('pay-label');
  const select = page.get('debt-select');
  const range = page.get('pay-range');

  ok(/Triangle Mastercard/.test(select.innerHTML) && /HELOC/.test(select.innerHTML),
    'the debt list renders every modellable debt');
  ok(!/undefined|NaN|\[object/.test(select.innerHTML + out.innerHTML + context.textContent),
    'and the panel it opens on contains no undefined, NaN or [object Object]',
    (out.innerHTML.match(/undefined|NaN|\[object \w+\]/) || [''])[0]);

  // Whatever the control opens on, the panel has to be showing THAT answer.
  const opened = byId.triangle;
  ok(Number(range.value) === opened.bounds.start
    && Number(range.min) === opened.bounds.min && Number(range.max) === opened.bounds.max,
  'the slider carries the engine\'s bounds and opening position',
  `${range.min}–${range.max} @ ${range.value}`);
  const expected = F.payoffModel(opened, Number(range.value));
  ok(out.innerHTML.includes(money(expected.totalInterest).replace('−', '−'))
    && out.innerHTML.includes(money(expected.totalPaid))
    && out.innerHTML.includes(money(expected.interestOnly)),
  'and the figures printed are the engine\'s, to the cent',
  money(expected.totalInterest));
  ok(label.textContent.includes(Math.round(Number(range.value)).toLocaleString('en-CA')),
    'the payment label states the position the figures were computed at',
    label.textContent);
  ok(/daily rate/.test(context.textContent) && context.textContent.includes('21.99%'),
    'and the context names the convention the rate is charged under, not just the rate');
  // The Triangle minimum is one of the five estimated ones, and every figure in
  // the panel beside it is measured against that number.
  ok(/estimated/.test(context.textContent) && /\$253\.57/.test(context.textContent),
    'the estimated minimum is marked as estimated where it is stated',
    context.textContent.slice(context.textContent.indexOf('The minimum')));
  // The averaged first-period figure reaches the household with its band, and
  // the row that carries it says which cycle it prices.
  ok(context.textContent.includes(money2Page(opened.interestOnlyBand.low))
    && context.textContent.includes(money2Page(opened.interestOnlyBand.high))
    && /average statement cycle/.test(context.textContent),
  'the first-period figure is published with the cycle band, not as a point',
  `${money(opened.interestOnlyBand.low)} – ${money(opened.interestOnlyBand.high)}`);
  ok(/average cycle/.test(out.innerHTML),
    'and the month-1 row says it prices an average cycle');
  const generous = F.payoffModel(opened, opened.bounds.max);
  range.value = String(opened.bounds.max);
  range.fire('input');
  ok(!!generous.versusMinimum
    && /versus paying the estimated minimum/.test(page.get('payoff-out').innerHTML),
  'and the saving is stated against the estimated minimum, not against a settled one');
  range.value = String(opened.bounds.start);
  range.fire('input');

  // The preset buttons are the engine's solve, rendered.
  ok(page.get('pay-presets').children.length === opened.presets.length
    && opened.presets.every((p, i) =>
      page.get('pay-presets').children[i].textContent.includes(
        Math.round(p.amount).toLocaleString('en-CA'))),
  'every preset button carries the payment the engine solved for',
  page.get('pay-presets').children.map(c => c.textContent).join(' / '));

  // Select the HELOC — the debt the old page was most wrong about — and read
  // what the household is now told.
  const helocIndex = REAL.findIndex(d => d.id === 'heloc');
  select.value = String(helocIndex);
  select.fire('change');
  ok(/The minimum is/.test(page.get('model-context').textContent)
      && /814/.test(page.get('model-context').textContent),
    'selecting the HELOC names the encoded cashPayment as the cash minimum');
  ok(page.get('pay-presets').children.some(c => /Minimum/.test(c.textContent)),
    'and the Minimum preset is reachable because there is a cash minimum');

  // Drop the slider to its floor and the panel has to say the balance grows.
  range.value = String(byId.heloc.bounds.min);
  range.fire('input');
  const floor = F.payoffModel(byId.heloc, byId.heloc.bounds.min);
  ok(/Never clears/.test(page.get('payoff-out').innerHTML)
    && page.get('payoff-out').innerHTML.includes(money(floor.shortfall)),
  'at the slider\'s floor it reports the balance growing, by the engine\'s figure',
  money(floor.shortfall));

  // Cash Back is back under its limit; the paid September spike is not named.
  select.value = String(REAL.findIndex(d => d.id === 'cashback'));
  select.fire('change');
  ok(!/cashback-sep/.test(page.get('model-context').textContent),
    'the paid September spike is not named on the page after the cutover');

  console.log('\n' + '═'.repeat(60));
  if (failures) {
    console.log(`FAILED — ${failures} payoff check(s)`);
    process.exit(1);
  }
  console.log('THE PAYOFF MODELLER IS THE ENGINE\'S, AND IT RECONCILES');
}, 0);
