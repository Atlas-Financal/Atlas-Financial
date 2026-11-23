'use strict';
// Isolated synthetic transport. No provider credential, file mutation or cache.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process'),Module=require('node:module'),events=require('node:events');
const root=path.resolve(__dirname,'..'),Refresh=require('../scripts/server-live-refresh'),Live=require('../scripts/live-plan'),O=require('../scripts/provider-observe');
const Credentials=require('../scripts/local-credentials');
const filename=path.join(__dirname,'test-production-live-overlay.js'),source=fs.readFileSync(filename,'utf8');
const fixture=new Module(filename);fixture.filename=filename;fixture.paths=Module._nodeModulePaths(__dirname);
fixture._compile(source.slice(0,source.indexOf('function independentGroceryRemaining'))+'\nmodule.exports={startMockProvider,freePort,syntheticLiveMap,login,startAtlas,PASS,SECRET};',filename);
const {startMockProvider,freePort,syntheticLiveMap,login,startAtlas,PASS,SECRET}=fixture.exports;
const canonicalText=fs.readFileSync(path.join(root,'data.json'),'utf8'),canonical=JSON.parse(canonicalText);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const baseEnv={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[key])baseEnv[key]=process.env[key];
baseEnv.LOCALAPPDATA=path.join(process.env.TEMP||process.env.TMP||__dirname,'atlas-deadline-synthetic-credentials');fs.mkdirSync(baseEnv.LOCALAPPDATA,{recursive:true});
const envFor=base=>({...baseEnv,ATLAS_LIVE_OVERLAY:'live',LUNCHMONEY_ACCESS_TOKEN:'synthetic-readonly-token-not-real',ATLAS_LUNCHMONEY_API_BASE:base,ATLAS_LIVE_OVERLAY_NOW:'2026-08-21T18:00:00.000Z',ATLAS_PROVIDER_ACCOUNT_MAP_JSON:JSON.stringify(syntheticLiveMap())});
let checks=0;const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const timings={};
async function stalled(mode,fn){
 const state={active:0,calls:0};
 const provider=http.createServer((req,res)=>{
  state.active++;state.calls++;let timer;
  if(mode==='trickle'){res.writeHead(200,{'content-type':'application/json'});res.write(' ');timer=setInterval(()=>res.write(' '),50);}
  if(mode==='cumulative')timer=setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end('{}');},250);
  res.on('close',()=>{state.active--;clearInterval(timer);clearTimeout(timer);});
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 try{await fn(envFor('http://127.0.0.1:'+provider.address().port+'/v2'),state);}
 finally{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
}
(async()=>{
 check(Refresh.LIVE_REFRESH_TIMEOUT_MS,150000,'finite compatibility refresh budget');
 check(Refresh.MAX_ACTIVE_LIVE_REFRESHES,2,'distinct worker concurrency is bounded without a completed data cache');
 await stalled('trickle',async(env,state)=>{
  const controller=new AbortController(),scheduled=[],original=setTimeout;
  global.setTimeout=(fn,ms,...args)=>{scheduled.push(ms);return original(fn,ms,...args);};
  let work;try{work=Refresh.serve(canonical,env,{signal:controller.signal,timeoutMs:300000});}finally{global.setTimeout=original;}
  controller.abort();await assert.rejects(work,error=>error.code==='live-refresh-cancelled');checks++;
  check(scheduled[0],150000,'caller cannot raise the finite production cap');
  await pause(150);check(state.active,0,'cap proof cancellation leaves no provider work');
 });
 const mock=await startMockProvider('ok');
 try{
  const env=envFor(mock.base),before=JSON.stringify(canonical);
  const expected=await Live.applyForServer(canonical,env),actual=await Refresh.serve(canonical,env);
  check(actual,expected,'entire qualified normal-flow payload conserved across worker boundary');
  check(JSON.stringify(canonical),before,'canonical input immutable');
 }finally{await mock.close();}
 await stalled('silent',async(env,state)=>{
  const start=performance.now(),data=await Refresh.serve(canonical,env,{timeoutMs:12000});
  check(data.liveOverlay.applied,false,'idle timeout preserves existing qualified failure');
  check(data.liveOverlay.reason,'provider-request-timeout','idle timeout reason');
  timings.idleTimeoutMs=Math.round(performance.now()-start);
  assert.ok(performance.now()-start<11000,'idle timeout finishes before absolute deadline');checks++;
  check(data.refreshTrust.exactFiguresAvailable,false,'failure cannot approve current figures');
  await pause(100);check(state.active,0,'idle timeout leaves no provider connection');
 });
 for(const mode of ['trickle','cumulative'])await stalled(mode,async(env,state)=>{
  const start=performance.now();await assert.rejects(Refresh.serve(canonical,env,{timeoutMs:900}),error=>error.code==='live-refresh-timeout');checks++;
  timings[mode+'DeadlineMs']=Math.round(performance.now()-start);
  assert.ok(performance.now()-start<1800,'absolute budget cannot be reset by activity/pages');checks++;
  await pause(150);check(state.active,0,mode+' deadline closes provider sockets');
  // Reads after /me run in parallel (at most 4 in flight), so several start before the shared deadline; the
  // deadline (asserted above: rejected well under 1.8 s although every GET takes 250 ms) still covers them all.
  // /me first, then at most the ten reads one refresh issues (manual_accounts and its /assets fallback included).
  if(mode==='cumulative'){assert.ok(state.calls>1&&state.calls<=11,'shared budget covers successive and parallel GETs: '+state.calls);checks++;}
 });
 await stalled('trickle',async(env,state)=>{
  const controller=new AbortController();
  const first=Refresh.serve(canonical,env,{signal:controller.signal});
  const second=Refresh.serve({...canonical,meta:{...canonical.meta,syntheticRevision:2}},env,{signal:controller.signal});
  const stopped=Promise.all([assert.rejects(first,error=>error.code==='live-refresh-cancelled'),assert.rejects(second,error=>error.code==='live-refresh-cancelled')]);
  await assert.rejects(Refresh.serve({...canonical,meta:{...canonical.meta,syntheticRevision:3}},env),error=>error.code==='live-refresh-busy');checks++;
  controller.abort();await stopped;checks++;
  await pause(150);check(state.active,0,'bounded concurrent cancellation leaves no provider work');
 });
 await stalled('trickle',async(env,state)=>{
  const controller=new AbortController(),baseline=events.getEventListeners(controller.signal,'abort').length;
  const work=Refresh.serve(canonical,env,{signal:controller.signal});await pause(300);controller.abort();
  await assert.rejects(work,error=>error.code==='live-refresh-cancelled');checks++;
  await pause(150);check(state.active,0,'client abort closes worker provider sockets');
  check(events.getEventListeners(controller.signal,'abort').length,baseline,'abort listener cleaned up');
  const aborted=new AbortController();aborted.abort();const calls=state.calls;
  await assert.rejects(Refresh.serve(canonical,env,{signal:aborted.signal}),error=>error.code==='live-refresh-cancelled');checks++;
  check(state.calls,calls,'already cancelled request starts no provider work');
 });
 await stalled('trickle',async(env,state)=>{
  const controller=new AbortController(),work=O.fetchLunchMoneyLive('synthetic-readonly-token-not-real','2026-08-21T18:00:00Z',14,{env,signal:controller.signal});
  await pause(100);controller.abort();await assert.rejects(work,/Live refresh cancelled/);checks++;
  await pause(100);check(state.active,0,'direct transport propagates AbortSignal');
 });
 // Simulate the Windows credential reader with a dummy Node child. Never run
 // DPAPI or inspect a real credential file; cancellation must stop that child too.
 const credentialFile=path.join(baseEnv.LOCALAPPDATA,'synthetic-unprotect-input.dat');
 fs.writeFileSync(credentialFile,'synthetic encrypted fixture');
 try{
  const controller=new AbortController();let child,receivedSignal;
  const work=Credentials.readWindowsStoredCredential({credentialPath:credentialFile,signal:controller.signal,execFile:(_file,_args,options,callback)=>{
   receivedSignal=options.signal;
   child=cp.execFile(process.execPath,['-e','setInterval(()=>{},1000)'],options,callback);return child;
  }});
  check(receivedSignal,controller.signal,'credential read forwards cancellation without token exposure');
  const exit=events.once(child,'exit').catch(()=>{});controller.abort();
  await assert.rejects(work,/Local Lunch Money credential could not be read/);checks++;
  await exit;assert.ok(child.killed);checks++;
 }finally{fs.unlinkSync(credentialFile);}
 const busyProgram=`const R=require(${JSON.stringify(path.join(root,'scripts/server-live-refresh'))});const start=Date.now();R.serve({}, {ATLAS_LIVE_OVERLAY:'live'}, {timeoutMs:300}).then(()=>process.exit(4),e=>{if(e.code!=='live-refresh-timeout'||Date.now()-start>1600)process.exit(5);else console.log('busy terminated');});`;
 const busy=await new Promise((resolve,reject)=>{let output='';const child=cp.spawn(process.execPath,['--require',path.join(__dirname,'fixtures/live-refresh-busy-worker.js'),'-e',busyProgram],{cwd:root,env:baseEnv,stdio:['ignore','pipe','pipe'],windowsHide:true});child.stdout.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('exit',code=>resolve({code,output}));});
 check(busy.code,0,'deadline interrupts synchronous worker work');
 assert.ok(busy.output.includes('busy terminated\n'));checks++;
 const busyRecords=busy.output.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);
 const busyTiming=busyRecords.filter(record=>record.type==='live-refresh-lifecycle');
 check(busyTiming.length,1,'one sanitized lifecycle timing for the interrupted worker');
 check(busyTiming[0].outcome,'live-refresh-timeout','busy-worker timing carries only the closed timeout outcome');
 const busyStages=busyRecords.filter(record=>record.type==='live-refresh-stages');
 check(busyStages.length,1,'one companion stage record for the interrupted worker');
 check(busyStages[0].workerComplete,false,'interrupted synchronous worker cannot claim completed stages');
 check(busyStages[0].qualified,null,'interruption has no qualification verdict');
 await stalled('trickle',async(env,state)=>{
  const port=await freePort(),shortFixture=path.join(__dirname,'fixtures/live-refresh-short-budget.js').replace(/\\/g,'/'),atlas=await startAtlas({...env,NODE_OPTIONS:'--require "'+shortFixture+'"',PORT:String(port),SITE_PASSWORD:PASS,SESSION_SECRET:SECRET,ATLAS_ASSISTANT_TOKEN:'synthetic-assistant-token-long-enough'}),base='http://127.0.0.1:'+port;
  try{
   const unauthorized=await fetch(base+'/data.json',{redirect:'manual'});check(unauthorized.status,401,'session guard unchanged');check(state.calls,0,'unauthorized request starts no provider work');
   const auth=await login(base);check(auth.status,302,'synthetic login unchanged');
   const response=fetch(base+'/data.json',{headers:{cookie:auth.cookie},signal:AbortSignal.timeout(19000)}),start=performance.now();
   await pause(500);const healthStart=performance.now(),health=await fetch(base+'/healthz');check(await health.text(),'ok','health stays responsive during refresh');assert.ok(performance.now()-healthStart<500);checks++;
   const data=await response;check(data.status,503,'whole server deadline returns explicit unavailable');check(await data.json(),{error:'data unavailable'},'deadline publishes no stale financial payload');
   timings.httpDeadlineMs=Math.round(performance.now()-start);
   assert.ok(performance.now()-start<3000);checks++;
   await pause(150);check(state.active,0,'HTTP deadline leaves no provider work');
   const controller=new AbortController(),cancelled=fetch(base+'/data.json',{headers:{cookie:auth.cookie},signal:controller.signal});await pause(300);controller.abort();await assert.rejects(cancelled);checks++;
   await pause(250);check(state.active,0,'HTTP client disconnect cancels refresh');
   const wrongBearer=await fetch(base+'/assistant/current',{headers:{authorization:'Bearer wrong'}});check(wrongBearer.status,401,'dedicated assistant auth unchanged');
  }finally{await atlas.stop();}
 });
 check(fs.readFileSync(path.join(root,'data.json'),'utf8'),canonicalText,'canonical data bytes unchanged');
 console.log('MEASURED '+JSON.stringify(timings));
 console.log('PASS live refresh deadline: '+checks+' checks; absolute and idle bounds, trickle/cumulative delay, synchronous work, abort cleanup, HTTP health/auth, no stale fallback and normal whole-payload conservation');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
