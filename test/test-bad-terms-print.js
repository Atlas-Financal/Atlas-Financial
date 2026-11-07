'use strict';
// Print-only Balance After Deductions terms on the Budget period view.
// Invented household (other-period-target fixture plus two invented bills).
// Expected cents below come from the invented inputs, not from Forecast:
//   income 1,400.00 every period (one confirmed biweekly salary);
//   bills  212.34 rent (biweekly from Sep 30) + 88.21 estimated hydro (15th);
//   household current = six plans 475.00 (groceries 110.37 under its 220)
//             + Other observed 618.73 above its 450 policy = 1,093.73;
//   household future  = 475.00 + Other policy 450.00 = 925.00.
// The identity is re-added here in integer cents from the printed strings.
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
const render=(period,plan,compact)=>{context.period=period;context.plan=plan;context.compact=compact;
 return vm.runInContext('calendarWaterfallHtml(period,null,null,plan,compact)',context);};
const KEYS=['periodIncome','assignedBills','householdBudgetHold','balanceAfterDeductions'];
const LABELS=['Period income','Assigned bills (incl. required debt minimums)',
 'Household (greater of plan or spent, incl. Other)','Balance After Deductions'];
const block=(html,id)=>{const q=html.split('data-operating-question="07"')[1];assert.ok(q,'terms print inside Balance After Deductions');
 const b=q.split(`data-bad-terms-period="${id}"`)[1];assert.ok(b,'one block per period id '+id);return b.split('</div>\n  </div>')[0]+'</div>';};
// [data-bad-term-amount] sits inside [data-bad-term-value]: plain money2 text
// (no ≈ prefix; trust stays on data-bad-term-trust), empty when unavailable.
const terms=b=>KEYS.map((key,i)=>{const m=b.match(new RegExp(`data-bad-term="${key}" data-bad-term-trust="([a-z]+)"><span data-bad-term-label>([^<]*)</span><span data-bad-term-value>(.*?)<span data-bad-term-amount>([^<]*)</span></span></div>`));
 assert.ok(m,'value and amount hooks for '+key);assert.equal(m[2],LABELS[i]);
 return{trust:m[1],text:(m[3]+m[4]).replace(/<[^>]+>/g,''),amount:m[4]};});
const cents=text=>{const m=text.match(/^(?:≈ estimated )?(−?)\$([\d,]+)\.(\d\d)$/);assert.ok(m,'money text: '+text);
 return (m[1]?-1:1)*(Number(m[2].replace(/,/g,''))*100+Number(m[3]));};

const f=fx.build(618.73);
f.plan.bills=[{id:'invented-rent',label:'Invented rent',frequency:'biweekly',anchor:'2026-09-30',amount:212.34,confidence:'confirmed',payingAccount:'chequing-a'},
 {id:'invented-hydro',label:'Invented hydro',frequency:'monthly',day:15,amount:88.21,confidence:'estimated',payingAccount:'chequing-a'}];
const advice=F.recommend(f.plan,f.date,{...f.plan.defaults,debts:[],currentPeriodActuals:f.packet});
const views=advice.payPeriodViews.filter(v=>v.timelineRole!=='past');
const expected=[['current',140000,21234,109373,false],['next',140000,30055,92500,true],
 ['future',140000,21234,92500,true],['future',140000,30055,92500,true]];
assert.ok(views.length>=4);
// (a) current + next + two later periods: printed terms close to the cent.
expected.forEach(([role,income,bills,hold,future],i)=>{
 const v=views[i];assert.equal(v.timelineRole,role);
 for(const compact of [true,false]){
  const sealed=JSON.stringify(v),b=block(render(v,f.plan,compact),v.id);
  assert.match(b,/data-bad-terms-status="published"/);
  const t=terms(b),[I,B,H,R]=t.map(x=>cents(x.text));
  assert.deepEqual([I,B,H],[income,bills,hold],`${v.id}: printed terms match invented inputs`);
  assert.equal(I-B-H,R,`${v.id}: Income − Bills − Household = Balance After Deductions to the cent`);
  assert.equal(R,income-bills-hold);
  // Trust marks follow the stamps plan.js already uses for these values.
  assert.equal(t[1].trust,bills===30055?'estimated':'calculated','estimated hydro marks bills');
  assert.equal(t[2].trust,future?'estimated':'calculated','future Other policy hold is estimated');
  assert.equal(t[3].trust,future?'estimated':'calculated');
  t.forEach(x=>assert.equal(x.text.startsWith('≈ estimated'),x.trust==='estimated'));
  t.forEach(x=>assert.equal(x.text,(x.trust==='estimated'?'≈ estimated ':'')+x.amount));
  assert.equal(JSON.stringify(v),sealed,'printing cannot rewrite the publication');
 }
});
// (b) null terms (Forecast's fail-closed publication) print Unavailable for
// all four, with no fallback to afterHouseholdBudget or the funded result.
const cur=views[0],fallback=['$93.93','93.93'];
// Fail-closed shapes: Forecast's null object (card minimum or income gate,
// forecast.js nulls terms and stamps the result unavailable), a non-closing
// object, a missing field, and the operating-plan-unavailable publication.
const failClosed={predictedEndingBalanceTerms:null,balanceAfterDeductions:null,predictedEndingBalance:null,balanceAfterDeductionsTrust:'unavailable'};
for(const over of [{predictedEndingBalanceTerms:null},failClosed,{...failClosed,operatingPlanUnavailable:true},
 {predictedEndingBalanceTerms:{...cur.predictedEndingBalanceTerms,closes:false}},{predictedEndingBalanceTerms:undefined}]){
 const v={...cur,...over};
 for(const compact of [true,false]){
  const b=block(render(v,f.plan,compact),v.id);
  assert.match(b,/data-bad-terms-status="unavailable"/);
  assert.deepEqual(terms(b).map(x=>[x.trust,x.text,x.amount]),KEYS.map(()=>['unavailable','Unavailable','']));
  fallback.forEach(s=>assert.ok(!b.includes(s),'no fallback figure '+s));
 }
}
// A single missing term is Unavailable for that term only.
const one=block(render({...cur,predictedEndingBalanceTerms:{...cur.predictedEndingBalanceTerms,assignedBills:null}},f.plan,true),cur.id);
assert.deepEqual(terms(one).map(x=>x.text==='Unavailable'),[false,true,false,false]);
// An unavailable trust stamp fails closed even when a number exists.
const untrusted=block(render({...cur,balanceAfterDeductionsTrust:'unavailable'},f.plan,true),cur.id);
assert.deepEqual(terms(untrusted).map(x=>x.text==='Unavailable'),[false,false,false,true]);
// (c) Amount hook on Forecast's published Oct 8 2026 terms (snapshot
// data-2026-10-08-548check.json: income, bills, household, BAD per period;
// household is calculated only in the current period). The Oct 6 snapshot
// published null terms, which is the fail-closed shape covered in (b).
const OCT8=[[6635.92,2706.67,3197.42,731.83,'$731.83'],[6652.30,3097.00,2175.00,1380.30,'$1,380.30'],
 [6651.99,2537.70,2275.00,1839.29,'$1,839.29'],[6432.85,2584.46,2175.00,1673.39,'$1,673.39']];
OCT8.forEach(([I,B,H,R,bad],i)=>{const v={...cur,predictedEndingBalanceTerms:{...cur.predictedEndingBalanceTerms,
 periodIncome:I,assignedBills:B,householdBudgetHold:H,balanceAfterDeductions:R},incomeTrust:'estimated',
 periodBillLoadTrust:'estimated',budgetHoldTrust:i?'estimated':null,balanceAfterDeductionsTrust:'estimated'};
 for(const compact of [true,false]){const t=terms(block(render(v,f.plan,compact),v.id));
  assert.equal(t[3].amount,bad);
  assert.deepEqual(t.map(x=>x.trust),['estimated','estimated',i?'estimated':'calculated','estimated']);
  t.forEach(x=>{assert.ok(!/[≈a-z]/i.test(x.amount),'plain amount '+x.amount);assert.equal(x.text,(x.trust==='estimated'?'≈ estimated ':'')+x.amount);});
  const [ci,cb,ch,cr]=t.map(x=>cents(x.amount));assert.equal(ci-cb-ch,cr);}
});
// Unavailable terms leave the amount hook empty.
for(const b of [one,untrusted])terms(b).filter(x=>x.trust==='unavailable').forEach(x=>assert.equal(x.amount,''));
// (d) Q07 result hooks: data-budget-result-trust plus [data-budget-result-amount]
// (plain money2, empty when unavailable) on the Q07 step (both layouts) and the
// non-compact hero. Visible text stays (≈ estimated) + amount, or Unavailable.
const result=(html,compact)=>{const strip=x=>x.replace(/<[^>]+>/g,'');
 const out=[html.match(/data-operating-question="07"[^>]*?data-budget-result-trust="([a-z]+)"[^]*?<span class="budget-step-value"[^>]*>(.*?)<span data-budget-result-amount>([^<]*)<\/span><\/span>/)];
 if(!compact)out.push(html.match(/data-budget-period-result data-budget-result-trust="([a-z]+)">[^]*?<p class="budget-period-result-value"[^>]*>(.*?)<span data-budget-result-amount>([^<]*)<\/span><\/p>/));
 return out.map(m=>{assert.ok(m,'Q07 result hook');return{trust:m[1],text:strip(m[2]+m[3]),amount:m[3]};});};
const funded={...cur,plannedCostFunding:{status:'ready',start:cur.start,end:cur.end,contribution:100,afterProposedFunding:1675,trust:'estimated',items:[],unscheduled:[]}};
for(const [v,trust,amount] of [[cur,'calculated','$93.93'],[views[1],'estimated','$174.45'],[funded,'estimated','$1,675.00'],[{...cur,...failClosed},'unavailable','']])
 for(const compact of [true,false]){const r=result(render(v,f.plan,compact),compact);assert.equal(r.length,compact?1:2);
  r.forEach(x=>{assert.deepEqual([x.trust,x.amount],[trust,amount]);assert.ok(!/≈/.test(x.amount));
   assert.equal(x.text,trust==='unavailable'?'Unavailable':(trust==='estimated'?'≈ estimated ':'')+amount);});}
// (e) Hidden all-period timeline: one <ol data-bad-timeline> per Budget render
// (payPeriodTimelineHtml), one <li> per advice.payPeriodViews row in order,
// carrying the same BAD trust, face and visible text as that period's terms block.
const timeline=(adv,compact,selected)=>{context.adv=adv;context.plan=f.plan;context.compact=compact;context.sel=selected??null;
 const html=vm.runInContext('payPeriodTimelineHtml(adv,sel,null,null,"",plan,compact,null,null)',context);
 const lists=html.match(/<ol data-bad-timeline[^>]*>[^]*?<\/ol>/g)||[];assert.equal(lists.length,1,'one timeline list per render');
 assert.match(lists[0],/^<ol data-bad-timeline hidden aria-hidden="true">/,'hidden from layout and screen readers');
 return [...lists[0].matchAll(/<li data-bad-timeline-period="([^"]*)" data-bad-timeline-role="([a-z]+)" data-bad-timeline-start="([^"]*)" data-bad-timeline-end="([^"]*)" data-bad-timeline-range-label="([^"]*)"(?: data-bad-timeline-coverage="([^"]*)")? data-bad-term-trust="([a-z]+)" data-bad-terms-face="([a-z-]+)"( data-sign="negative")?>(.*?)<span data-bad-term-amount>([^<]*)<\/span><\/li>/g)]
  .map(m=>({id:m[1],role:m[2],start:m[3],end:m[4],label:m[5],coverage:m[6],trust:m[7],face:m[8],negative:!!m[9],text:(m[10]+m[11]).replace(/<[^>]+>/g,''),amount:m[11]}));};
const badRow=b=>{const m=b.match(/data-bad-terms-face="([a-z-]+)"/);return{face:m[1],...terms(b)[3]};};
const rowsOf=adv=>adv.payPeriodViews.filter(Boolean);
const checkTimeline=(adv,compact,selected)=>{const li=timeline(adv,compact,selected),rows=rowsOf(adv);
 assert.equal(li.length,rows.length,'one <li> per payPeriodViews row');
 rows.forEach((v,i)=>{const x=li[i];
  assert.equal(x.id,v.id||v.start,'in published order');
  assert.equal(x.role,v.timelineRole==='past'||v.timelineRole==='current'?v.timelineRole:'future');
  assert.deepEqual([x.start,x.end],[v.start,v.end]);
  context.row=v;assert.equal(x.label,vm.runInContext('payPeriodRangeLabel(row)',context).replace(/<[^>]*>/g,''));
  const b=badRow(block(render(v,f.plan,compact),v.id));
  assert.deepEqual([x.trust,x.face,x.text,x.amount],[b.trust,b.face,b.text,b.amount],v.id+': same trust, face and text as the terms block');
  assert.ok(!/[≈a-z]/i.test(x.amount),'plain amount '+x.amount);
  const t=v.predictedEndingBalanceTerms;
  if(x.trust==='unavailable'){assert.equal(x.text,'Unavailable');assert.equal(x.amount,'');assert.equal(x.negative,false);}
  else{assert.equal(x.amount,vm.runInContext('money2',context)(t.balanceAfterDeductions));assert.equal(x.negative,t.balanceAfterDeductions<0);}
  const claim=v.budgetProgress&&v.budgetProgress.coverage&&v.budgetProgress.coverage.remainingClaim;
  assert.equal(x.coverage,typeof claim==='string'&&claim?claim:undefined,v.id+': coverage attribute reprints remainingClaim, absent when empty');
 });return li;};
for(const compact of [true,false]){
 const li=checkTimeline(advice,compact);
 assert.ok(li.some(x=>x.role==='past')&&li.filter(x=>x.role==='current').length===1&&li.some(x=>x.role==='future'),'past, current and future roles');
 assert.ok(!li.some(x=>x.role==='next'),'next maps to future');
 // Selecting another period does not change the list.
 assert.deepEqual(checkTimeline(advice,compact,views[2].id),li);
 // Fail-closed, negative, zero and funded rows, decided exactly as the terms block.
 const t0=cur.predictedEndingBalanceTerms,mod=rowsOf(advice).map(v=>v.id===cur.id?{...v,...failClosed}
  :v.id===views[1].id?{...v,predictedEndingBalanceTerms:{...v.predictedEndingBalanceTerms,balanceAfterDeductions:-12.34}}
  :v.id===views[2].id?{...v,predictedEndingBalanceTerms:{...v.predictedEndingBalanceTerms,balanceAfterDeductions:0},plannedCostFunding:{status:'ready',start:v.start,end:v.end,contribution:100,afterProposedFunding:1675,trust:'estimated',items:[],unscheduled:[]}}
  :v.id===views[3].id?{...v,balanceAfterDeductionsTrust:'unavailable'}:v);
 const sealed=JSON.stringify(mod),m=checkTimeline({...advice,payPeriodViews:mod},compact),at=id=>m.find(x=>x.id===id);
 assert.equal(JSON.stringify(mod),sealed,'printing cannot rewrite the publication');
 assert.deepEqual([at(cur.id).trust,at(cur.id).text,at(cur.id).amount,at(cur.id).negative],['unavailable','Unavailable','',false]);
 assert.deepEqual([at(views[3].id).trust,at(views[3].id).amount,at(views[3].id).negative],['unavailable','',false]);
 assert.deepEqual([at(views[1].id).amount,at(views[1].id).negative],['−$12.34',true]);
 assert.deepEqual([at(views[2].id).amount,at(views[2].id).negative,at(views[2].id).face],['$0.00',false,'after-proposed-funding']);
 // Oct 8 2026 published BAD for current + next three (snapshot values, see (c)).
 const o8=rowsOf(advice).map(v=>{const i=views.findIndex(w=>w.id===v.id);return i>=0&&i<4?{...v,predictedEndingBalanceTerms:{...v.predictedEndingBalanceTerms,balanceAfterDeductions:OCT8[i][3]},balanceAfterDeductionsTrust:'estimated'}:v;});
 const l8=checkTimeline({...advice,payPeriodViews:o8},compact).filter(x=>x.role!=='past').slice(0,4);
 assert.deepEqual(l8.map(x=>[x.trust,x.amount]),OCT8.map(r=>['estimated',r[4]]));
 l8.forEach(x=>assert.ok(x.text.startsWith('≈ estimated')&&!/≈/.test(x.amount)));
}
// No payPeriodViews rows: no list.
assert.equal(vm.runInContext('badTimelineHtml({payPeriodViews:[]},true,null)+badTimelineHtml({},false,null)',context),'');
// Coverage is print-only: remainingClaim is copied, and a missing claim
// omits the attribute rather than printing an empty one.
const covRow=(id,claim)=>({id,timelineRole:'past',start:'2026-07-03',end:'2026-07-16',
 predictedEndingBalanceTerms:{identity:'balance-after-deductions',closes:true,balanceAfterDeductions:1},
 balanceAfterDeductionsTrust:'calculated',...(claim===undefined?{}:{budgetProgress:{coverage:{remainingClaim:claim}}})});
context.covRows=[covRow('precise','precise'),covRow('posted','posted-only'),covRow('none','unavailable'),
 covRow('absent',undefined),covRow('empty',''),covRow('nil',null)];
const covHtml=vm.runInContext('badTimelineHtml({payPeriodViews:covRows},false,null)',context);
const covAttr=id=>{const li=covHtml.split(`data-bad-timeline-period="${id}"`)[1].split('</li>')[0];
 const m=li.match(/ data-bad-timeline-coverage="([^"]*)"/);return m?m[1]:null;};
assert.deepEqual([covAttr('precise'),covAttr('posted'),covAttr('none')],['precise','posted-only','unavailable']);
for(const id of ['absent','empty','nil']){
 assert.equal(covAttr(id),null,id+' omits data-bad-timeline-coverage');
 assert.ok(!covHtml.split(`data-bad-timeline-period="${id}"`)[1].split('>')[0].includes('data-bad-timeline-coverage='));
}
// Closing arithmetic and Household coverage do not qualify historical BAD.
// #818 5.7: with every term numeric and trusted it is shown only as a
// reconstruction marked ≈ estimated (never calculated); one untrusted term
// keeps it withheld.
for (const coverage of ['precise', 'posted-only', 'unavailable', undefined]) {
 const past={...cur,timelineRole:'past',lookback:true,
   budgetProgress:{...cur.budgetProgress,coverage:{remainingClaim:coverage}}};
 const untrusted={...past,incomeTrust:'unknown'};
 const sealed=JSON.stringify(past);
 for(const compact of [true,false]) {
  const html=render(past,f.plan,compact), t=terms(block(html,past.id));
  assert.deepEqual(t.slice(0,3),terms(block(render(cur,f.plan,compact),cur.id)).slice(0,3),
    'historical source terms retain their individual qualifications');
  const native=terms(block(render(cur,f.plan,compact),cur.id))[3];
  // Window evidence must exist (Atlas 6701429360): an unavailable or absent
  // coverage claim is not a reconstructable history.
  if (coverage==='unavailable'||coverage===undefined) {
   assert.deepEqual(t[3],{trust:'unavailable',text:'Unavailable',amount:''});
   assert.doesNotMatch(html,/data-bad-historical-reconstructed/);
   assert.match(html,/data-bad-historical-withheld/);
   continue;
  }
  assert.deepEqual(t[3],{trust:'estimated',text:'≈ estimated '+native.amount,amount:native.amount});
  assert.match(html,/data-budget-result-trust="estimated"/);
  assert.doesNotMatch(html,/data-budget-result-trust="calculated"|data-bad-historical-withheld/);
  assert.match(html,/data-bad-historical-reconstructed/);
  assert.match(html,/not captured when the period closed/);
  const timelineRow=timeline({payPeriodViews:[past]},compact,past.id)[0];
  assert.deepEqual([timelineRow.trust,timelineRow.amount],['estimated',native.amount],'timeline agrees with the terms block');
  const withheld=render(untrusted,f.plan,compact), w=terms(block(withheld,past.id));
  assert.deepEqual(w[3],{trust:'unavailable',text:'Unavailable',amount:''});
  assert.match(withheld,/data-budget-result-trust="unavailable"/);
  assert.match(withheld,/data-bad-historical-withheld/);
  assert.match(withheld,/Whole-period income, bill settlement and Household evidence have not been qualified together/);
  assert.doesNotMatch(withheld,/data-budget-result-amount>\$|data-budget-result-amount>-\$/);
  assert.equal(timeline({payPeriodViews:[untrusted]},compact,past.id)[0].trust,'unavailable');
 }
 assert.equal(JSON.stringify(past),sealed,'presentation never mutates historical Forecast publication');
}
const lookbackOnly={...cur,lookback:true,periodBillLoadTrust:'unknown'};
assert.equal(terms(block(render(lookbackOnly,f.plan,true),lookbackOnly.id))[3].trust,'unavailable',
 'the native lookback marker also fails closed without a timeline role');
assert.equal(terms(block(render({...cur,lookback:true},f.plan,true),cur.id))[3].trust,'estimated',
 'the native lookback marker alone reconstructs only as estimated');
// A native, complete Forecast publication earns historical display. A single
// missing or partial component cannot be filled by the other two components.
const completePart = amount => ({amount, trust:'calculated', completeness:'complete'});
const qualifiedPast = {...cur,timelineRole:'past',lookback:true,
 budgetProgress:{source:'Forecast.budgetPeriodProgress',start:cur.start,end:cur.end,coverage:{remainingClaim:'precise'},
  income:{actual:completePart(4050)},bills:{actual:completePart(1665)},household:{actual:completePart(752.99)}}};
for (const compact of [true,false]) {
 const html=render(qualifiedPast,f.plan,compact);
 assert.deepEqual(terms(block(html,cur.id)),terms(block(render(cur,f.plan,compact),cur.id)));
 assert.doesNotMatch(html,/data-bad-historical-withheld/);
 const published=timeline({payPeriodViews:[qualifiedPast]},compact,cur.id)[0];
 const native=badRow(block(html,cur.id));
 assert.deepEqual([published.trust,published.text,published.amount],[native.trust,native.text,native.amount],
  'qualified historical timeline and native term share the same publication');
}
for (const key of ['income','bills','household']) {
 for (const patch of [{completeness:'partial'},{amount:null},{amount:NaN},{trust:'unavailable'}]) {
  const past={...qualifiedPast,budgetProgress:{...qualifiedPast.budgetProgress,
   [key]:{actual:{...qualifiedPast.budgetProgress[key].actual,...patch}}}};
  // #818 5.7 (Atlas 6701429360): unsettled income or bills may still
  // reconstruct as estimated; unevidenced household spending never does.
  const html=render(past,f.plan,true);
  if (key==='household') {
   assert.equal(terms(block(html,past.id))[3].trust,'unavailable',key+' '+JSON.stringify(patch));
   assert.doesNotMatch(html,/data-bad-historical-reconstructed/,key+' '+JSON.stringify(patch));
  } else {
   assert.equal(terms(block(html,past.id))[3].trust,'estimated',key+' '+JSON.stringify(patch));
   assert.match(html,/data-bad-historical-reconstructed/,key+' '+JSON.stringify(patch));
  }
 }
}
for (const patch of [{source:'Other'},{start:'1900-01-01'},{end:null}]) {
 const past={...qualifiedPast,budgetProgress:{...qualifiedPast.budgetProgress,...patch}};
 // The evidence must be Forecast's for this exact period (Atlas 6701429360).
 const html=render(past,f.plan,true);
 assert.equal(terms(block(html,past.id))[3].trust,'unavailable','wrong historical publication identity is not evidence');
 assert.doesNotMatch(html,/data-bad-historical-reconstructed/);
}
// (e) ATLAS-026: a period whose income Forecast withholds (a scheduled
// receipt with a missing amount) prints Unavailable for all four terms —
// the fail-closed publication from (b), produced end-to-end by Forecast.
const plan026={windowDays:120,defaults:{targetBuffer:0,extraDebtMonthly:0,scenario:'expected'},
 opening:{asOf:'2026-10-07',paydaySnapshot:{periodStart:'2026-10-02',asOf:'2026-10-02',opening:50},
 representedEvents:[{id:'payroll',date:'2026-10-02'}]},
 startingCash:{breakdown:[{id:'chequing-a',value:50}]},
 income:[{id:'payroll',frequency:'biweekly',anchor:'2026-10-02',amount:0,confidence:'confirmed'},
 {id:'r1',label:'Synthetic receipt',frequency:'once',date:'2026-10-16',amount:null,confidence:'confirmed'}],
 bills:[{id:'b1',label:'Synthetic bill',frequency:'once',date:'2026-10-20',amount:120,confidence:'confirmed'}],
 obligations:[],commitments:[],budget:{categories:[]}};
const view026=F.recommend(plan026,'2026-10-07',{weeklyVariable:0,debts:[]}).payPeriodViews.find(v=>v.start==='2026-10-16');
assert.ok(view026&&view026.predictedEndingBalanceTerms===null&&view026.incomeTrust==='unavailable',
 'ATLAS-026: Forecast withholds the period terms for a missing receipt amount');
for(const compact of [true,false]){
 const b=block(render(view026,plan026,compact),view026.id);
 assert.match(b,/data-bad-terms-status="unavailable"/);
 assert.deepEqual(terms(b).map(x=>[x.trust,x.text,x.amount]),KEYS.map(()=>['unavailable','Unavailable','']));
}
console.log('PASS historical BAD: unqualified periods reconstruct only as ≈ estimated when household spending and the window are evidenced (withheld when any term is untrusted, spending is missing or coverage is unavailable); original source terms and publication immutable');
console.log('bad terms print: 4 periods × 2 layouts close to the cent; null/non-closing/untrusted terms print Unavailable; amount hook plain (Oct 8 BAD 731.83/1,380.30/1,839.29/1,673.39); Q07 + hero result hooks (funded $1,675.00 est, unavailable empty); hidden all-period timeline matches the terms block per row; coverage attribute reprints remainingClaim (precise, posted-only, unavailable) and is omitted when missing');
