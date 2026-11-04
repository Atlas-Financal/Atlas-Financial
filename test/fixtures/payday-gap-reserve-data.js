'use strict';
// Entirely invented source reports and cents. No canonical/provider data reads.
const future = require('./savings-future-closing-data');
const clone = value => JSON.parse(JSON.stringify(value));
function input() {
  const x = future();
  x.plan.opening = {asOf:'2026-09-29',representedEvents:[]};
  x.plan.startingCash.breakdown.find(r=>r.id==='chequing-a').value=70;
  x.plan.startingCash.breakdown.find(r=>r.id==='chequing-b').value=30;
  const accountMap={schema:'atlas-provider-account-map/v1',provider:'lunchmoney',scope:'fixture',
    owns:'Invented payday-gap account mapping',does_not_own:'Financial policy or live identifiers',mappings:[
      {providerAccountId:'9101',canonical:{collection:'cash',id:'chequing-a'},atlasRole:'household-cash'},
      {providerAccountId:'9102',canonical:{collection:'cash',id:'chequing-b'},atlasRole:'household-cash'},
      {providerAccountId:'9103',canonical:{collection:'cash',id:'savings'},atlasRole:'household-reserve'},
      {providerAccountId:'9104',canonical:{collection:'cash',id:'savings-dont-touch'},atlasRole:'household-reserve'},
    ]};
  const transactions=[
    {id:'invented-credit',date:'2026-09-30',amount:-20,currency:'CAD',pending:false,savingsPostingEvidence:'posted',atlasAccountId:'chequing-a',accountRole:'household-cash'},
    {id:'invented-debit',date:'2026-10-01',amount:7,currency:'CAD',pending:false,savingsPostingEvidence:'posted',atlasAccountId:'chequing-a',accountRole:'household-cash'},
  ];
  const window={startDate:'2026-09-30',endDate:'2026-10-07',complete:true,hasMore:false,truncated:false};
  return {x,plan:x.plan,asOf:x.asOf,accountMap,transactions,window,pendingCoverage:'complete'};
}
function payload(i) {
  return {provider:'lunchmoney',fetchedAt:'2026-10-07T18:00:00Z',
    pendingCoverage:{complete:true,basis:require('../../scripts/provider-observe').PENDING_COVERAGE_BASIS,hasMore:false,truncated:false},
    transactionWindow:{...i.window,savingsFetchCoverage:{complete:true,startDate:i.window.startDate,endDate:i.window.endDate}},
    accounts:[['9101',83],['9102',30],['9103',30],['9104',89]].map(([id,balance])=>({id,name:'Invented account '+id,type:'cash',currency:'CAD',balance,updated_at: '2026-10-07T17:55:00Z', balance_last_update: '2026-10-07T17:55:00Z'})),
    transactions:i.transactions.map((t,n)=>({id:'invented-provider-'+n,account_id:9101,date:t.date,amount:t.amount,currency:'CAD',is_pending:t.pending,payee:'INVENTED CASH LEG '+n})),
  };
}
module.exports={input,payload,clone};
