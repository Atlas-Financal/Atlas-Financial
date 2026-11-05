'use strict';
/* Payday leftover vs Current Balance explanation.
 *
 * Balance After Deductions is the household-facing current-pay-period
 * remainder (displayed income − period bill load − Household Budget
 * hold). Current Balance is posted planning-hub cash (canonical
 * chequing-a / BILLS ACCOUNT only). They are different contracts.
 * Proven household-internal movements explain cash location without
 * becoming leftover income or leftover spending. Forecast owns the
 * packet; the page reprints it.
 *
 * Independent reconstruction does not call the producing helper (L-002).
 * Synthetic amounts only (L-006).
 *
 * `node test/test-leftover-operating-cash-explanation.js`
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
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: txs,
    representedActuals: [],
  };
}

function classifyOpts(txs) {
  const currentPeriodActuals = packet(txs);
  return { currentPeriodActuals, packet: currentPeriodActuals };
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
  const matches = rows.filter(row => row && row.id === 'chequing-a');
  if (matches.length !== 1) return null;
  const value = Number(matches[0].value);
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


function independentEffect(sourceAccountId, destinationAccountId) {
  const srcOp = OPERATING_IDS.has(sourceAccountId);
  const dstOp = OPERATING_IDS.has(destinationAccountId);
  const srcSav = sourceAccountId === 'savings';
  const dstSav = destinationAccountId === 'savings';
  if (srcOp && dstOp) return 'stays-in-operating-cash';
  if (srcOp && dstSav) return 'leaves-operating-cash';
  if (srcSav && dstOp) return 'enters-operating-cash';
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

const composer = loadComposer();
const planSrc = read('public/plan.js');
const forecastSrc = read('public/forecast.js');

console.log('=== A. Leftover and Current Balance are different contracts ===');
{
  const plan = paydayPlan();
  const independentCash = independentOperatingCash(plan);
  const independentIncome = independentIncomeTotal(plan);
  const advice = recommend(plan, []);
  const active = period(advice.defaultView, 'this-pay-period');
  const next = period(advice.defaultView, 'next-pay-period');
  const expl = advice.defaultView && advice.defaultView.operatingCashExplanation;
  const independentLeft = independentLeftover(plan, active);
  ok(near(independentCash, BILLS)
      && !near(independentCash, BILLS + WEEKLY)
      && !near(independentCash, BILLS + WEEKLY + SAVINGS)
      && !near(independentCash, TENNIS),
    'independent Current Balance is posted BILLS hub only, not Weekly, savings, or Tennis');
  ok(near(independentIncome, DALE + AMANDA),
    'independent payday income is Dale + Amanda');
  ok(active && near(active.incomeTotal, independentIncome)
      && near(active.periodBillLoad, 0)
      && near(active.afterHouseholdBudget, independentLeft),
    'leftover identity is independently income − bills − Household Budget hold');

  ok(!near(independentLeft, independentCash),
    'independent leftover is not independent Current Balance');
  ok(expl && expl.sameContract === false
      && expl.leftoverIdentity === 'balance-after-deductions'

      && expl.operatingCashIdentity === 'posted-planning-hub',

    'Forecast names leftover and Current Balance as different contracts');
  ok(near(expl.leftover, independentLeft)
      && near(expl.operatingCash, independentCash)
      && near(expl.leftover, active.afterHouseholdBudget)
      && near(expl.operatingCash, active.liveCurrentBalance)
      && near(expl.operatingCash, advice.defaultView.liveCurrentBalance),
    'packet leftover and cash copy the existing identities, not a new leftover');
  ok(active.operatingCashExplanation === expl
      && !next.operatingCashExplanation,
    'explanation is on the active period and defaultView only');
  ok(!('gap' in expl) && !('difference' in expl) && !('missing' in expl)
      && !('fetchedAt' in expl) && !('purpose' in expl),
    'packet does not publish leftover−cash as missing money, fetchedAt, or savings purpose');
}

console.log('=== B. Internal movements explain location; leftover is unchanged ===');
{
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
  const plan = paydayPlan();
  const emptyAdvice = recommend(plan, []);
  const emptyActive = period(emptyAdvice.defaultView, 'this-pay-period');
  const emptyLeft = independentLeftover(plan, emptyActive);

  const cases = [
    { name: 'Bills→Savings', txs: billsToSavings, expected: 'leaves-operating-cash' },
    { name: 'Bills→Weekly', txs: billsToWeekly, expected: 'stays-in-operating-cash' },
    { name: 'Savings→Bills', txs: savingsToBills, expected: 'enters-operating-cash' },
  ];
  for (const row of cases) {
    const independent = independentPairs(row.txs);
    const effect = independent.length === 1
      ? independentEffect(independent[0].sourceAccountId, independent[0].destinationAccountId)
      : null;
    const advice = recommend(plan, row.txs);
    const active = period(advice.defaultView, 'this-pay-period');
    const expl = advice.defaultView.operatingCashExplanation;
    const move = expl && expl.movements && expl.movements[0];
    ok(independent.length === 1 && near(independent[0].householdAssetDelta, 0)
        && effect === row.expected,
      `independent ${row.name} conserves household cash and has ${row.expected}`);
    ok(expl && expl.movements.length === 1
        && move.operatingCashEffect === effect
        && near(move.amount, independent[0].amount)
        && near(move.householdIncome, 0)
        && near(move.householdConsumption, 0)
        && near(move.householdAssetDelta, 0)
        && move.purpose == null,
      `Forecast ${row.name} carries independently classified operating-cash effect`);
    ok(near(expl.leftover, emptyLeft)
        && near(active.afterHouseholdBudget, emptyActive.afterHouseholdBudget),
      `${row.name} does not rewrite leftover`);
  }

  const mixed = billsToWeekly.concat([grocery]);
  const mixedAdvice = recommend(plan, mixed);
  const mixedExpl = mixedAdvice.defaultView.operatingCashExplanation;
  const groceryCls = F.classifyCurrentPeriodTransaction(grocery, plan, classifyOpts(mixed));
  const action = F.currentPeriodAction(plan, PAYDAY, classifyOpts(mixed));
  const groceryCat = (action.categories || []).find(c => c && c.id === 'groceries');
  ok(groceryCls.kind === 'spend' && groceryCls.categoryId === 'groceries'
      && groceryCls.householdSpending === true
      && groceryCat && near(groceryCat.posted, GROCERY),
    'grocery remains household spend beside an internal movement');
  ok(mixedExpl && mixedExpl.movements.length === 1
      && mixedExpl.movements[0].operatingCashEffect === 'stays-in-operating-cash'
      && near(mixedExpl.leftover, emptyLeft),
    'grocery does not become an operating-cash movement and leftover stays Balance After Deductions');

}

console.log('=== C. Unpaired transfers and unavailable plans fail closed ===');
{
  const unpaired = [
    tfrLeg({
      id: 'tx-unpaired-tfr', dir: 'TO', amount: UNPAIRED,
      atlasAccountId: 'chequing-a', payee: 'GH404 TFR-TO SAVE01',
    }),
  ];
  const plan = paydayPlan();
  const advice = recommend(plan, unpaired);
  const expl = advice.defaultView.operatingCashExplanation;
  ok(independentPairs(unpaired).length === 0
      && expl && Array.isArray(expl.movements) && expl.movements.length === 0
      && expl.sameContract === false,
    'unpaired TFR is not an operating-cash movement; identities still publish');

  const withheld = recommend(plan, unpaired.concat([
    tfrLeg({
      id: 'tx-bills-sav-in', dir: 'FR', amount: BILLS_TO_SAVINGS,
      atlasAccountId: 'savings', payee: 'AB101 TFR-FR BILLSA',
    }),
    tfrLeg({
      id: 'tx-bills-sav-out', dir: 'TO', amount: BILLS_TO_SAVINGS,
      atlasAccountId: 'chequing-a', payee: 'AB101 TFR-TO SAVE01',
    }),
  ]), {
    operatingPlan: 'unavailable',
    operatingPlanNote: 'Current plan unavailable. The dated opening is stale.',
  });
  ok(withheld.defaultView.operatingCashExplanation == null
      && !(withheld.defaultView.calendarPeriods || []).some(p => p && p.operatingCashExplanation),
    'unavailable operating plan withholds the leftover vs cash explanation');
}

function independentAddDays(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function independentSeaspanPaydayOnOrBefore(asOf) {
  let payday = '2026-08-14';
  while (independentAddDays(payday, 14) <= asOf) {
    payday = independentAddDays(payday, 14);
  }
  return payday;
}

function independentExplanationWindow(asOf) {
  const start = independentSeaspanPaydayOnOrBefore(asOf);
  const next = independentAddDays(start, 14);
  const end = independentAddDays(next, -1);
  const through = asOf < end ? asOf : end;
  return { start, end, through };
}

function independentMovementInWindow(pair, txs, window) {
  if (!pair || !window) return false;
  const source = (txs || []).find(tx => tx && String(tx.id) === pair.sourceTransactionId);
  const dest = (txs || []).find(tx => tx && String(tx.id) === pair.destinationTransactionId);
  const sourceDate = source && source.date;
  const destDate = dest && dest.date;
  if (!sourceDate || !destDate) return false;
  return sourceDate >= window.start && sourceDate <= window.through
    && destDate >= window.start && destDate <= window.through;
}

console.log('=== D. Prior-period and undated pairs do not explain this payday ===');
{
  const PRIOR = '2026-09-06';
  const AFTER_AS_OF = '2026-09-15';
  const window = independentExplanationWindow(PAYDAY);
  const txs = [
    tfrLeg({
      id: 'tx-prior-out', dir: 'TO', amount: BILLS_TO_SAVINGS, date: PRIOR,
      atlasAccountId: 'chequing-a', payee: 'AB101 TFR-TO SAVE01',
    }),
    tfrLeg({
      id: 'tx-prior-in', dir: 'FR', amount: BILLS_TO_SAVINGS, date: PRIOR,
      atlasAccountId: 'savings', payee: 'AB101 TFR-FR BILLSA',
    }),
    tfrLeg({
      id: 'tx-in-period-out', dir: 'TO', amount: BILLS_TO_WEEKLY, date: PAYDAY,
      atlasAccountId: 'chequing-a', payee: 'CD202 TFR-TO WEEKLY',
    }),
    tfrLeg({
      id: 'tx-in-period-in', dir: 'FR', amount: BILLS_TO_WEEKLY, date: PAYDAY,
      atlasAccountId: 'chequing-b', payee: 'CD202 TFR-FR BILLSA',
    }),
    tfrLeg({
      id: 'tx-after-asof-out', dir: 'TO', amount: SAVINGS_TO_BILLS, date: AFTER_AS_OF,
      atlasAccountId: 'savings', payee: 'EF303 TFR-TO BILLSA',
    }),
    tfrLeg({
      id: 'tx-after-asof-in', dir: 'FR', amount: SAVINGS_TO_BILLS, date: AFTER_AS_OF,
      atlasAccountId: 'chequing-a', payee: 'EF303 TFR-FR SAVE01',
    }),
    tfrLeg({
      id: 'tx-undated-out', dir: 'TO', amount: UNPAIRED, date: null,
      atlasAccountId: 'chequing-a', payee: 'GH404 TFR-TO SAVE01',
    }),
    tfrLeg({
      id: 'tx-undated-in', dir: 'FR', amount: UNPAIRED, date: null,
      atlasAccountId: 'savings', payee: 'GH404 TFR-FR BILLSA',
    }),
  ];
  const independent = independentPairs(txs);
  const independentKept = independent.filter(pair => independentMovementInWindow(pair, txs, window));
  const plan = paydayPlan();
  const packetForWindow = {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: PAYDAY,
    coverageStart: PRIOR,
    coverageThrough: AFTER_AS_OF,
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: txs,
    representedActuals: [],
  };
  const advice = F.recommend(plan, PAYDAY, {
    targetBuffer: 0,
    debts: [{
      id: 'heloc', label: 'HELOC', secured: true, structure: 'Revolving',
      balance: 10000, rate: 5.45, payment: 50, pending: 0,
    }],
    currentPeriodActuals: packetForWindow,
  });
  const expl = advice.defaultView && advice.defaultView.operatingCashExplanation;
  const paired = F.householdInternalMovements(plan, {
    currentPeriodActuals: packetForWindow,
  });
  ok(window.start === PAYDAY && window.through === PAYDAY && window.end === '2026-09-24',
    'independent window is this payday through as-of, not the later period end');
  ok(independent.length === 4 && independentKept.length === 1
      && independentKept[0].tfrReference === 'CD202'
      && near(independentKept[0].amount, BILLS_TO_WEEKLY),
    'independent reconstruction keeps only the in-period pair');
  ok(paired.some(m => m && m.tfrReference === 'AB101')
      && paired.some(m => m && m.tfrReference === 'CD202')
      && paired.some(m => m && m.tfrReference === 'EF303'),
    'pairing primitive still sees prior-period and after-as-of pairs');
  ok(expl && expl.movements.length === 1
      && expl.movements[0].tfrReference === 'CD202'
      && expl.movements[0].date === PAYDAY
      && expl.movements[0].operatingCashEffect === 'stays-in-operating-cash'
      && !expl.movements.some(m => m.tfrReference === 'AB101')
      && !expl.movements.some(m => m.tfrReference === 'EF303')
      && !expl.movements.some(m => m.tfrReference === 'GH404'),
    'explanation retains the in-period pair and excludes prior-period, after-as-of, and undated pairs');
}

console.log('=== E. Page reprints Forecast identities and does not compute a gap ===');
{
  const plan = paydayPlan();
  const txs = [
    tfrLeg({
      id: 'tx-bills-sav-out', dir: 'TO', amount: BILLS_TO_SAVINGS,
      atlasAccountId: 'chequing-a', payee: 'AB101 TFR-TO SAVE01',
    }),
    tfrLeg({
      id: 'tx-bills-sav-in', dir: 'FR', amount: BILLS_TO_SAVINGS,
      atlasAccountId: 'savings', payee: 'AB101 TFR-FR BILLSA',
    }),
  ];
  const advice = recommend(plan, txs);
  const active = period(advice.defaultView, 'this-pay-period');
  const expl = active.operatingCashExplanation;
  const html = composer.operatingCashExplanationHtml(expl);
  const independentLeft = independentLeftover(plan, active);
  const independentCash = independentOperatingCash(plan);
  ok(html && /data-operating-cash-explanation/.test(html)
      && /data-same-contract="false"/.test(html)
      && html.includes(`data-leftover="${expl.leftover}"`)
      && html.includes(`data-operating-cash="${expl.operatingCash}"`)
      && html.includes(composer.money2(independentLeft))
      && html.includes(composer.money2(independentCash))
      && html.includes(expl.leftoverNote)
      && html.includes(expl.operatingCashNote)
      && /data-operating-cash-movement="leaves-operating-cash"/.test(html)
      && html.includes(expl.movements[0].operatingCashEffectNote),
    'page reprints Forecast leftover, Current Balance, sameContract, and effect notes');
  const htmlFn = grab(planSrc, /^function operatingCashExplanationHtml\([\s\S]*?\n\}$/m,
    'operatingCashExplanationHtml');
  const waterfallFn = grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m,
    'calendarWaterfallHtml');
  ok(/Balance After Deductions/.test(waterfallFn)
      && !/operatingCashExplanationHtml\(period\.operatingCashExplanation\)/.test(waterfallFn)
      && !/data-operating-question="08"/.test(waterfallFn)
      && !/projectedEnding|afterDebtRepayment/.test(waterfallFn)
      && !/'08'|'09'|'10'|'11'/.test(waterfallFn),
    'calendarWaterfallHtml stops at Balance After Deductions and does not print the explanation');

  ok(!/explanation\.leftover\s*-/.test(htmlFn)
      && !/explanation\.operatingCash\s*-/.test(htmlFn)
      && !/TFR-/.test(htmlFn) && !/householdInternalMovements/.test(htmlFn),
    'page helper does not subtract leftover from cash or pair transfers');
  ok(/leftoverIdentity: 'balance-after-deductions'/.test(forecastSrc)
      && /'posted-planning-hub'/.test(forecastSrc)
      && /'planned-dale-payday'/.test(forecastSrc)
      && /sameContract: false/.test(forecastSrc)
      && /function operatingCashExplanation\(/.test(forecastSrc),
    'Forecast owns leftover vs operating-cash identities');

  ok(packetKeys(expl).indexOf('leftover') >= 0
      && packetKeys(expl).indexOf('operatingCash') >= 0,
    'published packet still carries leftover and operatingCash for reprint');
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll leftover vs operating-cash explanation checks passed');
