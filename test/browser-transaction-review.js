'use strict';
// Synthetic intercepted real-page proof; emulation is not physical Safari acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {chromium,webkit}=require('playwright'),fx=require('./fixtures/budget-surface-data');
const root=path.join(__dirname,'..'),serveRoot=process.env.REVIEW_ROOT||root;
const out=process.env.ATLAS_REVIEW_PROOF_DIR||path.join(require('node:os').tmpdir(),'atlas-transaction-review');
const baseRoot=process.env.REVIEW_BASE_ROOT;
fs.mkdirSync(out,{recursive:true});
const records=[],errors=[],writes=[],external=[];
function dataFor(state){
 const data=state==='unavailable'?fx.served({unavailablePlan:true}):fx.served({etransfer:state!=='empty'});
 const p=data.liveOverlay.currentPeriodActuals;
 if(state==='partial')p.pendingCoverage='unknown';
 if(state==='stale')p.coverageThrough='2026-08-19';
 if(state==='multiple'){const row=p.transactions.find(t=>t.outgoingETransferIdentity);
 p.transactions.push({...row,id:'invented-second-transfer',coverageRef:'invented-second-transfer',date:'2026-08-20',amount:28.50,
 atlasAccountId:'chequing-a',account:'chequing-a',pending:true,savingsPostingEvidence:'pending',pendingTreatment:'pending-unproven'});}
 return data;
}
async function openPage(browser,width,theme,state,dir=serveRoot){
 const data=dataFor(state),before=JSON.stringify(data);
 const page=await browser.newPage({viewport:{width,height:1000},isMobile:width<400,hasTouch:width<400,colorScheme:theme,reducedMotion:'reduce'});
 page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(t=>localStorage.setItem('hfd-theme',t),theme);
 let refreshes=0;
 await page.route('**/*',route=>{
 const u=new URL(route.request().url());
 if(u.origin!=='http://review.test'){external.push(u.origin);return route.abort();}
 if(route.request().method()!=='GET')writes.push(route.request().method());
 if(u.pathname==='/data.json'){if(u.searchParams.get('refresh')==='force')refreshes++;return route.fulfill({json:data});}
 if(['/periods.json','/balance-history.json','/running-build.json'].includes(u.pathname))return route.fulfill({json:null});
 const file=path.join(dir,'public',u.pathname==='/'?'index.html':u.pathname.slice(1));
 if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
 return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html'});
 });
 await page.goto('http://review.test/');await page.locator('[data-budget-surface]').waitFor();
 await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 assert.equal(JSON.stringify(data),before);return{page,refreshes:()=>refreshes};
}
const figures=page=>page.locator('#operating-surface-body').innerText();
// The existing responsive skin can relocate the #604 disclosure around
// the Payday card. Compare its full labelled text separately, preserving
// every other financial label/value's order; do not sort money values.
const financialSurface=page=>page.locator('#operating-surface-body').evaluate(el=>{
 const text=node=>node?.textContent.replace(/\s+/g,' ').trim()||null;
 const copy=el.cloneNode(true),transfer=copy.querySelector('[data-budget-browse="e-transfers"]');
 const transfers=text(transfer);transfer?.remove();
 copy.querySelector('[data-budget-detail-sheet]')?.remove();
 copy.querySelector('[data-blend-river-today]')?.remove(); // header/river navigation chrome, not a financial publication
 return{financialText:text(copy),transfers};
});
async function closed(page){
 assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(e=>e.open),false);
 const bell=page.locator('[data-transaction-review-open]');
 assert.equal(await bell.getAttribute('aria-expanded'),'false');
 assert.equal(await bell.evaluate(e=>e===document.activeElement),true,'dismissal returns focus to bell');
}
async function readOnlyReview(dialog){
 // Reviewed #627 adds a local private-input download to shared Data status.
 // Keep the broad save/confirmation guard: only that exact purpose, label and
 // mount is allowed, and these incomplete HTTP fixtures cannot enable it.
 const saves=dialog.getByRole('button',{name:/save|confirm answer/i});
 const localSave=dialog.getByRole('button',{name:'Save private comparison inputs',exact:true});
 assert.equal(await saves.count(),1,'no transaction decision or provider save control');
 assert.equal(await localSave.count(),1,'the only save is the private input download');
 assert.equal(await localSave.evaluate(el=>el.matches('button[type="button"][data-private-comparison-save]')
   && !!el.closest('[data-review-source-check]')),true,'private download stays inside shared Data status');
 assert.equal(await localSave.isDisabled(),true,'incomplete HTTP fixtures cannot save private inputs');
}
async function rejectDecisionControls(dialog){
 for(const label of['Save decision','Confirm answer']){
  await dialog.evaluate((el,label)=>{const button=document.createElement('button');button.type='button';
   button.textContent=label;button.setAttribute('data-review-negative-control','');el.appendChild(button);},label);
  try{await assert.rejects(()=>readOnlyReview(dialog),{code:'ERR_ASSERTION'},label+' must still fail the guard');}
  finally{await dialog.locator('[data-review-negative-control]').evaluate(el=>el.remove());}
 }
 await readOnlyReview(dialog);
}
async function main(){
 for(const[name,engine]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true});
 try{for(const width of[320,390,1440])for(const theme of['light','dark'])for(const state of['complete','empty','multiple','partial','stale','unavailable']){
 const{page,refreshes}=await openPage(browser,width,theme,state);
 const toolbar=page.locator('[data-atlas-toolbar]');
 assert.equal(await toolbar.count(),1,'the real page has one compact toolbar');
 const before=await figures(page);
 if(baseRoot){const base=await openPage(browser,width,theme,state,baseRoot);const actual=await financialSurface(base.page),expected=await financialSurface(page);
 if(JSON.stringify(actual)!==JSON.stringify(expected))fs.writeFileSync(path.join(out,'financial-parity-failure.json'),JSON.stringify({actual,expected},null,2));
 assert.deepEqual(actual,expected,'base/head labelled financial and transfer publications are identical');await base.page.close();}
 if(width===320&&theme==='light'&&state==='complete'){
 const original=await financialSurface(page);
 await page.evaluate(()=>{
   const walker=document.createTreeWalker(document.querySelector('#operating-surface-body'),NodeFilter.SHOW_TEXT);
   let node;while((node=walker.nextNode())&&(!node.data.includes('$')||node.parentElement.closest('[data-budget-detail-sheet]'))){}
   if(!node)throw new Error('financial negative-control target missing');
   window.reviewProofText={node,value:node.data};node.data=node.data.replace('$','$999 ');
 });
 assert.notDeepEqual(await financialSurface(page),original,'labelled publication proof catches a changed financial value');
 await page.evaluate(()=>{window.reviewProofText.node.data=window.reviewProofText.value;delete window.reviewProofText;});
 assert.deepEqual(await financialSurface(page),original);
 }
 const g=await toolbar.evaluate(el=>({buttons:[...el.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return{width:r.width,height:r.height,top:r.top,left:r.left,right:r.right,name:b.getAttribute('aria-label')};}),
 headerHeight:el.closest('.site-head').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth}));
 assert.equal(g.buttons.length,3);assert.ok(g.buttons.every(b=>b.width>=44&&b.height>=44&&b.name),'named 44px targets');
 assert.ok(g.buttons.every(b=>b.left>=0&&b.right<=width),'all controls fit inside viewport');
 assert.ok(g.buttons.every((b,i)=>!i||b.left>=g.buttons[i-1].right),'controls never overlap');
 assert.ok(g.buttons.every(b=>Math.abs(b.top-g.buttons[0].top)<1),'single row');
 if(g.headerHeight>68){await page.screenshot({path:path.join(out,'header-failed.png')});console.log(await page.locator('.site-head').evaluate(el=>({html:el.innerHTML,height:el.getBoundingClientRect().height,children:[...el.children].map(n=>({tag:n.tagName,hidden:n.hidden,display:getComputedStyle(n).display,height:n.getBoundingClientRect().height}))})));}
 assert.ok(g.headerHeight<=68,'slim header '+JSON.stringify(g));assert.equal(g.overflow,false);
 const bell=page.locator('[data-transaction-review-open]'),dialog=page.locator('[data-budget-detail-sheet]');
 assert.match(await bell.getAttribute('aria-label'),/total unavailable/i);
 assert.equal(await bell.locator('[data-review-badge]').innerText(),'?','unknown shared total cannot become zero or transfer count');
 await bell.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-budget-detail-sheet]').open);
 assert.equal(await page.getByRole('heading',{name:'Review transactions',exact:true}).count(),1);
 for(const key of['Tab','Tab','Shift+Tab','Shift+Tab']){await page.keyboard.press(key);assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true,'focus stays in native modal');}
 assert.match(await dialog.innerText(),/read.only|read only/i);assert.match(await dialog.innerText(),/purchase.*payment match/i);
 await readOnlyReview(dialog);
 if(width===320&&theme==='light'&&state==='complete')await rejectDecisionControls(dialog);
 assert.equal(await dialog.locator('[data-observation-check]').count(),1,'actual source status remains reachable');
 assert.doesNotMatch(await dialog.innerText(),/Synthetic recipient|SEND E-TFR/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const count=await dialog.locator('[data-review-item]').count();
 assert.equal(count,['stale','unavailable','empty'].includes(state)?0:state==='multiple'?2:1);
 if(state==='multiple'){assert.match(await dialog.locator('[data-review-item]:not([hidden]) [data-review-position]').innerText(),/1 of 2/);
 await dialog.getByRole('button',{name:'Next transfer',exact:true}).click();assert.match(await dialog.locator('[data-review-item]:not([hidden]) [data-review-position]').innerText(),/2 of 2/);
 await dialog.getByRole('button',{name:'Previous transfer',exact:true}).click();assert.match(await dialog.locator('[data-review-item]:not([hidden]) [data-review-position]').innerText(),/1 of 2/);}
 await page.screenshot({path:path.join(out,[name,width,theme,state,'open.png'].join('-')),animations:'disabled'});
 await dialog.getByRole('button',{name:'Back to Budget',exact:true}).click();await closed(page);
 await bell.click();await page.keyboard.press('Escape');await closed(page);
 await bell.evaluate(e=>{e.click();e.click();e.click();});assert.equal(await dialog.evaluate(e=>e.open),true);
 await dialog.getByRole('button',{name:'Close details',exact:true}).click();await closed(page);
 assert.equal(await figures(page),before,'review cannot change figures');
 if(state==='complete'){
 const tb=page.locator('[data-blend-theme]');await tb.click();assert.equal(await page.locator('html').getAttribute('data-theme'),theme==='light'?'dark':'light');
 assert.equal(await figures(page),before);await tb.click();assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
 await Promise.all([page.waitForEvent('load'),page.locator('[data-manual-refresh]').click()]);
 await page.locator('[data-budget-surface]').waitFor();
 await page.waitForFunction(()=>!document.querySelector('.site-head').inert);
 assert.equal(refreshes(),1);
 }
 if(width===390&&theme==='light'&&state==='complete'){
 const river=page.locator('.g-river-wrap .river'),selected=await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
 await river.focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(id=>document.querySelector('[data-pay-period-swipe]')?.getAttribute('data-selected-pay-period')!==id,selected);
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 await bell.click();assert.equal(await dialog.locator('[data-review-item]').count(),0);await page.keyboard.press('Escape');
 await river.focus();await page.keyboard.press('ArrowLeft');await page.waitForFunction(id=>document.querySelector('[data-pay-period-swipe]')?.getAttribute('data-selected-pay-period')===id,selected);
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 await bell.click();assert.equal(await dialog.locator('[data-review-item]').count(),1);await page.keyboard.press('Escape');
 }
 records.push({browser:name,version:browser.version(),width,theme,state,geometry:g,count});await page.close();
 }}finally{await browser.close();}
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(writes,[]);
 const files=['public/index.html','public/app.js','public/plan.js','public/budget-blend.js','public/transaction-review.js','public/transaction-review.css'];
 fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({synthetic:true,executionHead:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 physicalSafariAcceptance:'not performed',referencePixelsViewedByBuilder:false,sourceSha256:Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')])),records,errors,writes,external},null,2)+'\n');
 console.log('PASS transaction review: 72 Chromium/WebKit state/theme/width views; native dismissal, navigation, status, theme, refresh and unchanged figures');
}
module.exports={openPage,figures,closed,errors,writes,external};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
