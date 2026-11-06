'use strict';
// Invented observations; 450 is the owner-authorized policy target, not live data.
const clone=x=>JSON.parse(JSON.stringify(x));
const O=require('../../scripts/provider-observe');
const effective='2026-09-25',asOf='2026-10-04';
function build(other=137.26,date=asOf,opts={}){
 const zeroPlan=new Set(opts.zeroPlan||[]);
 const start=date<effective?'2026-09-11':effective,end=date<effective?'2026-09-24':'2026-10-08';
 const plan={opening:{asOf:date,priorAsOf:start,representedEvents:[]},defaults:{targetBuffer:0,extraDebtMonthly:0},
  startingCash:{breakdown:[{id:'chequing-a',label:'Invented bills',value:2700,evidenceDate:date,confidence:'confirmed'},
   {id:'chequing-b',label:'Invented spending',value:150,evidenceDate:date,confidence:'confirmed'}]},
  income:[{id:'payroll',label:'Invented salary',frequency:'biweekly',anchor:effective,amount:1400,confidence:'confirmed'}],
  bills:[],obligations:[],commitments:[],groups:[],funding:{options:[]},
  budget:{categories:[
   ...[['groceries',220],['fuel',85],['restaurants',60],['dale-guilt-free',35],['amanda-guilt-free',45],['pets',30]].map(([id,amount])=>({id,label:id,class:'essential',plannedPayday:zeroPlan.has(id)?0:amount,confidence:'confirmed',from:[]})),
   {id:'other-spend',label:'Other spend',class:'essential',plannedPayday:zeroPlan.has('other-spend')?0:450,plannedMonthly:null,targetEffectiveFrom:effective,
    targetHistory:[{effectiveThrough:'2026-09-24',plannedMonthly:800,futurePayPeriodReserve:400}],from:[]}]}};
 let packet={schema:'atlas-current-period-actuals/v1',asOf:date,transactionWindow:{startDate:'2026-09-10',endDate:date},
  transactionCoverage:'complete',pendingCoverageComplete:true,balances:{asOf:date,complete:true,
   accounts:plan.startingCash.breakdown.map(r=>({...r}))},transactions:[
   {id:'invented-other',date:start,account:'chequing-b',accountRole:'household-cash',amount:other,categoryLabel:'Uncategorised',currency:'cad',pending:false},
   {id:'invented-grocery',date:start,account:'chequing-b',accountRole:'household-cash',amount:110.37,categoryLabel:'Groceries',currency:'cad',pending:false},
   {id:'invented-transfer',date:start,account:'chequing-a',accountRole:'household-cash',amount:93.72,categoryLabel:'Transfer',kind:'transfer',currency:'cad',pending:false},
   ...(opts.pendingOther!=null?[{id:'invented-pending-other',date,account:'chequing-b',accountRole:'household-cash',amount:opts.pendingOther,categoryLabel:'Uncategorised',currency:'cad',pending:true}]:[]),
   ...(Array.isArray(opts.extraTx)?opts.extraTx.map((tx,i)=>({id:'invented-extra-'+i,date:start,account:'chequing-b',accountRole:'household-cash',currency:'cad',pending:false,...tx})):[]),
   ...(date>=effective?[{id:'invented-prior-other',date:'2026-09-12',account:'chequing-b',accountRole:'household-cash',amount:83.14,categoryLabel:'Uncategorised',currency:'cad',pending:false}]:[])]};
 const accountMap={mappings:[{providerAccountId:'invented-a',atlasRole:'household-cash',canonical:{id:'chequing-a',collection:'cash'}},
  {providerAccountId:'invented-b',atlasRole:'household-cash',canonical:{id:'chequing-b',collection:'cash'}}]};
 const transactions=packet.transactions.map(tx=>({...tx,providerTransactionId:tx.id,providerAccountId:tx.account==='chequing-a'?'invented-a':'invented-b',payee:tx.id,savingsPostingEvidence:tx.pending===true?'pending':'posted'}));
 packet=O.sanitizedCurrentPeriodActuals({transactions,representedEventCandidates:[],fetchedAt:date+'T18:00:00.000Z',
  transactionWindow:{startDate:'2026-09-10',endDate:date,complete:true,hasMore:false,truncated:false},
  pendingCoverage:opts.pendingCoverage==='partial'?{complete:false,status:'bounded-window'}:opts.pendingCoverage==='unknown'?{complete:false}:{complete:true}},
  {asOf:date,plan,accountMap,identityRules:[]});
 const data={meta:{asOf:date,title:'Invented Other target'},accounts:[],debts:[],revolvingExtra:[],plan,
  liveOverlay:{applied:true,operatingPlan:'live',asOf:date,currentPeriodActuals:packet}};
 return{plan,packet,data,start,end,date};
}
module.exports={build,effective,asOf,clone};
