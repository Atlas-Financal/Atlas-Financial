'use strict';
/* Amanda salary vs coaching/business vs household transfers.
 *
 * Acceptance corpus: docs/source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md
 * Owner-confirmed 2026-08-22: the two fixed Tennis BC salary deposits are
 * Forecast household income. Owner-clarified 2026-08-31 / restated
 * 2026-09-01: they first land in TENNIS INCOME, which is not Current
 * Balance; household-visible posting proof is the later BILLS transfer.
 * A later transfer of those dollars is not a second income line. Future
 * confirmed salary remains Forecast income. Coaching surplus is not
 * forecast. The raw TENNIS INCOME balance remains non-spendable. Fusion
 * settlement and the
 * Hydro September dated due stay the B91 current-state cutover, not this
 * income-model outcome. This suite proves the semantic split on classified
 * movements plus existing Forecast.expandEvents. It is not a second income
 * engine.
 *
 * Independent proof: hand addition of named classified amounts. That is
 * not a second call to expandEvents or simulate.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const R = require('../scripts/reconcile.js');
const live = require('../data.json');
const amanda = require('../docs/reconciliation/amanda-income-observations.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => '$' + Number(n).toFixed(2);
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const START = '2026-08-14';
const END = F.addDays(START, 27);
const OPENING = 2000;
const SALARY = 2168.85;
const MONTH_END = 2387.99;
const SALARY_MONTHLY = 4556.84;
const TRANSFER = 2168.85;
const WRONG = 4337.70;
const COACHING = 4000;
const KNOWN_OBLIGATION = 300;
const KNOWN_COACHING = 400;
const SESSION_BALANCE = 798.37;
const CANONICAL_HELD = 2691.85;
const AMANDA = 'amanda-debt-payments';
const JOINT = 'chequing-b';

function emptySide() {
  return { observations: [] };
}

function cashFixture(income, extraCash) {
  return Object.assign({
    windowDays: 28,
    defaults: { targetBuffer: 0 },
    startingCash: {
      breakdown: [{ id: JOINT, value: OPENING, class: 'spendable' }, { id: 'chequing-a', value: 0 }],
      heldElsewhere: [{ id: AMANDA, value: SESSION_BALANCE, class: 'operational' }],
    },
    income: income || [],
    obligations: [],
    bills: [],
    commitments: [],
  }, extraCash || {});
}

function transferStream(amount) {
  return {
    id: 'amandaTransfer',
    label: "Amanda's transfers to the household",
    frequency: 'once',
    date: START,
    amount: amount,
    confidence: 'estimated',
  };
}

function salaryStream(amount) {
  return {
    id: 'amandaSalary',
    label: 'Tennis BC salary',
    frequency: 'once',
    date: START,
    amount: amount,
    confidence: 'estimated',
  };
}

function salary15(amount) {
  return {
    id: 'amandaSalary15',
    label: 'Amanda salary — Tennis BC — 15th',
    frequency: 'monthly',
    day: 15,
    amount: amount == null ? SALARY : amount,
    confidence: 'confirmed',
  };
}

function salaryEom(amount) {
  return {
    id: 'amandaSalaryMonthEnd',
    label: 'Amanda salary — Tennis BC — month end',
    frequency: 'monthly',
    day: 31,
    amount: amount == null ? MONTH_END : amount,
    confidence: 'confirmed',
  };
}

function incomeSum(plan) {
  return F.expandEvents(plan, START, END, {})
    .filter(e => e.kind === 'income')
    .reduce((s, e) => s + Number(e.amount), 0);
}

function runAmanda(plan, extraObs) {
  return R.reconcile({
    data: { meta: { asOf: START }, plan },
    map: { mappings: [] },
    observations: [],
    settlements: emptySide(),
    utility: emptySide(),
    amandaObservations: extraObs || R.observationsFromAmanda(amanda),
  });
}

console.log('=== independent classified-movement identity ===');
ok(near(SALARY + TRANSFER, WRONG),
  'independent: $2,168.85 + $2,168.85 = $4,337.70',
  money(SALARY + TRANSFER));
ok(near(SALARY + MONTH_END, SALARY_MONTHLY),
  'independent: $2,168.85 + $2,387.99 = $4,556.84/month',
  money(SALARY + MONTH_END));
ok(near(KNOWN_COACHING - KNOWN_OBLIGATION, 100),
  'independent: Q25 coaching remainder is $400 − $300 = $100');

console.log('\n=== 1. salary + transfer is not $4,337.70 household income ===');
{
  const movements = [
    { fact: 'employment-deposit', amount: SALARY },
    { fact: 'household-transfer', amount: TRANSFER },
  ];
  const classified = R.householdCashFromAmandaMovements(movements);
  ok(near(classified, SALARY),
    'classified household-cash inflow is the salary once',
    money(classified));
  ok(!near(classified, WRONG),
    'classified household-cash inflow is not the naive $4,337.70 sum');
  ok(near(R.classifyAmandaMovement(movements[0]).newIncome, SALARY)
    && near(R.classifyAmandaMovement(movements[0]).householdCashInflow, SALARY)
    && near(R.classifyAmandaMovement(movements[0]).amandaOperatingIncome, 0),
    'salary is household income, not TENNIS INCOME operating income');
  ok(near(R.classifyAmandaMovement(movements[1]).householdCashInflow, 0)
    && near(R.classifyAmandaMovement(movements[1]).newIncome, 0),
    'a later household-transfer of the same dollars is $0 additional income');

  const plan = cashFixture([transferStream(TRANSFER)]);
  ok(near(incomeSum(plan), TRANSFER),
    'Forecast.expandEvents on transfer-only plan emits $2,168.85',
    money(incomeSum(plan)));

  const both = cashFixture([transferStream(TRANSFER), salaryStream(SALARY)]);
  ok(near(incomeSum(both), WRONG),
    'Forecast WOULD emit $4,337.70 if both streams were live — that is the defect',
    money(incomeSum(both)));
  ok(R.forecastHasAmandaDoubleCount({ plan: both }),
    'double-count detector fires when salary sits beside amandaTransfer');
  ok(!R.forecastHasAmandaDoubleCount({ plan }),
    'transfer-only plan is not a double-count');

  const liveLike = cashFixture([
    {
      id: 'amandaTransfer',
      label: "Amanda's transfers to the household",
      frequency: 'monthly',
      day: 20,
      scenarioMonthly: { conservative: 930, expected: 2182, optimistic: 2400 },
      confidence: 'estimated',
    },
  ]);
  const okRows = runAmanda(liveLike);
  const salaryRows = okRows.rows.filter(r => r.fact === 'employment-deposit');
  ok(salaryRows.length === 2 && salaryRows.every(r => r.status === 'MISSING'),
    'A. live-like salary observation is MISSING, not MATCH against amandaTransfer');
  ok(salaryRows.every(r => r.canonicalTarget === '(no canonical salary fact)'),
    'A. salary canonical target is no salary fact, not income:amandaTransfer');
  ok(salaryRows.every(r => r.status !== 'MATCH'),
    'A. salary is not MATCH while only amandaTransfer is present');
  ok(salaryRows.every(r => r.intentionallyNotPromoted)
    && salaryRows.every(r => r.representation === 'observed-not-promoted'),
    'B. transfer-only plan still has no canonical salary fact');
  ok(salaryRows.every(r => r.canonicalTarget === '(no canonical salary fact)'),
    'B. salary canonical target is no salary fact while only amandaTransfer is present');
  const badRows = runAmanda(both);
  ok(badRows.rows.filter(r => r.fact === 'employment-deposit').every(r => r.status === 'CONFLICT')
    && badRows.rows.filter(r => r.fact === 'employment-deposit').every(r => r.doubleCount),
    'C. adding Tennis BC salary beside amandaTransfer is CONFLICT');
  const noTransfer = runAmanda(cashFixture([]));
  const noTransferSalary = noTransfer.rows.filter(r => r.fact === 'employment-deposit');
  ok(noTransferSalary.length === 2 && noTransferSalary.every(r => r.status === 'MISSING')
    && noTransferSalary.every(r => r.status !== 'MATCH'),
    'D. removing amandaTransfer does not make the salary observation MATCH');
  const salaryOnlyOnce = runAmanda(cashFixture([salaryStream(SALARY)]));
  ok(salaryOnlyOnce.rows.filter(r => r.fact === 'employment-deposit').every(r => r.status !== 'MATCH'),
    'D. a once salary stream without 15th/month-end cadence is still not MATCH');
  const canonical = runAmanda(cashFixture([salary15(), salaryEom()]));
  const canonicalSalary = canonical.rows.filter(r => r.fact === 'employment-deposit');
  const mid = canonicalSalary.find(r => r.observationId === 'payday-amanda-salary-midmonth');
  const eom = canonicalSalary.find(r => r.observationId === 'payday-amanda-salary-monthend');
  ok(mid && mid.status === 'MATCH' && near(mid.evidenceValue, SALARY)
    && mid.canonicalTarget === 'income:amandaSalary15' && near(mid.canonicalValue, SALARY)
    && mid.landingAccount !== AMANDA,
    'E. $2,168.85 / 15th observation MATCHES the canonical 15th salary stream as Forecast income, not spendable TENNIS INCOME cash');
  ok(eom && eom.status === 'MATCH' && near(eom.evidenceValue, MONTH_END)
    && eom.canonicalTarget === 'income:amandaSalaryMonthEnd' && near(eom.canonicalValue, MONTH_END)
    && eom.landingAccount !== AMANDA,
    'E. $2,387.99 / month-end observation MATCHES the canonical month-end salary stream as Forecast income, not spendable TENNIS INCOME cash');
  ok(!R.forecastHasAmandaDoubleCount({ plan: cashFixture([salary15(), salaryEom()]) }),
    'E. the two salary streams without amandaTransfer are not a double-count');
}

console.log('\n=== 2. internal Amanda transfer creates $0 new income ===');
{
  const movements = [{
    fact: 'internal-transfer',
    amount: 500,
    from: AMANDA,
    to: 'amanda-other',
  }];
  ok(near(R.householdCashFromAmandaMovements(movements), 0),
    'classified household-cash inflow is $0');
  ok(near(R.classifyAmandaMovement(movements[0]).newIncome, 0)
    && near(R.classifyAmandaMovement(movements[0]).amandaOperatingIncome, 0),
    'internal movement creates $0 new income of any kind');
  const plan = cashFixture([]);
  ok(near(incomeSum(plan), 0),
    'Forecast.expandEvents with no income stream emits $0');
  const row = runAmanda(plan, [{
    observationId: 'synthetic-internal',
    fact: 'internal-transfer',
    evidenceValue: 500,
    evidenceDate: START,
  }]).rows.find(r => r.fact === 'internal-transfer');
  ok(row && row.status === 'MATCH' && near(row.canonicalValue, 0),
    'reconciler reports internal transfer as $0 new income');

  const labelled = cashFixture([{
    id: 'amanda-to-amanda',
    label: 'Internal Amanda transfer',
    frequency: 'once',
    date: START,
    amount: 500,
    confidence: 'estimated',
  }]);
  ok(near(incomeSum(labelled), 500),
    'Forecast WOULD count a labelled internal-transfer stream — that is the defect');
  const bad = runAmanda(labelled, [{
    observationId: 'synthetic-internal',
    fact: 'internal-transfer',
    evidenceValue: 500,
    evidenceDate: START,
  }]).rows.find(r => r.fact === 'internal-transfer');
  ok(bad && bad.status === 'CONFLICT',
    'an internal transfer modelled as Forecast income is CONFLICT');
}

console.log('\n=== 3. Amanda→joint transfer is not a second salary line ===');
{
  const movements = [{ fact: 'household-transfer', amount: TRANSFER }];
  ok(near(R.householdCashFromAmandaMovements(movements), 0),
    'classified household-cash inflow from a transfer-only movement is $0');
  const plan = cashFixture([transferStream(TRANSFER)]);
  const events = F.expandEvents(plan, START, END, {})
    .filter(e => e.id === 'amandaTransfer');
  ok(events.length === 1 && near(events[0].amount, TRANSFER),
    'Forecast WOULD emit amandaTransfer if that retired stream were restored — that is the defect');
  const sim = F.simulate(plan, START, { weeklyVariable: 0 });
  ok(near(sim.ending, OPENING + TRANSFER),
    'simulate ending would rise by the restored transfer stream',
    money(sim.ending));
  ok(near(sim.totals.income, TRANSFER),
    'simulate income total would count the restored transfer stream');
}

console.log('\n=== 4. coaching/business revenue alone is $0 household cash ===');
{
  const movements = [{ fact: 'coaching-receipt', amount: COACHING }];
  ok(near(R.householdCashFromAmandaMovements(movements), 0),
    'classified household-cash inflow from coaching is $0');
  ok(near(R.classifyAmandaMovement(movements[0]).coachingInflow, COACHING)
    && near(R.classifyAmandaMovement(movements[0]).householdCashInflow, 0),
    'coaching is a business inflow, not household income');
  const plan = cashFixture([]);
  ok(near(incomeSum(plan), 0),
    'Forecast.expandEvents does not invent a coaching income event');
  const liveLike = cashFixture([{
    id: 'amandaTransfer',
    label: "Amanda's transfers to the household",
    frequency: 'monthly',
    day: 20,
    scenarioMonthly: { conservative: 930, expected: 2182, optimistic: 2400 },
    confidence: 'estimated',
  }]);
  const row = runAmanda(liveLike).rows.find(r => r.fact === 'coaching-receipt');
  ok(row && row.status === 'MISSING' && row.status !== 'MATCH'
    && row.unknown && row.representation === 'business-inflow',
    'unresolved coaching receipt is MISSING, not MATCH, and still a business inflow');

  const asIncome = cashFixture([{
    id: 'coaching',
    label: 'Coaching revenue',
    frequency: 'once',
    date: START,
    amount: COACHING,
    confidence: 'estimated',
  }]);
  ok(near(incomeSum(asIncome), COACHING),
    'Forecast WOULD treat coaching as household income if it were a plan.income stream');
  const bad = runAmanda(asIncome).rows.find(r => r.fact === 'coaching-receipt');
  ok(bad && bad.status === 'CONFLICT',
    'a coaching Forecast income stream is CONFLICT');
}

console.log('\n=== 5. known business obligation reduces available remainder ===');
{
  const remainder = R.amandaHouseholdAvailable({
    employment: SALARY,
    coaching: KNOWN_COACHING,
    obligations: KNOWN_OBLIGATION,
    obligationsKnown: true,
  });
  const independent = KNOWN_COACHING - KNOWN_OBLIGATION;
  ok(remainder.established === true && near(remainder.amount, independent),
    'known obligations yield Q25 coaching remainder $100',
    money(remainder.amount));
  ok(remainder.amount < KNOWN_COACHING,
    'the obligation reduced the coaching remainder before household use');
  ok(!near(remainder.amount, SALARY + KNOWN_COACHING - KNOWN_OBLIGATION),
    'salary is not mixed into the TENNIS INCOME remainder');
  const movements = [
    { fact: 'employment-deposit', amount: SALARY },
    { fact: 'coaching-receipt', amount: KNOWN_COACHING },
    { fact: 'business-obligation', amount: KNOWN_OBLIGATION },
    { fact: 'household-transfer', amount: independent },
  ];
  ok(near(R.householdCashFromAmandaMovements(movements), SALARY),
    'household cash is the direct salary, not salary plus a later transfer');
  ok(!near(R.householdCashFromAmandaMovements(movements), SALARY + independent),
    'later transfer of coaching remainder is not a second income line');
}

console.log('\n=== remainder inputs fail closed unless every value is explicitly finite ===');
{
  const closed = extra => R.amandaHouseholdAvailable(Object.assign({
    obligationsKnown: true,
  }, extra));
  const missing = [
    { employment: null, coaching: 0, obligations: 0, label: 'null employment' },
    { employment: undefined, coaching: 0, obligations: 0, label: 'undefined employment' },
    { employment: 0, coaching: null, obligations: 0, label: 'null coaching' },
    { employment: 0, coaching: undefined, obligations: 0, label: 'undefined coaching' },
    { employment: 0, coaching: 0, obligations: null, label: 'null obligations' },
    { employment: 0, coaching: 0, obligations: undefined, label: 'undefined obligations' },
    { employment: NaN, coaching: 0, obligations: 0, label: 'NaN employment' },
    { employment: 0, coaching: NaN, obligations: 0, label: 'NaN coaching' },
    { employment: 0, coaching: 0, obligations: NaN, label: 'NaN obligations' },
    { employment: '2168.85', coaching: 0, obligations: 0, label: 'string employment' },
    { employment: 0, coaching: '0', obligations: 0, label: 'string coaching' },
    { employment: 0, coaching: 0, obligations: '300', label: 'string obligations' },
    { coaching: 0, obligations: 0, label: 'omitted employment' },
    { employment: 0, obligations: 0, label: 'omitted coaching' },
    { employment: 0, coaching: 0, label: 'omitted obligations' },
  ];
  for (const c of missing) {
    const r = closed(c);
    ok(r.established === false && r.amount == null,
      `${c.label} does not establish a remainder`);
  }
  ok(closed({ obligationsKnown: true }).established === false,
    'obligationsKnown true with all inputs missing does not collapse to zero');
  const explicitZero = closed({ employment: 0, coaching: 0, obligations: 0 });
  ok(explicitZero.established === true && near(explicitZero.amount, 0),
    'explicit numeric zeros establish remainder $0');
  const valid = closed({
    employment: SALARY, coaching: KNOWN_COACHING, obligations: KNOWN_OBLIGATION,
  });
  ok(valid.established === true && near(valid.amount, 100),
    'all three explicit finite numbers calculate coaching − obligations, not salary');
  const unknown = R.amandaHouseholdAvailable({
    obligationsKnown: false, employment: SALARY, coaching: 0, obligations: 0,
  });
  ok(unknown.established === false && unknown.amount == null
    && unknown.reason === 'unknown-business-obligations',
    'obligationsKnown !== true still fails closed even when numbers are present');
}

console.log('\n=== 6. unknown business obligations fail closed ===');
{
  const remainder = R.amandaHouseholdAvailable({
    employment: SALARY,
    coaching: 0,
    obligationsKnown: false,
  });
  ok(remainder.established === false && remainder.amount == null,
    'unknown obligations do not invent a remainder amount');
  ok(remainder.reason === 'unknown-business-obligations',
    'the unresolved reason is unknown-business-obligations');
  const guessed = SALARY - 0;
  ok(remainder.amount !== guessed,
    'fail-closed does not treat salary minus guessed $0 costs as available');
  ok(remainder.amount !== SESSION_BALANCE && remainder.amount == null,
    'the $798.37 session balance is not reported as household-available');

  const liveLike = cashFixture([{
    id: 'amandaTransfer',
    label: "Amanda's transfers to the household",
    frequency: 'monthly',
    day: 20,
    scenarioMonthly: { conservative: 930, expected: 2182, optimistic: 2400 },
    confidence: 'estimated',
  }]);
  ok(near(F.startingCashAmount(liveLike), OPENING),
    'held-elsewhere DEBT&PAYMENTS is not joint spendable cash');
  const avail = runAmanda(liveLike).rows.find(r => r.fact === 'household-available');
  ok(avail && avail.remainderEstablished === false && avail.evidenceValue == null,
    'matching held-elsewhere cash does not establish a household-available remainder');
  ok(avail.status === 'MATCH' && near(avail.canonicalValue, SESSION_BALANCE)
    && near(avail.difference, 0) && near(avail.observedBalance, SESSION_BALANCE),
    'observed DEBT&PAYMENTS balance still reconciles against the held-elsewhere row');

  const spendable = cashFixture([{
    id: 'amandaTransfer',
    label: "Amanda's transfers to the household",
    frequency: 'monthly',
    day: 20,
    scenarioMonthly: { conservative: 930, expected: 2182, optimistic: 2400 },
    confidence: 'estimated',
  }]);
  spendable.startingCash.breakdown.push({
    id: AMANDA, value: SESSION_BALANCE, class: 'spendable',
  });
  spendable.startingCash.heldElsewhere = [];
  const bad = runAmanda(spendable).rows.find(r => r.fact === 'household-available');
  ok(bad && bad.status === 'CONFLICT',
    'treating DEBT&PAYMENTS as spendable household cash is CONFLICT');
}

console.log('\n=== Aug. 14 unresolved monetary facts are not MATCH ===');
{
  const liveLike = cashFixture([{
    id: 'amandaTransfer',
    label: "Amanda's transfers to the household",
    frequency: 'monthly',
    day: 20,
    scenarioMonthly: { conservative: 930, expected: 2182, optimistic: 2400 },
    confidence: 'estimated',
  }]);
  const held = liveLike.startingCash.heldElsewhere.find(r => r.id === AMANDA);
  ok(held && held.class === 'operational',
    'fixture DEBT&PAYMENTS is operational held-elsewhere — classification of where cash sits');
  const result = runAmanda(liveLike);
  const coaching = result.rows.find(r => r.observationId === 'payday-amanda-coaching-receipt');
  const obligation = result.rows.find(r => r.observationId === 'payday-amanda-business-obligation');
  const available = result.rows.find(r => r.observationId === 'payday-amanda-household-available');

  ok(coaching && coaching.unknown && coaching.evidenceValue == null,
    'Aug. 14 coaching receipt amount is unresolved');
  ok(coaching.status === 'MISSING' && coaching.status !== 'MATCH',
    'unknown coaching receipt is MISSING, not MATCH, even with no Forecast coaching stream');
  ok(coaching.representation === 'business-inflow'
    && /business inflow/i.test(coaching.note || ''),
    'coaching classification remains business inflow, not household income');

  ok(obligation && obligation.unknown && obligation.evidenceValue == null
    && obligation.remainderEstablished === false,
    'Aug. 14 business obligation amount is unresolved');
  ok(obligation.status === 'MISSING' && obligation.status !== 'MATCH',
    'unknown business obligation is MISSING, not MATCH, despite operational DEBT&PAYMENTS');
  ok(/fail closed|unresolved/i.test(obligation.note || ''),
    'obligation note still fail-closes the remainder');

  ok(available && available.remainderEstablished === false
    && available.evidenceValue == null
    && near(available.observedBalance, SESSION_BALANCE),
    'Aug. 14 household-available remainder is unestablished; $798.37 is evidence only');
  ok(available.status === 'MATCH' && available.status !== 'MISSING'
    && near(available.canonicalValue, SESSION_BALANCE)
    && near(available.difference, 0),
    'unestablished remainder does not hide a matching held-elsewhere balance compare');
  ok(/unresolved|not spendable|fail closed/i.test(available.note || ''),
    'remainder note still says unresolved / not spendable');
}

console.log('\n=== DEBT&PAYMENTS observed balance is reconciled against held-elsewhere ===');
{
  const independentDiff = Math.round((SESSION_BALANCE - CANONICAL_HELD) * 100) / 100;
  ok(near(independentDiff, -1893.48),
    'independent: $798.37 − $2,691.85 = −$1,893.48',
    money(independentDiff));

  const changed = cashFixture([{
    id: 'amandaTransfer',
    label: "Amanda's transfers to the household",
    frequency: 'monthly',
    day: 20,
    scenarioMonthly: { conservative: 930, expected: 2182, optimistic: 2400 },
    confidence: 'estimated',
  }]);
  changed.startingCash.heldElsewhere[0].value = CANONICAL_HELD;
  ok(changed.startingCash.heldElsewhere[0].class === 'operational',
    'fixture keeps DEBT&PAYMENTS operational / non-spendable');
  const available = runAmanda(changed).rows.find(r => r.fact === 'household-available');
  ok(available && available.status === 'CHANGE'
    && near(available.observedBalance, SESSION_BALANCE)
    && near(available.canonicalValue, CANONICAL_HELD)
    && near(available.difference, independentDiff)
    && available.canonicalTarget === `cash:${AMANDA}`
    && available.remainderEstablished === false,
    'Aug. 14 $798.37 vs canonical held-elsewhere $2,691.85 is CHANGE for owner reconciliation');
}

console.log('\n=== established remainder state is preserved ===');
{
  const liveLike = cashFixture([{
    id: 'amandaTransfer',
    label: "Amanda's transfers to the household",
    frequency: 'monthly',
    day: 20,
    scenarioMonthly: { conservative: 930, expected: 2182, optimistic: 2400 },
    confidence: 'estimated',
  }]);
  const established = runAmanda(liveLike, [{
    observationId: 'owner-established-remainder',
    fact: 'household-available',
    accountLabel: 'Household-available Amanda remainder',
    evidenceValue: 2268.85,
    evidenceDate: START,
    established: true,
    observedBalance: SESSION_BALANCE,
    landingAccount: AMANDA,
  }]).rows.find(r => r.observationId === 'owner-established-remainder');
  ok(established && established.remainderEstablished === true
    && near(established.evidenceValue, 2268.85),
    'owner-established remainder is reported established, not hard-coded unresolved');
  ok(established.status === 'MATCH' && near(established.canonicalValue, SESSION_BALANCE)
    && near(established.difference, 0),
    'established remainder still reconciles the observed DEBT&PAYMENTS balance');

  const missingBalance = runAmanda(liveLike, [{
    observationId: 'established-without-balance',
    fact: 'household-available',
    accountLabel: 'Household-available Amanda remainder',
    evidenceValue: 2268.85,
    evidenceDate: START,
    established: true,
    landingAccount: AMANDA,
  }]).rows.find(r => r.observationId === 'established-without-balance');
  ok(missingBalance && missingBalance.remainderEstablished === true
    && near(missingBalance.evidenceValue, 2268.85)
    && missingBalance.status === 'MISSING',
    'established remainder stays established even when no observed balance can be compared');
}

console.log('\n=== 7. live Tennis BC salary Forecast behaviour ===');
{
  ok(!live.plan.income.some(s => s.id === 'amandaTransfer'),
    'live plan.income has no amandaTransfer stream');
  const mid = live.plan.income.find(s => s.id === 'amandaSalary15');
  const eom = live.plan.income.find(s => s.id === 'amandaSalaryMonthEnd');
  ok(mid && mid.frequency === 'monthly' && mid.day === 15 && near(mid.amount, SALARY)
    && mid.confidence === 'confirmed' && mid.firstDue === '2026-09-15',
    'live 15th salary is $2,168.85 confirmed monthly on day 15, firstDue 2026-09-15');
  ok(eom && eom.frequency === 'monthly' && eom.day === 31 && near(eom.amount, MONTH_END)
    && eom.confidence === 'confirmed' && !eom.firstDue,
    'live month-end salary is $2,387.99 confirmed monthly on day 31');
  ok(near(mid.amount + eom.amount, SALARY_MONTHLY),
    'live fixed Amanda monthly salary is $4,556.84',
    money(mid.amount + eom.amount));
  ok(!live.plan.income.some(s => /coach|business.?receipt/i.test(`${s.id || ''} ${s.label || ''}`)),
    'live Forecast base income includes no coaching stream');
  ok(!R.forecastHasAmandaDoubleCount(live),
    'live data does not double-count salary plus transfer');
  ok(!(live.plan.actions || []).some(a => /standing transfer/i.test(a.what || '')),
    'live plan has no standing Amanda-transfer action');
  ok(!(live.plan.actions || []).some(a => a.amount === 1100 && /Amanda/i.test(a.what || '')),
    'retired $1,100 Amanda standing-transfer action is absent');
  ok(amanda.observations.filter(o => o.fact === 'employment-deposit')
    .every(o => o.landingAccount !== AMANDA),
    'D2 salary observations MATCH Forecast streams and do not treat TENNIS INCOME as spendable household cash');

  const asOf = live.meta.asOf;
  const windowEnd = F.addDays(asOf, live.plan.windowDays - 1);
  const midDates = F.occurrences(mid, asOf, windowEnd);
  const eomDates = F.occurrences(eom, asOf, windowEnd);
  ok(midDates.every(d => d.slice(-2) === '15'),
    'every 15th-salary occurrence is on a 15th');
  ok(midDates.every(d => d >= '2026-09-15'),
    'August 15 salary is not replayed after firstDue 2026-09-15');
  ok(!midDates.some(d => d < asOf),
    'no 15th-salary event is before as-of');
  const eomEvents = F.expandEvents(live.plan, asOf, windowEnd, { scenario: 'expected' })
    .filter(e => e.id === 'amandaSalaryMonthEnd');
  const midEvents = F.expandEvents(live.plan, asOf, windowEnd, { scenario: 'expected' })
    .filter(e => e.id === 'amandaSalary15');
  ok(midEvents.length === midDates.length && midEvents.every(e => near(e.amount, SALARY)),
    'Forecast emits one $2,168.85 event on each in-window 15th');
  ok(eomEvents.length === eomDates.length && eomEvents.every(e => near(e.amount, MONTH_END)),
    'Forecast emits one $2,387.99 event on each in-window month-end');
  ok(eomDates.includes('2026-08-31'),
    'August month-end salary is in-window on this 2026-08-19 opening');
  const independent = midDates.length * SALARY + eomDates.length * MONTH_END;
  const emitted = midEvents.concat(eomEvents).reduce((s, e) => s + e.amount, 0);
  ok(near(emitted, independent),
    'live Amanda salary total equals occurrences × the two fixed nets',
    money(independent));

  const feb = F.occurrences(eom, '2026-02-01', '2026-02-28');
  const apr = F.occurrences(eom, '2026-04-01', '2026-04-30');
  const jan = F.occurrences(eom, '2026-01-01', '2026-01-31');
  ok(feb.length === 1 && feb[0] === '2026-02-28',
    'February month-end salary lands on 28 February 2026');
  ok(apr.length === 1 && apr[0] === '2026-04-30',
    'April month-end salary lands on 30 April');
  ok(jan.length === 1 && jan[0] === '2026-01-31',
    'January month-end salary lands on 31 January');

  const held = (live.plan.startingCash.heldElsewhere || [])
    .find(r => r.id === AMANDA);
  ok(held && held.class === 'operational' && near(held.value, CANONICAL_HELD),
    'live DEBT&PAYMENTS is still operational $2,691.85, not spendable');
  ok(near(F.startingCashAmount(live.plan), 629.27 + 309.77),
    'Amanda operating-account balance is excluded from spendable starting cash');
}

console.log('\n=== circular transfer observation is not copied canonical evidence ===');
{
  const raw = fs.readFileSync(R.DEFAULT_AMANDA, 'utf8');
  ok(!/"expected"\s*:\s*2182/.test(raw) && !/"conservative"\s*:\s*930/.test(raw)
    && !/"optimistic"\s*:\s*2400/.test(raw),
    'Aug. 14 observation file does not copy amandaTransfer 930 / 2,182 / 2,400');
  ok(!amanda.observations.some(o => o.fact === 'household-transfer'
    && o.scenarioMonthly && o.scenarioMonthly.expected === 2182),
    'no household-transfer observation claims the canonical expected amount');

  function transferPlan(expected) {
    return cashFixture([{
      id: 'amandaTransfer',
      label: "Amanda's transfers to the household",
      frequency: 'monthly',
      day: 20,
      scenarioMonthly: { conservative: 930, expected, optimistic: 2400 },
      confidence: 'estimated',
    }]);
  }
  const at2182 = runAmanda(transferPlan(2182));
  const at9999 = runAmanda(transferPlan(9999));
  const copiedMatch = row => row.fact === 'household-transfer'
    && row.status === 'MATCH'
    && row.evidenceValue != null
    && near(row.evidenceValue, 2182);
  ok(!at2182.rows.some(copiedMatch),
    'canonical expected $2,182 does not create an Aug. 14 MATCH of copied evidence');
  ok(!at9999.rows.some(copiedMatch),
    'changing canonical expected to $9,999 does not leave a copied $2,182 MATCH');
  ok(at2182.amandaTransferAuthority && at2182.amandaTransferAuthority.transferPresent
    && at2182.amandaTransferAuthority.locator === 'income:amandaTransfer'
    && near(at2182.amandaTransferAuthority.canonicalExpected, 2182)
    && at2182.amandaTransferAuthority.independentlyVerifiedByPaydayEvidence === false,
    'report still names income:amandaTransfer as incumbent canonical context at $2,182 when only the transfer stream is present');
  ok(at9999.amandaTransferAuthority && near(at9999.amandaTransferAuthority.canonicalExpected, 9999)
    && at9999.amandaTransferAuthority.independentlyVerifiedByPaydayEvidence === false,
    'canonical context follows the mutated expected amount and is still not payday-verified');

  const copied = runAmanda(transferPlan(9999), [{
    observationId: 'copied-canonical-transfer',
    fact: 'household-transfer',
    scenarioMonthly: { conservative: 930, expected: 2182, optimistic: 2400 },
    independentlyObserved: false,
    canonical: { collection: 'income', id: 'amandaTransfer' },
    evidenceDate: START,
  }]);
  const copiedRow = copied.rows.find(r => r.observationId === 'copied-canonical-transfer');
  ok(copiedRow && copiedRow.evidenceValue == null,
    'a non-independent transfer row does not keep copied $2,182 as evidence');
  ok(!(copiedRow && copiedRow.status === 'MATCH' && near(copiedRow.evidenceValue, 2182)),
    'copied $2,182 cannot MATCH a mutated canonical expected');
}

console.log('\n=== 8. reconciliation performs no writes ===');
{
  const before = hashFile(R.DEFAULT_DATA);
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reconcile.js'), 'utf8');
  ok(!/writeFileSync?\s*\(\s*DEFAULT_DATA/.test(src),
    'reconcile.js source does not write DEFAULT_DATA');
  ok(!/writeFileSync?\s*\([^)]*data\.json/.test(src),
    'reconcile.js source does not write data.json by path');

  const result = R.reconcile({
    data: live,
    map: { mappings: [] },
    observations: [],
    settlements: emptySide(),
    utility: emptySide(),
    amanda,
  });
  ok(result.writesCanonicalState === false, 'reconcile result declares no write');
  const salaryMid = result.rows.find(r => r.observationId === 'payday-amanda-salary-midmonth');
  const salaryEnd = result.rows.find(r => r.observationId === 'payday-amanda-salary-monthend');
  const transfer = result.rows.find(r => r.observationId === 'payday-amanda-household-transfer-model');
  const coaching = result.rows.find(r => r.observationId === 'payday-amanda-coaching-receipt');
  const obligation = result.rows.find(r => r.observationId === 'payday-amanda-business-obligation');
  const available = result.rows.find(r => r.observationId === 'payday-amanda-household-available');
  ok(salaryMid && salaryMid.status === 'MATCH' && near(salaryMid.evidenceValue, SALARY)
    && salaryMid.canonicalTarget === 'income:amandaSalary15'
    && near(salaryMid.canonicalValue, SALARY)
    && salaryMid.intentionallyNotPromoted === false
    && salaryMid.landingAccount !== AMANDA,
    'live mid-month $2,168.85 MATCHES the canonical 15th salary stream as Forecast income, not spendable TENNIS INCOME cash');
  ok(salaryEnd && salaryEnd.status === 'MATCH' && near(salaryEnd.evidenceValue, MONTH_END)
    && salaryEnd.canonicalTarget === 'income:amandaSalaryMonthEnd'
    && near(salaryEnd.canonicalValue, MONTH_END)
    && salaryEnd.intentionallyNotPromoted === false
    && salaryEnd.landingAccount !== AMANDA,
    'live month-end $2,387.99 MATCHES the canonical month-end salary stream as Forecast income, not spendable TENNIS INCOME cash');
  ok(!transfer,
    'Aug. 14 file has no household-transfer observation that copies canonical amounts');
  ok(result.amandaTransferAuthority && result.amandaTransferAuthority.salaryPresent
    && result.amandaTransferAuthority.transferPresent === false
    && /amandaSalary15/.test(result.amandaTransferAuthority.locator)
    && /amandaSalaryMonthEnd/.test(result.amandaTransferAuthority.locator)
    && near(result.amandaTransferAuthority.canonicalExpected, SALARY_MONTHLY)
    && result.amandaTransferAuthority.independentlyVerifiedByPaydayEvidence === true,
    'live authority is the two salary streams at $4,556.84, payday-verified');
  ok(coaching && coaching.status === 'MISSING' && coaching.status !== 'MATCH'
    && coaching.unknown && coaching.representation === 'business-inflow',
    'live coaching receipt is unresolved MISSING, not MATCH, and still a business inflow');
  ok(obligation && obligation.status === 'MISSING' && obligation.status !== 'MATCH'
    && obligation.unknown && obligation.remainderEstablished === false,
    'live business obligation is unknown MISSING, not MATCH, and fail-closed');
  ok(available && available.remainderEstablished === false
    && available.evidenceValue == null
    && near(available.observedBalance, SESSION_BALANCE),
    'live household-available remainder is still unestablished');
  ok(available.status === 'CHANGE' && available.status !== 'MISSING'
    && near(available.canonicalValue, CANONICAL_HELD)
    && near(available.difference, Math.round((SESSION_BALANCE - CANONICAL_HELD) * 100) / 100)
    && available.canonicalTarget === `cash:${AMANDA}`,
    'live $798.37 vs held-elsewhere $2,691.85 is CHANGE, not hidden behind remainder MISSING');

  ok(hashFile(R.DEFAULT_DATA) === before, 'calling reconcile() does not change data.json');

  const cliBefore = hashFile(R.DEFAULT_DATA);
  const out = execFileSync(process.execPath, ['scripts/reconcile.js'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  ok(/does not write data\.json/.test(out),
    'CLI report repeats the no-write contract');
  ok(/Amanda income \/ coaching \/ transfer distinctions/.test(out),
    'CLI names the Amanda income split');
  ok(/no canonical salary fact/.test(out) === false
    || /MATCH against income:amandaSalary/.test(out),
    'CLI reports salary as MATCH against canonical salary streams');
  ok(/MATCH against income:amandaSalary15/.test(out)
    && /MATCH against income:amandaSalaryMonthEnd/.test(out),
    'CLI MATCHES both salary observations to their canonical rows');
  ok(/owner-confirmed Tennis BC salary is Forecast household income/.test(out),
    'CLI reports the two salary streams as Forecast household income');
  ok(!/intentionally not promoted/.test(out),
    'CLI no longer says salary is intentionally not promoted');
  ok(/remainder unresolved/.test(out),
    'CLI reports household-available remainder as unresolved');
  ok(/798\.37/.test(out) && /2691\.85/.test(out),
    'CLI surfaces the Aug. 14 DEBT&PAYMENTS balance against canonical held-elsewhere');
  ok(hashFile(R.DEFAULT_DATA) === cliBefore,
    'CLI reconcile does not write data.json');
}

console.log('\n=== Forecast.expandEvents remains the household-cash authority ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  ok(/function expandEvents\(plan, start, end, opts\)/.test(src),
    'expandEvents is still the Plan schedule expander');
  ok(!/function expandAmanda|amandaLedger|amandaPayrollEngine/.test(src),
    'no second Amanda expander, ledger, or payroll engine was added');
  ok(!/function classifyAmandaMovement/.test(src),
    'Amanda movement classification lives on the reconciler path, not Forecast');
}

console.log('\n=== live Fusion / Hydro / HELOC / card surfaces ===');
{
  const camp = live.plan.commitments.find(c => c.id === 'fusioncamp');
  const tryouts = live.plan.commitments.find(c => c.id === 'tryouts');
  const instalments = (live.plan.commitments || [])
    .filter(c => /fusion/i.test(c.id + c.label) && near(c.amount, 500));
  ok(camp && near(camp.amount, 786) && camp.settledOn === START,
    'live Fusion camp is the $786 row with settledOn 2026-08-14');
  ok(tryouts && near(tryouts.amount, 140) && tryouts.settledOn === START,
    'live Fusion tryouts are the $140 row with settledOn 2026-08-14');
  ok(instalments.length === 0,
    'the three stale $500 Fusion season instalments are gone');
  const liveHydro = (live.plan.bills || []).filter(b => /hydro/i.test(b.id + b.label));
  ok(liveHydro.some(b => b.id === 'hydro-due-sep1')
      && liveHydro.some(b => b.id === 'hydro-equal-payment')
      && liveHydro.length === 2,
    'live plan.bills has the 1 September Hydro dated due and the $199 equal-payment series');
  ok(!liveHydro.some(b => b.id === 'hydro-due-now'),
    'the 14 August Hydro due is still absent');
  const heloc = live.plan.obligations.find(o => o.id === 'heloc');
  ok(heloc && heloc.nonCash === true && near(heloc.amount, 814.18),
    'live HELOC capitalisation is untouched');
  const cards = ['cashback', 'travel', 'mbna', 'triangle']
    .map(id => live.debts.find(d => d.id === id))
    .filter(Boolean);
  ok(cards.length >= 3, 'live card debt rows remain present');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
