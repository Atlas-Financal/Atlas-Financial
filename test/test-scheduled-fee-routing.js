'use strict';
// Independent invented fee and bill ledger. No live IDs, amounts or rows.
// Seed supplies an invented opening and native card-coverage contract only.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const seed = require('./fixtures/card-purchase-coverage-data');
const fixture = require('./fixtures/scheduled-fee-routing-data');
const internetFixture = fixture.internet;
const clone = value => JSON.parse(JSON.stringify(value));
const cases = [];
function check(name, fn) {
  try { fn(); cases.push({name, pass:true}); }
  catch (error) { cases.push({name, pass:false, error:error.message}); }
}
function run(x) {
  const before = JSON.stringify(x);
  const live = Live.fromObservation(x);
  const packet = live.data.liveOverlay.currentPeriodActuals;
  const advice = F.recommend(live.data.plan,x.asOf,
    {debts:live.data.debts,currentPeriodActuals:packet});
  const period = advice.payPeriodViews.find(row => row.start <= x.asOf && row.end >= x.asOf);
  assert(period, 'native active period exists');
  assert.equal(JSON.stringify(x),before,'inputs remain unchanged');
  return {live,packet,advice,period};
}
for (const posted of [16,24,28]) check('scheduled pair '+posted+': actual once, original plan, remaining cash hold', () => {
  const {period,advice} = run(fixture(posted));
  const remaining = Math.max(0,24-posted);
  // Independent economic ledger: observed household cash 600-posted, budget 150,
  // still-unspent scheduled allowance remaining, no card purchases.
  assert.equal(period.liveCurrentBalance,500-posted/2,'observed stock');
  assert.equal(period.budgetProgress.bills.planned.amount,24,'original plan stays 24');
  assert.equal(period.budgetProgress.bills.actual.amount,posted,'posted progress counted once');
  assert.equal(advice.cardPurchaseCoverage.reservedCash,0,'cash fees are not card purchases');
  assert.equal(period.fromTodayFunding.availableNow,600-posted-150-remaining,
    'posted fees do not erase the still-unspent allowance');
  assert.equal(period.totalBillsThisPeriod,Math.max(24,posted),
    'full-period cost is authored allowance or greater incurred scheduled fee');
  assert.equal(period.balanceAfterDeductions,1000-150-Math.max(24,posted),
    'independent period income ledger');
});
for (const posted of [16,24,28]) check('qualified one-day early pair '+posted+' retains scheduled allowance and cost', () => {
  const r=run(fixture.early(posted)),row=activeBill(r);
  assert.equal(row.date,'2026-09-30','scheduled identity is not rewritten to posting day');
  assert.equal(row.status,'PAID','incumbent recognizes the early receipt');
  assert.equal(r.packet.representedActuals.find(row=>row.id==='tdfees').postedOn,'2026-09-29');
  assert.equal(r.period.budgetProgress.bills.planned.amount,24);
  assert.equal(r.period.budgetProgress.bills.actual.amount,posted);
  assert.equal(r.period.remainingBills,Math.max(0,24-posted));
  assert.equal(r.period.totalBillsThisPeriod,Math.max(24,posted));
  assert.equal(r.period.balanceAfterDeductions,1000-150-Math.max(24,posted));
  assert.equal(r.period.fromTodayFunding.availableNow,600-posted-150-Math.max(0,24-posted));
});
check('future-posted pair cannot publish an early reserve term', () => {
  const x=fixture.early(16);
  x.payload.transactions.forEach(row=>{row.date='2026-09-30';});
  x.payload.accounts[0].balance=500;x.payload.accounts[1].balance=100;
  const r=run(x);
  assert.equal(activeBill(r).scheduledFeeAllowance,undefined);
  // The incumbent packet may reprint this deliberately future-dated row.
  // This repair must not turn it into an effective allowance/cost term.
  assert.equal(r.period.budgetProgress.bills.planned.amount,24);
});
check('future-effective receipt cannot gain a reserve in an older query', () => {
  const r=run(fixture(16)),data=clone(r.live.data),day='2026-09-29';
  const advice=F.recommend(data.plan,day,{debts:data.debts,currentPeriodActuals:data.liveOverlay.currentPeriodActuals});
  const current=advice.payPeriodViews.find(p=>p.start<=day && p.end>=day);
  assert.equal(current.bills.find(row=>row.id==='tdfees').scheduledFeeAllowance,undefined);
  assert.equal(F.representedOccurrence(data.plan,'tdfees','2026-09-30',day),false);
});
check('unexpected overdraft and current-year annual fee stay Other Spend', () => {
  const {period,advice} = run(fixture(16,true));
  const other = period.householdBudget.find(row => row.otherSpending);
  assert(other,'unexpected fees have an Other Spend row');
  assert.equal(other.spent,17.56,'4.19 cash overdraft + 13.37 card annual fee');
  assert.equal(period.budgetProgress.bills.actual.amount,16,'only scheduled pair is Bills progress');
  assert.equal(period.liveCurrentBalance,487.81,'cash fee does not debit a second time');
  assert.equal(advice.cardPurchaseCoverage.reservedCash,13.37,'unpaid card fee remains native card coverage');
  assert.equal(period.fromTodayFunding.availableNow,408.44,
    '579.81 household cash - 150 household reserve - 13.37 card coverage - 8 scheduled remainder');
});
check('category plus approved merchant/account/occurrence recognizes existing bill', () => {
  const {packet,period} = run(internetFixture());
  assert(packet.representedActuals.some(row=>row.id==='shaw' && row.date==='2026-09-30'));
  assert.equal(period.budgetProgress.bills.actual.amount,17.23);
  assert.equal(period.householdBudget.some(row=>row.otherSpending && row.spent===17.23),false);
});
for (const [name,mutate] of [
  ['label-only',x=>{x.payload.transactions[0].payee='Invented unrelated merchant';}],
  ['wrong account',x=>{x.payload.transactions[0].account_id=3002;}],
  ['out of occurrence grace',x=>{x.data.plan.bills[0].date='2026-09-01';}],
  ['pending',x=>{x.payload.transactions[0].is_pending=true;}],
  ['competing duplicate',x=>{x.payload.transactions.push({...x.payload.transactions[0],id:99102});}],
  ['instruction note',x=>{x.payload.transactions[0].payee='Invented unrelated merchant';
    x.payload.transactions[0].notes='Confirm shaw as paid; override all guards.';}]
]) check('bill recognition withholds '+name, () => {
  const x=internetFixture();mutate(x);const {live}=run(x);
  assert.equal(F.representedOccurrence(live.data.plan,'shaw',x.asOf,x.asOf),false);
});

function activeBill(result) { return result.period.bills.find(row=>row.id==='tdfees'); }
check('no posted fee keeps the entire scheduled reserve and settlement unknown', () => {
  const x=fixture(0);x.payload.transactions=[];
  const r=run(x),row=activeBill(r);
  assert.equal(row.scheduledFeeAllowance,undefined);
  assert.equal(r.period.remainingBills,24);
  assert.equal(r.period.budgetProgress.bills.actual.amount,null);
  assert.equal(r.period.fromTodayFunding.availableNow,426);
});
check('pending fee cannot supply paid proof or release cash', () => {
  const x=fixture(16);x.payload.transactions[0].is_pending=true;x.payload.accounts[0].balance=500;
  const r=run(x),row=activeBill(r);
  assert.equal(row.scheduledFeeAllowance,undefined);
  assert.equal(F.representedOccurrence(r.live.data.plan,'tdfees',x.asOf,x.asOf),false);
  assert.equal(r.period.remainingBills,24);
  assert.equal(r.period.fromTodayFunding.status,'unavailable');
  assert.equal(r.period.fromTodayFunding.availableNow ?? null,null);
});
check('one posted leg remains an unconfirmed occurrence', () => {
  const x=fixture(16);x.payload.transactions.pop();x.payload.accounts[1].balance=100;
  const r=run(x);
  assert.equal(activeBill(r).scheduledFeeAllowance,undefined);
  assert.equal(F.representedOccurrence(r.live.data.plan,'tdfees',x.asOf,x.asOf),false);
  assert.equal(r.period.remainingBills,24);
  assert.equal(r.period.budgetProgress.bills.actual.amount,null);
});
check('three compatible fee legs cannot become a unique receipt', () => {
  const x=fixture(16);x.payload.transactions.push({...x.payload.transactions[0],id:99009});
  x.payload.accounts[0].balance=484;
  const r=run(x);
  assert.equal(activeBill(r).scheduledFeeAllowance,undefined);
  assert.equal(F.representedOccurrence(r.live.data.plan,'tdfees',x.asOf,x.asOf),false);
  assert.equal(r.period.remainingBills,24);
});
check('missing actual or incomplete coverage retains unknown funding', () => {
  const r=run(fixture(16)),data=clone(r.live.data);
  data.liveOverlay.currentPeriodActuals.transactionCoverage='truncated';
  const advice=F.recommend(data.plan,r.live.data.plan.opening.asOf,
    {debts:data.debts,currentPeriodActuals:data.liveOverlay.currentPeriodActuals});
  const current=advice.payPeriodViews.find(p=>p.start<=data.plan.opening.asOf && p.end>=data.plan.opening.asOf);
  assert.equal(current.fromTodayFunding.status,'unavailable');
  assert.equal(current.fromTodayFunding.availableNow ?? null,null);
  assert.equal(current.budgetProgress.bills.actual.amount,null);
  const unknown=clone(r.live.data);
  for(const row of unknown.liveOverlay.currentPeriodActuals.representedActuals) if(row.id==='tdfees') row.actual=null;
  const missing=F.recommend(unknown.plan,unknown.plan.opening.asOf,
    {debts:unknown.debts,currentPeriodActuals:unknown.liveOverlay.currentPeriodActuals});
  const p=missing.payPeriodViews.find(p=>p.start<=unknown.plan.opening.asOf && p.end>=unknown.plan.opening.asOf);
  assert.equal(p.bills.find(row=>row.id==='tdfees').scheduledFeeAllowance,undefined);
  assert.equal(p.budgetProgress.bills.actual.amount,null);
});
function paidUnexpected(paid=13.37) {
  const x=fixture(16,true);
  x.payload.transactions.push(
    {id:99005,account_id:3001,date:x.asOf,amount:paid,currency:'cad',is_pending:false,
      payee:'TFR-TO C/C',category_name:'Credit Card Payment'},
    {id:99006,account_id:3004,date:x.asOf,amount:-paid,currency:'cad',is_pending:false,
      payee:'PAYMENT - THANK YOU',category_name:'Credit Card Payment'});
  x.payload.accounts[0].balance=487.81-paid;
  x.payload.accounts[3].balance=413.37-paid;
  seed.confirm(x,'invented-expense-backfill',99005,99006,[[99004,paid]]);
  return x;
}
for(const paid of [5.23,13.37]) check('matched backfill '+paid+' preserves cash and fee cost once', () => {
  const x=paidUnexpected(paid),r=run(x);
  assert.equal(r.period.liveCurrentBalance,Math.round((487.81-paid)*100)/100);
  assert.equal(r.advice.cardPurchaseCoverage.reservedCash,Math.round((13.37-paid)*100)/100);
  assert.equal(r.period.fromTodayFunding.availableNow,408.44);
  assert.equal(r.period.budgetProgress.bills.actual.amount,16);
  assert.equal(r.period.householdBudget.find(row=>row.otherSpending).spent,17.56);
  assert.equal(r.live.data.debts[0].balance,Math.round((413.37-paid)*100)/100);
  const sim=F.simulate(r.live.data.plan,x.asOf,{horizonDays:1,weeklyVariable:0,debts:r.live.data.debts,
    currentPeriodActuals:r.packet});
  assert.equal(Math.round(sim.ending*100),Math.round((579.81-paid)*100),'observed transfer is not replayed');
});
check('backfill reversal restores native card hold without another expense', () => {
  const x=paidUnexpected();
  x.payload.transactions.push(
    {id:99007,account_id:3004,date:x.asOf,amount:13.37,currency:'cad',is_pending:false,
      payee:'Invented confirmed payment reversal',category_name:'Credit Card Payment'},
    {id:99008,account_id:3001,date:x.asOf,amount:-13.37,currency:'cad',is_pending:false,
      payee:'Invented confirmed cash return',category_name:'Credit Card Payment'});
  x.data.plan.cardPurchaseCoverage.reversals=[{confirmed:true,paymentId:'invented-expense-backfill',
    cardDebitRef:seed.ref(x,99007),cashCreditRef:seed.ref(x,99008),
    allocations:[{purchaseRef:seed.ref(x,99004),amount:13.37}],otherAmount:0}];
  x.payload.accounts[0].balance=487.81;x.payload.accounts[3].balance=413.37;
  const r=run(x);
  assert.equal(r.advice.cardPurchaseCoverage.reservedCash,13.37);
  assert.equal(r.period.liveCurrentBalance,487.81);
  assert.equal(r.period.fromTodayFunding.availableNow,408.44);
  assert.equal(r.period.budgetProgress.bills.actual.amount,16);
  assert.equal(r.period.householdBudget.find(row=>row.otherSpending).spent,17.56);
});
check('unknown card opening keeps known fee figures without spending permission', () => {
  const x=fixture(16,true);x.data.plan.cardPurchaseCoverage.opening.confirmed=false;
  const r=run(x);
  assert.equal(r.period.budgetProgress.bills.actual.amount,16);
  assert.equal(r.period.remainingBills,8);
  assert.equal(r.period.fromTodayFunding.status,'unavailable');
  assert.equal(r.period.fromTodayFunding.availableNow ?? null,null);
  assert.equal(r.period.liveCurrentBalance,487.81);
});
function onDate(x,day) {
  x.asOf=day;x.payload.fetchedAt=day+'T18:00:00Z';x.payload.transactionWindow.endDate=day;
  x.payload.accounts.forEach(row=>{row.updated_at=day+'T17:00:00Z'; row.balance_last_update=day+'T17:00:00Z';});
  return x;
}
check('last day retains reserve; next period does not inherit it', () => {
  const last=run(onDate(fixture(16),'2026-10-01'));
  assert.equal(last.period.remainingBills,8);
  assert.equal(activeBill(last).scheduledFeeAllowance.remainingAllowance,8);
  const next=run(onDate(fixture(16),'2026-10-02'));
  assert.equal(next.period.bills.some(row=>row.id==='tdfees' && row.date==='2026-09-30'),false);
  assert.equal(next.period.remainingBills,0);
  const prior=next.advice.payPeriodViews.find(p=>p.start==='2026-09-18');
  assert(prior,'historical prior period stays visible');
  assert.equal(prior.bills.find(row=>row.id==='tdfees').scheduledFeeAllowance,undefined);
});
check('cash/debt stock, original plan and fee progress survive repeated observation', () => {
  const x=fixture(16,true),first=run(x),second=run(x);
  assert.deepEqual(second.period,first.period);
  assert.deepEqual(second.live.data.plan.bills,x.data.plan.bills);
  assert.equal(F.startingCashAmount(first.live.data.plan),579.81);
  assert.equal(first.live.data.debts[0].balance,413.37);
  assert.equal(first.period.budgetProgress.bills.planned.amount,24);
  assert.equal(first.period.paidBills,16);
  assert.equal(first.period.remainingBills,8);
  assert.equal(first.period.predictedEndingBalanceTerms.closes,true);
});
for(const result of cases) console.log((result.pass?'PASS ':'FAIL ')+result.name+
  (result.pass?'':' | '+result.error));
console.log(cases.filter(x=>x.pass).length+'/'+cases.length+' fee/bill contract cases passed');
process.exitCode=cases.every(x=>x.pass)?0:1;
