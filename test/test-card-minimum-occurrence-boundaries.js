'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),F=require('../public/forecast');
const Detail=require('../public/bill-detail');
const clone=x=>JSON.parse(JSON.stringify(x)),results=[],cents=x=>Math.round(x*100);
const check=(label,actual,expected)=>{try{assert.deepEqual(actual,expected);results.push({label,pass:true});}
 catch(e){results.push({label,pass:false,actual,expected});}};
function ledger(){
 const data=require(path.join(root,'test/fixtures/card-backfill-data'))('tdcc','invented-cycle').data;
 data.meta.asOf='2038-05-01';data.plan.opening={asOf:'2038-05-01',representedEvents:[{id:'invented-cycle',date:'2038-05-17'}]};
 data.plan.windowDays=90;data.plan.income[0].amount=0;data.plan.income[0].anchor='2038-05-28';
 data.plan.budget.categories=[];data.plan.bills=[];data.plan.commitments=[];data.debts[0].balance=800;data.debts[0].rate=0;
 data.plan.obligations=[{id:'invented-cycle',label:'Invented minimum',debtId:'tdcc',effect:'payment',frequency:'monthly',
 day:17,firstDue:'2038-05-17',amount:38.41,confidence:'estimated',payingAccount:'chequing-a'}];return data;
}
function later(data){const row=data.plan.obligations[0];
 row.statementOccurrences=[{scheduledDate:'2038-06-17',dueDate:'2038-06-17',minimum:23.17,currency:'cad',confidence:'confirmed',dateConfidence:'estimated'}];
 row.sentPayments=[{scheduledDate:'2038-06-17',confirmed:true,intent:'minimum',debitId:'invented-new-send',
 postedOn:'2038-06-05',amount:27.79,currency:'cad',fundingAccountId:'chequing-a',pending:false,cashIncludedAsOf:'2038-06-06'}];
 data.plan.opening.representedEvents.push({id:'invented-cycle',date:'2038-06-17',effectiveAsOf:'2038-06-06'});return data;}
const original=ledger(),annotated=later(clone(original)),immutable=JSON.stringify(annotated);
const opts={debtHorizonDays:31,viewDays:31,horizonDays:31,weeklyVariable:0,targetBuffer:0};
const projection=data=>F.projectDebts(data.plan,data.debts,'2038-05-01',opts);
check('independent historical legacy principal: 800.00 - 38.41 = 761.59 before later annotation',
 cents(projection(original).byId.tdcc.balance),76159);
check('later-cycle annotation must preserve historical 761.59 debt',cents(projection(annotated).byId.tdcc.balance),76159);
check('later-cycle annotation must preserve all historical debt marks',projection(annotated).marks,projection(original).marks);
for(const mode of ['statement-only','sender-only','both-without-new-receipt']){
 const data=later(ledger()),row=data.plan.obligations[0];data.plan.opening.representedEvents.pop();
 if(mode==='statement-only')delete row.sentPayments;if(mode==='sender-only')delete row.statementOccurrences;
 check(mode+': no past principal change',cents(projection(data).byId.tdcc.balance),76159);
}
// Independently observed later stocks include the old 38.41 and new 27.79
// already: debt 800 - 38.41 - 27.79 = 733.80; Bills 500 - 27.79 = 472.21.
const current=clone(annotated),p=current.plan,asOf='2038-06-06';current.meta.asOf=asOf;
p.opening.asOf=asOf;p.opening.priorAsOf='2038-05-01';p.startingCash.breakdown[0].value=472.21;current.debts[0].balance=733.80;
const packet={schema:'atlas-current-period-actuals/v1',observationAsOf:asOf,coverageStart:'2038-05-28',coverageThrough:asOf,
 pendingCoverage:'complete',transactionCoverage:'complete',transactions:[],representedActuals:[]};
const nowOpts={...opts,debts:current.debts,currentPeriodActuals:packet,viewDays:14,horizonDays:14,debtHorizonDays:14};
check('current opening keeps observed debt once',cents(F.projectDebts(p,current.debts,asOf,nowOpts).byId.tdcc.balance),73380);
check('current opening keeps observed cash once',cents(F.simulate(p,asOf,nowOpts).ending),47221);
check('future standing estimate deducts exactly once',cents(F.simulate(p,asOf,{...nowOpts,viewDays:45,horizonDays:45}).ending),43380);
const advice=F.recommend(p,asOf,nowOpts);
const next=advice.payPeriodViews.find(period=>period.start==='2038-06-11');
const row=next.bills.find(row=>row.id==='invented-cycle'&&row.date==='2038-06-17');
const planSource=fs.readFileSync(path.join(root,'public/plan.js'),'utf8');
const presentation=vm.runInNewContext(planSource.match(/^function budgetBillPresentation\([\s\S]*?\n\}/m)[0]+'\nbudgetBillPresentation',{Forecast:F});
check('qualified early current receipt remains independently satisfied',
 [row.cashPaymentStatus,row.householdPaymentStatus,row.cashInclusionStatus,row.issuerMinimumStatus],['sent','paid','included','satisfied']);
check('future native/detail publication follows the assigned-period date rule',
 [row.status,row.settlement,cents(row.remaining)],['planned','upcoming',2317]);
check('future browse follows planned publication with separate money-sent evidence',
 [presentation(row).label,presentation(row).qualifier],['Planned','Money sent']);
const html=Detail.html(row,current,{});
check('native disclosure retains the assigned planned minimum separately from payment evidence',
 /<dt>Remaining<\/dt><dd>\$23\.17<\/dd>/.test(html),true);
const active=clone(current);active.plan.income[0].anchor='2038-06-04';
const activeAdvice=F.recommend(active.plan,asOf,{...nowOpts,debts:active.debts});
const activeRow=activeAdvice.payPeriodViews.flatMap(period=>period.bills||[]).find(row=>row.id==='invented-cycle'&&row.date==='2038-06-17');
check('same original receipt in active period is correctly paid',
 [activeRow.status,activeRow.settlement,cents(activeRow.remaining)],['PAID','represented',0]);
check('cycle moved to next period preserves separate payment evidence',
 [row.cashPaymentStatus,row.householdPaymentStatus,row.cashInclusionStatus,row.issuerMinimumStatus,row.additionalCashRequired],
 [activeRow.cashPaymentStatus,activeRow.householdPaymentStatus,activeRow.cashInclusionStatus,activeRow.issuerMinimumStatus,activeRow.additionalCashRequired]);
check('future totals exclude paid and retain full assigned minimum',
 [cents(next.paidBills),cents(next.remainingBills),cents(next.periodBillLoad)],[0,2317,2317]);
// Further timeline rows stop at the incumbent 2026 income-regime boundary.
// These invented amounts exercise that public path inside its allowed dates.
const further=JSON.parse(JSON.stringify(current).replaceAll('2038-','2026-').replaceAll('2026-06-17','2026-07-17'));
const furtherOpts=JSON.parse(JSON.stringify(nowOpts).replaceAll('2038-','2026-'));
const furtherPeriod=F.recommend(further.plan,'2026-06-06',{...furtherOpts,debts:further.debts}).payPeriodViews.find(period=>period.bills.some(bill=>bill.id==='invented-cycle'&&bill.date==='2026-07-17'));
check('further future row retains planned minimum despite early qualified payment',
 [furtherPeriod.timelineRole,furtherPeriod.bills.find(bill=>bill.date==='2026-07-17').status,cents(furtherPeriod.paidBills),cents(furtherPeriod.remainingBills)],['future','planned',0,2317]);
// Plain represented names and invalid/unconfirmed payment actions must retain
// the incumbent future normalization, as does qualified early evidence.
for(const [label,change] of [
 ['receipt only',d=>{delete d.plan.obligations[0].sentPayments;}],
 ['pending sender',d=>{d.plan.obligations[0].sentPayments[0].pending=true;}],
 ['backfill sender',d=>{d.plan.obligations[0].sentPayments[0].intent='purchase-backfill';}],
 ['future sender posting',d=>{d.plan.obligations[0].sentPayments[0].postedOn='2038-06-10';d.plan.obligations[0].sentPayments[0].cashIncludedAsOf='2038-06-10';}],
 ['wrong original cycle',d=>{d.plan.obligations[0].sentPayments[0].scheduledDate='2038-07-17';}],
 ['partial sender',d=>{d.plan.obligations[0].sentPayments[0].amount=12.31;}],
 ['unconfirmed sender',d=>{d.plan.obligations[0].sentPayments[0].confirmed=false;}],
 ['unknown sender intent',d=>{d.plan.obligations[0].sentPayments[0].intent='unknown';}],
 ['duplicate allocation',d=>{d.plan.obligations[0].sentPayments.push(clone(d.plan.obligations[0].sentPayments[0]));}],
]){
 const control=clone(current);change(control);
 const published=F.recommend(control.plan,asOf,{...nowOpts,debts:control.debts}).payPeriodViews
  .flatMap(period=>period.bills||[]).find(bill=>bill.id==='invented-cycle'&&bill.date==='2038-06-17');
 check(label+': future proof does not invent Paid',published.status==='PAID',false);
}
check('future amount and estimated timing retained',
 [row.planned,row.date,row.dateConfidence], [23.17,'2038-06-17','estimated']);
// The same public contract serves Emerald, MBNA and Cash Back. Alternate
// invented IDs exercise the consumers without using household cents.
for(const debtId of ['mbna','cashback']){
 const data=clone(current);data.debts[0].id=debtId;data.plan.obligations[0].debtId=debtId;
 const advice=F.recommend(data.plan,asOf,{...nowOpts,debts:data.debts});
 const published=advice.payPeriodViews.flatMap(period=>period.bills||[]).find(bill=>bill.id==='invented-cycle'&&bill.date==='2038-06-17');
 check(debtId+': future publication keeps early payment evidence separate',
  [published.status,published.settlement,cents(published.remaining),published.householdPaymentStatus],['planned','upcoming',2317,'paid']);
 check(debtId+': observed debt is not reduced twice',
  cents(F.projectDebts(data.plan,data.debts,asOf,nowOpts).byId[debtId].balance),73380);
}
// Changing the viewing period must not remove the assigned planned load.
check('early-paid next period preserves its planned bill load',cents(next.periodBillLoad),2317);
const withoutProof=clone(current);delete withoutProof.plan.obligations[0].sentPayments;
const nextWithoutProof=F.recommend(withoutProof.plan,asOf,{...nowOpts,debts:withoutProof.debts})
 .payPeriodViews.find(period=>period.start==='2038-06-11');
check('display-state correction does not alter projected deduction',
 cents(next.balanceAfterDeductions),cents(nextWithoutProof.balanceAfterDeductions));
const beforeCashIncluded=F.cardMinimumState(p,'2038-06-05',nowOpts);
check('posting without observed cash inclusion remains withheld',
 [beforeCashIncluded.status,beforeCashIncluded.payments[0].additionalCashRequired],['unavailable',null]);
check('read-only diagnosis leaves input immutable',JSON.stringify(annotated),immutable);
const small=results.map(result=>result.label.includes('all historical debt marks')&&!result.pass
 ? {label:result.label,pass:false,actual:'historical marks changed',expected:'exact unchanged baseline marks'}:result);

for(const result of small)console.log((result.pass?'PASS ':'FAIL ')+result.label+(result.pass?'':': '+JSON.stringify(result.actual)+' expected '+JSON.stringify(result.expected)));
process.exitCode=results.some(x=>!x.pass)?1:0;

console.log('Card minimum occurrence boundaries: '+results.filter(x=>x.pass).length+'/'+results.length+' independent checks');
