'use strict';
require('./test-confirmed-card-payment-transfer');
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe');
const OA = require('../scripts/operating-answer');
const RT = require('../scripts/refresh-trust');
const Assistant = require('../scripts/assistant-packet');
const fixture = require('./fixtures/card-purchase-coverage-data');
function run(x) {
  const before = JSON.stringify(x);
  const r = Live.fromObservation(x);
  assert.equal(JSON.stringify(x),before,'inputs are immutable');
  const advice = F.recommend(r.data.plan,x.asOf,{debts:r.data.debts,
    currentPeriodActuals:r.data.liveOverlay.currentPeriodActuals});
  const period = advice.payPeriodViews.find(p=>p.start==='2026-09-18');
  return {...r,advice,period};
}
const before=run(fixture('before')),purchase=run(fixture());
assert.equal(before.period.fromTodayFunding.availableNow,500-25-150);
assert.equal(purchase.period.fromTodayFunding.availableNow,500-25-70-80,
  'card purchase needs coverage immediately; it cannot free 80 before cash backfill');
assert.equal(purchase.period.liveCurrentBalance,500,'observed Bills balance stays actual');
assert.equal(purchase.period.householdBudget[0].spent,80);
assert.equal(purchase.period.householdBudget[0].hold,150,'purchase remains in original allowance once');
assert.equal(purchase.advice.cardPurchaseCoverage.reservedCash,80);
const x=fixture('backfill');
x.payload.transactions[0].amount=30;
x.payload.transactions[1].amount=10;x.payload.transactions[2].amount=-10;
x.payload.accounts[0].balance=490;x.payload.accounts[3].balance=420;
fixture.confirm(x,'partial-first',80002,80003,[[80001,10]]);
let partial=run(x);
assert.equal(partial.advice.cardPurchaseCoverage.reservedCash,20);
assert.equal(partial.period.fromTodayFunding.availableNow,490-25-120-20);
assert.equal(partial.period.householdBudget[0].spent,30);
assert.equal(partial.period.fromTodayFunding.operatingBills,25,'backfill does not settle the minimum');
const secondCash={...x.payload.transactions[1],id:80004,amount:25};
const secondCard={...x.payload.transactions[2],id:80005,amount:-25};
x.payload.transactions.push(secondCash,secondCard);
x.payload.accounts[0].balance=465;x.payload.accounts[3].balance=395;
fixture.confirm(x,'partial-second',80004,80005,[[80001,20]],5,'prior-debt');
const complete=run(x);
assert.equal(complete.advice.cardPurchaseCoverage.reservedCash,0);
assert.equal(complete.advice.cardPurchaseCoverage.payments[1].backfill,20);
assert.equal(complete.advice.cardPurchaseCoverage.payments[1].cardPayment,5);
assert.equal(complete.period.fromTodayFunding.availableNow,465-25-120);
assert.equal(complete.period.liveCurrentBalance,465);
assert.equal(complete.data.debts[0].balance,395);
assert.equal(complete.period.householdBudget[0].spent,30,'transfers cannot add expense');
assert.equal(complete.period.fromTodayFunding.operatingBills,25);
for(const mutate of [
  y=>delete y.data.plan.cardPurchaseCoverage,
  y=>y.data.plan.cardPurchaseCoverage.payments=[],
  y=>y.data.plan.cardPurchaseCoverage.payments[1].otherPurpose=null,
  y=>y.payload.transactions[0].currency='usd',
  y=>delete y.payload.transactions[0].currency,
  y=>y.payload.transactions[1].currency='eur',
  y=>y.payload.transactions[2].is_pending=true,
]) {
  const y=structuredClone(x);mutate(y);const unknown=run(y);
  assert.equal(unknown.advice.cardPurchaseCoverage.status,'unavailable');
  assert.equal(unknown.period.fromTodayFunding.status,'unavailable');
  assert.equal(unknown.period.fromTodayFunding.availableNow,null);
  assert.equal(unknown.period.liveCurrentBalance,465,'unknown intent keeps actual Bills cash');
}
for(const currency of ['usd','eur',null,'']) {
  const y=fixture();y.payload.transactions[0].currency=currency;
  y.payload.transactions[0].to_base=1.4;
  const unknown=run(y),packet=unknown.data.liveOverlay.currentPeriodActuals;
  assert.equal(packet.transactions.length,0,'raw foreign purchase never prints as CAD expense');
  assert.equal(packet.cardCoverageUnconfirmed.length,1);
  assert(!JSON.stringify(packet.cardCoverageUnconfirmed).includes('amount'));
  assert.equal(unknown.period.householdBudget[0].spent,null,'unqualified value is withheld rather than called zero');
  assert.equal(unknown.period.fromTodayFunding.availableNow,null);
}
const pending=fixture();pending.payload.transactions[0].is_pending=true;
assert.equal(run(pending).advice.cardPurchaseCoverage.reservedCash,80);
// Provider-directed replacement keeps one purchase reference, without amount/time guessing.
const directed=fixture();directed.payload.transactions[0].plaid_metadata={
  transaction_id:'posted-invented',pending_transaction_id:'pending-invented'};
directed.payload.transactions.push({...directed.payload.transactions[0],id:80006,
  plaid_metadata:{transaction_id:'pending-invented'},is_pending:true});
const one=run(directed);
assert.equal(one.advice.cardPurchaseCoverage.reservedCash,80);
assert.equal(one.period.householdBudget[0].spent,80);
directed.payload.transactions.at(-1).currency='usd';
assert.equal(run(directed).period.fromTodayFunding.availableNow,null,'replacement cannot launder missing/foreign units');
// Exact remote83 safety cases are retained under explicit intent rather than
// payment-window heuristics. Missing identity/pending cash legs never credit coverage.
for (const mutate of [
  y => y.payload.transactions[2].is_pending = true,
  y => y.payload.transactions[1].is_pending = true,
  y => y.payload.transactions.push({ ...y.payload.transactions[2] }),
]) { const y=structuredClone(x); mutate(y);
  assert.equal(run(y).advice.cardPurchaseCoverage.status,'unavailable'); }
const missingId=structuredClone(x); delete missingId.payload.transactions[2].id;
assert.throws(() => Live.fromObservation(missingId),/missing a stable id/);
for (const mutate of [y => y.payload.transactions[0].amount = null,
  y => y.payload.transactions[0].date = null]) {
  const y=fixture(); mutate(y);
  const row=O.normalizeLunchMoneyTransaction(y.payload.transactions[0]);
  const packet=O.sanitizedCurrentPeriodActuals({fetchedAt:y.payload.fetchedAt,
    transactionWindow:y.payload.transactionWindow,pendingCoverage:y.payload.pendingCoverage,
    transactions:[row]}, {plan:y.data.plan,accountMap:y.accountMap,asOf:y.asOf});
  assert.equal(packet.cardCoverageUnconfirmed.length,1,'invalid mapped card evidence cannot become a zero opening');
  assert.equal(F.visaPaymentReconciliation(packet.transactions,{plan:y.data.plan,
    debts:y.data.debts,packet,asOf:y.asOf}).status,'unavailable');
}
const noIntent=structuredClone(x); noIntent.data.plan.cardPurchaseCoverage.payments=[];
const unknownState=run(noIntent).data;
const operational=OA.fromRefreshedState(unknownState,{mode:'live-overlay'});
assert.equal(operational.moneyAvailable.value,null);
const unknownAdvice = run(noIntent).advice;
assert.equal(unknownAdvice.paydayAllocation.available,null);
assert.equal(unknownAdvice.paydayAllocation.paydayShellTrust.available,'unknown');
assert.equal(run(noIntent).period.extraDebt.status,'unavailable');
assert.equal(run(noIntent).period.extraDebt.allocated,null);
const printerSource=require('fs').readFileSync(require.resolve('../public/plan.js'),'utf8');
const extraPrinter=require('vm').runInNewContext('('+printerSource.match(/^function extraRepaymentHtml\([\s\S]*?\n\}/m)[0]+')');
const unknownPrint=extraPrinter(run(noIntent).period);
assert(unknownPrint.includes('data-extra-debt="unavailable"'));
assert(!unknownPrint.includes('No extra'));
assert.equal(run(noIntent).advice.currentPeriodAction.categories[0].committed,30,
  'unknown earmarking cannot erase known spending');
const trust=RT.fromIncumbent({data:unknownState,mode:'live-overlay'});
assert.equal(trust.exactFiguresAvailable,false);
assert.equal(trust.displayState,'attention-needed');
assert(trust.coverageLimits.some(row=>row.id==='card-purchase-coverage-unconfirmed'));
assert.equal(operational.currentSpendingPermission.weekly,null);
const assistant=Assistant.buildPacket({data:unknownState,periods:null,questionsMarkdown:''});
assert.equal(assistant.forecast.status,'unavailable');
assert.equal(assistant.current.spendableHouseholdCash.value,null);
assert.equal(assistant.current.spendableHouseholdCash.observedCash,465);
// Sanitized coverage identifiers are stable, account-bound hashes. Neither the
// original provider identity nor issuer payment IDs are published by the ledger.
const raw={providerAccountId:'invented-account',providerTransactionId:'invented-row',
 plaidTransactionId:'invented-pending'};
const ref=O.cardCoverageReference(raw);
assert.match(ref,/^pc-[a-f0-9]{24}$/);
assert.equal(O.cardCoverageReference({...raw,providerTransactionId:'invented-posted',
 plaidTransactionId:'new-native',pendingTransactionId:'invented-pending'}),ref);
assert.notEqual(O.cardCoverageReference({...raw,providerAccountId:'different-account'}),ref);
assert.equal(O.cardCoverageReference({...raw,providerTransactionId:null}),null);
const safe=JSON.stringify(complete.period.cardPurchaseCoverage);
assert(!/8000[1-5]|providerTransactionId|plaidTransactionId|accountId|purchaseRef/.test(safe));
const history=O.postedHistoryDaysForCarriedSettlement({now:'2026-09-20T18:00:00Z',
 plan:{cardPurchaseCoverage:{opening:{confirmed:true,asOf:'2026-07-22'}}}});
assert.equal(history,60,'confirmed opening extends bounded history by independently counted days');
assert.equal(O.postedHistoryDaysForCarriedSettlement({now:'2026-09-20T18:00:00Z',
 plan:{cardPurchaseCoverage:{opening:{confirmed:true,asOf:'2026-01-01'}}}}),120,
 'the existing observation cap is retained; ledger rejects incomplete cutover coverage');

// B1: independent supplied-cent totals must reconcile the actual Today printer,
// detailed evidence and chart, before/after partial/full purchase backfill.
const fs = require('node:fs'), vm = require('node:vm');
const fundingCases = [
  { stage:'before', cash:50000, spent:0, remaining:15000, reserve:0, needed:17500, chart:0 },
  { stage:'purchase', cash:50000, spent:8000, remaining:7000, reserve:8000, needed:17500, chart:16 },
  { stage:'partial', cash:48000, spent:8000, remaining:7000, reserve:6000, needed:15500, chart:12.5 },
  { stage:'full', cash:42000, spent:8000, remaining:7000, reserve:0, needed:9500, chart:0 },
];
for (const width of [1440,390]) for (const expected of fundingCases) {
  const input=fixture(['partial','full'].includes(expected.stage)?'backfill':expected.stage);
  if(expected.stage==='partial') {
    input.payload.transactions[1].amount=20; input.payload.transactions[2].amount=-20;
    input.payload.accounts[0].balance=480; input.payload.accounts[3].balance=460;
    fixture.confirm(input,'partial-ui',80002,80003,[[80001,20]]);
  }
  if(expected.stage==='full') fixture.confirm(input,'full-ui',80002,80003,[[80001,80]]);
  const state=run(input), today=state.period.fromTodayFunding;
  const cents=n=>Math.round(n*100);
  assert.equal(cents(today.currentCash),expected.cash);
  assert.equal(cents(today.requiredOperatingCash),expected.needed);
  assert.equal(cents(today.availableNow),32500);
  assert.equal(cents(today.operatingBills),2500,'the separate minimum is still reserved');
  assert.equal(cents(state.period.householdBudget[0].spent),expected.spent);
  assert.equal(cents(state.period.householdBudget[0].hold),15000,'original category unchanged');
  const context=vm.createContext({Forecast:F,console,innerWidth:width,addEventListener(){},
    document:{addEventListener(){},querySelectorAll(){return[];},getElementById(){return null;},
      documentElement:{dataset:{},style:{}}},
    window:{innerWidth:width,addEventListener(){},matchMedia(){return{matches:width<600,addEventListener(){}};}},
    localStorage:{getItem(){return null;},setItem(){}},location:{pathname:'/'}});
  vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'),'utf8'),context);
  vm.runInContext('App.boot=()=>{};',context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/plan.js'),'utf8'),context);
  context.ctx={advice:state.advice,plan:state.data.plan,liveOverlay:state.data.liveOverlay,
    planPayPeriodId:state.period.id};
  const html=vm.runInContext('budgetTodayCashCardHtml(ctx)',context);
  const publishedParts=Object.fromEntries([...html.matchAll(/data-budget-cash-part="([^"]+)"[\s\S]*?<strong>([\s\S]*?)<\/strong>/g)]
    .map(m=>[m[1],Math.round(Number(m[2].match(/\$([\d,.]+)/)[1].replace(/,/g,''))*100)]));
  assert.deepEqual(publishedParts,{bills:2500,household:expected.remaining,
    'card-coverage':expected.reserve,floor:0,proposed:0},expected.stage+'/'+width);
  // A second method: total the printed cents, not Forecast's total function.
  assert.equal(Object.values(publishedParts).reduce((sum,n)=>sum+n,0),expected.needed);
  assert.equal(expected.cash-expected.needed,32500,'independent cash-minus-holds capacity');
  assert(html.includes('budget-cash-card-coverage" style="width:'+expected.chart+'%"'));
  assert.doesNotMatch(html,/Cash needed protects remaining bills, household spending, uncovered card purchases and the existing floor/);
  context.row=state.period;context.plan=state.data.plan;
  const evidence=vm.runInContext('calendarFromTodayEvidenceHtml(row,plan)',context);
  assert.match(evidence,new RegExp('data-from-today-card-coverage[^>]*><span>Uncovered card purchases - keep in Bills<\\/span><span>\\$'+(expected.reserve/100).toFixed(2).replace('.','\\.')));
}

// Joint conservation (ATLAS-044): confirmed refunds and payment allocations
// share one bound — covered + refunded <= purchase amount in exact cents.
// An overallocating claim is rejected (publication unavailable), never
// silently clamped, reclassified or absorbed.
function jointLedger(x) {
  x.payload.accounts[0].balance = 500 - x.payload.transactions.filter(t => t.account_id === 3001).reduce((s, t) => s + t.amount, 0);
  x.payload.accounts[3].balance = 400 + x.payload.transactions.filter(t => t.account_id === 3004).reduce((s, t) => s + t.amount, 0);
  return x;
}
function refundClaim(x, amount, id = 80006) {
  x.payload.transactions.push({ id, account_id: 3004, date: x.asOf, amount: -amount,
    currency: 'cad', category_name: 'Refund', payee: 'Invented grocer refund', is_pending: false });
  x.data.plan.cardPurchaseCoverage.refunds.push({ confirmed: true,
    purchaseRef: fixture.ref(x, 80001), refundRef: fixture.ref(x, id) });
  return x;
}
{ // Refund 30 + payment allocating the full 80 overallocates the 80 purchase.
  const x = refundClaim(fixture('backfill'), 30);
  fixture.confirm(x, 'joint-over', 80002, 80003, [[80001, 80]]);
  const r = run(jointLedger(x));
  assert.equal(r.advice.cardPurchaseCoverage.status, 'unavailable',
    'covered 80 + refunded 30 against an 80 purchase must not publish');
  assert.equal(r.advice.cardPurchaseCoverage.reservedCash, null);
  // Replay of the identical input is deterministic.
  assert.deepEqual(run(jointLedger(structuredClone(x))).advice.cardPurchaseCoverage,
    r.advice.cardPurchaseCoverage, 'identical overallocated input replays identically');
}
{ // Exact bound: refund 30 + allocation 50 = 80 publishes ready, remaining 0.
  const x = refundClaim(fixture('backfill'), 30);
  x.payload.transactions[1].amount = 50; x.payload.transactions[2].amount = -50;
  fixture.confirm(x, 'joint-exact', 80002, 80003, [[80001, 50]]);
  const r = run(jointLedger(x)), pub = r.advice.cardPurchaseCoverage;
  assert.equal(pub.status, 'ready');
  assert.equal(pub.reservedCash, 0);
  assert.equal(pub.purchases[0].covered, 50);
  assert.equal(pub.purchases[0].refunded, 30);
  assert.equal(pub.purchases[0].remaining, 0);
}
{ // One cent over the joint bound is rejected.
  const x = refundClaim(fixture('backfill'), 30);
  x.payload.transactions[1].amount = 50.01; x.payload.transactions[2].amount = -50.01;
  fixture.confirm(x, 'joint-cent-over', 80002, 80003, [[80001, 50.01]]);
  const r = run(jointLedger(x));
  assert.equal(r.advice.cardPurchaseCoverage.status, 'unavailable',
    'covered 50.01 + refunded 30 exceeds the 80 purchase by one cent');
  assert.equal(r.advice.cardPurchaseCoverage.reservedCash, null);
}
{ // Cumulative claims across two payments plus a refund share the bound.
  const build = second => {
    const x = refundClaim(fixture('backfill'), 30);
    x.payload.transactions[1].amount = 30; x.payload.transactions[2].amount = -30;
    x.payload.transactions.push(
      { ...x.payload.transactions[1], id: 80007, amount: second },
      { ...x.payload.transactions[2], id: 80008, amount: -second });
    fixture.confirm(x, 'joint-first', 80002, 80003, [[80001, 30]]);
    fixture.confirm(x, 'joint-second', 80007, 80008, [[80001, second]]);
    return run(jointLedger(x));
  };
  assert.equal(build(30).advice.cardPurchaseCoverage.status, 'unavailable',
    'refund 30 + payments 30 + 30 cumulate past the 80 purchase');
  const ok = build(20).advice.cardPurchaseCoverage;
  assert.equal(ok.status, 'ready', 'refund 30 + payments 30 + 20 meet the bound exactly');
  assert.equal(ok.purchases[0].covered, 50);
  assert.equal(ok.purchases[0].remaining, 0);
}
{ // Opening carry is a claim too: opening covered 50 + refund 30 fills the
  // purchase exactly; one more allocated dollar overallocates it.
  const build = withPayment => {
    const x = fixture();
    x.data.plan.cardPurchaseCoverage.opening.purchases = [{ ref: 'opening-p1',
      date: '2026-09-10', accountId: 'travelvisa', amount: 80, covered: 50,
      categoryLabel: 'Groceries' }];
    x.payload.transactions.push({ id: 80006, account_id: 3004, date: x.asOf, amount: -30,
      currency: 'cad', category_name: 'Refund', payee: 'Invented grocer refund', is_pending: false });
    x.data.plan.cardPurchaseCoverage.refunds.push({ confirmed: true,
      purchaseRef: 'opening-p1', refundRef: fixture.ref(x, 80006) });
    if (withPayment) {
      const bf = fixture('backfill');
      x.payload.transactions.push({ ...bf.payload.transactions[1], id: 80002, amount: 1 },
        { ...bf.payload.transactions[2], id: 80003, amount: -1 });
      x.data.plan.cardPurchaseCoverage.payments.push({ id: 'joint-opening-pay', confirmed: true,
        debitRef: fixture.ref(x, 80002), creditRef: fixture.ref(x, 80003),
        allocations: [{ purchaseRef: 'opening-p1', amount: 1 }], otherAmount: 0, otherPurpose: null });
    }
    return run(jointLedger(x));
  };
  const filled = build(false).advice.cardPurchaseCoverage;
  assert.equal(filled.status, 'ready');
  assert.equal(filled.purchases.find(p => p.amount === 80 && p.covered === 50).refunded, 30);
  assert.equal(build(true).advice.cardPurchaseCoverage.status, 'unavailable',
    'opening covered 50 + refunded 30 + allocated 1 exceeds the 80 purchase');
}

{ // Repair round, Finding 2: a confirmed reversal relaxes its own payment.
  // Refund 30 + payment 80 + confirmed reversal 30 nets covered 50 +
  // refunded 30 = 80: the valid history publishes, it is not rejected at
  // the payment's gross claim before the reversal can release it.
  const x = refundClaim(fixture('backfill'), 30);
  fixture.confirm(x, 'joint-rev', 80002, 80003, [[80001, 80]]);
  x.payload.transactions.push(
    { id: 80010, account_id: 3004, date: x.asOf, amount: 30, currency: 'cad',
      category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false },
    { id: 80011, account_id: 3001, date: x.asOf, amount: -30, currency: 'cad',
      category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false });
  x.data.plan.cardPurchaseCoverage.reversals.push({ confirmed: true, paymentId: 'joint-rev',
    cardDebitRef: fixture.ref(x, 80010), cashCreditRef: fixture.ref(x, 80011),
    allocations: [{ purchaseRef: fixture.ref(x, 80001), amount: 30 }], otherAmount: 0 });
  const pub = run(jointLedger(x)).advice.cardPurchaseCoverage;
  assert.equal(pub.status, 'ready', 'net covered 50 + refunded 30 publishes');
  assert.equal(pub.purchases[0].covered, 50);
  assert.equal(pub.purchases[0].refunded, 30);
  assert.equal(pub.purchases[0].remaining, 0);
  assert.equal(pub.reservedCash, 0);
  // The same history with the reversal's cash leg missing gains no
  // release: the gross claim is judged and rejected.
  const broken = refundClaim(fixture('backfill'), 30);
  fixture.confirm(broken, 'joint-rev-broken', 80002, 80003, [[80001, 80]]);
  broken.payload.transactions.push(
    { id: 80010, account_id: 3004, date: broken.asOf, amount: 30, currency: 'cad',
      category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false });
  broken.data.plan.cardPurchaseCoverage.reversals.push({ confirmed: true, paymentId: 'joint-rev-broken',
    cardDebitRef: fixture.ref(broken, 80010), cashCreditRef: 'pc-missing-cash-leg',
    allocations: [{ purchaseRef: fixture.ref(broken, 80001), amount: 30 }], otherAmount: 0 });
  assert.equal(run(jointLedger(broken)).advice.cardPurchaseCoverage.status, 'unavailable',
    'unqualified reversal evidence creates no capacity');
}
{ // Repair round, Finding 1: a confirmed record that cannot apply (its
  // debit leg is gone) still holds its declared claim against the bound.
  // Retained 30 + refund 30 leave exactly 20 for a later candidate.
  const build = candidate => {
    const x = refundClaim(fixture('backfill'), 30);
    x.payload.transactions.push({ id: 80007, account_id: 3004, date: x.asOf, amount: -30,
      currency: 'cad', category_name: 'Credit Card Payment', payee: 'Invented retained credit', is_pending: false });
    x.payload.transactions.push(
      { ...x.payload.transactions[1], id: 80008, amount: candidate },
      { ...x.payload.transactions[2], id: 80009, amount: -candidate });
    const missingDebitRef = fixture.ref(x, 80002);
    x.data.plan.cardPurchaseCoverage.payments.push({ id: 'joint-retained', confirmed: true,
      debitRef: missingDebitRef, creditRef: fixture.ref(x, 80007),
      allocations: [{ purchaseRef: fixture.ref(x, 80001), amount: 30 }], otherAmount: 0, otherPurpose: null });
    fixture.confirm(x, 'joint-candidate', 80008, 80009, [[80001, candidate]]);
    x.payload.transactions = x.payload.transactions.filter(t => t.id !== 80002);
    return run(jointLedger(x)).advice.cardPurchaseCoverage;
  };
  const over = build(50);
  assert.equal(over.status, 'unavailable');
  assert.equal(over.purchases[0].covered, 0,
    'retained 30 + refund 30 reject candidate 50 before it can apply');
  assert.equal(over.purchases[0].refunded, 30);
  const fits = build(20);
  assert.equal(fits.status, 'unavailable', 'the broken retained record still withholds publication');
  assert.equal(fits.purchases[0].covered, 20, 'candidate 20 fits the retained bound exactly');
  assert.equal(fits.purchases[0].remaining, 30);
}

{ // Allocation cap (Atlas ruling on the d1c5432e boundary question): an
  // allocation of 110 against the 80 purchase is invalid even though its
  // qualified reversal 30 would net it to 80 — a reversal acts on a
  // previously allocated amount. The legitimate representation of the
  // same pair (allocation 80 + otherAmount 30) publishes covered 50.
  const build = (allocation, otherAmount) => {
    const x = fixture('backfill');
    x.payload.transactions[1].amount = 110; x.payload.transactions[2].amount = -110;
    x.payload.transactions.push(
      { id: 80010, account_id: 3004, date: x.asOf, amount: 30, currency: 'cad',
        category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false },
      { id: 80011, account_id: 3001, date: x.asOf, amount: -30, currency: 'cad',
        category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false });
    x.data.plan.cardPurchaseCoverage.payments.push({ id: 'cap-case', confirmed: true,
      debitRef: fixture.ref(x, 80002), creditRef: fixture.ref(x, 80003),
      allocations: [{ purchaseRef: fixture.ref(x, 80001), amount: allocation }],
      otherAmount, otherPurpose: otherAmount ? 'required-payment' : null });
    x.data.plan.cardPurchaseCoverage.reversals.push({ confirmed: true, paymentId: 'cap-case',
      cardDebitRef: fixture.ref(x, 80010), cashCreditRef: fixture.ref(x, 80011),
      allocations: [{ purchaseRef: fixture.ref(x, 80001), amount: 30 }], otherAmount: 0 });
    return run(jointLedger(x)).advice.cardPurchaseCoverage;
  };
  const over = build(110, 0);
  assert.equal(over.status, 'unavailable');
  assert.equal(over.purchases[0].covered, 0,
    'allocation 110 against the 80 purchase never applies, reversal or not');
  assert.equal(over.purchases[0].remaining, 80);
  const legit = build(80, 30);
  assert.equal(legit.purchases[0].covered, 50,
    'allocation 80 + other 30 with reversal 30 publishes covered 50');
  assert.equal(legit.purchases[0].remaining, 30);
}

{ // Reversal cohort (Atlas ruling on the order-dependence reproduction):
  // one cohort qualification governs release capacity and publication. A
  // payment's confirmed reversals whose valid parts total MORE than the
  // split are conflicted as a whole: no first-fit subset may reduce
  // published covered cents, in any array order.
  const reversalPair = (x, debit, credit, amount) => {
    x.payload.transactions.push(
      { id: debit, account_id: 3004, date: x.asOf, amount, currency: 'cad',
        category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false },
      { id: credit, account_id: 3001, date: x.asOf, amount: -amount, currency: 'cad',
        category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false });
    return { confirmed: true, paymentId: 'cohort-case',
      cardDebitRef: fixture.ref(x, debit), cashCreditRef: fixture.ref(x, credit),
      allocations: [{ purchaseRef: fixture.ref(x, 80001), amount }], otherAmount: 0 };
  };
  const build = (allocation, otherAmount, amounts) => {
    const x = refundClaim(fixture('backfill'), 30);
    const pairTotal = allocation + otherAmount;
    x.payload.transactions[1].amount = pairTotal; x.payload.transactions[2].amount = -pairTotal;
    x.data.plan.cardPurchaseCoverage.payments.push({ id: 'cohort-case', confirmed: true,
      debitRef: fixture.ref(x, 80002), creditRef: fixture.ref(x, 80003),
      allocations: [{ purchaseRef: fixture.ref(x, 80001), amount: allocation }],
      otherAmount, otherPurpose: otherAmount ? 'required-payment' : null });
    amounts.forEach((amount, i) =>
      x.data.plan.cardPurchaseCoverage.reversals.push(reversalPair(x, 80010 + i * 2, 80011 + i * 2, amount)));
    return run(jointLedger(x)).advice.cardPurchaseCoverage;
  };
  for (const amounts of [[30, 60], [60, 30], [20, 70], [70, 20]]) {
    const cov = build(80, 0, amounts);
    assert.equal(cov.purchases[0].covered, 0,
      'cohort ' + amounts.join('+') + ' is conflicted as a whole: the payment gains no release and does not reconcile');
    assert.equal(cov.purchases[0].refunded, 30);
    assert.equal(cov.purchases[0].remaining, 50);
  }
  { // A parent independently acceptable without reversal credit publishes
    // gross: allocation 50 + refund 30 meets the bound; the conflicted
    // cohort reduces nothing.
    const cov = build(50, 30, [30, 60]);
    assert.equal(cov.purchases[0].covered, 50,
      'independently acceptable parent publishes covered 50: conflicted reversals make no publication mutation');
    assert.equal(cov.purchases[0].remaining, 0);
  }
  { // Valid multiple reversals within the split still apply in full.
    const cov = build(80, 0, [30, 20]);
    assert.equal(cov.purchases[0].covered, 30, 'cohort 30+20 within the split publishes covered 30');
    assert.equal(cov.purchases[0].remaining, 20);
  }
  { // Cohort total exactly equal to the split applies in full.
    const cov = build(80, 0, [30, 50]);
    assert.equal(cov.purchases[0].covered, 0, 'cohort 30+50 equal to the split publishes covered 0');
    assert.equal(cov.purchases[0].remaining, 50);
  }
  { // Distinct-parent isolation: payment A's conflicted cohort neither
    // applies nor touches payment B's valid reversal on the same purchase.
    const x = fixture('backfill');
    x.data.plan.cardPurchaseCoverage.payments.push(
      { id: 'cohort-a', confirmed: true,
        debitRef: fixture.ref(x, 80002), creditRef: fixture.ref(x, 80003),
        allocations: [{ purchaseRef: fixture.ref(x, 80001), amount: 40 }],
        otherAmount: 0, otherPurpose: null });
    x.payload.transactions[1].amount = 40; x.payload.transactions[2].amount = -40;
    x.payload.transactions.push(
      { ...x.payload.transactions[1], id: 80020, amount: 40 },
      { ...x.payload.transactions[2], id: 80021, amount: -40 });
    x.data.plan.cardPurchaseCoverage.payments.push(
      { id: 'cohort-b', confirmed: true,
        debitRef: fixture.ref(x, 80020), creditRef: fixture.ref(x, 80021),
        allocations: [{ purchaseRef: fixture.ref(x, 80001), amount: 40 }],
        otherAmount: 0, otherPurpose: null });
    const revA = reversalPair(x, 80010, 80011, 30); revA.paymentId = 'cohort-a';
    const revA2 = reversalPair(x, 80012, 80013, 60); revA2.paymentId = 'cohort-a';
    const revB = reversalPair(x, 80022, 80023, 20); revB.paymentId = 'cohort-b';
    x.data.plan.cardPurchaseCoverage.reversals.push(revA, revA2, revB);
    const cov = run(jointLedger(x)).advice.cardPurchaseCoverage;
    assert.equal(cov.purchases[0].covered, 60,
      'A publishes its gross 40 (conflicted cohort applies nothing); B publishes 40 net of its valid reversal 20');
    assert.equal(cov.purchases[0].remaining, 20);
  }
}

{ // Whole-payment cohort (Atlas ruling on the multi-purchase probe): the
  // cohort is the PARENT PAYMENT's whole reversal cohort — one overclaimed
  // split disqualifies every reversal of that payment, including a
  // reversal for a disjoint purchase whose own subtotal fits. A separate
  // payment is a separate cohort and is untouched.
  const revLeg = (x, debit, credit, amount, paymentId, purchaseId) => {
    x.payload.transactions.push(
      { id: debit, account_id: 3004, date: x.asOf, amount, currency: 'cad',
        category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false },
      { id: credit, account_id: 3001, date: x.asOf, amount: -amount, currency: 'cad',
        category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false });
    return { confirmed: true, paymentId,
      cardDebitRef: fixture.ref(x, debit), cashCreditRef: fixture.ref(x, credit),
      allocations: [{ purchaseRef: fixture.ref(x, purchaseId), amount }], otherAmount: 0 };
  };
  const buildMulti = (specs, refund) => {
    const x = fixture('backfill');
    x.payload.transactions.push(
      { ...x.payload.transactions[0], id: 80005, amount: 80, date: '2026-09-19' },
      { ...x.payload.transactions[0], id: 80006, amount: 80, date: '2026-09-18' });
    x.payload.transactions[1].amount = 160; x.payload.transactions[2].amount = -160;
    x.data.plan.cardPurchaseCoverage.payments.push({ id: 'multi-case', confirmed: true,
      debitRef: fixture.ref(x, 80002), creditRef: fixture.ref(x, 80003),
      allocations: [{ purchaseRef: fixture.ref(x, 80001), amount: 80 },
        { purchaseRef: fixture.ref(x, 80005), amount: 80 }],
      otherAmount: 0, otherPurpose: null });
    x.payload.transactions.push(
      { ...x.payload.transactions[1], id: 80020, amount: 40 },
      { ...x.payload.transactions[2], id: 80021, amount: -40 });
    x.data.plan.cardPurchaseCoverage.payments.push({ id: 'separate-case', confirmed: true,
      debitRef: fixture.ref(x, 80020), creditRef: fixture.ref(x, 80021),
      allocations: [{ purchaseRef: fixture.ref(x, 80006), amount: 40 }],
      otherAmount: 0, otherPurpose: null });
    if (refund) {
      x.payload.transactions.push({ id: 80007, account_id: 3004, date: x.asOf, amount: -20,
        currency: 'cad', category_name: 'Refund', payee: 'Invented refund', is_pending: false });
      x.data.plan.cardPurchaseCoverage.refunds.push({ confirmed: true,
        purchaseRef: fixture.ref(x, 80005), refundRef: fixture.ref(x, 80007) });
    }
    specs.forEach(([purchaseId, amount], i) =>
      x.data.plan.cardPurchaseCoverage.reversals.push(
        revLeg(x, 80010 + i * 2, 80011 + i * 2, amount, 'multi-case', purchaseId)));
    x.data.plan.cardPurchaseCoverage.reversals.push(
      revLeg(x, 80030, 80031, 10, 'separate-case', 80006));
    return run(jointLedger(x)).advice.cardPurchaseCoverage;
  };
  const rowFor = (cov, date) => cov.purchases.find(p => p.date === date);
  const A = '2026-09-20', B = '2026-09-19', C = '2026-09-18';
  const cohortSpecs = [[80001, 30], [80001, 60], [80005, 20]];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    .map(order => order.map(i => cohortSpecs[i]));
  for (const specs of permutations) {
    const cov = buildMulti(specs, true);
    assert.equal(rowFor(cov, A).covered, 0, 'refund case: the whole parent cohort is disqualified, A publishes nothing');
    assert.equal(rowFor(cov, A).remaining, 80);
    assert.equal(rowFor(cov, B).covered, 0, 'refund case: B20 belongs to the conflicted parent cohort and applies nothing');
    assert.equal(rowFor(cov, B).refunded, 20);
    assert.equal(rowFor(cov, B).remaining, 60);
    assert.equal(rowFor(cov, C).covered, 30, 'the separate payment is a separate cohort: its reversal 10 still applies');
    assert.equal(rowFor(cov, C).remaining, 50);
  }
  { // Without the refund the parent qualifies on gross claims, and the
    // disqualified cohort still changes nothing.
    const cov = buildMulti(cohortSpecs, false);
    assert.equal(rowFor(cov, A).covered, 80, 'no-refund case: A publishes gross 80, cohort reversal or not');
    assert.equal(rowFor(cov, B).covered, 80, 'no-refund case: B publishes gross 80 — B20 does not apply');
    assert.equal(rowFor(cov, B).remaining, 0);
    assert.equal(rowFor(cov, C).covered, 30);
  }
  { // A valid multi-purchase cohort (every purchase total within its
    // split) still applies in full on both purchases.
    const cov = buildMulti([[80001, 30], [80005, 20]], true);
    assert.equal(rowFor(cov, A).covered, 50, 'valid cohort: A reversal 30 applies');
    assert.equal(rowFor(cov, B).covered, 60, 'valid cohort: B reversal 20 applies beside refund 20');
    assert.equal(rowFor(cov, B).refunded, 20);
    assert.equal(rowFor(cov, B).remaining, 0);
  }
}

console.log('PASS independent observed cash/debt/spending ledger: purchase, partial and combined backfill, pending, intent/currency unknown and directed replacement');
