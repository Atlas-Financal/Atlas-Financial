'use strict';
// Invented cents, references and dates. No native-unit adapter or live facts.
const OPENING=93417,PLANNED=18361,OBSERVED=5983;
const cases=[
  {id:'fortis',payee:'Fortisbc Energy Bpy',date:'2026-09-01',due:'2026-09-03',asOf:'2026-09-04',frequency:'monthly',day:3,firstDue:'2026-09-03'},
  {id:'hydro-due-sep1',payee:'BC Hydro',date:'2026-09-04',due:'2026-09-01',asOf:'2026-09-05',frequency:'once'},
  {id:'hydro-equal-payment',payee:'BCHYDRO',date:'2026-10-04',due:'2026-10-01',asOf:'2026-10-05',frequency:'monthly',day:1,firstDue:'2026-10-01'},
];
const clone=x=>JSON.parse(JSON.stringify(x));
function build(sample,rows){
  const beforeMonth=new Date(sample.due.slice(0,7)+'-01T00:00:00Z');
  beforeMonth.setUTCDate(beforeMonth.getUTCDate()-1);
  const start=beforeMonth.toISOString().slice(0,10);
  const data={meta:{asOf:start},accounts:[],debts:[],revolvingExtra:[],plan:{
    opening:{asOf:start,representedEvents:[]},windowDays:31,
    startingCash:{breakdown:[{id:'chequing-a',value:OPENING/100},{id:'chequing-b',value:0}]},
    defaults:{targetBuffer:0,extraDebtMonthly:0},income:[],obligations:[],commitments:[],budget:{categories:[]},
    bills:[{id:sample.id,label:'Invented utility',amount:PLANNED/100,confidence:'estimated',payingAccount:'chequing-a',
      frequency:sample.frequency,...(sample.frequency==='once'?{date:sample.due}:{day:sample.day,firstDue:sample.firstDue})}]
  }};
  const accountMap={schema:'atlas-provider-account-map/v1',scope:'fixture',provider:'lunchmoney',mappings:[
    {providerAccountId:'9101',canonical:{collection:'cash',id:'chequing-a'},atlasRole:'household-cash'},
    {providerAccountId:'9102',canonical:{collection:'cash',id:'chequing-b'},atlasRole:'household-cash'}]};
  return {data,accountMap,payload:{provider:'lunchmoney',fetchedAt:sample.asOf+'T18:00:00Z',
    transactionWindow:{startDate:start,endDate:sample.asOf,complete:true,hasMore:false,truncated:false},
    pendingCoverage:{complete:true,basis:'is_pending-unbounded',hasMore:false,truncated:false},
    accounts:[{id:9101,name:'Invented Bills',type:'cash',currency:'cad',balance:OPENING/100,updated_at: sample.asOf+'T17:55:00Z', balance_last_update: sample.asOf+'T17:55:00Z'},
      {id:9102,name:'Invented Weekly',type:'cash',currency:'cad',balance:0,updated_at: sample.asOf+'T17:55:00Z', balance_last_update: sample.asOf+'T17:55:00Z'}],
    categories:[{id:19,name:'Invented utility expense',is_income:false,exclude_from_totals:false}],transactions:rows}};
}
function transaction(sample,extra={}){return {id:8101,account_id:9101,date:sample.date,amount:OBSERVED/100,
  currency:'cad',is_pending:false,payee:sample.payee,category_id:19,...extra};}
module.exports={OPENING,PLANNED,OBSERVED,cases,clone,build,transaction};
