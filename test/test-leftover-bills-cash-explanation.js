'use strict';
/* Payday leftover vs posted BILLS ACCOUNT cash explanation.
 *
 * Leftover after household budget is Balance After Deductions
 * (income − bills − Household Budget hold). Current Balance is posted
 * planning-hub cash (canonical chequing-a / BILLS ACCOUNT). BILLS cash
 * is the same hub row. Proven household-internal movements may describe a
 * BILLS-location effect without becoming leftover income, leftover
 * spending, or a BILLS cash walk. Forecast owns the packet; the page
 * helper reprints it as a diagnostic.
 *
 * Independent reconstruction does not call the producing helper (L-002).
 * Synthetic amounts only (L-006).
 *
 * `node test/test-leftover-bills-cash-explanation.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(planSrc, /^function operatingCashExplanationHtml\([\s\S]*?\n\}$/m, 'operatingCashExplanationHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ operatingCashExplanationHtml, money2 });`,
    { Forecast: F }
  );
}

const PAYDAY = '2026-09-11';
const BILLS_TO_SAVINGS = 80;
const BILLS_TO_WEEKLY = 25;
const SAVINGS_TO_BILLS = 40;
const WEEKLY_TO_SAVINGS = 15;
const UNPAIRED = 40;
const GROCERY = 18.56;
const DALE = 2000;
const AMANDA = 1500;
const BILLS = 700;
const WEEKLY = 200;
const SAVINGS = 100;
const TENNIS = 4000;

const OPERATING_IDS = new Set(['chequing-a', 'chequing-b']);
const CASH_LOCATIONS = new Set(['chequing-a', 'chequing-b', 'savings']);
const TFR_RE = /\b([A-Z]{2}\d{3})\s+TFR-(TO|FR)\b/i;

function paydayPlan() {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: {
      amount: BILLS + WEEKLY + SAVINGS,
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: BILLS },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: WEEKLY },
        { id: 'savings', label: 'EMERGENCY SAVING', value: SAVINGS },
      ],
      heldElsewhere: [
        { id: 'amanda-debt-payments', label: 'TENNIS INCOME', value: TENNIS },
      ],
    },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: { asOf: PAYDAY, representedEvents: [{ id: 'payroll', date: PAYDAY }] },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaPayday', label: 'Amanda income', frequency: 'once',
        date: PAYDAY, amount: AMANDA, confidence: 'confirmed',
      },
    ],
    bills: [],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          plannedMonthly: 450, ownerLine: 'Groceries',
        },
      ],
    },
  };
}

function packet(txs) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: PAYDAY,
    coverageStart: PAYDAY,
    coverageThrough: PAYDAY,
    pendingCoverage: 'complete', transactionCoverage: 'complete',
    transactions: txs,
    representedActuals: [],
  };
}

function tfrLeg(opts) {
  const dir = opts.dir;
  const amount = dir === 'TO' ? opts.amount : -opts.amount;
  return {
    id: opts.id,
    date: Object.prototype.hasOwnProperty.call(opts, 'date') ? opts.date : PAYDAY,
    amount,
    pending: opts.pending === true,
    categoryLabel: opts.categoryLabel || 'Payment, Transfer',
    accountRole: opts.accountRole || 'household-cash',
    atlasAccountId: opts.atlasAccountId,
    account: opts.atlasAccountId,
    excludeFromTotals: true,
    kindHint: opts.kindHint || 'transfer',
    displayedPayee: opts.payee,
    originalMerchant: opts.payee,
    isIncome: opts.isIncome === true,
  };
}

function parseIndependentTfr(tx) {
  if (!tx) return null;
  if (tx.tfrReference && (tx.tfrDirection === 'TO' || tx.tfrDirection === 'FR')) {
    return {
      ref: String(tx.tfrReference).toUpperCase(),
      dir: String(tx.tfrDirection).toUpperCase(),
    };
  }
  const blob = [tx.displayedPayee, tx.originalMerchant, tx.payee]
    .filter(Boolean).join(' ');
  const match = TFR_RE.exec(blob);
  if (!match) return null;
  return { ref: match[1].toUpperCase(), dir: match[2].toUpperCase() };
}

function independentCashLocation(tx) {
  if (!tx || tx.accountRole !== 'household-cash') return null;
  const id = String(tx.atlasAccountId || tx.account || '').trim();
  return CASH_LOCATIONS.has(id) ? id : null;
}

function independentPairs(txs) {
  const groups = new Map();
  for (const tx of txs || []) {
    if (!tx || tx.pending === true || tx.id == null) continue;
    const parsed = parseIndependentTfr(tx);
    const loc = independentCashLocation(tx);
    if (!parsed || !loc) continue;
    const amt = Number(tx.amount);
    if (parsed.dir === 'TO' && !(amt > 0)) continue;
    if (parsed.dir === 'FR' && !(amt < 0)) continue;
    const list = groups.get(parsed.ref) || [];
    list.push({ tx, parsed, loc, amt });
    groups.set(parsed.ref, list);
  }
  const out = [];
  groups.forEach((legs, ref) => {
    if (legs.length !== 2) return;
    const left = legs[0];
    const right = legs[1];
    if (left.parsed.dir === right.parsed.dir) return;
    if (left.loc === right.loc) return;
    if (roundCent(Math.abs(left.amt)) !== roundCent(Math.abs(right.amt))) return;
    const source = left.parsed.dir === 'TO' ? left : right;
    const dest = left.parsed.dir === 'FR' ? left : right;
    out.push({
      amount: roundCent(Math.abs(source.amt)),
      sourceAccountId: source.loc,
      destinationAccountId: dest.loc,
      sourceTransactionId: String(source.tx.id),
      destinationTransactionId: String(dest.tx.id),
      tfrReference: ref,
      householdAssetDelta: roundCent(source.amt + dest.amt),
    });
  });
  return out;
}

function independentOperatingCash(plan) {
  const rows = (plan && plan.startingCash && plan.startingCash.breakdown) || [];
  return roundCent(rows.reduce((sum, row) => {
    if (!row || !OPERATING_IDS.has(row.id)) return sum;
    return roundCent(sum + (Number(row.value) || 0));
  }, 0));
}

function independentBillsCash(plan) {
  const rows = (plan && plan.startingCash && plan.startingCash.breakdown) || [];
  const row = rows.find(r => r && r.id === 'chequing-a');
  const value = row != null ? Number(row.value) : NaN;
  return Number.isFinite(value) ? roundCent(value) : null;
}

function independentIncomeTotal(plan) {
  return roundCent((plan.income || []).reduce((sum, row) => (
    roundCent(sum + (Number(row && row.amount) || 0))
  ), 0));
}

function independentLeftover(plan, period) {
  const income = period && period.incomeTotal != null
    ? Number(period.incomeTotal)
    : independentIncomeTotal(plan);
  const bills = period && period.periodBillLoad != null
    ? Number(period.periodBillLoad) : 0;
  const hold = period && period.budgetHold != null
    ? Number(period.budgetHold) : 0;
  return roundCent(income - bills - hold);
}

function independentOperatingEffect(sourceAccountId, destinationAccountId) {
  const srcOp = OPERATING_IDS.has(sourceAccountId);
  const dstOp = OPERATING_IDS.has(destinationAccountId);
  const srcSav = sourceAccountId === 'savings';
  const dstSav = destinationAccountId === 'savings';
  if (srcOp && dstOp) return 'stays-in-operating-cash';
  if (srcOp && dstSav) return 'leaves-operating-cash';
  if (srcSav && dstOp) return 'enters-operating-cash';
  return null;
}

function independentBillsEffect(sourceAccountId, destinationAccountId) {
  const srcBills = sourceAccountId === 'chequing-a';
  const dstBills = destinationAccountId === 'chequing-a';
  if (srcBills && !dstBills) return 'leaves-bills';
  if (dstBills && !srcBills) return 'enters-bills';
  return null;
}

function recommend(plan, txs, extra) {
  return F.recommend(plan, PAYDAY, Object.assign({
    targetBuffer: 0,
    debts: [{
      id: 'heloc', label: 'HELOC', secured: true, structure: 'Revolving',
      balance: 10000, rate: 5.45, payment: 50, pending: 0,
    }],
    currentPeriodActuals: packet(txs),
  }, extra || {}));
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p && p.id === id);
}

function packetKeys(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj) : [];
}

function forbiddenGapKeys(obj) {
  return packetKeys(obj).filter(k =>
    /gap|difference|missing|adjustment|plug|remainder/i.test(k)
    && k !== 'predicted-ending-balance'
    && k !== 'balance-after-deductions'
    && k !== 'leftoverIdentity');
}

const composer = loadComposer();
const planSrc = read('public/plan.js');
const forecastSrc = read('public/forecast.js');

const billsToSavings = [
  tfrLeg({
    id: 'tx-bills-sav-out', dir: 'TO', amount: BILLS_TO_SAVINGS,
    atlasAccountId: 'chequing-a', payee: 'AB101 TFR-TO SAVE01',
  }),
  tfrLeg({
    id: 'tx-bills-sav-in', dir: 'FR', amount: BILLS_TO_SAVINGS,
    atlasAccountId: 'savings', payee: 'AB101 TFR-FR BILLSA',
  }),
];
const billsToWeekly = [
  tfrLeg({
    id: 'tx-bills-week-out', dir: 'TO', amount: BILLS_TO_WEEKLY,
    atlasAccountId: 'chequing-a', payee: 'CD202 TFR-TO WEEKLY',
  }),
  tfrLeg({
    id: 'tx-bills-week-in', dir: 'FR', amount: BILLS_TO_WEEKLY,
    atlasAccountId: 'chequing-b', payee: 'CD202 TFR-FR BILLSA',
  }),
];
const savingsToBills = [
  tfrLeg({
    id: 'tx-sav-bills-out', dir: 'TO', amount: SAVINGS_TO_BILLS,
    atlasAccountId: 'savings', payee: 'EF303 TFR-TO BILLSA',
  }),
  tfrLeg({
    id: 'tx-sav-bills-in', dir: 'FR', amount: SAVINGS_TO_BILLS,
    atlasAccountId: 'chequing-a', payee: 'EF303 TFR-FR SAVE01',
  }),
];
const weeklyToSavings = [
  tfrLeg({
    id: 'tx-week-sav-out', dir: 'TO', amount: WEEKLY_TO_SAVINGS,
    atlasAccountId: 'chequing-b', payee: 'IJ505 TFR-TO SAVE01',
  }),
  tfrLeg({
    id: 'tx-week-sav-in', dir: 'FR', amount: WEEKLY_TO_SAVINGS,
    atlasAccountId: 'savings', payee: 'IJ505 TFR-FR WEEKLY',
  }),
];
const unpairedBills = [
  tfrLeg({
    id: 'tx-unpaired-tfr', dir: 'TO', amount: UNPAIRED,
    atlasAccountId: 'chequing-a', payee: 'GH404 TFR-TO SAVE01',
  }),
];
const grocery = {
  id: 'tx-grocery',
  date: PAYDAY,
  amount: GROCERY,
  pending: false,
  categoryLabel: 'Groceries',
  accountRole: 'household-cash',
  atlasAccountId: 'chequing-b',
  displayedPayee: 'Save-On-Foods',
  originalMerchant: 'Save-On-Foods',
};

console.log('=== A. Leftover, Current Balance, and BILLS cash are different contracts ===');
{
  const plan = paydayPlan();
  const independentCash = independentOperatingCash(plan);
  const independentBills = independentBillsCash(plan);
  const independentIncome = independentIncomeTotal(plan);
  const advice = recommend(plan, []);
  const active = period(advice.defaultView, 'this-pay-period');
  const expl = advice.defaultView && advice.defaultView.operatingCashExplanation;
  const independentLeft = independentLeftover(plan, active);
  ok(near(independentBills, BILLS)
      && !near(independentBills, independentCash)
      && !near(independentBills, independentLeft)
      && !near(independentBills, SAVINGS)
      && !near(independentBills, TENNIS),
    'independent BILLS cash is posted chequing-a, not leftover, A+B, savings, or Tennis');
  ok(near(independentCash, BILLS + WEEKLY) && near(independentIncome, DALE + AMANDA)
      && !near(independentBills, independentCash),
    'independent A+B is BILLS + WEEKLY (not Current Balance); independent income is Dale + Amanda');
  ok(active && near(active.afterHouseholdBudget, independentLeft)
      && near(active.liveCurrentBalance, independentBills)
      && !near(active.liveCurrentBalance, independentCash),
    'leftover is independently income − bills − hold; Current Balance is hub chequing-a, not A+B');
  ok(expl && expl.sameContract === false
      && expl.leftoverSameAsBillsCash === false
      && expl.leftoverIdentity === 'balance-after-deductions'
      && expl.operatingCashIdentity === 'posted-planning-hub'
      && expl.billsCashIdentity === 'posted-bills-account',
    'Forecast names leftover, Current Balance, and BILLS cash as leftover vs hub contracts');
  ok(near(expl.leftover, independentLeft)
      && near(expl.operatingCash, independentBills)
      && near(expl.billsCash, independentBills)
      && near(expl.billsCash, BILLS)
      && !near(expl.operatingCash, independentCash),
    'packet leftover is income-led; Current Balance and BILLS cash copy the hub row');
  ok(forbiddenGapKeys(expl).length === 0
      && !('gap' in expl) && !('difference' in expl) && !('missing' in expl)
      && !('fetchedAt' in expl) && !('purpose' in expl)
      && !('billsWalk' in expl) && !('billsOpening' in expl),
    'packet does not publish leftover−BILLS as missing money, a BILLS walk, fetchedAt, or purpose');
}

console.log('=== B. Proven BILLS-location effects; leftover and wealth unchanged ===');
{
  const plan = paydayPlan();
  const emptyAdvice = recommend(plan, []);
  const emptyActive = period(emptyAdvice.defaultView, 'this-pay-period');
  const emptyLeft = independentLeftover(plan, emptyActive);
  const emptyCash = independentOperatingCash(plan);
  const emptyBills = independentBillsCash(plan);

  const cases = [
    {
      name: 'BILLS → WEEKLY',
      txs: billsToWeekly,
      operating: 'stays-in-operating-cash',
      bills: 'leaves-bills',
    },
    {
      name: 'BILLS → Savings',
      txs: billsToSavings,
      operating: 'leaves-operating-cash',
      bills: 'leaves-bills',
    },
    {
      name: 'Savings → BILLS',
      txs: savingsToBills,
      operating: 'enters-operating-cash',
      bills: 'enters-bills',
    },
  ];
  for (const row of cases) {
    const independent = independentPairs(row.txs);
    const opEffect = independent.length === 1
      ? independentOperatingEffect(independent[0].sourceAccountId, independent[0].destinationAccountId)
      : null;
    const billsEffect = independent.length === 1
      ? independentBillsEffect(independent[0].sourceAccountId, independent[0].destinationAccountId)
      : null;
    const advice = recommend(plan, row.txs);
    const expl = advice.defaultView.operatingCashExplanation;
    const move = expl && expl.movements && expl.movements[0];
    ok(independent.length === 1 && near(independent[0].householdAssetDelta, 0)
        && opEffect === row.operating && billsEffect === row.bills,
      `independent ${row.name} conserves household cash, ${row.operating}, ${row.bills}`);
    ok(expl && expl.movements.length === 1
        && move.operatingCashEffect === opEffect
        && move.billsLocationEffect === billsEffect
        && near(move.householdIncome, 0)
        && near(move.householdConsumption, 0)
        && near(move.householdAssetDelta, 0)
        && move.purpose == null
        && move.billsLocationEffectNote
        && /leftover/i.test(move.billsLocationEffectNote),
      `Forecast ${row.name} carries independently classified BILLS-location effect`);
    ok(near(expl.leftover, emptyLeft)
        && near(expl.operatingCash, emptyBills)
        && near(expl.billsCash, emptyBills)
        && !near(expl.operatingCash, emptyCash)
        && expl.leftoverSameAsBillsCash === false,
      `${row.name} does not rewrite leftover, hub Current Balance, or BILLS cash`);
  }
}

console.log('=== C. Non-BILLS and unproven movements get no BILLS-location meaning ===');
{
  const plan = paydayPlan();
  const weeklyAdvice = recommend(plan, weeklyToSavings);
  const weeklyExpl = weeklyAdvice.defaultView.operatingCashExplanation;
  const weeklyIndependent = independentPairs(weeklyToSavings);
  const weeklyBills = weeklyIndependent.length === 1
    ? independentBillsEffect(
      weeklyIndependent[0].sourceAccountId,
      weeklyIndependent[0].destinationAccountId)
    : 'not-null';
  ok(weeklyIndependent.length === 1 && weeklyBills == null
      && weeklyExpl && weeklyExpl.movements.length === 1
      && weeklyExpl.movements[0].operatingCashEffect === 'leaves-operating-cash'
      && weeklyExpl.movements[0].billsLocationEffect == null
      && weeklyExpl.movements[0].billsLocationEffectNote == null,
    'WEEKLY → Savings is proven operating-cash movement and has no BILLS-location meaning');

  const unpairedAdvice = recommend(plan, unpairedBills.concat([grocery]));
  const unpairedExpl = unpairedAdvice.defaultView.operatingCashExplanation;
  ok(independentPairs(unpairedBills).length === 0
      && unpairedExpl && Array.isArray(unpairedExpl.movements)
      && unpairedExpl.movements.length === 0
      && unpairedExpl.leftoverSameAsBillsCash === false
      && near(unpairedExpl.billsCash, BILLS),
    'unpaired BILLS TFR and grocery spend receive no BILLS-location meaning');
}

console.log('=== D. Page reprints Forecast BILLS identities and does not subtract ===');
{
  const plan = paydayPlan();
  const advice = recommend(plan, billsToWeekly);
  const expl = advice.defaultView.operatingCashExplanation;
  const html = composer.operatingCashExplanationHtml(expl);
  const independentLeft = independentLeftover(plan, period(advice.defaultView, 'this-pay-period'));
  const independentCash = independentOperatingCash(plan);
  const independentBills = independentBillsCash(plan);
  ok(!near(independentLeft, independentBills)
      && near(independentBills, BILLS)
      && !near(independentLeft, BILLS)
      && near(expl.operatingCash, independentBills)
      && near(expl.billsCash, independentBills)
      && !near(expl.operatingCash, independentCash),
    'leftover (income-led Dale+Amanda minus hold) differs from hub cash 700; Current Balance and BILLS cash are the same hub row');
  ok(html && /data-operating-cash-explanation/.test(html)
      && /data-same-contract="false"/.test(html)
      && /data-leftover-same-as-bills-cash="false"/.test(html)
      && html.includes(`data-leftover="${expl.leftover}"`)
      && html.includes(`data-operating-cash="${expl.operatingCash}"`)
      && html.includes(`data-bills-cash="${expl.billsCash}"`)
      && html.includes(composer.money2(independentLeft))
      && html.includes(composer.money2(independentBills))
      && html.includes(expl.leftoverNote)
      && html.includes(expl.operatingCashNote)
      && html.includes(expl.billsCashNote)
      && /data-bills-location-effect="leaves-bills"/.test(html)
      && html.includes(expl.movements[0].billsLocationEffectNote)
      && html.includes(expl.movements[0].operatingCashEffectNote),
    'page reprints leftover and hub/BILLS cash; helper may print the same hub money2 twice');
  const htmlFn = grab(planSrc, /^function operatingCashExplanationHtml\([\s\S]*?\n\}$/m,
    'operatingCashExplanationHtml');
  ok(!/explanation\.leftover\s*-/.test(htmlFn)
      && !/explanation\.operatingCash\s*-/.test(htmlFn)
      && !/explanation\.billsCash\s*-/.test(htmlFn)
      && !/TFR-/.test(htmlFn) && !/householdInternalMovements/.test(htmlFn),
    'page helper does not subtract leftover from BILLS or pair transfers');
  ok(/billsCashIdentity: 'posted-bills-account'/.test(forecastSrc)
      && /leftoverIdentity: 'balance-after-deductions'/.test(forecastSrc)
      && /'posted-planning-hub'/.test(forecastSrc)
      && /'planned-dale-payday'/.test(forecastSrc)
      && /leftoverSameAsBillsCash: false/.test(forecastSrc)
      && /function billsLocationEffectForMovement\(/.test(forecastSrc)
      && /function postedBillsAccountCash\(/.test(forecastSrc),
    'Forecast owns leftover vs BILLS cash identities');
}

console.log('=== E. Unavailable operating plan fails closed; missing BILLS row withholds BILLS cash ===');
{
  const plan = paydayPlan();
  const withheld = recommend(plan, billsToWeekly, {
    operatingPlan: 'unavailable',
    operatingPlanNote: 'Current plan unavailable. The dated opening is stale.',
  });
  ok(withheld.defaultView.operatingCashExplanation == null
      && !(withheld.defaultView.calendarPeriods || []).some(p => p && p.operatingCashExplanation),
    'unavailable operating plan withholds leftover vs BILLS explanation');

  const noBills = paydayPlan();
  noBills.startingCash.breakdown = [
    { id: 'chequing-b', label: 'WEEKLY SPENDING', value: WEEKLY },
    { id: 'savings', label: 'EMERGENCY SAVING', value: SAVINGS },
  ];
  const missing = recommend(noBills, []);
  const missingExpl = missing.defaultView.operatingCashExplanation;
  ok(missingExpl && missingExpl.billsCash == null
      && missingExpl.leftoverSameAsBillsCash === false
      && missingExpl.sameContract === false
      && missingExpl.billsCashIdentity === 'posted-bills-account',
    'missing chequing-a withholds BILLS cash rather than inventing $0');
}

console.log('=== E. C5: an owner-estimated BILLS row is never described as posted cash ===');
{
  // Invented case: the bank feed returned no Bills account, so the
  // chequing-a row is the owner-entered estimate. The amount is reprinted
  // unchanged; only the description must say it is an estimate.
  const plan = paydayPlan();
  const row = plan.startingCash.breakdown.find(r => r.id === 'chequing-a');
  row.confidence = 'estimated';
  const independentBills = independentBillsCash(plan);
  const expl = recommend(plan, []).defaultView.operatingCashExplanation;
  const html = composer.operatingCashExplanationHtml(expl);
  ok(expl && near(expl.billsCash, independentBills)
      && /Not provider-confirmed/.test(expl.billsCashNote) && !/^Posted/.test(expl.billsCashNote)
      && html.includes(expl.billsCashNote) && !html.includes('Posted cash currently in BILLS ACCOUNT'),
    'estimated BILLS row: amount unchanged, note and page say estimate, never posted cash');
  const control = paydayPlan();
  const controlExpl = recommend(control, []).defaultView.operatingCashExplanation;
  ok(controlExpl && /^Posted cash currently in BILLS ACCOUNT/.test(controlExpl.billsCashNote),
    'positive control: a provider-observed BILLS row keeps the posted-cash note');
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll leftover vs BILLS cash explanation checks passed');
