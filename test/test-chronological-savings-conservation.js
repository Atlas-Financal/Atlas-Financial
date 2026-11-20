'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const F=require('../public/forecast'),fx=require('./fixtures/savings-daily-allocation-contract');
const {ledger,data}=require('./fixtures/chronological-savings-data');
const publish=i=>F.recommend(i.plan,i.asOf,{...i.opts,weeklyVariable:0}).savingsFunding;
const point=(p,date)=>{assert.equal(p.timeline.status,'ready',p.timeline.reason);const r=p.timeline.daily.find(r=>r.date===date);assert.ok(r);return [r.operatingCash,r.savingsCash,r.combinedHouseholdCash];};
test('one planned draw and future receipt conserve 199 -> 139 -> 216 exactly',()=>{
 const i=ledger(),before=JSON.stringify(i),p=publish(i);
 assert.deepEqual(point(p,'2026-10-07'),[80,119,199]);
 assert.deepEqual(point(p,'2026-10-21'),[80,59,139]);
 assert.deepEqual(point(p,'2026-11-01'),[80,59,139]);
 assert.deepEqual(point(p,'2026-11-02'),[157,59,216]);
 assert.equal(p.stock.amount,119,'future income never becomes observed savings');
 assert.equal(p.timeline.payments.filter(r=>r.id==='near').length,1);
 assert.equal(p.timeline.payments[0].amount,60);
 assert.equal(JSON.stringify(i),before);
});
test('either settled deposit moves operating/reserve equally and does not change household value',()=>{
 for(const account of ['savings','savings-dont-touch']) {
  const i=fx.transfer(ledger(),10,'AA101',account,'2026-10-06'),p=publish(i);
  assert.deepEqual(point(p,'2026-10-07'),[70,129,199]);
  assert.deepEqual(point(p,'2026-10-21'),[70,69,139]);
  assert.deepEqual(point(p,'2026-11-02'),[147,69,216]);
  assert.equal(p.period.transferred,10);assert.equal(p.period.actualSaved,null);
 }
});
test('operating unavailability holds proposals and projections while qualified stock/backing survives',()=>{
 const i=ledger();i.opts.operatingPlan='unavailable';
 const advice=F.recommend(i.plan,i.asOf,{...i.opts,weeklyVariable:0}),p=advice.savingsFunding;
 assert.equal(p.stock.amount,119);assert.equal(p.backing.items[0].saved,60);
 assert.equal(p.period.proposal,null);assert.equal(p.timeline.status,'unavailable');
 assert.equal(p.schedule,advice.planSpendPaydayFunding,'one schedule alias after withholding');
 assert.ok(p.lenses.every(l=>!l.ready&&l.proposal===null&&l.items.every(r=>r.contribution===null)));
});
test('unknown stock retains known requirements and never becomes a zero projection',()=>{
 const i=ledger();i.plan.savingsPoolObservation.accounts.pop();const p=publish(i);
 assert.equal(p.stock.amount,null);assert.equal(p.backing.items[0].needed,60);
 assert.equal(p.backing.items[0].saved,null);assert.equal(p.timeline.status,'unavailable');
 assert.deepEqual(p.timeline.daily,[]);
});
test('strict canonical policy cannot be replaced or laundered by caller options',()=>{
 const i=ledger();i.plan.savingsEarmarks.allocationPolicy.priority='invented';const p=publish(i);
 assert.equal(p.backing.status,'unavailable');assert.equal(p.backing.items.length,1);
 assert.equal(p.backing.items[0].saved,null);
 assert.match(p.backing.reason,/policy/);
 assert.equal(p.schedule.status,'unavailable');assert.equal(p.schedule.paydays.length,0);
 assert.ok(p.schedule.costs.every(row=>row.protectedNow===null&&row.actualSaved===null&&row.nextContribution===null));
 assert.ok(p.lenses.every(lens=>!lens.ready&&lens.proposal===null&&lens.items.every(row=>row.contribution===null)),
   'an invalid policy cannot launder a future proposal via the legacy schedule');
});
test('current derived backing never publishes confirmed assignment/actual fulfillment',()=>{
 const d=data(),advice=F.recommend(d.plan,d.meta.asOf,{weeklyVariable:40,...d.liveOverlay}),p=advice.savingsFunding;
 // One authority (#1441): the published schedule is the advice schedule, or,
 // where its first payday does not reprint the Budget's payday top-up, the same
 // schedule with only its payday rows and gap withheld (and the reason given).
 if(p.schedule.paydayReason==null)assert.equal(p.schedule,advice.planSpendPaydayFunding);
 else{const{paydays,gap,paydayReason,...rest}=p.schedule,{paydays:p0,gap:g0,...base}=advice.planSpendPaydayFunding;
  assert.deepEqual(paydays,[]);assert.equal(gap,null);assert.match(paydayReason,/Budget/);assert.deepEqual(rest,base);}
 assert.ok(p.schedule.costs.every(r=>r.actualSaved===null));
 assert.equal(p.backing.actualTransferred,null);assert.equal(p.period.actualSaved,null);
 assert.deepEqual(p.backing.items.map(r=>[r.id,r.saved]),[['near',60],['home-cost',24],['far',35],['trip',0]]);
 assert.ok(p.lenses.every(l=>l.items.find(r=>r.requirementId==='trip').saved===0));
 const projected=p.timeline.daily;
 if(p.timeline.status==='ready')for(const r of projected)assert.equal(Math.round(r.operatingCash*100)+Math.round(r.savingsCash*100),Math.round(r.combinedHouseholdCash*100));
});
test('before effective date retains historical policy without pulling today stock backward',()=>{
 const i=fx.advance(fx.fixture(),'2026-10-06');
 i.plan.savingsEarmarks.allocationPolicy={order:'due-date-first-combined-pool',effectiveFrom:'2026-10-07',source:'Invented owner'};
 i.plan.savingsPoolObservation.accounts[0].value=i.plan.startingCash.breakdown[2].value=30;
 i.plan.savingsPoolObservation.accounts[1].value=i.plan.startingCash.heldElsewhere[0].value=89;
 const p=F.recommend(i.plan,i.asOf,i.opts).savingsFunding;
 assert.equal(p.backing.items.find(r=>r.id==='near').saved,30);
 assert.equal(p.backing.items.find(r=>r.id==='far').saved,0);
 assert.equal(p.asOf,'2026-10-06');
});
test('settled cost remains history and is absent from queue/group need on every repeat',()=>{
 const d=data('settled'),before=JSON.stringify(d);
 for(let n=0;n<3;n++){const p=F.recommend(d.plan,d.meta.asOf,{weeklyVariable:40,...d.liveOverlay}).savingsFunding;
  assert.ok(!p.backing.items.some(r=>r.id==='near'));
  assert.equal(p.rows.find(r=>r.key==='group:club').needed,170);
  assert.equal(p.rows.find(r=>r.key==='group:club').saved,95);
 }
 assert.equal(JSON.stringify(d),before);assert.equal(d.plan.commitments[0].amount,60);
});

test('native simulation uses the same global stock frontier without a second assignment policy',()=>{
 const i=ledger(),before=JSON.stringify(i);
 i.plan.bills=[{id:'annual',label:'Invented annual card cost',frequency:'yearly',month:10,day:25,
   firstDue:'2026-10-25',amount:24,confidence:'confirmed',jointCash:false}];
 const p=publish(i),sim=F.simulate(i.plan,i.asOf,{...i.opts,weeklyVariable:0,horizonDays:31,viewDays:31});
 assert.deepEqual(p.backing.items.map(r=>[r.id,r.saved]),[['near',60],['annual',24]]);
 assert.deepEqual(sim.events.filter(r=>r.reserveFunding).map(r=>[r.id,r.reserveFunding.amount]),[['near',60],['annual',24]]);
 assert.deepEqual(point(p,'2026-10-25'),[80,35,115], '199 - 60 cash requirement - 24 reserved card requirement');
 assert.deepEqual(point(p,'2026-11-02'),[157,35,192], 'the 77 receipt arrives only on its native date');
 assert.equal(p.timeline.cashBasis,'native-available-and-reserved-planning-ledger');
 assert.equal(sim.daily.find(r=>r.date==='2026-10-25').balance,80,'backed reserve is not a second operating deduction');
 assert.equal(p.timeline.payments.filter(r=>r.id==='annual').length,1);
 assert.deepEqual(F.projectDebts(i.plan,[],i.asOf,{}).byId,{},'planning a card-paid bill never posts or repays card debt');
 delete i.plan.bills[0];i.plan.bills=[];assert.equal(JSON.stringify(i),before);
});


for(const kind of ['annual','tax'])test('missing native '+kind+' requirement stays visible and withholds the frontier',()=>{
 const i=ledger();
 if(kind==='annual')i.plan.bills=[{id:'unknown-annual',label:'Invented unknown annual',frequency:'yearly',month:10,day:25,firstDue:'2026-10-25',confidence:'estimated',jointCash:false}];
 else i.plan.budget.categories=[{id:'unknown-tax',label:'Invented unknown tax',class:'reserve',planningDate:'2026-10-24',confidence:'estimated'}];
 const p=publish(i),r=p.unresolved.find(row=>row.id==='unknown-'+kind);
 assert.ok(r);assert.equal(r.needed,null);assert.equal(r.saved,null);
 assert.equal(p.backing.status,'unavailable');assert.equal(p.period.proposal,null);
 assert.equal(p.backing.items[0].saved,null,'unknown earlier priority cannot become a zero requirement');
 assert.equal(p.rows.find(row=>row.members.includes(r.key)).needed,null);
});

test('selected historical periods cannot borrow present savings or future top-ups',()=>{
 const p=publish(ledger());const history=p.periodViews.filter(row=>row.role==='past');
 assert.ok(history.length);
 for(const view of history){assert.equal(view.packet.period.kind,'historical');assert.equal(view.packet.stock.amount,null);
  assert.ok(view.packet.rows.every(row=>row.saved===null&&row.needed===null&&row.thisPeriod===null));}
});


for(const evidence of ['observation','transaction'])test('pending '+evidence+' holds permission but preserves independently known 119 posted stock',()=>{
 const i=ledger(),before=JSON.stringify(i);
 if(evidence==='observation')i.plan.savingsPoolObservation.accounts[0].pendingState='pending';
 else i.opts.currentPeriodActuals.transactions.push({id:'invented-pending',date:i.asOf,amount:5,
   pending:true,currency:'CAD',atlasAccountId:'savings',accountRole:'household-reserve'});
 const p=publish(i);
 assert.equal(p.stock.status,'ready');assert.equal(p.stock.amount,119);assert.equal(p.stock.evidenceTrust,'verified');
 assert.equal(p.stock.pendingState,'unresolved');assert.equal(p.backing.status,'unavailable');
 assert.deepEqual(p.backing.items.map(row=>row.saved),[60],'the single invented 60-dollar requirement retains its reported earmark');assert.equal(p.period.proposal,null);
 assert.ok(p.lenses.every(lens=>!lens.ready&&lens.items.every(row=>row.contribution===null)));
 assert.equal(p.schedule.status,'unavailable');assert.equal(p.timeline.status,'unavailable');
 assert.equal(p.period.actualSaved,null);assert.equal(p.backing.actualTransferred,null);
 if(evidence==='observation')i.plan.savingsPoolObservation.accounts[0].pendingState='clear';else i.opts.currentPeriodActuals.transactions=[];
 assert.equal(JSON.stringify(i),before,'pending read cannot mutate posted balances or source history');
});


test('native optional cost cannot re-enter via unresolved roster retention',()=>{
 const i=ledger();i.plan.commitments.push({id:'optional',label:'Invented optional cost',date:'2026-10-08',
  amount:5,confidence:'confirmed',sinkingFund:true,flexibility:'optional'});
 const p=publish(i);assert.deepEqual(p.backing.items.map(row=>[row.id,row.saved]),[['near',60]]);
 assert.ok(!p.unresolved.some(row=>row.id==='optional'));assert.equal(p.backing.unallocated,59);
});

test('malformed reserve account list withholds money without throwing or fabricating zero',()=>{
 const i=ledger();i.plan.savingsPoolObservation.accounts={};const p=publish(i);
 assert.equal(p.stock.amount,null);assert.equal(p.backing.status,'unavailable');
 assert.equal(p.backing.items[0].needed,60);assert.equal(p.backing.items[0].saved,null);
 assert.equal(p.period.proposal,null);
});

for(const confidence of [undefined,'unknown','unexpected'])test('unsupported confidence '+String(confidence)+' cannot earn an estimated allocation',()=>{
 const i=ledger();i.plan.commitments[0].confidence=confidence;const p=publish(i);
 assert.equal(p.backing.status,'unavailable');assert.equal(p.period.proposal,null);
 const cost=p.unresolved.find(row=>row.id==='near');assert.ok(cost);assert.equal(cost.needed,60);
 assert.equal(cost.saved,null);assert.equal(cost.trust,'unknown');
});
