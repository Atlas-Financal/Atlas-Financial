'use strict';
// Real factory/adapter/store/HTTP constructors; SQL, TLS, custody and Express
// transport below are OFFLINE DOUBLES. No driver, network or custody proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const vm = require('node:vm');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { makeExclusionWorld } = require('./test-settlement-evidence-terminal-certificate');
const load = () => require(path.join(ROOT, 'scripts/settlement-evidence-postgres-runtime'))
  .createSettlementEvidencePostgresRuntime;
const host = 'db.example.test', CANARY = 'PUBLIC-DUMMY-SECRET-CANARY';
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const turn = () => new Promise(r => setImmediate(r));
// Budgets are real wall-clock timers in the connection module. A double that
// completes must always beat its budget, even when a loaded CI host stalls this
// process, so the fixture uses the module's maximum budgets. A test that needs a
// budget to expire uses a double that never settles (HUNG_CLOSE below) or mocked
// timers; it never relies on a slow host losing a race against a short timer.
const BUDGETS = Object.freeze({connect:10000,preflight:10000,query:7000,close:2000});
const HUNG_CLOSE = 20; // only for end() doubles that never settle: expiry is certain.
function world(hooks = {}) {
  const w = makeExclusionWorld(); // Explicitly simulated independent pin/archive/history.
  Object.assign(w, { clients:[], queries:[], ends:0, connects:0 });
  const metadata = [
    [{database:'synthetic',user:'synthetic_app',pid:314,searchPath:'pg_catalog'}],
    [{canLogin:true,superuser:false,createDb:false,createRole:false,inherit:false,
      replication:false,bypassRls:false,connectionLimit:1,memberships:0,ownedObjects:0}],
    [{connect:true,schemaUsage:true,databaseCreate:false,schemaCreate:false,tables:true,functions:true}],
    ['doc_head','doc_staged','journal','quarantine'].map(name => ({name,kind:'r',persistence:'p',
      rls:false,forceRls:false,unsafe:false,primaryKeyCount:1,
      columns:(name==='quarantine'?['scope','name','label','bytes']:['scope','bytes']).map(name =>
        ({name,type:name==='bytes'?'bytea':'text',notNull:name!=='label',generated:''})),
      primaryKey:name==='quarantine'?['scope','name']:['scope']}))
  ];
  if(hooks.native)metadata[3].push({name:'terminal_history',kind:'r',persistence:'p',rls:false,forceRls:false,
    unsafe:false,primaryKeyCount:1,columns:['scope','history_bytes','checkpoint_bytes'].map(name=>({name,
      type:name==='scope'?'text':'bytea',notNull:true,generated:''})),primaryKey:['scope']});
  class Client extends EventEmitter {
    constructor() { super(); w.clients.push(this); this.connection={stream:{encrypted:true,authorized:true,
      servername:host,getPeerCertificate:()=>({subjectaltname:'DNS:'+host})}};
      if(hooks.tls)Object.assign(this.connection.stream,hooks.tls);
      if(hooks.construct)hooks.construct(); }
    async connect() {w.connects++;if(hooks.connect)await hooks.connect();}
    async end() {w.ends++;if(hooks.end)await hooks.end();this.emit('end');}
    async query(text, values) {
      const index=w.queries.length;w.queries.push(text);
      if(hooks.query){const result=await hooks.query(text,index);if(result!==undefined)return result;}
      if(index<4)return {command:'SELECT',rows:metadata[index]};
      const result=(rows=[],rowCount=0)=>({command:text.split(' ')[0],rows,rowCount});
      if(/pg_try_advisory_lock/.test(text))return result([{locked:true}]);
      if(/pg_advisory_unlock/.test(text))return result([{unlocked:true}]);
      if(/pg_backend_pid/.test(text))return result([{pid:314}]);
      if(['BEGIN','COMMIT','ROLLBACK'].includes(text))return result();
      if(/^SELECT history_bytes, checkpoint_bytes FROM/.test(text))return result(w.historyBytes?[{
        history_bytes:Buffer.from(w.historyBytes),checkpoint_bytes:Buffer.from(JSON.stringify(w.checkpoint))}]:[]);
      if(/^UPDATE .*\.terminal_history SET history_bytes/.test(text)){
        const match=w.historyBytes.equals(values[3])&&Buffer.from(JSON.stringify(w.checkpoint)).equals(values[4]);
        if(match){w.historyBytes=Buffer.from(values[1]);w.checkpoint=JSON.parse(values[2]);}return result([],match?1:0);
      }
      if(/^SELECT bytes FROM/.test(text)){
        const field=text.includes('.doc_head')?'doc':text.includes('.journal')?'journal':'temp';
        return result(w[field]?[{bytes:Buffer.from(w[field])}]:[]);
      }
      if(/^WITH s AS/.test(text)){w.doc=w.temp;w.temp=null;return result([],1);}
      if(/^INSERT INTO/.test(text)){
        const field=text.includes('.doc_staged')?'temp':'journal';w[field]=Buffer.from(values[1]);return result([],1);
      }
      if(/^DELETE FROM/.test(text)){w[text.includes('.journal')?'journal':'temp']=null;return result([],1);}
      throw Error('unmodelled SQL');
    }
  }
  w.options = {connection:{Client,config:{host,port:5432,database:'synthetic',user:'synthetic_app',
    password:CANARY,ssl:{rejectUnauthorized:true,servername:host}},schema:'synthetic_state',scope:'synthetic-scope',
    timeouts:{...BUDGETS}},
    custody:{pinStore:w.adapters.pinStore,backupStore:w.adapters.backupStore,
      terminalHistory:w.terminalHistory,exclusionDomain:w.domain},
    application:{householdId:JSON.parse(w.doc).householdId,origin:'https://atlas.example.test',
      authorize:async c=>({householdId:JSON.parse(w.doc).householdId,actorId:c.actorId}),
      acquire:async()=>{throw Error('unused acquisition double');},contextReader:()=>({}),
      readBase:async()=>({}),now:()=>w.time}};
  w.construct=()=>load()(w.options);
  w.start=async()=>{const r=w.construct();await r.connect();return r;};
  w.prepare=r=>w.prepareRuntime(r);
  w.prepareRuntime=r=>r.settlement.store.prepare({actorId:'session-'+'b'.repeat(64),
    operationId:'operation-'+'1'.repeat(32),command:w.command()});
  return w;
}
function unavailable(error) {
  assert.equal(error.code,'SETTLEMENT_RUNTIME_UNAVAILABLE');assert.ok(!JSON.stringify(error).includes(CANARY));return true;
}

const recordedActor = 'session-'+'b'.repeat(64), laterActor = 'session-'+'c'.repeat(64);
function optIn(w, overrides = {}) {
  w.options.recovery = {recoveryRead:true,
    authorizeRecovery:async ({householdId,actorId,operationId})=>({householdId,actorId,operationId}),
    finalDisclosureAuthorize:()=>true,...overrides};
  return w;
}
// The REAL HTTP/controller/resolver/store are used. Only Express routing and
// response serialization are offline doubles; no socket is opened here.
function http(r, actor = laterActor) {
  const routes = new Map(), middleware = [];
  const router={use(fn){middleware.push(fn);},post(route,fn){routes.set(route,fn);},get(){}};
  const filename=path.join(ROOT,'scripts/settlement-evidence-http.js');
  const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  const normal=m.require.bind(m);m.require=id=>id==='express'?{Router:()=>router,json:()=> (_q,_s,next)=>next()}:normal(id);
  m._compile(fs.readFileSync(filename,'utf8'),filename);
  const bridge=m.exports.mountSettlementHttp({use(){}},()=>actor,r.settlement);
  return {bridge,async post(route,body){
    const req={body,method:'POST',originalUrl:'/settlement'+route,
      get:name=>({'Origin':r.settlement.origin,'X-Atlas-Settlement':'same-origin',
        'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'}[name])};
    let status=200,result,serializations=0;
    const res={set(){return res;},status(n){status=n;return res;},json(x){
      serializations++;result=JSON.parse(JSON.stringify(x));return res;}};
    for(const fn of middleware.filter(fn=>fn.length===3)){
      let next=false;await fn(req,res,()=>{next=true;});if(!next)return {status,result,serializations};
    }
    await routes.get(route)(req,res);return {status,result,serializations};
  }};
}
async function committed(w,r) {
  const prepared=await w.prepare(r),receipt=await r.settlement.commitAdmitted(w.input(prepared),()=>true);
  assert.equal(receipt.status,'committed');return {receipt,operationId:receipt.operationId};
}

test('EC7 absence preserves configured keys and same-actor receipt without recovery',async()=>{
  const w=world(),r=w.construct();
  assert.deepEqual(Object.keys(r.settlement).sort(),['acquire','authorize','commitAdmitted','contextReader',
    'householdId','now','origin','readBase','readDocument','readPin','store']);
  assert.equal(r.settlement.store.recoveryRead,undefined);assert.equal(w.connects,0);
  await r.connect();const {receipt,operationId}=await committed(w,r),{actorId,...publicReceipt}=receipt;
  assert.equal(actorId,recordedActor);
  assert.deepEqual((await http(r,recordedActor).post('/outcome',{operationId})).result,publicReceipt);
  assert.equal((await http(r).post('/outcome',{operationId})).result.status,'unknown');
  await r.retire();
});

function nativeRuntimeWorld(hooks={}){const w=world({native:true,...hooks});w.options.custody.terminalHistory={mode:'postgres'};return w;}
test('N runtime native explicit selection is inert and retains default settlement keys',()=>{
  const w=nativeRuntimeWorld(),r=w.construct();assert.equal(w.clients.length,0);assert.equal(w.queries.length,0);
  assert.deepEqual(Object.keys(r.settlement).sort(),['acquire','authorize','commitAdmitted','contextReader',
    'householdId','now','origin','readBase','readDocument','readPin','store']);
  assert.equal(r.settlement.store.recoveryRead,undefined);
});
test('N runtime malformed mixed native selection refuses before Client construction',()=>{
  for(const selection of [{mode:'other'},{mode:'postgres',readSnapshot(){}},{mode:'postgres',extra:true},
    {mode:true},'postgres',null]){
    const w=world();w.options.custody.terminalHistory=selection;assert.throws(w.construct);assert.equal(w.clients.length,0);
  }
  let reads=0;const w=world();w.options.custody.terminalHistory=Object.defineProperty({},'mode',{enumerable:true,get(){reads++;return 'postgres';}});
  assert.throws(w.construct);assert.equal(reads,0);assert.equal(w.clients.length,0);
});
test('N runtime real store preserves negative checkpoint/digest, exact generation and positive receipt',async()=>{
  const w=nativeRuntimeWorld();optIn(w);const r=await w.start(),p=await w.prepare(r);
  const sealed=await w.seal(r.settlement.store,p);assert.equal(sealed.status,'certified');
  const snapshot=JSON.parse(w.historyBytes);assert.equal(snapshot.records.length,1);
  assert.equal(snapshot.records[0].confirmationDigest,p.confirmationDigest);assert.equal(w.checkpoint.digest,snapshot.digest);
  const negative=await r.settlement.store.recoveryRead({operationId:p.preview.operationId,generation:sealed.certificate.generation});
  assert.deepEqual(negative,{status:'not-applied',operationId:p.preview.operationId,generation:sealed.certificate.generation,confirmationDigest:p.confirmationDigest});
  assert.equal((await r.settlement.store.recoveryRead({operationId:p.preview.operationId,generation:'generation-'+'f'.repeat(32)})).status,'unknown');
  assert.notEqual((await r.settlement.commitAdmitted(w.input(p),()=>true)).status,'committed');
  const p2=await r.settlement.store.prepare({actorId:recordedActor,operationId:'operation-'+'2'.repeat(32),command:w.command(2)});
  const receipt=await r.settlement.commitAdmitted(w.input(p2),()=>true);assert.equal(receipt.status,'committed');
  assert.equal((await r.settlement.store.recoveryRead({operationId:receipt.operationId})).requestDigest,p2.confirmationDigest);
  assert.equal(w.clients.length,1);assert.equal(w.connects,1);assert(w.queries.some(t=>/^UPDATE .*terminal_history/.test(t)));
  await r.retire();assert.equal(w.ends,1);
});
test('N runtime missing provisioned native history cannot authorize prepare or invent genesis',async()=>{
  const w=nativeRuntimeWorld();w.historyBytes=null;const r=await w.start();const p=await w.prepare(r);
  assert.equal(p.status,'unavailable');assert.equal(w.historyBytes,null);
  assert(!w.queries.some(t=>/^INSERT INTO .*terminal_history|^UPDATE .*terminal_history/.test(t)));await r.retire();
});
test('N runtime retirement across native history await suppresses result and retires once',async()=>{
  const reached=defer(),release=defer();let block=false;
  const w=nativeRuntimeWorld({query:async text=>{if(block&&/^SELECT history_bytes/.test(text)){reached.resolve();await release.promise;}}});
  const r=await w.start();block=true;const pending=w.prepare(r);pending.catch(()=>{});await reached.promise;
  const report=await r.retire();assert.equal(report.close,'confirmed');const count=w.queries.length;release.resolve();
  await assert.rejects(pending,unavailable);await turn();assert.equal(w.queries.length,count);assert.equal(w.ends,1);
});
test('N runtime native negative survives modeled new-client restart and public outcome excludes digest',async()=>{
  const w=nativeRuntimeWorld();optIn(w);const writer=await w.start(),prepared=await w.prepare(writer);
  const seal=await w.seal(writer.settlement.store,prepared);assert.equal(seal.status,'certified');await writer.retire();
  // This is a new modeled session/runtime in this process, NOT real restart or
  // independent checkpoint custody. The SQL/custody state below is copied.
  const other=nativeRuntimeWorld();other.historyBytes=Buffer.from(w.historyBytes);other.checkpoint=structuredClone(w.checkpoint);
  other.doc=Buffer.from(w.doc);other.pin=structuredClone(w.pin);other.backups=new Map(w.backups);
  other.options.custody.exclusionDomain=w.domain;optIn(other);const reader=await other.start();
  const selector={operationId:prepared.preview.operationId,generation:seal.certificate.generation};
  assert.deepEqual((await http(reader).post('/outcome',selector)).result,{status:'not-applied',...selector});
  assert.equal((await http(reader).post('/outcome',{...selector,generation:'generation-'+'f'.repeat(32)})).result.status,'unknown');
  assert.equal(other.connects,1);await reader.retire();assert.equal(other.ends,1);
});
test('N runtime failed and unconfirmed native close preserve retirement uncertainty',async()=>{
  for(const close of ['failed','unconfirmed']){
    const w=nativeRuntimeWorld({end:()=>close==='failed'?Promise.reject(Error(CANARY)):new Promise(()=>{})});
    if(close==='unconfirmed')w.options.connection.timeouts.close=HUNG_CLOSE;
    const r=await w.start();const report=await r.retire();assert.equal(report.close,close);assert.equal(report.state,'lost');
    assert.equal(w.ends,1);assert.throws(()=>r.settlement.store.outcome({operationId:'operation-'+'1'.repeat(32),actorId:recordedActor}),unavailable);
    assert(!JSON.stringify(report).includes(CANARY));
  }
});
test('EC7 validates complete opt-in before Client or callback construction I/O',()=>{
  for(const mutate of [o=>o.recovery=null,o=>o.recovery={},o=>o.recovery.recoveryRead=false,
    o=>o.recovery.recoveryRead='true',o=>delete o.recovery.authorizeRecovery,
    o=>delete o.recovery.finalDisclosureAuthorize,o=>o.recovery.authorizeRecovery=true,
    o=>o.recovery.finalDisclosureAuthorize=null,o=>o.recovery.extra=true,
    o=>Object.defineProperty(o.recovery,'authorizeRecovery',{get(){throw Error(CANARY);}})]){
    const w=optIn(world());mutate(w.options);assert.throws(w.construct,TypeError);assert.equal(w.clients.length,0);
  }
  let calls=0;const fail=()=>{calls++;throw Error(CANARY);};
  const w=optIn(world(),{authorizeRecovery:fail,finalDisclosureAuthorize:fail}),r=w.construct();
  assert.equal(calls,0);assert.equal(w.clients.length,0);assert.equal(w.queries.length,0);
  assert.equal(typeof r.settlement.store.recoveryRead,'function');
  assert.equal(r.settlement.store.bootstrap,undefined);assert.equal(r.settlement.store.reconcile,undefined);
});
test('EC7 real runtime/store/controller/HTTP recover commit without private receipt fields',async()=>{
  const calls=[],w=optIn(world(),{authorizeRecovery:async input=>{calls.push(input);
    const {householdId,actorId,operationId}=input;return {householdId,actorId,operationId};}});
  w.options.application.readBase=async()=>({meta:{asOf:'2026-10-20'},debts:[],
    plan:{defaults:{},startingCash:{},income:[],bills:[],obligations:[],commitments:[]}});
  const r=await w.start();
  // Mutating the caller's record after construction cannot replace policy.
  w.options.recovery.authorizeRecovery=()=>{throw Error(CANARY);};
  const {receipt,operationId}=await committed(w,r),doc=Buffer.from(w.doc),pin={...w.pin},before=w.queries.length;
  const result=await http(r).post('/outcome',{operationId});
  assert.deepEqual(result,{status:200,result:{status:'committed',operationId},serializations:1});
  const publication=await http(r).post('/publication',{operationId});
  assert.equal(publication.status,200);assert.equal(publication.result.status,'committed');
  assert.equal(publication.result.publication,'included');
  assert.equal(publication.result.data.settlementEvidenceStatus.status,'qualified');
  assert.ok(calls.length>=6);assert.ok(calls.every(x=>x.actorId===laterActor&&x.operationId===operationId));
  const json=JSON.stringify([result,publication,calls]);
  for(const secret of [recordedActor,CANARY,receipt.digest])assert.ok(!json.includes(secret));
  assert.deepEqual(w.doc,doc);assert.deepEqual(w.pin,pin);
  assert.ok(w.queries.slice(before).every(q=>/^SELECT|^BEGIN|^COMMIT/.test(q)));
  await r.retire();
});
test('EC7 opted-in same-actor receipts and sealed negative recovery retain incumbent shapes',async()=>{
  const w=optIn(world()),r=await w.start(),{receipt,operationId}=await committed(w,r);
  const {actorId,...publicReceipt}=receipt;assert.equal(actorId,recordedActor);
  assert.deepEqual((await http(r,recordedActor).post('/outcome',{operationId})).result,publicReceipt);
  await r.retire();
  const negative=optIn(world()),reader=await negative.start(),prepared=await negative.prepare(reader);
  const claim=negative.claim(prepared);
  assert.equal((await reader.settlement.store.terminalExclusion.sealNegative(claim)).status,'certified');
  const input={operationId:prepared.preview.operationId,generation:claim.generation};
  assert.deepEqual((await http(reader).post('/outcome',input)).result,{status:'not-applied',...input});
  // The incumbent publication route takes operationId only; do not widen it.
  assert.equal((await http(reader).post('/publication',input)).status,400);
  assert.equal((await http(reader).post('/publication',{operationId:input.operationId})).result.status,'unknown');
  assert.equal((await http(reader).post('/outcome',{...input,generation:'generation-'+'e'.repeat(32)})).result.status,'unknown');
  await reader.retire();
});
test('EC7 HTTP final predicate malformed/throw/Promise verdicts never disclose',async()=>{
  let touched=0,verdict,throws=false;
  const w=optIn(world(),{finalDisclosureAuthorize:()=>{if(throws)throw Error(CANARY);return verdict;}});
  const r=await w.start(),{operationId}=await committed(w,r);
  for(const make of [()=>false,()=>undefined,()=>1,()=>({}),
    ()=>Object.defineProperty({},'then',{get(){touched++;throw Error(CANARY);}}),
    ()=>Promise.resolve(true),()=>Promise.reject(Error(CANARY)),()=>{throws=true;}]){
    verdict=make();assert.deepEqual(await http(r).post('/outcome',{operationId}),
      {status:503,result:{status:'unavailable'},serializations:1});
  }
  assert.equal(touched,0);await turn();await r.retire();
});
for(const state of ['before-connect','retired','session-error','session-end'])
test('EC7 recovery capabilities refuse '+state,async()=>{
  let calls=0;const w=optIn(world(),{authorizeRecovery:()=>{calls++;return {};},
    finalDisclosureAuthorize:()=>{calls++;return true;}}),r=w.construct();
  if(state!=='before-connect')await r.connect();
  if(state==='retired')await r.retire();
  if(state==='session-error')w.clients[0].emit('error',Error(CANARY));
  if(state==='session-end')w.clients[0].emit('end');
  assert.throws(()=>r.settlement.store.recoveryRead({}),unavailable);
  assert.throws(()=>r.settlement.authorizeRecovery({}),unavailable);
  assert.throws(()=>r.settlement.finalDisclosureAuthorize({}),unavailable);
  assert.equal(calls,0);await r.retire();
});
for(const pending of ['policy','store'])test('EC7 retirement suppresses pending '+pending+' result',async()=>{
  const gate=defer(),entered=defer(),w=optIn(world());
  if(pending==='policy')w.options.recovery.authorizeRecovery=()=>{entered.resolve();return gate.promise;};
  const r=await w.start(),{operationId}=await committed(w,r);
  if(pending==='store')w.hooks.pinRead=()=>{entered.resolve();return gate.promise;};
  const result=pending==='policy'?r.settlement.authorizeRecovery({}):r.settlement.store.recoveryRead({operationId});
  const rejected=assert.rejects(result,unavailable);await entered.promise;await r.retire();
  const queries=w.queries.length;gate.resolve({...w.pin});await rejected;
  assert.equal(w.queries.length,queries);assert.equal(w.ends,1);
});
test('EC7 retirement across HTTP recovery authorization suppresses serialization',async()=>{
  const gate=defer(),entered=defer(),w=optIn(world(),{authorizeRecovery:()=>{entered.resolve();return gate.promise;}});
  const r=await w.start(),{operationId}=await committed(w,r),pending=http(r).post('/outcome',{operationId});
  await entered.promise;await r.retire();gate.resolve({householdId:w.options.application.householdId,actorId:laterActor,operationId});
  assert.deepEqual(await pending,{status:503,result:{status:'unavailable'},serializations:1});
});
test('EC7 synchronous final predicate accepts only exact true without touching thenables',async()=>{
  let touched=0,verdict=true;
  const w=optIn(world(),{finalDisclosureAuthorize:()=>verdict}),r=await w.start();
  assert.equal(r.settlement.finalDisclosureAuthorize({}),true);
  for(const invalid of [false,null,undefined,1,'true',{},Object.defineProperty({},'then',{get(){touched++;throw Error(CANARY);}})]){
    verdict=invalid;assert.notEqual(r.settlement.finalDisclosureAuthorize({}),true);
  }
  assert.equal(touched,0);await r.retire();
});
test('EC7 native Promise refusal contains rejection without supplied then/catch reads',async()=>{
  for(const foreign of [false,true])for(const retiring of [false,true]){
    let r,touched=0;
    const w=optIn(world(),{finalDisclosureAuthorize:()=>{
      const value=foreign?vm.runInNewContext('Promise.reject(new Error("PUBLIC-DUMMY-SECRET-CANARY"))')
        :Promise.reject(Error(CANARY));
      for(const key of ['then','catch'])Object.defineProperty(value,key,{get(){touched++;throw Error(CANARY);}});
      if(retiring)r.retire();return value;
    }});
    r=await w.start();
    if(retiring)assert.throws(()=>r.settlement.finalDisclosureAuthorize({}),unavailable);
    else assert.notEqual(r.settlement.finalDisclosureAuthorize({}),true);
    await turn();assert.equal(touched,0);await r.retire();assert.equal(w.ends,1);
  }
});
for(const loss of ['retire','error','end'])test('EC7 reentrant '+loss+' in synchronous predicate cannot disclose',async()=>{
  let r;const w=optIn(world(),{finalDisclosureAuthorize:()=>{
    if(loss==='retire')r.retire();else w.clients[0].emit(loss,Error(CANARY));return true;}});
  r=await w.start();const {operationId}=await committed(w,r),queries=w.queries.length;
  const result=await http(r).post('/outcome',{operationId});
  assert.deepEqual(result,{status:503,result:{status:'unavailable'},serializations:1});
  await r.retire();assert.equal(w.ends,1);assert.equal(w.connects,1);
  const count=w.queries.length;assert.ok(count>=queries);
  assert.throws(()=>r.settlement.finalDisclosureAuthorize({}),unavailable);assert.equal(w.queries.length,count);
});
test('default construction and retirement perform zero I/O and expose no settlement',async()=>{
  const r=load()();assert.equal(r.settlement,undefined);assert.equal(r.status().state,'disconnected');
  assert.deepEqual(Object.keys(r).sort(),['connect','retire','settlement','status']);
  assert.equal((await r.retire()).close,'not-opened');await assert.rejects(r.connect(),unavailable);
});
test('construction validates all application/custody dependencies before any Client',()=>{
  for(const mutate of [o=>delete o.application.authorize,o=>o.application.origin+='/',
    o=>delete o.custody.backupStore.get,o=>delete o.custody.terminalHistory,
    o=>o.custody.exclusionDomain={bad:true},o=>o.unrecognized=1]){
    const w=world();mutate(w.options);assert.throws(w.construct,TypeError);assert.equal(w.clients.length,0);
  }
  const w=world();Object.defineProperty(w.options.application,'authorize',{get(){throw Error(CANARY);}});
  assert.throws(w.construct,e=>!String(e).includes(CANARY));assert.equal(w.clients.length,0);
});
test('explicit single connect owns one session and only supplies incumbent consumer capabilities',async()=>{
  const w=world(),r=w.construct();assert.equal(w.connects,0);
  assert.throws(r.settlement.readDocument,unavailable);
  const a=r.connect(),b=r.connect();assert.equal(a,b);await a;
  assert.equal(r.status().state,'ready');assert.equal(w.connects,1);assert.equal(w.queries.length,4);
  assert.equal(r.settlement.query,undefined);assert.equal(r.settlement.store.bootstrap,undefined);
  assert.equal(r.settlement.store.reconcile,undefined);assert.equal(r.settlement.store.commit,undefined);
  assert.ok(r.settlement.store.terminalExclusion);assert.ok(Object.isFrozen(r.settlement));
  assert.equal(r.retire(),r.retire());await r.retire();assert.equal(w.ends,1);
  await assert.rejects(r.connect(),unavailable);assert.equal(w.connects,1);
});
test('actual HTTP consumer constructs its real resolver/controller/readers over composed store',async()=>{
  const w=world(),r=await w.start();
  // Only Express routing is stubbed; load the unchanged real HTTP module.
  const filename=path.join(ROOT,'scripts/settlement-evidence-http.js');
  const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  const normal=m.require.bind(m),router={use(){},post(){},get(){}};
  m.require=id=>id==='express'?{Router:()=>router,json:()=>()=>{}}:normal(id);m._compile(fs.readFileSync(filename,'utf8'),filename);
  const bridge=m.exports.mountSettlementHttp({use(){}},()=> 'session-'+'b'.repeat(64),r.settlement);
  assert.equal(bridge.active,true);
  const base={plan:{commitments:[]},settlementEvidence:{stale:true}};
  const data=await bridge.browserData({},async()=>base,x=>x);
  assert.equal(data.settlementEvidenceStatus.status,'qualified');
  assert.notEqual(data.settlementEvidence,base.settlementEvidence);
  await r.retire();let published=false;
  await assert.rejects(bridge.browserData({},async()=>base,()=>{published=true;}),
    e=>e.code==='settlement-browser-unavailable');assert.equal(published,false);
});
test('real store commits and returns the exact original qualified receipt with custody doubles',async()=>{
  const w=world(),r=await w.start(),p=await w.prepare(r);assert.ok(p.preview);
  const input=w.input(p),receipt=await r.settlement.commitAdmitted(input,()=>true);
  assert.equal(receipt.status,'committed');assert.equal(receipt.revision,1);
  const {actorId,...publicReceipt}=receipt;
  assert.equal(actorId,input.actorId);
  assert.deepEqual(await r.settlement.store.outcome({actorId:input.actorId,operationId:p.preview.operationId}),publicReceipt);
  assert.deepEqual(await r.settlement.commitAdmitted(input,()=>{throw Error('must not re-admit');}),receipt);
  assert.equal(w.pin.revision,1);assert.equal(w.journal,null);assert.equal(w.temp,null);await r.retire();
});
for(const stage of ['connect','tls','identity','role','privileges','schema'])test('failed '+stage+' never publishes a session',async()=>{
  const hooks=stage==='connect'?{connect:()=>{throw Object.assign(Error(CANARY),{code:'ECONNRESET'});}}
    :stage==='tls'?{tls:{authorized:false}}
    :{query:(_t,i)=>i===['identity','role','privileges','schema'].indexOf(stage)?{command:'SELECT',rows:[]}:undefined};
  const w=world(hooks),r=w.construct();await assert.rejects(r.connect(),e=>{
    assert.ok(!String(e).includes(CANARY));assert.equal(e.diagnostic.stage,stage);return true;});
  assert.notEqual(r.status().state,'ready');await r.retire();assert.equal(w.ends,1);
  assert.throws(r.settlement.readDocument,unavailable);assert.equal(w.connects,1);
});
test('retirement during pending connect fences late success and waits for sole close',async()=>{
  const gate=defer(),w=world({connect:()=>gate.promise}),r=w.construct(),opening=r.connect();
  await turn();const retiring=r.retire();gate.resolve();await assert.rejects(opening,unavailable);
  assert.equal((await retiring).close,'confirmed');assert.equal(w.ends,1);assert.equal(w.connects,1);
});
test('late connect timeout retains factory primary and does not reconnect',async t=>{
  // The connect budget expires only once connect is provably in flight: the
  // budget timer is mocked, so a host stall cannot expire it before connect
  // starts (which would test an unopened connect instead of a late one).
  const gate=defer(),entered=defer();
  const w=world({connect:()=>{entered.resolve();return gate.promise;}});
  t.mock.timers.enable({apis:['setTimeout']});
  const r=w.construct(),opening=r.connect();opening.catch(()=>{});
  await entered.promise;assert.equal(w.connects,1);
  // The expired connect retires the session; its close waits on the still
  // pending connect, so the close budget must expire too (unconfirmed).
  t.mock.timers.tick(BUDGETS.connect);await turn();t.mock.timers.tick(BUDGETS.close);
  await assert.rejects(opening,e=>e.diagnostic.category==='timeout');
  const report=await r.retire();assert.equal(report.close,'unconfirmed');gate.resolve();await turn();
  assert.equal(w.ends,1);assert.equal(w.connects,1);assert.notEqual(r.status().state,'ready');
});
for(const event of ['error','end','query'])test(event+' loss permanently fences all capabilities',async()=>{
  let rejectQuery=false;
  const w=world({query:(_t,i)=>{if(rejectQuery&&i>=4)throw Object.assign(Error(CANARY),{code:'ECONNRESET'});}}),r=await w.start();
  if(event==='query'){rejectQuery=true;await assert.rejects(r.settlement.readDocument(),unavailable);}
  else w.clients[0].emit(event,Object.assign(Error(CANARY),{code:'ECONNRESET'}));
  await r.retire();const count=w.queries.length;
  assert.throws(r.settlement.readPin,unavailable);
  assert.throws(()=>r.settlement.store.outcome({}),unavailable);
  assert.equal(w.queries.length,count);assert.equal(w.ends,1);assert.equal(w.connects,1);
  assert.ok(!JSON.stringify(r.status()).includes(CANARY));
  await assert.rejects(r.connect(),unavailable);
});
for(const close of ['failed','unconfirmed'])test('close '+close+' is preserved, never retried',async()=>{
  const w=world({end:close==='failed'?()=>{throw Object.assign(Error(CANARY),{code:'ECONNRESET'});}:()=>new Promise(()=>{})});
  if(close==='unconfirmed')w.options.connection.timeouts.close=HUNG_CLOSE;
  const r=await w.start(),report=await r.retire();assert.equal(report.close,close);
  assert.equal(report.closeDiagnostic.stage,'end');assert.ok(!JSON.stringify(report).includes(CANARY));
  assert.equal(await r.retire(),report);assert.equal(w.ends,1);
});
test('late custody read cannot publish or continue to SQL after retirement',async()=>{
  const gate=defer(),w=world();w.hooks.pinRead=()=>gate.promise;
  const r=await w.start(),pending=w.prepare(r);await turn();await r.retire();const count=w.queries.length;
  gate.resolve({...w.pin});await assert.rejects(pending,unavailable);assert.equal(w.queries.length,count);
});
test('retirement during archive acknowledgement never advances pin or fabricates a receipt',async()=>{
  const gate=defer(),entered=defer(),w=world();const put=w.options.custody.backupStore.put;
  w.options.custody.backupStore={...w.options.custody.backupStore,put:async(...args)=>{entered.resolve();await gate.promise;return put(...args);}};
  const r=await w.start(),p=await w.prepare(r),pending=r.settlement.commitAdmitted(w.input(p),()=>true);
  await entered.promise;await r.retire();const count=w.queries.length;gate.resolve();
  await assert.rejects(pending,unavailable);assert.equal(w.pin.revision,0);assert.ok(w.journal);
  assert.equal(w.queries.length,count);assert.equal(w.ends,1);
});
test('unreadable injected custody stays unknown without leaking raw diagnostic or retry',async()=>{
  const w=world();w.hooks.pinRead=()=>{throw Error(CANARY);};const r=await w.start();
  const result=await w.prepare(r);assert.equal(result.status,'unavailable');
  assert.ok(!JSON.stringify(result).includes(CANARY));await r.retire();assert.equal(w.connects,1);
});
test('retiring a configured but unopened runtime never constructs a Client',async()=>{
  const w=world(),r=w.construct();assert.equal((await r.retire()).close,'not-opened');
  await assert.rejects(r.connect(),unavailable);assert.equal(w.clients.length,0);
});
test('late preflight cannot publish after retirement and close diagnostics retain primary',async()=>{
  const gate=defer(),entered=defer();
  const w=world({query:(_t,i)=>{if(i===1){entered.resolve();return gate.promise;}},
    end:()=>{throw Object.assign(Error(CANARY),{code:'ECONNRESET'});}}),r=w.construct();
  const pending=r.connect();await entered.promise;const retiring=r.retire();gate.resolve({command:'SELECT',rows:[]});
  await assert.rejects(pending,e=>e.diagnostic.stage==='role');
  const report=await retiring;assert.equal(report.close,'failed');assert.equal(report.primary.stage,'role');
  assert.equal(report.closeDiagnostic.code,'ECONNRESET');assert.equal(r.status().retirement,report);
  assert.equal(w.ends,1);assert.equal(w.queries.length,2);
});
test('late query result cannot escape retirement or dispatch a subsequent query',async()=>{
  const gate=defer(),entered=defer(),w=world({query:(_t,i)=>{
    if(i===4){entered.resolve();return gate.promise;}
  }}),r=await w.start();
  const pending=r.settlement.readDocument();await entered.promise;await r.retire();
  await assert.rejects(pending,unavailable);gate.resolve({command:'SELECT',rows:[{bytes:w.doc}]});await turn();
  assert.equal(w.queries.length,5);assert.equal(w.ends,1);
});
test('pending policy/base/acquisition responses cannot escape after retirement',async()=>{
  for(const name of ['authorize','readBase','acquire','contextReader']){
    const gate=defer(),w=world();w.options.application[name]=()=>gate.promise;
    const r=await w.start(),pending=r.settlement[name]({actorId:'invented'});await r.retire();gate.resolve({});
    await assert.rejects(pending,unavailable);assert.equal(w.queries.length,4);
  }
});
test('connection inputs are snapshotted and invalid driver config is refused before construction',async()=>{
  const w=world(),r=w.construct();w.options.connection.config.ssl.rejectUnauthorized=false;
  w.options.connection.config.host='changed.example.test';w.options.application.now=()=>{throw Error(CANARY);};
  await r.connect();assert.equal(r.settlement.now(),w.time);await r.retire();
  const bad=world();bad.options.connection.config.ssl.rejectUnauthorized=false;
  const refused=bad.construct();await assert.rejects(refused.connect(),e=>e.diagnostic.category==='invalid-config');
  assert.equal(bad.clients.length,0);assert.equal((await refused.retire()).close,'not-opened');
});
test('same known custody surface cannot be rewrapped into a conflicting terminal domain',()=>{
  const w=world();w.construct();const other=world();other.options.custody.pinStore=w.options.custody.pinStore;
  assert.throws(other.construct,TypeError);assert.equal(other.clients.length,0);
});
for(const close of ['confirmed','failed','unconfirmed'])test('synchronous constructor retirement owns opening and reports '+close,async()=>{
  const gate=defer();let r,retiring,settled=false,endRetirement;
  const w=world({construct:()=>{retiring=r.retire();retiring.then(()=>{settled=true;});},
    connect:()=>gate.promise,end:()=>{
      endRetirement=r.retire();
      if(close==='failed')throw Object.assign(Error(CANARY),{code:'ECONNRESET'});
      if(close==='unconfirmed')return new Promise(()=>{});
    }});
  if(close==='unconfirmed')w.options.connection.timeouts.close=HUNG_CLOSE;
  r=w.construct();const opening=r.connect();
  // Observe rejection immediately; assertions happen after releasing all owned
  // work, so the deliberately broken source also leaves no orphaned rejection.
  const outcome=opening.then(()=>null,e=>e);await turn();
  const early={settled,clients:w.clients.length,connects:w.connects,ends:w.ends,queries:w.queries.length};
  gate.resolve();const error=await outcome,report=await retiring;
  assert.equal(early.clients,1);assert.equal(early.settled,false);
  assert.equal(error.code,'SETTLEMENT_RUNTIME_UNAVAILABLE');
  assert.equal(report.close,close);assert.equal(await r.retire(),report);
  assert.equal(endRetirement,retiring);assert.equal(w.ends,1);assert.equal(w.connects,1);
  const count=w.queries.length;assert.equal(count,4);
  assert.throws(r.settlement.readDocument,unavailable);await assert.rejects(r.connect(),unavailable);
  await turn();assert.equal(w.queries.length,count);
});
test('retirement before deferred opening dispatch prevents Client construction entirely',async()=>{
  const w=world(),r=w.construct(),opening=r.connect();assert.equal(r.connect(),opening);
  const outcome=opening.catch(e=>e),retiring=r.retire();assert.equal(r.retire(),retiring);
  const report=await retiring;assert.equal((await outcome).code,'SETTLEMENT_RUNTIME_UNAVAILABLE');
  assert.equal(report.close,'not-opened');assert.equal(w.clients.length,0);assert.equal(w.connects,0);
  assert.equal(w.ends,0);assert.equal(w.queries.length,0);
});
test('constructor retirement followed by setup throw reports unconfirmed ownership, never not-opened',async()=>{
  let r,retiring;const w=world({construct:()=>{
    retiring=r.retire();throw Object.assign(Error(CANARY),{code:'ECONNRESET'});
  }});
  r=w.construct();await assert.rejects(r.connect(),e=>e.diagnostic.stage==='client-setup');
  const report=await retiring;assert.equal(report.state,'lost');assert.equal(report.close,'unconfirmed');
  assert.equal(report.primary.stage,'client-setup');assert.equal(report.closeDiagnostic.category,'unconfirmed');
  assert.equal(await r.retire(),report);assert.equal(w.clients.length,1);assert.equal(w.connects,0);
  assert.equal(w.ends,0);assert.equal(w.queries.length,0);assert.ok(!JSON.stringify(report).includes(CANARY));
});
