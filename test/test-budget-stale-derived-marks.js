'use strict';
// Independent invented observations and category amounts. 450 is approved
// policy, not a copied observation. Exercise the active native sheet renderer.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const F=require('../public/forecast'),fx=require('./fixtures/other-period-target');
const stub=()=>({innerHTML:'',value:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},
 addEventListener(){},querySelector(){return null},querySelectorAll(){return[]},appendChild(){},replaceChildren(){}});
const context=vm.createContext({Forecast:F,console,setTimeout,clearTimeout,addEventListener(){},
 document:{getElementById:stub,querySelectorAll(){return[]},addEventListener(){},documentElement:{dataset:{},style:{}}},
 localStorage:{getItem(){return null},setItem(){}},location:{pathname:'/',search:''}});
context.window=context;context.matchMedia=()=>({matches:false,addEventListener(){}});
const script=name=>fs.readFileSync(path.join(__dirname,'../public/'+name+'.js'),'utf8');
vm.runInContext(script('app'),context);vm.runInContext('App.boot=()=>{};',context);
for(const name of ['bill-detail','savings-inventory','budget-surface','plan'])vm.runInContext(script(name),context);
// Run the actual Forecast publication and the incumbent Budget renderer.
// No money or trust field in the publication may change during rendering.
const build = (...args) => {
 const f = fx.build(...args);
 f.data.liveOverlay.observedCash = {asOf:f.date,complete:true,accounts:fx.clone(f.plan.startingCash.breakdown)};
 return f;
};
const options = f => ({...f.plan.defaults,debts:[],currentPeriodActuals:f.packet,
 operatingPlan:f.data.liveOverlay.operatingPlan,observedCash:f.data.liveOverlay.observedCash});
const stripMarks = html => html.replace(/ <span class="budget-spent-incomplete" data-budget-spent-incomplete>Incomplete<\/span>/g, '');
const render = (f, period, overlay = f.data.liveOverlay) => {
 context.period = period;
 context.displayCtx = {asOf: f.date, plan: f.plan, advice: F.recommend(f.plan,f.date,options(f)), liveOverlay: overlay};
 return vm.runInContext('budgetSpendingSectionHtml(period,displayCtx)',context);
};
const publish = f => F.recommend(f.plan,f.date,options(f));
const status = (html,id) => html.split('data-budget-category-open="'+id+'"')[1].split('<span class="budget-category-status">')[1].split(/<\/span>\s*<span class="budget-category-meta">/)[0];
const delta = html => html.split('<span data-budget-household-delta')[1].split('</div>')[0];
const remaining = html => html.split('<strong data-budget-browse-remaining>')[1].split('</strong>')[0];
const marked = html => /data-budget-spent-incomplete>Incomplete/.test(html);
for (const [other,expectedDelta,expectedStatus] of [[137.26,677.37,'left'],[814.63,0,'over'],[1034.19,219.56,'over']]) {
 const f=build(other), p=publish(f).payPeriodViews.find(p=>p.timelineRole==='current');
 const before=JSON.stringify({f,p}), stale=render(f,p);
 assert.equal(p.budgetProgress.household.delta.magnitude,expectedDelta,'independent: 925 - (110.37 + Other), magnitude');
 assert.ok(marked(status(stale,'other-spending')), 'stale category '+expectedStatus+' carries Incomplete');
 assert.ok(marked(delta(stale)), 'stale household delta carries Incomplete');
 assert.ok(marked(remaining(stale)), 'stale Still planned carries Incomplete');
 // Change only the date of an existing same-period row: identical amounts.
 const freshOverlay=fx.clone(f.data.liveOverlay);
 freshOverlay.currentPeriodActuals.transactions[0].date=fx.asOf;
 const fresh=render(f,p,freshOverlay);
 assert.ok(!marked(fresh),'fresh feed has no mark');
 assert.equal(stripMarks(stale).replace(/ data-budget-spent-trust="incomplete"/g,'').replace(' data-bank-feed="stale"','').replace(/<p class="budget-browse-note budget-bank-feed-stale"[\s\S]*?<\/p>/,''),fresh,'all non-mark, non-notice markup stays byte-identical');
 assert.equal(JSON.stringify({f,p}),before,'rendering cannot mutate any input, cents or trust field');
 for(const overlay of [null,{...f.data.liveOverlay,applied:false},{...f.data.liveOverlay,currentPeriodActuals:null}])
  assert.ok(!marked(render(f,p,overlay)), 'absent, unapplied or unknown feed makes no stale claim');
}
for(const opts of [{pendingCoverage:'unknown'},{pendingCoverage:'partial'}]) {
 const f=build(137.26,fx.asOf,opts),p=publish(f).payPeriodViews.find(p=>p.timelineRole==='current'),html=render(f,p);
 assert.ok(!marked(delta(html)),'unavailable delta is not a marked money value');
 assert.ok(!marked(status(html,'other-spending')),'unavailable category remaining has no numeric marker');
 assert.match(status(html,'other-spending'),/Remaining unavailable/);
}
const f=build(), advice=publish(f);
for(const role of ['past','next']) {
 const p=advice.payPeriodViews.find(p=>p.timelineRole===role);
 assert.ok(p,'fixture has '+role);
 assert.ok(!marked(render(f,p)),'non-current period never gets a feed mark');
}
// Fully used is also a derived-spending assertion, even without a printed zero.
const used=build(450),p=publish(used).payPeriodViews.find(p=>p.timelineRole==='current');
assert.match(status(render(used,p),'other-spending'),/All used[\s\S]*Incomplete/);
const noCash=build(); delete noCash.data.liveOverlay.observedCash;
const noCashPeriod=publish(noCash).payPeriodViews.find(p=>p.timelineRole==='current');
const noCashHtml=render(noCash,noCashPeriod);
assert.match(remaining(noCashHtml),/Unavailable/);
assert.ok(!marked(remaining(noCashHtml)),'unavailable Still planned has no mark or invented value');
console.log('PASS stale derived marks: current left/over/used, household delta and Still planned; unchanged cents, fresh/missing/unapplied/unknown/historical/future controls');
