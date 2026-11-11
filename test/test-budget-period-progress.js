'use strict';
// Independent invented original plans/observations. No production data or
// proposed assignments become contribution evidence.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const F=require('../public/forecast');
const fx=require('./fixtures/budget-surface-data');
const clone=x=>JSON.parse(JSON.stringify(x));
const asOf='2026-08-20',start='2026-08-14',end='2026-08-27';
const observed={observationAsOf:asOf,coverageStart:start,coverageThrough:asOf,
  pendingCoverage:'complete',transactionCoverage:'complete',transactions:[]};
function fixture(){return {start,end,role:'active',timelineRole:'current',
  spendingCycle:{start,end},income:[{id:'pay',date:start,planned:1000,amount:1000,
    actual:-1120,status:'received',settlement:'represented',confidence:'confirmed'}],
  bills:[{id:'paid',date:'2026-08-15',planned:40,amount:40,actual:55,status:'PAID',settlement:'represented',confidence:'confirmed'},
    {id:'next',date:'2026-08-24',planned:70,amount:70,actual:0,status:'still due',settlement:'upcoming',confidence:'confirmed'}],
  householdBudget:[{id:'groceries',planned:120,spent:150,recon:[]},
    {id:'fuel',planned:80,spent:15,recon:[]},{id:'other-spending',planned:null,spent:7,otherSpending:true,recon:[]}],
  totalBillsThisPeriod:125,paidBills:55,budgetHold:237};}
const plan=fx.canonical().plan;
function publish(period=fixture(),packet=observed){return F.budgetPeriodProgress(plan,asOf,period,{currentPeriodActuals:packet});}
const p=publish();
const down=fixture();down.operatingPlanUnavailable=true;
for(const key of ['income','bills','household','savings']){
  assert.equal(publish(down)[key].actual.amount,null,'unavailable plan cannot retain actionable actuals '+key);
  assert.equal(publish(down)[key].planned.amount,null,'unavailable plan cannot retain an actionable original plan '+key);
}
assert.deepEqual([p.income.actual.amount,p.income.planned.amount],[1120,1000]);
assert.deepEqual([p.bills.actual.amount,p.bills.planned.amount],[55,110],'actual 55 must not replace original planned 40');
assert.deepEqual([p.household.actual.amount,p.household.planned.amount],[172,200],'150 + 15 + Other 7; original 120 + 80, never reserve 237');
assert.deepEqual([p.household.delta?.amount,p.household.delta?.magnitude,p.household.delta?.direction],
  [28,28,'left'],'20000 - (15000 + 1500 + 700) = 2800 cents of combined comparison');
for(const [planned,spent,signed,direction] of [[925,247.63,677.37,'left'],[925,925,0,'left'],
  [925,1144.56,-219.56,'over'],[925.99,926,-0.01,'over'],[100,99.01,0.99,'left'],[0,0,0,'left'],[0,0.01,-0.01,'over']]){
  const r=fixture();r.householdBudget=[{id:'invented-total',planned,spent,recon:[]}];
  const before=JSON.stringify(r),delta=publish(r).household.delta;
  assert.deepEqual([delta.amount,delta.magnitude,delta.direction,delta.trust,delta.completeness],
    [signed,Math.abs(signed),direction,'calculated','complete'],'independent exact-cent combined delta');
  assert.equal(Object.is(delta.amount,-0),false);assert.equal(Object.is(delta.magnitude,-0),false);
  assert.equal(JSON.stringify(r),before,'comparison never mutates source totals');
}
for(const [kind,change] of [['estimated-plan',r=>{r.householdBudget[0].plannedTrust='estimated';}],
  ['estimated-actual',r=>{r.householdBudget[0].trust='estimated';}],
  ['pending',r=>{r.householdBudget[0].recon=[{pending:true,amount:150}];}]]){
  const r=fixture();change(r);const delta=publish(r).household.delta;
  assert.equal(delta.trust,'estimated',kind+' cannot promote the difference');assert.equal(delta.amount,28);
}
for(const packet of [{...observed,transactionCoverage:'truncated'},{...observed,pendingCoverage:'unknown'},
  {...observed,transactions:null},{...observed,coverageStart:null}]){
  const delta=publish(fixture(),packet).household.delta;
  assert.deepEqual([delta.amount,delta.magnitude,delta.direction,delta.completeness],[null,null,null,'unavailable'],
    'missing or incomplete evidence cannot supply a precise remaining comparison');
}
assert.equal(p.household.actual.completeness,'complete');
const signedPayments=fixture();signedPayments.bills[0].actual=-12;
assert.equal(publish(signedPayments).bills.actual.amount,-12,'bill reversal never becomes a positive paid amount');
const signedIncome=fixture();signedIncome.income[0].actual=12;
assert.equal(publish(signedIncome).income.actual.amount,12,'positive normalized benefit receipt follows the shared incumbent income selector');
const otherIncome=fixture();otherIncome.income.push({id:'one-off',date:'2026-08-19',planned:25,amount:25,
  actual:35,status:'received',settlement:'represented',otherIncome:true});
assert.deepEqual([publish(otherIncome).income.actual.amount,publish(otherIncome).income.planned.amount],[1155,1025],
  'incumbent Other Income already publishes positive inflow, distinct from raw named-income credits');
otherIncome.income[1].planned=0;
assert.equal(publish(otherIncome).income.planned.amount,1000,'unexpected Other Income cannot inflate the original scheduled denominator');
for(const spent of [0,200,275,-20]){const r=fixture();r.householdBudget=[{id:'groceries',planned:200,spent,recon:[]}];
  const q=publish(r);assert.equal(q.household.actual.amount,spent);assert.equal(q.household.planned.amount,200);}
for(const field of ['planned','actual'])for(const bad of [null,'40',NaN,Infinity,...(field==='planned'?[-1]:[])]){
  const r=fixture();r.bills[0][field]=bad;const q=publish(r);
  if(field==='planned')assert.equal(q.bills.planned.amount,null);
  else {assert.equal(q.bills.actual.completeness,'partial');assert.equal(q.bills.actual.amount,0);}
}
const absent=fixture();delete absent.bills[0].planned;
assert.equal(publish(absent).bills.planned.amount,110,'only absent legacy plan follows amount');
for(const trust of [null,'unknown','unavailable','untrusted'])for(const key of ['plannedTrust','actualTrust']){
  const r=fixture();r.bills[0][key]=trust;const q=publish(r);
  assert.equal(key==='plannedTrust'?q.bills.planned.amount:q.bills.actual.completeness,key==='plannedTrust'?null:'partial');
}
for(const trust of [null,'unknown','unavailable','untrusted']){
  const r=fixture();r.householdBudget[0].trust=trust;
  assert.equal(publish(r).household.actual.amount,null);assert.equal(publish(r).household.planned.amount,null);
}
for(const mode of ['missing','partial','truncated','posted-only','no-start','no-transactions','missing-date','missing-amount','no-observation-date','future-observation','future-coverage','currency-unconfirmed']){
  let packet=clone(observed);
  if(mode==='missing')packet=null;
  if(mode==='partial')packet.coverageStart='2026-08-19';
  if(mode==='truncated')packet.transactionCoverage='truncated';
  if(mode==='posted-only')packet.pendingCoverage='partial';
  if(mode==='no-start')delete packet.coverageStart;
  if(mode==='no-transactions')delete packet.transactions;
  if(mode==='missing-date')packet.transactions=[{amount:5}];
  if(mode==='missing-amount')packet.transactions=[{date:start,amount:null}];
  if(mode==='no-observation-date')packet.observationAsOf=null;
  if(mode==='future-observation')packet.observationAsOf='2026-08-21';
  if(mode==='future-coverage')packet.coverageThrough='2026-08-21';
  if(mode==='currency-unconfirmed')packet.currencyUnconfirmed=[{id:'invented-currency'}];
  const q=publish(fixture(),packet);
  assert.equal(q.household.actual.completeness,mode==='posted-only'?'partial':'unavailable',mode);
  assert.equal(q.income.planned.amount,1000,'missing actuals cannot erase original plan');
}
for(const state of ['pending','unverified','unknown','not-relied-upon']){
  const r=fixture();r.bills[0].settlement=state;
  assert.equal(publish(r).bills.actual.completeness,'partial','contradictory paid/'+state);
}
const pending=fixture();pending.householdBudget[0].recon=[{pending:true,amount:150}];
assert.equal(publish(pending).household.actual.trust,'estimated');
assert.equal(publish(pending).household.actual.includesPending,true);
const future=fixture();Object.assign(future,{start:'2026-08-28',end:'2026-09-10',role:'future',projected:true,timelineRole:'next'});
for(const key of ['income','bills','household','savings'])assert.equal(publish(future)[key].actual.amount,null,'future '+key);
const past=fixture();Object.assign(past,{start:'2026-07-31',end:'2026-08-13',role:'lookback',timelineRole:'past',
  spendingCycle:{start:'2026-07-31',end:'2026-08-13'},income:[],bills:[]});
assert.equal(publish(past).household.actual.amount,null,'current-only coverage does not prove history');
const oldPacket={...observed,coverageStart:'2026-07-31',coverageThrough:asOf};
assert.equal(publish(past,oldPacket).household.actual.amount,172,'exact historical coverage');
assert.equal(publish(past,oldPacket).household.planned.amount,null,'current category targets do not prove a historical original plan');
const revisedPast=clone(past);revisedPast.householdBudget[0].planned=613.27;
assert.equal(publish(revisedPast,oldPacket).household.planned.amount,null,'a later target edit cannot rewrite a completed period denominator');
assert.equal(publish(revisedPast,oldPacket).household.actual.amount,172,'target edits do not change the observed historical numerator');
const earlyPaid=fixture();Object.assign(earlyPaid.bills[1],{actual:70,status:'PAID',settlement:'represented'});
assert.equal(publish(earlyPaid).bills.actual.amount,55+70,'confirmed early payment counts in its selected-period occurrence before the scheduled due date');
assert.equal(publish(earlyPaid).bills.planned.amount,40+70,'early actual never replaces the original denominator');
for(const contradiction of ['pending','unverified','unknown','not-relied-upon']){
  const badEarly=clone(earlyPaid);badEarly.bills[1].settlement=contradiction;
  assert.equal(publish(badEarly).bills.actual.amount,55,'early '+contradiction+' cannot become confirmed paid');
  assert.equal(publish(badEarly).bills.actual.completeness,'partial');
}
const unknownEarly=clone(earlyPaid);unknownEarly.bills[1].actual=null;
assert.equal(publish(unknownEarly).bills.actual.amount,55,'unknown early actual never falls back to its scheduled amount');
unknownEarly.bills[1].actual=70;unknownEarly.bills[1].actualTrust=null;
assert.equal(publish(unknownEarly).bills.actual.amount,55,'invalid early-payment trust stays withheld');
const futurePaid=clone(earlyPaid);Object.assign(futurePaid,{start:'2026-08-28',end:'2026-09-10',projected:true,timelineRole:'next'});
assert.equal(publish(futurePaid).bills.actual.amount,null,'future-period projections cannot become actuals even with paid-shaped input');
const changedCycle=fixture();changedCycle.spendingCycle.start='2026-08-15';
assert.equal(publish(changedCycle).household.actual.amount,null,'mismatched category cycle is not selected period');
for(const amount of [0,9999]){
  const r=fixture();r.plannedCostFunding={status:'ready',basis:'selected-Budget-period',asOf,start,end,trust:'calculated',
    contribution:amount,actualSaved:amount,originalPaydayPlan:null,items:[{id:'school-trip',label:'School trip',contribution:amount,actualSaved:amount,cumulativeProposed:amount,remainingGap:0}]};
  const q=publish(r);const g=q.savings.goals.find(g=>g.id==='school-trip');
  assert.equal(g.status,'not-confirmed');assert.equal(g.required.amount,null);assert.equal(g.fulfilled.amount,null);
  assert.equal(g.remaining.amount,null);assert.equal(g.proposal.amount,amount);
  assert.equal(q.savings.actual.amount,null);assert.equal(q.savings.planned.amount,null);
}
const goalPlan=clone(future);
goalPlan.plannedCostFunding={source:'Forecast.planSpendPaydayFunding',status:'ready',basis:'selected-Budget-period',
  asOf,start:goalPlan.start,end:goalPlan.end,trust:'calculated',contribution:105,minimumRequiredContribution:105,
  minimumRequiredAttribution:'complete',items:[
    {id:'school-trip',label:'School trip',contribution:40,minimumRequiredContribution:40},
    {id:'winter-tires',label:'Winter tires',contribution:65,minimumRequiredContribution:65}]};
const requirement=publish(goalPlan);
assert.equal(requirement.savings.planned.amount,105,'current Forecast minimum-now requirement, 40 + 65');
assert.deepEqual(requirement.savings.goals.map(g=>g.required.amount),[40,65]);
assert.ok(requirement.savings.goals.every(g=>g.status==='not-confirmed'&&g.fulfilled.amount===null&&g.remaining.amount===null));
assert.equal(requirement.savings.planned.basis,'current-Forecast-minimum-now','never an original payday snapshot');
for(const bad of [null,-1,'40',NaN,Infinity]){const r=clone(goalPlan);r.plannedCostFunding.items[0].minimumRequiredContribution=bad;
  assert.equal(publish(r).savings.planned.amount,null,'unsupported requirement attribution withholds the aggregate');}
for(const field of ['asOf','start','end','trust','minimumRequiredAttribution']){const r=clone(goalPlan);r.plannedCostFunding[field]=null;
  assert.equal(publish(r).savings.planned.amount,null,'strict requirement scope/trust '+field);}
const gap=clone(goalPlan);gap.plannedCostFunding.contribution=80;gap.plannedCostFunding.minimumRequiredAttribution='unavailable';
assert.equal(publish(gap).savings.planned.amount,null,'insufficient attributed proposal is not the full requirement');
const currentRequirement=fixture();currentRequirement.plannedCostFunding={...goalPlan.plannedCostFunding,start,end};
assert.equal(publish(currentRequirement).savings.planned.amount,null,'no mid-period reconstruction of original contribution plan');
// Second method for the real serial allocator publication: a $600 cost due
// next period, whose 1000 - 200 - 150 - 300 capacity is $350, needs $250 now.
const fundingFixture=require('./fixtures/budget-funding-data')();
const fundingBefore=JSON.stringify(fundingFixture);
const fundingAdvice=F.recommend(fundingFixture.plan,fundingFixture.meta.asOf,{});
for(const [date,amount] of [['2026-08-14',600-350],['2026-08-28',350]]){
  const period=fundingAdvice.payPeriodViews.find(p=>p.start===date);
  assert.equal(period.budgetProgress.savings.planned.amount,amount);
  assert.equal(period.budgetProgress.savings.goals[0].required.amount,amount);
  assert.equal(period.budgetProgress.savings.goals[0].fulfilled.amount,null);
  assert.equal(period.budgetProgress.savings.goals[0].remaining.amount,null);
  assert.equal(period.budgetProgress.savings.goals[0].status,'not-confirmed');
}
assert.equal(JSON.stringify(fundingFixture),fundingBefore,'requirement disclosure does not change any baseline input');
// Actual observation -> incumbent Forecast -> attached publication, with
// independently reconciled deductions unchanged.
const served=fx.served(),before=JSON.stringify(served);
const advice=F.recommend(served.plan,asOf,{...served.plan.defaults,debts:served.debts,
  currentPeriodActuals:served.liveOverlay.currentPeriodActuals});
const current=advice.payPeriodViews.find(r=>r.timelineRole==='current');
assert.deepEqual([current.incomeTotal,current.periodBillLoad,current.budgetHold,current.afterBills,current.balanceAfterDeductions],
  [4050,1665,752.99,2385,1632.01]);
assert.deepEqual([current.budgetProgress.income.actual.amount,current.budgetProgress.bills.actual.amount,
  current.budgetProgress.household.actual.amount,current.budgetProgress.household.planned.amount],[2600,1400,444.49,730]);
assert.equal(current.budgetProgress.bills.actual.completeness,'partial');
assert.equal(JSON.stringify(served),before,'publication never mutates inputs or assignments');
// Exact current-main control: removing only the added disclosures must leave
// every existing financial publication identical, not just the displayed pair.
const Module=require('node:module');
const baselineModule=new Module(path.join(__dirname,'../public/forecast-before-household-delta.js'));
baselineModule.filename=baselineModule.id;baselineModule.paths=Module._nodeModulePaths(path.dirname(baselineModule.filename));
baselineModule._compile(require('node:child_process').execFileSync('git',
  ['show','c1d8c155552d87bc93aa0425147f1a00570146a9:public/forecast.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),baselineModule.filename);
let etransferPublications=0;
const withoutDelta=value=>{
  if(value&&typeof value==='object'){
    assert(!Object.hasOwn(value,'paydaySweep'),'every S1 paydaySweep publication was validated and excluded by stripS1Sweep');
    if(value.source==='Forecast.budgetPeriodProgress'&&value.household)delete value.household.delta;
    // Authorized change (a past period never turns unknown into $0): a completed
    // period whose spending the observation cannot prove stamps its placeholder
    // household hold Unavailable. Validate it concretely (a completed period,
    // a published hold, no other value touched) before restoring the frozen
    // engine's null for this comparison.
    if(value.budgetHoldTrust==='unavailable'&&Object.hasOwn(value,'budgetHold')){
      assert.equal(value.timelineRole,'past','only a completed period carries the unproven-hold stamp');
      assert(typeof value.budgetHold==='number','the stamped hold is a placeholder number, never removed');
      assert(value.householdBudget.every(row=>row.spent===null),'every category row of that period is unknown');
      value.budgetHoldTrust=null;
    }
    // Authorized change (same rule, for Other income): a completed period the
    // observation cannot cover publishes Other income as unobserved, never a
    // $0 sum of nothing. Validate it concretely (a completed period, a null
    // amount, and in these fixtures no observed credit before the window),
    // then restore the frozen engine's 0 for this comparison.
    if(value.otherIncome&&typeof value.otherIncome==='object'&&value.otherIncome.unavailable===true){
      assert.equal(value.timelineRole,'past','only a completed period carries the unobserved Other income stamp');
      assert.equal(value.otherIncome.amount,null,'unobserved Other income is null, never 0');
      assert.deepEqual(value.otherIncome.items,[],'these fixtures hold no credit before the fetch window');
      value.otherIncome={amount:0,items:[]};
    }
    if(value.outgoingETransfers){
      // Authorized addition (outgoing e-transfer review list): validate the
      // typed publication concretely before excluding it from this frozen
      // comparison — unavailable states carry no list and no count, never
      // zero; an available count is exactly its observed items length.
      const pub=value.outgoingETransfers;
      assert(pub&&typeof pub==='object','the added publication is present');
      assert(['available-complete','available-posted-only','available-incomplete','unavailable-stale','unavailable-missing'].includes(pub.status),
        'typed outgoing e-transfer publication state');
      if(pub.status.startsWith('unavailable')){assert.equal(pub.count,null);assert.equal(pub.items,null);}
      else assert.equal(pub.count,pub.items.length,'available count is its observed items length');
      etransferPublications++;
      delete value.outgoingETransfers;
    }
    Object.values(value).forEach(withoutDelta);
  }
  return value;
};
// S1 supersession: the current engine also publishes paydaySweep on every
// period, and a future opening is the frozen-chain opening minus the
// sweeps that landed before it. Validate each sweep against the frozen
// baseline directly — opening (and the opening-derived balances) plus the
// cumulative prior sweeps must reproduce the baseline figure to the cent —
// then exclude only the new field; every other value must still agree
// exactly with exact main.
const stripS1Sweep=(current,baseline)=>{
  const cents=v=>Math.round(v*100)/100;
  let validated=0,numeric=0;
  const chain=(nowColl,oldColl)=>{
    assert.equal(nowColl.length,oldColl.length,'period count unchanged');
    let swept=0;
    nowColl.forEach((period,index)=>{
      const old=oldColl[index];
      assert.equal(period.start,old.start,'period identity unchanged');
      assert(Object.hasOwn(period,'paydaySweep'),'every period publishes the S1 sweep field');
      const sweep=period.paydaySweep;
      assert(sweep===null||(typeof sweep==='number'&&Number.isFinite(sweep)&&sweep>=0
        &&Math.abs(sweep*100-Math.round(sweep*100))<1e-6),
        'S1 paydaySweep is null or a non-negative cent-exact amount');
      for(const field of ['opening','currentBalance']){
        if(typeof period[field]==='number'&&typeof old[field]==='number'){
          assert.equal(cents(period[field]+swept),cents(old[field]),
            'S1 chain identity: ' + field + ' plus cumulative prior sweeps reproduces the frozen baseline');
          period[field]=old[field];
        }
      }
      if(period.leftover&&old.leftover&&typeof period.leftover.currentBalance==='number'
        &&typeof old.leftover.currentBalance==='number'){
        assert.equal(cents(period.leftover.currentBalance+swept),cents(old.leftover.currentBalance),
          'S1 chain identity: leftover balance plus cumulative prior sweeps reproduces the frozen baseline');
        period.leftover.currentBalance=old.leftover.currentBalance;
      }
      if(sweep!==null){assert.equal(typeof period.opening,'number','a known sweep requires a known opening');numeric++;}
      delete period.paydaySweep;
      if(typeof sweep==='number')swept=cents(swept+sweep);
      validated++;
    });
  };
  chain(current.payPeriodViews,baseline.payPeriodViews);
  chain(current.defaultView.calendarPeriods,baseline.defaultView.calendarPeriods);
  for(const period of current.pastPeriodViews){
    assert(Object.hasOwn(period,'paydaySweep'),'every period publishes the S1 sweep field');
    assert.equal(period.paydaySweep,null,'past periods never carry a payday sweep');
    delete period.paydaySweep; validated++;
  }
  assert(validated>0&&numeric>0,'S1 sweeps were concretely validated in this control');
  // PA-4 authorized addition (adopted packet #787 6526949494): validate each
  // opening-inclusive planned close against its own published terms, then
  // exclude only those four fields from the frozen comparison.
  let pa4=0;
  for(const period of [...current.payPeriodViews,...current.defaultView.calendarPeriods,...current.pastPeriodViews]){
    assert(Object.hasOwn(period,'plannedPeriodClose'),'every period publishes the PA-4 planned close field');
    const t=period.plannedPeriodCloseTerms;
    if(period.plannedPeriodClose===null){
      assert.equal(period.plannedPeriodCloseTrust,'unknown');assert.equal(t,null);
    }else{
      assert.equal(cents(period.plannedPeriodClose),cents(t.opening+t.incomeAdded-t.periodBillLoad-t.budgetHold-t.annualSavingsNeed),
        'PA-4 planned close reconciles to its published terms');
    }
    for(const key of ['plannedPeriodClose','plannedPeriodCloseTrust','plannedPeriodCloseTerms','plannedPeriodCloseReason'])delete period[key];
    pa4++;
  }
  assert(pa4>0,'PA-4 planned closes were concretely validated in this control');
};
const totalFixture=require('./fixtures/other-period-target');
for(const [spent,opts] of [[137.26,{}],[618.73,{}],[1034.19,{}],[814.63,{}],
  [137.26,{pendingOther:17.43}],[137.26,{pendingCoverage:'unknown'}]]){
  const x=totalFixture.build(spent,totalFixture.asOf,opts),input=JSON.stringify(x);
  const args={debts:[],currentPeriodActuals:x.packet};
  const currentAdvice=clone(F.recommend(x.plan,x.date,args));
  const baselineAdvice=baselineModule.exports.recommend(x.plan,x.date,args);
  stripS1Sweep(currentAdvice,baselineAdvice);
  assert.deepEqual(withoutDelta(currentAdvice),baselineAdvice,
    'all pre-existing recommendation values/qualifications agree with exact main');
  assert.equal(JSON.stringify(x),input);
}
assert.equal(etransferPublications,6,'the added outgoing e-transfer publication was concretely checked once per frozen comparison');
for(const r of advice.payPeriodViews.filter(r=>['next','future'].includes(r.timelineRole)))
  for(const k of ['income','bills','household','savings'])assert.equal(r.budgetProgress[k].actual.amount,null);
// Active presenter consumes new publications, not old total/reserve fields.
const stub=()=>({innerHTML:'',value:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},
  addEventListener(){},querySelector(){return null},querySelectorAll(){return[]},appendChild(){},replaceChildren(){}});
const context=vm.createContext({Forecast:F,console,setTimeout,clearTimeout,addEventListener(){},
  document:{getElementById:stub,querySelectorAll(){return[]},addEventListener(){},documentElement:{dataset:{},style:{}}},
  localStorage:{getItem(){return null},setItem(){}},location:{pathname:'/',search:''}});
context.window=context;context.matchMedia=()=>({matches:false,addEventListener(){}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
vm.runInContext('App.boot=()=>{};',context);
for(const script of ['bill-detail','savings-inventory','budget-surface','plan'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/'+script+'.js'),'utf8'),context);
context.progressPeriod=current;context.progressCtx={asOf,advice,plan:served.plan};
const primary=vm.runInContext('calendarWaterfallHtml(progressPeriod,null,null,progressCtx.plan,true)',context);
assert.match(primary,/data-budget-ratio="income"[\s\S]*?2,600\.00[\s\S]*?4,050\.00/);
assert.match(primary,/data-budget-ratio="household"[\s\S]*?444\.49[\s\S]*?730\.00/);
assert.match(primary,/data-budget-ratio="bills"[\s\S]*?1,400\.00[\s\S]*?1,665\.00[\s\S]*?partial evidence/);
assert.match(primary,/data-budget-goal-fulfillment-evidence="school-trip"/);
const primaryIncome=primary.split('data-operating-question="02"')[1].split('</summary>')[0];
assert.ok(primaryIncome.includes('width:'+2600/4050*100+'%'));
const spending=vm.runInContext('budgetSpendingSectionHtml(progressPeriod,progressCtx)',context);
assert.match(spending,/data-budget-browse-hold[\s\S]*?444\.49[\s\S]*?730\.00/);
assert.match(spending,/data-budget-household-delta hidden data-budget-delta-amount="285\.51" data-budget-delta-direction="left"/,
  'browse stamps the exact published difference magnitude; the painter alone changes display precision');
const householdBefore=clone(current.budgetProgress.household);delete householdBefore.delta;
context.beforeDelta=householdBefore;context.afterDelta=current.budgetProgress.household;
assert.equal(vm.runInContext("budgetProgressEvidenceHtml(beforeDelta,'household')",context),
  vm.runInContext("budgetProgressEvidenceHtml(afterDelta,'household')",context),'native household sheet is byte-identical');
for(const [delta,known] of [[p.household.delta,true],[publish(pending).household.delta,true],
  [publish(fixture(),{...observed,pendingCoverage:'unknown'}).household.delta,false]]){
  context.delta=delta;const html=vm.runInContext('budgetHouseholdDeltaHtml(delta)',context);
  assert.equal(html.includes('data-budget-delta-amount='),known,'only qualified comparison amounts are stamped');
  if(!known)assert.match(html,/Remaining unavailable/);
  else if(delta.trust==='estimated')assert.match(html,/estimated/,'estimated comparison preserves accessible qualifier');
}
const bills=vm.runInContext('budgetBillsSectionHtml(progressPeriod,progressCtx)',context);
assert.match(bills,/data-budget-ratio="bills"[\s\S]*?1,400\.00[\s\S]*?1,665\.00/);
assert.match(bills,/data-budget-progress-kind="bills"/);
assert.match(bills,/data-budget-progress-kind="bills"[^>]*aria-hidden="true"><\/span>/,'partial paid evidence has no progress fill');
const goals=vm.runInContext('budgetSavingsGoalsHtml(progressCtx,progressPeriod,null)',context);
assert.match(goals,/School trip/);assert.match(goals,/Saved[\s\S]*Needed[\s\S]*Unavailable/);assert.doesNotMatch(goals,/>Funded<|>Still to fund</);
// Actual incumbent Forecast -> active savings renderer, with a second-method
// reconciliation from independently invented salary/bills/category/goal rows.
const contributionData=require('./fixtures/savings-contribution-display-data')();
const undatedContribution=F.recommend(contributionData.plan,contributionData.meta.asOf,{});
assert.equal(undatedContribution.sim.scheduledAmounts.status,'unavailable');
assert.equal(undatedContribution.payPeriodViews.find(row=>row.timelineRole==='current').plannedCostFunding.contribution,null);
assert.equal(contributionData.plan.commitments.find(row=>row.id==='reading-nook').amount,410);
// Separate invented dated control preserves the independently reconciled garden requirement.
contributionData.plan.commitments.find(row=>row.id==='reading-nook').date='2027-08-13';
const contributionBefore=JSON.stringify(contributionData);
const contributionAdvice=F.recommend(contributionData.plan,contributionData.meta.asOf,{});
const contributionPublicationBefore=JSON.stringify(contributionAdvice);
for(const [date,amount] of [['2026-08-14',875 - (1300 - 240 - 160 - 310)],['2026-08-28',590]]) {
  context.contributionPeriod=contributionAdvice.payPeriodViews.find(row=>row.start===date);
  context.contributionCtx={asOf:contributionData.meta.asOf,advice:contributionAdvice,plan:contributionData.plan};
  assert.equal(context.contributionPeriod.budgetProgress.savings.goals.find(row=>row.id==='garden-course').required.amount,amount);
  const html=vm.runInContext('budgetSavingsGoalsHtml(contributionCtx,contributionPeriod,null)',context);
  if(context.contributionPeriod.timelineRole==='current') {
    assert.match(html,/Saved[\s\S]*Needed[\s\S]*Unavailable/,'daily policy before confirmation cannot borrow legacy requirement or saved amounts');
    assert.doesNotMatch(html,/data-budget-goal-fulfilled|data-budget-goal-required/);
    const retained=vm.runInContext("budgetProgressEvidenceHtml(contributionPeriod.budgetProgress.savings,'savings')",context);
    assert.match(retained,new RegExp('Required this period:[\\s\\S]*?'+amount.toFixed(2).replace('.','\\.')),'native independently reconciled requirement remains in evidence');
    assert.match(retained,/Confirmed fulfilled this period: Unavailable/);
  } else {
    assert.match(html,/data-budget-goal-fulfilled><span class="budget-v3-unknown">Unknown/);
    assert.match(html,new RegExp('data-budget-goal-required>[\\s\\S]*?'+amount.toFixed(2).replace('.','\\.')));
    assert.match(html,/Fulfilled[\s\S]*Required this period[\s\S]*Required/);
    assert.doesNotMatch(html,/Current Forecast requirement/);
  }
  assert.match(html,/Reading nook with a deliberately long goal name/);
  assert.doesNotMatch(html,/>Funded<|>Still to fund<|type="checkbox"|original planned|width:/);
}
assert.equal(JSON.stringify(contributionData),contributionBefore);
assert.equal(JSON.stringify(contributionAdvice),contributionPublicationBefore,'presentation does not mutate any publication');
// Explicitly sealed presenter-only future probes. The current engine does
// NOT publish confirmed goal fulfillment; these are not attribution evidence.
const sealedField=amount=>({amount,trust:'calculated',completeness:'complete'});
function probe(goal,publication={}) {
  context.goalProbe=clone(context.contributionPeriod);
  context.goalProbe.budgetProgress={...context.goalProbe.budgetProgress,...publication,
    savings:{goals:[goal]}};
  return vm.runInContext('budgetSavingsGoalsHtml(contributionCtx,goalProbe,null)',context);
}
const sealedGoal={id:'presenter-only',label:'Sealed presentation probe',required:sealedField(71.25),
  fulfilled:sealedField(31.25),remaining:sealedField(40),status:'still-to-fund',reason:'Invented sealed presenter-only evidence.'};
for(const [status,fulfilled,remaining] of [['still-to-fund',31.25,40],['funded',71.25,0],['funded',0,0]]) {
  const goal={...sealedGoal,status,required:sealedField(status==='funded'&&fulfilled===0?0:71.25),fulfilled:sealedField(fulfilled),remaining:sealedField(remaining)};
  const html=probe(goal);
  assert.match(html,new RegExp('is-'+status));
  assert.match(html,new RegExp('data-budget-goal-fulfilled>[\\s\\S]*?'+fulfilled.toFixed(2).replace('.','\\.')));
  context.goalEvidencePair={goals:[goal]};
  const detail=vm.runInContext("budgetProgressEvidenceHtml(goalEvidencePair,'savings')",context);
  assert.doesNotMatch(detail,/Not confirmed\./);
  assert.match(detail,new RegExp('Remaining this period:[\\s\\S]*?'+remaining.toFixed(2).replace('.','\\.')));
}
for(const key of ['required','fulfilled','remaining'])for(const bad of [null,'71.25',NaN,Infinity,...(key==='remaining'?[]:[-1])]) {
  const goal={...sealedGoal,[key]:sealedField(bad)};
  assert.doesNotMatch(probe(goal),/is-funded|is-still-to-fund/);
}
for(const key of ['required','fulfilled','remaining'])for(const completeness of ['partial','proposal','unavailable']) {
  assert.doesNotMatch(probe({...sealedGoal,[key]:{...sealedGoal[key],completeness}}),/is-funded|is-still-to-fund/);
}
for(const key of ['required','fulfilled','remaining'])for(const trust of [null,'unknown','unavailable','verified']) {
  assert.doesNotMatch(probe({...sealedGoal,[key]:{...sealedGoal[key],trust}}),/is-funded|is-still-to-fund/);
}
for(const status of ['not-confirmed','pending','unknown',null])assert.doesNotMatch(probe({...sealedGoal,status}),/is-funded|is-still-to-fund/);
for(const publication of [{asOf:'2026-08-15'},{start:'2026-08-29'},{end:'2026-09-11'},
  {currency:'USD'},{source:'Presentation'}, {asOf:'2026-02-30'}]) {
  const html=probe({...sealedGoal,status:'funded'},publication);
  assert.doesNotMatch(html,/is-funded|is-still-to-fund|71\.25|31\.25/,'out-of-scope publications are withheld');
}
const proposalOnly={...sealedGoal,status:'not-confirmed',required:null,fulfilled:null,remaining:null,
  proposal:{amount:29.75,trust:'estimated',completeness:'proposal'}};
assert.match(probe(proposalOnly),/29\.75[\s\S]*proposed; requirement unavailable/);
assert.match(probe(proposalOnly),/data-budget-goal-required><span class="budget-v3-unknown">Unknown/);
assert.match(probe({...proposalOnly,proposal:{...proposalOnly.proposal,amount:-1}}),/Required contribution unavailable/);
const mixedGoal={...sealedGoal,status:'not-confirmed',
  required:{amount:null,trust:'unavailable',completeness:'unavailable',reason:'Invented missing required evidence.'},
  remaining:{amount:null,trust:'unavailable',completeness:'unavailable',reason:'Invented missing remaining evidence.'}};
const mixedHtml=probe(mixedGoal);
assert.match(mixedHtml,/data-budget-goal-fulfilled>[\s\S]*?31\.25/,'known fulfilled survives unknown requirement');
assert.match(mixedHtml,/data-budget-goal-required><span class="budget-v3-unknown">Unknown/);
assert.doesNotMatch(mixedHtml,/is-funded|is-still-to-fund/);
context.goalEvidencePair={goals:[mixedGoal]};
const mixedDetail=vm.runInContext("budgetProgressEvidenceHtml(goalEvidencePair,'savings')",context);
assert.match(mixedDetail,/Required this period: Unavailable[\s\S]*Invented missing required evidence/);
assert.match(mixedDetail,/Confirmed fulfilled this period:[\s\S]*31\.25/);
assert.match(mixedDetail,/Remaining this period: Unavailable[\s\S]*Invented missing remaining evidence/);
const signedRemaining={...sealedGoal,remaining:sealedField(-8.75)};
assert.match(probe(signedRemaining),/[\u2212-]\$8\.75[\s\S]*remaining/,'signed published remainder is not silently clamped');
context.goalEvidencePair={goals:[signedRemaining]};
assert.match(vm.runInContext("budgetProgressEvidenceHtml(goalEvidencePair,'savings')",context),/Remaining this period:[\s\S]*?[\u2212-]\$8\.75/);
for(const [key,label] of [['required','Required'],['fulfilled','Confirmed fulfilled'],['remaining','Remaining']]) {
  const partialGoal={...sealedGoal,[key]:{...sealedGoal[key],completeness:'partial',reason:'Invented partial '+key+' evidence.'}};
  assert.doesNotMatch(probe(partialGoal),/is-funded|is-still-to-fund/);
  context.goalEvidencePair={goals:[partialGoal]};
  const detail=vm.runInContext("budgetProgressEvidenceHtml(goalEvidencePair,'savings')",context);
  assert.match(detail,new RegExp(label+' this period:[\\s\\S]*?'+partialGoal[key].amount.toFixed(2).replace('.','\\.')+'[\\s\\S]*?- partial evidence[\\s\\S]*?Invented partial '+key+' evidence'));
}
// Active Forecast plus active renderer: old target 450 is revised to an
// independently invented 613.27 today, with no dated original-plan snapshot.
const historicalData=fx.fundingHistorical('full','paid'),historicalBefore=JSON.stringify(historicalData);
const historicalAdvice=F.recommend(historicalData.plan,asOf,{...historicalData.plan.defaults,debts:historicalData.debts,
  currentPeriodActuals:historicalData.liveOverlay.currentPeriodActuals});
const revisedData=clone(historicalData);revisedData.plan.budget.categories.find(r=>r.id==='groceries').plannedPayday=613.27;
const revisedBefore=JSON.stringify(revisedData);
const revisedAdvice=F.recommend(revisedData.plan,asOf,{...revisedData.plan.defaults,debts:revisedData.debts,
  currentPeriodActuals:revisedData.liveOverlay.currentPeriodActuals});
for(const [data,published] of [[historicalData,historicalAdvice],[revisedData,revisedAdvice]]){
  const sealedPublication=JSON.stringify(published);
  const history=published.payPeriodViews.find(r=>r.start==='2026-07-31');
  assert.equal(history.budgetProgress.household.actual.amount,47.25+19.50);
  assert.equal(history.budgetProgress.household.planned.amount,null);
  context.historyPeriod=history;context.historyCtx={asOf,advice:published,plan:data.plan};
  const historyHtml=vm.runInContext('budgetSpendingSectionHtml(historyPeriod,historyCtx)',context);
  assert.match(historyHtml,/data-budget-ratio-actual[\s\S]*?66\.75/);
  assert.match(historyHtml,/data-budget-ratio-plan><span class="budget-v3-unknown">Unknown/);
  assert.doesNotMatch(historyHtml,/\$450\.00|\$613\.27|budget-category-fill|budget-category-pace|\$402\.75 left|\$566\.02 left/,
    'current targets, remaining estimates and target-based geometry do not pose as historical original plans');
  const nativeHistory=vm.runInContext('calendarBudgetHtml(historyPeriod)',context);
  assert.match(nativeHistory,/data-budget-historical-original-plan="unavailable"/);
  assert.match(nativeHistory,/Historical original plan unavailable/);
  assert.doesNotMatch(nativeHistory,/<dt>Planned<|<dt>Remaining<|\$450\.00|\$613\.27|\/week/,
    'full native evidence and its movable individual nodes do not print current targets as historical plans');
  assert.match(nativeHistory,/Synthetic historical grocer[\s\S]*?47\.25/);
  assert.match(nativeHistory,/Synthetic historical fuel[\s\S]*?19\.50/);
  context.categoryProbe={...history.householdBudget.find(r=>r.id==='groceries'),remaining:566.02,overspend:42,plannedWeekly:306.64,projected:true};
  const categoryEvidence=vm.runInContext('householdBudgetCategoryHtml(categoryProbe,{historicalOriginalPlanUnavailable:true})',context);
  assert.doesNotMatch(categoryEvidence,/<dt>Planned<|<dt>Remaining<|613\.27|450\.00|566\.02|306\.64|Projected\./);
  assert.match(categoryEvidence,/Historical original plan unavailable[\s\S]*Synthetic historical grocer[\s\S]*47\.25/);
  context.attentionProbe={...history,householdBudget:[context.categoryProbe]};
  assert.equal(vm.runInContext('budgetBrowseAttentionHtml(attentionProbe)',context),'',
    'historical current-target overrun does not become an over-plan attention claim');
  assert.equal(JSON.stringify(published),sealedPublication,'context-specific native presentation preserves sealed Forecast publications');
}
const currentNative=vm.runInContext('calendarBudgetHtml(progressPeriod)',context);
assert.match(currentNative,/<dt>Planned<\/dt>[\s\S]*?450\.00/,'current authored targets retain native evidence');
assert.doesNotMatch(currentNative,/data-budget-historical-original-plan/);
assert.equal(JSON.stringify(historicalData),historicalBefore);assert.equal(JSON.stringify(revisedData),revisedBefore);
const realEarly=fx.served({earlyInternet:true}),realEarlyBefore=JSON.stringify(realEarly);
const earlyAdvice=F.recommend(realEarly.plan,asOf,{...realEarly.plan.defaults,debts:realEarly.debts,
  currentPeriodActuals:realEarly.liveOverlay.currentPeriodActuals});
const earlyPeriod=earlyAdvice.payPeriodViews.find(r=>r.timelineRole==='current');
assert.equal(earlyPeriod.bills.find(r=>r.id==='internet').settlement,'represented','typed receipt earns native occurrence settlement');
assert.equal(earlyPeriod.bills.find(r=>r.id==='internet').date,'2026-08-24','scheduled occurrence remains after as-of');
assert.equal(earlyPeriod.budgetProgress.bills.actual.amount,1400+85);
assert.equal(earlyPeriod.budgetProgress.bills.planned.amount,1400+120+60+85);
assert.equal(earlyPeriod.paidBills,1400+85,'shared native paid authority agrees');
context.earlyPeriod=earlyPeriod;context.earlyCtx={asOf,advice:earlyAdvice,plan:realEarly.plan};
assert.match(vm.runInContext('budgetBillsSectionHtml(earlyPeriod,earlyCtx)',context),
  /data-budget-ratio="bills"[\s\S]*?1,485\.00[\s\S]*?1,665\.00/);
assert.equal(JSON.stringify(realEarly),realEarlyBefore);
current.budgetProgress.household.actual.trust=null;
assert.match(vm.runInContext('budgetSpendingSectionHtml(progressPeriod,progressCtx)',context),/data-budget-ratio-actual><span class="budget-v3-unknown">Unknown/);
current.budgetProgress.asOf='2026-08-19';
assert.equal(vm.runInContext('budgetProgressFor(progressPeriod,progressCtx.asOf)',context),null,'stale publication cannot be reused');
current.budgetProgress.asOf=asOf;
assert.equal(vm.runInContext('budgetProgressFor(progressPeriod,null)',context),null,'explicit missing consumer as-of cannot use the fallback');
assert.equal(vm.runInContext('budgetProgressFor(progressPeriod)',context),current.budgetProgress,'absent consumer argument follows the publisher stamp');
current.budgetProgress.currency='USD';
assert.equal(vm.runInContext('budgetProgressFor(progressPeriod,progressCtx.asOf)',context),null,'wrong-currency publication cannot use the CAD formatter');
current.budgetProgress.currency='CAD';
for(const [actual,planned,over,state] of [[25,0,true,'zero-plan'],[0,0,false,'zero-plan'],[-12,40,false,'deficit'],[55,40,true,'known']]){
  context.progressPair={actual:{amount:actual,trust:'calculated',completeness:'complete'},planned:{amount:planned,trust:'calculated',completeness:'complete'}};
  const bar=vm.runInContext("budgetProgressBarHtml(progressPair,'household')",context);
  assert.equal(bar.includes('budget-progress-over'),over);assert.ok(bar.includes('data-budget-bar-state="'+state+'"'));
  if(planned===0||actual<0)assert.doesNotMatch(bar,/width:|NaN|Infinity/);
}
for(const trust of [null,'unknown','unavailable','untrusted']){
  context.progressPair={actual:{amount:25,trust,completeness:'complete'},planned:{amount:0,trust:'calculated',completeness:'complete'}};
  assert.doesNotMatch(vm.runInContext("budgetProgressBarHtml(progressPair,'household')",context),/budget-progress-over|width:/);
}
context.progressPair={actual:{amount:-12,trust:'calculated',completeness:'complete'},planned:{amount:-1,trust:'calculated',completeness:'complete'}};
assert.match(vm.runInContext("budgetProgressValueHtml(progressPair,'household')",context),/data-budget-ratio-plan><span class="budget-v3-unknown">Unknown/);
assert.match(vm.runInContext("budgetProgressValueHtml(progressPair,'household')",context),/[\u2212-]\$12\.00/,'signed actual remains known while original plan is invalid');
console.log('PASS Budget period progress: independent original plans and actuals, coverage/strict nulls, historical/future scope, pending, unknown contributions, immutable financial deductions and active consumers');
