'use strict';
// Independent invented amounts, dates, account IDs and employer aliases.
// These are not copied or scaled household receipts.
const O=require('../../scripts/provider-observe');
const AS_OF='2026-07-04',START='2026-06-26',END='2026-07-09';
const accountMap={schema:'atlas-provider-account-map/v1',provider:'lunchmoney',scope:'fixture',mappings:[
 {providerAccountId:'fixture-hub',canonical:{collection:'cash',id:'chequing-a'},atlasRole:'household-cash'},
 {providerAccountId:'fixture-weekly',canonical:{collection:'cash',id:'chequing-b'},atlasRole:'household-cash'},
 {providerAccountId:'fixture-salary',atlasRole:'household-external',externalId:'tennis-income'}]};
const rules=[
 {eventId:'payroll',payeePattern:'FIXTURE PAYROLL',atlasAccountId:'chequing-a',direction:'credit'},
 ...['amandaSalary15','amandaSalaryMonthEnd'].map(eventId=>({eventId,transactionKind:'transfer',
   atlasAccountId:'chequing-a',direction:'credit',counterpartExternalId:'tennis-income',
   settlesWhen:'exact-scheduled-amount',salaryReceiptPayeePatterns:['FIXTURE TENNIS EMPLOYER PAY']}))];
function data(){return {meta:{asOf:AS_OF,title:'Invented receipt reconciliation'},accounts:[],debts:[],revolvingExtra:[],plan:{
 opening:{asOf:AS_OF,priorAsOf:'2026-06-25',representedEvents:[]},
 startingCash:{breakdown:[{id:'chequing-a',label:'Invented bills account',value:3000},
   {id:'chequing-b',label:'Invented spending account',value:400}]},
 defaults:{targetBuffer:300,extraDebtMonthly:0,scenario:'expected'},
 income:[{id:'payroll',label:'Payroll - Seaspan',frequency:'biweekly',anchor:START,amount:2520.25,confidence:'confirmed'},
   {id:'amandaSalary15',label:'Amanda Tennis BC salary 15th',frequency:'monthly',day:15,amount:900,confidence:'confirmed'},
   {id:'amandaSalaryMonthEnd',label:'Amanda Tennis BC salary month-end',frequency:'monthly',day:31,amount:1800.25,confidence:'confirmed'}],
 bills:[],obligations:[],commitments:[],groups:[],funding:{options:[]},
 budget:{categories:[{id:'groceries',label:'Groceries',class:'essential',from:['Groceries'],plannedPayday:220},
  {id:'fuel',label:'Fuel',class:'essential',from:['Gas'],plannedPayday:85},
  {id:'restaurants',label:'Eating out',class:'discretionary',from:['Restaurants'],plannedPayday:60},
  {id:'health',label:'Historical health category',class:'essential',from:['Health'],plannedPayday:999}]}}};}
const tx=(id,account,date,amount,payee,categoryLabel,extra={})=>({providerTransactionId:id,providerAccountId:account,
 date,amount,payee,categoryLabel,currency:'cad',pending:false,savingsPostingEvidence:'posted',isIncome:categoryLabel==='Income',...extra});
function transactions(){return [
 tx('pay','fixture-hub',START,-2493.18,'FIXTURE PAYROLL PAY','Income'),
 tx('salary','fixture-salary','2026-06-29',-1733.18,'FIXTURE TENNIS EMPLOYER PAY','Income'),
 tx('credit','fixture-hub','2026-07-01',-1733.18,'INVENTED TRANSFER','Transfer',{kind:'transfer'}),
 tx('debit','fixture-salary','2026-07-01',1733.18,'INVENTED TRANSFER','Transfer',{kind:'transfer'}),
 tx('coaching','fixture-salary','2026-06-29',-419.27,'INVENTED COACHING RECEIPT','Income'),
 tx('grocery','fixture-weekly','2026-06-27',215.31,'Invented grocer','Groceries'),
 tx('fuel','fixture-weekly','2026-06-28',102.65,'Invented fuel station','Gas'),
 tx('dining','fixture-weekly','2026-06-30',18.35,'Invented restaurant','Restaurants'),
 tx('other','fixture-weekly','2026-07-02',9.63,'Invented unidentified purchase','Uncategorised'),
 tx('refund','fixture-weekly','2026-07-03',-11.07,'Invented refund','Refund',{kind:'refund'}),
 tx('old','fixture-weekly','2026-06-25',51.08,'Invented prior-period grocer','Groceries'),
 tx('later','fixture-weekly','2026-07-05',82.17,'Invented future grocer','Groceries')];}
function build(rows=transactions(),ruleRows=rules,provider=O,observationDate=AS_OF){const d=data();
 d.meta.asOf=observationDate;d.plan.opening.asOf=observationDate;
 const input={plan:d.plan,accountMap,identityRules:ruleRows,transactions:rows,
   transactionWindow:{startDate:'2026-06-25',endDate:observationDate,complete:true,hasMore:false,truncated:false}};
 const candidates=provider.representedEventCandidates(input);
 const report={transactions:rows,representedEventCandidates:candidates,transactionWindow:input.transactionWindow,
   fetchedAt:observationDate+'T18:00:00.000Z',pendingCoverage:{complete:true}};
 const packet=provider.sanitizedCurrentPeriodActuals(report,{asOf:observationDate,plan:d.plan,accountMap,identityRules:ruleRows});
 d.plan.opening.representedEvents=candidates.map(({id,date})=>({id,date}));
 d.liveOverlay={applied:true,operatingPlan:'live',asOf:observationDate,currentPeriodActuals:packet};
 return {data:d,input,report,candidates,packet};}
module.exports={AS_OF,START,END,accountMap,rules,data,transactions,build};
