'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const F=require('../public/forecast'),UI=require('../public/budget-polish');
const fx=require('./fixtures/budget-surface-data');
const source=fs.readFileSync(path.join(__dirname,'../public/plan.js'),'utf8');
const grab=name=>{const m=new RegExp('^function '+name+'\\([\\s\\S]*?\\n\\}','m').exec(source);assert.ok(m,name);return m[0];};
const known=/^const budgetBrowseKnown = .*$/m.exec(source)[0];
const functions=vm.runInNewContext(known+'\n'+['isValidIsoCalendarDate','budgetBrowseMoney','budgetCategoryPresentation','budgetCategoryBarHtml','budgetBillPresentation'].map(grab).join('\n')+
  '\n({budgetCategoryPresentation,budgetCategoryBarHtml,budgetBillPresentation})',{Forecast:F,money2:n=>'$'+n.toFixed(2)});
for(const planned of [0,40,null,undefined,NaN,Infinity,-1,'0']){
  const row={id:'invented-category',planned,spent:25,overspend:25,remaining:-25,trust:'calculated'};
  const state=functions.budgetCategoryPresentation(row),html=functions.budgetCategoryBarHtml(row,state,.5);
  const over=typeof planned==='number'&&Number.isFinite(planned)&&planned>=0&&25>planned;
  assert.equal(html.includes('is-over-plan'),over);
  assert.equal(html.includes('budget-category-over-limit'),over);
  if(planned===0){assert.match(html,/data-budget-category-scale="no-scale"/);assert.doesNotMatch(html,/budget-category-fill|NaN|Infinity|width:/);}
  if(planned==null||!Number.isFinite(planned))assert.doesNotMatch(html,/budget-category-over-limit|budget-category-fill/);
  assert.equal(row.spent,25,'presentation retains independently invented actual amount');
}
for(const spent of [0,null,NaN,'25']){
  const row={planned:0,spent,trust:'calculated'};
  assert.doesNotMatch(functions.budgetCategoryBarHtml(row,functions.budgetCategoryPresentation(row),null),/is-over-plan|budget-category-over-limit/);
}
for(const trust of ['unknown','unavailable','untrusted']){
  const row={planned:0,spent:25,trust};
  assert.doesNotMatch(functions.budgetCategoryBarHtml(row,functions.budgetCategoryPresentation(row),null),/is-over-plan|budget-category-over-limit/);
}
const d=fx.served();
// Independent prepaid occurrence exercises Forecast's future settlement
// normalization, rather than manufacturing the published planned status.
d.plan.opening.representedEvents.push({id:'mortgage',date:'2026-09-15'});
const a=F.recommend(d.plan,d.meta.asOf,{...d.plan.defaults,debts:d.debts,currentPeriodActuals:d.liveOverlay.currentPeriodActuals});
const future=a.payPeriodViews.find(p=>p.start==='2026-09-11');
const row=future.bills.find(r=>r.status==='planned'&&r.settlement==='upcoming');
assert.ok(row,'incumbent Forecast actually publishes planned/upcoming');
const before=JSON.stringify(row);
assert.equal(functions.budgetBillPresentation(row).label,'Due','Budget names this published upcoming dated occurrence without asserting unpaid settlement');
assert.equal(functions.budgetBillPresentation(row).kind,'due');
for(const date of ['2026-08-20','2026-08-21',null,'2026-02-30']){
  const native=UI.planningBillChrome(row.status,date,d.meta.asOf,row.settlement);
  assert.equal(native.label,'Not paid');assert.equal(native.kind,'to-pay');assert.equal(native.planning,false);
}
assert.equal(JSON.stringify(row),before,'native/browse mapping cannot mutate Forecast settlement');
for(const settlement of [null,'unknown','unverified','pending']){
  const expected=settlement==='unverified'?'check':settlement==='pending'?'pending':'unknown';
  assert.equal(UI.billStatePresentation('planned',settlement).kind,expected);
}
console.log('PASS #493 review regressions: actual future planned/upcoming keeps its settlement under Budget Due and native Not paid labels; trusted zero-plan overspend is marked without division; missing plan/spend/trust stays unmarked');
