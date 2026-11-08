'use strict';
// Synthetic cents and dates only. No live household amount is the behavior oracle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {sourceText}=require('./test-source-text');
const F = require('../public/forecast');
const O = require('./fixtures/native-cad-observation')(require('../scripts/provider-observe'));
const clone = x => JSON.parse(JSON.stringify(x));
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname,'..',file),'utf8'));
const cents = x => Math.round(Number(x)*100);
const AMOUNT=13937, CREDIT=6123, OPENING=100000;
const AS_OF='2026-10-04', NO_PAY='2026-10-03', OLD_DUE='2026-09-03';
const data={meta:{asOf:AS_OF},accounts:[],debts:[],revolvingExtra:[],plan:{
  windowDays:91,opening:{asOf:AS_OF,priorAsOf:'2026-08-19',representedEvents:[]},
  startingCash:{breakdown:[{id:'chequing-a',value:OPENING/100},{id:'chequing-b',value:0}]},
  defaults:{targetBuffer:0,extraDebtMonthly:0},income:[],obligations:[],commitments:[],budget:{categories:[]},
  bills:[{id:'fortis',label:'Synthetic gas',frequency:'monthly',day:3,amount:AMOUNT/100,
    confidence:'estimated',payingAccount:'chequing-a',budgetCategory:null,noPaymentRequiredOn:[NO_PAY],
    utilityAccountCredit:{amount:CREDIT/100,asOf:AS_OF}}]
}};
const untouched=JSON.stringify(data), plan=data.plan;
const before=clone(plan);delete before.bills[0].noPaymentRequiredOn;
const events=F.expandEvents(plan,'2026-09-01','2026-12-31');
assert.deepEqual(events.map(e=>[e.date,cents(-e.amount)]),[
  [OLD_DUE,AMOUNT],['2026-11-03',AMOUNT],['2026-12-03',AMOUNT]]);
assert(F.expandEvents(before,'2026-10-01','2026-10-31').some(e=>e.date===NO_PAY&&cents(-e.amount)===AMOUNT));
assert.deepEqual(F.expandEvents(plan,'2026-10-01','2026-10-31'),[]);
const simulate=p=>F.simulate(p,'2026-10-01',{horizonDays:31,viewDays:31,weeklyVariable:0,targetBuffer:0});
const oldCash=simulate(before), corrected=simulate(plan);
assert.equal(cents(oldCash.ending),OPENING-AMOUNT);
assert.equal(cents(corrected.ending),OPENING);
assert.equal(cents(corrected.ending)-cents(oldCash.ending),AMOUNT,'independent removal is the old cash requirement, not the credit balance');
assert.equal(cents(corrected.totals.income),0);
assert.equal(cents(corrected.totals.bills),0);
assert.equal(cents(plan.startingCash.breakdown[0].value),OPENING);
assert.equal(cents(plan.bills[0].utilityAccountCredit.amount),CREDIT);
assert(!plan.bills[0].firstDue,'credit has no future application date');
assert.deepEqual(F.projectDebts(plan,[],AS_OF,{}).byId,{});
assert.deepEqual(F.expandEvents(plan,'2026-09-01','2026-12-31'),events);
assert.equal(JSON.stringify(data),untouched);
console.log('PASS exact October no-pay occurrence; independent cash delta; no bank credit, debt or future netting; unchanged September and future schedule');

for(const noPaymentRequiredOn of [undefined,null,NO_PAY,[],['2026-10-01'],['2026-10-08'],[20261003]]) {
  const other=clone(plan);other.bills[0].noPaymentRequiredOn=noPaymentRequiredOn;
  assert.equal(cents(-F.expandEvents(other,'2026-10-01','2026-10-31')[0].amount),AMOUNT,'only an explicit exact modeled date removes the requirement');
}
const unrelated=clone(plan);unrelated.bills.push({id:'other-bill',label:'Other synthetic bill',frequency:'once',date:NO_PAY,amount:42.19,confidence:'confirmed'});
assert.deepEqual(F.expandEvents(unrelated,'2026-10-01','2026-10-31').map(e=>[e.id,cents(-e.amount)]),[['other-bill',4219]]);
console.log('PASS wrong/malformed/issuance dates and same-day unrelated bills are unaffected');

// Unknown next statement total/date retain conservative nominal inputs. Trust
// travels with that placeholder; observed historical settlement is separate.
const confirmedPlaceholder=clone(plan);confirmedPlaceholder.bills[0].confidence='confirmed';
const roster=F.householdBills(plan,AS_OF,{}).bills.find(r=>r.id==='fortis');
const falseConfirmedRoster=F.householdBills(confirmedPlaceholder,AS_OF,{}).bills.find(r=>r.id==='fortis');
assert(roster&&falseConfirmedRoster);
assert.equal(falseConfirmedRoster.confidence,'confirmed','counterfactual reproduces the false-confirmed future roster');
assert.equal(roster.confidence,'estimated');assert.equal(roster.nextDate,'2026-11-03');assert.equal(cents(roster.amount),AMOUNT);
const appSource=sourceText(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'));
const formatter=re=>{const match=appSource.match(re);assert(match);return match[0];};
const renderCard=vm.runInNewContext([
  formatter(/^const money2 = .*$/m),formatter(/^const escapeHtml = .*$/m),formatter(/^const fmtDateFull = .*$/m),
  sourceText(fs.readFileSync(path.join(__dirname,'../public/bills.js'),'utf8')),
  'billsCardHtml'
].join('\n'),{Forecast:F,console,App:{register(){},boot(){}}});
assert(renderCard(falseConfirmedRoster).includes('CONFIRMED'),'counterfactual real card reproduces the false-confirmed disclosure');
const rendered=renderCard(roster);assert(rendered.includes('ESTIMATED'));assert(!rendered.includes('CONFIRMED'));
assert(rendered.includes((AMOUNT/100).toFixed(2)),'real standing card retains the synthetic conservative amount');
const future=F.expandEvents(plan,'2026-11-01','2026-12-31');
assert.deepEqual(future.map(e=>[e.date,cents(-e.amount),e.confidence]),[
  ['2026-11-03',AMOUNT,'estimated'],['2026-12-03',AMOUNT,'estimated']]);
const futureSim=p=>F.simulate(p,'2026-11-01',{horizonDays:61,viewDays:61,weeklyVariable:0,targetBuffer:0});
const estimatedFuture=futureSim(plan),confirmedFuture=futureSim(confirmedPlaceholder);
assert.equal(cents(estimatedFuture.ending),OPENING-2*AMOUNT,'independent future ledger retains two nominal debits and no credit application');
assert.equal(cents(estimatedFuture.totals.bills),2*AMOUNT);
assert.equal(cents(estimatedFuture.totals.income),0);
assert.equal(estimatedFuture.ending,confirmedFuture.ending);assert.deepEqual(estimatedFuture.totals,confirmedFuture.totals);
console.log('PASS future roster/events are estimated; conservative nominal cash ledger is unchanged');

const identity=load('docs/connectivity/transaction-identity.json');
function observe(asOf,transactions,inputData=data) {
  return O.observe({provider:'lunchmoney',data:inputData,identity,accountMap:load('docs/connectivity/fixtures/provider-account-map.json'),payload:{
    provider:'lunchmoney',fetchedAt:asOf+'T18:00:00.000Z',
    transactionWindow:{startDate:'2026-08-19',endDate:asOf,complete:true,hasMore:false,truncated:false},
    pendingCoverage:{complete:true,basis:O.PENDING_COVERAGE_BASIS,hasMore:false,truncated:false},
    accounts:[{id:1001,name:'Synthetic Bills',type:'cash',balance:OPENING/100,updated_at:asOf+'T17:55:00.000Z'},
      {id:1002,name:'Synthetic Weekly',type:'cash',balance:0,updated_at:asOf+'T17:55:00.000Z'}],
    categories:[{id:11,name:'Synthetic gas',is_income:false,exclude_from_totals:false}],transactions}});
}
const tx=(id,date,amount,extra={})=>({id,account_id:1001,date,amount,currency:'cad',is_pending:false,payee:'Fortisbc Energy Bpy',category_id:11,...extra});
const historical=tx(9701,'2026-09-01',AMOUNT/100), report=observe(AS_OF,[historical]);
const oldHit=(report.representedEventCandidates||[]).find(r=>r.id==='fortis'&&r.date===OLD_DUE);
assert(oldHit&&oldHit.postingDate==='2026-09-01');
assert.equal(cents(oldHit.observedAmount),AMOUNT);
const actual=(report.currentPeriodActuals.representedActuals||[]).find(r=>r.id==='fortis'&&r.date===OLD_DUE);
assert(actual&&actual.postedOn==='2026-09-01');assert.equal(cents(actual.actual),AMOUNT);
const historicalRow=(report.currentPeriodActuals.transactions||[]).find(r=>r.id===actual.transactionId);
assert.equal(F.classifyCurrentPeriodTransaction(historicalRow,plan,{currentPeriodActuals:report.currentPeriodActuals}).kind,'bill');
assert(!(report.representedEventCandidates||[]).some(r=>r.id==='fortis'&&r.date===NO_PAY));
assert(!(report.currentPeriodActuals.representedActuals||[]).some(r=>r.id==='fortis'&&r.date===NO_PAY),'no zero-paid actual is synthesized');
const represented=(report.representedEventCandidates||[]).map(({id,date})=>({id,date}));
const operating=clone(plan);operating.opening.representedEvents=represented;
operating.income=require('./fixtures/reserve-aware-funding').backedFixture().plan.income;
const advice=F.recommend(operating,AS_OF,{currentPeriodActuals:report.currentPeriodActuals,representedEvents:represented});
const previousOperating=clone(operating);delete previousOperating.bills[0].noPaymentRequiredOn;
const previousAdvice=F.recommend(previousOperating,AS_OF,{currentPeriodActuals:report.currentPeriodActuals,representedEvents:represented});
const calendarRows=a=>(a.defaultView.calendarPeriods||[]).flatMap(period=>period.bills||[]);
const receiptPlan=clone(operating);receiptPlan.opening.asOf='2026-09-04';
const receiptReport=observe('2026-09-04',[historical]);
const receiptAdvice=F.recommend(receiptPlan,'2026-09-04',{
  currentPeriodActuals:receiptReport.currentPeriodActuals,representedEvents:represented});
const paidHistory=calendarRows(receiptAdvice).find(r=>r.id==='fortis'&&r.date===OLD_DUE);
assert(paidHistory);assert.equal(paidHistory.status,'PAID');assert.equal(cents(paidHistory.actual),AMOUNT);
const futureReport=observe('2026-11-01',[historical]);
const futureAdvice=F.recommend(operating,'2026-11-01',{
  currentPeriodActuals:futureReport.currentPeriodActuals,representedEvents:represented});
const futureCalendar=calendarRows(futureAdvice).find(r=>r.id==='fortis'&&r.date==='2026-11-03');
assert(futureCalendar);assert.equal(futureCalendar.confidence,'estimated');assert.equal(cents(futureCalendar.amount),AMOUNT);
assert((previousAdvice.currentPeriodAction.bills||[]).some(r=>r.id==='fortis'&&r.date===NO_PAY),'counterfactual action contains the unsupported October requirement');
assert(calendarRows(previousAdvice).some(r=>r.id==='fortis'&&r.date===NO_PAY),'counterfactual calendar contains the unsupported October requirement');
assert(!(advice.currentPeriodAction.bills||[]).some(r=>r.id==='fortis'&&r.date===NO_PAY));
assert(!calendarRows(advice).some(r=>r.id==='fortis'&&r.date===NO_PAY),'calendar does not print October as due or PAID');
console.log('PASS observer-to-Forecast preserves historical actual and current-period calendar/action invent no paid-$0 entry');

for(const [label,extra] of [['pending',{is_pending:true}],['wrong account',{account_id:1002}],['wrong payee',{payee:'Other shop'}]]) {
  const r=observe('2026-11-03',[historical,tx(9702,'2026-11-03',AMOUNT/100,extra)]);
  assert(!(r.representedEventCandidates||[]).some(hit=>hit.id==='fortis'&&hit.date==='2026-11-03'),label+' does not gain settlement from the no-pay instruction');
}
const ambiguous=observe('2026-11-03',[historical,tx(9702,'2026-11-03',AMOUNT/100),tx(9703,'2026-11-03',AMOUNT/100)]);
assert(!(ambiguous.representedEventCandidates||[]).some(r=>r.id==='fortis'&&r.date==='2026-11-03'));
// The incumbent generic utility identity has its own unit handling. This
// October input must neither broaden it nor claim to repair it.
const foreignRows=[historical,tx(9702,'2026-11-03',AMOUNT/100,{currency:'usd'})];
const priorData=clone(data);delete priorData.plan.bills[0].noPaymentRequiredOn;
const relevant=r=>(r.representedEventCandidates||[]).filter(hit=>hit.id==='fortis'&&hit.date==='2026-11-03');
assert.deepEqual(relevant(observe('2026-11-03',foreignRows)),relevant(observe('2026-11-03',foreignRows,priorData)),
  'foreign-unit identity behavior remains incumbent, independently of the no-pay input');
const laterPaid=observe('2026-11-03',[historical,tx(9702,'2026-11-03',81.23)]);
const laterActual=(laterPaid.currentPeriodActuals.representedActuals||[]).find(r=>r.id==='fortis'&&r.date==='2026-11-03');
assert(laterActual);assert.equal(cents(laterActual.actual),8123,'incumbent actual settlement still uses observed amount after identity');
console.log('PASS existing pending/ambiguity guards, incumbent foreign handling and later actual-payment treatment are preserved');

const live=load('data.json'), gas=live.plan.bills.find(b=>b.id==='fortis');
assert.equal(gas.confidence,'estimated','canonical future Fortis placeholders cannot claim a confirmed invoice');
assert.deepEqual(gas.noPaymentRequiredOn,[NO_PAY]);assert(!gas.firstDue);
assert(gas.utilityAccountCredit&&gas.utilityAccountCredit.asOf===AS_OF);
assert(!live.plan.bills.some(b=>b.id==='fortis-equal-payment'),'no future series/date is introduced');
assert(!live.plan.opening.representedEvents.some(r=>r.id==='fortis'&&r.date===NO_PAY),'no cash-paid opening confirmation is invented');
console.log('PASS bounded canonical input routing, without live household cents as a behavior oracle');
