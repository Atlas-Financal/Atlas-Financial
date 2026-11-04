'use strict';
// Independent invented ledger: cash 500 - posted payment 80 = 420;
// card stock 480 - that same payment 80 = 400. Original minimum is 73.21.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const source = require('./fixtures/card-backfill-data');
const originalDate = '2033-05-31', postedOn = '2033-06-02', qualifiedOn = '2033-07-05';
const oldId = 'invented-prior-minimum', nextId = 'invented-recurring-minimum';
const x = source('mbna', oldId);
x.data.meta.asOf = x.data.plan.opening.asOf = '2033-05-29';
x.data.plan.income[0].anchor = '2033-06-24';
x.data.plan.income[0].amount = 0;
x.data.plan.budget.categories = [];
x.data.debts[0].balance = 480;
x.data.plan.obligations = [
  {id:oldId, debtId:'mbna', effect:'payment', label:'Invented prior statement minimum',
    frequency:'once', date:originalDate, amount:73.21, confidence:'confirmed', payingAccount:'chequing-a',
    sentPayments:[{scheduledDate:originalDate, confirmed:true, intent:'minimum', debitId:'invented-prior-debit',
      postedOn, amount:80, currency:'cad', fundingAccountId:'chequing-a', pending:false, cashIncludedAsOf:qualifiedOn}]},
  {id:nextId, debtId:'mbna', effect:'payment', label:'Invented later estimated statement',
    frequency:'monthly', day:31, firstDue:'2033-06-30', amount:43.27, confidence:'estimated', payingAccount:'chequing-a'}
];
x.data.plan.opening.representedEvents = [{id:oldId, date:originalDate, effectiveAsOf:qualifiedOn}];
const inputBefore = JSON.stringify(x.data);
const laterInput = JSON.stringify(x.data.plan.obligations[1]);
const historical = F.cardMinimumState(x.data.plan,'2033-06-03');
assert.equal(historical.payments[0].issuerMinimumStatus,'unconfirmed','later confirmation cannot invent earlier issuer receipt');
assert.equal(historical.payments[0].cashInclusionStatus,'unconfirmed','later opening cannot prove earlier cash inclusion');
assert.equal(historical.payments[0].additionalCashRequired,null);
assert.equal(F.representedEventEffectiveBy(x.data.plan.opening.representedEvents[0],'2033-07-04'),false);
const current = F.cardMinimumState(x.data.plan,qualifiedOn);
assert.deepEqual(current.payments.map(p=>[p.id,p.scheduledDate,p.cashPaid,p.issuerMinimumStatus,p.additionalCashRequired]),
  [[oldId,originalDate,80,'satisfied',0]],'one exact original occurrence, not the later recurring statement');
assert.equal(current.status,'ready');
assert.equal(JSON.stringify(x.data),inputBefore,'receipt query does not mutate the dated opening or stock');
const unknown = structuredClone(x.data.plan);unknown.opening.representedEvents=[];
assert.equal(F.cardMinimumState(unknown,qualifiedOn).payments[0].issuerMinimumStatus,'unconfirmed','posted debit alone is not receipt proof');
const backfill = structuredClone(x.data.plan);backfill.obligations[0].sentPayments[0].intent='purchase-backfill';
assert.equal(F.cardMinimumState(backfill,qualifiedOn).payments.length,0,'purchase backfill is not a minimum allocation');
const ambiguous = structuredClone(x.data.plan);delete ambiguous.obligations[0].sentPayments[0].intent;
assert.equal(F.cardMinimumState(ambiguous,qualifiedOn).status,'unavailable','ambiguous intent remains unconfirmed');
x.asOf=qualifiedOn;
x.payload.transactions=[{id:98731,account_id:3001,date:postedOn,amount:80,currency:'cad',
  payee:'Invented card payment',category_name:'Credit Card Payment',is_pending:false}];
for(const day of [qualifiedOn,'2033-07-06','2033-07-07']) {
  x.payload.fetchedAt=day+'T18:00:00Z';
  x.payload.transactionWindow={startDate:'2033-05-29',endDate:day,complete:true,hasMore:false,truncated:false};
  x.payload.accounts.forEach(a=>{a.updated_at=day+'T17:00:00Z'; a.balance_last_update=day+'T17:00:00Z';});
  x.payload.accounts[0].balance=420;x.payload.accounts[3].balance=400;
  const before=JSON.stringify(x), live=Live.fromObservation(x);
  assert.equal(JSON.stringify(x),before,'refresh remains read-only');
  assert.equal(live.data.liveOverlay.applied,true);
  x.data=live.data;
  assert.deepEqual(x.data.plan.opening.representedEvents.filter(p=>p.id===oldId),
    [{id:oldId,date:originalDate,effectiveAsOf:qualifiedOn}],'original receipt qualification survives advancing refreshes');
  assert.equal(F.cardMinimumState(x.data.plan,day).payments[0].issuerMinimumStatus,'satisfied');
  const opts={debts:x.data.debts,currentPeriodActuals:x.data.liveOverlay.currentPeriodActuals};
  const states=F.currentPeriodObligationStates(x.data.plan,day,opts);
  const advice=F.recommend(x.data.plan,day,opts);
  const rows=[...states.bills,...advice.defaultView.bills,...advice.payPeriodViews.flatMap(p=>p.bills)];
  const oldRows=rows.filter(p=>p.id===oldId);
  assert.ok(oldRows.length>0);
  assert.ok(oldRows.every(p=>p.settlement==='represented'&&p.issuerMinimumStatus==='satisfied'&&p.remaining===0));
  assert.ok([...advice.defaultView.bills,...advice.payPeriodViews.flatMap(p=>p.bills)]
    .filter(p=>p.id===oldId).every(p=>p.status==='PAID'));
  assert.ok(rows.some(p=>p.id===nextId&&p.date==='2033-06-30'),'later statement remains independently visible');
  if(day===qualifiedOn) assert.ok(!rows.some(p=>p.id===nextId&&p.status==='PAID'),
    'next statement cannot borrow prior issuer proof at confirmation');
  assert.equal(JSON.stringify(x.data.plan.obligations[1]),laterInput,'later-cycle source remains untouched');
  assert.ok(!x.data.plan.opening.representedEvents.some(p=>p.id===nextId),'prior receipt never names a later cycle');
  assert.equal(F.postedHouseholdChequingCash(x.data.plan),420,'bank debit is included once');
  assert.equal(x.data.debts[0].balance,400,'issuer stock is observed once');
  const priorOnly = structuredClone(x.data.plan);priorOnly.obligations=[priorOnly.obligations[0]];
  const projected=F.projectDebts(priorOnly,x.data.debts,day,{debtHorizonDays:2});
  assert.equal(projected.byId.mbna.balance,400,'confirmed prior payment never reduces the observed issuer stock again');
  if(day===qualifiedOn) assert.equal(F.projectDebts(x.data.plan,x.data.debts,day,{debtHorizonDays:2}).byId.mbna.balance,356.73,
    'independent 400 - later minimum 43.27: later-cycle projection survives without replay of prior minimum 73.21 or payment 80');
}
console.log('PASS independently balanced carried minimum: scoped receipt, qualified history, advancing refreshes, later-cycle isolation and no duplicate cash or principal');
