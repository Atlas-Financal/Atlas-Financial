'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.ATLAS_TEST_APP_ROOT||path.join(__dirname,'..'),O=require(path.join(root,'scripts/provider-observe'));
const Live=require(path.join(root,'scripts/live-plan')),F=require(path.join(root,'public/forecast'));
const fx=require('./fixtures/provider-v2-credit-date-data');let checks=0;
function eq(a,b,reason){assert.deepEqual(a,b,reason);checks++;}
const page=vm.createContext({ escapeHtml: require('./app-escape-html'),Forecast:F,console,App:{boot(){},register(){}},money2:n=>'$'+Number(n).toFixed(2),pct:n=>n+'%',fmtDateFull:n=>n});
vm.runInContext(fs.readFileSync(path.join(root,'public/credit.js'),'utf8'),page);
for(const mode of fx.modes){
 const x=fx.input(mode),inputBefore=JSON.stringify(x),report=O.observe({provider:'lunchmoney',...x});
 const posted=report.observations.find(row=>row.cardId===fx.cardId&&row.fact==='posted-balance');
 const rawUnknown=['null-stale-object','null-current-object','null-current-fetch','malformed-date','malformed-type','impossible-date','missing-date'].includes(mode);
 for(const fact of ['posted-balance','available-credit','limit']){
  const obs=report.observations.find(row=>row.cardId===fx.cardId&&row.fact===fact);
  eq(obs.evidenceDate,rawUnknown?null:['stale-date','legacy-stale-over-v2'].includes(mode)?'2026-09-19':mode==='future-date'?'2026-09-21':x.asOf,
   mode+': '+fact+' preserves semantic date and never borrows request time');
  eq(obs.observedAsOf,obs.evidenceDate,mode+': no secondary freshness promotion');
  eq(obs.unknown===true,rawUnknown||mode==='future-date',mode+': all credit facts qualify missing/invalid/future evidence as unknown');
 }
 const live=Live.fromObservation(x),data=live.data,expected=fx.qualified.has(mode)?438.16:551.37;
 eq(data.debts[0].balance,expected,mode+': independently invented observed stock or unchanged incumbent');
 eq(live.overlays.some(row=>row.locator==='debts:'+fx.cardId&&row.field==='balance'),fx.qualified.has(mode),mode+': only dated stock can enter the live overlay');
 if(!fx.qualified.has(mode)){
  assert.ok(live.refused.some(row=>row.locator==='debts:'+fx.cardId&&row.fact==='posted-balance'));checks++;
 }
 eq(F.postedHouseholdChequingCash(data.plan),600,mode+': credit capacity never enters cash');
 const rows=F.creditAccounts(data.plan,data.debts,data.meta.asOf),card=rows.cards.find(row=>row.id===fx.cardId);
 eq(card.balance,expected,mode+': Forecast active Credit publisher retains stock authority');
 page.row=card;const html=vm.runInContext('cardHtml(row)',page);
 assert.match(html,new RegExp('<b>\\$'+expected.toFixed(2).replace('.','\\.')+'</b>'),mode+': active Credit renderer prints the qualified stock');checks++;
 eq(JSON.stringify(x),inputBefore,mode+': raw, canonical and receipt inputs unchanged');
 const replay=Live.fromObservation({...x,data});
 eq(replay.data.debts[0].balance,expected,mode+': repeat refresh cannot promote unknown date');
 if(rawUnknown){
  const advancedInput=fx.input(mode),nextDay='2026-09-21';advancedInput.asOf=nextDay;
  advancedInput.payload.fetchedAt=nextDay+'T18:00:00Z';
  advancedInput.payload.accounts.forEach(account=>{account.updated_at=nextDay+'T17:00:00Z';});
  advancedInput.payload.accounts.slice(0,3).forEach(account=>{account.balance_last_update=nextDay+'T17:00:00Z';});
  advancedInput.payload.accounts[3].date_last_fetched=nextDay+'T17:00:00Z';
  advancedInput.payload.accounts[3].last_fetch=nextDay+'T17:00:00Z';
  // The missing-field mode keeps missing dates; every explicit unknown v2
  // mode must resist even fresh legacy/object/sync metadata on a later day.
  if(mode==='missing-date'){delete advancedInput.payload.accounts[3].updated_at;delete advancedInput.payload.accounts[3].date_last_fetched;}
  advancedInput.payload.transactionWindow.endDate=nextDay;
  const advanced=Live.fromObservation({...advancedInput,data});
  eq(advanced.data.debts[0].balance,551.37,mode+': advancing request and object/sync clocks cannot replace stock');
  eq(advanced.overlays.some(row=>row.locator==='debts:'+fx.cardId&&row.field==='balance'),false,mode+': advanced overlay still refuses undated stock');
  eq(F.postedHouseholdChequingCash(advanced.data.plan),600,mode+': advancing observed cash remains independent');
 }
 eq(posted.evidenceValue,438.16,mode+': provider-reported diagnostic evidence retained without overwriting stock');
}
console.log('PASS v2 semantic dates -> all credit facts -> live overlay -> Forecast -> active Credit renderer: '+checks+' independent checks; unknown/stale/future stock held, valid/legacy dates retained, repeat refresh and cash isolation');
