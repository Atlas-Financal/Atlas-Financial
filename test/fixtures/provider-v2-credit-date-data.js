'use strict';
// Independent invented stocks; no source household balances or scaled inputs.
const base=require('./card-backfill-data');
const cardId='invented-v2-card';
const modes=['null-stale-object','null-current-object','null-current-fetch','malformed-date','malformed-type','impossible-date',
 'missing-date','stale-date','future-date','legacy-stale-over-v2','valid-v2','offset-date','calendar-date','legacy-over-null','legacy-object-date'];
const qualified=new Set(['valid-v2','offset-date','calendar-date','legacy-over-null','legacy-object-date']);
function input(mode='valid-v2'){
 const x=base(cardId,'invented-required-minimum'),day=x.asOf,stamp=day+'T17:00:00Z';
 x.data.meta.asOf=x.data.plan.opening.asOf=day;
 x.data.debts[0].balance=551.37;x.data.debts[0].limit=1420;
 x.data.plan.startingCash.breakdown[0].value=600;x.data.plan.income[0].amount=0;
 x.data.plan.obligations=[];x.data.plan.budget.categories=[];
 x.payload.transactions=[];x.payload.accounts[0].balance=600;
 x.payload.accounts.slice(0,3).forEach(a=>{a.balance_last_update=stamp;}); // N1: cash is dated by its semantic balance date
 const credit=x.payload.accounts[3];credit.balance=438.16;credit.credit_limit=1420;credit.available=981.84;
 credit.balance_last_update=stamp;credit.updated_at='2026-09-19T17:00:00Z';credit.date_last_fetched=stamp;
 credit.last_fetch=stamp;
 if(mode==='null-stale-object'||mode==='null-current-fetch')credit.balance_last_update=null;
 if(mode==='null-stale-object')delete credit.date_last_fetched;
 if(mode==='null-current-fetch')delete credit.updated_at;
 if(mode==='null-current-object'){credit.balance_last_update=null;credit.updated_at=stamp;}
 if(mode==='malformed-date'){credit.balance_last_update='not-a-date';credit.updated_at=stamp;}
 if(mode==='malformed-type'){credit.balance_last_update=[day];credit.updated_at=stamp;}
 if(mode==='impossible-date'){credit.balance_last_update='2026-02-30T17:00:00Z';credit.updated_at=stamp;}
 if(mode==='missing-date'){delete credit.balance_last_update;delete credit.updated_at;delete credit.date_last_fetched;}
 if(mode==='stale-date'){credit.balance_last_update='2026-09-19T17:00:00Z';credit.updated_at=stamp;}
 if(mode==='future-date'){credit.balance_last_update='2026-09-21T17:00:00Z';credit.updated_at=stamp;}
 if(mode==='legacy-stale-over-v2')credit.balance_as_of='2026-09-19T17:00:00Z';
 if(mode==='offset-date')credit.balance_last_update='2026-09-21T02:00:00Z';
 if(mode==='calendar-date')credit.balance_last_update=day;
 if(mode==='legacy-over-null'){credit.balance_last_update=null;credit.balance_as_of=stamp;}
 if(mode==='legacy-object-date'){delete credit.balance_last_update;credit.updated_at=stamp;}
 return x;
}
function served(mode,live){return live.fromObservation(input(mode));}
module.exports={input,served,modes,qualified,cardId};
