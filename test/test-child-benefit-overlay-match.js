'use strict';
/* Privacy-stripped Canada Child Benefit overlay must not double-count.
 *
 * Live overlay Income credits have payee/merchant stripped, so the
 * CHILD TAX BEN / CCB blob in txMatchesScheduledIncome misses them.
 * A unique chequing-b credit equal to plan.income.childBenefit in the
 * Friday-before-Sunday / same-day window around scheduled day 20
 * represents that occurrence once: omit from Other income, mark the
 * scheduled row paid/represented, and keep incomeTotal to one copy.
 *
 * Independent arithmetic (L-002 / L-006): fixture Dale + one fixture
 * CCB amount + genuine other income. Not a live-cent specification.
 *
 * `node test/test-child-benefit-overlay-match.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;

const PAYDAY = '2026-09-11';
const ASOF = '2026-09-18';
const CCB_DUE = '2026-09-20';
const DALE = 2000;
const CCB = 219.45;
const TRAVEL = 103.93;
const WRONG_AMT = 200;

const debts = [
  {
    id: 'cashback', label: 'Synthetic card', secured: false,
    structure: 'Revolving — test', balance: 200, rate: 19.99, payment: 20, pending: 0,
  },
];

function ccbPlan() {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: {
      amount: 1000,
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 700 },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: 300 },
      ],
    },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: {
      asOf: ASOF,
      priorAsOf: PAYDAY,
      representedEvents: [],
    },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'childBenefit', label: 'Child benefit', frequency: 'monthly',
        day: 20, amount: CCB, confidence: 'confirmed',
      },
    ],
    bills: [],
    obligations: [],
    commitments: [],
    budget: { categories: [] },
  };
}

function actualsPacket(txs, representedActuals) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: ASOF,
    coverageStart: PAYDAY,
    coverageThrough: ASOF,
    pendingCoverage: 'complete',
    transactions: txs,
    representedActuals: representedActuals || [],
  };
}

function incomeTx(id, date, amount, extra) {
  return Object.assign({
    id,
    date,
    amount,
    pending: false,
    categoryLabel: 'Income',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-b',
    isIncome: true,
    displayedPayee: null,
    originalMerchant: null,
    payee: null,
  }, extra || {});
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p && p.id === id);
}

function recommend(txs, extraOpts) {
  return F.recommend(ccbPlan(), ASOF, Object.assign({
    targetBuffer: 0,
    debts,
    currentPeriodActuals: actualsPacket(txs || []),
  }, extraOpts || {}));
}

function childRow(active) {
  return ((active && active.income) || [])
    .find(r => r && r.id === 'childBenefit' && r.date === CCB_DUE);
}

function otherItems(active) {
  return ((active && active.otherIncome && active.otherIncome.items) || []);
}

function otherHasAmount(active, amount) {
  return otherItems(active).some(r => r && near(r.amount, amount));
}

console.log('=== 1. Null-payee Friday CCB overlay represents Sunday childBenefit once ===');
{
  const ccbTx = incomeTx('tx-429', ASOF, -CCB);
  const travelTx = incomeTx('tx-travelvisa', ASOF, -TRAVEL);
  const advice = recommend([ccbTx, travelTx]);
  const active = period(advice.defaultView, 'this-pay-period');
  const child = childRow(active);
  const items = otherItems(active);
  const otherCcb = items.filter(r => r && (r.id === 'other-income:tx-429' || near(r.amount, CCB)));
  const travelRows = items.filter(r => r && r.id === 'other-income:tx-travelvisa');
  const childCount = ((active.income || []).filter(r => r && r.id === 'childBenefit')).length;
  const independentOther = TRAVEL;
  const independentTotal = roundCent(DALE + CCB + TRAVEL);
  const doubleTotal = roundCent(DALE + CCB + CCB + TRAVEL);

  ok(active && active.start === PAYDAY && active.end === '2026-09-24',
    'This Pay Period is the Sep 11–24 Seaspan cycle containing Sep 18 and Sep 20',
    active && `${active.start}–${active.end}`);
  ok(childCount === 1 && child && near(child.amount, CCB),
    'scheduled childBenefit remains one named row at 219.45');
  ok(child && child.settlement === 'represented' && child.status === 'received'
      && child.alreadyInCash === true,
    'childBenefit is represented/received, not arriving',
    child && `${child.status} / ${child.settlement}`);
  ok(otherCcb.length === 0 && !otherHasAmount(active, CCB),
    'Other income does not include the 219.45 overlay credit');
  ok(travelRows.length === 1 && near(travelRows[0].amount, TRAVEL)
      && travelRows[0].status === 'received',
    'Sep 18 travelvisa other income is unchanged');
  ok(near(active.otherIncome.amount, independentOther),
    'Other Income independently equals the travelvisa only');
  ok(near(active.incomeTotal, independentTotal),
    'incomeTotal independently equals Dale + one CCB + travelvisa');
  ok(!near(active.incomeTotal, doubleTotal),
    'incomeTotal is not the double-count of CCB plus other income');
}

console.log('\n=== 2. Same-day null-payee CCB overlay also represents childBenefit ===');
{
  const dueAsOf = CCB_DUE;
  const plan = ccbPlan();
  plan.opening.asOf = dueAsOf;
  plan.opening.priorAsOf = PAYDAY;
  const ccbTx = incomeTx('tx-429-sameday', dueAsOf, -CCB);
  const advice = F.recommend(plan, dueAsOf, {
    targetBuffer: 0,
    debts,
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: dueAsOf,
      coverageStart: PAYDAY,
      coverageThrough: dueAsOf,
      pendingCoverage: 'complete',
      transactions: [ccbTx],
      representedActuals: [],
    },
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const child = childRow(active);
  const independentTotal = roundCent(DALE + CCB);
  ok(child && child.settlement === 'represented' && child.status === 'received',
    'same-day chequing-b overlay marks childBenefit represented');
  ok(!otherHasAmount(active, CCB),
    'same-day overlay is omitted from Other income');
  ok(near(active.incomeTotal, independentTotal),
    'same-day incomeTotal counts CCB once');
}

console.log('\n=== 3. Before the Friday window fails closed ===');
{
  const early = incomeTx('tx-early', '2026-09-17', -CCB);
  const advice = recommend([early]);
  const active = period(advice.defaultView, 'this-pay-period');
  const child = childRow(active);
  const items = otherItems(active);
  const earlyRows = items.filter(r => r && r.id === 'other-income:tx-early');
  ok(child && child.status === 'arriving' && child.settlement !== 'represented',
    'Thursday 219.45 does not mark Sunday childBenefit paid',
    child && `${child.status} / ${child.settlement}`);
  ok(earlyRows.length === 1 && near(earlyRows[0].amount, CCB),
    'credit before the Friday-before-Sunday window stays Other income');
}

console.log('\n=== 4. Wrong amount fails closed ===');
{
  const wrong = incomeTx('tx-wrong-amt', ASOF, -WRONG_AMT);
  const advice = recommend([wrong]);
  const active = period(advice.defaultView, 'this-pay-period');
  const child = childRow(active);
  ok(child && child.status === 'arriving' && child.settlement !== 'represented',
    'chequing-b credit that is not 219.45 does not settle childBenefit');
  ok(otherHasAmount(active, WRONG_AMT) && !otherHasAmount(active, CCB),
    'wrong-amount credit stays Other income at its own amount');
}

console.log('\n=== 5. Wrong account fails closed ===');
{
  const bills = incomeTx('tx-wrong-acct', ASOF, -CCB, { atlasAccountId: 'chequing-a' });
  const advice = recommend([bills]);
  const active = period(advice.defaultView, 'this-pay-period');
  const child = childRow(active);
  ok(child && child.status === 'arriving' && child.settlement !== 'represented',
    'chequing-a 219.45 does not settle WEEKLY childBenefit');
  ok(otherHasAmount(active, CCB),
    'wrong-account credit stays Other income');
}

console.log('\n=== 6. Two equal Friday credits fail closed (uniqueness) ===');
{
  const a = incomeTx('tx-ccb-a', ASOF, -CCB);
  const b = incomeTx('tx-ccb-b', ASOF, -CCB);
  const advice = recommend([a, b]);
  const active = period(advice.defaultView, 'this-pay-period');
  const child = childRow(active);
  const ccbOthers = otherItems(active).filter(r => r && near(r.amount, CCB));
  // Early-income settlement: the Sunday occurrence's cash may already be
  // in the opening, so ambiguity withholds it (not relied upon) instead of
  // leaving it arriving, where the walk would add it a second time.
  ok(child && child.status !== 'received' && child.settlement !== 'represented'
      && child.notReliedUpon === true && child.notReliedUponReason === 'early-inbound-ambiguous',
    'two 219.45 credits do not uniquely represent childBenefit; the occurrence is withheld',
    JSON.stringify(child && [child.status, child.settlement, child.notReliedUponReason]));
  ok(ccbOthers.length === 2,
    'both ambiguous credits remain Other income',
    String(ccbOthers.length));
}

if (failures) {
  console.log('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nAll child-benefit overlay-match checks passed.');
