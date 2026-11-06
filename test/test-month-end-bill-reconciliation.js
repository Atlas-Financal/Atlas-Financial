'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const fixture = require('./fixtures/month-end-bill-data');
const beforeBytes = fs.readFileSync(require.resolve('../data.json'));
function run(x) {
  const before = JSON.stringify(x);
  const r = Live.fromObservation(x);
  assert.equal(JSON.stringify(x), before);
  const packet = r.report.currentPeriodActuals;
  const advice = F.recommend(r.data.plan, x.asOf, { debts: r.data.debts, currentPeriodActuals: packet });
  const p = advice.payPeriodViews.find(p => p.start === '2026-09-18');
  const other = p.householdBudget.find(b => b.otherSpending);
  return { ...r, packet, p, other, bills: advice.defaultView.bills };
}
function bill(r,id) { return r.bills.find(b => b.id === id); }
for (const date of ['2026-09-29','2026-09-30']) {
  const r = run(fixture(date));
  for (const [id,amount] of [['tdfees',24],['google-storage-100gb',4]]) {
    const candidates = r.report.representedEventCandidates.filter(c => c.id === id);
    assert.equal(candidates.length,1);
    assert.equal(candidates[0].date,'2026-09-30','current fees never settle August instead');
    assert.equal(bill(r,id).status,'PAID'); assert.equal(bill(r,id).actual,amount);
    assert.equal(bill(r,id).remaining,0);
  }
  const fee = r.packet.representedActuals.find(a => a.id === 'tdfees');
  assert.equal(new Set(fee.transactionIds).size,2,'equal fee legs remain distinct');
  assert.equal(r.other.spent,7,'only invented overdraft fee remains');
  assert.equal(r.other.recon.length,1);
  // Independent cash ledger: Bills500-12=488; Weekly0-12-7-4=-23.
  assert.equal(r.p.fromTodayFunding.currentCash,465);
  assert.equal(r.p.fromTodayFunding.operatingBills,0);
  assert.equal(r.p.fromTodayFunding.availableNow,465,'posted costs already left observed cash');
  assert.deepEqual(run(fixture(date)).packet,r.packet,'replay does not duplicate evidence');
}
for (const category of ['Other bank fees','Overdraft fees','Insufficient funds','Foreign transaction fees']) {
  const x=fixture(); x.payload.transactions.push({id:82007,account_id:3001,date:'2026-09-29',amount:5,
    payee:'Invented extra fee',category_name:category,is_pending:false});
  x.payload.accounts[0].balance -= 5;
  const r=run(x); assert.equal(r.other.spent,12,'unmatched '+category+' is retained');
  assert.equal(r.other.recon.length,2);
  assert.equal(r.p.fromTodayFunding.currentCash,460);
}
for (const mutate of [
  x=>{x.payload.transactions=x.payload.transactions.filter(t=>t.id!==82002);},
  x=>{x.payload.transactions[1].account_id=3001;},
  x=>{x.payload.transactions[1].amount=-12;},
  x=>{x.payload.transactions[1].is_pending=true;},
  x=>{x.payload.transactions[1].payee='MONTHLY ACCOUNT FEE REVERSAL';},
  x=>{x.payload.transactionWindow.complete=false;x.payload.transactionWindow.truncated=true;}
]) {
  const x=fixture();mutate(x);const r=run(x);
  assert.equal(r.report.representedEventCandidates.some(c=>c.id==='tdfees'),false);
  assert.notEqual(bill(r,'tdfees').status,'PAID','incomplete/ambiguous pair never proves paid');
  assert.equal(bill(r,'tdfees').remaining,24);
}
for (const mutate of [
  t=>{t.original_name='Invented unrelated product';},
  t=>{delete t.original_name;},
  t=>{t.payee='Google Play';},
  t=>{t.account_id=3001;},
  t=>{t.amount=-4;t.payee='Google refund';}
]) {
  const x=fixture();const t=x.payload.transactions.find(t=>t.id===82006);mutate(t);const r=run(x);
  assert.equal(r.report.representedEventCandidates.some(c=>c.id==='google-storage-100gb'),false);
  assert.notEqual(bill(r,'google-storage-100gb').status,'PAID');
  assert.equal(bill(r,'google-storage-100gb').remaining,4);
}
const pending=fixture();pending.payload.transactions.forEach(t=>{if(t.id===82001||t.id===82002)t.is_pending=true;});
pending.payload.accounts[0].balance+=12;pending.payload.accounts[1].balance+=12;
const p=run(pending);assert.notEqual(bill(p,'tdfees').status,'PAID');
assert.equal(p.p.fromTodayFunding.status,'unavailable','unresolved pending cash cannot publish precise funding');
assert.equal(p.p.fromTodayFunding.contribution,null);
for (const id of [82001,82002]) {
  const posted=pending.payload.transactions.find(t=>t.id===id);
  posted.is_pending=false;
  posted.plaid_metadata={transaction_id:'posted-'+id,pending_transaction_id:'pending-'+id};
  pending.payload.transactions.push({...posted,id:id+100,is_pending:true,
    plaid_metadata:{transaction_id:'pending-'+id}});
}
pending.payload.accounts[0].balance-=12;pending.payload.accounts[1].balance-=12;
const replaced=run(pending);
assert.equal(bill(replaced,'tdfees').status,'PAID');
assert.equal(replaced.packet.transactions.length,6,'directed replacements are not extra expenses');
assert.equal(replaced.other.spent,7);
const negative=fixture();negative.payload.transactions.forEach(t=>{if(t.id===82001||t.id===82002)t.amount=-12;});
assert.equal(run(negative).report.representedEventCandidates.some(c=>c.id==='tdfees'),false);
const external=fixture();external.payload.transactions=external.payload.transactions.filter(t=>t.account_id===3005);
assert.equal(run(external).other?.spent || 0,0,'external fees are not household spend');
const duplicateGoogle=fixture();duplicateGoogle.payload.transactions.push({...duplicateGoogle.payload.transactions[5],id:82007});
assert.notEqual(bill(run(duplicateGoogle),'google-storage-100gb').status,'PAID','multiple compatible Google charges stay unconfirmed');
const early=run(fixture('2026-09-28'));
assert.notEqual(bill(early,'tdfees').status,'PAID','two-day early fee posting does not settle September');
assert.equal(bill(early,'google-storage-100gb').status,'PAID','two-day early storage posting settles the nearest month-end');
const tooEarly=run(fixture('2026-09-27'));
assert.notEqual(bill(tooEarly,'google-storage-100gb').status,'PAID','three-day early storage posting does not settle the upcoming month-end');
assert.equal(bill(tooEarly,'google-storage-100gb').remaining,4);

// Invented adjacent 30/31-day months. The preserved descriptor, not a new
// renamed-payee alias or recurring_id, supplies the incumbent product identity.
for (const asOf of ['2030-11-30','2030-12-31','2031-01-01']) {
  const x=fixture(); x.asOf=asOf; x.data.meta.asOf='2030-11-01';
  x.data.plan.opening={asOf:'2030-11-01'};
  x.data.plan.income[0].anchor='2030-11-01';
  x.data.plan.bills=x.data.plan.bills.filter(b=>b.id==='google-storage-100gb');
  x.payload.fetchedAt=asOf+'T18:00:00Z';
  x.payload.transactionWindow={startDate:'2030-11-01',endDate:asOf,complete:true,hasMore:false,truncated:false};
  x.payload.accounts.forEach(a=>{a.updated_at=asOf+'T17:00:00Z'; a.balance_last_update=asOf+'T17:00:00Z';});
  x.payload.transactions=[
    {id:94001,date:'2030-11-29',payee:'Google',recurring_id:null},
    {id:94002,date:'2030-12-29',payee:'Bill - Google One'},
  ].filter(t=>t.date<=asOf).map(t=>({account_id:3002,amount:4,currency:'cad',is_pending:false,
    category_name:'Online Purchases',original_name:'SERVICE _V',...t}));
  const before=JSON.stringify(x), r=Live.fromObservation(x), packet=r.report.currentPeriodActuals;
  const hits=r.report.representedEventCandidates.filter(c=>c.id==='google-storage-100gb');
  const expected=asOf==='2030-11-30'?['2030-11-30']:['2030-11-30','2030-12-31'];
  assert.deepEqual(hits.map(c=>c.date).sort(),expected);
  assert.equal(packet.representedActuals.filter(c=>c.id==='google-storage-100gb').length,expected.length);
  const advice=F.recommend(r.data.plan,asOf,{debts:r.data.debts,currentPeriodActuals:packet});
  const due=expected.at(-1);
  const paid=advice.defaultView.bills.find(b=>b.id==='google-storage-100gb'&&b.date===due);
  assert.equal(paid.status,'PAID'); assert.equal(paid.actual,4); assert.equal(paid.remaining,0);
  const action=F.currentPeriodAction(r.data.plan,asOf,{debts:r.data.debts,currentPeriodActuals:packet});
  assert.equal(action.excluded.bills,4,'current period excludes the represented storage debit once');
  assert.deepEqual(Live.fromObservation(x).report.currentPeriodActuals,packet,'replay does not duplicate either cycle');
  assert.equal(JSON.stringify(x),before);
}

// Native units qualify evidence independently of mapped account currency,
// numeric similarity, and Lunch Money's separate to_base FX estimate.
function assertCurrencyBlocked(x, eventId, planned, unrelatedId, unrelatedAmount) {
  const r=run(x);
  assert.equal(r.report.representedEventCandidates.some(c=>c.id===eventId),false);
  assert.equal(r.packet.representedActuals.some(c=>c.id===eventId),false);
  assert.notEqual(bill(r,eventId).status,'PAID');
  assert.equal(bill(r,eventId).remaining,planned,'unconfirmed obligation retains its reserve');
  assert.equal(bill(r,unrelatedId).actual,unrelatedAmount,'unrelated CAD evidence keeps its amount');
  assert.equal(r.packet.transactionCoverage,'incomplete');
  assert.ok(r.packet.currencyUnconfirmed.length);
  assert.ok(r.packet.currencyUnconfirmed.every(d=>!Object.hasOwn(d,'amount')),
    'unqualified raw money never enters published transaction evidence');
  assert.equal(r.p.fromTodayFunding.status,'unavailable');
  assert.equal(r.p.fromTodayFunding.contribution,null);
  assert.ok(r.p.fromTodayFunding.evidenceFailures.some(f=>f.code==='actuals-currency-unconfirmed'));
  assert.equal(r.data.plan.startingCash.breakdown.reduce((n,a)=>n+a.value,0),465,
    'observed cash remains actual cash');
  assert.deepEqual(run(x).packet,r.packet);
  return r;
}
for (const currency of ['usd','eur',undefined,null,'']) {
  const storage=fixture();const t=storage.payload.transactions.find(t=>t.id===82006);
  t.currency=currency;t.amount=2.45;t.to_base=3.49;
  const s=assertCurrencyBlocked(storage,'google-storage-100gb',4,'tdfees',24);
  assert.equal(s.packet.transactions.some(t=>t.amount===2.45),false);
  const fees=fixture();const a=fees.payload.transactions[0],b=fees.payload.transactions[1];
  a.currency=currency;a.amount=7.23;a.to_base=10.11;b.amount=9.87;
  assertCurrencyBlocked(fees,'tdfees',24,'google-storage-100gb',4);
}
const cadCase=fixture();cadCase.payload.transactions.forEach(t=>{t.currency=' CAD ';t.to_base=999;});
assert.equal(bill(run(cadCase),'tdfees').actual,24,'CAD native amounts are not replaced by to_base');
assert.equal(bill(run(cadCase),'google-storage-100gb').actual,4);

function addReplacement(x,id,pendingCurrency,postedCurrency,keepPostedIdentity=false) {
  const post=x.payload.transactions.find(t=>t.id===id);
  const pend={...post,id:id+100,is_pending:true,currency:pendingCurrency,
    plaid_metadata:{transaction_id:'native-pending-'+id}};
  post.currency=postedCurrency;post.to_base=999;
  post.plaid_metadata={transaction_id:'native-posted-'+id,pending_transaction_id:'native-pending-'+id};
  if (!keepPostedIdentity) { post.payee='Invented posted descriptor';delete post.original_name; }
  x.payload.transactions.push(pend);
}
for (const [pendingCurrency,postedCurrency] of [
  ['cad','usd'],['usd','cad'],['cad',undefined],[undefined,'cad'],['usd','usd']
]) {
  for (const keepPostedIdentity of [false,true]) {
    const x=fixture();addReplacement(x,82006,pendingCurrency,postedCurrency,keepPostedIdentity);
    assertCurrencyBlocked(x,'google-storage-100gb',4,'tdfees',24);
  }
  const fees=fixture();addReplacement(fees,82001,pendingCurrency,postedCurrency,true);
  assertCurrencyBlocked(fees,'tdfees',24,'google-storage-100gb',4);
}
const cadReplacement=fixture();addReplacement(cadReplacement,82006,'cad','cad');
const cr=run(cadReplacement);assert.equal(bill(cr,'google-storage-100gb').actual,4);
assert.equal(cr.packet.transactions.length,6,'qualified pending replacement remains one expense');
assert.equal(cr.other.spent,7);assert.equal(cr.p.fromTodayFunding.availableNow,465);
const pendingForeign=fixture();const pf=pendingForeign.payload.transactions.find(t=>t.id===82006);
pf.is_pending=true;pf.currency='usd';pf.to_base=5.50;
assertCurrencyBlocked(pendingForeign,'google-storage-100gb',4,'tdfees',24);
// A scoped settlement currency guard does not declare unrelated foreign
// credits or absent occurrences to be failed settlement evidence.
for (const mutate of [
  t=>{t.amount=-4;t.category_name='Refund';},
  t=>{t.amount=0;},
  t=>{t.payee='Google Play';},
  t=>{t.account_id=3001;},
  t=>{t.original_name='Unrelated product';},
]) {
  const x=fixture(),t=x.payload.transactions.find(t=>t.id===82006);
  t.currency='usd';mutate(t);const r=run(x);
  assert.equal(r.packet.currencyUnconfirmed.length,0,'noncandidate is not a scoped currency failure');
  assert.equal(r.packet.transactionCoverage,'complete');
  assert.notEqual(bill(r,'google-storage-100gb').status,'PAID');
  assert.equal(r.p.fromTodayFunding.status,'ready','unrelated row cannot withhold qualified funding');
}
const absentOccurrence=fixture();
absentOccurrence.data.plan.bills=absentOccurrence.data.plan.bills.filter(b=>b.id!=='google-storage-100gb');
absentOccurrence.payload.transactions.find(t=>t.id===82006).currency='usd';
assert.equal(run(absentOccurrence).packet.currencyUnconfirmed.length,0,
  'matching merchant/account without a scheduled occurrence is not settlement evidence');
const onceExpired=fixture();
Object.assign(onceExpired.data.plan.bills.find(b=>b.id==='google-storage-100gb'),
  {frequency:'once',date:'2026-08-01'});
onceExpired.payload.transactions.find(t=>t.id===82006).currency='usd';
assert.equal(run(onceExpired).packet.currencyUnconfirmed.length,0,'expired occurrence is not a candidate');
for (const id of [82001,82002]) {
  const x=fixture();const t=x.payload.transactions.find(t=>t.id===id);
  t.currency='usd';t.amount=-12;
  assert.equal(run(x).packet.currencyUnconfirmed.length,0,'fee credit cannot settle a debit occurrence');
}
for (const keepPostedIdentity of [false,true]) {
  const x=fixture(),t=x.payload.transactions.find(t=>t.id===82006);
  t.amount=-4;t.category_name='Refund';
  addReplacement(x,82006,'usd','cad',keepPostedIdentity);
  const r=run(x);
  assert.equal(r.packet.currencyUnconfirmed.length,0,'noncandidate replacement cannot stamp a currency failure');
  assert.equal(r.packet.transactionCoverage,'complete');
  assert.equal(r.p.fromTodayFunding.status,'ready');
}
assert.deepEqual(fs.readFileSync(require.resolve('../data.json')),beforeBytes);
console.log('PASS independent month-end fee/storage identity, ledger, extras, pending, refunds and coverage');
