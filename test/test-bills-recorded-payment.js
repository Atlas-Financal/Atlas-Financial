'use strict';
// Invented cents and explicit intent. Paid here records a complete household
// send; issuer satisfaction, cash inclusion and all financial totals stay separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cp = require('node:child_process');
const F = require('../public/forecast');
const incumbentAdvice = require('./bills-period-end-legacy-comparison');
const Detail = require('../public/bill-detail');
const source = require('./fixtures/card-backfill-data');
const NOW = '2026-10-05';
const BASE = 'ab4cd7ecbbdb776b21412f4cf255e8a8fb3c587c';
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
function fixture(records) {
  const x = source('triangle', 'triangle');
  x.data.meta.asOf = x.asOf = NOW;
  const p = x.data.plan;
  p.opening = { asOf: NOW, priorAsOf: '2026-08-19', representedEvents: [] };
  p.income[0].anchor = '2026-09-25';
  p.startingCash.breakdown[0].value = 785.17;
  p.budget.categories = [];
  p.obligations = [
    { id: 'triangle', label: 'Invented card minimum', debtId: 'triangle',
      effect: 'payment', frequency: 'monthly', day: 7, firstDue: '2026-10-07',
      amount: 43.21, confidence: 'estimated', payingAccount: 'chequing-a',
      statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08',
        minimum: 47.39, currency: 'cad', confidence: 'confirmed' }],
      ...(records ? { sentPayments: records } : {}) },
    { id: 'mbna-aug31', label: 'Invented prior statement', debtId: 'mbna',
      effect: 'payment', frequency: 'once', date: '2026-08-31', amount: 31.17,
      confidence: 'confirmed', payingAccount: 'chequing-a' },
    { id: 'mbna', label: 'Invented recurring minimum', debtId: 'mbna',
      effect: 'payment', frequency: 'monthly', day: 31, firstDue: '2026-09-30',
      amount: 52.33, confidence: 'estimated', payingAccount: 'chequing-a' },
  ];
  return x;
}
function sent(changes = {}) {
  return { scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum',
    debitId: 'invented-recorded-send', postedOn: NOW, amount: 52.67,
    currency: 'cad', fundingAccountId: 'chequing-a', pending: false, ...changes };
}
function renderer() {
  const context = vm.createContext({ Forecast: F, BillDetail: Detail, console,
    addEventListener() {}, document: { addEventListener() {}, querySelectorAll() { return []; },
      getElementById() { return null; }, documentElement: { dataset: {}, style: {} } },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' } });
  vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {};', context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/plan.js'), 'utf8'), context);
  return { presentation(row) { context.row = row; return JSON.parse(vm.runInContext('JSON.stringify(budgetBillPresentation(row))', context)); },
    html(row) { context.row = row; return vm.runInContext('budgetBillBrowseRowHtml(row)', context); } };
}
function publication(x, engine = F) {
  const r = engine.recommend(x.data.plan, NOW, { debts: x.data.debts });
  const period = r.payPeriodViews.find(p => p.timelineRole === 'current');
  return { r, period, row: period.bills.find(b => b.id === 'triangle') };
}
// The previous deployed engine is a regression reference for monetary fields,
// never the independent source of the new household-action expected value.
const prior = { module: { exports: {} }, console };
vm.runInNewContext(cp.execFileSync('git', ['show', BASE + ':public/forecast.js'], { encoding: 'utf8' }), prior);
const oldF = prior.module.exports;
function numbers(value, path = '', out = {}) {
  if (typeof value === 'number' || value === null) out[path] = value;
  else if (value && typeof value === 'object') Object.keys(value).forEach(k => numbers(value[k], path + '/' + k, out));
  return out;
}
const incumbentNumbers = value => numbers(incumbentAdvice(value, NOW));
// PA-4a-2b C7 (Muse #812 6541501158): a card-held close feeds no numeric
// dependent opening. In a card-held publication each projected period's
// opening-dependent chain is null (the frozen engine carried numbers), its
// sweep is null, and every other monetary or null publication still equals
// the frozen engine exactly. A card-clean publication is compared whole.
function frozenEq(r, frozenR, label = 'frozen monetary/null publications') {
  if (r.cardPurchaseCoverage?.status !== 'unavailable') return eq(incumbentNumbers(r), numbers(frozenR), label);
  const current = incumbentNumbers(r), frozen = numbers(frozenR);
  const chain = /^\/(payPeriodViews|defaultView\/calendarPeriods)\/(\d+)\/(opening|openingAsOf|openingSource|currentBalance|incomeAdded|leftover\/currentBalance)$/;
  const projected = (list, index) => {
    const p = list === 'payPeriodViews' ? r.payPeriodViews[index] : r.defaultView.calendarPeriods[index];
    return !!p && p.projected === true;
  };
  let nulled = 0;
  // Authorized addition (coverage authority, blocker 3): while card coverage is unavailable the
  // protected path is unavailable, and future costs and liquidity are withheld with it.
  const withheld = /^\/paydayAllocation\/(liquidity\/(wanted|allocated)|futureCosts\/\d+\/(requiredNow|allocated|projectedByDeadline|shortfall|funded|uncertaintyFunded|margin|remaining|fundingMargin|deferred))$/;
  for (const key of new Set([...Object.keys(current), ...Object.keys(frozen)])) {
    const m = chain.exec(key);
    if (m && projected(m[1], Number(m[2]))) { eq(current[key], null, label + ': C7 null chain ' + key); nulled++; }
    else if (withheld.test(key)) eq(current[key], null, label + ': withheld with the unavailable protected path ' + key);
    else eq(current[key], frozen[key], label + ' ' + key);
  }
  ok(nulled > 0, label + ': the card-held scene withholds its dependent chain');
  for (const p of r.payPeriodViews.filter(p => p.projected)) eq(p.paydaySweep, null, label + ': no numeric sweep from a withheld close');
}
{
  const x = fixture(null), { r } = publication(x), baseline = numbers(publication(x, oldF).r);
  const changedBalance = { ...r, binding: { ...r.binding, balance: r.binding.balance + 0.01 } };
  assert.throws(() => assert.deepEqual(incumbentNumbers(changedBalance), baseline), assert.AssertionError,
    'a one-cent incumbent change is still detected'); checks++;
  const addedMoney = { ...r, unexpectedPublishedCash: 0 };
  assert.throws(() => assert.deepEqual(incumbentNumbers(addedMoney), baseline), assert.AssertionError,
    'unexpected monetary additions are not excluded'); checks++;
  const changedPublisher = { ...r, defaultView: { ...r.defaultView,
    billsAccountPeriodBalance: { ...r.defaultView.billsAccountPeriodBalance, source: 'page' } } };
  assert.throws(() => incumbentNumbers(changedPublisher), assert.AssertionError,
    'new namespace ownership is positively validated'); checks++;
}
const render = renderer();
const cases = [
  ['absent', null, undefined, false],
  ['partial', [sent({ amount: 46.38 })], 'partial', false],
  ['exact', [sent({ amount: 47.39 })], 'paid', true],
  ['excess', [sent()], 'paid', true],
  ['distinct partials make one full send', [sent({ amount: 20.13 }), sent({ debitId: 'invented-second-send', amount: 27.26 })], 'paid', true],
  ['duplicate identity cannot establish payment action', [sent({ amount: 30.13 }), sent({ amount: 30.13 })], 'unconfirmed', false],
  ...[
    [sent(), sent({ amount: 1 })],
    [sent({ amount: 1 }), sent()],
    [sent(), sent()],
    [sent(), sent({ scheduledDate: '2026-11-07' })],
    [sent({ scheduledDate: '2026-11-07' }), sent()],
    ...[{ intent: 'purchase-backfill' }, { intent: 'unconfirmed' },
      { pending: true }, { fundingAccountId: 'chequing-b' }]
      .flatMap(change => [[sent(), sent(change)], [sent(change), sent()]]),
  ].map((records, index) => ['conflicting identity ' + index, records, index === 4 ? undefined : 'unconfirmed', false]),
  ['unrelated backfill does not taint minimum', [sent(), sent({ debitId: 'invented-backfill', intent: 'purchase-backfill' })], 'paid', true],
  ...[{ pending: true }, { confirmed: false }, { intent: 'purchase-backfill' },
    { intent: 'unconfirmed' }, { amount: 0 }, { amount: -1 }, { currency: 'usd' },
    { fundingAccountId: 'chequing-b' }, { postedOn: '2026-10-06' },
    { scheduledDate: '2026-11-07' }].map(change => [JSON.stringify(change), [sent(change)], undefined, false]),
];
for (const [name, records, action, paid] of cases) {
  const x = fixture(records), input = JSON.stringify(x.data), { r, period, row } = publication(x);
  eq(row.householdPaymentStatus, action, name + ': independent full/partial/no-recorded-action oracle');
  eq(render.presentation(row).kind === 'paid', paid, name + ': household Paid display');
  eq(JSON.stringify(x.data), input, 'read/render does not mutate financial data');
  frozenEq(r, publication(x, oldF).r, 'every monetary/null publication unchanged ' + name);
  eq([row.date, row.occurrenceKey], ['2026-10-08', 'triangle@2026-10-07']);
  // Independent cents sum: 3,117 prior + 5,233 recurring + 4,739 statement.
  eq(Math.round(period.totalBillsThisPeriod * 100), 13089, 'three original requirements counted exactly once');
  if (action) {
    eq([row.status, row.issuerMinimumStatus, row.cashInclusionStatus, row.remaining],
      ['unconfirmed', 'unconfirmed', 'unconfirmed', null], 'Paid display cannot satisfy the lender or cash opening');
    eq([r.weekly, r.sim.ending], [null, null], 'unknown funding remains withheld');
    eq(Math.round(period.paidBills * 100), 0, 'household action does not increase confirmed settlement totals');
    eq(F.projectDebts(x.data.plan, x.data.debts, NOW, { debtHorizonDays: 10 }).byId.triangle.paid, 0,
      'observed principal is not reduced again');
    const html = Detail.html(row, x.data, {});
    if (action === 'unconfirmed') {
      ok(html.includes('Payment allocation unconfirmed') && !html.includes('Paid - money sent'));
      ok(!html.includes('invented-recorded-send') && !html.includes('<dt>Money sent</dt>'), 'conflicting send not presented as confirmed evidence');
    } else {
      ok(html.includes('Money sent') && html.includes('Lender minimum confirmation') && html.includes('Not confirmed'));
      ok(html.includes('2026-10-05') && !html.includes('invented-recorded-send'), 'date shown, audit identity private');
    }
  }
  if (paid) ok(render.html(row).includes('Paid · Money sent'), 'complete posted send has a visible qualifier');
}
for (const reverse of [false, true]) {
  const x = fixture([sent()]);
  x.data.plan.obligations[2].sentPayments = [sent({ scheduledDate: '2026-09-30' })];
  if (reverse) x.data.plan.obligations.reverse();
  const { r, period } = publication(x);
  eq(period.bills.filter(row => ['triangle', 'mbna'].includes(row.id))
    .some(row => render.presentation(row).kind === 'paid'), false, 'one debit reused across obligations cannot establish either action');
  frozenEq(r, publication(x, oldF).r, 'cross-obligation conflict preserves every incumbent monetary field');
}
// Independent issuer settlement takes precedence over the household send's
// partial/estimated classification. The action qualifier and funding holds
// remain separate across every receipt, inclusion and identity combination.
for (const mode of ['partial', 'estimated']) for (const receipt of [false, true])
  for (const inclusion of [false, true]) for (const conflict of [false, true]) {
  const records = [sent({ ...(mode === 'partial' ? { amount: 23.11 } : {}),
    ...(inclusion ? { cashIncludedAsOf: NOW } : {}) })];
  if (conflict) records.push(sent({ amount: 1 }));
  const x = fixture(records);
  if (mode === 'estimated') delete x.data.plan.obligations[0].statementOccurrences;
  if (receipt) x.data.plan.opening.representedEvents.push({ id: 'triangle', date: '2026-10-07', effectiveAsOf: NOW });
  const immutable = JSON.stringify(x.data), { r, row } = publication(x), baseline = publication(x, oldF);
  const name = `${mode}: receipt=${receipt}, inclusion=${inclusion}, conflict=${conflict}`;
  eq(row.householdPaymentStatus, conflict ? 'unconfirmed' : mode === 'partial' ? 'partial' : 'sent', name + ': action remains separate');
  eq(render.presentation(row).kind === 'paid', receipt, name + ': qualified issuer settlement stays Paid');
  eq(render.presentation(row).qualifier, conflict ? 'Payment allocation unconfirmed'
    : mode === 'partial' ? 'Partial payment sent' : 'Money sent; minimum amount unconfirmed', name + ': qualifier retained');
  eq([row.status, row.settlement, row.remaining, row.issuerMinimumStatus, row.cashInclusionStatus],
    [baseline.row.status, baseline.row.settlement, baseline.row.remaining, baseline.row.issuerMinimumStatus, baseline.row.cashInclusionStatus], name + ': existing authority unchanged');
  frozenEq(r, baseline.r, name + ': all monetary/null publications unchanged');
  eq(JSON.stringify(x.data), immutable, name + ': read/render remains immutable');
  if (conflict || !receipt || !inclusion) eq(r.sim.ending, null, name + ': unresolved funding remains unavailable');
  else {
    eq(Math.round(F.simulate(x.data.plan, NOW, { horizonDays: 10, weeklyVariable: 0 }).ending * 100),
      170167, name + ': independent opening minus two other requirements plus one payroll, no repeated debit');
    eq(F.projectDebts(x.data.plan, x.data.debts, NOW, { debtHorizonDays: 10 }).byId.triangle.paid, 0,
      name + ': no repeated principal payment');
  }
}
eq(render.presentation({ status: 'PAID', settlement: 'represented' }).kind, 'paid', 'represented settlement without a send remains Paid');
eq(render.presentation({ status: 'pending', settlement: 'represented', cashPaymentStatus: 'sent', householdPaymentStatus: 'partial' }).kind,
  'pending', 'pending evidence retains its existing precedence');
for (const receipt of [false, true]) for (const inclusion of [false, true]) {
  const x = fixture([sent(inclusion ? { cashIncludedAsOf: NOW } : {})]);
  if (receipt) x.data.plan.opening.representedEvents.push({ id: 'triangle', date: '2026-10-07', effectiveAsOf: NOW });
  const { r, row } = publication(x);
  eq(render.presentation(row).kind, 'paid');
  eq([row.issuerMinimumStatus, row.cashInclusionStatus], [receipt ? 'satisfied' : 'unconfirmed', inclusion ? 'included' : 'unconfirmed']);
  eq(r.sim.ending === null, !(receipt && inclusion), 'both separate confirmations needed to release cash publication');
  frozenEq(r, publication(x, oldF).r);
  if (receipt && inclusion) {
    const sim = F.simulate(x.data.plan, NOW, { horizonDays: 10, weeklyVariable: 0 });
    eq(Math.round(sim.ending * 100), 170167, 'independent cash: 78517 - 3117 - 5233 + 100000, both unresolved Amazon cycles and no second Triangle debit');
  }
}
for (const receipt of [false, true]) for (const inclusion of [false, true]) {
  const x = fixture([sent(inclusion ? { cashIncludedAsOf: NOW } : {}), sent({ amount: 1 })]);
  if (receipt) x.data.plan.opening.representedEvents.push({ id: 'triangle', date: '2026-10-07', effectiveAsOf: NOW });
  const { r, row } = publication(x), html = Detail.html(row, x.data, {});
  eq(row.householdPaymentStatus, 'unconfirmed', 'conflict always withholds household action assurance');
  eq(render.presentation(row).kind === 'paid', receipt, 'independent qualified issuer settlement retains existing Paid');
  eq([row.issuerMinimumStatus, row.cashInclusionStatus], [receipt ? 'satisfied' : 'unconfirmed', inclusion ? 'included' : 'unconfirmed']);
  ok(html.includes('Payment allocation unconfirmed') && !html.includes('<dt>Money sent</dt>'));
  ok(html.includes('<dt>Lender minimum confirmation</dt><dd>' + (receipt ? 'Confirmed' : 'Not confirmed') + '</dd>'));
  frozenEq(r, publication(x, oldF).r, 'settled conflict preserves incumbent money and funding holds');
}
{
  const x = fixture([sent()]); delete x.data.plan.obligations[0].statementOccurrences;
  const { r, row } = publication(x);
  eq(row.householdPaymentStatus, 'sent', 'estimated requirement does not establish complete payment');
  eq(render.presentation(row).kind === 'paid', false);
  ok(Detail.html(row, x.data, {}).includes('full required amount is not confirmed'));
  frozenEq(r, publication(x, oldF).r);
}
const { period } = publication(fixture([sent()]));
const amazon = period.bills.filter(row => ['mbna-aug31', 'mbna'].includes(row.id));
eq(amazon.map(row => [row.id, row.date]), [['mbna-aug31', '2026-08-31'], ['mbna', '2026-09-30']], 'distinct prior/current identities retained');
eq(amazon.map(row => Math.round(row.planned * 100)), [3117, 5233]);
ok(render.html(amazon[0]).includes('earlier August statement'));
ok(render.html(amazon[1]).includes('September minimum'));
eq(amazon.every(row => render.presentation(row).kind !== 'paid'), true, 'unattributed same-card transfers cannot mark either cycle Paid');
console.log('Recorded Bills action: ' + checks + ' assertions passed.');
module.exports = { fixture, sent, publication, NOW };
