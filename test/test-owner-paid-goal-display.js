'use strict';
// Owner-confirmed settlement is display proof, never a paid amount/date.
// Invented facts and a production publication exercise the active goal renderer.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const F=require('../public/forecast');
const stub=()=>({innerHTML:'',value:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},
 addEventListener(){},querySelector(){return null},querySelectorAll(){return[]},appendChild(){},replaceChildren(){}});
const context=vm.createContext({Forecast:F,console,setTimeout,clearTimeout,addEventListener(){},
 document:{getElementById:stub,querySelectorAll(){return[]},addEventListener(){},documentElement:{dataset:{},style:{}}},
 localStorage:{getItem(){return null},setItem(){}},location:{pathname:'/',search:''}});
context.window=context;context.matchMedia=()=>({matches:false,addEventListener(){}});
const script=name=>fs.readFileSync(path.join(__dirname,'../public/'+name+'.js'),'utf8');
vm.runInContext(script('app'),context);vm.runInContext('App.boot=()=>{};',context);
for(const name of ['bill-detail','savings-inventory','budget-surface','plan'])vm.runInContext(script(name),context);
// These literal facts exercise presentation, not a second financial calculator.
const row = { saved: 0, savedTrust: 'calculated', stillToFund: 0, stillToFundTrust: 'estimated',
  commitmentCost: { ownerConfirmation: { status: 'full', confirmedOn: '2026-10-12' },
    originalCost: {status:'known',amount:200}, paid:{status:'unknown'}, unpaidCost:{status:'known',amount:0} } };
function render(r) { context.row=r; const before=JSON.stringify(r);
  const html=vm.runInContext('budgetGoalPaidProgressHtml(row)',context);
  assert.equal(JSON.stringify(r),before,'presentation never mutates published money or trust'); return html; }
const full=render(row);
assert.match(full,/data-budget-goal-paid-progress="paid"/);
assert.match(full,/data-budget-goal-original-amount="200"/);
assert.match(full,/data-budget-goal-paid><\/span>/,'no dash or guessed payment amount');
assert.match(full,/Actual amount and date/);
assert.doesNotMatch(full,/≈|planning gap|Estimate:/);
assert.match(full,/Owner-confirmed paid; no further funding needed/);
for (const change of [
  {commitmentCost:{...row.commitmentCost,ownerConfirmation:{status:'partial'}}},
  {commitmentCost:{...row.commitmentCost,unpaidCost:{status:'unknown'}}},
  {commitmentCost:{...row.commitmentCost,ownerConfirmation:null}},
  {stillToFund:50},
]) assert.match(render({...row,...change}),/≈/,'only an established full settlement with published zero loses estimate wording');
for (const change of [{stillToFund:null},{stillToFundTrust:'unknown'}])
 assert.match(render({...row,...change}),/data-budget-goal-still-to-fund><span class="budget-v3-unknown">Unknown/,'settlement does not manufacture a missing figure');
console.log('owner-paid goal display: passed');
// Actual invented observation -> Forecast publication -> goal renderer.
const H=require('./acceptance/harness');
const w=H.baseWorld();
w.commitments=[{id:'trip',label:'Invented trip',date:'2026-11-20',amount:200,
 confidence:'confirmed',sinkingFund:true,settledOn:'2026-10-12'},
 {id:'gift',label:'Invented unpaid goal',date:'2026-12-10',amount:600,confidence:'confirmed',sinkingFund:true}];
w.savingsPool={};
w.transactions=[H.lm({date:'2026-10-09',amount:-1400,category:'Payroll',account:'chequing-a',payee:'Invented employer'})];
const {data,error}=H.dataOf(w); assert.equal(error,null);
const o=data.liveOverlay, advice=F.recommend(data.plan,w.asOf,{debts:data.debts,
 currentPeriodActuals:o.currentPeriodActuals,operatingPlan:o.operatingPlan,observedCash:o.observedCash});
context.ctx={asOf:w.asOf,plan:data.plan,advice,liveOverlay:o};
context.period=advice.payPeriodViews.find(p=>p.timelineRole==='current');
const before=JSON.stringify({data,advice});
const html=vm.runInContext('budgetSavingsGoalsHtml(ctx,period,null)',context);
const goal=html.split('data-budget-savings-goal="commitment:trip"')[1].split('</li>')[0];
assert.match(goal,/\$200\.00<\/span><small>Planned<\/small>/,'retained original cost is planned, never Paid');
assert.match(goal,/data-budget-goal-required-amount="0"/,'remaining need stays zero');
assert.match(goal,/data-budget-goal-paid-progress="paid"/);
assert.doesNotMatch(goal,/≈|planning gap|Estimate:/);
assert.match(goal,/Actual amount and date/);
assert.doesNotMatch(goal,/this period/, 'owner-paid goal has no inapplicable top-up context');
const unpaid=html.split('data-budget-savings-goal="commitment:gift"')[1].split('</li>')[0];
assert.match(unpaid,/this period/, 'unpaid goal retains its published top-up context');
assert.equal(JSON.stringify({data,advice}),before,'full renderer leaves publication unchanged');
console.log('owner-paid goal display: production publication checks passed');
