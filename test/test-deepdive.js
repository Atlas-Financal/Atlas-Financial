'use strict';
/* Focused proof for Forecast.deepDive(). Until this move public/deepdive.js
 * grouped heldElsewhere, averaged period spending, totalled discretionary
 * spend and avoidable fees, flagged Cash Back Visa cycles with
 * `Math.abs(eff - 26.99) > 4`, summed implied/charged columns, and
 * hardcoded 26.99% and ~$1,620/month. Widening the fit band to 40,
 * swapping the footer rate, halving the elsewhere total, doubling the
 * monthly average, and replacing $1,620 with $1,000 left npm test green
 * — ALL 22 SUITES PASSED — because no test could reach the page.
 *
 * Correctness cases are hand-computed from literal balances, period
 * rows, cycle figures and the Cash Back Visa / mortgage debt records —
 * not the function that now produces the answer.
 */
const fs = require('fs');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');
const periods = require('../public/periods.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const same = (a, b) => a === b;
const cents = n => Math.round(Number(n) * 100);
const sameCents = (a, b) => cents(a) === cents(b);
const read = p => sourceText(fs.readFileSync(p, 'utf8'));
const money = n => (n < 0 ? '−$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-CA');
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const FIX_HELD = [
  { label: 'Amanda — pass-through', value: 100, class: 'operational' },
  { label: 'Coaches — same class', value: 50, class: 'operational' },
  { label: 'Staging', value: 20, class: 'staging' },
];
const HAND_ELSEWHERE = 100 + 50 + 20;
const HAND_OPERATIONAL = 100 + 50;
const HAND_STAGING = 20;

const FIX_PERIOD = {
  label: 'Fixture',
  months: 2,
  spendingTotal: 1000,
  interestTotal: 80,
  feesTotal: 30,
  spending: [
    { label: 'Groceries', total: 400, type: 'essential' },
    { label: 'Dining', total: 250, type: 'discretionary' },
    { label: 'Shopping', total: 200, type: 'discretionary' },
    { label: 'Unknown', total: 150, type: 'unknown' },
  ],
  fees: [
    { label: 'NSF', total: 20, type: 'avoidable' },
    { label: 'Monthly fee', total: 10, type: 'structural' },
  ],
};
const HAND_DISC = 250 + 200;
const HAND_SHARE = HAND_DISC / 1000 * 100;
const HAND_MONTHLY = 1000 / 2;
const HAND_AVOID = 20;

const FIX_ROWS = [
  { stmt: 'On', avg: 1000, implied: 20, charged: 19, eff: 26.99 },
  { stmt: 'High', avg: 1000, implied: 30, charged: 40, eff: 31.00 },
  { stmt: 'Low', avg: 1000, implied: 10, charged: 8, eff: 22.98 },
];
const HAND_IMPLIED = 20 + 30 + 10;
const HAND_CHARGED = 19 + 40 + 8;
const FIX_DATA = {
  plan: { startingCash: { amount: 80, heldElsewhere: FIX_HELD } },
  debts: [
    { id: 'mortgage', annualInterest: 12000 },
    { id: 'cashback', rate: 26.99 },
  ],
  interestCheck: { rows: FIX_ROWS },
};

console.log('=== hand-computed cash grouping ===');
ok(HAND_ELSEWHERE === 170 && HAND_OPERATIONAL === 150 && HAND_STAGING === 20,
  'elsewhere is $100+$50+$20; operational $150; staging $20');
const cashDive = F.deepDive(FIX_DATA);
ok(cashDive && same(cashDive.elsewhere, HAND_ELSEWHERE)
  && same(cashDive.cashAmount, 80),
  'elsewhere total is $170; spendable cash is the register amount, not the sum');
ok(cashDive.classes.length === 2
  && cashDive.classes[0].class === 'operational'
  && same(cashDive.classes[0].total, HAND_OPERATIONAL)
  && cashDive.classes[1].class === 'staging'
  && same(cashDive.classes[1].total, HAND_STAGING),
  'classes group in first-seen order and do not merge across class');

console.log('\n=== spending monthly average, discretionary, avoidable ===');
ok(HAND_DISC === 450 && HAND_SHARE === 45 && HAND_MONTHLY === 500 && HAND_AVOID === 20,
  'discretionary $250+$200 = $450 is 45% of $1,000; average $500; avoidable $20');
const periodDive = F.deepDive(FIX_DATA, FIX_PERIOD);
const snap = periodDive.period;
ok(snap && same(snap.discretionary, HAND_DISC)
  && same(snap.discretionaryShare, HAND_SHARE)
  && same(snap.spendingMonthly, HAND_MONTHLY)
  && same(snap.avoidable, HAND_AVOID),
  'period snapshot matches the hand totals');

const oneMonth = F.deepDive(FIX_DATA, Object.assign({}, FIX_PERIOD, { months: 1 }));
ok(oneMonth.period && oneMonth.period.spendingMonthly === null,
  'a one-month period omits the monthly average, as the page already did');

const emptySpend = F.deepDive(FIX_DATA, {
  months: 2, spendingTotal: 0, spending: [], fees: [],
});
ok(emptySpend.period && same(emptySpend.period.discretionary, 0)
  && same(emptySpend.period.discretionaryShare, 0),
  'zero spending is 0% discretionary, not a divide-by-zero');

console.log('\n=== Cash Back Visa fit: both sides of ±4pp, equality on 4 ===');
ok(Math.abs(26.99 - 26.99) === 0 && !(0 > 4), 'exact rate is inside the band');
ok(Math.abs(30.99 - 26.99) === 4 && !(4 > 4), 'exactly +4pp is inside — the page used `>`');
ok(Math.abs(31.00 - 26.99) > 4, '+4.01pp is outside');
ok(Math.abs(22.99 - 26.99) === 4 && !(4 > 4), 'exactly −4pp is inside');
ok(Math.abs(22.98 - 26.99) > 4, '−4.01pp is outside');

const ic = cashDive.interest;
ok(ic && same(ic.rate, 26.99),
  'the published rate is the Cash Back Visa record, not a page literal');
ok(ic.rows[0].off === false, '26.99% is not flagged');
ok(ic.rows[1].off === true, '31.00% is flagged');
ok(ic.rows[2].off === true, '22.98% is flagged');

const edge = F.deepDive({
  plan: FIX_DATA.plan,
  debts: FIX_DATA.debts,
  interestCheck: { rows: [
    { stmt: 'Plus4', avg: 1, implied: 1, charged: 1, eff: 30.99 },
    { stmt: 'Minus4', avg: 1, implied: 1, charged: 1, eff: 22.99 },
  ] },
});
ok(edge.interest.rows.every(r => r.off === false),
  'both exact ±4pp edges stay unflagged');

ok(sameCents(ic.impliedTotal, HAND_IMPLIED) && sameCents(ic.chargedTotal, HAND_CHARGED),
  'five-cycle stand-in totals are $60 implied and $67 charged',
  `${ic.impliedTotal} / ${ic.chargedTotal}`);

ok(same(periodDive.mortgageMonthly, 12000 / 12),
  'mortgage monthly is $12,000 / 12 = $1,000 — the compact-snapshot twelfth');

console.log('\n=== live Deep Dive: independent of deepDive ===');
const LIVE_ELSEWHERE = (data.plan.startingCash.heldElsewhere || [])
  .reduce((s, h) => s + h.value, 0);

const LIVE_IMPLIED_CENTS = [110.59, 109.76, 75.23, 91.43, 117.36]
  .reduce((s, n) => s + cents(n), 0);
const LIVE_CHARGED_CENTS = [108.91, 103.98, 61.27, 59.93, 158.55]
  .reduce((s, n) => s + cents(n), 0);
ok(LIVE_IMPLIED_CENTS === 50437 && LIVE_CHARGED_CENTS === 49264,
  'five-cycle implied $504.37 and charged $492.64 — the note\'s own totals');

const LIVE_MORTGAGE_ANNUAL = 19441;
const LIVE_MORTGAGE_MONTHLY = LIVE_MORTGAGE_ANNUAL / 12;
ok(money(LIVE_MORTGAGE_MONTHLY) === '$1,620',
  'mortgage $19,441 / 12 prints $1,620');

const LIVE_LM_DISC_CENTS = [2274.15, 2257.64, 1378.39, 378.53, 86.02, 77.66]
  .reduce((s, n) => s + cents(n), 0);
const LIVE_LM_SPEND = 10151.07;
const LIVE_LM_AVOID_CENTS = [3]
  .reduce((s, n) => s + cents(n), 0);
ok(LIVE_LM_DISC_CENTS === 645239, 'last-month discretionary is the six cleaned discretionary lines');
ok(LIVE_LM_AVOID_CENTS === 300, 'last-month avoidable fees are the $3 out-of-network ATM charge');
ok((LIVE_LM_DISC_CENTS / cents(LIVE_LM_SPEND) * 100).toFixed(0) === '64',
  'and that is 64% of $10,151.07');

const LIVE_YTD_DISC_CENTS = [17725.23, 10293.44, 7809.73, 2846.33, 2018.42, 676.99]
  .reduce((s, n) => s + cents(n), 0);
const LIVE_YTD_SPEND = 75922.86;
const LIVE_YTD_MONTHS = 8;
const LIVE_YTD_AVG = LIVE_YTD_SPEND / LIVE_YTD_MONTHS;
const LIVE_YTD_AVOID_CENTS = [87, 30, 3]
  .reduce((s, n) => s + cents(n), 0);
ok(LIVE_YTD_DISC_CENTS === 4137014 && LIVE_YTD_AVOID_CENTS === 12000,
  'cleaned YTD discretionary $41,370.14 and avoidable $120.00');
ok(LIVE_YTD_AVG === 9490.3575, 'YTD average is $75,922.86 / 8');

const live = F.deepDive(data, periods.periods.lastMonth);
ok(live && same(live.elsewhere, LIVE_ELSEWHERE) && same(live.cashAmount, F.startingCashAmount(data.plan)),
  'live elsewhere is the held-elsewhere sum beside spendable household cash');
ok(live.interest && same(live.interest.rate, 26.99)
  && cents(live.interest.impliedTotal) === LIVE_IMPLIED_CENTS
  && cents(live.interest.chargedTotal) === LIVE_CHARGED_CENTS,
  'live rate/totals come from the Cash Back Visa record and the five cycle rows');
ok(live.interest.rows.filter(r => r.off).map(r => r.stmt).join(',')
    === '8 Jun 2026,7 Jul 2026,7 Aug 2026',
  'live flagged cycles are June, July and August — |eff−26.99| > 4');
ok(live.interest.rows.filter(r => !r.off).length === 2,
  'April and May stay inside the band');
ok(same(live.mortgageMonthly, LIVE_MORTGAGE_MONTHLY),
  'live mortgage monthly is $19,441 / 12');
ok(live.period && cents(live.period.discretionary) === LIVE_LM_DISC_CENTS
  && cents(live.period.avoidable) === LIVE_LM_AVOID_CENTS
  && live.period.spendingMonthly === null
  && live.period.discretionaryShare.toFixed(0) === '64',
  'live last-month snapshot matches the independent totals; no monthly average');

const liveYtd = F.deepDive(data, periods.periods.ytd);
ok(liveYtd.period && same(liveYtd.period.spendingMonthly, LIVE_YTD_AVG)
  && cents(liveYtd.period.discretionary) === LIVE_YTD_DISC_CENTS
  && cents(liveYtd.period.avoidable) === LIVE_YTD_AVOID_CENTS,
  'live ytd average, discretionary and avoidable match the hand sums');

ok(money2(LIVE_IMPLIED_CENTS / 100) === '$504.37'
  && money2(LIVE_CHARGED_CENTS / 100) === '$492.64',
  'the published five-cycle footer still prints $504.37 and $492.64');

console.log('\n=== mutation: the incumbent engine decisions now fail ===');
const FORECAST_SRC = read('public/forecast.js');
const FROM_FIT = '  const INTEREST_FIT_PP = 4;';
const TO_FIT = '  const INTEREST_FIT_PP = 40;';
const FROM_MONTH = '        spendingMonthly: months > 1 ? spendingTotal / months : null,';
const TO_MONTH = '        spendingMonthly: months > 1 ? spendingTotal / months / 2 : null,';
const FROM_ELSE = '      elsewhere += h.value;';
const TO_ELSE = '      elsewhere += h.value / 2;';
const FROM_DISC = '        .filter(s => publishedSpendType(s.types || [s.type]) === \'discretionary\')\n';
const TO_DISC = '';
ok(FORECAST_SRC.split(FROM_FIT).length - 1 === 1, 'the ±4pp band appears once');
ok(FORECAST_SRC.split(FROM_MONTH).length - 1 === 1, 'the monthly average appears once');
ok(FORECAST_SRC.split(FROM_ELSE).length - 1 === 1, 'the elsewhere sum appears once');
ok(FORECAST_SRC.split(FROM_DISC).length - 1 === 1, 'the discretionary filter appears once');
const sandbox = { module: { exports: {} } };
try {
  vm.runInNewContext(
    FORECAST_SRC.replace(FROM_FIT, TO_FIT)
      .replace(FROM_MONTH, TO_MONTH)
      .replace(FROM_ELSE, TO_ELSE)
      .replace(FROM_DISC, TO_DISC),
    sandbox, { filename: 'forecast-mutant.js' });
} catch (e) {
  ok(false, 'mutant engine loads', e.message);
}
const mutant = sandbox.module.exports;
const broken = mutant && mutant.deepDive(FIX_DATA, FIX_PERIOD);
ok(mutant && broken && same(broken.elsewhere, HAND_ELSEWHERE / 2)
  && !same(broken.elsewhere, HAND_ELSEWHERE),
  'halving the elsewhere add publishes $85 instead of $170');
ok(mutant && broken && same(broken.period.spendingMonthly, HAND_MONTHLY / 2),
  'halving the monthly average publishes $250 instead of $500');
ok(mutant && broken && same(broken.period.discretionary, 1000)
  && !same(broken.period.discretionary, HAND_DISC),
  'dropping the discretionary filter publishes the whole $1,000 instead of $450');
ok(mutant && broken && broken.interest.rows[1].off === false
  && ic.rows[1].off === true,
  'widening the band to 40pp stops flagging 31.00%');
ok(same(cashDive.elsewhere, HAND_ELSEWHERE)
  && same(periodDive.period.spendingMonthly, HAND_MONTHLY)
  && ic.rows[1].off === true,
  'the real engine still answers the hand-computed figures on the same fixtures');

const monthMutant = { module: { exports: {} } };
const FROM_TWELFTH = '    return annual === null || annual === undefined ? null : annual / 12;';
ok(FORECAST_SRC.split(FROM_TWELFTH).length - 1 === 1,
  'monthOfAnnual is the single twelfth, shared with compactSnapshot');
try {
  vm.runInNewContext(FORECAST_SRC.replace(FROM_TWELFTH, '    return annual === null || annual === undefined ? null : annual / 6;'),
    monthMutant, { filename: 'forecast-month-mutant.js' });
} catch (e) {
  ok(false, 'month mutant loads', e.message);
}
const brokenMonth = monthMutant.module.exports
  && monthMutant.module.exports.deepDive(data);
ok(brokenMonth && !same(brokenMonth.mortgageMonthly, LIVE_MORTGAGE_MONTHLY)
  && same(brokenMonth.mortgageMonthly, LIVE_MORTGAGE_ANNUAL / 6),
  'halving the shared twelfth publishes $3,240.17 instead of $1,620.08');
ok(same(live.mortgageMonthly, LIVE_MORTGAGE_MONTHLY),
  'the real engine still answers $19,441 / 12');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
