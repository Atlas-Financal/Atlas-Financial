'use strict';
// Independent invented observations and category amounts. 450 is approved
// policy, not a copied observation. Exercise the active native sheet renderer.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const F=require('../public/forecast'),fx=require('./fixtures/other-period-target');
const LmGroups=require('./lm-groups-fixture.js');
const build=(...a)=>{const f=fx.build(...a);f.plan=LmGroups.groupPlan(f.plan);f.packet=LmGroups.groupPacket(f.packet,f.plan);f.data={...f.data,plan:f.plan,liveOverlay:{...f.data.liveOverlay,currentPeriodActuals:f.packet}};return f;};
const stub=()=>({innerHTML:'',value:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},
 addEventListener(){},querySelector(){return null},querySelectorAll(){return[]},appendChild(){},replaceChildren(){}});
const context=vm.createContext({Forecast:F,console,setTimeout,clearTimeout,addEventListener(){},
 document:{getElementById:stub,querySelectorAll(){return[]},addEventListener(){},documentElement:{dataset:{},style:{}}},
 localStorage:{getItem(){return null},setItem(){}},location:{pathname:'/',search:''}});
context.window=context;context.matchMedia=()=>({matches:false,addEventListener(){}});
const script=name=>fs.readFileSync(path.join(__dirname,'../public/'+name+'.js'),'utf8');
vm.runInContext(script('app'),context);vm.runInContext('App.boot=()=>{};',context);
for(const name of ['bill-detail','savings-inventory','budget-surface','plan'])vm.runInContext(script(name),context);
const render=(period,plan)=>{context.period=period;context.plan=plan;return vm.runInContext('calendarWaterfallHtml(period,null,null,plan,true)',context);};
const publish=f=>F.recommend(f.plan,f.date,{...f.plan.defaults,debts:[],currentPeriodActuals:f.packet});
const sheet=html=>html.split('data-operating-question="06"')[1].split('data-operating-question="07"')[0];
const total=html=>html.split('data-household-budget-progress-total>')[1].split('</strong>')[0];
const money=n=>new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format(n).replace(/^-/, '\u2212');
for(const [spent,actual,remaining,hold] of [[0,110.37,450,925],[137.26,247.63,312.74,925],
 [450,560.37,0,925],[618.73,729.10,-168.73,1093.73],[1034.19,1144.56,-584.19,1509.19]]){
 const f=build(spent),before=JSON.stringify(f),p=publish(f).payPeriodViews.find(p=>p.timelineRole==='current');
 const sealed=JSON.stringify(p),html=sheet(render(p,f.plan)),pair=total(html);
 assert.equal((html.match(/<h3>Household Budget Total<\/h3>/g)||[]).length,1);
 assert.match(html,/Actual \/ Planned/);assert.doesNotMatch(html,/Actual and original plan|Original plan:/);
 assert.ok(pair.includes(money(actual)),'actual = invented groceries 110.37 + observed Other');
 assert.ok(pair.includes(money(925)),'six invented plans 475 + Other policy 450, untouched by overspend');
 assert.equal(p.budgetHold,hold,'protective max reserve retains independent expected cents');
 assert.equal(p.balanceAfterDeductions,(140000-Math.round(hold*100))/100,'financial deduction unchanged');
 assert.match(html,/<details class="household-budget-reserve-info" data-budget-reserve-info>/);
 assert.doesNotMatch(html,/<details[^>]*data-budget-reserve-info[^>]*\bopen\b/);
 assert.match(html,/Info: protective spending reserve[\s\S]*Protective spending reserve/);
 const other=html.split('data-budget-category="other-spending"')[1].split('</dl>')[0];
 assert.match(other,/<dt>Remaining<\/dt>/);assert.ok(other.includes(money(remaining)),`published signed Other remaining ${money(remaining)} survives: ${other.slice(other.indexOf('<dt>Remaining'))}`);
 assert.equal(JSON.stringify(p),sealed);assert.equal(JSON.stringify(f),before,'display cannot rewrite plans, observed cash or captured rows');
}
const missing=build();missing.packet.transactionCoverage='truncated';
const mp=publish(missing).payPeriodViews.find(p=>p.timelineRole==='current'),mh=sheet(render(mp,missing.plan));
assert.match(total(mh),/data-budget-ratio-actual><span class="budget-v3-unknown">Unknown/);
assert.ok(total(mh).includes(money(925)),'unknown actual retains original plan');
assert.match(mh.split('data-budget-category="other-spending"')[1],/<dt>Remaining<\/dt><dd>Unavailable<\/dd>/);
// Real provider sanitization -> recommend -> sealed publication -> active
// native household sheet. Do not inject or substitute a progress publication.
for(const pendingCoverage of ['partial','unknown']){
 const f=build(137.26,fx.asOf,{pendingCoverage}),input=JSON.stringify(f),p=publish(f).payPeriodViews.find(p=>p.timelineRole==='current');
 assert.equal(f.packet.pendingCoverage,pendingCoverage);
 assert.equal(p.budgetProgress.coverage.remainingClaim,'posted-only');
 assert.equal(p.budgetProgress.household.actual.completeness,'partial');
 assert.equal(p.budgetProgress.household.actual.amount,247.63);
 assert.equal(p.householdBudget.find(r=>r.id==='other-spending').remaining,312.74,'engine publication stays unchanged; display must qualify completeness');
 assert.equal(p.budgetHold,925);assert.equal(p.balanceAfterDeductions,475);
 const sealed=JSON.stringify(p),html=sheet(render(p,f.plan)),other=html.split('data-budget-category="other-spending"')[1].split('</dl>')[0];
 assert.match(total(html),/247\.63[\s\S]*partial evidence/);
 assert.ok(total(html).includes(money(925)));assert.match(other,/<dt>Remaining<\/dt><dd>Unavailable<\/dd>/);
 assert.doesNotMatch(other,/312\.74/);
 assert.equal((html.match(/<dt>Remaining<\/dt><dd>Unavailable<\/dd>/g)||[]).length,7,'all native household Remaining rows carry the incomplete period context');
 assert.match(html,/data-budget-remaining-info/,'explanation stays behind Info in the same movable category node');
 context.period=p;context.displayCtx={asOf:f.date,plan:f.plan,advice:publish(f)};
 const browse=vm.runInContext('budgetSpendingSectionHtml(period,displayCtx)',context);
 assert.doesNotMatch(browse,/312\.74 left|All used/,'browse cannot retain an unqualified remaining claim beside the repaired native sheet');
 assert.match(browse,/Remaining unavailable/);
 assert.equal(JSON.stringify(p),sealed);assert.equal(JSON.stringify(f),input);
}
const completePending=build(137.26,fx.asOf,{pendingOther:17.43}),cp=publish(completePending).payPeriodViews.find(p=>p.timelineRole==='current');
assert.equal(cp.budgetProgress.household.actual.completeness,'complete');assert.equal(cp.budgetProgress.household.actual.includesPending,true);
assert.equal(cp.budgetProgress.household.actual.amount,265.06);assert.equal(cp.householdBudget.find(r=>r.id==='other-spending').remaining,295.31);
const ch=sheet(render(cp,completePending.plan));assert.match(ch.split('data-budget-category="other-spending"')[1],/<dt>Remaining<\/dt>[\s\S]*295\.31/);
assert.doesNotMatch(ch,/data-budget-remaining-info/,'fully covered observed pending does not lose its known Remaining');
const historical=build(137.26,'2026-10-18'),hp=publish(historical).payPeriodViews.find(p=>p.start===fx.effective);
const hh=sheet(render(hp,historical.plan));
assert.ok(total(hh).includes(money(247.63)));assert.match(total(hh),/data-budget-ratio-plan><span class="budget-v3-unknown">Unknown/);
assert.match(hh,/Historical original plan unavailable/);assert.doesNotMatch(hh.split('data-budget-category="other-spending"')[1].split('</dl>')[0],/<dt>Remaining<\/dt>/);
const future=build(),fp=publish(future).payPeriodViews.find(p=>p.timelineRole==='next'),fh=sheet(render(fp,future.plan));
assert.match(total(fh),/data-budget-ratio-actual><span class="budget-v3-unknown">Unknown/);
assert.ok(total(fh).includes(money(925)));assert.match(fh,/data-budget-hold-trust="estimated"/);
const futureOther=fh.split('data-budget-category="other-spending"')[1].split('</dl>')[0];
assert.match(futureOther,/<dt>Remaining<\/dt>[\s\S]*estimated[\s\S]*450\.00/);
assert.match(fh,/Projected\./,'future remaining remains explicitly projected, never observed');
context.pair={planned:{amount:925,completeness:'complete',trust:'calculated'},actual:{amount:247.63,completeness:'partial',trust:'estimated',includesPending:true,reason:'Invented pending coverage is partial.'}};
const partial=vm.runInContext("budgetProgressEvidenceHtml(pair,'household')",context);
assert.match(partial,/partial evidence/);assert.match(partial,/observed pending transactions/);assert.match(partial,/Invented pending coverage is partial/);
console.log('PASS one native Household Budget Total actual/planned; independent under/at/over cents, unchanged reserve/deductions, Other signed/unknown remaining, historical/future/pending truth and immutable evidence');
