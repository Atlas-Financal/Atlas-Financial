'use strict';
// Unwired connection ownership for the unchanged local-state adapter.
// No driver import, environment-secret resolution, store, bootstrap or activation.
// Client is a trusted injected direct/non-reconnecting pg.Client constructor.
// Catalog preflight targets PostgreSQL 18. Metadata checks are point-in-time,
// not protection against an admin
// changing the server afterwards. Production driver/Linux qualification is separate.
const tls = require('node:tls');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { createSettlementEvidencePostgresAdapter } = require('./settlement-evidence-postgres-adapter');
// Closed profile set. 'settlement' (the default) is unchanged. 'period-history'
// owns one session for the private period-history archive
// (scripts/private-period-history-postgres.js): same TLS, role, timeout,
// sanitization and retirement rules, its own one-table catalog preflight.
const PROFILES = Object.freeze(['settlement','period-history']);

const MAX = Object.freeze({ connect:10000, preflight:10000, query:7000, close:2000 });
const CLAIMED = new WeakSet();
const FAILURES = new WeakSet();
const TRUST = /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i;
const SQLSTATES = new Set(['28000','28P01','42501','42P01','42703','42704','3D000',
  '53300','53400','57P01','57P02','57P03','57014','55P03','25P03','25P04',
  '08000','08003','08006','08001','08004','08007','08P01','40001','40P01','23505','23502','22001']);
const DNS = new Set(['ENOTFOUND','EAI_AGAIN']);
const TCP = new Set(['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH']);
const TLS = new Set(['ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);

function failure(stage, category, code = null) {
  const e = new Error('settlement-postgres-connection: ' + stage + ' failed');
  e.code = 'SETTLEMENT_CONNECTION';
  e.diagnostic = Object.freeze({ stage, category, code });
  FAILURES.add(e);
  return e;
}
function sanitize(error, stage) {
  if (error && FAILURES.has(error)) return error;
  // Never read message/detail/cause/stack or stringify a driver object.
  let code;
  try { code = Object.getOwnPropertyDescriptor(error, 'code')?.value; } catch { /* no raw access */ }
  const category = DNS.has(code) ? 'dns' : TCP.has(code) ? 'tcp' : TLS.has(code) ? 'tls'
    : code === '28P01' || code === '28000' ? 'authentication' : SQLSTATES.has(code) ? 'sql' : 'other';
  return failure(stage, category, category === 'other' ? null : code);
}
function check(ok, stage, category) { if (!ok) throw failure(stage, category); }
function record(value, allowed, required = allowed) {
  check(value && Object.getPrototypeOf(value) === Object.prototype, 'config', 'invalid-config');
  const fields = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(fields).every(k => typeof k === 'string' && allowed.includes(k)
    && Object.hasOwn(fields[k], 'value')) && required.every(k => Object.hasOwn(fields,k)), 'config','invalid-config');
  return Object.fromEntries(Object.entries(fields).map(([k,d]) => [k,d.value]));
}
function validate(options) {
  const o = record(options, ['Client','config','schema','scope','timeouts','terminalHistory','profile'], ['Client','config','schema']);
  const profile = o.profile === undefined ? 'settlement' : o.profile;
  check(PROFILES.includes(profile), 'config','invalid-config');
  // Settlement keeps its required scope; the archive profile takes none.
  check(profile === 'settlement' ? Object.hasOwn(o,'scope')
    : o.scope === undefined && o.terminalHistory === undefined, 'config','invalid-config');
  const c = record(o.config, ['host','port','database','user','password','ssl']);
  const ssl = record(c.ssl, ['rejectUnauthorized','servername']);
  check(typeof o.Client === 'function', 'config','invalid-config');
  check(typeof c.host === 'string' && c.host.length <= 253 && c.host.includes('.') && !net.isIP(c.host)
    && c.host.split('.').every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))
    && !c.host.includes('-pooler'), 'config','invalid-config');
  check(Number.isInteger(c.port) && c.port > 0 && c.port <= 65535, 'config','invalid-config');
  for (const key of ['database','user']) check(typeof c[key] === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(c[key]), 'config','invalid-config');
  check(typeof c.password === 'string' && c.password.length > 0 && c.password.length <= 1024 && !c.password.includes('\0'), 'config','invalid-config');
  check(ssl.rejectUnauthorized === true && ssl.servername === c.host, 'config','invalid-config');
  check(typeof o.schema === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(o.schema)
    && !o.schema.startsWith('pg_') && o.schema !== 'information_schema', 'config','invalid-config');
  if (profile === 'settlement') check(typeof o.scope === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(o.scope), 'config','invalid-config');
  const terminalHistory=o.terminalHistory===undefined?undefined:record(o.terminalHistory,['householdId','ledgerNamespace']);
  if(terminalHistory)check(typeof terminalHistory.householdId==='string'&&/^household-[a-f0-9]{32}$/.test(terminalHistory.householdId)
    &&typeof terminalHistory.ledgerNamespace==='string'&&/^ledger-[a-f0-9]{32}$/.test(terminalHistory.ledgerNamespace),'config','invalid-config');
  const times = { ...MAX, ...(o.timeouts === undefined ? {} : record(o.timeouts,Object.keys(MAX),[])) };
  for (const k of Object.keys(MAX)) check(Number.isInteger(times[k]) && times[k] > 0 && times[k] <= MAX[k], 'config','invalid-config');
  check(!Object.keys(process.env).some(k => TRUST.test(k)), 'environment','environment');
  return { ...o, profile, terminalHistory, times, config:{ host:c.host, port:c.port, database:c.database, user:c.user,
    password:c.password, ssl:{rejectUnauthorized:true,servername:c.host},
    application_name:profile === 'settlement' ? 'atlas-settlement' : 'atlas-period-history', connectionTimeoutMillis:times.connect,
    query_timeout:times.query, statement_timeout:5000, lock_timeout:1000,
    idle_in_transaction_session_timeout:10000, keepAlive:true } };
}

// Four bounded, parameterized catalog queries. No DDL, SET ROLE, application row
// reads, or writes. Effective PUBLIC defaults (including TEMP) are not removed.
const IDENTITY = 'SELECT current_database() AS database, current_user AS "user", pg_backend_pid() AS pid,'
  + ' current_setting(\'search_path\') AS "searchPath"';
const ROLE = `SELECT r.rolcanlogin AS "canLogin", r.rolsuper AS superuser,
  r.rolcreatedb AS "createDb", r.rolcreaterole AS "createRole", r.rolinherit AS inherit,
  r.rolreplication AS replication, r.rolbypassrls AS "bypassRls", r.rolconnlimit AS "connectionLimit",
  (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS memberships,
  (SELECT count(*)::int FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass
    AND d.refobjid=r.oid AND d.deptype='o') AS "ownedObjects"
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;
const PRIVILEGES = `SELECT has_database_privilege(current_database(),'CONNECT') AS connect,
  has_schema_privilege($1,'USAGE') AS "schemaUsage",
  has_database_privilege(current_database(),'CREATE') AS "databaseCreate",
  has_schema_privilege($1,'CREATE') AS "schemaCreate",
  (SELECT bool_and(has_table_privilege(format('%I.%I',$1,t.name),'SELECT')
    AND has_table_privilege(format('%I.%I',$1,t.name),'INSERT')
    AND has_table_privilege(format('%I.%I',$1,t.name),'UPDATE')=(t.name<>'quarantine')
    AND (t.name<>'quarantine' OR NOT has_any_column_privilege(format('%I.%I',$1,t.name),'UPDATE'))
    AND has_table_privilege(format('%I.%I',$1,t.name),'DELETE')=(t.name<>'quarantine')
    AND NOT has_table_privilege(format('%I.%I',$1,t.name),'TRUNCATE')
    AND NOT has_any_column_privilege(format('%I.%I',$1,t.name),'REFERENCES')
    AND NOT has_table_privilege(format('%I.%I',$1,t.name),'TRIGGER'))
    FROM (VALUES ('doc_head'),('doc_staged'),('journal'),('quarantine')) t(name)) AS tables,
  has_function_privilege('pg_catalog.pg_try_advisory_lock(integer,integer)','EXECUTE')
    AND has_function_privilege('pg_catalog.pg_advisory_unlock(integer,integer)','EXECUTE')
    AND has_function_privilege('pg_catalog.pg_backend_pid()','EXECUTE') AS functions`;
const SCHEMA = `SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
  c.relrowsecurity AS rls,c.relforcerowsecurity AS "forceRls",
  (c.relhasrules OR c.relispartition OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
    WHERE k.conrelid=c.oid AND (k.contype NOT IN ('p','n') OR k.condeferrable
      OR NOT k.convalidated OR NOT k.conenforced))) AS unsafe,
  (SELECT count(*)::int FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p') AS "primaryKeyCount",
  (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
    'notNull',a.attnotnull,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
  ARRAY(SELECT a.attname::text FROM pg_catalog.pg_constraint k CROSS JOIN LATERAL unnest(k.conkey)
    WITH ORDINALITY p(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=p.num
    WHERE k.conrelid=c.oid AND k.contype='p' ORDER BY p.ord) AS "primaryKey"
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$1 AND c.relkind<>'i' ORDER BY c.relname LIMIT 5`;
// Fixed second profile; no caller-supplied table list or optional extra state.
const NATIVE_PRIVILEGES=PRIVILEGES
  .replace("has_table_privilege(format('%I.%I',$1,t.name),'INSERT')",
    "has_table_privilege(format('%I.%I',$1,t.name),'INSERT')=(t.name<>'terminal_history')\n"
    +"    AND (t.name<>'terminal_history' OR NOT has_any_column_privilege(format('%I.%I',$1,t.name),'INSERT'))")
  .replace("has_table_privilege(format('%I.%I',$1,t.name),'DELETE')=(t.name<>'quarantine')",
    "has_table_privilege(format('%I.%I',$1,t.name),'DELETE')=(t.name NOT IN ('quarantine','terminal_history'))")
  .replace("('quarantine')) t(name)","('quarantine'),('terminal_history')) t(name)");
const NATIVE_SCHEMA=SCHEMA.replace('LIMIT 5','LIMIT 6');
// Period-history profile: the append-only `revisions` relation (SELECT and
// INSERT only; UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER must be absent,
// so the database itself refuses rewriting a revision), and optionally the
// owner-approved `capture_window_claims` relation (#821 6822615033): INSERT
// only, with no SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER. A
// claims table that is absent reads as NULL (to_regclass), so an archive set
// up before it existed still opens; one present with any other grant fails
// closed. Catalog columns used here
// exist on PostgreSQL 16 through 18 (no conenforced), so a local PG16 run and
// Neon's current majors are both covered.
const ARCHIVE = "format('%I.%I',$1,'revisions')";
const CLAIMS = "to_regclass(format('%I.%I',$1,'capture_window_claims'))";
const ARCHIVE_PRIVILEGES = `SELECT has_database_privilege(current_database(),'CONNECT') AS connect,
  has_schema_privilege($1,'USAGE') AS "schemaUsage",
  has_database_privilege(current_database(),'CREATE') AS "databaseCreate",
  has_schema_privilege($1,'CREATE') AS "schemaCreate",
  (has_table_privilege(${ARCHIVE},'SELECT') AND has_table_privilege(${ARCHIVE},'INSERT')
    AND NOT has_table_privilege(${ARCHIVE},'UPDATE') AND NOT has_any_column_privilege(${ARCHIVE},'UPDATE')
    AND NOT has_table_privilege(${ARCHIVE},'DELETE') AND NOT has_table_privilege(${ARCHIVE},'TRUNCATE')
    AND NOT has_any_column_privilege(${ARCHIVE},'REFERENCES') AND NOT has_table_privilege(${ARCHIVE},'TRIGGER')) AS tables,
  (has_table_privilege(${CLAIMS},'INSERT') AND NOT has_table_privilege(${CLAIMS},'SELECT')
    AND NOT has_any_column_privilege(${CLAIMS},'SELECT')
    AND NOT has_table_privilege(${CLAIMS},'UPDATE') AND NOT has_any_column_privilege(${CLAIMS},'UPDATE')
    AND NOT has_table_privilege(${CLAIMS},'DELETE') AND NOT has_table_privilege(${CLAIMS},'TRUNCATE')
    AND NOT has_any_column_privilege(${CLAIMS},'REFERENCES') AND NOT has_table_privilege(${CLAIMS},'TRIGGER')) AS claims,
  has_function_privilege('pg_catalog.pg_try_advisory_xact_lock(integer,integer)','EXECUTE') AS functions`;
const ARCHIVE_SCHEMA = SCHEMA.replace(' OR NOT k.conenforced','').replace('LIMIT 5','LIMIT 3');

function rows(result, stage) {
  check(result && !Array.isArray(result) && result.command === 'SELECT' && Array.isArray(result.rows), stage,'protocol');
  return result.rows;
}
function single(result, stage) { const r=rows(result,stage);check(r.length===1 && r[0] && typeof r[0]==='object',stage,'protocol');return r[0]; }
// Returns whether the claims table is present (it sorts before `revisions`).
function archiveSchemaMatches(result) {
  const r=rows(result,'schema');
  check(r.length===1||r.length===2,'schema','schema');
  if(r.length===2){
    const c=r[0], claimCols=[['period_start','date'],['period_end','date'],
      ['window_start','timestamp with time zone'],['claimed_at','timestamp with time zone']];
    check(c && c.name==='capture_window_claims' && c.kind==='r' && c.persistence==='p' && c.rls===false && c.forceRls===false
      && c.unsafe===false && c.primaryKeyCount===1,'schema','schema');
    check(Array.isArray(c.columns) && c.columns.length===claimCols.length && c.columns.every((x,i)=>
      x.name===claimCols[i][0] && x.type===claimCols[i][1] && x.notNull===true && x.generated===''),'schema','schema');
    const pk=['period_start','period_end','window_start'];
    check(Array.isArray(c.primaryKey) && c.primaryKey.length===pk.length && c.primaryKey.every((x,i)=>x===pk[i]),'schema','schema');
  }
  const t=r[r.length-1], cols=[['sequence','integer'],['revision_id','text'],['record','text']];
  check(t && t.name==='revisions' && t.kind==='r' && t.persistence==='p' && t.rls===false && t.forceRls===false
    && t.unsafe===false && t.primaryKeyCount===1,'schema','schema');
  check(Array.isArray(t.columns) && t.columns.length===cols.length && t.columns.every((c,i)=>
    c.name===cols[i][0] && c.type===cols[i][1] && c.notNull===true && c.generated===''),'schema','schema');
  check(Array.isArray(t.primaryKey) && t.primaryKey.length===1 && t.primaryKey[0]==='sequence','schema','schema');
  return r.length===2;
}
function schemaMatches(result,native=false) {
  const r=rows(result,'schema');
  // At most five non-index relations: the fifth proves unexpected extra state.
  const tables=r;
  check(tables.length===(native?5:4),'schema','schema');
  const names=new Set();
  for (const t of tables) {
    check(['doc_head','doc_staged','journal','quarantine',...(native?['terminal_history']:[])].includes(t.name) && !names.has(t.name), 'schema','schema'); names.add(t.name);
    check(t.kind==='r' && t.persistence==='p' && t.rls===false && t.forceRls===false
      && t.unsafe===false && t.primaryKeyCount===1, 'schema','schema');
    const cols=t.name==='terminal_history'?['scope','history_bytes','checkpoint_bytes']:t.name==='quarantine'?['scope','name','label','bytes']:['scope','bytes'];
    check(Array.isArray(t.columns) && t.columns.length===cols.length && t.columns.every((c,i)=>
      c.name===cols[i] && c.type===((t.name==='terminal_history'?c.name!=='scope':c.name==='bytes')?'bytea':'text') && c.notNull===(c.name!=='label')
      && c.generated===''),'schema','schema');
    const pk=t.name==='quarantine'?['scope','name']:['scope'];
    check(Array.isArray(t.primaryKey) && t.primaryKey.length===pk.length && t.primaryKey.every((c,i)=>c===pk[i]),'schema','schema');
  }
}

async function createSettlementEvidencePostgresConnection(options) {
  let o;
  try {o=validate(options);} catch(error){throw sanitize(error,'config');}
  // No driver or constructor before all input checks.
  let raw;
  try { raw=new o.Client(o.config); } catch(error) { throw sanitize(error,'client-setup'); }
  try {
    check(raw && !CLAIMED.has(raw), 'client-setup','setup');
    check(['connect','query','on','end'].every(k=>typeof raw[k]==='function') && typeof raw.release!=='function'
      && raw.connection && typeof raw.connection.stream==='object','client-setup','setup');
  } catch(error){throw sanitize(error,'client-setup');}
  CLAIMED.add(raw);
  let state='connecting', primary=null, retirement=null, report=null, connectSettled;
  const connectedDone=new Promise(resolve=>{connectSettled=resolve;});
  let lossError=null;
  const lossWatchers=new Set();
  function signalLoss(error) {
    lossError ||= error;
    for(const resolve of lossWatchers)resolve(lossError);
    lossWatchers.clear();
  }
  function raceLoss(pending) {
    let listener;
    const lost=new Promise(resolve=>{listener=resolve;if(lossError)resolve(lossError);else lossWatchers.add(resolve);});
    return Promise.race([pending,lost.then(error=>{throw error;})]).finally(()=>lossWatchers.delete(listener));
  }
  const subscribers={ error:new Set(), end:new Set() };
  function notify(event) { for(const fn of subscribers[event]) { try { fn(); } catch { /* no callback diagnostics */ } } }
  function status() { return Object.freeze({state,primary,retirement:report}); }
  // Period-history profile only: call fn synchronously the moment the
  // session is lost or retired (before the connection is released), or at
  // once if that has already happened. Returns an unsubscribe function.
  function onLoss(fn) {
    if(typeof fn!=='function')return ()=>{};
    const watcher=()=>{try{fn();}catch{/* no callback diagnostics */}};
    if(lossError||state==='retiring'||state==='retired'||state==='lost'){watcher();return ()=>{};}
    lossWatchers.add(watcher);return ()=>{lossWatchers.delete(watcher);};
  }
  function retire() {
    if(retirement)return retirement;
    state='retiring'; signalLoss(failure('retire','retired'));
    // Invoke end once, including during a pending connect. Confirmation also
    // requires that connect settle; a timeout never asserts server lock release.
    retirement=(async()=>{
      let timer;const deadline=performance.now()+o.times.close;
      const ending=Promise.resolve().then(()=>raw.end()).then(()=>({ok:true}),error=>({ok:false,error}));
      const completion=ending.then(outcome=>outcome.ok?connectedDone.then(()=>outcome):outcome);
      let outcome=await Promise.race([completion,new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),o.times.close);})]);
      clearTimeout(timer);
      if(performance.now()>=deadline && outcome.ok)outcome={timeout:true};
      const close=outcome.timeout?'unconfirmed':outcome.ok?'confirmed':'failed';
      const closeDiagnostic=outcome.timeout?failure('end','timeout').diagnostic
        :outcome.ok?null:sanitize(outcome.error,'end').diagnostic;
      state=close==='confirmed'?'retired':'lost';
      report=Object.freeze({state,close,primary,closeDiagnostic});return report;
    })();
    notify('end');
    return retirement;
  }
  function lose(error) {
    if(state==='retiring'||state==='retired'||state==='lost')return;
    primary ||= error.diagnostic; signalLoss(error); void retire();
  }
  async function bounded(invoke,stage,millis) {
    check(state!=='retiring'&&state!=='retired'&&state!=='lost',stage,'retired');
    let timer;const deadline=performance.now()+millis;
    try {
      const value=await raceLoss(Promise.race([Promise.resolve().then(()=>{
        check(state!=='retiring'&&state!=='retired'&&state!=='lost',stage,'retired');
        check(performance.now()<deadline,stage,'timeout');return invoke();
      }),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure(stage,'timeout')),Math.max(1,millis));})]));
      check(state!=='retiring'&&state!=='retired'&&state!=='lost',stage,'retired');
      check(performance.now()<deadline,stage,'timeout');return value;
    } catch(error) {const safe=sanitize(error,stage);lose(safe);throw safe;}
    finally {clearTimeout(timer);}
  }
  let connectStarted=false;
  try {
    raw.on('error',error=>{lose(sanitize(error,'session-error'));notify('error');});
    raw.on('end',()=>{lose(failure('session-end','session'));notify('end');});
    await bounded(()=>{connectStarted=true;return Promise.resolve().then(()=>raw.connect()).finally(connectSettled);},'connect',o.times.connect);
    state='preflight';
    const socket=raw.connection?.stream;
    check(socket?.encrypted===true && socket.authorized===true && socket.servername===o.config.host
      && !socket.authorizationError && typeof socket.getPeerCertificate==='function', 'tls','tls');
    check(!tls.checkServerIdentity(o.config.host,socket.getPeerCertificate(true)), 'tls','tls');
    const deadline=performance.now()+o.times.preflight;
    async function query(text,values,stage) {
      const left=deadline-performance.now();check(left>0,stage,'timeout');
      return bounded(()=>raw.query(text,values),stage,Math.min(o.times.query,left));
    }
    const id=single(await query(IDENTITY,[],'identity'),'identity');
    check(id.database===o.config.database && id.user===o.config.user && Number.isSafeInteger(id.pid) && id.pid>0
      && id.searchPath==='pg_catalog','identity','identity');
    const role=single(await query(ROLE,[],'role'),'role');
    check(role.canLogin===true && ['superuser','createDb','createRole','inherit','replication','bypassRls'].every(k=>role[k]===false)
      && role.connectionLimit===1 && role.memberships===0 && role.ownedObjects===0,'role','privileges');
    const archive=o.profile==='period-history';
    const grants=single(await query(archive?ARCHIVE_PRIVILEGES:o.terminalHistory?NATIVE_PRIVILEGES:PRIVILEGES,[o.schema],'privileges'),'privileges');
    check(['connect','schemaUsage','tables','functions'].every(k=>grants[k]===true)
      && grants.databaseCreate===false && grants.schemaCreate===false,'privileges','privileges');
    // Claims grants and claims table agree: absent together (NULL grant), or
    // present together with exactly INSERT.
    let claims=false;
    if(archive){
      check(grants.claims===null||grants.claims===true,'privileges','privileges');
      claims=archiveSchemaMatches(await query(ARCHIVE_SCHEMA,[o.schema],'schema'));
      check(claims===(grants.claims===true),'schema','schema');
    } else schemaMatches(await query(o.terminalHistory?NATIVE_SCHEMA:SCHEMA,[o.schema],'schema'),!!o.terminalHistory);
    check(performance.now()<deadline,'schema','timeout');
    const client={
      query:(text,values)=>bounded(()=>raw.query(text,values),'query',o.times.query),
      on:(event,fn)=>{check(Object.hasOwn(subscribers,event)&&typeof fn==='function','client-setup','setup');subscribers[event].add(fn);},
      retire:()=>{if(state==='ready')primary ||= failure('adapter','protocol').diagnostic;return retire();}
    };
    if(archive){
      // Lazy: the archive module imports this owner from its own entry point.
      const store=require('./private-period-history-postgres').createPeriodHistoryPostgresStore({client,schema:o.schema,claims});
      // The store's own fixed history-* codes pass through; anything else is
      // sanitized exactly as for settlement.
      const guarded=fn=>(...args)=>{
        let pending;
        try {check(state==='ready','adapter','retired');pending=fn(...args);}
        catch(error){pending=Promise.reject(store.owns(error)?error:sanitize(error,'adapter'));}
        return raceLoss(pending).then(value=>{check(state==='ready','adapter','retired');return value;})
          .catch(error=>{throw store.owns(error)?error:sanitize(error,'adapter');});
      };
      state='ready';
      return Object.freeze({periodHistory:Object.freeze({append:guarded(store.append),read:guarded(store.read),
        claimWindow:guarded(store.claimWindow)}),retire,status,onLoss});
    }
    const adapter=createSettlementEvidencePostgresAdapter({client,schema:o.schema,scope:o.scope,
      ...(o.terminalHistory?{terminalHistory:o.terminalHistory}:{})});
    function expose(capabilities) {
      return Object.freeze(Object.fromEntries(Object.entries(capabilities).map(([name,fn])=>[name,(...args)=>{
        // Invoke synchronously so the adapter still snapshots inputs at call time.
        // Fence publication too: an adapter lock callback may outlive retirement.
        let pending;
        try {check(state==='ready','adapter','retired');pending=fn(...args);}
        catch(error){pending=Promise.reject(sanitize(error,'adapter'));}
        return raceLoss(pending).then(value=>{
          check(state==='ready','adapter','retired');return value;
        }).catch(async error=>{
          const safe=sanitize(error,'adapter');if(retirement)safe.retirement=await retirement;throw safe;
        });
      }])));
    }
    state='ready';
    return Object.freeze({documentStore:expose(adapter.documentStore),journalStore:expose(adapter.journalStore),
      ...(o.terminalHistory?{terminalHistory:expose(adapter.terminalHistory)}:{}),
      quarantine:expose(adapter.quarantine),lock:expose(adapter.lock),contract:adapter.contract,retire,status});
  } catch(error) {
    if(!connectStarted)connectSettled();
    const safe=sanitize(error,'client-setup');lose(safe);
    safe.retirement=await retire();throw safe;
  }
}
module.exports = { createSettlementEvidencePostgresConnection };
