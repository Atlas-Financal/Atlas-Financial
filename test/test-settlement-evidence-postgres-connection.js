'use strict';
// Offline injected-Client qualification only. No pg, socket, credential or provider.
// TLS certificates, SQL metadata and close behavior below are public test doubles;
// this suite cannot establish real-driver TLS, permissions or server durability.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { createSettlementEvidencePostgresConnection: open } = require(path.join(ROOT,
  'scripts/settlement-evidence-postgres-connection'));

const host = 'db.example.test';
const CANARY = 'PUBLIC-DUMMY-NOT-A-CREDENTIAL-CANARY';
const config = () => ({ host, port: 5432, database: 'synthetic', user: 'synthetic_app',
  password: CANARY, ssl: { rejectUnauthorized: true, servername: host } });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
// Virtual time for the subtests where an instant step must beat a short real
// budget (F9 part 1, F13 runtime timeout, F16 'failed'). On a loaded CI runner
// the OS can deschedule the process for longer than 8 ms between a deadline
// stamp and its re-check, so the instant step itself timed out (merge-queue
// flake, 2026-11-19). Here the module's setTimeout and performance.now both
// read one virtual clock that moves only when the test advances it: instant
// work completes at virtual 0 ms, and a deadline fires only when the test
// crosses it. Budgets and assertions are unchanged; the module is untouched.
const perfHooks = require('node:perf_hooks').performance;
function virtualClock(t) {
  let now = 0;
  const ownNow = Object.prototype.hasOwnProperty.call(perfHooks, 'now'), realNow = perfHooks.now;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  perfHooks.now = () => now;
  return {
    advance(ms) { now += ms; t.mock.timers.tick(ms); },
    // Time passes with no timer callback run yet: the stall a loaded runner
    // could only produce by chance, made deterministic.
    jump(ms) { now += ms; },
    restore() { if (ownNow) perfHooks.now = realNow; else delete perfHooks.now; t.mock.timers.reset(); },
  };
}
const safeError = code => Object.assign(new Error(CANARY + ' postgres://hidden:password@host'), { code, detail: CANARY, cause: CANARY });
function metadata() {
  return [
    { database: 'synthetic', user: 'synthetic_app', pid: 314, searchPath:'pg_catalog' },
    { canLogin:true, superuser:false, createDb:false, createRole:false, inherit:false,
      replication:false, bypassRls:false, connectionLimit:1, memberships:0, ownedObjects:0 },
    { connect:true, schemaUsage:true, databaseCreate:false, schemaCreate:false, tables:true, functions:true },
    ['doc_head','doc_staged','journal','quarantine'].map(name => ({ name, kind:'r', persistence:'p',
      rls:false, forceRls:false, unsafe:false, primaryKeyCount:1,
      columns:(name === 'quarantine' ? ['scope','name','label','bytes'] : ['scope','bytes'])
        .map(n => ({ name:n, type:n === 'bytes' ? 'bytea' : 'text', notNull:n !== 'label', generated:'' })),
      primaryKey:name === 'quarantine' ? ['scope','name'] : ['scope'] }))
  ];
}
// PostgreSQL 18-shaped catalog INPUT, not pre-approved output. Ordinary NOT NULL
// rows use contype n (PG18 catalog documentation); PK columns are also non-null.
// This is still an offline model, not a PostgreSQL parser/driver/server execution.
function catalog18() {
  return Object.fromEntries(['doc_head','doc_staged','journal','quarantine'].map(name=>{
    const keys=name==='quarantine'?['scope','name']:['scope'];
    const required=name==='quarantine'?['scope','name','bytes']:['scope','bytes'];
    const row=(contype,conkey)=>({contype,conkey,condeferrable:false,convalidated:true,conenforced:true});
    return [name,[row('p',keys),...required.map(col=>row('n',[col]))]];
  }));
}
function projectConstraints(text, table, constraints) {
  // Interpret only the specific catalog predicate/count forms exercised by this
  // regression. Unknown query forms fail instead of manufacturing safe metadata.
  let allowed;
  if(/k\.contype\s+NOT IN\s*\('p',\s*'n'\)/.test(text))allowed=new Set(['p','n']);
  else if(/k\.contype\s*<>\s*'p'/.test(text))allowed=new Set(['p']);
  else throw Error('unmodelled constraint predicate');
  const primaryOnly=/count\(\*\)::int FROM pg_catalog\.pg_constraint k WHERE k\.conrelid=c\.oid AND k\.contype='p'\) AS "primaryKeyCount"/.test(text);
  if(!primaryOnly)assert.match(text,/count\(\*\)::int FROM pg_catalog\.pg_constraint k WHERE k\.conrelid=c\.oid\) AS "constraintCount"/);
  const result={...table};delete result.constraintCount;delete result.primaryKeyCount;
  result.unsafe=table.unsafe || constraints.some(k=>!allowed.has(k.contype)||k.condeferrable||!k.convalidated
    || (/NOT k\.conenforced/.test(text)&&!k.conenforced));
  result[primaryOnly?'primaryKeyCount':'constraintCount']=constraints.filter(k=>!primaryOnly||k.contype==='p').length;
  result.primaryKey=constraints.filter(k=>k.contype==='p').flatMap(k=>k.conkey);
  return result;
}
function approvedAcl() {
  return Object.fromEntries(['doc_head','doc_staged','journal','quarantine'].map(name=>[name,{
    table:new Set(name==='quarantine'?['SELECT','INSERT']:['SELECT','INSERT','UPDATE','DELETE']),columns:{}
  }]));
}
function projectAcl(text, base, acl) {
  // Narrow inquiry model over effective table/column input grants. It follows
  // only the emitted inquiry forms, not a SQL parser or PostgreSQL execution.
  for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER'])
    assert.ok(text.includes("has_table_privilege(format('%I.%I',$1,t.name),'"+privilege+"')"));
  const columnUpdate=text.includes("(t.name<>'quarantine' OR NOT has_any_column_privilege(format('%I.%I',$1,t.name),'UPDATE'))");
  const columnReferences=text.includes("NOT has_any_column_privilege(format('%I.%I',$1,t.name),'REFERENCES')");
  if(!columnReferences)assert.ok(text.includes("NOT has_table_privilege(format('%I.%I',$1,t.name),'REFERENCES')"));
  const any=(grants,privilege)=>grants.table.has(privilege)||Object.values(grants.columns).some(p=>p.has(privilege));
  const native=text.includes("('terminal_history')");
  const nativeInsert=text.includes("(t.name<>'terminal_history' OR NOT has_any_column_privilege(format('%I.%I',$1,t.name),'INSERT'))");
  return {...base,tables:Object.entries(acl).every(([name,g])=>g.table.has('SELECT')&&g.table.has('INSERT')===(!native||name!=='terminal_history')
    &&g.table.has('UPDATE')===(name!=='quarantine')&&g.table.has('DELETE')===(name!=='quarantine'&&(!native||name!=='terminal_history'))
    &&!g.table.has('TRUNCATE')&&!g.table.has('TRIGGER')
    &&!(columnReferences?any(g,'REFERENCES'):g.table.has('REFERENCES'))
    &&!(columnUpdate&&name==='quarantine'&&any(g,'UPDATE'))
    &&!(nativeInsert&&name==='terminal_history'&&any(g,'INSERT')))};
}
function attributeCatalog() {
  return metadata()[3].map(table=>({...table,columns:table.columns.map(c=>({
    name:c.name,type:c.type,notNull:c.notNull,attgenerated:''
  }))}));
}
function projectAttributes(text, table) {
  const selected=text.includes("'generated',a.attgenerated");
  return {...table,columns:table.columns.map(c=>({name:c.name,type:c.type,notNull:c.notNull,
    ...(selected?{generated:c.attgenerated}:{})}))};
}
// Captured pg-types 2.2.0 default text-parser boundary, reproduced with the
// installed package offline before this repair. No pg dependency is added here.
// index.js SHA256 ece6d549270ba55d08126b10c9997324d808ee828ef00dad236e84e54d9d556d
// lib/textParsers.js SHA256 bd811a530000508b6b90c1db462078e122f0404769d73f57ad41fe90aca159bd
// PG18 pg_attribute.attname is name; name[] OID1003 falls back to String,
// whereas registered text[] OID1009 returns an array. This narrow model handles
// only these fixed unquoted catalog identifiers, not arbitrary array syntax.
function catalogArray(oid,wire) {
  assert.match(wire,/^\{(?:[a-z_]+(?:,[a-z_]+)*)?\}$/);
  if(oid===1003)return String(wire);
  assert.equal(oid,1009);return wire==='{}'?[]:wire.slice(1,-1).split(',');
}
function projectKeyType(text,table) {
  const oid=/ARRAY\(SELECT a\.attname::text FROM/.test(text)?1009
    :/ARRAY\(SELECT a\.attname FROM/.test(text)?1003:null;
  assert.ok(oid,'unmodelled primary-key projection');
  return {...table,primaryKey:catalogArray(oid,'{'+table.primaryKey.join(',')+'}')};
}
function world(options = {}) {
  const w = { constructed:0, connects:0, ends:0, queries:[], clients:[], rows:metadata(), data:null };
  class Client extends EventEmitter {
    constructor(c) {
      super(); w.constructed++; w.config=c; w.clients.push(this);
      this.connection={ stream:{ encrypted:true, authorized:true, servername:host,
        getPeerCertificate:() => ({ subjectaltname:'DNS:' + host }) } };
      if (options.tls) Object.assign(this.connection.stream, options.tls);
    }
    async connect() { w.connects++; if (options.connect) await options.connect(this); }
    async end() { w.ends++; if (options.end) await options.end(this); this.emit('end'); }
    async query(text, values) {
      const index=w.queries.length; w.queries.push({ text, values });
      if (options.query) { const r=await options.query({ text, values, index, client:this, w }); if (r !== undefined) return r; }
      if (index < 4) {
        if(index===2 && options.acl)return {command:'SELECT',rows:[projectAcl(text,w.rows[2],options.acl)]};
        if(index===3 && (options.catalog||options.attributes||options.parserBoundary)) {
          let projected=options.attributes?options.attributes.map(row=>projectAttributes(text,row)):w.rows[3];
          if(options.catalog)projected=projected.map(row=>projectConstraints(text,row,options.catalog[row.name]));
          if(options.parserBoundary)projected=projected.map(row=>projectKeyType(text,row));
          w.projected=projected;
          return {command:'SELECT',rows:w.projected};
        }
        return { command:'SELECT', rows:index === 3 ? w.rows[3] : [w.rows[index]] };
      }
      if (/pg_try_advisory_lock/.test(text)) return { command:'SELECT', rows:[{ locked:options.locked !== false }] };
      if (/pg_advisory_unlock/.test(text)) return { command:'SELECT', rows:[{ unlocked:true }] };
      if (/pg_backend_pid/.test(text)) return { command:'SELECT', rows:[{ pid:314 }] };
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { command:text, rows:[] };
      if (/^SELECT bytes/.test(text)) return { command:'SELECT', rows:w.data === null ? [] : [{ bytes:w.data }] };
      if (/^INSERT/.test(text)) { w.data=Buffer.from(values[1]); return { command:'INSERT', rows:[], rowCount:1 }; }
      throw safeError('UNSUPPORTED');
    }
  }
  w.Client=Client;
  w.open = extra => open({ Client, config:config(), schema:'synthetic_state', scope:'synthetic-scope', ...extra });
  return w;
}
const retirement = e => { assert.equal(e.code,'SETTLEMENT_CONNECTION'); assert.ok(e.retirement); return e; };

test('F1 import is inert; factory constructs only when explicitly called', async () => {
  const w=world(); assert.equal(w.constructed,0);
  const owner=await w.open(); assert.equal(w.connects,1); assert.equal(w.queries.length,4);
  assert.equal(w.config.connectionString,undefined); assert.deepEqual(w.config.ssl,{ rejectUnauthorized:true, servername:host });
  assert.ok(w.queries.every(q => /^SELECT\b/.test(q.text) && Array.isArray(q.values)));
  assert.equal((await owner.retire()).close,'confirmed');
});
test('F2 invalid config is rejected before construction, without invoking getters', async () => {
  const changes=[{host:'127.0.0.1'},{host:'https://db.example.test'},{host:'db-pooler.example.test'},
    {port:0},{database:''},{user:'bad user'},{password:''},{connectionString:'postgres://'+CANARY},
    {ssl:{ rejectUnauthorized:false, servername:host }},{ssl:{ rejectUnauthorized:true, servername:'other.test' }},
    {ssl:{ rejectUnauthorized:true, servername:host, ca:CANARY }}];
  for (const change of changes) { const w=world(); await assert.rejects(w.open({config:{...config(),...change}})); assert.equal(w.constructed,0); }
  for (const extra of [{scope:'bad_scope'},{schema:'pg_bad'},{timeouts:{connect:10001}},{timeouts:{query:0}},{unexpected:true}]) {
    const w=world(); await assert.rejects(w.open(extra)); assert.equal(w.constructed,0);
  }
  let getters=0; const c=config(); Object.defineProperty(c,'password',{get(){getters++;throw Error(CANARY);}});
  const w=world(); await assert.rejects(w.open({config:c})); assert.equal(getters,0); assert.equal(w.constructed,0);
});
test('F3 ambient PostgreSQL/trust override names are refused before construction', async () => {
  for(const key of ['PGHOST','PGOPTIONS','NODE_OPTIONS','NODE_TLS_REJECT_UNAUTHORIZED','NODE_EXTRA_CA_CERTS',
    'NODE_USE_SYSTEM_CA','SSL_CERT_FILE','SSL_CERT_DIR','OPENSSL_CONF','OPENSSL_MODULES']) {
    const old=process.env[key]; process.env[key]='public-dummy';
    try { const w=world(); await assert.rejects(w.open()); assert.equal(w.constructed,0); }
    finally { if(old===undefined)delete process.env[key];else process.env[key]=old; }
  }
});
test('F4 structured identity and SSL are snapshotted before a suspended connect', async () => {
  const gate=deferred(),w=world({connect:()=>gate.promise}),c=config();
  const p=w.open({config:c}); c.host='other.test'; c.ssl.rejectUnauthorized=false;
  gate.resolve(); const owner=await p; assert.equal(w.config.host,host); assert.equal(w.config.ssl.rejectUnauthorized,true);
  await owner.retire();
});
test('F5 connect failure retains safe primary and failed-close diagnostics once', async () => {
  const w=world({connect:()=>{throw safeError('28P01');},end:()=>{throw safeError('ECONNRESET');}});
  const e=await w.open().catch(retirement); assert.equal(e.diagnostic.stage,'connect');
  assert.equal(e.diagnostic.code,'28P01'); assert.equal(e.retirement.close,'failed');
  assert.equal(e.retirement.closeDiagnostic.code,'ECONNRESET'); assert.equal(w.ends,1); assert.equal(w.queries.length,0);
  assert.ok(!JSON.stringify(e).includes(CANARY)); assert.ok(!String(e.stack).includes(CANARY));
});
test('F6 connect timeout and late completion never publish capabilities or preflight', async () => {
  for (const completes of [true,false]) {
    const gate=deferred(),w=world({connect:()=>gate.promise,end:()=>{if(completes)gate.resolve();}});
    const p=w.open({timeouts:{connect:8,close:completes?2000:8}}).catch(retirement);
    const e=await p; assert.equal(e.diagnostic.category,'timeout'); assert.equal(w.ends,1); assert.equal(w.queries.length,0);
    assert.equal(e.retirement.close,completes?'confirmed':'unconfirmed');
    gate.resolve(); await tick(); assert.equal(w.ends,1); assert.equal(w.queries.length,0);
  }
});
test('F7 TLS is checked after connect, including actual hostname verification', async () => {
  for (const tls of [{encrypted:false},{authorized:false},{servername:'other.test'},
    {authorizationError:CANARY},{getPeerCertificate:()=>({subjectaltname:'DNS:other.test'})},
    {getPeerCertificate:()=>({})}]) {
    const w=world({tls}); const e=await w.open().catch(retirement);
    assert.equal(e.diagnostic.stage,'tls'); assert.equal(w.queries.length,0); assert.equal(w.ends,1);
  }
  const w=world({connect:c=>{c.connection.stream.authorized=true;},tls:{authorized:false}});
  await (await w.open()).retire();
});
test('F8 each metadata stage rejects query failure without raw SQLSTATE leakage', async () => {
  for(let index=0;index<4;index++) {
    const w=world({query:q=>{if(q.index===index)throw safeError('42501');}});
    const e=await w.open().catch(retirement); assert.equal(e.diagnostic.code,'42501');
    assert.equal(w.queries.length,index+1); assert.equal(w.ends,1);
  }
});
test('F8 malformed identity, elevated role, effective ACL or schema never qualifies', async () => {
  const mutations=[r=>r[0].database='other',r=>r[0].user='owner',r=>r[0].pid=0,r=>r[0].searchPath='public, pg_catalog',
    r=>r[1].superuser=true,r=>r[1].memberships=1,r=>r[1].ownedObjects=1,r=>r[1].connectionLimit=-1,
    r=>r[2].tables=false,r=>r[2].functions=false,r=>r[2].schemaCreate=true,
    r=>r[3].pop(),r=>r[3][0].columns[1].type='text',r=>r[3][0].primaryKey=[],
    r=>r[3][0].unsafe=true,r=>r[3][0].rls=true,r=>r[3][0].primaryKeyCount=2];
  for(const mutate of mutations){const w=world();mutate(w.rows);const e=await w.open().catch(retirement);assert.equal(e.code,'SETTLEMENT_CONNECTION');assert.equal(w.ends,1);}
  for(const rows of [[],[{}],null]){
    const w=world({query:q=>q.index===0?{command:'SELECT',rows}:undefined}); await assert.rejects(w.open());assert.equal(w.ends,1);
  }
});
test('F9 query and aggregate preflight deadlines retire without later dispatch', async (t) => {
  const clock=virtualClock(t);
  try {
    const gate=deferred(),w=world({query:q=>q.index===1?gate.promise:undefined});
    const opening=w.open({timeouts:{query:8,preflight:30}}).catch(retirement);
    await tick(); assert.equal(w.queries.length,2,'the instant identity query passes at virtual 0 ms; role is dispatched');
    clock.advance(8);
    const e=await opening;
    assert.equal(e.diagnostic.category,'timeout'); assert.equal(w.ends,1); assert.equal(w.queries.length,2);
    gate.resolve({command:'SELECT',rows:[metadata()[1]]});await tick();assert.equal(w.queries.length,2);
  } finally { clock.restore(); }
  // A result that arrives after its query deadline, before the timer has run
  // (the post-await deadline re-check), still times out and dispatches nothing more.
  {
    const clock=virtualClock(t);
    try {
      const gate=deferred(),w=world({query:q=>q.index===1?gate.promise:undefined});
      const opening=w.open({timeouts:{query:8,preflight:30}}).then(()=>null,retirement);
      await tick(); assert.equal(w.queries.length,2);
      clock.jump(9); gate.resolve({command:'SELECT',rows:[metadata()[1]]});
      const late=await opening;
      assert.ok(late,'a result after its query deadline is refused, not accepted');
      assert.equal(late.diagnostic.category,'timeout'); assert.equal(late.diagnostic.stage,'role');
      assert.equal(w.queries.length,2,'no later query is dispatched'); assert.equal(w.ends,1);
    } finally { clock.restore(); }
  }
  // Time spent between queries past the aggregate preflight deadline (here
  // while the identity row is read) refuses the next query before dispatch.
  {
    const clock=virtualClock(t);
    try {
      const identity={...metadata()[0]};
      let jumped=false;
      Object.defineProperty(identity,'searchPath',{enumerable:true,get(){if(!jumped){jumped=true;clock.jump(31);}return 'pg_catalog';}});
      const w=world({query:q=>q.index===0?{command:'SELECT',rows:[identity]}:undefined});
      const refused=await w.open({timeouts:{query:30,preflight:30}}).then(()=>null,retirement);
      assert.ok(jumped,'the identity row was read');
      assert.ok(refused,'a query after the aggregate preflight deadline is refused');
      assert.equal(refused.diagnostic.category,'timeout'); assert.equal(refused.diagnostic.stage,'role');
      assert.equal(w.queries.length,1,'the role query is never dispatched'); assert.equal(w.ends,1);
    } finally { clock.restore(); }
  }
  const x=world({query:async q=>{if(q.index<4)await delay(7);}});
  const ex=await x.open({timeouts:{query:30,preflight:12}}).catch(retirement);
  assert.equal(ex.diagnostic.category,'timeout');assert.ok(x.queries.length<4);assert.equal(x.ends,1);
});
test('F10 real unchanged adapter consumes connection: lock, transaction, journal and read', async () => {
  const w=world(),owner=await w.open();
  assert.equal(await owner.documentStore.read(),null);
  await owner.lock.withLock(async()=>{await owner.journalStore.write({v:'invented'});assert.deepEqual(JSON.parse(await owner.journalStore.read()),{v:'invented'});});
  assert.ok(w.queries.some(q=>q.text==='COMMIT')); assert.equal(owner.status().state,'ready');
  await owner.retire();assert.equal(w.constructed,1);assert.equal(w.ends,1);
});
test('F11 capability surface is immutable and exposes no reusable raw client/query', async () => {
  const w=world(),owner=await w.open();
  assert.deepEqual(Object.keys(owner).sort(),['contract','documentStore','journalStore','lock','quarantine','retire','status'].sort());
  assert.equal(owner.query,undefined);assert.equal(owner.client,undefined);assert.ok(Object.isFrozen(owner));
  assert.ok(Object.isFrozen(owner.documentStore));await owner.retire();
});
for(const event of ['error','end'])test('F12 '+event+' permanently loses a suspended read and future work', async()=>{
  const gate=deferred(),w=world({query:q=>q.index===4?gate.promise:undefined}),owner=await w.open();
  const read=owner.documentStore.read();await tick();w.clients[0].emit(event,safeError('ECONNRESET'));
  await assert.rejects(read);gate.resolve({command:'SELECT',rows:[{bytes:Buffer.from(CANARY)}]});await tick();
  await assert.rejects(owner.documentStore.read());assert.equal(w.queries.length,5);await owner.retire();assert.equal(w.ends,1);
});
test('F13 runtime rejection preserves safe SQLSTATE before adapter wrapping and never reconnects', async()=>{
  const w=world({query:q=>{if(q.index>=4)throw safeError('57P01');}}),owner=await w.open();
  await assert.rejects(owner.documentStore.read());assert.equal(owner.status().primary.code,'57P01');
  await assert.rejects(owner.documentStore.read());assert.equal(w.queries.length,5);await owner.retire();assert.equal(w.constructed,1);
});
test('F13 runtime query timeout suppresses late result', async(t)=>{
  const clock=virtualClock(t);
  try {
    const gate=deferred(),w=world({query:q=>q.index>=4?gate.promise:undefined}),owner=await w.open({timeouts:{query:8}});
    const read=owner.documentStore.read();await tick();clock.advance(8);
    await assert.rejects(read);gate.resolve({command:'SELECT',rows:[]});await tick();
    assert.equal(owner.status().primary.category,'timeout');await owner.retire();assert.equal(w.ends,1);
  } finally { clock.restore(); }
});
test('F14 explicit retirement is once-only and fences late work', async()=>{
  const gate=deferred(),w=world({query:q=>q.index===4?gate.promise:undefined}),owner=await w.open();
  const read=owner.documentStore.read();await tick();const a=owner.retire(),b=owner.retire();assert.equal(a,b);
  await assert.rejects(read);gate.resolve({command:'SELECT',rows:[]});await a;await tick();
  await assert.rejects(owner.lock.withLock(async()=>{}));assert.equal(w.ends,1);assert.equal(w.queries.length,5);
});
test('F15 malformed COMMIT and unlock acknowledgements retire exact owner', async()=>{
  for(const target of ['COMMIT','pg_advisory_unlock']){
    const w=world({query:q=>q.index>=4&&(q.text===target||q.text.includes(target))?{command:'ROLLBACK',rows:[]}:undefined});
    const owner=await w.open();let acknowledged=false;
    await owner.lock.withLock(async()=>{await owner.journalStore.write({v:1});acknowledged=true;}).catch(()=>{});
    if(target==='COMMIT')assert.equal(acknowledged,false);
    assert.notEqual(owner.status().state,'ready');assert.equal((await owner.retire()).primary.stage,'adapter');assert.equal(w.ends,1);
  }
});
test('F16 failed/hanging close is bounded, explicit and never retried', async(t)=>{
  for(const mode of ['failed','unconfirmed']){
    // 'failed': the instant rejection must beat the 8 ms close budget, so it
    // runs on virtual time. 'unconfirmed' keeps the real clock (a stall only
    // makes it more unconfirmed).
    const clock=mode==='failed'?virtualClock(t):null;
    try {
      const gate=deferred(),w=world({end:()=>mode==='failed'?Promise.reject(safeError('ECONNRESET')):gate.promise});
      const owner=await w.open({timeouts:{close:8}});const a=owner.retire(),b=owner.retire();assert.equal(a,b);
      const report=await a;assert.equal(report.close,mode);assert.ok(report.closeDiagnostic);assert.equal(w.ends,1);
      gate.resolve();await tick();assert.equal((await owner.retire()).close,mode);assert.equal(w.ends,1);
    } finally { if (clock) clock.restore(); }
  }
});
test('F17 unsupported diagnostic codes and rejected late promises never escape', async()=>{
  const gate=deferred(),w=world({connect:()=>gate.promise,end:()=>{throw safeError(CANARY);}});
  const e=await w.open({timeouts:{connect:8,close:8}}).catch(retirement);
  gate.reject(safeError(CANARY));await tick();assert.ok(!JSON.stringify(e).includes(CANARY));assert.equal(e.retirement.closeDiagnostic.code,null);
});
test('F17 expected lock refusal preserves qualified session', async()=>{
  const w=world({locked:false}),owner=await w.open();await assert.rejects(owner.lock.withLock(async()=>{}));
  assert.equal(owner.status().state,'ready');assert.equal(w.ends,0);await owner.retire();
});
test('F6 event-loop-delayed connect completion still exceeds the monotonic deadline', async()=>{
  const w=world({connect:()=>{const until=performance.now()+16;while(performance.now()<until){ /* bounded public dummy */ }}});
  const e=await w.open({timeouts:{connect:8}}).catch(retirement);
  assert.equal(e.diagnostic.category,'timeout');assert.equal(w.queries.length,0);assert.equal(w.ends,1);
});
test('F14 retirement before the next dispatch microtask prevents any SQL', async()=>{
  const w=world(),owner=await w.open();const read=owner.documentStore.read();const close=owner.retire();
  await assert.rejects(read);await close;assert.equal(w.queries.length,4);assert.equal(w.ends,1);
});
test('F14 suspended lock callback cannot publish a late success after retirement', async()=>{
  const gate=deferred(),entered=deferred(),w=world(),owner=await w.open();
  const work=owner.lock.withLock(async()=>{entered.resolve();await gate.promise;return 'late-value';});
  await entered.promise;const n=w.queries.length;await owner.retire();await assert.rejects(work);
  gate.resolve();await tick();assert.equal(w.queries.length,n);assert.equal(w.ends,1);
});
test('F10 capability wrapping preserves unchanged adapter call-time snapshots', async()=>{
  const w=world(),owner=await w.open();
  await owner.lock.withLock(async()=>{const value={v:'original'};const write=owner.journalStore.write(value);value.v='mutated';await write;});
  assert.equal(JSON.parse(w.data).v,'original');await owner.retire();
});
test('F11 reused injected session is refused without retiring its existing owner', async()=>{
  const w=world(),owner=await w.open();const Client=function(){return w.clients[0];};
  await assert.rejects(w.open({Client}));assert.equal(w.ends,0);assert.equal(owner.status().state,'ready');await owner.retire();
});
test('F2 hostile input proxy and Client setup errors are sanitized before connect', async()=>{
  const w=world();const c=new Proxy(config(),{getPrototypeOf(){throw safeError(CANARY);}});
  const e=await w.open({config:c}).catch(e=>e);assert.equal(e.code,'SETTLEMENT_CONNECTION');assert.ok(!String(e.stack).includes(CANARY));assert.equal(w.constructed,0);
  const bad=await w.open({Client:class {constructor(){throw safeError(CANARY);}}}).catch(e=>e);
  assert.equal(bad.diagnostic.stage,'client-setup');assert.ok(!JSON.stringify(bad).includes(CANARY));
});
test('F16 late close after event-loop delay is unconfirmed rather than false success', async()=>{
  const w=world({end:()=>{const until=performance.now()+16;while(performance.now()<until){ /* public dummy */ }}});
  const owner=await w.open({timeouts:{close:8}});assert.equal((await owner.retire()).close,'unconfirmed');assert.equal(w.ends,1);
});
test('F2 a Pool-shaped constructor is refused before its connect can borrow a session', async()=>{
  let connects=0;
  class PoolShape extends EventEmitter {connect(){connects++;}query(){}end(){}}
  const w=world();await assert.rejects(w.open({Client:PoolShape}));assert.equal(connects,0);
});
test('F8 PG18 catalog model: required NOT NULL constraints qualify alongside one primary key', async()=>{
  const catalog=catalog18(),w=world({catalog});
  assert.equal(catalog.doc_head.length,3);assert.equal(catalog.quarantine.length,4);
  const owner=await w.open();
  assert.ok(w.projected.every(row=>row.unsafe===false && row.primaryKeyCount===1));
  assert.equal(owner.status().state,'ready');assert.equal((await owner.retire()).close,'confirmed');assert.equal(w.ends,1);
});
test('F8 PG18 catalog model: unsafe types and invalid constraint attributes retire once', async()=>{
  for(const kind of ['c','f','u','t','x','z']) {
    const catalog=catalog18();catalog.doc_head.push({contype:kind,conkey:['bytes'],condeferrable:false,convalidated:true,conenforced:true});
    const w=world({catalog});const e=await w.open().catch(retirement);
    assert.equal(e.diagnostic.stage,'schema',kind);assert.equal(w.projected[0].unsafe,true,kind);assert.equal(w.ends,1);
  }
  for(const type of ['p','n'])for(const [key,value]of [['condeferrable',true],['convalidated',false],['conenforced',false]]){
    const catalog=catalog18();catalog.doc_head.find(k=>k.contype===type)[key]=value;
    const w=world({catalog});const e=await w.open().catch(retirement);
    assert.equal(e.diagnostic.stage,'schema',type+key);assert.equal(w.ends,1);
  }
});
test('F8 PG18 catalog model: separate PK count and original column/PK/nullability guards remain', async()=>{
  const changes=[c=>c.doc_head.splice(0,1),c=>c.doc_head.push({...c.doc_head[0]}),c=>c.doc_head[0].conkey=['bytes']];
  for(const change of changes){const catalog=catalog18();change(catalog);const w=world({catalog});await assert.rejects(w.open());assert.equal(w.ends,1);}
  for(const change of [rows=>rows[0].columns[1].notNull=false,rows=>rows[0].columns[1].type='text',rows=>rows[3].columns[2].notNull=true]){
    const w=world({catalog:catalog18()});change(w.rows[3]);await assert.rejects(w.open());assert.equal(w.ends,1);
  }
});
async function preflightRefused(w,stage) {
  let owner,error;try{owner=await w.open();}catch(e){error=e;}
  if(owner)await owner.retire(); // keep tests-first ready failures closed too
  assert.ok(error,'unexpected adapter capabilities published');retirement(error);
  assert.equal(error.diagnostic.stage,stage);assert.equal(w.queries.length,stage==='privileges'?3:4);
  assert.equal(error.retirement.close,'confirmed');assert.equal(w.ends,1);
  assert.ok(w.queries.every(q=>/^SELECT\b/.test(q.text)));assert.ok(!JSON.stringify(error).includes(CANARY));
}
test('P2 ACL model: approved full-table grants and mutable-table updates qualify',async()=>{
  const w=world({acl:approvedAcl(),catalog:catalog18(),attributes:attributeCatalog()});
  const owner=await w.open();assert.equal(owner.status().state,'ready');assert.equal(w.queries.length,4);
  await owner.retire();assert.equal(w.ends,1);
});
test('P2 ACL model: table and every column-only quarantine UPDATE refuse',async()=>{
  for(const column of [null,'bytes','scope','name','label']){
    const acl=approvedAcl();if(column===null)acl.quarantine.table.add('UPDATE');else acl.quarantine.columns[column]=new Set(['UPDATE']);
    await preflightRefused(world({acl}),'privileges');
  }
});
test('P2 ACL model: table and column-only REFERENCES across all four tables refuse',async()=>{
  const columns={doc_head:['bytes','scope'],doc_staged:['bytes','scope'],journal:['bytes','scope'],quarantine:['bytes','scope','name','label']};
  for(const [name,names]of Object.entries(columns))for(const column of [null,...names]){
    const acl=approvedAcl();if(column===null)acl[name].table.add('REFERENCES');else acl[name].columns[column]=new Set(['REFERENCES']);
    await preflightRefused(world({acl}),'privileges');
  }
});
test('P2 ACL model: required whole-table grants and other prohibitions stay enforced',async()=>{
  for(const [name,g]of Object.entries(approvedAcl()))for(const privilege of g.table){
    const acl=approvedAcl();acl[name].table.delete(privilege);
    if(privilege!=='DELETE')acl[name].columns.bytes=new Set([privilege]);
    await preflightRefused(world({acl}),'privileges');
  }
  for(const name of Object.keys(approvedAcl()))for(const privilege of ['TRUNCATE','TRIGGER']){
    const acl=approvedAcl();acl[name].table.add(privilege);await preflightRefused(world({acl}),'privileges');
  }
  const acl=approvedAcl();acl.quarantine.table.add('DELETE');await preflightRefused(world({acl}),'privileges');
});
test('P2 generated model: stored and virtual columns supplied by adapter refuse',async()=>{
  for(const marker of ['s','v'])for(const table of attributeCatalog())for(const column of [...table.columns].sort((a,b)=>(a.name==='bytes'?-1:b.name==='bytes'?1:0))){
    const attributes=attributeCatalog();attributes.find(t=>t.name===table.name).columns.find(c=>c.name===column.name).attgenerated=marker;
    await preflightRefused(world({catalog:catalog18(),attributes}),'schema');
  }
});
test('P2 generated model: missing null and malformed projected generation never qualifies',async()=>{
  for(const value of [undefined,null,false,1,{},[],'other','s','v']){
    const w=world();if(value===undefined)delete w.rows[3][0].columns[1].generated;else w.rows[3][0].columns[1].generated=value;
    await preflightRefused(w,'schema');
  }
});
test('PK parser boundary: captured single/composite name[] and text[] values differ',()=>{
  for(const [wire,keys]of [['{scope}',['scope']],['{scope,name}',['scope','name']],['{}',[]]]){
    assert.equal(catalogArray(1003,wire),wire);assert.deepEqual(catalogArray(1009,wire),keys);
  }
});
test('PK parser boundary: ordinary single and composite keys qualify as text arrays',async()=>{
  const w=world({parserBoundary:true,catalog:catalog18(),attributes:attributeCatalog(),acl:approvedAcl()});
  const owner=await w.open();assert.equal(owner.status().state,'ready');
  assert.deepEqual(w.projected[0].primaryKey,['scope']);assert.deepEqual(w.projected[3].primaryKey,['scope','name']);
  assert.match(w.queries[3].text,/ARRAY\(SELECT a\.attname::text FROM/);
  assert.equal((await owner.retire()).close,'confirmed');assert.equal(w.ends,1);
});
test('PK parser boundary: missing reordered extra duplicate and wrong keys still refuse',async()=>{
  for(const [index,keys]of [[0,[]],[3,['name','scope']],[3,['scope','name','bytes']],[3,['scope','scope']],[0,['bytes']]]){
    const w=world({parserBoundary:true});w.rows[3][index].primaryKey=keys;
    await preflightRefused(w,'schema');
  }
});

const nativeBinding=()=>({householdId:'household-'+'a'.repeat(32),ledgerNamespace:'ledger-'+'d'.repeat(32)});
function nativeWorld(options={}) {
  const w=world(options);w.rows[3].push({name:'terminal_history',kind:'r',persistence:'p',rls:false,forceRls:false,
    unsafe:false,primaryKeyCount:1,columns:['scope','history_bytes','checkpoint_bytes'].map(name=>({name,
      type:name==='scope'?'text':'bytea',notNull:true,generated:''})),primaryKey:['scope']});
  return w;
}
test('N connection native opt-in exactly qualifies five relations; default still refuses the fifth',async()=>{
  const w=nativeWorld();const o=await w.open({terminalHistory:nativeBinding()});
  assert.equal(typeof o.terminalHistory.readSnapshot,'function');assert.equal(w.queries.length,4);
  assert.equal(Object.keys(o.contract.relations).length,5);assert.match(w.queries[2].text,/\('terminal_history'\)/);
  assert.match(w.queries[3].text,/LIMIT 6$/);await o.retire();
  await preflightRefused(nativeWorld(),'schema');
});
test('N connection validates explicit history binding before constructing a Client',async()=>{
  for(const terminalHistory of [null,true,{},nativeBinding().householdId,{...nativeBinding(),extra:1},
    {...nativeBinding(),householdId:'household-bad'},{...nativeBinding(),ledgerNamespace:'bad'}]){
    const w=world();await assert.rejects(w.open({terminalHistory}));assert.equal(w.constructed,0);
  }
});
test('N connection native missing extra generated wrong-type and wrong-key relations refuse at schema',async()=>{
  for(const mutate of [rows=>rows.pop(),rows=>rows.push({...rows.at(-1),name:'unexpected'}),
    rows=>{rows.at(-1).columns[1].generated='s';},rows=>{rows.at(-1).columns[2].type='text';},
    rows=>{rows.at(-1).columns.push({name:'extra',type:'bytea',notNull:true,generated:''});},
    rows=>{rows.at(-1).primaryKey=['history_bytes'];},rows=>{rows.at(-1).unsafe=true;}]){
    const w=nativeWorld();mutate(w.rows[3]);await assert.rejects(w.open({terminalHistory:nativeBinding()}),e=>{assert.equal(e.diagnostic.stage,'schema');return true;});assert.equal(w.ends,1);
  }
});
test('N connection native grants SELECT UPDATE only, including effective forbidden column grants',async()=>{
  const approved=()=>({...approvedAcl(),terminal_history:{table:new Set(['SELECT','UPDATE']),columns:{}}});
  const good=nativeWorld({acl:approved()});await(await good.open({terminalHistory:nativeBinding()})).retire();
  for(const [privilege,column]of [['INSERT',false],['DELETE',false],['TRUNCATE',false],['TRIGGER',false],
    ['REFERENCES',true],['INSERT',true]]){
    const acl=approved();if(column)acl.terminal_history.columns.history_bytes=new Set([privilege]);else acl.terminal_history.table.add(privilege);
    const w=nativeWorld({acl});await assert.rejects(w.open({terminalHistory:nativeBinding()}),e=>{assert.equal(e.diagnostic.stage,'privileges');return true;});assert.equal(w.queries.length,3);assert.equal(w.ends,1);
  }
});
test('N connection PG18 native NOT NULL rows pass while unsafe constraints remain prohibited',async()=>{
  const constraints=()=>({...catalog18(),terminal_history:[{contype:'p',conkey:['scope'],condeferrable:false,convalidated:true,conenforced:true},
    ...['scope','history_bytes','checkpoint_bytes'].map(name=>({contype:'n',conkey:[name],condeferrable:false,convalidated:true,conenforced:true}))]});
  const good=nativeWorld({catalog:constraints(),parserBoundary:true});await(await good.open({terminalHistory:nativeBinding()})).retire();
  for(const change of [c=>c.push({contype:'c',conkey:[],condeferrable:false,convalidated:true,conenforced:true}),c=>{c[0].condeferrable=true;},c=>{c[1].conenforced=false;}]){
    const catalog=constraints();change(catalog.terminal_history);const w=nativeWorld({catalog});
    await assert.rejects(w.open({terminalHistory:nativeBinding()}),e=>{assert.equal(e.diagnostic.stage,'schema');return true;});
  }
});
