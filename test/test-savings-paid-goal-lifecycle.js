'use strict';
// Invented $60 cost and $119 stock: payment relief is never a stock movement.
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('../public/forecast');
const C = require('../scripts/planned-obligation-settlement-contract');
const fx = require('./fixtures/savings-daily-allocation-contract');
const { policy } = require('./fixtures/chronological-savings-data');
function input(day = '2026-10-07') {
  const x = policy(fx.advance(fx.fixture(), day));
  x.plan.savingsEarmarks.pools[0].goalRefs = [{kind:'commitment',id:'near'}];
  return x;
}
function evidence(cents = 6000, date = '2026-10-07') {
  return {commitments:[{goalId:'commitment:near',links:[{operationId:'invented-payment',
    effectiveDate:date,asOf:date,assignedCents:cents,reversals:[]}]}]};
}
function surfaces(day, eff) {
  const x=input(day), opts={...x.opts,settlementEvidence:eff};
  return {x,seq:F.fundingSequence(x.plan,day,opts),
    inventory:F.savingsInventory(x.plan,day,opts),
    funding:F.savingsDailyFunding(x.plan,[],day,opts)};
}
test('full payment is Paid through completion-period end and absent at next opening',()=>{
  for(const day of ['2026-10-07','2026-10-15']) {
    const p=surfaces(day,evidence());
    assert.equal(p.seq.find(r=>r.id==='near').paymentStatus,'paid');
    assert.equal(p.funding.backing.items.find(r=>r.id==='near').paymentStatus,'paid');
    assert.equal(p.inventory.pools[0].plannedGoals[0].paymentStatus,'paid');
    assert.equal(p.seq.find(r=>r.id==='near').need,0);
  }
  const p=surfaces('2026-10-16',evidence());
  assert.ok(!p.seq.some(r=>r.id==='near'));
  assert.ok(!p.funding.backing.items.some(r=>r.id==='near'));
  assert.ok(!p.inventory.pools[0].plannedGoals.some(g=>g.key==='commitment:near'));
});
test('partial, over-assigned and reversal-tainted payments never retire',()=>{
  for(const cents of [2500,6100]) {
    const p=surfaces('2026-10-30',evidence(cents));
    assert.equal(p.seq.find(r=>r.id==='near').need,cents===2500?35:null);
    assert.ok(p.funding.backing.items.concat(p.funding.unresolved).some(r=>r.id==='near'));
  }
  const e=evidence();e.commitments[0].links[0].reversals=[{cents:500,date:'2026-10-08'}];
  const p=surfaces('2026-10-30',e);
  assert.equal(p.seq.find(r=>r.id==='near').need,null);
  assert.notEqual(p.seq.find(r=>r.id==='near').paymentStatus,'paid');
});
test('effective date pins completion; future links and missing calendar never retire',()=>{
  assert.equal(surfaces('2026-10-15',evidence(6000,'2026-10-15')).seq.find(r=>r.id==='near').paymentStatus,'paid');
  assert.ok(!surfaces('2026-10-16',evidence(6000,'2026-10-15')).seq.some(r=>r.id==='near'));
  const e=evidence(6000,'2026-10-16');
  assert.equal(surfaces('2026-10-15',e).seq.find(r=>r.id==='near').need,60);
  assert.equal(surfaces('2026-10-16',e).seq.find(r=>r.id==='near').paymentStatus,'paid');
  assert.ok(!surfaces('2026-10-30',e).seq.some(r=>r.id==='near'));
  const x=input('2026-10-30');x.plan.income=[];
  assert.ok(F.fundingSequence(x.plan,x.asOf,{settlementEvidence:e}).some(r=>r.id==='near'));
});
test('Saved is not Paid; no extra stock draw, source mutation or manual-settlement reinterpretation',()=>{
  const e=evidence(), before=JSON.stringify(e), p=surfaces('2026-10-07',e);
  assert.equal(p.funding.stock.amount,119);
  assert.equal(p.funding.backing.items.find(r=>r.id==='near').saved,0);
  const saved=surfaces('2026-10-07',{commitments:[]});
  assert.equal(saved.funding.backing.items.find(r=>r.id==='near').saved,60);
  assert.notEqual(saved.seq.find(r=>r.id==='near').paymentStatus,'paid');
  assert.equal(p.x.plan.commitments[0].settledOn,undefined);
  assert.equal(F.commitmentSettledBy(p.x.plan.commitments[0],'2026-10-30'),false);
  p.x.plan.commitments[0].settledOn='2026-10-08';
  assert.equal(F.commitmentSettledBy(p.x.plan.commitments[0],'2026-10-07'),false);
  assert.equal(F.commitmentSettledBy(p.x.plan.commitments[0],'2026-10-08'),true);
  assert.equal(JSON.stringify(e),before);
});
test('operation replay retains withdrawn history while removing effective relief',()=>{
  const householdId='household-'+'a'.repeat(32),actorId='session-'+'c'.repeat(64);
  let body=C.adopt({householdId});
  const debit={accountId:'invented-account',currency:'cad',direction:'debit',date:'2026-10-07',cents:6000,posted:true};
  const commands=[{version:1,kind:'link',goalId:'commitment:near',txRef:'tx-'+'1'.repeat(32),
    evidence:debit,evidenceDigest:C.digest(debit),assignedCents:6000,asOf:'2026-10-07'},
    {version:1,kind:'retract',targetOperationId:'operation-'+'1'.repeat(32)}];
  commands.forEach((command,i)=>{
    const now=Date.parse('2026-10-07T12:00:00Z')+i*10;
    const prepared=C.prepare(body,{householdId,actorId,operationId:'operation-'+String(i+1).repeat(32),command,now});
    const result=C.confirmCandidate(body,{householdId,actorId,preview:prepared.preview,confirmationDigest:prepared.confirmationDigest,now:now+1});
    assert.equal(result.status,'candidate');body=result.document;
    if(i===0) assert.ok(!surfaces('2026-10-16',C.effectiveEvidence(JSON.parse(body))).seq.some(r=>r.id==='near'));
  });
  const state=JSON.parse(body);assert.equal(state.operations.length,2);
  assert.equal(surfaces('2026-10-16',C.effectiveEvidence(state)).seq.find(r=>r.id==='near').need,60);
});
test('selected future publications omit actual Paid goals even when no native expense remains',()=>{
  const x=input(),opts={...x.opts,settlementEvidence:evidence(),debts:[],weeklyVariable:0};
  const before=JSON.stringify(x), advice=F.recommend(x.plan,x.asOf,opts);
  assert.equal(advice.fundingSequence.find(r=>r.id==='near').paymentStatus,'paid');
  let checked=0;
  for(const view of advice.savingsFunding.periodViews.filter(v=>v.role==='past')) {
    for(const row of view.packet?.rows || []) assert.equal(row.paymentStatus,undefined);
  }
  for(const view of advice.savingsFunding.periodViews.filter(v=>['next','future'].includes(v.role))) {
    if(view.start<='2026-10-07')continue;
    assert.ok(!view.packet.plannedRequirements.items.some(i=>i.id==='near'));
    assert.ok(!view.packet.forecastClosing.items.some(i=>i.id==='near'));
    checked++;
  }
  assert.ok(checked>0);assert.equal(JSON.stringify(x),before);
});
test('split payments complete on the last effective date; groups keep their unpaid sibling',()=>{
  const e=evidence(2500,'2026-10-07');
  e.commitments[0].links.push({...e.commitments[0].links[0],operationId:'second-payment',assignedCents:3500,effectiveDate:'2026-10-16'});
  assert.equal(surfaces('2026-10-15',e).seq.find(r=>r.id==='near').need,35);
  assert.equal(surfaces('2026-10-16',e).seq.find(r=>r.id==='near').paidOn,'2026-10-16');
  const x=input('2026-10-30');x.plan.savingsEarmarks.pools[0].goalRefs=[{kind:'group',id:'club'}];
  const p=F.savingsInventory(x.plan,x.asOf,{settlementEvidence:e});
  assert.equal(p.pools[0].plannedGoals[0].target,170);
  assert.deepEqual(p.pools[0].plannedGoals[0].members,['goal:far']);
  assert.notEqual(p.pools[0].plannedGoals[0].paymentStatus,'paid');
});
test('zero cost and colliding native identity never establish payment retirement',()=>{
  for(const collision of ['duplicate','bill','zero']) {
    const x=input('2026-10-30');
    if(collision==='duplicate')x.plan.commitments.push({...x.plan.commitments[0]});
    if(collision==='bill')x.plan.bills.push({id:'near',amount:60,frequency:'once',date:'2026-10-21'});
    if(collision==='zero')x.plan.commitments[0].amount=0;
    const opts={settlementEvidence:evidence(collision==='zero'?0:6000)};
    if(collision==='zero') {
      assert.equal(F.scheduledAmountState(x.plan,x.asOf,'2026-11-30',opts).status,'unavailable');
      assert.equal(F.recommend(x.plan,x.asOf,{...x.opts,...opts,debts:[]}).savingsFunding.backing.status,'unavailable');
    } else assert.ok(F.fundingSequence(x.plan,x.asOf,opts).some(r=>r.id==='near'));
  }
});

// Scheduler join regression: a paid $60 goal emits no future expense, while
// the independent $170 goal retains $95 of the $119 stock after the $24 bill.
function scheduleInput(eff = evidence(6000,'2026-10-05')) {
  const x=input();
  const opts={...x.opts,settlementEvidence:eff,debts:[],weeklyVariable:0,horizonDays:91,viewDays:91};
  const advice=F.recommend(x.plan,x.asOf,opts);
  const sim=F.simulate(x.plan,x.asOf,opts),seq=F.fundingSequence(x.plan,x.asOf,opts);
  return {x,opts,advice,sim,seq,run:(walk=sim,rows=seq)=>F.planSpendPaydayFunding(x.plan,x.asOf,walk,rows,[])};
}
test('scheduler: fully Paid goal keeps the current funding schedule and unrelated goal figures ready',()=>{
  const p=scheduleInput(),s=p.advice.planSpendPaydayFunding;
  assert.equal(s.status,'ready');
  assert.equal(p.advice.savingsFunding.schedule.status,'ready');
  assert.equal(p.seq.find(r=>r.id==='near').paymentStatus,'paid');
  assert.equal(p.sim.events.filter(e=>e.id==='near').length,0,'no fabricated zero cash event');
  const paid=s.costs.find(c=>c.id==='near'),far=s.costs.find(c=>c.id==='far');
  assert.equal(paid.baseRequirement,0);
  assert.equal(paid.stillToFund,0);
  assert.equal(far.baseRequirement,170);
  assert.equal(far.protectedNow,95);
  assert.equal(far.actualSaved,null,'backing is not evidence of an actual transfer');
  assert.equal(far.stillToFund,75,'170 - 95 = 75, independent of the paid goal');
});
test('scheduler: a partial positive obligation still needs exactly one matching cash event',()=>{
  const p=scheduleInput(evidence(2500,'2026-10-05'));
  assert.equal(p.run().status,'ready');
  assert.equal(p.seq.find(r=>r.id==='near').need,35);
  const matches=p.sim.events.filter(e=>e.id==='near');assert.equal(matches.length,1);
  assert.equal(matches[0].amount,-35);
  for(const events of [p.sim.events.filter(e=>e.id!=='near'),[...p.sim.events,matches[0]],
    p.sim.events.map(e=>e.id==='near'?{...e,amount:-34}:e)]) {
    const s=p.run({...p.sim,events});
    assert.equal(s.status,'unavailable');assert.match(s.reason,/does not match one Forecast cash event/);
  }
});
test('scheduler: zero alone or an ambiguous/mismatched event cannot claim the Paid exception',()=>{
  const p=scheduleInput();
  for(const rows of [p.seq.map(r=>r.id==='near'?{...r,paymentStatus:undefined}:r),
    p.seq.map(r=>r.id==='near'?{...r,linkedPaid:59}:r)]) assert.equal(p.run(p.sim,rows).status,'unavailable');
  const unexpected={id:'near',date:'2026-10-21',kind:'commitment',amount:-1};
  assert.equal(p.run({...p.sim,events:[...p.sim.events,unexpected]}).status,'unavailable');
});
test('scheduler: reversal, over-assignment and ambiguous native identity still withhold',()=>{
  for(const mode of ['reverse','over','duplicate']) {
    const eff=evidence(mode==='over'?6100:6000,'2026-10-05');
    if(mode==='reverse')eff.commitments[0].links[0].reversals=[{cents:500,date:'2026-10-06'}];
    const x=input();if(mode==='duplicate')x.plan.commitments.push({...x.plan.commitments[0]});
    const a=F.recommend(x.plan,x.asOf,{...x.opts,settlementEvidence:eff,debts:[],weeklyVariable:0});
    assert.equal(a.planSpendPaydayFunding.status,'unavailable',mode);
  }
});
