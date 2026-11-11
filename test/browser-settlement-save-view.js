'use strict';
const { applyPlanKnobsAfterWiring, planKnobsInitSource } = require('./browser-plan-knobs');
// Actual loopback application, real login and mounted POSTs. Only authority,
// storage, context and complete base inputs are synthetic. No intercepted data
// responses on successful journeys. Edge runs the repository's actual scripts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { startWorld, startChildWorld, env, syntheticRecord, armProbeCompetition, appendCompetingRecord } = require('./test-settlement-evidence-http');
const KEY = 'atlas-settlement-pending-v1';
const out = process.env.ATLAS_SETTLEMENT_BROWSER_PROOF || path.join(os.tmpdir(), 'atlas-settlement-browser-proof');
const results = [];
async function openPage(browser, w, width = 390, marker) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], external = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/settlement/')) requests.push({ method: request.method(), path: url.pathname });
  });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== w.origin) { external.push(new URL(route.request().url()).origin); return route.abort(); }
    return route.continue();
  });
  // An observing once-hook, registered before the page's own once-hooks, proves
  // whether any initial DATA ever reached them. This does not replace a hook,
  // data acquisition, renderer, Forecast call or application route.
  await page.route('**/plan.js', async route => {
    try {
      const response = await route.fetch();
      await route.fulfill({ response, body: 'App.once(data => { window.__settlementOnce = (window.__settlementOnce || 0) + 1; });\n' + await response.text() });
    } catch (error) {
      if (!/disposed|closed|cancelled/i.test(error.message)) throw error;
    }
  });
  await page.goto(w.origin + '/login');
  await page.getByLabel('Password', { exact: true }).fill(env.SITE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
  if (marker) {
    await page.evaluate(({ KEY, marker }) => localStorage.setItem(KEY, JSON.stringify(marker)), { KEY, marker });
    await page.reload();
  }
  return { page, context, errors, external, requests };
}
async function sheet(page) {
  const tile = page.locator('[data-budget-savings-goals]'); await tile.waitFor();
  await (async t => { const p = t.locator('.blend-goals-panel'); if (await p.count() && !(await p.evaluate(n => n.open))) await t.locator('.blend-tile-head').click(); })(tile); // Refined face: Accounts & evidence opens from the savings detail.
  const open = tile.locator('[data-budget-funding-inventory]');
  await open.focus(); await page.keyboard.press('Enter');
  const dialog = page.locator('[data-budget-detail-sheet]'); await dialog.waitFor({ state: 'visible' });
  return dialog;
}
async function preview(page) {
  const dialog = await sheet(page);
  await dialog.getByRole('button', { name: 'Assign a recorded payment', exact: true }).click();
  await dialog.getByLabel('Amount to assign (CAD)', { exact: true }).fill('25.00');
  await dialog.getByRole('button', { name: 'Preview assignment', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).waitFor();
  assert.match(await dialog.locator('[data-settlement-assignment]').innerText(), /\$25\.00 CAD.*2026-10-03.*Invented first club cost.*Preview expires/);
  const stored = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
  assert.deepEqual(Object.keys(stored).sort(), ['generation', 'operationId', 'phase']); assert.equal(stored.phase, 'preview');
  assert.match(stored.generation, /^generation-[a-f0-9]{32}$/);
  return dialog;
}
async function facts(page) {
  return page.evaluate(() => {
    const d = App.data;
    const row = Forecast.savingsInventory(d.plan, d.meta.asOf,
      { settlementEvidence: d.settlementEvidence }).pools[0].plannedGoals[0];
    return { original: row.target, paid: row.linkedPaid, remaining: row.remaining };
  });
}
async function complete(page, dialog) {
  await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).dblclick()]);
  await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
  await page.waitForFunction(KEY => localStorage.getItem(KEY) === null, KEY);
}
async function withdrawalPreview(page, afterDiscovery = () => {}) {
  const dialog = await sheet(page);
  await dialog.getByRole('button', { name: 'Withdraw an assignment', exact: true }).click();
  // Catalogue order is not target identity: a sibling can sort before this
  // assignment. Select the independently known original cost explicitly.
  const assignments = dialog.getByLabel('Existing assignment', { exact: true });
  const target = assignments.locator('option').filter({ hasText: /Invented first club cost|Recorded planned cost/ });
  await target.first().waitFor({ state: 'attached' });
  assert.equal(await target.count(), 1);
  await assignments.selectOption(await target.getAttribute('value'));
  await afterDiscovery();
  await dialog.getByRole('button', { name: 'Preview withdrawal', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).waitFor();
  assert.match(await dialog.locator('[data-settlement-assignment]').innerText(), /Withdraw.*\$25\.00 CAD.*does not move money.*Preview expires/);
  const marker = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
  assert.deepEqual(Object.keys(marker).sort(), ['generation', 'operationId', 'phase']);
  assert.equal(marker.phase, 'preview'); assert.match(marker.generation, /^generation-[a-f0-9]{32}$/);
  return dialog;
}
async function completeWithdrawal(page, dialog) {
  await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).dblclick()]);
  await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified'
    && localStorage.getItem(KEY) === null, KEY);
}
async function refuseStorageReads(context) {
  await context.addInitScript(() => {
    Storage.prototype.getItem = function () { throw new DOMException('synthetic storage read refusal', 'SecurityError'); };
  });
}
function bootTraffic(page) {
  const traffic = { ordinary: 0, classification: 0 };
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/data.json') traffic.ordinary++;
    if (path === '/settlement/capability' && request.headers()['x-atlas-settlement'] === 'same-origin') traffic.classification++;
  });
  return traffic;
}
async function reconciliationBoot(page) {
  await page.getByText('Assignment outcome needs reconciliation. Figures remain unavailable.', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => App.data), null);
  assert.equal(await page.evaluate(() => window.__settlementOnce || 0), 0);
}
function observeMarkerMutations() {
  const key = 'atlas-settlement-pending-v1';
  let locked = false;
  window.__markerLockHeld = false;
  window.__markerMutations = [];
  const request = navigator.locks.request.bind(navigator.locks);
  navigator.locks.request = (name, options, callback) => request(name, options, async lock => {
    if (name === key && options.mode === 'exclusive') { locked = true; window.__markerLockHeld = true; }
    try { return await callback(lock); } finally { locked = false; window.__markerLockHeld = false; }
  });
  for (const method of ['setItem', 'removeItem']) {
    const original = Storage.prototype[method];
    Storage.prototype[method] = function (name, ...args) {
      if (name === key) window.__markerMutations.push({ method, locked });
      return original.call(this, name, ...args);
    };
  }
}

async function lostNativeNegative(w, page, loseStoreAck = false) {
  const ready=page.waitForResponse(r=>r.url().endsWith('/settlement/prepare'));
  const dialog=await preview(page),p=await(await ready).json();await w.setClock(p.expiresAt);
  if(loseStoreAck)w.hooks.historyAppend=perform=>{perform();throw Error('synthetic lost store acknowledgement');};
  await page.route('**/settlement/confirm',async route=>{
    const response=await route.fetch();assert.equal((await response.json()).status,loseStoreAck?'unknown':'not-applied');
    return route.abort(); // Only the reply is deliberately lost, never the write route.
  });
  await dialog.getByRole('button',{name:'Confirm assignment',exact:true}).click();
  await page.getByText('Assignment outcome needs reconciliation.',{exact:false}).waitFor();
  const marker=await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY);
  assert.equal(marker.phase,'dispatched');return {marker,p};
}
async function b3Ready(page) {
  await page.waitForFunction(KEY=>App.data?.settlementEvidenceStatus?.status==='qualified'
    &&localStorage.getItem(KEY)===null&&window.__settlementOnce===1,KEY);
  assert.deepEqual(await facts(page),{original:60,paid:0,remaining:60});
}

function rendererReversalEvidence(withReversal) {
  const C = require('../scripts/planned-obligation-settlement-contract');
  const householdId = 'household-' + 'a'.repeat(32), actorId = 'session-' + 'b'.repeat(64);
  const op = n => 'operation-' + n.toString(16).padStart(32, '0');
  const evidence = { accountId: 'chequing-a', currency: 'cad', direction: 'debit', date: '2026-10-03', cents: 6000, posted: true };
  const link = { version: 1, kind: 'link', goalId: 'commitment:near', txRef: 'tx-' + 'c'.repeat(32),
    evidence, evidenceDigest: C.digest(evidence), assignedCents: 2500, asOf: '2026-10-05' };
  const counter = { ...evidence, direction: 'credit', cents: 1000 };
  const commands = [link, ...(withReversal ? [{ version: 1, kind: 'reverse', targetOperationId: op(1),
    counterTxRef: 'tx-' + 'd'.repeat(32), counterEvidence: counter, counterEvidenceDigest: C.digest(counter), cents: 1000 }] : []),
  { ...link, goalId: 'commitment:far', assignedCents: 2000 }];
  let body = C.adopt({ householdId });
  commands.forEach((command, i) => {
    const p = C.prepare(body, { householdId, actorId, operationId: op(i + 1), command, now: 100 + i * 2 });
    body = C.confirmCandidate(body, { householdId, actorId, preview: p.preview,
      confirmationDigest: p.confirmationDigest, now: 101 + i * 2 }).document;
  });
  return C.effectiveEvidence(JSON.parse(body));
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const browserVersion = browser.version();
  try {
    const run = async (name, action, active = true, width = 390, options = {}) => {
      if (process.env.ATLAS_SETTLEMENT_BROWSER_CASE && name !== process.env.ATLAS_SETTLEMENT_BROWSER_CASE) return;
      if (process.env.ATLAS_SETTLEMENT_BROWSER_PREFIX && !name.startsWith(process.env.ATLAS_SETTLEMENT_BROWSER_PREFIX)) return;
      const w = options.childNegative ? await startChildWorld(options) : await startWorld(active, options); let fixture;
      try {
        fixture = await openPage(browser, w, width);
        await action(w, fixture);
        if (options.childNegative) await w.snapshot();
        if (options.nativeNegative || options.childNegative) assert.deepEqual(w.effects, [], 'no financial adapter write of any kind');
        assert.deepEqual(fixture.external, [], 'zero external network requests');
        assert.deepEqual(fixture.errors, [], 'zero page errors');
        results.push({ name, width, status: 'PASS', commits: w.calls.commit, journalWrites: w.calls.journal,
          requests: fixture.requests, details: fixture.details }); console.log('PASS ' + name);
      } catch (error) {
        // Independent cases still execute, but any failure makes the command
        // fail. Preserve the actual trace instead of manufacturing a green run.
        const screenshot = 'failure-' + results.length + '.png';
        if (fixture && !fixture.page.isClosed()) await fixture.page.screenshot({ path: path.join(out, screenshot) }).catch(() => {});
        results.push({ name, width, status: 'FAIL', failure: error.message.slice(0, 6000),
          screenshot, details: fixture?.details, commits: w.calls.commit, journalWrites: w.calls.journal,
          requests: fixture?.requests || [] });
        console.error('FAIL ' + name + ': ' + error.message.split('\n')[0]);
      } finally { await fixture?.context.close(); await w.close(); }
    };

    await run('B3 lost store acknowledgement stays fenced until controller reconstruction',async(w,fixture)=>{
      const {page,requests}=fixture;await lostNativeNegative(w,page,true);
      const traffic=bootTraffic(page);await page.reload();await reconciliationBoot(page);
      assert.equal(traffic.ordinary,0);
      assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).phase,KEY),'dispatched');
      assert.equal((await w.prepare(2)).reason,'outcome-unresolved');
      w.recreateStore();await page.reload();await b3Ready(page);
      assert.equal(traffic.ordinary,1);
      assert.equal(w.calls.commit,0);assert.equal(w.calls.journal,0);assert.equal(w.historyCalls.append,1);
      assert.equal(requests.filter(r=>r.path==='/settlement/confirm').length,1);
      fixture.details={lostStoreAck:true,sameInstanceFenced:true,freshControllerQualifiedRead:true,noReplay:true};
    },true,390,{nativeNegative:true});
    for(const lostStoreAck of [false,true]){
      await run('B3 real child replacement recovers '+(lostStoreAck?'lost store ack':'lost HTTP reply'),async(w,fixture)=>{
        const {page,requests}=fixture;
        const ready=page.waitForResponse(r=>r.url().endsWith('/settlement/prepare'));
        const dialog=await preview(page),p=await(await ready).json();await w.setClock(p.expiresAt);
        await page.route('**/settlement/confirm',async route=>{
          const response=await route.fetch();assert.equal((await response.json()).status,lostStoreAck?'unknown':'not-applied');
          return route.abort();
        });
        await dialog.getByRole('button',{name:'Confirm assignment',exact:true}).click();
        await page.getByText('Assignment outcome needs reconciliation.',{exact:false}).waitFor();
        const before=await w.restart();await page.reload();await b3Ready(page);
        const after=await w.snapshot();assert.equal(after.doc,before.doc);assert.equal(after.historyBytes,before.historyBytes);
        assert.equal(after.historyCalls.append,1);assert.equal(after.calls.journal,0);assert.equal(after.calls.commit,0);
        assert.equal(requests.filter(r=>r.path==='/settlement/confirm').length,1);
        fixture.details={actualChildReplacement:true,parentRetainedSyntheticPersistence:true,sameActorCookie:true,lostStoreAck};
      },true,390,{childNegative:true,loseSealAck:lostStoreAck});
    }
    for(const fault of ['legacy','wrong-generation','malformed','other-actor','history-unreadable','journal']){
      await run('B3 '+fault+' never releases pending browser boot',async(w,fixture)=>{
        const {page,context}=fixture;const {marker}=await lostNativeNegative(w,page);
        if(fault==='history-unreadable')w.hooks.historyRead=()=>{throw Error('synthetic history refusal');};
        if(fault==='journal')w.durable.journal=Buffer.from('{}');
        if(['legacy','wrong-generation','malformed'].includes(fault))await page.evaluate(({KEY,fault})=>{
          const value=JSON.parse(localStorage.getItem(KEY));
          if(fault==='legacy')delete value.generation;
          if(fault==='wrong-generation')value.generation='generation-'+'f'.repeat(32);
          if(fault==='malformed')value.extra=true;
          localStorage.setItem(KEY,JSON.stringify(value));
        },{KEY,fault});
        if(fault==='other-actor'){
          await context.clearCookies();await page.goto(w.origin+'/login');await page.getByLabel('Password',{exact:true}).fill(env.SITE_PASSWORD);
          await page.getByRole('button',{name:'Sign in',exact:true}).click();
        }else await page.reload();
        await reconciliationBoot(page);
        assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY)!==null,KEY),true);
        assert.equal(w.calls.commit,0);assert.equal(w.calls.journal,0);assert.equal(w.historyCalls.append,1);
        fixture.details={fault,neverInitialized:true};
      },true,390,{nativeNegative:true});
    }
    for(const fault of ['base-only','unavailable','incomplete','publication-shape','observation-only','malformed-evidence']){
      await run('B3 negative proof plus '+fault+' data never publishes',async(w,fixture)=>{
        const {page}=fixture;await lostNativeNegative(w,page);
        let ordinary=0;
        await page.route('**/data.json',async route=>{
          ordinary++;const response=await route.fetch(),data=await response.json();
          if(fault==='base-only'||fault==='observation-only'){delete data.settlementEvidence;delete data.settlementEvidenceStatus;}
          if(fault==='unavailable'){delete data.settlementEvidence;data.settlementEvidenceStatus={status:'unavailable'};}
          if(fault==='incomplete')delete data.plan.startingCash;
          if(fault==='malformed-evidence')data.settlementEvidence=null;
          const body=fault==='publication-shape'?{status:'committed',publication:'included',data}:data;
          await route.fulfill({response,json:body,headers:{...response.headers(),
            'X-Atlas-Observation-Qualified':'true','X-Atlas-Observation-Source':'memory'}});
        });
        await page.reload();await reconciliationBoot(page);
        assert.equal(ordinary,1);assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).phase,KEY),'dispatched');
        assert.equal(w.historyCalls.append,1);assert.equal(w.calls.commit,0);
        fixture.details={deliberateDataFault:fault,ordinaryAcquisitions:ordinary,once:0};
      },true,390,{nativeNegative:true});
    }
    for(const fault of ['extra-field','wrong-generation','wrong-operation','live-proof-token']){
      await run('B3 malformed recovery '+fault+' acknowledgement is never cleanup authority',async(w,fixture)=>{
        const {page}=fixture;await lostNativeNegative(w,page);
        await page.route('**/settlement/outcome',async route=>{
          const response=await route.fetch(),proof=await response.json();assert.equal(proof.status,'not-applied');
          if(fault==='extra-field')proof.extra=true;
          if(fault==='wrong-generation')proof.generation='generation-'+'f'.repeat(32);
          if(fault==='wrong-operation')proof.operationId='operation-'+'f'.repeat(32);
          if(fault==='live-proof-token')proof.previewToken='f'.repeat(64);
          return route.fulfill({response,json:proof});
        });
        const traffic=bootTraffic(page);await page.reload();await reconciliationBoot(page);
        assert.equal(traffic.ordinary,0);assert.equal(w.historyCalls.append,1);
        assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).phase,KEY),'dispatched');
        fixture.details={deliberateProofFault:fault,ordinary:0};
      },true,390,{nativeNegative:true});
    }
    for(const fault of ['read-before-removal','remove','read-after-removal','remove-after-effect','lock']){
      await run('B3 '+fault+' fault initializes nothing without invented marker rollback',async(w,fixture)=>{
        const {page,context}=fixture;await lostNativeNegative(w,page);
        await context.addInitScript(({KEY,fault})=>{
          const get=Storage.prototype.getItem,remove=Storage.prototype.removeItem;
          window.__actualPending=()=>get.call(localStorage,KEY);let reads=0;
          Storage.prototype.getItem=function(key){
            if(key===KEY){reads++;if(reads===(fault==='read-before-removal'?2:fault==='read-after-removal'?3:-1))
              throw Error('synthetic pending read refusal');}
            return get.call(this,key);
          };
          Storage.prototype.removeItem=function(key){
            if(key===KEY&&fault==='remove')throw Error('synthetic remove refusal');
            const result=remove.call(this,key);
            if(key===KEY&&fault==='remove-after-effect')throw Error('synthetic lost remove acknowledgement');
            return result;
          };
          if(fault==='lock')navigator.locks.request=()=>Promise.reject(Error('synthetic lock refusal'));
        },{KEY,fault});
        await page.reload();
        await page.locator('[data-boot-notice].crit').waitFor();
        assert.equal(await page.evaluate(()=>App.data),null);
        assert.equal(await page.evaluate(()=>window.__settlementOnce||0),0);
        assert.equal(await page.evaluate(()=>window.__actualPending()===null),['read-after-removal','remove-after-effect'].includes(fault));
        assert.equal(w.calls.commit,0);assert.equal(w.historyCalls.append,1);
        fixture.details={fault,once:0,markerActuallyRemoved:['read-after-removal','remove-after-effect'].includes(fault),noRollbackClaim:true};
      },true,390,{nativeNegative:true});
    }
    for(const replacement of ['same-operation-new-generation','different-operation']){
      await run('B3 delayed negative reply preserves '+replacement,async(w,fixture)=>{
        const {page}=fixture;await lostNativeNegative(w,page);
        let reached,release;const seen=new Promise(r=>{reached=r;}),gate=new Promise(r=>{release=r;});
        await page.route('**/settlement/outcome',async route=>{
          const response=await route.fetch();reached();await gate;return route.fulfill({response});
        });
        try{
          await page.reload();await seen;
          const next=await page.evaluate(async({KEY,replacement})=>navigator.locks.request(KEY,{mode:'exclusive'},()=>{
            const marker=JSON.parse(localStorage.getItem(KEY));marker.generation='generation-'+'f'.repeat(32);
            if(replacement==='different-operation')marker.operationId='operation-'+'f'.repeat(32);
            localStorage.setItem(KEY,JSON.stringify(marker));return marker;
          }),{KEY,replacement});
          release();await reconciliationBoot(page);
          assert.deepEqual(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY),next);
          assert.equal(w.calls.commit,0);assert.equal(w.historyCalls.append,1);
          fixture.details={delayedActualProof:true,replacement,preserved:true};
        }finally{release();}
      },true,390,{nativeNegative:true});
    }
    await run('B3 cancel queued final Web Lock never initializes or clears',async(w,fixture)=>{
      const {page,context}=fixture;await lostNativeNegative(w,page);
      const holder=await context.newPage();await holder.goto(w.origin+'/styles.css'); // Same-origin document with no App boot.
      await holder.evaluate(KEY=>{
        window.__held=navigator.locks.request(KEY,{mode:'exclusive'},()=>new Promise(r=>{window.__release=r;window.__locked=true;}));
      },KEY);await holder.waitForFunction(()=>window.__locked===true);
      await context.addInitScript(KEY=>{
        const request=navigator.locks.request.bind(navigator.locks);
        navigator.locks.request=(name,options,fn)=>{if(name===KEY)window.__queued=true;return request(name,options,fn);};
      },KEY);
      try{
        await page.reload();await page.waitForFunction(()=>window.__queued===true);
        await page.getByRole('button',{name:'Cancel',exact:true}).click();
        await holder.evaluate(()=>window.__release());await page.locator('[data-boot-notice].crit').waitFor();
        assert.equal(await page.evaluate(()=>App.data),null);assert.equal(await page.evaluate(()=>window.__settlementOnce||0),0);
        assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).phase,KEY),'dispatched');
        assert.equal(w.calls.commit,0);assert.equal(w.historyCalls.append,1);
        fixture.details={actualSecondPageLock:true,cancelledWhileQueued:true,once:0};
      }finally{await holder.evaluate(()=>window.__release());await holder.close();}
    },true,390,{nativeNegative:true});
    for(const failure of ['once-hook','render']){
      await run('B3 post-publication '+failure+' failure withholds shell and allows only whole reload',async(w,fixture)=>{
        const {page}=fixture;await lostNativeNegative(w,page);
        await page.route('**/plan.js',async route=>{
          const response=await route.fetch(),body=await response.text();
          const instrumentation="App.once(()=>{window.__settlementOnce=(window.__settlementOnce||0)+1;});\n"
            +(failure==='once-hook'?"App.once(()=>{throw Error('synthetic once failure');});\n":
              "App.register(()=>{window.__failedRender=(window.__failedRender||0)+1;throw Error('synthetic render failure');});\n");
          return route.fulfill({response,body:instrumentation+body});
        });
        await page.reload();await page.getByRole('button',{name:'Reload page',exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>window.__settlementOnce),1);
        assert.equal(await page.evaluate(()=>App.data!==null),true,'publication started; no invented rollback');
        assert.equal(await page.evaluate(()=>document.querySelector('.site-head').inert),true);
        assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),null,'valid negative marker was removed before hooks');
        assert.equal(await page.locator('[data-manual-refresh]').isDisabled(),true);
        await page.evaluate(()=>App.rerender());
        assert.equal(await page.evaluate(()=>window.__settlementOnce),1);
        if(failure==='render')assert.equal(await page.evaluate(()=>window.__failedRender),1,'failed page never renders in place again');
        const outcomeCalls=fixture.requests.filter(r=>r.path==='/settlement/outcome').length;
        await page.unroute('**/plan.js');
        await page.route('**/plan.js',async route=>{
          const response=await route.fetch();return route.fulfill({response,body:
            'App.once(()=>{window.__settlementOnce=(window.__settlementOnce||0)+1;});\n'+await response.text()});
        });
        await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Reload page',exact:true}).click()]);
        await b3Ready(page);assert.equal(fixture.requests.filter(r=>r.path==='/settlement/outcome').length,outcomeCalls);
        assert.equal(w.calls.commit,0);assert.equal(w.historyCalls.append,1);
        fixture.details={deliberateHookFault:failure,oldPageOnce:1,noInPlaceRetry:true,fullReloadRecovered:true};
      },true,390,{nativeNegative:true});
    }

    await run('B3 lost negative HTTP reply recovers qualified ordinary view', async (w, fixture) => {
      const { page } = fixture;
      const prepared = page.waitForResponse(r => r.url().endsWith('/settlement/prepare'));
      const dialog = await preview(page); const p = await (await prepared).json();
      w.setClock(p.expiresAt);
      await page.route('**/settlement/confirm', async route => {
        const response = await route.fetch();
        assert.equal((await response.json()).status, 'not-applied');
        await route.abort(); // Deliberately lose the real mounted HTTP reply.
      });
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      await page.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
      const marker = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
      assert.equal(marker.phase, 'dispatched'); assert.equal(w.historyCalls.append, 1);
      const before = w.snapshot(); await page.reload();
      await page.waitForFunction(KEY => App.data?.settlementEvidenceStatus?.status === 'qualified'
        && localStorage.getItem(KEY) === null && window.__settlementOnce === 1, KEY);
      assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
      assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
      assert.equal(w.historyCalls.append, 1); assert.equal(w.snapshot().historyBytes, before.historyBytes);
      fixture.details = { deliberateLostHttpReply: true, nativeSyntheticHistory: true, qualifiedOrdinaryBoot: true };
    }, true, 390, { nativeNegative: true });
    await run('default inactive controls and zero storage', async (w, { page }) => {
      const dialog = await sheet(page);
      await page.waitForResponse(r => r.url().endsWith('/settlement/capability')).catch(() => {});
      assert.equal(await dialog.getByRole('button', { name: 'Assign a recorded payment' }).count(), 0);
      assert.equal(await dialog.getByRole('button', { name: 'Withdraw an assignment' }).count(), 0);
      assert.equal(w.calls.storage, 0); assert.equal(w.calls.acquire, 0);
    }, false);
    await run('raw storage refusal boots ordinary data only with real sealed preactivation attestation', async (w, fixture) => {
      const { page, context } = fixture;
      await refuseStorageReads(context); const traffic = bootTraffic(page);
      const classified = page.waitForResponse(response => response.url().endsWith('/settlement/capability')
        && response.request().headers()['x-atlas-settlement'] === 'same-origin');
      await page.reload();
      assert.deepEqual(await (await classified).json(), { status: 'inactive', bootClassification: 'preactivation-only' });
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null && window.__settlementOnce === 1);
      const dialog = await sheet(page);
      assert.equal(await dialog.getByRole('button', { name: 'Assign a recorded payment', exact: true }).count(), 0);
      assert.deepEqual(traffic, { ordinary: 1, classification: 1 });
      assert.deepEqual(w.calls, { storage: 0, journal: 0, commit: 0, acquire: 0, base: 0 });
      fixture.details = { traffic, once: 1, trustedDeploymentAssertionOnly: true };
    }, false, 390, { preactivationOnly: true });
    for (const active of [false, true]) {
      await run('raw storage refusal with ' + (active ? 'active' : 'history-unknown inactive') + ' construction stays fenced', async (w, fixture) => {
        const { page, context } = fixture;
        const before = { ...w.calls };
        await refuseStorageReads(context); const traffic = bootTraffic(page);
        await page.reload(); await reconciliationBoot(page);
        assert.deepEqual(traffic, { ordinary: 0, classification: 1 });
        assert.deepEqual(w.calls, before);
        fixture.details = { traffic, once: 0, active };
      }, active);
    }
    for (const failure of ['unauthorized', 'unavailable', 'malformed-json', 'unknown-classification', 'extra-field', 'network']) {
      await run('raw storage refusal with ' + failure + ' classification never initializes figures', async (w, fixture) => {
        const { page, context } = fixture;
        await refuseStorageReads(context); const traffic = bootTraffic(page);
        await page.route('**/settlement/capability', async route => {
          if (route.request().headers()['x-atlas-settlement'] !== 'same-origin') return route.continue();
          if (failure === 'unauthorized') {
            const response = await route.fetch({ headers: { ...route.request().headers(), Cookie: 'hfd_session=synthetic-invalid' } });
            assert.equal(response.status(), 401); return route.fulfill({ response });
          }
          if (failure === 'network') return route.abort();
          return route.fulfill({ status: failure === 'unavailable' ? 503 : 200, contentType: 'application/json',
            body: failure === 'malformed-json' ? '{' : JSON.stringify(failure === 'extra-field'
              ? { status: 'inactive', bootClassification: 'preactivation-only', extra: true }
              : { status: 'inactive', bootClassification: 'unknown' }) });
        });
        await page.reload(); await reconciliationBoot(page);
        assert.deepEqual(traffic, { ordinary: 0, classification: 1 });
        assert.equal(w.calls.storage, 0); assert.equal(w.calls.commit, 0);
        fixture.details = { traffic, failure, deliberateClassificationFault: true };
      }, false, 390, { preactivationOnly: true });
    }
    await run('raw storage refusal with timed-out classification stays fenced under deterministic browser clock', async (w, fixture) => {
      const { page, context } = fixture;
      await refuseStorageReads(context); const traffic = bootTraffic(page);
      await page.clock.install();
      let received, release;
      const seen = new Promise(resolve => { received = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      await page.route('**/settlement/capability', async route => {
        if (route.request().headers()['x-atlas-settlement'] !== 'same-origin') return route.continue();
        const response = await route.fetch(); received(); await held;
        await route.fulfill({ response }).catch(() => {});
      });
      try {
        const navigation = page.reload({ waitUntil: 'domcontentloaded' });
        await seen; await page.clock.fastForward(20001); await navigation;
        await reconciliationBoot(page);
        assert.deepEqual(traffic, { ordinary: 0, classification: 1 });
        assert.equal(w.calls.storage, 0); assert.equal(w.calls.commit, 0);
        fixture.details = { traffic, heldActualClassificationReply: true, advancedMs: 20001 };
      } finally { release(); }
    }, false, 390, { preactivationOnly: true });
    await run('readable malformed markers never request preactivation exception even when sealed', async (w, fixture) => {
      const { page } = fixture; const traffic = bootTraffic(page);
      for (const value of ['{', 'x'.repeat(161), JSON.stringify({ operationId: 'invalid', phase: 'preview' }),
        JSON.stringify({ operationId: 'operation-' + 'a'.repeat(32), phase: 'dispatched', extra: true }),
        ...[null, {}, 'invalid'].map(generation => JSON.stringify({ operationId: 'operation-' + 'a'.repeat(32), phase: 'dispatched', generation }))]) {
        await page.evaluate(({ KEY, value }) => localStorage.setItem(KEY, value), { KEY, value });
        await page.reload(); await reconciliationBoot(page);
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), value);
      }
      assert.deepEqual(traffic, { ordinary: 0, classification: 0 });
      assert.equal(w.calls.storage, 0); assert.equal(w.calls.commit, 0);
      fixture.details = { traffic, readableMalformedCases: 4 };
    }, false, 390, { preactivationOnly: true });
    await run('readable dispatched marker never bypasses recovery even when sealed', async (w, fixture) => {
      const { page, requests } = fixture; const traffic = bootTraffic(page);
      const marker = { operationId: 'operation-' + 'a'.repeat(32), phase: 'dispatched' };
      await page.evaluate(({ KEY, marker }) => localStorage.setItem(KEY, JSON.stringify(marker)), { KEY, marker });
      await page.reload(); await reconciliationBoot(page);
      assert.deepEqual(await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY), marker);
      assert.deepEqual(traffic, { ordinary: 0, classification: 0 });
      assert.equal(requests.filter(request => request.path === '/settlement/outcome').length, 1);
      assert.equal(requests.filter(request => request.path === '/settlement/confirm').length, 0);
      assert.equal(w.calls.storage, 0); fixture.details = { traffic, retainedDispatched: true };
    }, false, 390, { preactivationOnly: true });
    for (const width of [390, 1440]) {
      await run('raw constructor ordinary reload preserves assignment withdrawal and separate relink ' + width, async (w, fixture) => {
        const { page, requests } = fixture;
        assert.equal(w.base.settlementEvidenceStatus, undefined, 'raw base has no fixture attachment');
        const reload = async expected => {
          assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
          const recoveryPosts = requests.filter(r => ['/settlement/outcome', '/settlement/publication'].includes(r.path)).length;
          await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
          const status = await page.evaluate(() => App.data.settlementEvidenceStatus?.status || 'absent');
          fixture.details = { synthetic: true, ordinaryStatus: status, commits: w.calls.commit, rawBase: true };
          assert.equal(status, 'qualified'); assert.deepEqual(await facts(page), expected);
          assert.equal(requests.filter(r => ['/settlement/outcome', '/settlement/publication'].includes(r.path)).length, recoveryPosts,
            'ordinary reload does not recover an old receipt');
        };
        await complete(page, await preview(page));
        await reload({ original: 60, paid: 25, remaining: 35 }); assert.equal(w.calls.commit, 1);
        await completeWithdrawal(page, await withdrawalPreview(page));
        await reload({ original: 60, paid: 0, remaining: 60 }); assert.equal(w.calls.commit, 2);
        await complete(page, await preview(page));
        await reload({ original: 60, paid: 25, remaining: 35 }); assert.equal(w.calls.commit, 3);
      }, true, width);
    }
    await run('ordinary read failure withholds stale browser figures then recovers without a write', async (w, { page }) => {
      await complete(page, await preview(page));
      w.base.settlementEvidence = { hostile: true }; w.base.settlementEvidenceStatus = { status: 'qualified' }; w.readFailure = true;
      await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      assert.equal(await page.evaluate(() => App.data.settlementEvidenceStatus.status), 'unavailable');
      assert.equal(await page.evaluate(() => App.data.settlementEvidence), undefined);
      await page.locator('[data-settlement-evidence="unavailable"][data-settlement-reason="pin-unavailable"]:visible').first().waitFor();
      assert.equal(await page.locator('[data-budget-savings-goals]').count(), 0,
        'the incumbent renderer withholds the dependent Savings panel');
      assert.doesNotMatch(await page.locator('body').innerText(), /\$25(?:\.00)?\b|\$35(?:\.00)?\b/);
      assert.equal(await page.evaluate(() => window.__settlementOnce), 1, 'complete withheld base initializes consumers once');
      assert.equal(w.calls.commit, 1); w.readFailure = false;
      await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 }); assert.equal(w.calls.commit, 1);
    });
    await run('ordinary policy refusal never installs browser DATA or once-hooks', async (w, { page }) => {
      await complete(page, await preview(page)); const reads = w.calls.storage; w.authorized = false;
      await page.reload(); await page.getByText('Current data could not be loaded. Figures remain unavailable.', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => App.data), null); assert.equal(await page.evaluate(() => window.__settlementOnce || 0), 0);
      assert.equal(w.calls.storage, reads); assert.equal(w.calls.commit, 1); w.authorized = true;
      await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 }); assert.equal(w.calls.commit, 1);
    });
    await run('ordinary cross-login browser projection does not recover another login receipt', async (w, { page, context, requests }) => {
      await complete(page, await preview(page)); const original = JSON.parse(w.durable.doc).operations[0];
      const receipt = await w.store.outcome({ actorId: original.actorId, operationId: original.operationId });
      const posts = requests.filter(r => ['/settlement/outcome', '/settlement/publication'].includes(r.path)).length;
      await context.clearCookies(); await page.goto(w.origin + '/login');
      await page.getByLabel('Password', { exact: true }).fill(env.SITE_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      assert.equal(await page.evaluate(() => App.data.settlementEvidenceStatus?.status), 'qualified');
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
      const data = await page.evaluate(() => JSON.stringify(App.data));
      assert.ok(!data.includes(receipt.digest) && !data.includes(original.actorId));
      assert.equal(requests.filter(r => ['/settlement/outcome', '/settlement/publication'].includes(r.path)).length, posts);
      assert.equal(w.calls.commit, 1);
    });
    await run('real Savings sheet preview, confirm, full reload and independent 60/25/35', async (w, { page, requests }) => {
      const dialog = await preview(page); assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
      // The sheet moves the original source, including this live form.
      assert.equal(await dialog.locator('[data-budget-funding-savings] [data-settlement-assignment]').count(), 1);
      await dialog.screenshot({ path: path.join(out, 'preview-390.png') });
      await complete(page, dialog);
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
      const after = await sheet(page);
      await after.screenshot({ path: path.join(out, 'saved-390.png') });
      const first = await after.innerText();
      assert.match(first, /\$25\.00/); assert.match(first, /\$35\.00/);
      await page.keyboard.press('Escape');
      // Refined face: the savings detail was opened to reach Accounts & evidence;
      // close it so the snapshot compares the same face a rerender produces.
      await (async t => { const p = t.locator('.blend-goals-panel'); if (await p.count() && await p.evaluate(n => n.open)) await t.locator('.blend-tile-head').click(); })(page.locator('[data-budget-savings-goals]'));
      const original = await page.locator('[data-budget-savings-goals]').innerText();
      await page.evaluate(() => App.rerender());
      assert.equal(await page.locator('[data-budget-savings-goals]').innerText(), original);
      const step = async key => {
        const start = await page.locator('[data-budget-window-progress]').getAttribute('data-start');
        await page.locator('.river').focus(); await page.keyboard.press(key);
        await page.waitForFunction(start => document.querySelector('[data-budget-window-progress]')?.dataset.start !== start, start);
      };
      await step('ArrowRight'); const next = await page.locator('[data-budget-savings-goals]').innerText();
      await step('ArrowLeft'); assert.equal(await page.locator('[data-budget-savings-goals]').innerText(), original);
      await step('ArrowRight'); assert.equal(await page.locator('[data-budget-savings-goals]').innerText(), next);
      assert.equal(w.calls.commit, 1);
      assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 1);
      assert.equal(requests.filter(x => x.path === '/settlement/publication').length, 1);
      await page.reload();
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
      await step('ArrowRight'); assert.equal(await page.locator('[data-budget-savings-goals]').innerText(), next);
    });
    await run('restart before dispatch abandons only the never-sent preview', async (w, { page, requests }) => {
      await preview(page); await page.reload();
      await page.waitForFunction(() => App.data !== null);
      assert.equal(w.calls.commit, 0);
      assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
      assert.equal(requests.filter(x => x.path === '/settlement/outcome').length, 0);
      await preview(page); assert.equal(w.calls.commit, 0);
    });
    await run('two-tab stale preview boot cannot erase a dispatched reconciliation marker', async (w, fixture) => {
      const { page, context, requests } = fixture;
      const dialog = await preview(page);
      const operationId = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)).operationId, KEY);
      const generation = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)).generation, KEY);
      const second = await context.newPage(); second.setDefaultTimeout(15000);
      const secondRequests = [];
      second.on('pageerror', error => fixture.errors.push(error.message));
      second.on('request', request => secondRequests.push(new URL(request.url()).pathname));
      let releaseBoot, readBoot;
      const bootGate = new Promise(resolve => { releaseBoot = resolve; });
      const bootRead = new Promise(resolve => { readBoot = resolve; });
      await second.exposeBinding('__settlementBootPause', async (_, marker) => {
        readBoot(marker); await bootGate;
      });
      await second.route('**/*', route => {
        if (new URL(route.request().url()).origin !== w.origin) {
          fixture.external.push(new URL(route.request().url()).origin); return route.abort();
        }
        return route.continue();
      });
      await second.route('**/app.js', async route => {
        const response = await route.fetch(), source = await response.text();
        const anchor = 'try { marker = parsePending(raw); } catch';
        assert.equal(source.split(anchor).length, 2, 'one initial marker-read observation point');
        // Deliberate scheduling only: pause B after its real shared-storage
        // read. A still uses the actual script and actual mounted confirm.
        await route.fulfill({ response, body: source.replace(anchor,
          'try { marker = parsePending(raw); await window.__settlementBootPause(marker); } catch') });
      });
      await second.route('**/plan.js', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: 'App.once(() => { window.__settlementOnce = (window.__settlementOnce || 0) + 1; });\n' + await response.text() });
      });
      try {
        const navigation = second.goto(w.origin + '/');
        assert.deepEqual(await bootRead, { operationId, phase: 'preview', generation });
        await page.route('**/settlement/confirm', async route => { await route.fetch(); return route.abort(); });
        await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
        await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
        assert.equal(w.calls.commit, 1);
        const receiptDocument = Buffer.from(w.durable.doc);
        assert.equal(await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)).phase, KEY), 'dispatched');
        w.readFailure = true; releaseBoot(); await navigation;
        await second.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
        const marker = await second.evaluate(KEY => localStorage.getItem(KEY), KEY);
        fixture.details = { realSharedContext: true, pausedBootPhase: 'preview',
          responseDroppedAfterCommit: true, secondRequests, retainedDispatched: marker !== null };
        assert.ok(marker, 'B must not erase A\'s now-dispatched marker using its stale preview read');
        assert.deepEqual(JSON.parse(marker), { operationId, phase: 'dispatched', generation });
        assert.equal(secondRequests.filter(path => path === '/data.json').length, 0, 'B cannot fall through to ordinary data');
        assert.equal(secondRequests.filter(path => path === '/settlement/outcome').length, 1);
        assert.equal(secondRequests.filter(path => path === '/settlement/publication').length, 1);
        await second.locator('[data-settlement-recovery]').waitFor();
        assert.equal(await second.evaluate(() => App.data.settlementEvidenceStatus.status), 'unavailable');
        assert.equal(await second.evaluate(() => window.__settlementOnce), 1);
        w.readFailure = false; await page.reload();
        await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
        await page.waitForFunction(KEY => localStorage.getItem(KEY) === null, KEY);
        assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
        assert.equal(w.calls.commit, 1); assert.ok(w.durable.doc.equals(receiptDocument));
        assert.equal(requests.filter(request => request.path === '/settlement/confirm').length, 1);
      } finally { releaseBoot(); await second.close(); }
    });
    await run('all marker mutations are locked and a stale prepared tab cannot overwrite dispatch', async (w, fixture) => {
      const { page, context, requests } = fixture;
      await context.addInitScript(observeMarkerMutations);
      await page.evaluate(observeMarkerMutations);
      const second = await context.newPage(); second.setDefaultTimeout(15000);
      second.on('pageerror', error => fixture.errors.push(error.message));
      await second.route('**/*', route => {
        if (new URL(route.request().url()).origin !== w.origin) {
          fixture.external.push(new URL(route.request().url()).origin); return route.abort();
        }
        return route.continue();
      });
      let releasePrepare, prepared;
      const gate = new Promise(resolve => { releasePrepare = resolve; });
      const seen = new Promise(resolve => { prepared = resolve; });
      await second.route('**/settlement/prepare', async route => {
        const response = await route.fetch(); prepared(); await gate;
        await route.fulfill({ response });
      });
      try {
        await second.goto(w.origin + '/');
        await second.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
        const otherDialog = await sheet(second);
        await otherDialog.getByRole('button', { name: 'Assign a recorded payment', exact: true }).click();
        await otherDialog.getByLabel('Amount to assign (CAD)', { exact: true }).fill('25.00');
        await otherDialog.getByRole('button', { name: 'Preview assignment', exact: true }).click();
        await seen;
        const dialog = await preview(page);
        await page.route('**/settlement/confirm', async route => { await route.fetch(); return route.abort(); });
        await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
        await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
        const dispatched = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
        releasePrepare();
        await otherDialog.getByText('Preview unavailable. No confirmation was sent.', { exact: false }).waitFor();
        assert.equal(await second.evaluate(KEY => localStorage.getItem(KEY), KEY), dispatched);
        assert.equal(await otherDialog.getByRole('button', { name: 'Confirm assignment', exact: true }).count(), 0);
        const before = await page.evaluate(() => window.__markerMutations);
        assert.deepEqual(before, [{ method: 'setItem', locked: true }, { method: 'setItem', locked: true }]);
        assert.deepEqual(await second.evaluate(() => window.__markerMutations), []);
        await page.reload();
        await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified'
          && localStorage.getItem(KEY) === null, KEY);
        const after = await page.evaluate(() => window.__markerMutations);
        assert.deepEqual(after, [{ method: 'removeItem', locked: true }]);
        assert.equal(w.calls.commit, 1);
        assert.equal(requests.filter(request => request.path === '/settlement/confirm').length, 1);
        fixture.details = { before, after, stalePreparedResponseRefused: true, sharedContext: true };
      } finally { releasePrepare(); await second.close(); }
    });
    await run('missing cross-tab lock support refuses active controls without dispatch', async (w, { page, context, requests }) => {
      await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
      await page.reload();
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      const dialog = await sheet(page);
      await dialog.getByText('Assignment controls unavailable.', { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Assign a recorded payment', exact: true }).count(), 0);
      assert.equal(requests.filter(request => ['/settlement/prepare', '/settlement/confirm'].includes(request.path)).length, 0);
      assert.equal(w.calls.commit, 0);
    });
    await run('lost commit response, recreated controller, same original receipt, no second commit', async (w, { page, requests }) => {
      const dialog = await preview(page);
      await page.route('**/settlement/confirm', async route => { await route.fetch(); return route.abort(); });
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
      assert.equal(w.calls.commit, 1); const original = Buffer.from(w.durable.doc);
      w.recreate(); await page.unroute('**/settlement/confirm'); await page.reload();
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
      assert.ok(w.durable.doc.equals(original)); assert.equal(w.calls.commit, 1);
      assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 1);
      assert.equal(await page.evaluate(() => window.__settlementOnce), 1);
    });
    await run('active lost response then disabled composition retains uncertainty and recovers without new confirm', async (w, fixture) => {
      const { page, requests } = fixture;
      const dialog = await preview(page);
      await page.route('**/settlement/confirm', async route => { await route.fetch(); return route.abort(); });
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
      const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
      const document = Buffer.from(w.durable.doc), before = { ...w.calls };
      w.recreate('disabled'); const traffic = bootTraffic(page);
      await page.reload(); await reconciliationBoot(page);
      assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
      assert.deepEqual(traffic, { ordinary: 0, classification: 0 });
      assert.deepEqual(w.calls, before); assert.ok(w.durable.doc.equals(document));
      assert.equal(requests.filter(request => request.path === '/settlement/confirm').length, 1);
      w.recreate('active'); await page.unroute('**/settlement/confirm'); await page.reload();
      await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified'
        && localStorage.getItem(KEY) === null, KEY);
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
      assert.equal(w.calls.commit, 1); assert.ok(w.durable.doc.equals(document));
      assert.equal(requests.filter(request => request.path === '/settlement/confirm').length, 1);
      fixture.details = { traffic, disabledRetainedUncertainty: true, sameReceipt: true };
    });
    await run('saved view unavailable boots withheld object and recovers by whole reload', async (w, { page }) => {
      const dialog = await preview(page);
      w.readFailure = true;
      await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click()]);
      await page.locator('[data-settlement-recovery]').waitFor();
      assert.match(await page.locator('[data-settlement-recovery]').innerText(), /Saved; view unavailable/);
      assert.equal(await page.evaluate(() => App.data.settlementEvidenceStatus.status), 'unavailable');
      assert.equal(await page.evaluate(() => Object.hasOwn(App.data, 'settlementEvidence')), false);
      assert.equal(await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)).phase, KEY), 'dispatched');
      assert.equal(await page.evaluate(() => window.__settlementOnce), 1);
      w.readFailure = false;
      await page.getByRole('button', { name: 'Check saved view', exact: true }).click();
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 }); assert.equal(w.calls.commit, 1);
    });
    await run('unknown dispatched restart never loads stale ordinary data or once-hooks', async (w, { page, requests }) => {
      const dialog = await preview(page);
      await page.route('**/settlement/confirm', route => route.abort());
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
      assert.equal(w.calls.commit, 0);
      let ordinary = 0; page.on('request', r => { if (new URL(r.url()).pathname === '/data.json') ordinary++; });
      await page.reload(); await page.getByText('Assignment outcome needs reconciliation. Figures remain unavailable.', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => App.data), null);
      assert.equal(await page.evaluate(() => window.__settlementOnce || 0), 0); assert.equal(ordinary, 0);
      assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 1);
    });
    await run('persistence failure prevents confirm dispatch', async (w, { page, requests }) => {
      const dialog = await preview(page);
      const traffic = bootTraffic(page);
      await page.evaluate(KEY => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key === KEY && JSON.parse(value).phase === 'dispatched') throw new Error('synthetic storage refusal');
          return original.call(this, key, value);
        };
      }, KEY);
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      await dialog.getByText('Confirmation was not sent:', { exact: false }).waitFor();
      assert.equal(w.calls.commit, 0);
      assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 0);
      assert.equal(traffic.classification, 0, 'persistence failure cannot request the boot exception');
      await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
      assert.equal(traffic.classification, 0);
    });
    await run('new signed login cannot recover an old session receipt or clear uncertainty', async (w, { page, requests }) => {
      const dialog = await preview(page);
      await page.route('**/settlement/confirm', async route => { await route.fetch(); return route.abort(); });
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
      const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
      await page.context().clearCookies();
      await page.goto(w.origin + '/login');
      await page.getByLabel('Password', { exact: true }).fill(env.SITE_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByText('Assignment outcome needs reconciliation. Figures remain unavailable.', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => App.data), null);
      assert.equal(await page.evaluate(() => window.__settlementOnce || 0), 0);
      assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
      assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 1); assert.equal(w.calls.commit, 1);
    });
    await run('malformed publication fails before DATA/once-hooks then whole reload recovers', async (w, { page }) => {
      const dialog = await preview(page);
      await page.route('**/settlement/publication', async route => {
        await route.fetch();
        return route.fulfill({ json: { status: 'committed', publication: 'included', data: { plan: {}, meta: {}, settlementEvidenceStatus: { status: 'qualified' }, settlementEvidence: {} } } });
      });
      await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click()]);
      await page.getByText('Assignment outcome needs reconciliation. Figures remain unavailable.', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => App.data), null); assert.equal(await page.evaluate(() => window.__settlementOnce || 0), 0);
      assert.equal(await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)).phase, KEY), 'dispatched');
      await page.unroute('**/settlement/publication'); await page.reload();
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 }); assert.equal(w.calls.commit, 1);
    });
    await run('desktop actual sheet controls and single-effect double click', async (w, { page }) => {
      const dialog = await preview(page); await complete(page, dialog);
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
      assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1);
      await (await sheet(page)).screenshot({ path: path.join(out, 'saved-1440.png') });
    }, true, 1440);
    await run('successful purchase assignment leaves unrelated card-coverage holds unresolved', async (w, { page }) => {
      w.base.liveOverlay.currentPeriodActuals.cardCoverageRequired = true;
      w.acquisition.packet.cardCoverageRequired = true;
      await page.reload();
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.liveOverlay?.currentPeriodActuals.cardCoverageRequired === true);
      const coverage = () => page.evaluate(() => {
        const d = App.data;
        return Forecast.recommend(d.plan, d.meta.asOf, { ...d.liveOverlay, debts: d.debts,
          weeklyVariable: 0, settlementEvidence: d.settlementEvidence }).cardPurchaseCoverage;
      });
      const before = await coverage(); assert.equal(before.status, 'unavailable'); assert.equal(before.reservedCash, null);
      await complete(page, await preview(page));
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
      assert.deepEqual(await coverage(), before); assert.equal(w.calls.commit, 1);
    });
    await run('pending boot actual mounted HTTP401 keeps marker and never loads ordinary data or once-hooks', async (w, { page, requests }) => {
      const dialog = await preview(page);
      await page.route('**/settlement/confirm', async route => { await route.fetch(); return route.abort(); });
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
      const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
      // Deliberate request fault: the upstream mounted outcome route receives
      // an invalid cookie and actually returns 401. No fabricated data/body.
      await page.route('**/settlement/outcome', async route => {
        const response = await route.fetch({ headers: { ...route.request().headers(), cookie: 'hfd_session=synthetic-invalid-cookie' } });
        assert.equal(response.status(), 401);
        return route.fulfill({ response });
      });
      let ordinary = 0; page.on('request', r => { if (new URL(r.url()).pathname === '/data.json') ordinary++; });
      const unauthorized = page.waitForResponse(r => r.url().endsWith('/settlement/outcome') && r.status() === 401);
      await page.reload(); await unauthorized;
      await page.getByText('Assignment outcome needs reconciliation. Figures remain unavailable.', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => App.data), null);
      assert.equal(await page.evaluate(() => window.__settlementOnce || 0), 0);
      assert.equal(ordinary, 0); assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
      assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 1); assert.equal(w.calls.commit, 1);
    });
    for (const dismissal of ['close button', 'Escape cancellation']) {
      await run(dismissal + ' during dispatched confirm preserves marker and cannot confirm twice', async (w, { page, requests }) => {
        const dialog = await preview(page);
        let reached, release;
        const entered = new Promise(resolve => { reached = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        await page.route('**/settlement/confirm', async route => {
          const response = await route.fetch(); // real application commits once
          reached(); await gate; // deliberately hold only its response
          return route.fulfill({ response });
        });
        try {
          await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
          await entered;
          const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
          assert.equal(JSON.parse(marker).phase, 'dispatched'); assert.equal(w.calls.commit, 1);
          if (dismissal === 'close button') await dialog.locator('[data-budget-detail-close]').click();
          else await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
          assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
          const reopened = await sheet(page);
          assert.equal(await reopened.getByRole('button', { name: 'Confirm assignment', exact: true }).isEnabled(), false);
          assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 1);
          const loaded = page.waitForEvent('load'); release(); await loaded;
          await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
          assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
          assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1);
        } finally { release(); }
      });
    }
    let previewClock = Date.now();
    await run('deterministically expired preview returns bound no-effect proof and permits explicit reload', async (w, { page, requests }) => {
      const dialog = await preview(page);
      const marker = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
      previewClock += require('../scripts/planned-obligation-settlement-contract').TTL_MS;
      const response = page.waitForResponse(r => r.url().endsWith('/settlement/confirm'));
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      const ack = await (await response).json();
      assert.equal(ack.status, 'not-applied'); assert.equal(ack.operationId, marker.operationId);
      assert.equal(ack.generation, marker.generation); assert.match(ack.previewToken, /^[a-f0-9]{64}$/);
      await dialog.getByText('Not saved.', { exact: false }).waitFor();
      assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
      assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
      assert.equal(requests.filter(x => x.path === '/settlement/outcome').length, 0);
      await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Reload current view', exact: true }).click()]);
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
      assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 1);
    }, true, 390, { now: () => previewClock });
    await run('received probe mismatch proof clears marker and permits ordinary browser reload', async (w, fixture) => {
      const { page, requests } = fixture, dialog = await preview(page);
      const marker = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
      const control = armProbeCompetition(w, marker.operationId);
      const pending = page.waitForResponse(r => r.url().endsWith('/settlement/confirm'));
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      const response = await pending, result = await response.json(), request = response.request().postDataJSON();
      const bound = require('node:util').isDeepStrictEqual(result, { status: 'not-applied', operationId: request.operationId,
        previewToken: request.previewToken, generation: request.generation });
      fixture.details = { synthetic: true, status: result.status, reason: result.reason, exactProofBound: bound,
        successfulProbe: control.successfulProbe, refusedCommitInvocations: w.calls.commit, journalWrites: w.calls.journal };
      if (!bound) {
        await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
        const dispatched = await page.evaluate(KEY => localStorage.getItem(KEY), KEY); assert.equal(JSON.parse(dispatched).phase, 'dispatched');
        await page.reload(); await reconciliationBoot(page);
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), dispatched);
        Object.assign(fixture.details, { markerRetained: true, reloadData: null, reloadOnceHooks: 0 });
      }
      assert.equal(bound, true, 'received real successful-probe mismatch must prove exact retained generation');
      await dialog.getByText('Not saved.', { exact: false }).waitFor();
      assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
      await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Reload current view', exact: true }).click()]);
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
      assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
      assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 1); assert.ok(w.durable.doc.equals(control.competing.doc));
      assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 1);
    });
    await run('withdrawal late probe mismatch clears only its proof and retains the original assignment', async (w, { page, requests }) => {
      await complete(page, await preview(page)); const dialog = await withdrawalPreview(page);
      const marker = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
      const control = armProbeCompetition(w, marker.operationId);
      await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
      await dialog.getByText('Not saved. No withdrawal was recorded.', { exact: false }).waitFor();
      assert.equal(control.successfulProbe, true); assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
      await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Reload current view', exact: true }).click()]);
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified');
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
      assert.ok(w.durable.doc.equals(control.competing.doc)); assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 2);
      assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 2);
    });
    for (const fault of ['lost-reply', 'legacy-marker', 'mismatched-marker', 'postauthorization']) {
      await run('probe mismatch ' + fault + ' retains unresolved browser marker', async (w, { page, requests }) => {
        const dialog = await preview(page), marker = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
        const control = armProbeCompetition(w, marker.operationId);
        if (fault === 'postauthorization') {
          let calls = 0; w.hooks.authorize = async () => { if (control.successfulProbe && ++calls === 2) w.authorized = false; };
        } else await page.route('**/settlement/confirm', async route => {
          const response = await route.fetch(); assert.equal((await response.json()).status, 'not-applied');
          if (fault === 'lost-reply') return route.abort('failed');
          await page.evaluate(({ KEY, fault }) => navigator.locks.request(KEY, { mode: 'exclusive' }, () => {
            const current = JSON.parse(localStorage.getItem(KEY));
            if (fault === 'legacy-marker') delete current.generation;
            else current.generation = 'generation-' + 'f'.repeat(32);
            localStorage.setItem(KEY, JSON.stringify(current));
          }), { KEY, fault });
          return route.fulfill({ response });
        });
        await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
        await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
        const retained = await page.evaluate(KEY => localStorage.getItem(KEY), KEY); assert.equal(JSON.parse(retained).phase, 'dispatched');
        await page.reload(); await reconciliationBoot(page);
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), retained);
        assert.ok(w.durable.doc.equals(control.competing.doc)); assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 1);
        assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 1);
      });
    }
    for (const journal of [false, true]) {
      await run('generic post-store ' + (journal ? 'recovery-required' : 'conflict') + ' retains browser uncertainty', async (w, { page, requests }) => {
        const dialog = await preview(page), prepare = w.store.prepare; let incoming, competing;
        w.store.prepare = async input => { incoming = input; return prepare(input); };
        w.hooks.admission = async () => { competing = await appendCompetingRecord(w, incoming,
          { sameId: !journal, journal }, prepare); };
        const response = page.waitForResponse(r => r.url().endsWith('/settlement/confirm'));
        await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
        assert.deepEqual(await (await response).json(), { status: 'rejected', reason: journal ? 'recovery-required' : 'store-conflict' });
        await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
        const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY); assert.equal(JSON.parse(marker).phase, 'dispatched');
        await page.reload(); await reconciliationBoot(page);
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
        assert.ok(w.durable.doc.equals(competing.doc)); if (journal) assert.ok(w.durable.journal.equals(competing.journal));
        assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1);
        assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 1);
      });
    }
    for (const refusal of ['selection-change', 'admission-refused']) {
      await run('received terminal proof for ' + refusal + ' clears only its marker', async (w, { page, requests }) => {
        await page.evaluate(observeMarkerMutations);
        await page.evaluate(() => {
          const original = window.fetch;
          window.__networkWhileMarkerLocked = false;
          window.fetch = (...args) => { window.__networkWhileMarkerLocked ||= window.__markerLockHeld; return original(...args); };
        });
        const dialog = await preview(page);
        if (refusal === 'selection-change') w.acquisition.packet.observationAsOf = '2026-10-06';
        else w.hooks.admission = async () => { w.cell.revision++; };
        await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
        await dialog.getByText('Not saved.', { exact: false }).waitFor();
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
        assert.equal(await page.evaluate(() => window.__networkWhileMarkerLocked), false);
        assert.ok((await page.evaluate(() => window.__markerMutations)).every(m => m.locked));
        assert.equal(w.calls.journal, 0); assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 1);
      });
    }
    let storeExpiryClock = Date.now();
    await run('real store expiry after controller check releases only proven no-effect generation', async (w, fixture) => {
      const { page, requests } = fixture; const dialog = await preview(page);
      const before = Buffer.from(w.durable.doc), pin = JSON.stringify(w.durable.pin);
      storeExpiryClock += require('../scripts/planned-obligation-settlement-contract').TTL_MS - 1;
      w.hooks.admission = async () => { storeExpiryClock++; };
      const response = page.waitForResponse(r => r.url().endsWith('/settlement/confirm'));
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      const ack = await (await response).json();
      assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 0);
      assert.ok(w.durable.doc.equals(before)); assert.equal(JSON.stringify(w.durable.pin), pin);
      fixture.details = { responseStatus: ack.status, responseReason: ack.reason, commitInvocations: 1,
        journalWrites: 0, durableBytesUnchanged: true };
      if (ack.status !== 'not-applied') {
        await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
        const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
        await page.reload(); await reconciliationBoot(page);
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
        fixture.details.reload = { data: null, markerRetained: true, onceHooks: 0 };
      }
      assert.equal(ack.status, 'not-applied', 'exact real-store prejournal expiry must provide terminal proof');
      await dialog.getByText('Not saved.', { exact: false }).waitFor();
      assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
      await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Reload current view', exact: true }).click()]);
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
      assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 1);
      fixture.details.reload = { dataInstalled: true, markerRemoved: true };
    }, true, 390, { now: () => storeExpiryClock });
    for (const fault of ['wrong-operation', 'wrong-generation', 'wrong-token', 'extra-field', 'lost-reply', 'cleanup-storage', 'cleanup-lock']) {
      let clock = Date.now();
      await run('terminal proof ' + fault + ' preserves uncertainty without replay', async (w, { page, requests }) => {
        const dialog = await preview(page); clock += require('../scripts/planned-obligation-settlement-contract').TTL_MS;
        await page.route('**/settlement/confirm', async route => {
          const response = await route.fetch(); const ack = await response.json(); assert.equal(ack.status, 'not-applied');
          if (fault === 'lost-reply') return route.abort('failed');
          if (fault === 'wrong-operation') ack.operationId = 'operation-' + 'f'.repeat(32);
          if (fault === 'wrong-generation') ack.generation = 'generation-' + 'f'.repeat(32);
          if (fault === 'wrong-token') ack.previewToken = 'f'.repeat(64);
          if (fault === 'extra-field') ack.untrusted = true;
          if (fault === 'cleanup-storage') await page.evaluate(() => { Storage.prototype.removeItem = () => { throw new Error('synthetic cleanup refusal'); }; });
          if (fault === 'cleanup-lock') await page.evaluate(() => { navigator.locks.request = () => Promise.reject(new Error('synthetic lock refusal')); });
          return route.fulfill({ response, json: ack });
        });
        await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
        await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
        const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
        assert.equal(JSON.parse(marker).phase, 'dispatched');
        await page.reload(); await reconciliationBoot(page);
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
        assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 1);
        assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
      }, true, 390, { now: () => clock });
    }
    let restartClock = Date.now();
    await run('delayed terminal ack cannot clear same-operation replacement after controller restart', async (w, fixture) => {
      const { page, requests } = fixture; const dialog = await preview(page);
      const first = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
      restartClock += require('../scripts/planned-obligation-settlement-contract').TTL_MS;
      let reached, release; const seen = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
      let confirms = 0;
      await page.route('**/settlement/confirm', async route => {
        const response = await route.fetch();
        if (++confirms === 1) {
          assert.equal((await response.json()).status, 'not-applied'); reached(); await gate;
          await route.fulfill({ response });
        } else { assert.equal((await response.json()).status, 'committed'); await route.abort('failed'); }
      });
      try {
        await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click(); await seen;
        w.recreate();
        // Deliberate lifecycle fault: reuse the old operation via real routes,
        // then install that new generation under the real origin-wide lock.
        // The supported UI itself always mints a fresh operationId.
        const next = await page.evaluate(async operationId => {
          const post = async (path, body) => (await fetch('/settlement/' + path, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Atlas-Settlement': 'same-origin' }, body: JSON.stringify(body) })).json();
          const c = await post('selections', {});
          return post('prepare', { operationId, assignedCents: 2500,
            selection: { transaction: c.transactions[0].handle, commitment: c.commitments[0].handle } });
        }, first.operationId);
        assert.equal(next.status, 'prepared'); assert.notEqual(next.generation, first.generation);
        const replacement = { operationId: next.operationId, phase: 'dispatched', generation: next.generation };
        await page.evaluate(async ({ KEY, replacement, next }) => {
          await navigator.locks.request(KEY, { mode: 'exclusive' }, () => localStorage.setItem(KEY, JSON.stringify(replacement)));
          await fetch('/settlement/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json',
            'X-Atlas-Settlement': 'same-origin' }, body: JSON.stringify({ operationId: next.operationId,
            previewToken: next.previewToken, generation: next.generation, confirmed: true }) }).catch(() => {});
        }, { KEY, replacement, next });
        assert.equal(w.calls.commit, 1); release();
        await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
        assert.deepEqual(await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY), replacement);
        await page.reload();
        await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified'
          && localStorage.getItem(KEY) === null, KEY);
        assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
        assert.equal(w.calls.commit, 1); assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 2);
        fixture.details = { realRestart: true, deliberatelyReusedOperation: true, distinctGeneration: true, oldAckRetainedReplacement: true };
      } finally { release(); }
    }, true, 390, { now: () => restartClock });
    for (const interruption of ['legacy-marker', 'timeout', 'tab-close-before-cleanup']) {
      let clock = Date.now();
      await run('terminal proof ' + interruption + ' retains receipt-only recovery fence', async (w, fixture) => {
        const { page, context, requests } = fixture; const dialog = await preview(page);
        clock += require('../scripts/planned-obligation-settlement-contract').TTL_MS;
        if (interruption === 'timeout') await page.clock.install();
        let reached, release; const seen = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
        await page.route('**/settlement/confirm', async route => {
          const response = await route.fetch(); assert.equal((await response.json()).status, 'not-applied');
          reached(); await gate;
          await route.fulfill({ response }).catch(() => {}); // request may already be aborted/closed by this explicit fault.
        });
        try {
          await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click(); await seen;
          let marker = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
          if (interruption === 'legacy-marker') {
            delete marker.generation;
            await page.evaluate(async ({ KEY, marker }) => navigator.locks.request(KEY, { mode: 'exclusive' },
              () => localStorage.setItem(KEY, JSON.stringify(marker))), { KEY, marker }); release();
            await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
          } else if (interruption === 'timeout') {
            await page.clock.fastForward(20001);
            await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor(); release();
          } else {
            await page.close(); release();
            const second = await context.newPage(); second.setDefaultTimeout(15000);
            second.on('pageerror', error => fixture.errors.push(error.message));
            await second.goto(w.origin + '/'); await reconciliationBoot(second);
            assert.deepEqual(await second.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY), marker);
            await second.close(); return;
          }
          assert.deepEqual(await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY), marker);
          await page.reload(); await reconciliationBoot(page);
          assert.deepEqual(await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY), marker);
          assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 1);
          assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
        } finally { release(); }
      }, true, 390, { now: () => clock });
    }
    await run('legacy dispatched marker still recovers an original committed receipt', async (w, { page }) => {
      const dialog = await preview(page);
      await page.route('**/settlement/confirm', async route => { await route.fetch(); await route.abort('failed'); });
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
      await page.evaluate(async KEY => navigator.locks.request(KEY, { mode: 'exclusive' }, () => {
        const marker = JSON.parse(localStorage.getItem(KEY)); delete marker.generation;
        localStorage.setItem(KEY, JSON.stringify(marker));
      }), KEY);
      await page.reload();
      await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified'
        && localStorage.getItem(KEY) === null, KEY);
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 }); assert.equal(w.calls.commit, 1);
    });
    await run('dispatch cannot advance a replaced generation of the same operation', async (w, { page, requests }) => {
      const dialog = await preview(page);
      const marker = await page.evaluate(async KEY => navigator.locks.request(KEY, { mode: 'exclusive' }, () => {
        const marker = JSON.parse(localStorage.getItem(KEY)); marker.generation = 'generation-' + 'f'.repeat(32);
        localStorage.setItem(KEY, JSON.stringify(marker)); return marker;
      }), KEY);
      await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
      await dialog.getByText('Confirmation was not sent:', { exact: false }).waitFor();
      assert.deepEqual(await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY), marker);
      assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 0); assert.equal(w.calls.commit, 0);
    });
    await run('stale preview abandonment cannot erase same-operation replacement generation', async (w, fixture) => {
      const { page, context } = fixture; await preview(page);
      const first = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
      const second = await context.newPage(); second.setDefaultTimeout(15000);
      second.on('pageerror', error => fixture.errors.push(error.message));
      let reached, release; const seen = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
      await second.exposeBinding('__pauseGenerationBoot', async () => { reached(); await gate; });
      await second.route('**/app.js', async route => {
        const response = await route.fetch(), source = await response.text();
        const anchor = 'try { marker = parsePending(raw); } catch';
        assert.equal(source.split(anchor).length, 2);
        await route.fulfill({ response, body: source.replace(anchor,
          'try { marker = parsePending(raw); await window.__pauseGenerationBoot(); } catch') });
      });
      try {
        const navigation = second.goto(w.origin + '/'); await seen;
        // Deliberate shared-storage replacement, under the real marker lock.
        const replacement = { ...first, generation: 'generation-' + 'f'.repeat(32) };
        await page.evaluate(async ({ KEY, replacement }) => navigator.locks.request(KEY, { mode: 'exclusive' },
          () => localStorage.setItem(KEY, JSON.stringify(replacement))), { KEY, replacement });
        release(); await navigation; await reconciliationBoot(second);
        assert.deepEqual(await second.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY), replacement);
        assert.equal(w.calls.commit, 0);
        await second.unroute('**/app.js'); await second.reload();
        await second.waitForFunction(KEY => typeof App !== 'undefined' && App.data !== null && localStorage.getItem(KEY) === null, KEY);
        fixture.details = { staleGenerationRetained: true, replacementFaultInjected: true };
      } finally { release(); await second.close(); }
    });
    for (const width of [390, 1440]) {
      await run('direct pointer Accounts & evidence and original source lifecycle ' + width, async (w, fixture) => {
        const { page } = fixture;
        fixture.details = [];
        const cycle = async (view, branch) => {
          const tile = page.locator('[data-budget-savings-goals]');
          await (async t => { const p = t.locator('.blend-goals-panel'); if (await p.count() && !(await p.evaluate(n => n.open))) await t.locator('.blend-tile-head').click(); })(tile); // Refined face: Accounts & evidence opens from the savings detail.
          const opener = tile.locator('[data-budget-funding-inventory]');
          const source = await tile.locator('[data-budget-funding-savings]').elementHandle();
          assert.ok(source, view + ': original Savings source exists');
          const parent = await source.evaluateHandle(node => node.parentNode);
          const before = await source.evaluate(node => ({ hidden: node.hidden, inert: node.inert,
            clipped: node.classList.contains('blend-goals-source'), maxHeight: getComputedStyle(node).maxHeight }));
          assert.equal(before.clipped, true, view + ': evidence source remains clipped while closed');
          if (branch === 'fallback') assert.equal(await tile.locator('.budget-goal-notice').count(), 1);
          else assert.equal(await tile.locator('.budget-goal-notice').count(), 0);
          if (branch === 'projected') assert.equal(await tile.locator('[data-budget-savings-forecast-stock]').count(), 1);
          const geometry = await opener.evaluate(node => ({ height: node.getBoundingClientRect().height,
            clipped: node.classList.contains('blend-goals-source') }));
          assert.ok(geometry.height > 0, view + ': original opener has pointer area');
          assert.equal(geometry.clipped, false, view + ': interactive opener is excluded from source clipping');
          const dialog = page.locator('[data-budget-detail-sheet]');
          const originalIsInDialog = () => source.evaluate(node =>
            node.parentNode === document.querySelector('[data-budget-detail-body]')
            && document.querySelector('[data-budget-detail-sheet]').contains(node)
            && document.querySelector('[data-budget-detail-sheet] [data-budget-funding-savings]') === node);
          const restored = async () => {
            assert.equal(await source.evaluate((node, originalParent) => node.parentNode === originalParent, parent), true,
              view + ': close restores the identical source to its original parent');
            assert.deepEqual(await source.evaluate(node => ({ hidden: node.hidden, inert: node.inert,
              clipped: node.classList.contains('blend-goals-source'), maxHeight: getComputedStyle(node).maxHeight })), before,
            view + ': close restores original hidden/inert/clipping state');
          };
          try {
            await opener.click({ timeout: 5000 }); // genuine unforced pointer; never evaluate/force-click
            await dialog.waitFor({ state: 'visible' });
            assert.equal(await originalIsInDialog(), true, view + ': sheet holds that exact original node');
            assert.equal(await dialog.locator('[data-budget-funding-savings]').count(), 1);
            await dialog.getByRole('button', { name: 'Assign a recorded payment', exact: true }).waitFor();
            await dialog.locator('[data-budget-detail-close]').click();
            await dialog.waitFor({ state: 'hidden' }); await restored();
            await opener.click({ timeout: 5000 });
            await dialog.waitFor({ state: 'visible' });
            assert.equal(await originalIsInDialog(), true, view + ': pointer reopen moves the same node again');
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'hidden' }); await restored();
            fixture.details.push({ view, branch, geometry, originalNodeIdentity: true, restoredState: before });
          } finally { await parent.dispose(); await source.dispose(); }
        };
        const step = async key => {
          const start = await page.locator('[data-budget-window-progress]').getAttribute('data-start');
          await page.locator('.river').focus(); await page.keyboard.press(key);
          await page.waitForFunction(start => document.querySelector('[data-budget-window-progress]')?.dataset.start !== start, start);
        };
        await cycle('daily current', 'daily');
        await step('ArrowRight'); await cycle('daily projected after period change', 'projected');
        await page.evaluate(() => App.rerender()); await cycle('daily projected after rerender', 'projected');
        await step('ArrowLeft'); await cycle('daily current after return', 'daily');
        // Both real markup branches: without the optional policy, the next
        // period consumes Forecast's incumbent fallback publication.
        delete w.base.plan.savingsEarmarks.allocationPolicy;
        delete w.acquisition.plan.savingsEarmarks.allocationPolicy;
        await page.reload();
        await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null
          && App.data.plan.savingsEarmarks.allocationPolicy == null);
        await step('ArrowRight'); await cycle('fallback next period', 'fallback');
        await page.evaluate(() => App.rerender()); await cycle('fallback after rerender', 'fallback');
        await step('ArrowLeft'); await step('ArrowRight'); await cycle('fallback after period return', 'fallback');
        assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
      }, true, width);
    }
    for (const width of [390, 1440]) for (const override of [null, 1800]) {
      await run('renderer reversal uncertainty ready-unknown-ready ' + width + ' override ' + override, async (w, fixture) => {
        const { page } = fixture;
        w.base.settlementEvidenceStatus = { status: 'qualified' };
        w.base.settlementEvidence = rendererReversalEvidence(false);
        if (override != null) await page.addInitScript(applyPlanKnobsAfterWiring, { weeklyVariable: override });
        await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null && document.querySelector('[data-budget-savings-goals]'));
        await page.evaluate(() => { document.getElementById('road-ahead').hidden = false; App.rerender(); });
        const ids = ['cap-headline', 'cap-split', 'cap-basis', 'budget-out', 'budget-basis', 'budget-cats-note', 'hero-tiles'];
        const snapshot = () => page.evaluate(ids => ids.map(id => ({ id, html: document.getElementById(id).innerHTML,
          text: document.getElementById(id).textContent })), ids);
        const ready = await snapshot();
        const diagnosticIds = ['hero-tiles', 'cap-headline', 'phases', 'risk-list'];
        const diagnostics = () => page.evaluate(ids => ids.map(id => ({ id, html: document.getElementById(id).innerHTML,
          text: document.getElementById(id).textContent })), diagnosticIds);
        const retainedDiagnostics = await diagnostics();
        const categories = await page.locator('#budget-cats').innerHTML();
        await page.evaluate(() => { document.getElementById('road-ahead').hidden = true; });
        w.base.settlementEvidence = rendererReversalEvidence(true);
        const publication = await page.evaluate(async () => {
          const d = await (await fetch('/data.json', { credentials: 'same-origin' })).json();
          const advice = Forecast.recommend(d.plan, d.meta.asOf, { ...d.plan.defaults, ...d.liveOverlay,
            weeklyVariable: state.weeklyVariable, debts: d.debts, settlementEvidence: d.settlementEvidence });
          const cap = Forecast.budgetBreakdown(d.plan, App.periods, { weeklyCap: advice.weekly }).cap;
          // Explicit mutable fixture input exercises the renderer lifecycle;
          // production acquisition/reload policy is not being changed here.
          Object.assign(App.data, d);
          let hiddenCounterfactualCalls = 0;
          const original = Forecast.counterfactuals;
          Forecast.counterfactuals = (...args) => { hiddenCounterfactualCalls++; return original(...args); };
          try { App.rerender(); } finally { Forecast.counterfactuals = original; }
          return { weekly: advice.weekly, cap, reason: advice.operatingPlanNote, hiddenCounterfactualCalls };
        });
        assert.equal(publication.weekly, null); assert.equal(publication.cap, null);
        assert.match(publication.reason, /remaining cost is uncertain/);
        assert.equal(publication.hiddenCounterfactualCalls, 0);
        assert.deepEqual(await diagnostics(), retainedDiagnostics, 'explicitly hidden diagnostic mounts remain untouched');
        for (const row of (await snapshot()).filter(row => !diagnosticIds.includes(row.id))) {
          assert.ok(row.text.includes(publication.reason), row.id + ': active state refreshes while diagnostics are hidden');
        }
        await page.evaluate(() => { document.getElementById('road-ahead').hidden = false; App.rerender(); });
        for (const row of await snapshot()) {
          assert.ok(row.text.includes(publication.reason), row.id + ': published reason');
          assert.doesNotMatch(row.text, /protected funding shortfall|\$0\/wk|\$0\s*\/\s*week/);
        }
        assert.equal(w.base.plan.budget.categories[0].plannedWeekly, 40, 'synthetic groceries are independently positive');
        const essential = page.locator('#hero-tiles .tile').filter({ has: page.locator('.lab', { hasText: /^Essential variable need$/ }) });
        assert.equal(await essential.locator('.val').textContent(), 'unavailable');
        assert.ok((await essential.locator('.note').textContent()).includes(publication.reason));
        assert.equal(await page.locator('#budget-cats').innerHTML(), categories, 'known categories/history remain unchanged');
        w.base.settlementEvidence = rendererReversalEvidence(false);
        await page.evaluate(async () => { const d = await (await fetch('/data.json', { credentials: 'same-origin' })).json(); Object.assign(App.data, d); App.rerender(); });
        assert.deepEqual(await snapshot(), ready, 'ready control restores exactly after uncertainty');
        assert.equal(w.calls.commit, 0); assert.equal(w.calls.storage, 0);
        fixture.details = { publication, override, cycle: ['ready-visible', 'unavailable-hidden', 'unavailable-visible', 'ready-visible'], normalizedSyntheticEvidence: true, actualDataRoute: true };
      }, false, width);
    }
    for (const width of [390, 1440]) {
      await run('renderer hidden diagnostics unfunded sentinel ' + width, async (w, fixture) => {
        const { page } = fixture;
        const diagnosticIds = ['hero-tiles', 'cap-headline', 'phases', 'risk-list'];
        const nativeDiagnostics = await page.evaluate(async ids => {
          const html = await (await fetch('/', { credentials: 'same-origin' })).text();
          const document = new DOMParser().parseFromString(html, 'text/html');
          return ids.map(id => ({ id, html: document.getElementById(id).innerHTML, text: document.getElementById(id).textContent }));
        }, diagnosticIds);
        // Same invented $400 buffer / $150 cash / empty funding source as the
        // registered weekly suite: independent unfunded gap = $250.
        const payload = { meta: { asOf: '2026-08-16', title: 'Synthetic unfunded renderer' },
          debts: [], revolvingExtra: [], paypal: null, helocHistory: [],
          plan: { windowDays: 21, defaults: { scenario: 'expected', extraDebtMonthly: 0, targetBuffer: 400 },
            obligations: [], bills: [], commitments: [], actions: [], startingCash: { amount: 150, note: '' },
            income: [{ id: 'later-pay', label: 'Later pay', frequency: 'once', date: '2026-08-30', amount: 3000, confidence: 'confirmed' }],
            funding: { heading: 'Cover the gap', note: '', options: [{ id: 'empty', label: 'Empty pot', short: 'empty', available: 0, rank: 1 }] },
            budget: { basis: 'ytd', categories: [
              { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedMonthly: 1200 },
              { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedMonthly: 800 },
              { id: 'dining', label: 'Dining', class: 'discretionary', from: ['Dining'], plannedMonthly: 400 }] } } };
        for (const key of Object.keys(w.base)) delete w.base[key]; Object.assign(w.base, payload);
        await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
        assert.deepEqual(await page.evaluate(ids => ids.map(id => ({ id, html: document.getElementById(id).innerHTML,
          text: document.getElementById(id).textContent })), diagnosticIds), nativeDiagnostics,
        'default hidden diagnostic mounts preserve native markup through initial boot');
        const trace = await page.evaluate(() => {
          const hidden = document.getElementById('road-ahead').hidden;
          const advice = Forecast.recommend(App.data.plan, App.data.meta.asOf,
            { ...App.data.plan.defaults, fundingSources: App.data.plan.funding.options, debts: [] });
          let calls = 0, error = null;
          const original = Forecast.counterfactuals;
          Forecast.counterfactuals = (...args) => { calls++; return original(...args); };
          try { App.rerender(); } catch (e) { error = e.message; } finally { Forecast.counterfactuals = original; }
          return { hidden, weekly: advice.weekly, feasible: advice.funding.feasible, shortfall: advice.funding.shortfall,
            calls, error, headline: document.getElementById('cap-headline').textContent };
        });
        fixture.details = { trace, actualDataRoute: true, normalizedSyntheticEvidence: false };
        assert.equal(trace.hidden, true, 'actual default root is hidden');
        assert.equal(trace.weekly, 0); assert.equal(trace.feasible, false); assert.equal(trace.shortfall, 250);
        assert.equal(trace.calls, 0, 'hidden root never enables counterfactual calculations');
        assert.equal(trace.error, null, 'unfunded zero sentinel completes the renderer');
        assert.equal(trace.headline, nativeDiagnostics.find(row => row.id === 'cap-headline').text,
          'hidden headline remains untouched on repeated render');
        assert.match(await page.locator('#cap-split .total .cap-part-amt').textContent(), /unavailable/);
        await page.evaluate(() => { document.getElementById('road-ahead').hidden = false; App.rerender(); });
        const revealedHeadline = await page.locator('#cap-headline').textContent();
        assert.match(revealedHeadline, /unavailable/); assert.match(revealedHeadline, /250/);
        fixture.details.revealedHeadline = revealedHeadline;
        assert.equal(w.calls.storage, 0); assert.equal(w.calls.commit, 0);
      }, false, width);
    }
    for (const width of [390, 1440]) {
      await run('withdrawal then separately explicit normal relink ' + width, async (w, { page }) => {
        await complete(page, await preview(page));
        assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
        await completeWithdrawal(page, await withdrawalPreview(page));
        assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
        assert.equal(w.calls.commit, 2, 'no automatic relink');
        await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
        assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
        await complete(page, await preview(page));
        assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
        assert.equal(w.calls.commit, 3);
        assert.deepEqual(JSON.parse(w.durable.doc).operations.map(o => o.command.kind), ['link', 'retract', 'link']);
      }, true, width);
    }
    let discoveryClock = Date.now();
    for (const change of ['expiry', 'replacement']) {
      discoveryClock = Date.now();
      await run('prepared withdrawal survives discovery catalogue ' + change + ' through real browser reload', async (w, fixture) => {
        const { page } = fixture;
        await complete(page, await preview(page)); const t0 = discoveryClock;
        const prepared = page.waitForResponse(r => r.url().endsWith('/settlement/prepare-withdrawal'));
        const dialog = await withdrawalPreview(page, () => { discoveryClock += 60000; });
        const expiresAt = (await (await prepared).json()).expiresAt;
        if (change === 'expiry') discoveryClock = t0 + require('../scripts/planned-obligation-settlement-contract').TTL_MS + 1000;
        else assert.equal(await page.evaluate(async () => {
          const response = await fetch('/settlement/assignments', { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Atlas-Settlement': 'same-origin' }, body: '{}' });
          return (await response.json()).status;
        }), 'available');
        assert.ok(discoveryClock < expiresAt, 'preview remains valid beyond discovery lifetime');
        const before = Buffer.from(w.durable.doc);
        const response = page.waitForResponse(r => r.url().endsWith('/settlement/confirm'));
        await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
        assert.equal((await response).status(), 200);
        // Successful confirmation navigates immediately. Observe the installed
        // view/marker instead of racing response.json against that navigation.
        await page.waitForFunction(KEY => localStorage.getItem(KEY) === null
          || document.body.innerText.includes('Assignment outcome needs reconciliation.'), KEY);
        const result = await page.evaluate(KEY => localStorage.getItem(KEY) === null
          ? 'committed-view' : 'reconciliation-required', KEY);
        fixture.details = { synthetic: true, discoveryChange: change, bootOutcome: result, previewValidAtConfirm: true };
        if (result !== 'committed-view') {
          await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
          const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
          assert.equal(JSON.parse(marker).phase, 'dispatched');
          assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1); assert.ok(w.durable.doc.equals(before));
          await page.reload(); await reconciliationBoot(page);
          assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
          Object.assign(fixture.details, { dispatchedMarkerRetained: true, durableUnchanged: true,
            reloadData: null, reloadOnceHooks: 0, commitInvocations: w.calls.commit, journalWrites: w.calls.journal });
        }
        assert.equal(result, 'committed-view');
        await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified'
          && localStorage.getItem(KEY) === null, KEY);
        assert.equal(w.calls.commit, 2); assert.equal(w.calls.journal, 2);
        assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
        await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
        assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
        assert.equal(w.calls.commit, 2, 'ordinary reload never replays');
      }, true, 390, { now: () => discoveryClock });
    }
    await run('withdrawal lost committed response reload never resends or automatically relinks', async (w, { page }) => {
      await complete(page, await preview(page)); const dialog = await withdrawalPreview(page);
      let dropped = false;
      await page.route('**/settlement/confirm', async route => {
        const response = await route.fetch(); assert.equal((await response.json()).status, 'committed');
        dropped = true; await route.abort('failed');
      });
      await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
      await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
      const marker = await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)), KEY);
      assert.equal(marker.phase, 'dispatched'); assert.equal(dropped, true);
      w.recreate(); await page.reload();
      await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data !== null && localStorage.getItem(KEY) === null, KEY);
      assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
      assert.equal(w.calls.commit, 2);
      assert.deepEqual(JSON.parse(w.durable.doc).operations.map(o => o.command.kind), ['link', 'retract']);
    });
    await run('withdrawal lost unknown response preserves dispatched marker and blocks ordinary reload', async (w, { page, requests }) => {
      await complete(page, await preview(page)); const dialog = await withdrawalPreview(page);
      const before = Buffer.from(w.durable.doc);
      w.hooks.admission = async () => { throw new Error('synthetic ambiguous commit transport'); };
      await page.route('**/settlement/confirm', async route => {
        const response = await route.fetch(); assert.equal((await response.json()).status, 'unknown');
        await route.abort('failed');
      });
      await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
      await dialog.getByText('Assignment outcome needs reconciliation.', { exact: false }).waitFor();
      const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY); assert.equal(JSON.parse(marker).phase, 'dispatched');
      await page.reload(); await reconciliationBoot(page);
      assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
      assert.equal(w.calls.commit, 2); assert.equal(w.calls.journal, 1); assert.ok(w.durable.doc.equals(before));
      assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 2);
    });
    await run('withdrawal remains available without current provider row or goal and preview dismissal is read-only', async (w, { page }) => {
      await complete(page, await preview(page));
      w.acquisition.packet.transactions = []; w.base.plan.commitments = [];
      await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      const dialog = await withdrawalPreview(page);
      await page.keyboard.press('Escape');
      assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1);
      await page.reload(); await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data !== null && localStorage.getItem(KEY) === null, KEY);
      await completeWithdrawal(page, await withdrawalPreview(page));
      assert.equal(w.calls.commit, 2);
      assert.deepEqual(await page.evaluate(() => App.data.settlementEvidence.commitments), []);
    });
    await run('household cross-login withdrawal owns a new receipt without exposing original receipt', async (w, { page, context }) => {
      await complete(page, await preview(page));
      const original = JSON.parse(w.durable.doc).operations[0];
      const oldCookie = (await context.cookies(w.origin)).find(c => c.name === 'hfd_session'); assert.ok(oldCookie);
      await context.clearCookies(); await page.goto(w.origin + '/login');
      await page.getByLabel('Password', { exact: true }).fill(env.SITE_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      const foreign = await page.evaluate(async operationId => (await fetch('/settlement/outcome', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Atlas-Settlement': 'same-origin' }, body: JSON.stringify({ operationId }) })).json(), original.operationId);
      assert.equal(foreign.status, 'unknown');
      await completeWithdrawal(page, await withdrawalPreview(page));
      const history = JSON.parse(w.durable.doc).operations;
      assert.notEqual(history[0].actorId, history[1].actorId); assert.equal(history[1].command.kind, 'retract');
      assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 }); assert.equal(w.calls.commit, 2);
      w.cookie = 'hfd_session=' + oldCookie.value;
      assert.equal((await w.post('outcome', { operationId: original.operationId })).status, 'committed');
      assert.equal((await w.post('outcome', { operationId: history[1].operationId })).status, 'unknown');
    });
    await run('withdrawal partial reversal and sibling leave exactly thirty dollars for separate relink', async (w, { page }) => {
      await complete(page, await preview(page)); const first = JSON.parse(w.durable.doc).operations[0];
      const C = require('../scripts/planned-obligation-settlement-contract');
      const counter = { ...first.command.evidence, direction: 'credit', cents: 1000 };
      await syntheticRecord(w, 100, { version: 1, kind: 'reverse', targetOperationId: first.operationId,
        counterTxRef: 'tx-' + '9'.repeat(32), counterEvidence: counter, counterEvidenceDigest: C.digest(counter), cents: 1000 }, first.actorId);
      // The browser consumes the complete Forecast view: use its existing
      // second planned commitment, rather than inventing an unknown goal.
      const siblingGoal = 'commitment:' + w.base.plan.commitments[1].id;
      await syntheticRecord(w, 101, { ...first.command, goalId: siblingGoal, assignedCents: 2000 }, first.actorId);
      await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      await completeWithdrawal(page, await withdrawalPreview(page));
      assert.equal(JSON.parse(w.durable.doc).operations.length, 4, 'withdrawal cannot relink automatically');
      const prepareAmount = async amount => {
        const dialog = await sheet(page); await dialog.getByRole('button', { name: 'Assign a recorded payment', exact: true }).click();
        await dialog.getByLabel('Amount to assign (CAD)', { exact: true }).fill(amount);
        await dialog.getByRole('button', { name: 'Preview assignment', exact: true }).click(); return dialog;
      };
      let dialog = await prepareAmount('30.01');
      await dialog.getByText('Preview unavailable. No confirmation was sent.', { exact: false }).waitFor();
      assert.equal(w.calls.commit, 2);
      await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      dialog = await prepareAmount('30.00'); await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).waitFor();
      await complete(page, dialog); assert.equal(w.calls.commit, 3);
      assert.deepEqual(await facts(page), { original: 60, paid: 30, remaining: 30 });
    });
    let withdrawalClock = Date.now();
    for (const boundary of ['controller', 'store']) {
      withdrawalClock = Date.now();
      await run('withdrawal ' + boundary + ' expiry keeps terminal generation proof and permits explicit reload', async (w, { page, requests }) => {
        await complete(page, await preview(page));
        const dialog = await withdrawalPreview(page);
        const before = Buffer.from(w.durable.doc), pin = JSON.stringify(w.durable.pin);
        const ttl = require('../scripts/planned-obligation-settlement-contract').TTL_MS;
        withdrawalClock += ttl - (boundary === 'store' ? 1 : 0);
        if (boundary === 'store') w.hooks.admission = async () => { withdrawalClock++; };
        await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
        await dialog.getByText('Not saved. No withdrawal was recorded.', { exact: false }).waitFor();
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
        assert.equal(w.calls.commit, boundary === 'store' ? 2 : 1); assert.equal(w.calls.journal, 1);
        assert.ok(w.durable.doc.equals(before)); assert.equal(JSON.stringify(w.durable.pin), pin);
        await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Reload current view', exact: true }).click()]);
        await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
        assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
        assert.equal(requests.filter(x => x.path === '/settlement/confirm').length, 2);
      }, true, 390, { now: () => withdrawalClock });
    }
    for (const refusal of ['context-ABA', 'late-domain-fence']) {
      await run('withdrawal ' + refusal + ' uses terminal proof without writing', async (w, { page }) => {
        await complete(page, await preview(page)); const dialog = await withdrawalPreview(page);
        if (refusal === 'context-ABA') { const original = w.cell.domain; w.cell.domain = 'other'; w.cell.revision++; w.cell.domain = original; w.cell.revision++; }
        else w.hooks.admission = async () => { w.cell.domain = 'other'; w.cell.revision++; };
        await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
        await dialog.getByText('Not saved. No withdrawal was recorded.', { exact: false }).waitFor();
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), null);
        assert.equal(w.calls.journal, 1); assert.equal(JSON.parse(w.durable.doc).operations.length, 1);
      });
    }
    await run('withdrawal publication unavailable retains marker and unrelated card holds until whole recovery', async (w, { page }) => {
      w.base.liveOverlay.currentPeriodActuals.cardCoverageRequired = true; w.acquisition.packet.cardCoverageRequired = true;
      await page.reload(); await page.waitForFunction(() => typeof App !== 'undefined' && App.data !== null);
      await complete(page, await preview(page)); const dialog = await withdrawalPreview(page);
      w.hooks.admission = async () => { w.readFailure = true; };
      await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click()]);
      await page.locator('[data-settlement-recovery]').waitFor();
      assert.equal(await page.evaluate(() => App.data.settlementEvidenceStatus.status), 'unavailable');
      assert.equal(await page.evaluate(KEY => JSON.parse(localStorage.getItem(KEY)).phase, KEY), 'dispatched');
      assert.equal(w.calls.commit, 2); delete w.hooks.admission; w.readFailure = false;
      await page.getByRole('button', { name: 'Check saved view', exact: true }).click();
      await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data?.settlementEvidenceStatus?.status === 'qualified'
        && localStorage.getItem(KEY) === null, KEY);
      assert.deepEqual(await facts(page), { original: 60, paid: 0, remaining: 60 });
      assert.equal(await page.evaluate(() => {
        const d = App.data; return Forecast.recommend(d.plan, d.meta.asOf, { ...d.liveOverlay, debts: d.debts,
          weeklyVariable: 0, settlementEvidence: d.settlementEvidence }).cardPurchaseCoverage.status;
      }), 'unavailable'); assert.equal(w.calls.commit, 2);
    });
    await run('withdrawal restart before dispatch abandons only its unsent preview', async (w, { page, requests }) => {
      await complete(page, await preview(page)); await withdrawalPreview(page);
      await page.reload(); await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data !== null && localStorage.getItem(KEY) === null, KEY);
      assert.equal(w.calls.commit, 1); assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 1);
      assert.deepEqual(await facts(page), { original: 60, paid: 25, remaining: 35 });
    });
    await run('withdrawal cancellation while confirm is dispatched retains generation and one effect', async (w, { page, requests }) => {
      await complete(page, await preview(page)); const dialog = await withdrawalPreview(page);
      let reached, release; const seen = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
      await page.route('**/settlement/confirm', async route => { const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
      try {
        await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click(); await seen;
        const marker = await page.evaluate(KEY => localStorage.getItem(KEY), KEY);
        await page.keyboard.press('Escape'); const reopened = await sheet(page);
        assert.equal(await page.evaluate(KEY => localStorage.getItem(KEY), KEY), marker);
        assert.equal(await reopened.getByRole('button', { name: 'Confirm withdrawal', exact: true }).isEnabled(), false);
        const loaded = page.waitForEvent('load'); release(); await loaded;
        await page.waitForFunction(KEY => typeof App !== 'undefined' && App.data !== null && localStorage.getItem(KEY) === null, KEY);
        assert.equal(w.calls.commit, 2); assert.equal(requests.filter(r => r.path === '/settlement/confirm').length, 2);
      } finally { release(); }
    });
  } finally { await browser.close(); }
  assert.ok(results.length, 'at least one browser case must run');
  fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ synthetic: true,
    browserVersion, nodeVersion: process.version,
    head: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim(),
    repositorySources: Object.fromEntries(['server.js', 'public/app.js', 'public/plan.js', 'public/budget-blend.js',
      'scripts/settlement-evidence-http.js', 'scripts/settlement-evidence-confirmation.js', 'scripts/settlement-evidence-resolver.js',
      'scripts/settlement-evidence-serving.js', 'test/test-settlement-evidence-http.js',
      'scripts/settlement-evidence-loader.js', 'test/test-settlement-evidence-loader.js',
      'test/test-settlement-evidence-confirmation.js', 'test/test-weekly-cap.js', 'test/browser-settlement-save-view.js'].map(file => [file,
      require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex')])),
    actualHttpAndBrowser: true, results }, null, 2) + '\n');
  console.log('Proof: ' + out);
  if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
