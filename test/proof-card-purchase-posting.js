'use strict';
// Exact-base synthetic qualification proof; cents are specified independently.
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=process.argv[2],F=require('../public/forecast'),L=require('../scripts/live-plan'),fx=require('./fixtures/card-purchase-coverage-data');
const {captureSourceBinding,verifySourceBinding}=require('./proof-source-binding'),cache=new Map();
assert.match(base||'',/^[0-9a-f]{40}$/);
function old(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(path.join(root,file),module);cache.set(file,m);m.filename=path.join(root,file);m.paths=Module._nodeModulePaths(path.dirname(m.filename));const native=m.require.bind(m);m.require=id=>id.startsWith('.')?old(path.posix.normalize(path.posix.join(path.posix.dirname(file),id))+(path.posix.extname(id)?'':'.js')):native(id);m._compile(cp.execFileSync('git',['show',base+':'+file],{cwd:root,encoding:'utf8',maxBuffer:16000000}),m.filename);return m.exports;}
const Before=old('public/forecast.js'),digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const modes=['posted','pending','raw-missing','raw-null','raw-string-false','raw-string-true','raw-zero','raw-one','raw-object','dto-missing','dto-null','dto-string-false','dto-zero','dto-object','dto-source-unknown','dto-source-null','dto-source-pending','pending-confirmed-treatment','pending-presumed-treatment','legacy-posted'];
const cases=[];
for(const mode of modes)for(const allocated of [80,40]){
  const x=fx('backfill');delete x.data.plan.cardPurchaseCoverage.opening;x.payload.transactions.slice(1).forEach(tx=>{tx.category_name='Payment, Transfer';tx.notes=null;});
  if(mode.startsWith('pending')){x.payload.transactions[0].is_pending=true;x.payload.accounts[3].balance=320;}
  const rawValues={'raw-null':null,'raw-string-false':'false','raw-string-true':'true','raw-zero':0,'raw-one':1,'raw-object':{}};
  if(mode==='raw-missing')delete x.payload.transactions[0].is_pending;else if(Object.hasOwn(rawValues,mode))x.payload.transactions[0].is_pending=rawValues[mode];
  const inputHash=digest(x),served=L.fromObservation(x),data=served.data,reportHash=digest(served.report),packet=structuredClone(data.liveOverlay.currentPeriodActuals);
  const purchase=packet.transactions.find(tx=>tx.atlasAccountId===x.cardId&&tx.amount===80);
  const dtoValues={'dto-null':null,'dto-string-false':'false','dto-zero':0,'dto-object':{}};
  if(mode==='dto-missing')delete purchase.pending;else if(Object.hasOwn(dtoValues,mode))purchase.pending=dtoValues[mode];
  if(mode.startsWith('dto-source-'))purchase.savingsPostingEvidence=mode==='dto-source-null'?null:mode.slice('dto-source-'.length);
  if(mode==='legacy-posted')delete purchase.savingsPostingEvidence;
  if(mode==='pending-confirmed-treatment')purchase.pendingTreatment='confirmed-settled';
  if(mode==='pending-presumed-treatment')purchase.pendingTreatment='presumed-settled-for-current-forecast';
  const record={id:'decision-'+'a'.repeat(32),confirmed:true,debitRef:fx.ref(x,80002),creditRef:fx.ref(x,80003),allocations:[{purchaseRef:fx.ref(x,80001),amount:allocated}],otherAmount:80-allocated,otherPurpose:allocated===80?null:'required-payment'};
  const args={plan:data.plan,debts:data.debts,asOf:x.asOf,packet,record},argsHash=digest(args),before=Before.validateCardPaymentDecision(args),after=F.validateCardPaymentDecision(args),ready=['posted','legacy-posted'].includes(mode);
  assert.equal(after.status,ready?'ready':'unavailable');if(ready)assert.deepEqual([after.allocation.backfill,after.allocation.cardPayment],[allocated,80-allocated]);
  const plan=structuredClone(data.plan);plan.cardPurchaseCoverage.payments.push(record);
  const opts={debts:data.debts,currentPeriodActuals:packet},a=Before.recommend(plan,x.asOf,opts),b=F.recommend(plan,x.asOf,opts),prior=a.cardPurchaseCoverage.purchases,now=b.cardPurchaseCoverage.purchases;
  assert.equal(prior.length,1);assert.equal(now.length,1);assert.equal(prior[0].amount,80);assert.equal(now[0].amount,80);
  assert.deepEqual([now[0].covered,now[0].remaining],[ready?allocated:0,ready?80-allocated:80]);
  assert.equal(F.startingCashAmount(data.plan),420);assert.equal(data.debts[0].balance,mode.startsWith('pending')?320:400);assert.equal(data.debts[0].pending,mode.startsWith('pending')?80:0);
  const financial=card=>({posted:card.posted.map(({paymentAllocation,...row})=>row),pending:card.pending,netMovement:card.netMovement,netStatus:card.netStatus});
  const window=F.spendingCycle(plan,x.asOf),oldMovement=Before.cardPeriodMovements(plan,data.debts,x.asOf,window,opts),newMovement=F.cardPeriodMovements(plan,data.debts,x.asOf,window,opts);
  assert.deepEqual(oldMovement.cards.map(financial),newMovement.cards.map(financial),'physical card movements are unchanged; allocation evidence alone differs');
  assert.deepEqual(F.currentPeriodAction(plan,x.asOf,opts).outgoingETransfers,Before.currentPeriodAction(plan,x.asOf,opts).outgoingETransfers,'current-main e-transfer publication stays unchanged');
  assert.equal(digest(x),inputHash);assert.equal(digest(served.report),reportHash);assert.equal(digest(args),argsHash);
  cases.push({mode,allocatedCents:allocated*100,expectedStatus:ready?'ready':'unavailable',beforeStatus:before.status,afterStatus:after.status,beforePass:before.status===(ready?'ready':'unavailable'),afterPass:true,purchaseCents:8000,beforeCoveredCents:Math.round(prior[0].covered*100),afterCoveredCents:Math.round(now[0].covered*100),remainingCents:Math.round(now[0].remaining*100),cashCents:42000,postedDebtCents:mode.startsWith('pending')?32000:40000,pendingDebtCents:mode.startsWith('pending')?8000:0,physicalCardMovementChanges:0,inputSha256:inputHash,returnedReportUnchanged:true});
}
assert.equal(cases.length,40);assert.equal(cases.filter(row=>!row.beforePass).length,36);
const publicationControls=[];
for(const pending of [false,true]){
  const x=fx('backfill');delete x.data.plan.cardPurchaseCoverage.opening;x.payload.transactions.slice(1).forEach(tx=>{tx.category_name='Payment, Transfer';tx.notes=null;});
  x.payload.transactions[0].is_pending=pending;x.payload.accounts[3].balance=pending?320:400;
  x.payload.transactions.push({...x.payload.transactions[1],id:80004,amount:17,payee:'Invented recipient',original_name:'SEND E-TFR INVENTED',category_name:'Transfer'});x.payload.accounts[0].balance=403;
  const data=L.fromObservation(x).data,packet=data.liveOverlay.currentPeriodActuals;
  assert.equal(packet.transactions.find(tx=>tx.amount===17).outgoingETransferIdentity,true);
  data.plan.cardPurchaseCoverage.payments.push({id:'decision-'+'a'.repeat(32),confirmed:true,debitRef:fx.ref(x,80002),creditRef:fx.ref(x,80003),allocations:[{purchaseRef:fx.ref(x,80001),amount:80}],otherAmount:0,otherPurpose:null});
  const opts={debts:data.debts,currentPeriodActuals:packet},before=Before.currentPeriodAction(data.plan,x.asOf,opts).outgoingETransfers,after=F.currentPeriodAction(data.plan,x.asOf,opts).outgoingETransfers;
  assert.deepEqual(after,before);assert.equal(after.count,1);assert.equal(after.items[0].amount,17);assert.equal(F.startingCashAmount(data.plan),403);
  publicationControls.push({purchasePending:pending,outgoingCents:1700,count:after.count,status:after.status,publicationChanged:false,cashCents:40300});
}
const files=new Set(Object.keys(require.cache).filter(file=>file.startsWith(root+path.sep)).map(file=>path.relative(root,file).replace(/\\/g,'/')));
files.add('test/proof-card-purchase-posting.js');files.add('public/forecast-card-period.js');
const binding=captureSourceBinding(root,[...files],base);verifySourceBinding(root,binding);
console.log(JSON.stringify({outcome:'PASS',base,executionBinding:binding,independentCents:{purchase:8000,payment:8000,postedCash:50000-8000,postedDebt:40000+8000-8000,pendingPurchasePostedDebt:40000-8000,pendingAuthorization:8000},before:{controls:40,pass:4,fail:36},after:{controls:40,pass:40,fail:0},cases,publicationControls,qualification:'Observed cash/debt, physical card movements and current-main outgoing e-transfer publication unchanged. Unqualified coverage/holds intentionally change; no claim of whole-Forecast equality.'},null,2));
