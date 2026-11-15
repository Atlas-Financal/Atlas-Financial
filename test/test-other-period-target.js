'use strict';
const assert=require('node:assert/strict'),F=require('../public/forecast'),fx=require('./fixtures/other-period-target');
function period(f){return F.recommend(f.plan,f.date,{...f.plan.defaults,debts:[],currentPeriodActuals:f.packet}).payPeriodViews.find(p=>p.timelineRole==='current');}
for(const [spent,cents] of [[0,0],[137.26,13726],[450,45000],[618.73,61873]]){
 const f=fx.build(spent),before=JSON.stringify(f.packet),p=period(f),r=p.householdBudget.find(x=>x.id==='other-spending');
 assert.ok(r);assert.equal(r.planned,450);assert.equal(r.spent,spent);
 assert.equal(r.hold,Math.max(45000,cents)/100,'consume once: no 450 + actual');
 assert.equal(r.remaining,(45000-cents)/100);assert.equal(r.overspend,Math.max(0,cents-45000)/100);
 assert.equal(p.budgetHold,(47500+Math.max(45000,cents))/100,'six invented category plans sum 475; independent max policy');
 // The fixture's invented 93.72 posted chequing debit is filed as Transfer with no
 // proven other side: it reduces the remainder once, as Money out, to confirm.
 assert.deepEqual([p.moneyOutToConfirm.posted,p.moneyOutToConfirm.count],[93.72,1]);
 assert.equal(p.balanceAfterDeductions,(140000-47500-Math.max(45000,cents)-9372)/100,'active deduction chain consumes the once-only reserve, not target plus actual; the unproven transfer leaves once');
 assert.equal(p.budgetProgress.household.planned.amount,925,'original total includes one Other plan');
 assert.equal(p.budgetProgress.household.actual.amount,(11037+cents)/100);
 assert.equal(JSON.stringify(f.packet),before,'budget target does not rewrite actual evidence');
 assert.equal(r.recon.length,spent===0?0:1,'transaction membership remains original residual only');
 if(spent)assert.equal(r.recon[0].displayedPayee,'invented-other');
 const clone=fx.clone(f);delete clone.plan.budget.categories.at(-1).plannedPayday;delete clone.plan.budget.categories.at(-1).targetEffectiveFrom;
 const baseline=period(clone).householdBudget.find(x=>x.id==='other-spending');assert.deepEqual(r.recon,baseline?.recon||[]);
 assert.equal(p.fromTodayFunding.status,'ready');
 assert.equal(p.fromTodayFunding.remainingHousehold,(36463+Math.max(0,45000-cents))/100,'from today reserves only unused plan');
 const opts={...f.plan.defaults,debts:[],currentPeriodActuals:f.packet};
 const allocation=F.paydayAllocation(f.plan,f.date,opts);
 const otherCash=allocation.essentials.items.find(row=>row.id==='other-spend');
 assert.equal(otherCash.planned,450);
 assert.equal(otherCash.posted,spent,'cash allocation consumes the exact incumbent residual evidence');
 assert.equal(otherCash.required,Math.max(0,45000-cents)/100,'posted cash reserves only unused Other, never another 450');
 assert.equal(allocation.essentials.wanted,(36463+Math.max(0,45000-cents))/100,'Today cash and named unused plans agree');
 const action=F.currentPeriodAction(f.plan,f.date,opts);
 const otherAction=action.categories.find(row=>row.id==='other-spend');
 assert.equal(otherAction.committed,spent);
 assert.equal(otherAction.remaining,(45000-cents)/100);
 assert.equal(action.categories.some(row=>row.id==='uncategorised'),false,'the same residual is not charged under a second identity');
}
const old=fx.build(137.26,'2026-09-20'),r=period(old).householdBudget.find(x=>x.id==='other-spending');
assert.equal(r.planned,null);assert.equal(r.hold,137.26,'prior active period retains actual-only reserve');
const current=fx.build(),advice=F.recommend(current.plan,current.date,{...current.plan.defaults,debts:[],currentPeriodActuals:current.packet});
const past=advice.payPeriodViews.find(p=>p.timelineRole==='past'&&p.start==='2026-09-11');
assert.ok(past,'the covered prior completed Sep 11-24 period is exercised');
const priorOther=past.householdBudget.find(x=>x.id==='other-spending');
assert.ok(priorOther,'covered independent prior-period spending remains published');
assert.deepEqual([priorOther.planned,priorOther.spent,priorOther.hold],[null,83.14,83.14],'prior completed period retains exact actual-only deduction');
for(const older of advice.payPeriodViews.filter(p=>p.timelineRole==='past'&&p.start<'2026-09-10')){
 assert.equal(older.householdBudget.find(row=>row.id==='other-spending'),undefined,'uncovered older history does not invent an Other row');
 assert.equal(older.budgetProgress.household.actual.amount,null,'uncovered historical actual remains unavailable, never zero');
}
for(const date of ['2026-09-24','2026-09-25']){
 const f=fx.build(137.26,date),r=period(f).householdBudget.find(x=>x.id==='other-spending');
 assert.equal(r.planned,date<fx.effective?null:450,'target switches at the exact Sep 25 cycle boundary');
 const opts={...f.plan.defaults,debts:[],currentPeriodActuals:f.packet};
 const cash=F.paydayAllocation(f.plan,date,opts).essentials.items.find(row=>row.id==='other-spend');
 assert.equal(cash.planned,date<fx.effective?367.97:450,'14-day legacy monthly scale stays 800 * 14 / (365.25 / 12) before Sep 25');
 const action=F.currentPeriodAction(f.plan,date,opts).categories.find(row=>row.id==='other-spend');
 assert.equal(action.planned,date<fx.effective?367.97:450,'current action uses the same dated target');
 const periods={periods:{ytd:{months:1,spending:[]}},asOf:date};
 const bd=F.budgetBreakdown(f.plan,periods,{asOf:date});
 assert.equal(bd.categories.find(row=>row.id==='other-spend').target,date<fx.effective?800:978.35,'monthly target selects the bounded policy');
}
// A prior-asOf cash walk must not acquire a present-day owner target.
// Both plans and all observations here are independently invented.
for(const date of ['2026-08-19','2026-09-24']){
 const f=fx.build(0,date),legacy=fx.clone(f.plan),cat=legacy.budget.categories.at(-1);
 delete cat.plannedPayday;delete cat.targetEffectiveFrom;delete cat.targetHistory;cat.plannedMonthly=800;cat.futurePayPeriodReserve=400;
 const opts={debts:[],periods:{periods:{ytd:{months:1,spending:[]}},asOf:date},extraDebtMonthly:0,targetBuffer:0};
 const currentWalk=F.baselineTrajectory(f.plan,[],date,opts),oldWalk=F.baselineTrajectory(legacy,[],date,opts);
 assert.equal(currentWalk.status,'ready');assert.equal(oldWalk.status,'ready');
 if(date==='2026-08-19')assert.ok(currentWalk.months.some(row=>row.end<fx.effective),'the regression must exercise an earlier month publication');
 assert.deepEqual(currentWalk.months.filter(row=>row.end<fx.effective),oldWalk.months.filter(row=>row.end<fx.effective),
  'all earlier month publications remain byte-for-byte unchanged by the dated restatement');
 assert.deepEqual(currentWalk.weeklyVariable,oldWalk.weeklyVariable,'the walk starts with the retired monthly policy');
 assert.deepEqual(currentWalk.payPeriods.filter(row=>row.end<fx.effective),oldWalk.payPeriods.filter(row=>row.end<fx.effective));
}
const completed=fx.build(137.26,'2026-10-18'),completedAdvice=F.recommend(completed.plan,completed.date,{...completed.plan.defaults,debts:[],currentPeriodActuals:completed.packet});
const completedOther=completedAdvice.payPeriodViews.find(p=>p.start===fx.effective).householdBudget.find(x=>x.id==='other-spending');
assert.deepEqual([completedOther.planned,completedOther.spent,completedOther.hold,completedOther.remaining],[450,137.26,137.26,null],
 'after-policy completed periods retain dated plan but only deduct observed consumption, with no current reserve');
assert.equal(completedAdvice.payPeriodViews.find(p=>p.start===fx.effective).budgetProgress.household.planned.amount,null,
 'configured dated target does not establish the original completed-period household plan');
const next=advice.payPeriodViews.find(p=>p.timelineRole==='next');
assert.equal(next.householdBudget.filter(x=>['other-spending','other-spend'].includes(x.id)).length,1,'future reserve is included once');
assert.equal(next.householdBudget.find(x=>x.id==='other-spending').hold,450);
assert.equal(next.householdBudget.find(x=>x.id==='other-spending').trust,'estimated');
assert.equal(next.budgetHoldTrust,'estimated');assert.equal(next.balanceAfterDeductionsTrust,'estimated','future target cannot lose estimated trust downstream');
const unavailable=fx.build();unavailable.packet.transactionCoverage='truncated';
const unknown=period(unavailable).householdBudget.find(x=>x.id==='other-spending');assert.equal(unknown.spent,null);assert.equal(unknown.planned,450);
assert.equal(unknown.remaining,null,'missing observations do not prove 450 left');
const unknownCash=F.paydayAllocation(unavailable.plan,unavailable.date,{currentPeriodActuals:unavailable.packet,debts:[]}).essentials.items.find(row=>row.id==='other-spend');
assert.equal(unknownCash.posted,null,'missing cash-consumption evidence remains unknown, never zero');
const pending=fx.build(),postedOther=pending.packet.transactions.find(tx=>tx.amount===137.26);
assert.ok(postedOther,'the sanitized independent Other observation is present');
const pendingTx={...postedOther,id:'invented-pending-other',amount:17.43,pending:true,pendingTreatment:'unresolved'};
pending.packet.transactions.push(pendingTx);
const pendingCash=F.paydayAllocation(pending.plan,pending.date,{currentPeriodActuals:pending.packet,debts:[]}).essentials.items.find(row=>row.id==='other-spend');
assert.deepEqual([pendingCash.posted,pendingCash.pending,pendingCash.required],[137.26,17.43,295.31],
 'known pending Other consumes category capacity once while its physical cash remains separately protected');
assert.equal(period(pending).householdBudget.find(row=>row.id==='other-spending').spent,154.69,'calendar and cash consume identical eligible posted/pending evidence');
const canonical=require('../data.json'),category=canonical.plan.budget.categories.find(x=>x.id==='other-spend');
assert.equal(category.plannedPayday,450);assert.equal(category.plannedMonthly,null);assert.equal(category.futurePayPeriodReserve,undefined);
assert.equal(category.targetEffectiveFrom,fx.effective);assert.equal(category.targetSource,'owner-stated-2026-10-04');
const published=F.recommend(canonical.plan,fx.asOf,{...canonical.plan.defaults,debts:canonical.debts}).payPeriodViews;
const now=published.find(p=>p.timelineRole==='current');assert.equal(now.start,fx.effective);
assert.equal(now.budgetProgress.household.planned.amount,2275,'900 + 325 + 200 + 150 + 150 + 100 ON-cycle dog food + 450 = 2275');
assert.equal(now.householdBudget.filter(r=>r.id==='other-spending').length,1);
const later=published.find(p=>p.timelineRole==='next');
const laterFuel=canonical.plan.budget.categories.find(row=>row.id==='fuel');
const datedFuel=laterFuel.targetEffectiveFrom && later.start<laterFuel.targetEffectiveFrom
 ? laterFuel.targetHistory.find(row=>later.start<=row.effectiveThrough).plannedPayday : laterFuel.plannedPayday;
assert.equal(later.budgetProgress.household.planned.amount,900+datedFuel+200+150+150+450,
 'next dog-food OFF cycle omits 100; later owner fuel restatements select that period\'s dated input');
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const vm=require('node:vm'),ctx={module:{exports:{}},console};
const forecastSource=fs.readFileSync(path.join(__dirname,'../public/forecast.js'),'utf8');
assert.ok(forecastSource.includes('const Forecast = {'));
vm.runInNewContext(forecastSource.replace('const Forecast = {','globalThis.otherSpanProof = { ownerTargetHoldForSpan, householdBudgetScaled }; const Forecast = {'),ctx);
for(const [start,end,days,expected] of [['2026-09-11','2026-09-24',14,367.97],['2026-09-25','2026-10-08',14,450],
 ['2026-09-01','2026-09-30',30,1080.80],['2026-09-18','2026-10-01',14,633.98]]){
 const plan=fx.build().plan;
 const rows=ctx.otherSpanProof.ownerTargetHoldForSpan(plan,days,start,end);
 assert.equal(rows.find(row=>row.id==='other-spend').planned,expected,'span uses legacy monthly days before Sep 25 plus only authorized whole payday starts');
 const glance=ctx.otherSpanProof.householdBudgetScaled(plan,days,start,end);
 assert.equal(glance.find(row=>row.id==='other-spend'),undefined,'the six-category glance does not invent a second Other row');
}
const before=JSON.parse(execFileSync('git',['show','8ce4e67915e41dbfaee55ad0d2c09ed74b4b4e9c:data.json'],{encoding:'utf8'}));
// The original input-footprint guard belongs to the immutable Other change,
// not every later owner-authorized bill or balance update. Current Other
// behavior/configuration remains covered above by independent fixture cents.
const otherInputRevision=JSON.parse(execFileSync('git',['show','2bf14a2d8e3fc578db8ea14997cff02a945d3c80:data.json'],{encoding:'utf8'}));
const withoutOther=d=>{const copy=fx.clone(d);copy.plan.budget.categories=copy.plan.budget.categories.filter(c=>c.id!=='other-spend');return copy;};
assert.deepEqual(withoutOther(otherInputRevision),withoutOther(before),'the immutable Other input revision changes no other canonical fields, including savings and opening assignments');
const priorCsv=execFileSync('git',['show','8ce4e67915e41dbfaee55ad0d2c09ed74b4b4e9c:docs/positions.csv'],{encoding:'utf8'});
const unchangedRows=s=>s.split(/\r?\n/).filter(line=>!line.includes('Essential spending estimate')&&!line.includes('Weeks of essentials covered'));
assert.deepEqual(unchangedRows(fs.readFileSync(path.join(__dirname,'../docs/positions.csv'),'utf8')),unchangedRows(priorCsv),
 'only the two derived essentials reporting rows may change; no other household evidence is edited');
console.log('PASS owner Other target: below/at/above/zero, exact scope, unchanged recon, original denominator, once-only hold, future and unavailable evidence');
