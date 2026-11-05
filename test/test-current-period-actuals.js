'use strict';
/* Forecast current-period planned → actual → remaining → next action.
 *
 * Synthetic fixtures only. Live household cents are not the specification
 * (L-006). Category remaining is reconciled against an independent sum of
 * classified fixture transactions, not by reading currentPeriodAction back
 * to itself. Bill settlement reuses representedEvents + expandEvents.
 *
 * `node test/test-current-period-actuals.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const L = require('../scripts/live-plan.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps;
const MONTH = 365.25 / 12;
const PAYDAY = '2026-09-01';
const MID = '2026-09-08';
const NEXT = '2026-09-15';
const PERIOD_LAST = '2026-09-14';

function paydayComposer() {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  const grab = (src, re, label) => {
    const m = re.exec(src);
    if (!m) throw new Error('missing ' + label);
    return m[0];
  };
  return vm.runInNewContext(
    [
      grab(appSrc, /^const money = .*$/m, 'money'),
      grab(appSrc, /^const money2 = .*$/m, 'money2'),
      grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
      grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
      grab(planSrc, /^const fmtMonth = .*$/m, 'fmtMonth'),
      grab(planSrc, /^function weeklyCapView\([\s\S]*?\n\}$/m, 'weeklyCapView'),
      grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
      grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
      grab(planSrc, /^function currentOperatingUnavailableHtml\([\s\S]*?\n\}$/m, 'currentOperatingUnavailableHtml'),
      grab(planSrc, /^function paydayActionRows\([\s\S]*?\n\}$/m, 'paydayActionRows'),
      grab(planSrc, /^function paydayOtherActionRows\([\s\S]*?\n\}$/m, 'paydayOtherActionRows'),
      grab(planSrc, /^function paydayReservedIds\([\s\S]*?\n\}$/m, 'paydayReservedIds'),
      grab(planSrc, /^function paydayComingRows\([\s\S]*?\n\}$/m, 'paydayComingRows'),
      grab(planSrc, /^function paydaySheet\([\s\S]*?\n\}$/m, 'paydaySheet'),
      grab(planSrc, /^function paydayCashNote\([\s\S]*?\n\}$/m, 'paydayCashNote'),
      grab(planSrc, /^function paydayObligationNote\([\s\S]*?\n\}$/m, 'paydayObligationNote'),
      grab(planSrc, /^function paydayCoverageNote\([\s\S]*?\n\}$/m, 'paydayCoverageNote'),
      grab(planSrc, /^function paydayBillStatusNote\([\s\S]*?\n\}$/m, 'paydayBillStatusNote'),
      grab(planSrc, /^function paydayAmountCell\([\s\S]*?\n\}$/m, 'paydayAmountCell'),
      grab(planSrc, /^function paydayAnswerHtml\([\s\S]*?\n\}$/m, 'paydayAnswerHtml'),
      '({ paydayAnswerHtml, money2 })',
    ].join('\n'),
    { Forecast: F }
  );
}

function miniPeriods() {
  return { periods: { ytd: { label: 'YTD', months: 1, spending: [] } } };
}

function basePlan(extra) {
  return Object.assign({
    windowDays: 40,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 4000 },
    opening: { asOf: PAYDAY, representedEvents: [] },
    income: [{
      id: 'pay', label: 'Pay', frequency: 'once', date: PAYDAY,
      amount: 2500, confidence: 'confirmed',
    }, {
      id: 'pay2', label: 'Pay 2', frequency: 'once', date: NEXT,
      amount: 2500, confidence: 'confirmed',
    }],
    obligations: [],
    bills: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedMonthly: 1800,
        },
        {
          id: 'fuel', label: 'Fuel & transport', class: 'essential',
          from: ['Fuel & transport'], plannedMonthly: 600,
        },
        {
          id: 'uncategorised', label: 'Uncategorised', class: 'unknown',
          from: ['Uncategorised'],
        },
      ],
      excluded: [{ from: 'Business', why: 'not household' }],
    },
  }, extra || {});
}

function packet(txs, extra) {
  return Object.assign({
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: extra && extra.asOf || PAYDAY,
    coverageStart: extra && extra.coverageStart || PAYDAY,
    coverageThrough: extra && extra.coverageThrough || (extra && extra.asOf) || PAYDAY,
    pendingCoverage: extra && extra.pendingCoverage || 'complete',
    transactionCoverage: 'complete',
    transactions: txs,
  }, extra || {});
}

function opts(extra) {
  return Object.assign({
    paydayFloor: 1000,
    targetBuffer: 0,
    debts: [],
    weeklyVariable: 180,
    periods: miniPeriods(),
  }, extra || {});
}

function periodDays(start, end) {
  return F.diffDays(start, end) + 1;
}

function plannedNeed(monthly, start, end) {
  return Math.round(monthly * periodDays(start, end) / MONTH * 100) / 100;
}

function cat(action, id) {
  return ((action && action.categories) || []).find(c => c.id === id) || null;
}

function bill(action, id) {
  return ((action && action.bills) || []).find(b => b.id === id) || null;
}

function independentSpend(txs, plan, asOf, origin) {
  const byId = {};
  const skipped = { transfer: 0, payment: 0, income: 0, business: 0, external: 0 };
  for (const tx of txs) {
    if (tx.date < origin || tx.date > asOf) continue;
    const cls = F.classifyCurrentPeriodTransaction(tx, plan);
    const amt = Number(tx.amount) || 0;
    if (cls.kind === 'spend' || cls.kind === 'unclassified') {
      const id = cls.categoryId || 'uncategorised';
      byId[id] = byId[id] || { posted: 0, pending: 0 };
      if (tx.pending === true && tx.pendingTreatment !== 'confirmed-settled'
        && tx.pendingTreatment !== 'presumed-settled-for-current-forecast') {
        byId[id].pending += amt;
      } else {
        byId[id].posted += amt;
      }
    } else if (skipped[cls.kind] != null) {
      skipped[cls.kind] += amt;
    }
  }
  for (const id of Object.keys(byId)) {
    byId[id].posted = Math.round(byId[id].posted * 100) / 100;
    byId[id].pending = Math.round(byId[id].pending * 100) / 100;
  }
  return { byId, skipped };
}

console.log('=== A. paid bill via representedEvents ===');
{
  const plan = basePlan({
    bills: [
      { id: 'bcaa', label: 'BCAA', frequency: 'once', date: PAYDAY, amount: 82.96, confidence: 'confirmed' },
    ],
    opening: { asOf: PAYDAY, representedEvents: [{ id: 'bcaa', date: PAYDAY }] },
  });
  const action = F.currentPeriodAction(plan, PAYDAY, opts());
  const row = bill(action, 'bcaa');
  const events = F.expandEvents(plan, PAYDAY, PERIOD_LAST, {});
  ok(row && near(row.planned, 82.96), 'planned amount exists', row && row.planned);
  ok(row && row.actual == null && near(row.remaining, 0),
    'represented remaining is 0; schedule amount is not fabricated as actual');
  ok(row && row.settlement === 'represented', 'status is represented / paid');
  ok(!events.some(e => e.id === 'bcaa'),
    'expandEvents omits the represented occurrence — no second reserve');
  const alloc = F.paydayAllocation(plan, PAYDAY, opts());
  ok(!(alloc.obligations.items || []).some(i => i.id === 'bcaa'),
    'paydayAllocation does not reserve a represented bill');
}

console.log('\n=== B. unverified bill ===');
{
  const plan = basePlan({
    opening: { asOf: MID, priorAsOf: PAYDAY, representedEvents: [] },
    income: [
      { id: 'pay', label: 'Pay', frequency: 'once', date: NEXT, amount: 2500, confidence: 'confirmed' },
    ],
    bills: [
      { id: 'icbc', label: 'ICBC', frequency: 'once', date: '2026-09-05', amount: 99.91, confidence: 'confirmed' },
    ],
  });
  const action = F.currentPeriodAction(plan, MID, opts());
  const row = bill(action, 'icbc');
  ok(row && row.actual == null, 'actual is unknown / unproven');
  ok(row && near(row.remaining, 99.91), 'remaining stays reserved');
  ok(row && row.settlement === 'unverified', 'status is unverified');
  ok(row && row.settlement !== 'unpaid' && !/unpaid/i.test(JSON.stringify(row)),
    'not called unpaid');
  const html = paydayComposer().paydayAnswerHtml({
    plan, asOf: MID,
    advice: {
      weekly: 180, mode: 'normal',
      paydayAllocation: F.paydayAllocation(plan, MID, opts()),
      currentPeriodAction: action,
    },
    recommended: 180, weekly: 180,
  });
  ok(/settlement not proven/.test(html) && !/unpaid/i.test(html),
    'page says settlement not proven, not unpaid');
}

console.log('\n=== C. upcoming bill ===');
{
  const plan = basePlan({
    opening: { asOf: MID, representedEvents: [] },
    income: [
      { id: 'pay', label: 'Pay', frequency: 'once', date: NEXT, amount: 2500, confidence: 'confirmed' },
    ],
    bills: [
      { id: 'visa', label: 'Travel Visa', frequency: 'once', date: '2026-09-12', amount: 17, confidence: 'confirmed' },
    ],
  });
  const action = F.currentPeriodAction(plan, MID, opts());
  const row = bill(action, 'visa');
  ok(row && near(row.actual, 0), 'actual is 0');
  ok(row && near(row.remaining, 17), 'remaining is the required amount');
  ok(row && row.date === '2026-09-12' && row.settlement === 'upcoming',
    'due date and upcoming status');
}

console.log('\n=== D. groceries actual remaining ===');
{
  const txs = [
    { date: '2026-09-02', amount: 80.10, pending: false, categoryLabel: 'Groceries', accountRole: 'revolving-credit', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
    { date: '2026-09-04', amount: 40.00, pending: false, categoryLabel: 'Groceries', accountRole: 'household-cash', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
  ];
  const plan = basePlan({
    opening: { asOf: MID, priorAsOf: PAYDAY, representedEvents: [] },
    income: [
      { id: 'pay', label: 'Pay', frequency: 'once', date: NEXT, amount: 2500, confidence: 'confirmed' },
    ],
  });
  const origin = PAYDAY;
  const independent = independentSpend(txs, plan, MID, origin);
  const planned = plannedNeed(1800, origin, PERIOD_LAST);
  const posted = independent.byId.groceries.posted;
  const expected = Math.round((planned - posted) * 100) / 100;
  const action = F.currentPeriodAction(plan, MID, opts({
    currentPeriodActuals: packet(txs, { asOf: MID, coverageStart: PAYDAY, coverageThrough: MID }),
  }));
  const row = cat(action, 'groceries');
  ok(row && near(row.planned, planned), 'planned matches independent period scale',
    `${row && row.planned} vs ${planned}`);
  ok(row && near(row.posted, posted), 'posted matches independent transaction sum',
    `${row && row.posted} vs ${posted}`);
  ok(row && near(row.remaining, expected),
    'remaining = planned − posted', `${row && row.remaining} vs ${expected}`);
}

console.log('\n=== E. credit-card purchase counted once ===');
{
  const txs = [
    { date: PAYDAY, amount: 40, pending: false, categoryLabel: 'Groceries', accountRole: 'revolving-credit', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
    {
      date: PAYDAY, amount: 40, pending: false, categoryLabel: 'Transfer',
      accountRole: 'household-cash', excludeFromTotals: true, kindHint: 'payment',
    },
  ];
  const plan = basePlan();
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs),
  }));
  const groceries = cat(action, 'groceries');
  const payCls = F.classifyCurrentPeriodTransaction(txs[1], plan);
  ok(groceries && near(groceries.posted, 40), 'card purchase counts toward groceries');
  ok(payCls.kind === 'card-payment' || payCls.kind === 'transfer',
    'card payment is not spend', payCls.kind);
  ok(groceries && near(groceries.posted, 40) && !near(groceries.posted, 80),
    'card payment does not add a second grocery dollar');
}

console.log('\n=== F. internal transfer is not spending or income ===');
{
  const txs = [
    {
      date: PAYDAY, amount: 50, pending: false, categoryLabel: 'Transfer',
      accountRole: 'household-cash', excludeFromTotals: true, kindHint: 'transfer',
    },
  ];
  const plan = basePlan();
  const cls = F.classifyCurrentPeriodTransaction(txs[0], plan);
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs),
  }));
  const groceries = cat(action, 'groceries');
  const planned = plannedNeed(1800, PAYDAY, PERIOD_LAST);
  ok(cls.kind === 'transfer' && cls.householdSpending === false, 'classified as transfer');
  ok(groceries && near(groceries.posted, 0) && near(groceries.remaining, planned),
    'transfer does not change grocery actual or remaining');
  ok(action.unclassified.count === 0, 'transfer is not dumped into unclassified spend');
}

console.log('\n=== G. pending purchase has gravity and is not posted ===');
{
  const txs = [
    {
      date: PAYDAY, amount: 18.40, pending: true,
      pendingTreatment: 'unresolved', categoryLabel: 'Groceries',
      accountRole: 'revolving-credit',
      displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
    },
  ];
  const plan = basePlan();
  const planned = plannedNeed(1800, PAYDAY, PERIOD_LAST);
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs, { pendingCoverage: 'complete' }),
  }));
  const row = cat(action, 'groceries');
  ok(row && near(row.posted, 0) && near(row.pending, 18.40),
    'pending is labelled pending, not posted');
  ok(row && near(row.committed, 18.40) && near(row.remaining, planned - 18.40),
    'pending cannot be offered again as free grocery room');
}

console.log('\n=== H. refund / credit reduces spending ===');
{
  const txs = [
    { date: PAYDAY, amount: 40, pending: false, categoryLabel: 'Groceries', accountRole: 'revolving-credit', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
    { date: PAYDAY, amount: -12, pending: false, categoryLabel: 'Groceries', accountRole: 'revolving-credit' },
  ];
  const plan = basePlan();
  const planned = plannedNeed(1800, PAYDAY, PERIOD_LAST);
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs),
  }));
  const row = cat(action, 'groceries');
  ok(row && near(row.posted, 40), 'posted is the purchase; credits are excluded as refunds, not netted into groceries');
  ok(row && near(row.remaining, planned - 40), 'remaining uses posted spend without the refund credit');
}

console.log('\n=== I. unclassified transaction is not dropped or guessed ===');
{
  const txs = [
    { date: PAYDAY, amount: 9.99, pending: false, categoryLabel: null, accountRole: 'household-cash' },
  ];
  const plan = basePlan();
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  const helpers = src.slice(src.indexOf('function txMerchantExact'),
    src.indexOf('function classifyCurrentPeriodTransaction'));
  const slice = src.slice(src.indexOf('function classifyCurrentPeriodTransaction'),
    src.indexOf('function currentPeriodActualsPacket'));
  ok(/displayedPayee/.test(helpers) && /originalMerchant/.test(helpers)
      && /merchantKnown === true/.test(helpers)
      && /function isDogFoodMerchant/.test(helpers)
      && /tx\.representedBill === true/.test(helpers),
    'classifier uses derived flags on the served packet, with merchant-text fallback for unit tests');
  ok(/isDogFoodMerchant\(tx\)/.test(slice) && /isCanadianTireMerchant\(tx\)/.test(slice),
    'classifier applies merchant identity before named-category mapping');
  ok(!/\btx\.payee\b/.test(slice) || /txMerchantExact/.test(slice),
    'classifier merchant identity prefers packet fields over a raw provider payee key');
  const cls = F.classifyCurrentPeriodTransaction(txs[0], plan);
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs),
  }));
  ok(cls.kind === 'unclassified', 'unclassified, not a guessed merchant category');
  ok(action.unclassified.count === 1 && near(action.unclassified.posted, 9.99),
    'uncertainty is surfaced with the dollar amount');
  const groceries = cat(action, 'groceries');
  ok(groceries && near(groceries.posted, 0), 'not guessed into groceries');
  ok(action.remainingClaim === 'precise',
    'provider coverage remainingClaim stays precise when accounts and posted/pending coverage are complete');
  ok(action.categoryRemainingClaim === 'classified-incomplete',
    'named remaining is not claimed precise while household spend is unclassified');
  ok(groceries && groceries.remaining != null,
    'observed grocery remaining is still published');
}

console.log('\n=== J. stale actuals fail closed ===');
{
  const txs = [
    { date: '2026-08-20', amount: 200, pending: false, categoryLabel: 'Groceries', accountRole: 'household-cash', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
  ];
  const plan = basePlan({ opening: { asOf: PAYDAY, representedEvents: [] } });
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs, {
      asOf: PAYDAY, coverageStart: '2026-08-09', coverageThrough: '2026-08-09',
    }),
  }));
  const groceries = cat(action, 'groceries');
  ok(action.remainingClaim === 'unavailable' && action.coverage.status === 'stale',
    'Forecast fails closed on stale coverage');
  ok(groceries && groceries.remaining == null,
    'no precise remaining amount is published');
  const html = paydayComposer().paydayAnswerHtml({
    plan, asOf: PAYDAY,
    advice: {
      weekly: 180, mode: 'normal',
      paydayAllocation: F.paydayAllocation(plan, PAYDAY, opts()),
      currentPeriodAction: action,
    },
    recommended: 180, weekly: 180,
  });
  ok(/only through/.test(html) && /unavailable/.test(html),
    'page shows the freshness limitation');
  ok(!/Everyday spending left[\s\S]*\$200/.test(html),
    'stale grocery actual is not shown as current remaining');
}

console.log('\n=== K. between-paydays action plan ===');
{
  const plan = basePlan({
    opening: {
      asOf: MID, priorAsOf: PAYDAY,
      representedEvents: [{ id: 'bcaa', date: '2026-09-03' }],
    },
    income: [
      { id: 'pay', label: 'Pay', frequency: 'once', date: NEXT, amount: 2500, confidence: 'confirmed' },
    ],
    bills: [
      { id: 'bcaa', label: 'BCAA', frequency: 'once', date: '2026-09-03', amount: 82.96, confidence: 'confirmed' },
      { id: 'visa', label: 'Travel Visa', frequency: 'once', date: '2026-09-12', amount: 17, confidence: 'confirmed' },
    ],
  });
  const txs = [
    { date: '2026-09-03', amount: 50, pending: false, categoryLabel: 'Groceries', accountRole: 'household-cash', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
  ];
  const rec = F.recommend(plan, MID, opts({
    currentPeriodActuals: packet(txs, { asOf: MID, coverageStart: PAYDAY, coverageThrough: MID }),
  }));
  const action = rec.currentPeriodAction;
  ok(action.mode === 'between-paydays', 'no current-day payday event → between-paydays');
  ok(action.nextPayday === NEXT, 'next payday is the incumbent income date');
  ok(bill(action, 'bcaa') && bill(action, 'bcaa').settlement === 'represented',
    'already-done bill is reported');
  ok(bill(action, 'visa') && bill(action, 'visa').settlement === 'upcoming',
    'still-due bill is reported');
  ok(cat(action, 'groceries') && cat(action, 'groceries').remaining != null,
    'variable remaining is reported');
  ok(action.noMovementToday === true && action.todayActions.length === 0,
    'does not invent a money movement');
  const html = paydayComposer().paydayAnswerHtml({
    plan, asOf: MID, advice: rec, recommended: rec.weekly, weekly: rec.weekly,
  });
  ok(/What to do now/.test(html) && /No money movement is required today/.test(html),
    'action plan says no movement today');
  ok(!/What to do with this paycheque/.test(html),
    'between-paydays is not a payday allocation worksheet');
}

console.log('\n=== L. payday mode keeps the allocator ===');
{
  const plan = basePlan({
    bills: [
      { id: 'soon', label: 'Soon', frequency: 'once', date: '2026-09-10', amount: 70, confidence: 'confirmed' },
    ],
  });
  const txs = [
    { date: PAYDAY, amount: 25, pending: false, categoryLabel: 'Groceries', accountRole: 'household-cash', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
  ];
  const rec = F.recommend(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs),
  }));
  const alloc = rec.paydayAllocation;
  const action = rec.currentPeriodAction;
  ok(action.mode === 'payday' && alloc.mode === 'payday', 'authoritative date is a payday');
  ok(near(alloc.identity, alloc.available), 'waterfall identity still holds');
  ok((alloc.obligations.items || []).some(i => i.id === 'soon'),
    'upcoming bill remains in the payday reserve');
  const groceries = cat(action, 'groceries');
  const planned = plannedNeed(1800, PAYDAY, PERIOD_LAST);
  ok(groceries && near(groceries.remaining, planned - 25),
    'payday essentials incorporate actuals without a second allocator');
  const html = paydayComposer().paydayAnswerHtml({
    plan, asOf: PAYDAY, advice: rec, recommended: rec.weekly, weekly: rec.weekly,
  });
  ok(/What to do with this paycheque/.test(html) && /Money available/.test(html),
    'payday worksheet remains the payday surface');
}

console.log('\n=== M. dollar / category reconciliation ===');
{
  const txs = [
    { date: PAYDAY, amount: 40, pending: false, categoryLabel: 'Groceries', accountRole: 'revolving-credit', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
    { date: PAYDAY, amount: 15, pending: false, categoryLabel: 'Fuel & transport', accountRole: 'household-cash', displayedPayee: 'Shell', originalMerchant: 'Shell' },
    { date: PAYDAY, amount: 8, pending: true, pendingTreatment: 'unresolved', categoryLabel: 'Groceries', accountRole: 'revolving-credit', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
    { date: PAYDAY, amount: 20, pending: false, categoryLabel: 'Transfer', accountRole: 'household-cash', kindHint: 'transfer', excludeFromTotals: true },
  ];
  const plan = basePlan();
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs),
  }));
  const independent = independentSpend(txs, plan, PAYDAY, PAYDAY);
  for (const id of ['groceries', 'fuel']) {
    const row = cat(action, id);
    const ind = independent.byId[id] || { posted: 0, pending: 0 };
    const planned = plannedNeed(id === 'groceries' ? 1800 : 600, PAYDAY, PERIOD_LAST);
    const committed = Math.round((ind.posted + ind.pending) * 100) / 100;
    ok(row && near(row.posted, ind.posted) && near(row.pending, ind.pending),
      `${id} posted/pending match independent sums`);
    ok(row && near(row.remaining, planned - committed),
      `${id} planned − committed = remaining`);
  }
  ok(!independent.byId.groceries || independent.byId.fuel,
    'fixture has both categories');
  const groceryCls = F.classifyCurrentPeriodTransaction(txs[0], plan);
  const fuelCls = F.classifyCurrentPeriodTransaction(txs[1], plan);
  ok(groceryCls.categoryId === 'groceries' && fuelCls.categoryId === 'fuel',
    'the same transaction cannot sit in two household spending categories');
}

console.log('\n=== N. privacy — no raw payloads in overlay or localStorage knobs ===');
{
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'connectivity', 'fixtures', 'lunchmoney-sample.json'), 'utf8'));
  const map = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'connectivity', 'fixtures', 'provider-account-map.json'), 'utf8'));
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const report = O.observe({ provider: 'lunchmoney', payload: fixture, accountMap: map, data });
  const actuals = report.currentPeriodActuals;
  const blob = JSON.stringify(actuals);
  ok(actuals && actuals.schema === 'atlas-current-period-actuals/v1',
    'observer emits a sanitized current-period actuals packet');
  ok(!/"payee"\s*:/.test(blob) && !/"providerTransactionId"\s*:/.test(blob)
      && !/"original_name"\s*:/.test(blob) && !/"providerAccountId"\s*:/.test(blob)
      && !/"notes"\s*:/.test(blob) && !/"tags"\s*:/.test(blob),
    'actuals packet has no raw payee, notes, tags, or provider ids');
  ok(/"displayedPayee"\s*:/.test(blob) && /"originalMerchant"\s*:/.test(blob),
    'actuals packet keeps sanitized displayedPayee / originalMerchant');
  ok(O.currentPeriodActualsLooksSanitized(actuals),
    'observer packet passes the sanitizer');
  ok(Array.isArray(actuals.transactions) && actuals.transactions.some(tx =>
      tx && (tx.account || tx.atlasAccountId)
      && Object.prototype.hasOwnProperty.call(tx, 'isGroup')
      && Object.prototype.hasOwnProperty.call(tx, 'parentId')
      && Object.prototype.hasOwnProperty.call(tx, 'dogFood')
      && Object.prototype.hasOwnProperty.call(tx, 'merchantKnown')),
    'Forecast actuals keep local ids, account, isGroup, parentId, and derived flags');
  const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  ok(/const KNOBS = \['scenario'/.test(planSrc)
    && /localStorage\.setItem\(KNOB_KEY/.test(planSrc)
    && !/currentPeriodActuals/.test(planSrc.match(/function saveKnobs[\s\S]*?\n\}/)[0]),
    'plan knobs persist only planning knobs, not transactions');
  ok(!/localStorage\.setItem\([^)]*currentPeriodActuals/.test(planSrc + fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')),
    'page scripts do not write actuals into localStorage');
  const overlayFn = L.overlayLiveState.toString();
  ok(/currentPeriodActuals/.test(overlayFn),
    'live overlay is the publication path for current-period actuals');
  const failed = L.failedOverlay
    ? L.failedOverlay(data, 'stale-live-cash-evidence')
    : null;
  if (failed) {
    ok(!failed.liveOverlay.currentPeriodActuals,
      'a failed overlay does not publish current-period actuals');
  } else {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'live-plan.js'), 'utf8');
    ok(/function failedOverlay[\s\S]*?currentPeriodActuals: opts\.currentPeriodActuals \|\| null/.test(src)
      && /applied: false/.test(src),
      'failed overlay meta defaults currentPeriodActuals to null');
  }
}

console.log('\n=== observer category identity passes through ===');
{
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: '2026-09-08T18:00:00.000Z',
    transactionWindow: { startDate: '2026-09-01', endDate: '2026-09-08' },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    accounts: [{
      id: 1001, name: 'Cheq', type: 'cash', balance: 100,
      updated_at: '2026-09-08T17:00:00.000Z',
    }],
    categories: [
      { id: 11, name: 'Groceries', is_income: false, exclude_from_totals: false },
      { id: 82, name: 'Transfer', is_income: false, exclude_from_totals: true },
    ],
    transactions: [
      { id: 1, account_id: 1001, date: '2026-09-02', amount: 12.5, category_id: 11, is_pending: false, payee: 'SYNTHETIC GROCER', original_name: 'SYNTHETIC GROCER', notes: 'weekly shop', tags: ['fixture'] },
      { id: 2, account_id: 1001, date: '2026-09-03', amount: 40, category_id: 82, is_pending: false, payee: 'SYNTHETIC TRANSFER' },
      { id: 3, account_id: 1001, date: '2026-09-04', amount: 80, category_id: 11, is_pending: false, payee: 'SPLIT PARENT', is_group: true, has_children: true },
      { id: 4, account_id: 1001, date: '2026-09-04', amount: 50, category_id: 11, is_pending: false, payee: 'SPLIT CHILD', parent_id: 3 },
    ],
  };
  const map = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'connectivity', 'fixtures', 'provider-account-map.json'), 'utf8'));
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap: map, data });
  const grocery = report.currentPeriodActuals.transactions.find(t => t.amount === 12.5);
  const transfer = report.currentPeriodActuals.transactions.find(t => t.amount === 40);
  ok(grocery && grocery.categoryLabel === 'Groceries' && grocery.accountRole === 'household-cash',
    'Lunch Money category name is normalized without a merchant guess');
  ok(transfer && transfer.excludeFromTotals === true && transfer.categoryLabel === 'Transfer',
    'transfer category identity is preserved');
  ok(transfer && transfer.displayedPayee == null && transfer.originalMerchant == null,
    'excluded transfer does not publish merchant identity');
  ok(!report.currentPeriodActuals.transactions.some(t =>
      t.payee || t.notes || t.tags
      || t.providerTransactionId || t.providerAccountId
      || t.original_name || t.originalName),
    'sanitized actuals dropped raw payee, notes, tags, and provider ids');
  ok(grocery && grocery.merchantKnown === true
      && grocery.dogFood === false
      && grocery.displayedPayee === 'SYNTHETIC GROCER'
      && grocery.originalMerchant === 'SYNTHETIC GROCER'
      && (grocery.account || grocery.atlasAccountId),
    'Forecast packet keeps sanitized merchant identity, derived flags, and canonical account, not raw payee');
  const parent = report.currentPeriodActuals.transactions.find(t => t.amount === 80);
  const child = report.currentPeriodActuals.transactions.find(t => t.amount === 50);
  ok(parent && parent.isGroup === true && child && child.parentId === parent.id
      && parent.id && !/^[0-9]+$/.test(String(parent.id)),
    'packet keeps isGroup/parentId as local ids, not provider ids');
}

console.log('\n=== O. known pending still constrains remaining when pending coverage is incomplete ===');
{
  const txs = [
    {
      date: PAYDAY, amount: 18.40, pending: true,
      pendingTreatment: 'unresolved', categoryLabel: 'Groceries',
      accountRole: 'revolving-credit',
      displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
    },
  ];
  const plan = basePlan();
  const planned = plannedNeed(1800, PAYDAY, PERIOD_LAST);
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs, { pendingCoverage: 'partial' }),
  }));
  const row = cat(action, 'groceries');
  const html = paydayComposer().paydayAnswerHtml({
    plan, asOf: PAYDAY,
    advice: {
      weekly: 180, mode: 'normal',
      paydayAllocation: F.paydayAllocation(plan, PAYDAY, opts({
        currentPeriodActuals: packet(txs, { pendingCoverage: 'partial' }),
      })),
      currentPeriodAction: action,
    },
    recommended: 180, weekly: 180,
  });
  ok(action.remainingClaim === 'posted-only',
    'incomplete pending universe is qualified, not claimed as precise');
  ok(row && near(row.posted, 0) && near(row.pending, 18.40),
    'known pending is labelled pending, not posted');
  ok(row && near(row.committed, 18.40) && near(row.remaining, planned - 18.40),
    'observed pending still reduces available grocery room');
  ok(/pending \$18\.40/.test(html) && /additional unknown pending may exist/.test(html),
    'page shows the pending gravity and the qualified coverage');
}

console.log('\n=== P. truncated posted-transaction page cannot claim precise remaining ===');
{
  const txs = [
    { date: PAYDAY, amount: 40, pending: false, categoryLabel: 'Groceries', accountRole: 'household-cash', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
  ];
  const plan = basePlan();
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs, { transactionCoverage: 'truncated' }),
  }));
  const groceries = cat(action, 'groceries');
  ok(action.remainingClaim === 'unavailable' && action.coverage.status === 'incomplete',
    'truncated posted coverage fails closed');
  ok(groceries && groceries.remaining == null,
    'no precise remaining is published from an incomplete posted page');
}

console.log('\n=== P2. unmapped current-period account cannot claim precise remaining ===');
{
  const txs = [
    { date: PAYDAY, amount: 40, pending: false, categoryLabel: 'Groceries', accountRole: 'unmapped', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
  ];
  const plan = basePlan();
  const unmappedCls = F.classifyCurrentPeriodTransaction(txs[0], plan);
  ok(unmappedCls.kind === 'unmapped' && unmappedCls.householdSpending === true,
    'unmapped is not classified as household-external');
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs, { transactionCoverage: 'complete', pendingCoverage: 'complete' }),
  }));
  const groceries = cat(action, 'groceries');
  ok(action.remainingClaim === 'unavailable' && action.coverage.status === 'incomplete',
    'unmapped account fails remaining closed even if the packet claims complete coverage');
  ok(groceries && groceries.remaining == null,
    'no precise remaining is published from an unresolved account');
}

console.log('\n=== P3. explicit household-external stays excluded without blocking remaining ===');
{
  const txs = [
    { date: PAYDAY, amount: 40, pending: false, categoryLabel: 'Groceries', accountRole: 'revolving-credit', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
    { date: PAYDAY, amount: 99, pending: false, categoryLabel: 'Groceries', accountRole: 'household-external', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
  ];
  const plan = basePlan();
  const externalCls = F.classifyCurrentPeriodTransaction(txs[1], plan);
  ok(externalCls.kind === 'external' && externalCls.householdSpending === false,
    'explicit household-external is non-household spend');
  const origin = PAYDAY;
  const independent = independentSpend([txs[0]], plan, PAYDAY, origin);
  const planned = plannedNeed(1800, origin, PERIOD_LAST);
  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet(txs, { pendingCoverage: 'complete' }),
  }));
  const groceries = cat(action, 'groceries');
  ok(action.remainingClaim === 'precise' || action.remainingClaim === 'posted-only',
    'explicit exclusion keeps remaining available', action.remainingClaim);
  ok(groceries && near(groceries.committed, independent.byId.groceries.posted),
    'only the household grocery counts');
  ok(groceries && near(groceries.remaining, planned - independent.byId.groceries.posted),
    'excluded grocery does not reduce remaining');
}

console.log('\n=== Q. represented bill actual is observed amount, never the schedule ===');
{
  const plan = basePlan({
    bills: [
      { id: 'bcaa', label: 'BCAA', frequency: 'once', date: PAYDAY, amount: 82.96, confidence: 'confirmed' },
    ],
    opening: { asOf: PAYDAY, representedEvents: [{ id: 'bcaa', date: PAYDAY }] },
  });
  const withoutAmount = F.currentPeriodAction(plan, PAYDAY, opts());
  ok(bill(withoutAmount, 'bcaa') && bill(withoutAmount, 'bcaa').actual == null
    && near(bill(withoutAmount, 'bcaa').remaining, 0),
    'identity without an observed amount publishes actual unavailable and remaining 0');
  const withObserved = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet([], {
      representedActuals: [{ id: 'bcaa', date: PAYDAY, actual: 103 }],
    }),
  }));
  const row = bill(withObserved, 'bcaa');
  ok(row && near(row.planned, 82.96) && near(row.actual, 103) && near(row.remaining, 0),
    'observed $103 is actual; planned $82.96 is not copied',
    row && `${row.actual} vs planned ${row.planned}`);
  ok(row && row.settlement === 'represented' && !near(row.actual, row.planned),
    'planned and observed amounts may differ without inventing equality');
}

console.log('\n=== R. automatic-payment identity uses explicit payee+account+date rules ===');
{
  const identity = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'connectivity', 'transaction-identity.json'), 'utf8'));
  const map = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'connectivity', 'fixtures', 'provider-account-map.json'), 'utf8'));
  const bcaaRule = (identity.rules || []).find(r => r.eventId === 'bcaa-aug15-outstanding');
  const icbcRule = (identity.rules || []).find(r => r.eventId === 'icbc-aug15-outstanding');
  const respRule = (identity.rules || []).find(r => r.eventId === 'resp' || r.eventId === 'resp-aug15-outstanding');
  const duesRule = (identity.rules || []).find(r => r.eventId === 'uniondues' || r.eventId === 'uniondues-aug15-outstanding');
  ok(bcaaRule && bcaaRule.payeePattern === 'BCAA-AdvAutoIns' && bcaaRule.atlasAccountId === 'chequing-a'
    && bcaaRule.direction === 'debit',
    'BCAA outstanding uses documented payee+Chequing A debit identity');
  ok(icbcRule && icbcRule.payeePattern === 'ICBC INS' && icbcRule.atlasAccountId === 'chequing-a'
    && icbcRule.direction === 'debit',
    'ICBC outstanding uses documented payee+Chequing A debit identity');
  ok(respRule && respRule.payeePattern === 'TD WATERHOUSE I REP'
    && respRule.atlasAccountId === 'chequing-a' && respRule.direction === 'debit',
    'RESP uses its explicit provider alias + Chequing A debit identity');
  const mortgageRule = (identity.rules || []).find(r => r.eventId === 'mortgage');
  ok(mortgageRule && mortgageRule.payeePattern === 'TD MORTGAGE' && mortgageRule.atlasAccountId === 'chequing-a'
    && mortgageRule.direction === 'debit',
    'mortgage uses documented TD MORTGAGE + Chequing A debit identity');
  const fitRule = (identity.rules || []).find(r => r && r.eventId === 'fit4less');
  ok(fitRule && fitRule.payeePattern === 'Fit4less Msp' && fitRule.atlasAccountId === 'chequing-a'
    && fitRule.direction === 'debit',
    'Fit4Less uses documented Fit4less Msp + Chequing A debit identity');
  const feeRules = (identity.rules || []).filter(r => r && r.eventId === 'tdfees');
  ok(feeRules.length === 2
      && feeRules.every(r => r.settlesWhen === 'two-leg-sum'
        && r.direction === 'debit'
        && (r.payeePatterns || []).includes('MONTHLY ACCOUNT FEE'))
      && feeRules.some(r => r.atlasAccountId === 'chequing-a')
      && feeRules.some(r => r.atlasAccountId === 'chequing-b'),
    'TD fees use standing two-leg MONTHLY ACCOUNT FEE identity');
  const travelRule = (identity.rules || []).find(r => r && r.eventId === 'travel');
  ok(travelRule && travelRule.atlasAccountId === 'travelvisa'
    && travelRule.direction === 'credit'
    && travelRule.payeePattern === 'TFR-TO C/C'
    && travelRule.postingDateRule === 'covers-due-on-or-before-posting'
    && travelRule.settlesWhen === 'amount-at-least'
    && !(travelRule.payeePatterns || []).some(p => /travel visa/i.test(p)),
    'Travel Visa min identity is a payment onto the mapped card, not an invented chequing payee');

  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const outstandingBills = (data.plan.bills || []).filter(b => [
    'bcaa-aug15-outstanding', 'icbc-aug15-outstanding',
    'resp-aug15-outstanding',
  ].includes(b.id));
  ok(outstandingBills.length === 3,
    'canonical plan still names the three 15 August reserved occurrences');
  ok(!(data.plan.bills || []).some(b => b.id === 'uniondues-aug15-outstanding'),
    'cancelled CMAW dues are not a reserved August occurrence');
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: '2026-08-16T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-09', endDate: '2026-08-16', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    accounts: [{
      id: 1001, name: 'Cheq A', type: 'cash', balance: 100,
      updated_at: '2026-08-16T17:00:00.000Z',
    }, {
      id: 1002, name: 'Cheq B', type: 'cash', balance: 50,
      updated_at: '2026-08-16T17:00:00.000Z',
    }],
    categories: [{ id: 11, name: 'Insurance', is_income: false, exclude_from_totals: false }],
    transactions: [
      { id: 1, account_id: 1001, date: '2026-08-16', amount: 103, category_id: 11, is_pending: false, payee: 'BCAA-AdvAutoIns INS' },
      { id: 2, account_id: 1001, date: '2026-08-16', amount: 99.91, category_id: 11, is_pending: false, payee: 'ICBC INS' },
      { id: 3, account_id: 1001, date: '2026-08-16', amount: 100, category_id: 11, is_pending: false, payee: 'INTERNAL TRANSFER RESP' },
      { id: 4, account_id: 1001, date: '2026-08-16', amount: 25, category_id: 11, is_pending: false, payee: 'CMAW LOCAL 1995' },
    ],
  };
  const report = O.observe({
    provider: 'lunchmoney', payload, accountMap: map, data, identity,
  });
  const bcaa = report.representedEventCandidates.find(c => c.id === 'bcaa-aug15-outstanding');
  const icbc = report.representedEventCandidates.find(c => c.id === 'icbc-aug15-outstanding');
  ok(bcaa && bcaa.amountNotUsed === true && bcaa.identity === 'payee+account+date'
    && near(bcaa.observedAmount, 103),
    'BCAA matches payee+account+date; $103 is carried after identity, not used as identity');
  ok(icbc && icbc.amountNotUsed === true,
    'ICBC matches payee+account+date');
  ok(!report.representedEventCandidates.some(c => c.id === 'resp-aug15-outstanding'
    || c.id === 'uniondues-aug15-outstanding'),
    'unauthorized RESP and CMAW labels do not become represented by amount+date');

  const amountOnly = JSON.parse(JSON.stringify(payload));
  amountOnly.transactions = [
    { id: 5, account_id: 1001, date: '2026-08-16', amount: 82.96, is_pending: false, payee: 'UNKNOWN DEBIT' },
  ];
  const rejected = O.observe({
    provider: 'lunchmoney', payload: amountOnly, accountMap: map, data, identity,
  });
  ok(!rejected.representedEventCandidates.some(c => String(c.id).indexOf('bcaa') === 0),
    'same scheduled date and BCAA amount without the documented payee stays unverified');

  const wrongAccount = JSON.parse(JSON.stringify(payload));
  wrongAccount.transactions = [
    { id: 6, account_id: 1002, date: '2026-08-16', amount: 82.96, is_pending: false, payee: 'BCAA-AdvAutoIns INS' },
  ];
  const misplaced = O.observe({
    provider: 'lunchmoney', payload: wrongAccount, accountMap: map, data, identity,
  });
  ok(!misplaced.representedEventCandidates.some(c => String(c.id).indexOf('bcaa') === 0),
    'documented BCAA payee on Chequing B is not inferred as the Chequing A bill');

  const wrongDate = JSON.parse(JSON.stringify(payload));
  wrongDate.transactions = [
    { id: 7, account_id: 1001, date: '2026-08-15', amount: 82.96, is_pending: false, payee: 'BCAA-AdvAutoIns INS' },
  ];
  const dated = O.observe({
    provider: 'lunchmoney', payload: wrongDate, accountMap: map, data, identity,
  });
  ok(!dated.representedEventCandidates.some(c => String(c.id).indexOf('bcaa') === 0),
    'BCAA on 15 August is not stretched onto the 16 August scheduled occurrence');

  const forecastPlan = basePlan({
    opening: {
      asOf: '2026-08-16',
      representedEvents: report.representedEventCandidates.map(c => ({ id: c.id, date: c.date })),
    },
    income: [{
      id: 'pay', label: 'Pay', frequency: 'once', date: '2026-08-28',
      amount: 2500, confidence: 'confirmed',
    }],
    bills: outstandingBills,
  });
  const action = F.currentPeriodAction(forecastPlan, '2026-08-16', opts({
    currentPeriodActuals: report.currentPeriodActuals,
  }));
  const bcaaBill = bill(action, 'bcaa-aug15-outstanding');
  const respBill = bill(action, 'resp-aug15-outstanding');
  ok(bcaaBill && bcaaBill.settlement === 'represented' && near(bcaaBill.actual, 103)
    && near(bcaaBill.remaining, 0),
    'identified BCAA publishes observed actual, not the $82.96 schedule');
  ok(respBill && respBill.settlement !== 'represented' && near(respBill.remaining, 100),
    'RESP without its explicit provider alias is not marked paid');
  ok(!/"payee"\s*:/.test(JSON.stringify(report.currentPeriodActuals)),
    'sanitized represented actuals still drop raw payee');
  ok(!(report.currentPeriodActuals.transactions || []).some(tx =>
      tx && (tx.displayedPayee || tx.originalMerchant)),
    'represented bill and unmatched insurance rows do not publish merchant identity');
}

console.log('\n=== R2. grocery with the same date and amount as a represented bill stays Groceries ===');
{
  const identity = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'connectivity', 'transaction-identity.json'), 'utf8'));
  const map = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'connectivity', 'fixtures', 'provider-account-map.json'), 'utf8'));
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: '2026-08-16T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-09', endDate: '2026-08-16', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    accounts: [{
      id: 1001, name: 'Cheq A', type: 'cash', balance: 100,
      updated_at: '2026-08-16T17:00:00.000Z',
    }],
    categories: [
      { id: 11, name: 'Insurance', is_income: false, exclude_from_totals: false },
      { id: 22, name: 'Groceries', is_income: false, exclude_from_totals: false },
    ],
    transactions: [
      { id: 41, account_id: 1001, date: '2026-08-16', amount: 103, category_id: 11, is_pending: false, payee: 'BCAA-AdvAutoIns INS' },
      { id: 42, account_id: 1001, date: '2026-08-16', amount: 103, category_id: 22, is_pending: false, payee: 'SYNTHETIC GROCER' },
    ],
  };
  const report = O.observe({
    provider: 'lunchmoney', payload, accountMap: map, data, identity,
  });
  const packet = report.currentPeriodActuals;
  ok(O.currentPeriodActualsLooksSanitized(packet),
    'collision fixture packet is sanitized');
  const billRow = (packet.representedActuals || []).find(r => r.id === 'bcaa-aug15-outstanding');
  ok(billRow && billRow.transactionId && near(billRow.actual, 103),
    'unique BCAA hit is linked by local transactionId, not amount');
  const billTx = (packet.transactions || []).find(tx => tx.id === billRow.transactionId);
  const groceryTx = (packet.transactions || []).find(tx =>
    tx && tx.categoryLabel === 'Groceries' && Number(tx.amount) === 103);
  ok(billTx && groceryTx && billTx.id !== groceryTx.id,
    'bill payment and grocery are distinct local rows');
  ok(billTx.representedBill === true && groceryTx.representedBill !== true,
    'only the unique identity hit is flagged representedBill');
  const groceryCls = F.classifyCurrentPeriodTransaction(groceryTx, basePlan(), {
    currentPeriodActuals: packet,
  });
  const billCls = F.classifyCurrentPeriodTransaction(billTx, basePlan(), {
    currentPeriodActuals: packet,
  });
  ok(groceryCls.kind === 'spend' && groceryCls.categoryId === 'groceries',
    'a grocery purchase with the same date and amount as a represented bill remains Groceries');
  ok(billCls.kind === 'bill' && billCls.reason === 'represented-bill',
    'only the exact linked transaction is excluded as a bill');

  const noLinkPacket = {
    representedActuals: [{ id: 'bcaa-aug15-outstanding', date: '2026-08-16', actual: 103 }],
  };
  const ambiguousGrocery = F.classifyCurrentPeriodTransaction({
    id: 'tx-groc',
    date: '2026-08-16',
    amount: 103,
    categoryLabel: 'Groceries',
    accountRole: 'household-cash',
    merchantKnown: true,
  }, basePlan(), { currentPeriodActuals: noLinkPacket });
  ok(ambiguousGrocery.kind === 'spend' && ambiguousGrocery.categoryId === 'groceries',
    'ambiguous bill linkage without a local transactionId fails closed; grocery stays Groceries');
}

console.log('\n=== R3. sanitizer rejects renamed raw transaction metadata ===');
{
  const renamed = [
    'original_name', 'originalName',
    'payee', 'notes', 'note', 'tags', 'tag',
    'providerTransactionId', 'providerAccountId',
    'provider_transaction_id', 'merchant', 'merchantName',
    'displayed_payee', 'original_merchant',
    'pending_transaction_id', 'pendingTransactionId',
    'plaid_metadata', 'plaidMetadata',
    'plaidTransactionId', 'plaidPendingTransactionId',
    'transaction_id',
  ];
  for (const key of renamed) {
    const leaked = {
      schema: 'atlas-current-period-actuals/v1',
      transactions: [{ id: 'tx-1', date: '2026-08-15', amount: 12, [key]: 'SAFEWAY' }],
    };
    ok(!O.currentPeriodActualsLooksSanitized(leaked),
      `sanitizer rejects renamed raw field ${key}`);
  }
  const withIdentity = {
    schema: 'atlas-current-period-actuals/v1',
    transactions: [{
      id: 'tx-1', date: '2026-08-15', amount: 12,
      displayedPayee: 'SAFEWAY', originalMerchant: 'SAFEWAY',
      merchantKnown: true, categoryLabel: 'Groceries',
    }],
  };
  ok(O.currentPeriodActualsLooksSanitized(withIdentity),
    'sanitizer allows displayedPayee and originalMerchant as identity fields');
  const clean = {
    schema: 'atlas-current-period-actuals/v1',
    representedActuals: [{
      id: 'bcaa', date: '2026-08-16', actual: 103, transactionId: 'tx-1',
    }],
    transactions: [{
      id: 'tx-1', date: '2026-08-16', amount: 103,
      dogFood: false, merchantKnown: true, representedBill: true,
      personalOwner: null, categoryLabel: 'Insurance',
    }],
  };
  ok(O.currentPeriodActualsLooksSanitized(clean),
    'sanitizer allows derived flags and local transactionId references');
}

console.log('\n=== R4. merchant identity stays off excluded kinds and accounts ===');
{
  const plan = basePlan();
  const map = {
    schema: 'atlas-provider-account-map/v1',
    mappings: [
      {
        providerAccountId: '1001',
        canonical: { collection: 'cash', id: 'chequing-a' },
        atlasRole: 'household-cash',
      },
      { providerAccountId: '9999', atlasRole: 'household-external' },
    ],
  };
  const packet = O.sanitizedCurrentPeriodActuals({
    fetchedAt: PAYDAY + 'T18:00:00.000Z',
    transactionWindow: { startDate: PAYDAY, endDate: PAYDAY, complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: PAYDAY, amount: 18.56, pending: false, categoryLabel: 'Groceries',
        payee: 'Save-On-Foods', originalName: 'Save-On-Foods',
        providerAccountId: '1001', providerTransactionId: 'groc-1',
      },
      {
        date: PAYDAY, amount: 2500, pending: false, categoryLabel: 'Income',
        payee: 'SEASPAN PAYROLL', originalName: 'SEASPAN PAYROLL',
        isIncome: true, providerAccountId: '1001', providerTransactionId: 'inc-1',
      },
      {
        date: PAYDAY, amount: 40, pending: false, categoryLabel: 'Transfer',
        payee: 'INTERNAL TRANSFER', originalName: 'INTERNAL TRANSFER',
        excludeFromTotals: true, kind: 'transfer',
        providerAccountId: '1001', providerTransactionId: 'xfer-1',
      },
      {
        date: PAYDAY, amount: 200, pending: false, categoryLabel: 'Payment',
        payee: 'VISA PAYMENT', originalName: 'VISA PAYMENT',
        excludeFromTotals: true, kind: 'payment',
        providerAccountId: '1001', providerTransactionId: 'pay-1',
      },
      {
        date: PAYDAY, amount: 103, pending: false, categoryLabel: 'Insurance',
        payee: 'BCAA-AdvAutoIns INS', originalName: 'BCAA-AdvAutoIns INS',
        providerAccountId: '1001', providerTransactionId: 'bill-1',
      },
      {
        date: PAYDAY, amount: 80, pending: false, categoryLabel: 'Business',
        payee: 'ACME CORP', originalName: 'ACME CORP',
        providerAccountId: '1001', providerTransactionId: 'biz-1',
      },
      {
        date: PAYDAY, amount: 99, pending: false, categoryLabel: 'Groceries',
        payee: 'COSTCO', originalName: 'COSTCO',
        providerAccountId: '9999', providerTransactionId: 'ext-1',
      },
      {
        date: PAYDAY, amount: -12, pending: false, categoryLabel: 'Groceries',
        payee: 'REFUND GROCER', originalName: 'REFUND GROCER',
        providerAccountId: '1001', providerTransactionId: 'ref-1',
      },
    ],
    representedEventCandidates: [{
      id: 'bcaa', date: PAYDAY, observedAmount: 103,
      providerTransactionId: 'bill-1', postingDate: PAYDAY,
    }],
  }, { asOf: PAYDAY, plan, accountMap: map });

  function byAmount(amount) {
    return (packet.transactions || []).find(tx => tx && Number(tx.amount) === amount) || null;
  }
  function noMerchant(tx) {
    return !tx || (tx.displayedPayee == null && tx.originalMerchant == null
      && !Object.prototype.hasOwnProperty.call(tx, 'displayedPayee')
      && !Object.prototype.hasOwnProperty.call(tx, 'originalMerchant'));
  }

  const grocery = byAmount(18.56);
  const income = byAmount(2500);
  const transfer = byAmount(40);
  const payment = byAmount(200);
  const billTx = byAmount(103);
  const business = byAmount(80);
  const external = byAmount(99);
  const refund = byAmount(-12);

  ok(grocery && grocery.displayedPayee === 'Save-On-Foods'
      && grocery.originalMerchant === 'Save-On-Foods',
    'eligible Household Budget grocery keeps sanitized merchant identity');
  ok(F.classifyCurrentPeriodTransaction.householdBudgetSupportingSpendEligible(
      F.classifyCurrentPeriodTransaction(grocery, plan, { currentPeriodActuals: packet })) === true
      && F.classifyCurrentPeriodTransaction(grocery, plan, { currentPeriodActuals: packet }).categoryId === 'groceries',
    'eligible grocery still classifies as Groceries spend');
  ok(income && F.classifyCurrentPeriodTransaction(income, plan, { currentPeriodActuals: packet }).kind === 'income'
      && noMerchant(income),
    'income publishes no merchant identity');
  ok(transfer && F.classifyCurrentPeriodTransaction(transfer, plan, { currentPeriodActuals: packet }).kind === 'transfer'
      && noMerchant(transfer),
    'transfer publishes no merchant identity');
  ok(payment && F.classifyCurrentPeriodTransaction(payment, plan, { currentPeriodActuals: packet }).kind === 'card-payment'
      && noMerchant(payment),
    'card payment publishes no merchant identity');
  ok(billTx && billTx.representedBill === true
      && F.classifyCurrentPeriodTransaction(billTx, plan, { currentPeriodActuals: packet }).kind === 'bill'
      && noMerchant(billTx),
    'represented bill publishes no merchant identity');
  ok(business && F.classifyCurrentPeriodTransaction(business, plan, { currentPeriodActuals: packet }).kind === 'business'
      && noMerchant(business),
    'excluded business row publishes no merchant identity');
  ok(external && external.accountRole === 'household-external'
      && F.classifyCurrentPeriodTransaction(external, plan, { currentPeriodActuals: packet }).kind === 'external'
      && noMerchant(external),
    'household-external grocery publishes no merchant identity');
  ok(refund && F.classifyCurrentPeriodTransaction(refund, plan, { currentPeriodActuals: packet }).kind === 'refund'
      && noMerchant(refund),
    'refund publishes no merchant identity');

  const action = F.currentPeriodAction(plan, PAYDAY, opts({
    currentPeriodActuals: packet,
  }));
  const groceries = cat(action, 'groceries');
  const planned = plannedNeed(1800, PAYDAY, PERIOD_LAST);
  ok(groceries && near(groceries.committed, 18.56) && near(groceries.remaining, planned - 18.56),
    'Spent/Remaining still count only the eligible grocery, not excluded counterparties');
  ok(!/"payee"\s*:/.test(JSON.stringify(packet))
      && O.currentPeriodActualsLooksSanitized(packet),
    'gated merchant packet still drops raw payee and passes the sanitizer');
}

function independentInventory(txs, plan, asOf, origin) {
  let householdSpend = 0;
  let named = 0;
  let unclassified = 0;
  let excluded = 0;
  const namedIds = {};
  for (const tx of txs) {
    if (tx.date < origin || tx.date > asOf) continue;
    const cls = F.classifyCurrentPeriodTransaction(tx, plan);
    if (cls.kind === 'spend' && cls.categoryId && cls.categoryId !== 'uncategorised') {
      householdSpend += 1;
      named += 1;
      namedIds[cls.categoryId] = (namedIds[cls.categoryId] || 0) + 1;
    } else if (cls.kind === 'unclassified' || cls.kind === 'unmapped'
      || (cls.kind === 'spend' && cls.categoryId === 'uncategorised')) {
      householdSpend += 1;
      unclassified += 1;
    } else {
      excluded += 1;
    }
  }
  return { householdSpend, named, unclassified, excluded, namedById: namedIds };
}

console.log('\n=== S. named remaining is not precise while household spend is unclassified ===');
{
  const namedTxs = [
    { date: PAYDAY, amount: 40, pending: false, categoryLabel: 'Groceries', accountRole: 'revolving-credit', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' },
    { date: PAYDAY, amount: 15, pending: false, categoryLabel: 'Fuel & transport', accountRole: 'household-cash', displayedPayee: 'Shell', originalMerchant: 'Shell' },
  ];
  const unclassifiedTxs = [
    { date: PAYDAY, amount: 12.50, pending: false, categoryLabel: 'Gifts', accountRole: 'household-cash' },
  ];
  const excludedTxs = [
    {
      date: PAYDAY, amount: 50, pending: false, categoryLabel: 'Transfer',
      accountRole: 'household-cash', excludeFromTotals: true, kindHint: 'transfer',
    },
    {
      date: PAYDAY, amount: 200, pending: false, categoryLabel: 'Payment',
      accountRole: 'household-cash', excludeFromTotals: true, kindHint: 'payment',
    },
    {
      date: PAYDAY, amount: 2500, pending: false, categoryLabel: 'Income',
      accountRole: 'household-cash', isIncome: true,
    },
    {
      date: PAYDAY, amount: 80, pending: false, categoryLabel: 'Business',
      accountRole: 'household-cash',
    },
    {
      date: PAYDAY, amount: 99, pending: false, categoryLabel: 'Groceries',
      accountRole: 'household-external',
      displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
    },
  ];
  const pendingNamed = [{
    date: PAYDAY, amount: 18.40, pending: true,
    pendingTreatment: 'unresolved', categoryLabel: 'Groceries',
    accountRole: 'revolving-credit',
    displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
  }];

  console.log('  --- S1. fully classified period may claim precise named remaining ---');
  {
    const txs = namedTxs.slice();
    const plan = basePlan();
    const inv = independentInventory(txs, plan, PAYDAY, PAYDAY);
    ok(inv.householdSpend === 2 && inv.named === 2 && inv.unclassified === 0 && inv.excluded === 0,
      'independent inventory: 2 named household-spend, 0 unclassified, 0 excluded',
      JSON.stringify(inv));
    const actionOpts = opts({
      currentPeriodActuals: packet(txs, { pendingCoverage: 'complete' }),
    });
    const action = F.currentPeriodAction(plan, PAYDAY, actionOpts);
    ok(action.remainingClaim === 'precise',
      'provider coverage remainingClaim is precise');
    ok(action.categoryRemainingClaim === 'precise',
      'named remaining may be precise when every household-spend tx is classified');
    ok(action.unclassified.count === 0, 'no unclassified household spend');
    const groceries = cat(action, 'groceries');
    const fuel = cat(action, 'fuel');
    const gNeed = plannedNeed(1800, PAYDAY, PERIOD_LAST);
    const fNeed = plannedNeed(600, PAYDAY, PERIOD_LAST);
    ok(groceries && near(groceries.remaining, gNeed - 40),
      'grocery remaining is planned − classified posted');
    ok(fuel && near(fuel.remaining, fNeed - 15),
      'fuel remaining is planned − classified posted');
    const html = paydayComposer().paydayAnswerHtml({
      plan, asOf: PAYDAY,
      advice: {
        weekly: 180, mode: 'normal',
        paydayAllocation: F.paydayAllocation(plan, PAYDAY, actionOpts),
        currentPeriodAction: action,
      },
      recommended: 180, weekly: 180,
    });
    ok(/Actual spending through/.test(html),
      'page may describe remaining from complete classified actuals');
    ok(/<th>Remaining<\/th>/.test(html) && !/Observed remaining/.test(html),
      'column header is Remaining, not a qualified observed label');
    ok(!/Category allocation incomplete/.test(html),
      'fully classified period does not warn about allocation');
  }

  console.log('  --- S2. unclassified household spend keeps coverage precise, remaining not precise ---');
  {
    const txs = namedTxs.concat(unclassifiedTxs);
    const plan = basePlan();
    ok(namedTxs.length === 2 && unclassifiedTxs.length === 1 && excludedTxs.length === 5,
      'fixture inventory is 2 named, 1 unclassified, 5 excluded constructed separately');
    const inv = independentInventory(txs, plan, PAYDAY, PAYDAY);
    ok(inv.householdSpend === 3 && inv.named === 2 && inv.unclassified === 1 && inv.excluded === 0,
      'independent inventory: 3 household-spend = 2 named + 1 unclassified',
      JSON.stringify(inv));
    const actionOpts = opts({
      currentPeriodActuals: packet(txs, { pendingCoverage: 'complete' }),
    });
    const action = F.currentPeriodAction(plan, PAYDAY, actionOpts);
    ok(action.remainingClaim === 'precise',
      'complete provider coverage still reports remainingClaim precise');
    ok(action.categoryRemainingClaim === 'classified-incomplete',
      'named remaining is not precise while unclassified household spend exists');
    ok(action.unclassified.count === 1 && near(action.unclassified.posted, 12.50),
      'unclassified Gifts remains visible in uncategorised with its dollar amount');
    const groceries = cat(action, 'groceries');
    ok(groceries && near(groceries.posted, 40),
      'classified grocery actuals are still calculated');
    ok(groceries && groceries.remaining != null,
      'observed grocery remaining is still shown');
    ok(!(action.categories || []).some(c => c.id !== 'uncategorised' && near(c.posted, 12.50)),
      'unmapped Gifts is not guessed into a named household category');
    ok(near(action.unclassified.posted, 12.50),
      'unmapped Gifts stays in the unclassified remainder, not a named row');
    const html = paydayComposer().paydayAnswerHtml({
      plan, asOf: PAYDAY,
      advice: {
        weekly: 180, mode: 'normal',
        paydayAllocation: F.paydayAllocation(plan, PAYDAY, actionOpts),
        currentPeriodAction: action,
      },
      recommended: 180, weekly: 180,
    });
    ok(/Transaction coverage complete/.test(html) && /Category allocation incomplete/.test(html),
      'page distinguishes complete transaction coverage from incomplete category allocation');
    ok(/Observed remaining/.test(html),
      'named remaining is labelled observed, not proven precise');
    ok(!/>Remaining</.test(html) || /Observed remaining/.test(html),
      'UI does not present Remaining as an unqualified precise claim');
    ok(/uncategorised/.test(html) && /12\.50/.test(html),
      'uncategorised spending remains visible');
  }

  console.log('  --- S3. excluded non-spend does not degrade category remaining precision ---');
  {
    const txs = [namedTxs[0]].concat(excludedTxs);
    const plan = basePlan();
    const inv = independentInventory(txs, plan, PAYDAY, PAYDAY);
    ok(inv.householdSpend === 1 && inv.named === 1 && inv.unclassified === 0 && inv.excluded === 5,
      'independent inventory: 1 named household-spend, 5 excluded, 0 unclassified',
      JSON.stringify(inv));
    const action = F.currentPeriodAction(plan, PAYDAY, opts({
      currentPeriodActuals: packet(txs, { pendingCoverage: 'complete' }),
    }));
    ok(action.remainingClaim === 'precise',
      'coverage remainingClaim stays precise');
    ok(action.categoryRemainingClaim === 'precise',
      'exclusions do not make named remaining imprecise');
    ok(action.unclassified.count === 0, 'excluded txs are not unclassified household spend');
    const groceries = cat(action, 'groceries');
    const gNeed = plannedNeed(1800, PAYDAY, PERIOD_LAST);
    ok(groceries && near(groceries.posted, 40) && near(groceries.remaining, gNeed - 40),
      'only the household grocery constrains remaining');
    ok(near(action.excluded.transfers, 50) || action.excluded.transfers > 0,
      'transfer exclusion is recorded');
  }

  console.log('  --- S4. classified pending still constrains remaining; claim stays precise ---');
  {
    const txs = pendingNamed.slice();
    const plan = basePlan();
    const inv = independentInventory(txs, plan, PAYDAY, PAYDAY);
    ok(inv.named === 1 && inv.unclassified === 0,
      'independent inventory: pending grocery is named, not unclassified');
    const actionOpts = opts({
      currentPeriodActuals: packet(txs, { pendingCoverage: 'complete' }),
    });
    const action = F.currentPeriodAction(plan, PAYDAY, actionOpts);
    const groceries = cat(action, 'groceries');
    const gNeed = plannedNeed(1800, PAYDAY, PERIOD_LAST);
    ok(action.remainingClaim === 'precise',
      'complete pending coverage keeps coverage remainingClaim precise');
    ok(action.categoryRemainingClaim === 'precise',
      'classified pending does not degrade category remaining precision');
    ok(groceries && near(groceries.posted, 0) && near(groceries.pending, 18.40),
      'pending is pending, not posted');
    ok(groceries && near(groceries.remaining, gNeed - 18.40),
      'classified pending constrains grocery remaining');
  }

  console.log('  --- S5. one unclassified tx blocks globally proven precise named remaining ---');
  {
    const txs = [namedTxs[0]].concat(unclassifiedTxs);
    const plan = basePlan();
    const inv = independentInventory(txs, plan, PAYDAY, PAYDAY);
    ok(inv.named === 1 && inv.unclassified === 1 && inv.namedById.groceries === 1 && !inv.namedById.fuel,
      'independent inventory: groceries classified, fuel has no classified txs, Gifts unclassified',
      JSON.stringify(inv));
    const actionOpts = opts({
      currentPeriodActuals: packet(txs, { pendingCoverage: 'complete' }),
    });
    const action = F.currentPeriodAction(plan, PAYDAY, actionOpts);
    const fuel = cat(action, 'fuel');
    const groceries = cat(action, 'groceries');
    const fNeed = plannedNeed(600, PAYDAY, PERIOD_LAST);
    ok(action.remainingClaim === 'precise',
      'provider coverage remains complete');
    ok(action.categoryRemainingClaim === 'classified-incomplete',
      'one unclassified household tx prevents a precise named-remaining claim');
    ok(fuel && near(fuel.posted, 0) && near(fuel.remaining, fNeed),
      'fuel observed remaining equals full planned because no classified fuel actuals exist');
    ok(groceries && near(groceries.posted, 40),
      'groceries still show classified actuals');
    ok(!(action.categories || []).some(c => c && (
      Object.prototype.hasOwnProperty.call(c, 'remainingIsPrecise')
      || Object.prototype.hasOwnProperty.call(c, 'remainingClaim')
      || Object.prototype.hasOwnProperty.call(c, 'categoryRemainingClaim')
    )),
      'no per-category remaining-precision field is invented');
    const html = paydayComposer().paydayAnswerHtml({
      plan, asOf: PAYDAY,
      advice: {
        weekly: 180, mode: 'normal',
        paydayAllocation: F.paydayAllocation(plan, PAYDAY, actionOpts),
        currentPeriodAction: action,
      },
      recommended: 180, weekly: 180,
    });
    ok(/Observed remaining/.test(html),
      'UI labels remaining as observed when any household spend is unclassified');
    ok(/Category allocation incomplete/.test(html),
      'UI does not imply unaffected named rows are globally proven precise');
    ok(!/remaining is precise|precise remaining/i.test(html),
      'page copy does not call named remaining precise');
  }

  console.log('  --- S6. explicit Uncategorised household spend is classification-incomplete ---');
  {
    const uncategorisedTxs = [{
      date: PAYDAY, amount: 22, pending: false,
      categoryLabel: 'Uncategorised', accountRole: 'household-cash',
    }];
    const txs = [namedTxs[0]].concat(uncategorisedTxs);
    const plan = basePlan();
    const uncatCls = F.classifyCurrentPeriodTransaction(uncategorisedTxs[0], plan);
    ok(uncatCls.kind === 'spend' && uncatCls.categoryId === 'uncategorised',
      'independent classifier: provider Uncategorised matches the incumbent remainder category as spend');
    const inv = independentInventory(txs, plan, PAYDAY, PAYDAY);
    ok(inv.named === 1 && inv.unclassified === 1 && inv.namedById.groceries === 1 && !inv.namedById.uncategorised,
      'independent inventory counts explicit Uncategorised as unclassified remainder, not a trusted named category',
      JSON.stringify(inv));
    const actionOpts = opts({
      currentPeriodActuals: packet(txs, { pendingCoverage: 'complete' }),
    });
    const action = F.currentPeriodAction(plan, PAYDAY, actionOpts);
    const uncat = cat(action, 'uncategorised');
    ok(action.remainingClaim === 'precise',
      'provider coverage remainingClaim stays precise');
    ok(action.categoryRemainingClaim === 'classified-incomplete',
      'named remaining is not precise while household spend sits in the uncategorised bucket');
    ok(uncat && near(uncat.posted, 22),
      'the Uncategorised amount remains visible on the uncategorised row');
    ok(action.unclassified.count === 1 && near(action.unclassified.posted, 22),
      'confidence accumulator treats canonical uncategorised spend as classification-incomplete');
    const html = paydayComposer().paydayAnswerHtml({
      plan, asOf: PAYDAY,
      advice: {
        weekly: 180, mode: 'normal',
        paydayAllocation: F.paydayAllocation(plan, PAYDAY, actionOpts),
        currentPeriodAction: action,
      },
      recommended: 180, weekly: 180,
    });
    ok(/Observed remaining/.test(html),
      'Plan renders Observed remaining for explicit Uncategorised household spend');
    ok(/Category allocation incomplete/.test(html),
      'Plan does not present named remaining as precise while the remainder bucket has spend');
  }
}

console.log('\n=== ET. outgoing e-transfer review publication (additional visibility only) ===');
{
  const etPlan = () => basePlan({
    opening: { asOf: MID, priorAsOf: PAYDAY, representedEvents: [] },
    income: [{ id: 'pay', label: 'Pay', frequency: 'once', date: NEXT, amount: 2500, confidence: 'confirmed' }],
  });
  const etPacket = (txs, extra) => packet(txs, Object.assign({
    asOf: MID, coverageStart: PAYDAY, coverageThrough: MID, transactionCoverage: 'complete',
    transactionWindow: { startDate: PAYDAY, endDate: MID, complete: true, hasMore: false, truncated: false },
  }, extra || {}));
  const groceryRow = {
    id: 'et-grocery', date: '2026-09-02', amount: 50, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash', displayedPayee: 'Save-On-Foods',
  };
  const etRow = (id, extra) => Object.assign({
    id, date: '2026-09-03', amount: 75, pending: false, categoryLabel: 'Transfer',
    accountRole: 'household-cash', atlasAccountId: 'chequing-a', outgoingETransferIdentity: true,
  }, extra || {});
  const incumbent = action => JSON.stringify({
    categories: action.categories, unclassified: action.unclassified,
    excluded: action.excluded, remainingClaim: action.remainingClaim,
    categoryRemainingClaim: action.categoryRemainingClaim,
    internalMovements: action.internalMovements,
  });

  // Population: transfer-labelled and unclassified flagged rows, posted and
  // pending; item shape is exactly id/date/amount/pending/account.
  const flagged = [
    etRow('et-a'),
    etRow('et-b', { date: '2026-09-04', amount: 40, categoryLabel: null }),
    etRow('et-c', { date: '2026-09-05', amount: 25, pending: true, pendingTreatment: 'unresolved' }),
  ];
  const withFlagged = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([groceryRow].concat(flagged)),
  }));
  const pub = withFlagged.outgoingETransfers;
  ok(pub && pub.status === 'available-complete',
    'explicit complete evidence publishes available-complete', pub && pub.status);
  ok(pub && pub.count === 3 && Array.isArray(pub.items) && pub.items.length === 3,
    'all three flagged rows are published', pub && String(pub.count));
  ok(pub && JSON.stringify(Object.keys(pub.items[0]).sort())
      === JSON.stringify(['account', 'amount', 'date', 'id', 'pending']),
    'published items carry only id/date/amount/pending/account — no descriptor, payee or category');
  ok(pub && pub.items.some(i => i.id === 'et-a' && i.amount === 75 && i.account === 'chequing-a' && i.pending === false)
    && pub.items.some(i => i.id === 'et-c' && i.pending === true),
    'posted and observed-pending items publish with their pending flag');
  ok(!JSON.stringify(pub).includes('SEND E-TFR') && !JSON.stringify(pub).includes('Transfer'),
    'the publication contains no descriptor or category text');

  // Classification and totals are byte-identical with and without the
  // flag: same rows, identity boolean off. The publication is a sibling,
  // never a reclassification — the rows feed the incumbent aggregates
  // exactly as they did before the boolean existed.
  const unflagged = flagged.map(row => Object.assign({}, row, { outgoingETransferIdentity: false }));
  const withoutFlagged = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([groceryRow].concat(unflagged)),
  }));
  ok(incumbent(withFlagged) === incumbent(withoutFlagged),
    'incumbent categories/unclassified/excluded/claims are byte-identical with the flag on or off');
  ok(withoutFlagged.outgoingETransfers.count === 0,
    'the same rows unflagged publish an empty (complete-evidence) list');
  ok(F.classifyCurrentPeriodTransaction(flagged[0], etPlan()).kind === 'transfer'
    && F.classifyCurrentPeriodTransaction(flagged[1], etPlan()).kind === 'unclassified',
    'flagged rows keep their incumbent classifications (transfer / unclassified)');

  // Exclusions: each row below carries the identity boolean and must stay
  // out of the publication, each for its named reason.
  const exclusions = [
    ['card-payment category label (Credit card payment)', etRow('ex-cc-label', { categoryLabel: 'Credit card payment' })],
    ['card-payment kind hint', etRow('ex-cc-hint', { kindHint: 'payment' })],
    ['stamped cardPaymentIdentity', etRow('ex-cc-flag', { cardPaymentIdentity: true })],
    ['personal-loan debt payment label', etRow('ex-debt-label', { categoryLabel: 'Personal loan payment' })],
    ['represented bill', etRow('ex-bill', { representedBill: true })],
    ['pending matching card-paid bill', etRow('ex-pending-bill', { pending: true, pendingTreatment: 'unresolved', pendingMatchingCardPaidBill: true })],
    ['revolving-credit account', etRow('ex-revolving', { accountRole: 'revolving-credit' })],
    ['refund (negative amount)', etRow('ex-refund', { amount: -30 })],
    ['income row', etRow('ex-income', { isIncome: true })],
    ['identity boolean absent (SEND E-TFR FEE stamps false upstream)', etRow('ex-fee', { outgoingETransferIdentity: false })],
  ];
  for (const [label, row] of exclusions) {
    const action = F.currentPeriodAction(etPlan(), MID, opts({
      currentPeriodActuals: etPacket([groceryRow, row]),
    }));
    ok(action.outgoingETransfers.count === 0
      && !action.outgoingETransfers.items.some(i => i.id === row.id),
      `excluded from the publication: ${label}`,
      JSON.stringify(action.outgoingETransfers.items));
  }

  // Refinement 3 — explicit negative case: a confirmed named spending
  // category row plus a residual transfer hint. Classify returns transfer
  // early (before category resolution), so kind alone would admit it; the
  // named category must exclude it, and its classification stays untouched.
  const namedRow = etRow('ex-named', { categoryLabel: 'Groceries', kindHint: 'transfer' });
  const namedCls = F.classifyCurrentPeriodTransaction(namedRow, etPlan(),
    { currentPeriodActuals: etPacket([namedRow]) });
  ok(namedCls.kind === 'transfer',
    'setup: the named-category row with a transfer hint really does classify as transfer', namedCls.kind);
  const namedAction = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([groceryRow, namedRow]),
  }));
  ok(namedAction.outgoingETransfers.count === 0,
    'a confirmed named spending category row is excluded despite the residual transfer hint');

  // ATLAS-043: 'Coffee Shops' joins the same named-category authority as
  // the incumbent Eating Out labels (Restaurants / Fast Food / Food
  // Delivery). The helper's behaviour changes for coffee-labelled rows
  // only in that they are now named; the row's own classification is
  // untouched, exactly as for the Groceries row above.
  const coffeeNamedRow = etRow('ex-coffee-named', { categoryLabel: 'Coffee Shops', kindHint: 'transfer' });
  const coffeeNamedCls = F.classifyCurrentPeriodTransaction(coffeeNamedRow, etPlan(),
    { currentPeriodActuals: etPacket([coffeeNamedRow]) });
  ok(coffeeNamedCls.kind === 'transfer',
    'setup: the Coffee Shops row with a transfer hint really does classify as transfer', coffeeNamedCls.kind);
  const coffeeNamedAction = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([groceryRow, coffeeNamedRow]),
  }));
  ok(coffeeNamedAction.outgoingETransfers.count === 0
    && !coffeeNamedAction.outgoingETransfers.items.some(i => i.id === 'ex-coffee-named'),
    'a Coffee Shops-labelled row is a confirmed named category and is excluded from the e-transfer publication');

  // Coverage states.
  const missing = F.currentPeriodAction(etPlan(), MID, opts());
  ok(missing.outgoingETransfers.status === 'unavailable-missing'
    && missing.outgoingETransfers.count === null && missing.outgoingETransfers.items === null,
    'no packet: unavailable-missing with null count/items — never a zero all-clear');

  const stale = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-stale')], { coverageThrough: '2026-09-05' }),
  }));
  ok(stale.outgoingETransfers.status === 'unavailable-stale'
    && stale.outgoingETransfers.count === null && stale.outgoingETransfers.items === null,
    'stale evidence: unavailable-stale, stale items are not shown as current-period fact');

  const truncated = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-trunc')], { transactionCoverage: 'truncated' }),
  }));
  ok(truncated.outgoingETransfers.status === 'available-incomplete'
    && truncated.outgoingETransfers.count === null && truncated.outgoingETransfers.items === null,
    'truncated coverage: available-incomplete with no list and no count when nothing was collected');

  const postedOnly = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-po')], { pendingCoverage: 'unknown' }),
  }));
  ok(postedOnly.outgoingETransfers.status === 'available-posted-only'
    && postedOnly.outgoingETransfers.count === 1 && postedOnly.outgoingETransfers.items.length === 1,
    'pending coverage incomplete alone: available-posted-only with the observed subset');

  // Legacy defaults must not manufacture completeness (refinement 4). C2 supersedes the
  // earlier incumbent behaviour: an absent transactionCoverage stamp is no longer read as
  // complete, so the claim is unavailable and the publication follows it (no list, no count).
  const legacyTx = etPacket([etRow('et-legacy')]); delete legacyTx.transactionCoverage;
  const legacyAction = F.currentPeriodAction(etPlan(), MID, opts({ currentPeriodActuals: legacyTx }));
  ok(legacyAction.remainingClaim === 'unavailable'
    && legacyAction.outgoingETransfers.status === 'available-incomplete'
    && legacyAction.outgoingETransfers.count === null && legacyAction.outgoingETransfers.items === null,
    'missing transactionCoverage (C2): the claim is unavailable and the publication withholds list and count (available-incomplete)');
  const noObs = etPacket([etRow('et-noobs')]); noObs.observationAsOf = null;
  const noObsAction = F.currentPeriodAction(etPlan(), MID, opts({ currentPeriodActuals: noObs }));
  ok(noObsAction.outgoingETransfers.status === 'available-incomplete',
    'missing observationAsOf: no available-complete all-clear');
  const noStart = etPacket([etRow('et-nostart')]); noStart.coverageStart = null;
  const noStartAction = F.currentPeriodAction(etPlan(), MID, opts({ currentPeriodActuals: noStart }));
  ok(noStartAction.outgoingETransfers.status === 'available-incomplete',
    'missing coverageStart: no available-complete all-clear');
  const lateStart = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-late')], { coverageStart: '2026-09-03' }),
  }));
  ok(lateStart.outgoingETransfers.status === 'available-incomplete'
    && lateStart.outgoingETransfers.items === null,
    'coverage starting after the period origin: available-incomplete, nothing collected, no count');

  const zeroComplete = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([groceryRow]),
  }));
  ok(zeroComplete.outgoingETransfers.status === 'available-complete'
    && zeroComplete.outgoingETransfers.count === 0
    && Array.isArray(zeroComplete.outgoingETransfers.items) && zeroComplete.outgoingETransfers.items.length === 0,
    'available-complete with no flagged rows is the only factual zero');

  // Repair (Atlas, 2026-10-12) — canonical Uncategorised is the remainder
  // bucket, not a confirmed named category: a flagged row the owner has not
  // categorised must stay in the review list on both classification paths
  // (transfer via an early hint return, and spend into the bucket itself).
  const uncatHint = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-uncat-hint', { categoryLabel: 'Uncategorised', kindHint: 'transfer' })]),
  }));
  ok(uncatHint.outgoingETransfers.count === 1
    && uncatHint.outgoingETransfers.items.some(i => i.id === 'et-uncat-hint' && i.amount === 75),
    'flagged $75 row labelled Uncategorised with a transfer hint stays in the review list');
  const uncatSpend = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-uncat-spend', { categoryLabel: 'Uncategorised' })]),
  }));
  ok(uncatSpend.outgoingETransfers.count === 1
    && uncatSpend.outgoingETransfers.items.some(i => i.id === 'et-uncat-spend' && i.amount === 75),
    'flagged $75 row classified spend into the Uncategorised bucket stays in the review list');
  ok(uncatSpend.outgoingETransfers.status === 'available-complete',
    'the Uncategorised-bucket row publishes under the same complete evidence');
  const uncatUnflagged = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-uncat-spend', { categoryLabel: 'Uncategorised', outgoingETransferIdentity: false })]),
  }));
  ok(incumbent(uncatSpend) === incumbent(uncatUnflagged),
    'listing the bucket row changes no category total, unclassified count or claim');

  // Repair (Atlas, 2026-10-12) — provenance: the transaction window bounds
  // and the observation date are validated, not assumed. Out-of-window or
  // invalidly-dated evidence must not produce an all-clear.
  const noWindow = etPacket([etRow('et-nowin')]); delete noWindow.transactionWindow;
  const noWindowAction = F.currentPeriodAction(etPlan(), MID, opts({ currentPeriodActuals: noWindow }));
  ok(noWindowAction.outgoingETransfers.status === 'available-incomplete',
    'missing transactionWindow: no available-complete all-clear');
  const openWindow = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-openwin')], {
      transactionWindow: { startDate: PAYDAY, endDate: MID, complete: false, hasMore: false, truncated: false },
    }),
  }));
  ok(openWindow.outgoingETransfers.status === 'available-incomplete',
    'window not marked complete: no available-complete all-clear');
  const lateWindow = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-latewin')], {
      transactionWindow: { startDate: '2026-09-03', endDate: MID, complete: true, hasMore: false, truncated: false },
    }),
  }));
  ok(lateWindow.outgoingETransfers.status === 'available-incomplete',
    'window starting after the period origin: no available-complete all-clear');
  const shortWindow = F.currentPeriodAction(etPlan(), MID, opts({
    currentPeriodActuals: etPacket([etRow('et-shortwin')], {
      transactionWindow: { startDate: PAYDAY, endDate: '2026-09-05', complete: true, hasMore: false, truncated: false },
    }),
  }));
  ok(shortWindow.outgoingETransfers.status === 'available-incomplete',
    'window ending before the as-of: no available-complete all-clear');
  const badObs = etPacket([etRow('et-badobs')]); badObs.observationAsOf = 'not-a-date';
  const badObsAction = F.currentPeriodAction(etPlan(), MID, opts({ currentPeriodActuals: badObs }));
  ok(badObsAction.outgoingETransfers.status === 'available-incomplete',
    'invalid observationAsOf: no available-complete all-clear');
  const oldObs = etPacket([etRow('et-oldobs')]); oldObs.observationAsOf = '2026-09-02';
  const oldObsAction = F.currentPeriodAction(etPlan(), MID, opts({ currentPeriodActuals: oldObs }));
  ok(oldObsAction.outgoingETransfers.status === 'available-incomplete',
    'observationAsOf predating the coverage it claims: no available-complete all-clear');
  const futureObs = etPacket([etRow('et-futureobs')]); futureObs.observationAsOf = '2026-12-31';
  const futureObsAction = F.currentPeriodAction(etPlan(), MID, opts({ currentPeriodActuals: futureObs }));
  ok(futureObsAction.outgoingETransfers.status === 'available-incomplete',
    'observationAsOf after the financial as-of: no available-complete all-clear');
}

console.log('\n=== ET2. unprocessable e-transfer candidates: producer to publication (P1 4253396900) ===');
{
  // Repair (Atlas BLOCK 5497313211): the sanitizer drops a household-cash
  // SEND E-TFR row whose amount cannot be qualified, before identity
  // detection. The packet's dates-only outgoingETransferUnconfirmed entry
  // must withhold the publication's available-complete all-clear for any
  // period the candidate date falls in — without touching the review
  // population, classification, or totals. These cases run the real
  // producer (sanitizedCurrentPeriodActuals) into the real publication.
  const et2Plan = () => basePlan({
    opening: { asOf: MID, priorAsOf: PAYDAY, representedEvents: [] },
    income: [{ id: 'pay', label: 'Pay', frequency: 'once', date: NEXT, amount: 2500, confidence: 'confirmed' }],
  });
  const et2Map = {
    schema: 'atlas-provider-account-map/v1',
    mappings: [
      { providerAccountId: '1001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      { providerAccountId: '2001', canonical: { collection: 'debts', id: 'tdcc' }, atlasRole: 'revolving-credit' },
    ],
  };
  const rawRow = (id, extra) => Object.assign({
    date: '2026-09-03', amount: 75, pending: false, categoryLabel: 'Transfer',
    payee: 'Interac recipient', originalName: 'SEND E-TFR J SMITH', currency: 'cad',
    providerAccountId: '1001', providerTransactionId: id,
  }, extra || {});
  const produce = (txs, pending) => O.sanitizedCurrentPeriodActuals({
    fetchedAt: MID + 'T18:00:00.000Z',
    transactionWindow: { startDate: PAYDAY, endDate: MID, complete: true, hasMore: false, truncated: false },
    pendingCoverage: pending || { complete: true },
    transactions: txs, collapsedTransactions: txs,
    representedEventCandidates: [],
  }, { asOf: MID, accountMap: et2Map, plan: et2Plan() });
  const incumbent = action => JSON.stringify({
    categories: action.categories, unclassified: action.unclassified,
    excluded: action.excluded, remainingClaim: action.remainingClaim,
    categoryRemainingClaim: action.categoryRemainingClaim,
    internalMovements: action.internalMovements,
  });
  const publish = txs => F.currentPeriodAction(et2Plan(), MID, opts({ currentPeriodActuals: produce(txs) }));

  // Invalid-only: the producer records the candidate and the publication
  // withholds the all-clear — an observed subset of zero, not a factual zero.
  const invalidPacket = produce([rawRow('et2-invalid', { amount: 'unavailable' })]);
  ok(Array.isArray(invalidPacket.outgoingETransferUnconfirmed)
    && invalidPacket.outgoingETransferUnconfirmed.length === 1
    && invalidPacket.outgoingETransferUnconfirmed[0].date === '2026-09-03',
    'producer: the unprocessable candidate is recorded as a dates-only entry',
    JSON.stringify(invalidPacket.outgoingETransferUnconfirmed));
  const invalidAction = F.currentPeriodAction(et2Plan(), MID, opts({ currentPeriodActuals: invalidPacket }));
  ok(invalidAction.outgoingETransfers.status === 'available-incomplete'
    && invalidAction.outgoingETransfers.count === 0
    && Array.isArray(invalidAction.outgoingETransfers.items) && invalidAction.outgoingETransfers.items.length === 0,
    'invalid-only: publication is available-incomplete with the empty observed subset — no all-clear',
    invalidAction.outgoingETransfers.status);
  const emptyAction = publish([]);
  ok(incumbent(invalidAction) === incumbent(emptyAction),
    'invalid-only: incumbent categories/totals/claims are identical to the no-candidate packet');

  // Valid flagged row: complete evidence still earns the all-clear.
  const validAction = publish([rawRow('et2-valid')]);
  ok(validAction.outgoingETransfers.status === 'available-complete'
    && validAction.outgoingETransfers.count === 1,
    'valid flagged row: available-complete with count 1', validAction.outgoingETransfers.status);

  // FEE: excluded upstream, no entry, complete state unaffected.
  const feePacket = produce([rawRow('et2-fee', { originalName: 'SEND E-TFR FEE' })]);
  const feeAction = F.currentPeriodAction(et2Plan(), MID, opts({ currentPeriodActuals: feePacket }));
  ok(Array.isArray(feePacket.outgoingETransferUnconfirmed)
    && feePacket.outgoingETransferUnconfirmed.length === 0
    && feeAction.outgoingETransfers.status === 'available-complete'
    && feeAction.outgoingETransfers.count === 0,
    'SEND E-TFR FEE: no unconfirmed entry and the complete state is unaffected');

  // Mixed: the valid item stays listed; completeness is withheld.
  const mixedAction = publish([
    rawRow('et2-mixed-valid'),
    rawRow('et2-mixed-invalid', { amount: 'unavailable', date: '2026-09-04' }),
  ]);
  ok(mixedAction.outgoingETransfers.status === 'available-incomplete'
    && mixedAction.outgoingETransfers.count === 1
    && mixedAction.outgoingETransfers.items.length === 1
    && mixedAction.outgoingETransfers.items[0].amount === 75,
    'mixed valid + invalid: available-incomplete with the one observed item still listed',
    mixedAction.outgoingETransfers.status);

  // Out-of-period candidate: recorded by the producer, scoped out by the
  // publication — the all-clear for this period stands.
  const earlyPacket = produce([rawRow('et2-early', { amount: 'unavailable', date: '2026-08-31' })]);
  const earlyAction = F.currentPeriodAction(et2Plan(), MID, opts({ currentPeriodActuals: earlyPacket }));
  ok(Array.isArray(earlyPacket.outgoingETransferUnconfirmed)
    && earlyPacket.outgoingETransferUnconfirmed.length === 1
    && earlyAction.outgoingETransfers.status === 'available-complete'
    && earlyAction.outgoingETransfers.count === 0,
    'candidate dated before the period origin: all-clear stands',
    earlyAction.outgoingETransfers.status);

  // Posted-only branch (Atlas BLOCK 5498435733): pending coverage unknown
  // alone earns available-posted-only, whose claim is that pending is the
  // SOLE gap. An in-period unprocessable candidate means posted evidence
  // is also lost, so the same guard must withhold posted-only too.
  const unknownPending = {};
  const poInvalid = F.currentPeriodAction(et2Plan(), MID, opts({
    currentPeriodActuals: produce([rawRow('et2-po-invalid', { amount: 'unavailable' })], unknownPending),
  }));
  ok(poInvalid.outgoingETransfers.status === 'available-incomplete'
    && poInvalid.outgoingETransfers.count === 0,
    'invalid-only + unknown pending: available-incomplete — posted-only must not claim pending is the sole gap',
    poInvalid.outgoingETransfers.status);
  const poMixed = F.currentPeriodAction(et2Plan(), MID, opts({
    currentPeriodActuals: produce([
      rawRow('et2-po-valid'),
      rawRow('et2-po-mixed-invalid', { amount: 'unavailable', date: '2026-09-04' }),
    ], unknownPending),
  }));
  ok(poMixed.outgoingETransfers.status === 'available-incomplete'
    && poMixed.outgoingETransfers.count === 1
    && poMixed.outgoingETransfers.items.length === 1,
    'mixed + unknown pending: available-incomplete with the observed item still listed',
    poMixed.outgoingETransfers.status);
  const poValid = F.currentPeriodAction(et2Plan(), MID, opts({
    currentPeriodActuals: produce([rawRow('et2-po-control')], unknownPending),
  }));
  ok(poValid.outgoingETransfers.status === 'available-posted-only'
    && poValid.outgoingETransfers.count === 1,
    'control — valid flagged row + unknown pending, no candidate: available-posted-only stands',
    poValid.outgoingETransfers.status);
  const poFee = F.currentPeriodAction(et2Plan(), MID, opts({
    currentPeriodActuals: produce([rawRow('et2-po-fee', { originalName: 'SEND E-TFR FEE', amount: 'unavailable' })], unknownPending),
  }));
  ok(poFee.outgoingETransfers.status === 'available-posted-only'
    && poFee.outgoingETransfers.count === 0,
    'control — unqualified FEE row + unknown pending: no entry, available-posted-only stands',
    poFee.outgoingETransfers.status);
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll current-period actuals proofs passed.');
