'use strict';
// Invented independently balanced ledger, not copied household cents.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const source = require('./fixtures/card-backfill-data');
const canonical = fs.readFileSync(require.resolve('../data.json'), 'utf8');
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function fixture() {
  const x = source('triangle', 'triangle');
  x.asOf = '2026-10-05';
  x.data.meta.asOf = '2026-10-02';
  x.data.plan.opening.asOf = '2026-10-02';
  x.data.plan.windowDays = 28;
  x.data.plan.income[0].anchor = '2026-10-02';
  x.data.plan.startingCash.breakdown[1].value = 100;
  x.data.plan.obligations[0] = { id: 'triangle', debtId: 'triangle', effect: 'payment',
    label: 'Invented card minimum', frequency: 'monthly', day: 7, firstDue: '2026-10-07',
    amount: 88.88, confidence: 'estimated', payingAccount: 'chequing-a',
    statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08',
      minimum: 91.23, currency: 'cad', confidence: 'confirmed' }] };
  x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2026-10-02', endDate: x.asOf,
    complete: true, hasMore: false, truncated: false };
  x.payload.transactions = [
    { id: 94001, account_id: 3001, date: x.asOf, amount: 100, currency: 'cad',
      payee: 'Invented retailer', category_name: 'Credit card payment', is_pending: false },
    { id: 94002, account_id: 3002, date: x.asOf, amount: 35.70, currency: 'cad',
      payee: 'Invented retailer', category_name: 'Superstores', is_pending: false }
  ];
  x.payload.accounts.forEach(a => { a.updated_at = x.asOf + 'T17:00:00Z'; a.balance_last_update = x.asOf + 'T17:00:00Z'; });
  x.payload.accounts[0].balance = 400;
  x.payload.accounts[1].balance = 64.30;
  x.payload.accounts[3].balance = 400;
  return x;
}
function sent(x, changes = {}) {
  x.data.plan.obligations[0].sentPayments = [{ scheduledDate: '2026-10-07',
    confirmed: true, intent: 'minimum', debitId: 'invented-bank-debit',
    postedOn: '2026-10-05', amount: 100, currency: 'cad',
    fundingAccountId: 'chequing-a', pending: false, ...changes }];
  return x;
}
function run(x) {
  const original = JSON.stringify(x);
  const result = Live.fromObservation(x);
  eq(result.data.liveOverlay.applied, true);
  eq(JSON.stringify(x), original, 'input remains immutable');
  const opts = { debts: result.data.debts, currentPeriodActuals: result.data.liveOverlay.currentPeriodActuals };
  const advice = F.recommend(result.data.plan, x.asOf, opts);
  const bill = advice.defaultView.bills.find(row => row.id === 'triangle');
  const period = advice.payPeriodViews.find(row => row.start === '2026-10-02');
  return { ...result, opts, advice, bill, period };
}
const x = fixture(), p = x.data.plan;
eq(F.expandEvents(p, '2026-10-01', '2026-12-31').filter(e => e.id === 'triangle')
  .map(e => [e.date, -e.amount, e.confidence, e.dateConfidence]), [
    ['2026-10-08', 91.23, 'confirmed', 'confirmed'],
    ['2026-11-07', 88.88, 'estimated', undefined],
    ['2026-12-07', 88.88, 'estimated', undefined]]);
eq(F.expandEvents(p, '2026-10-07', '2026-10-07').filter(e => e.id === 'triangle').length, 0);
const moved = F.expandEvents(p, '2026-10-08', '2026-10-08').find(e => e.id === 'triangle');
eq([moved.date, moved.scheduledDate, moved.occurrenceKey, moved.dateConfidence],
  ['2026-10-08', '2026-10-07', 'triangle@2026-10-07', 'confirmed'],
  'replacement before window filtering, stable identity, confirmed date override');
for (const dueDate of ['2026-09-30', '2026-11-01']) {
  const q = structuredClone(p); q.obligations[0].statementOccurrences[0].dueDate = dueDate;
  eq(F.expandEvents(q, dueDate, dueDate).filter(e => e.id === 'triangle').length, 1);
  eq(F.expandEvents(q, '2026-10-07', '2026-10-07').filter(e => e.id === 'triangle').length, 0);
}
for (const changes of [{ dueDate: '2026-02-30' }, { minimum: -1 }, { minimum: 1.001 },
  { currency: 'usd' }, { confidence: 'estimated' }, { dateConfidence: 'verified' },
  { scheduledDate: '2026-10-06' }, { dueDate: '2026-11-07' }]) {
  const q = structuredClone(p); Object.assign(q.obligations[0].statementOccurrences[0], changes);
  assert.throws(() => F.expandEvents(q, '2026-10-01', '2026-11-30')); checks++;
}
for (const dateConfidence of [null, undefined, '', false, 0, [], {}]) {
  const q = structuredClone(p);
  q.obligations[0].statementOccurrences[0].dateConfidence = dateConfidence;
  assert.throws(() => F.expandEvents(q, '2026-10-01', '2026-11-30'),
    /Statement must replace/, 'explicit malformed date trust must not become confirmed'); checks++;
}
eq(F.expandEvents(p, '2026-10-08', '2026-10-08')[0].dateConfidence, 'confirmed',
  'omitted legacy date confidence retains confirmed statement-date trust');
{
  const amountOnly = structuredClone(p);
  amountOnly.obligations[0].statementOccurrences[0].dueDate = '2026-10-07';
  amountOnly.obligations[0].statementOccurrences[0].dateConfidence = 'estimated';
  const original = F.expandEvents(amountOnly, '2026-10-01', '2026-12-31')
    .filter(e => e.id === 'triangle');
  eq(original.map(e => [e.date, -e.amount, e.confidence, e.dateConfidence]), [
    ['2026-10-07', 91.23, 'confirmed', 'estimated'],
    ['2026-11-07', 88.88, 'estimated', undefined],
    ['2026-12-07', 88.88, 'estimated', undefined]],
    'amount confirmation does not promote a retained planning date');
  const amountOnlyRun = run((() => {
    const x = fixture();
    x.data.plan.obligations[0].statementOccurrences[0].dueDate = '2026-10-07';
    x.data.plan.obligations[0].statementOccurrences[0].dateConfidence = 'estimated';
    return sent(x, { cashIncludedAsOf: '2026-10-05' });
  })());
  eq([amountOnlyRun.bill.date, amountOnlyRun.bill.planned, amountOnlyRun.bill.confidence,
    amountOnlyRun.bill.dateConfidence, amountOnlyRun.bill.householdPaymentStatus],
    ['2026-10-07', 91.23, 'confirmed', 'estimated', 'paid'],
    'settlement uses confirmed amount trust without confirming the planning date');
  const BillDetail = require('../public/bill-detail');
  const detail = BillDetail.html(amountOnlyRun.bill, amountOnlyRun.data);
  eq(/Due date<\/dt><dd>2026-10-07 · estimated/.test(detail), true,
    'Plan bill detail reprints estimated date trust');
  eq(/Published confidence<\/dt><dd>confirmed/.test(detail), true,
    'Plan bill detail keeps confirmed amount trust');
  const planSrc = fs.readFileSync(require.resolve('../public/plan.js'), 'utf8');
  const grabPlan = re => { const m = re.exec(planSrc); eq(!!m, true, 'plan helper present'); return m[0]; };
  const labelCtx = { Date, Intl };
  vm.createContext(labelCtx);
  vm.runInContext([
    fs.readFileSync(require.resolve('../public/app.js'), 'utf8').match(/^const fmtDate = .*$/m)[0],
    grabPlan(/^function glanceLineLabel\([\s\S]*?\n\}$/m),
    'this.glanceLineLabel = glanceLineLabel;',
  ].join('\n'), labelCtx);
  eq(labelCtx.glanceLineLabel(amountOnlyRun.bill, 'still due'),
    'Invented card minimum · Oct 7 · estimated · still due',
    'Plan date line keeps estimated indication after amount confirmation');
  const debtCtx = { Date, escapeHtml: require('./app-escape-html') };
  vm.createContext(debtCtx);
  vm.runInContext([
    fs.readFileSync(require.resolve('../public/app.js'), 'utf8').match(/^const money2 = .*$/m)[0],
    fs.readFileSync(require.resolve('../public/app.js'), 'utf8').match(/^const fmtDate = .*$/m)[0],
    grabPlan(/^function operatingDebtAnswerHtml\([\s\S]*?\n\}$/m),
    'this.operatingDebtAnswerHtml = operatingDebtAnswerHtml;',
  ].join('\n'), debtCtx);
  const debtHtml = debtCtx.operatingDebtAnswerHtml({
    requiredDebtPayments: { items: [{
      label: 'Invented card minimum', date: '2026-10-07', amount: 91.23,
      confidence: 'confirmed', dateConfidence: 'estimated', settlement: 'upcoming',
    }] },
    extraDebt: { allocated: 0 },
  });
  eq(/Oct 7 · estimated/.test(debtHtml) && /\$91\.23/.test(debtHtml), true,
    'required-debt date keeps estimated indication while the amount stays confirmed');
}
const duplicate = structuredClone(p);
duplicate.obligations[0].statementOccurrences.push({ ...duplicate.obligations[0].statementOccurrences[0] });
assert.throws(() => F.expandEvents(duplicate, '2026-10-01', '2026-11-30')); checks++;
const zero = structuredClone(p); zero.obligations[0].statementOccurrences[0].minimum = 0;
eq(F.expandEvents(zero, '2026-10-01', '2026-10-31').filter(e => e.id === 'triangle').length, 0);

const base = run(fixture());
eq([base.data.plan.startingCash.breakdown[0].value, base.data.plan.startingCash.breakdown[1].value], [400, 64.30]);
eq(base.period.householdBudget.reduce((sum, row) => sum + (row.spent || 0), 0), 35.70, 'purchase once, transfer no expense');
eq([base.bill.date, base.bill.planned, base.bill.confidence, base.bill.dateConfidence],
  ['2026-10-08', 91.23, 'confirmed', 'confirmed']);
eq(base.bill.status === 'PAID', false, 'bank movement alone has no minimum intent');
eq(base.data.debts[0].balance, 400, 'sender-only bank debit does not change card stock');

for (const included of [undefined, '2026-10-05', '2026-10-06']) {
  const input = sent(fixture(), included ? { cashIncludedAsOf: included } : {});
  const r = run(input);
  eq([r.bill.cashPaymentStatus, r.bill.cashPaid, r.bill.issuerMinimumStatus, r.bill.remaining,
    r.bill.additionalCashRequired, r.bill.status], ['sent', 100, 'unconfirmed', null, null, 'unconfirmed']);
  eq(r.bill.cashInclusionStatus, included === '2026-10-05' ? 'included' : 'unconfirmed');
  eq(r.advice.weekly, null, 'unknown issuer cash is not spend permission');
  eq([r.advice.sim.ending, r.advice.sim.min.balance, r.advice.knowledge.ending, r.advice.gap],
    [null, null, null, null], 'conditional unknown-cash walk is not a public figure');
  const sim = F.simulate(r.data.plan, input.asOf, { horizonDays: 10 });
  eq([sim.status, sim.ending, sim.additionalCashRequired], ['unavailable', null, null]);
  eq(sim.daily.every(row => row.balance === null), true);
  eq(F.recommendWeekly(r.data.plan, input.asOf), null);
  eq(r.period.fromTodayFunding.status, 'unavailable');
  eq(F.baselineTrajectory(r.data.plan, r.data.debts, input.asOf, r.opts).status, 'unavailable');
  const current = F.expandEvents(r.data.plan, input.asOf, '2026-10-31');
  eq(current.filter(e => e.id === 'triangle').reduce((sum, e) => sum - e.amount, 0), 0,
    'known sent allocation is not a second full scheduled debit');
  const walk = F.projectDebts(r.data.plan, r.data.debts, input.asOf, { debtHorizonDays: 10 });
  eq(walk.byId.triangle.paid, 0, 'no invented receiving-side principal reduction');
  eq(r.data.plan.opening.representedEvents.filter(e => e.id === 'triangle').length, 0);
  eq(run(input).advice, r.advice, 'repeat observation is stable');
  eq(JSON.stringify(r.advice.cardMinimumPayments).includes('invented-bank-debit'), false,
    'private debit identity does not enter publication');
}
// Passing the due date does not resurrect a second minimum after a cutover.
const afterDue = sent(fixture());
afterDue.data.plan.opening = { asOf: '2026-10-10', priorAsOf: '2026-10-02' };
eq(F.expandEvents(afterDue.data.plan, '2026-10-10', '2026-10-31').filter(e => e.id === 'triangle')
  .map(e => [e.date, e.amount, e.minimumPayment.cashPaymentStatus]), [['2026-10-08', 0, 'sent']]);
// A partial confirmed send still leaves issuer-dependent extra cash unknown.
const partial = run(sent(fixture(), { amount: 10, cashIncludedAsOf: '2026-10-05' }));
eq([partial.bill.cashPaid, partial.bill.planned, partial.bill.additionalCashRequired], [10, 91.23, null]);
const two = sent(fixture());
two.data.plan.obligations[0].sentPayments.push({ ...two.data.plan.obligations[0].sentPayments[0],
  debitId: 'invented-second-debit', amount: 5 });
eq(run(two).bill.cashPaid, 105, 'two distinct posted debits sum once');
two.data.plan.obligations[0].sentPayments[1].debitId = 'invented-bank-debit';
const duplicated = run(two);
eq(duplicated.bill.cashPaid, 100, 'same debit cannot be allocated twice');
eq(duplicated.advice.cardMinimumPayments.issues.includes('sent-payment-allocated-more-than-once'), true);
for (const changes of [{ intent: 'purchase-backfill' }, { intent: 'unconfirmed' },
  { confirmed: false }, { pending: true }, { amount: -100 }, { amount: 0 },
  { currency: 'usd' }, { fundingAccountId: 'chequing-b' }, { debitId: '' },
  { cashIncludedAsOf: '2026-10-04' }, { postedOn: '2026-10-06' }]) {
  const input = sent(fixture(), changes), r = run(input);
  eq(r.bill.status === 'PAID', false);
  eq(r.bill.cashPaymentStatus, undefined, 'pending, refund, unknown or backfill is not sent minimum evidence');
  eq(r.bill.remaining, 91.23, 'existing contractual minimum remains one requirement');
  eq(r.data.debts[0].balance, 400);
}
// Explicit receipt evidence does not infer a new payment or change card stock.
const paidInput = sent(fixture(), { cashIncludedAsOf: '2026-10-05' });
paidInput.data.plan.opening.representedEvents = [{ id: 'triangle', date: '2026-10-07', effectiveAsOf: '2026-10-05' }];
const paid = run(paidInput);
eq([paid.bill.status, paid.bill.issuerMinimumStatus, paid.bill.remaining], ['PAID', 'satisfied', 0]);
eq(paid.data.debts[0].balance, 400);
const oldOpening = structuredClone(paidInput.data.plan);
eq(F.expandEvents(oldOpening, '2026-10-02', '2026-10-10').filter(e => e.id === 'triangle').map(e => -e.amount), [91.23],
  'current qualification cannot suppress a historical opening');

const cents = value => Math.round(Number(value) * 100);
const Reconcile = require('../scripts/reconcile');
function blockerPlan(changes = {}) {
  return {
    opening: { asOf: changes.asOf || '2026-10-05',
      representedEvents: changes.represented || [] },
    windowDays: 90,
    startingCash: { breakdown: [
      { id: 'chequing-a', value: 5000 }, { id: 'chequing-b', value: 0 },
      { id: 'savings', value: 0 }] },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    income: [{ id: 'payroll', label: 'Seaspan - invented', frequency: 'biweekly',
      anchor: '2026-10-02', amount: 2000, confidence: 'confirmed' }],
    bills: [],
    commitments: changes.commitments || [],
    budget: { categories: [] },
    obligations: [{
      id: 'card', debtId: 'card', effect: 'payment', label: 'Invented card minimum',
      frequency: 'monthly', day: 7, firstDue: changes.firstDue || '2026-10-07',
      amount: 47.39, confidence: 'estimated', payingAccount: 'chequing-a',
      statementOccurrences: changes.statements === null ? undefined : (changes.statements || [{
        scheduledDate: '2026-10-07', dueDate: '2026-10-08',
        minimum: 47.39, currency: 'cad', confidence: 'confirmed' }]),
      sentPayments: changes.sent,
    }],
  };
}
const sentOct = {
  scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum',
  debitId: 'invented-oct-debit', postedOn: '2026-10-05', amount: 47.39,
  currency: 'cad', fundingAccountId: 'chequing-a', pending: false,
  cashIncludedAsOf: '2026-10-05',
};
const observedDebts = [{ id: 'card', label: 'Invented card', balance: 821.43,
  pending: 0, rate: 0, limit: 2000 }];

// 1. Same-date observed debt already includes the posted payment.
const stockPlan = blockerPlan({
  sent: [sentOct],
  represented: [{ id: 'card', date: '2026-10-07', effectiveAsOf: '2026-10-05' }],
});
const stockWalk = F.projectDebts(stockPlan, observedDebts, '2026-10-05', { debtHorizonDays: 10 });
eq(cents(stockWalk.marks[0].debts[0].balance), 82143, 'observed opening stock is the independent input');
eq([cents(stockWalk.byId.card.paid), cents(stockWalk.byId.card.balance)], [0, 82143],
  'neither sender evidence nor receipt annotation subtracts an already reflected payment');
eq(cents(F.projectDebts(blockerPlan({ sent: [sentOct] }), observedDebts, '2026-10-05',
  { debtHorizonDays: 10 }).byId.card.paid), 0, 'sender-only evidence invents no principal reduction');

// 2. Unique occurrence attribution; later-opening proof does not leak backward.
const twoCycle = blockerPlan({
  firstDue: '2026-09-07',
  sent: [
    { ...sentOct, scheduledDate: '2026-09-07', debitId: 'invented-sep-debit',
      postedOn: '2026-09-05', cashIncludedAsOf: '2026-09-05' },
    sentOct,
    { ...sentOct, scheduledDate: '2026-11-07', debitId: 'invented-nov-debit',
      postedOn: '2026-11-05', cashIncludedAsOf: '2026-11-05' },
  ],
  represented: [{ id: 'card', date: '2026-10-08', effectiveAsOf: '2026-10-05' }],
});
const twoState = F.cardMinimumState(twoCycle, '2026-11-07');
eq(twoState.payments.map(row => [row.scheduledDate, row.issuerMinimumStatus]), [
  ['2026-09-07', 'unconfirmed'], ['2026-10-07', 'satisfied'], ['2026-11-07', 'unconfirmed'],
], 'one issuer proof satisfies exactly one original scheduled occurrence');
const laterProof = F.cardMinimumState(blockerPlan({ sent: [sentOct] }), '2026-10-05', {
  representedEvents: [{ id: 'card', date: '2026-10-07', effectiveAsOf: '2026-10-20' }],
});
eq(laterProof.payments.map(row => row.issuerMinimumStatus), ['unconfirmed'],
  'later-opening proof cannot satisfy an earlier as-of');
eq(F.expandEvents(blockerPlan({
  asOf: '2026-10-02',
  sent: [sentOct],
  represented: [{ id: 'card', date: '2026-10-07', effectiveAsOf: '2026-10-20' }],
}), '2026-10-02', '2026-10-10').filter(e => e.id === 'card').map(e => [e.date, -e.amount]),
  [['2026-10-08', 47.39]], 'later-opening proof does not suppress an earlier cash opening');
const next = F.creditAccounts(stockPlan, observedDebts, '2026-10-05', {}).cards[0].nextPayment;
eq([next.date, next.amount, next.issuerMinimumStatus],
  ['2026-11-07', 47.39, undefined],
  'october proof does not satisfy the later estimated cycle');

// 3. Reconciliation, matching and classification keep original identity.
const identityPlan = blockerPlan({});
const movedDue = F.expandEvents(identityPlan, '2026-10-08', '2026-10-08').find(e => e.id === 'card');
eq([movedDue.date, movedDue.scheduledDate, movedDue.occurrenceKey],
  ['2026-10-08', '2026-10-07', 'card@2026-10-07']);
const laterEstimate = F.expandEvents(identityPlan, '2026-11-07', '2026-11-07').find(e => e.id === 'card');
eq([laterEstimate.date, laterEstimate.scheduledDate || laterEstimate.date, laterEstimate.id],
  ['2026-11-07', '2026-11-07', 'card'],
  'an unmoved later cycle keeps its own date identity');
eq(Reconcile.scheduledEventExists({ plan: identityPlan }, 'card', '2026-10-07'), true,
  'reconciliation still finds the occurrence by original scheduled date');
eq(Reconcile.scheduledEventExists({ plan: identityPlan }, 'card', '2026-10-08'), true,
  'the moved due date remains the same original occurrence');

// 4. Unknown cash cannot publish feasibility or $NaN amount claims.
const unknownPlan = blockerPlan({
  sent: [{ ...sentOct, cashIncludedAsOf: undefined }],
  commitments: [{ id: 'trip', label: 'Invented trip', date: '2026-12-01',
    amount: 300, flexibility: 'required', confidence: 'confirmed' }],
});
const unknownAdvice = F.recommend(unknownPlan, '2026-10-05', { debts: observedDebts });
eq(unknownAdvice.cardMinimumPayments.status, 'unavailable');
eq(unknownAdvice.weekly, null);
const trip = unknownAdvice.majorPlans.find(row => row.id === 'trip');
eq([trip.verdict, trip.margin, trip.remaining], [null, null, null],
  'unknown cash withholds Plan Spend feasibility');
eq(unknownAdvice.planSpendPaydayFunding.status, 'unavailable');
const appSrc = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const grab = re => re.exec(appSrc)[0];
const helpers = [grab(/^const money = .*$/m), grab(/^const money2 = .*$/m), grab(/^const escapeHtml = .*$/m),
  grab(/^const pct = .*$/m), grab(/^const fmtDate = .*$/m),
  grab(/^const fmtDateLong = .*$/m), grab(/^const fmtDateFull = .*$/m)].join('\n');
const pageCtx = { Forecast: F, App: { register() {}, boot() {} } };
vm.createContext(pageCtx);
vm.runInContext(helpers + '\n' + fs.readFileSync(require.resolve('../public/plan-spend.js'), 'utf8'), pageCtx);
const page = pageCtx.planSpendPageHtml(unknownAdvice, null);
eq(/FEASIBLE IN CURRENT PLAN/.test(page.list), false);
eq(/\$NaN/.test(page.lede + page.list), false);
eq(/STATUS UNAVAILABLE/.test(page.list), true,
  'Plan Spend reprints withheld feasibility instead of an unsupported numeric claim');

{
  // Retain the external repair's independent amount/date and actual-renderer controls.
  const amountOnly = structuredClone(p);
  Object.assign(amountOnly.obligations[0].statementOccurrences[0], {
    dueDate: '2026-10-07', dateConfidence: 'estimated',
  });
  const explicitEstimatedMove = structuredClone(p);
  explicitEstimatedMove.obligations[0].statementOccurrences[0].dateConfidence = 'estimated';
  const legacySameDate = structuredClone(p);
  legacySameDate.obligations[0].statementOccurrences[0].dueDate = '2026-10-07';
  eq(F.expandEvents(legacySameDate, '2026-10-07', '2026-10-07')[0].dateConfidence,
    'confirmed', 'omitted legacy trust remains confirmed when the date is unchanged');
  for (const dueDate of ['2026-10-07', '2026-10-08']) {
    const unknownDate = structuredClone(p);
    Object.assign(unknownDate.obligations[0].statementOccurrences[0], { dueDate, dateConfidence: null });
    assert.throws(() => F.expandEvents(unknownDate, dueDate, dueDate),
      /Statement must replace/, 'unknown date remains unknown whether retained or moved'); checks++;
  }
const amountDebts = [{ id: 'triangle', label: 'Invented card', balance: 400,
  pending: 0, rate: 19.99, rateConvention: 'card', limit: 2000 }];
const amountAdvice = F.recommend(amountOnly, '2026-10-02', { debts: amountDebts });
const amountBill = (amountAdvice.defaultView.bills || []).find(row => row.id === 'triangle');
eq([amountBill.date, amountBill.planned, amountBill.confidence, amountBill.dateConfidence],
  ['2026-10-07', 91.23, 'confirmed', 'estimated'],
  'Plan bill row keeps confirmed amount and estimated retained date');
const amountPay = (amountAdvice.paydayAllocation.obligations.items || [])
  .find(row => row.id === 'triangle' && row.date === '2026-10-07');
eq([amountPay.confidence, amountPay.dateConfidence], ['confirmed', 'estimated'],
  'payday obligation items propagate separate amount/date trust');
const amountNext = F.creditAccounts(amountOnly, amountDebts, '2026-10-05', {}).cards
  .find(row => row.id === 'triangle').nextPayment;
eq([amountNext.date, amountNext.amount, amountNext.confidence, amountNext.dateConfidence],
  ['2026-10-07', 91.23, 'confirmed', 'estimated'],
  'Credit next payment keeps confirmed amount and estimated planning date');

const planSrc = fs.readFileSync(require.resolve('../public/plan.js'), 'utf8');
const grabFn = (src, re) => { const m = re.exec(src); if (!m) throw new Error(String(re)); return m[0]; };
const presentCtx = {};
vm.createContext(presentCtx);
vm.runInContext([
  grab(/^const fmtDate = .*$/m),
  grab(/^const fmtDateFull = .*$/m),
  grab(/^const money2 = .*$/m), grab(/^const escapeHtml = .*$/m),
  grabFn(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m),
].join('\n'), presentCtx);
eq(presentCtx.glanceLineLabel({
  label: 'Invented card minimum', date: '2026-10-07',
  confidence: 'confirmed', dateConfidence: 'estimated',
}, 'still due'), 'Invented card minimum · Oct 7 · estimated · still due',
  'Plan keeps estimated on the retained planning date');
eq(presentCtx.glanceLineLabel({
  label: 'Invented card minimum', date: '2026-10-08',
  confidence: 'confirmed', dateConfidence: 'confirmed',
}, 'still due'), 'Invented card minimum · Oct 8 · still due',
  'Plan does not mark a confirmed statement due date as estimated');
const movedEstimatedNext = F.creditAccounts(explicitEstimatedMove, amountDebts, '2026-10-05', {}).cards
  .find(row => row.id === 'triangle').nextPayment;
eq([movedEstimatedNext.date, movedEstimatedNext.confidence, movedEstimatedNext.dateConfidence],
  ['2026-10-08', 'confirmed', 'estimated'],
  'Credit does not confirm a moved date without date evidence');

const livePlan = JSON.parse(canonical);
const liveCashback = livePlan.plan.obligations.find(row => row.id === 'cashback');
const liveStatement = liveCashback && (liveCashback.statementOccurrences || [])[0];
eq(!!liveStatement, true, 'canonical Cash Back occurrence exists for date-trust encoding');
eq(liveStatement.dueDate === liveStatement.scheduledDate, true,
  'canonical Cash Back retains the original planning date');
eq(liveStatement.dateConfidence, 'estimated',
  'canonical Cash Back records estimated date trust on the retained planning date');
const liveOcc = F.obligationOccurrences(liveCashback, liveStatement.scheduledDate, liveStatement.scheduledDate)[0];
eq([liveOcc.confidence, liveOcc.dateConfidence], ['confirmed', 'estimated'],
  'runtime keeps Cash Back amount confirmed and planning date estimated');

}

const context = { console, Date, Map, Set }; vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve('../public/forecast'), 'utf8'), context);
eq(JSON.parse(JSON.stringify(context.Forecast.expandEvents(p, '2026-10-08', '2026-10-08'))),
  F.expandEvents(p, '2026-10-08', '2026-10-08'), 'browser runs the same contract');
eq(fs.readFileSync(require.resolve('../data.json'), 'utf8'), canonical, 'no canonical writes');
console.log(`PASS card minimum cycle/sender contract: ${checks} independent checks`);
