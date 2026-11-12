'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const fx=require('./fixtures/other-period-target'),root=process.env.ATLAS_HOUSEHOLD_TOTAL_ROOT||path.join(__dirname,'..');
const out=process.env.ATLAS_BUDGET_SCREENSHOTS_DIR||path.join(require('node:os').tmpdir(),'household-total-browser');fs.mkdirSync(out,{recursive:true});
const baseline=process.env.ATLAS_HOUSEHOLD_TOTAL_BASELINE==='1';
const beforeP1=process.env.ATLAS_HOUSEHOLD_TOTAL_BASELINE==='5b';
// Invented published observations: six plans = 475, groceries spent = 110.37.
const actuals={0:'110.37',137.26:'247.63',450:'560.37',618.73:'729.10',1034.19:'1,144.56'};
const remaining={0:'450.00',137.26:'312.74',450:'0.00',618.73:'−$168.73',1034.19:'−$584.19'};
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
try{for(const width of [1440,390,320])for(const state of width===320?[0,137.26,450,618.73,1034.19,null,'history','next','pending-partial','pending-unknown','complete-pending']:width===390?[137.26,450,618.73,'pending-unknown']:[137.26,618.73,'pending-partial']){
 const historical=state==='history',future=state==='next',incompletePending=state==='pending-partial'||state==='pending-unknown',completePending=state==='complete-pending';
 const f=fx.build(typeof state==='number'?state:137.26,historical?'2026-10-18':fx.asOf,
  {pendingCoverage:incompletePending?state.slice(8):'complete',pendingOther:completePending?17.43:undefined});
 if(state===null)f.packet.transactionCoverage='truncated';
 const page=await browser.newPage({viewport:{width,height:1000},colorScheme:'light',reducedMotion:'reduce'}),errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!=='http://budget.test'){external.push(u.origin);return route.abort();}
  if(u.pathname==='/data.json')return route.fulfill({json:f.data});
  if(['/periods.json','/balance-history.json','/running-build.json'].includes(u.pathname))return route.fulfill({json:null});
  const file=path.join(root,'public',u.pathname==='/'?'index.html':u.pathname.slice(1));
  if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
  return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});
 });
 await page.goto('http://budget.test/');await page.locator('[data-budget-surface]').waitFor();
 // The river hides the native step control; drive its incumbent handler.
 const step=async dir=>{const was=await page.evaluate(()=>[...document.querySelectorAll('[data-budget-window-range]')].map(e=>e.textContent).join('|'));
  await page.evaluate(d=>{const b=[...document.querySelectorAll(`[data-budget-window-step="${d}"]`)].find(x=>x.getAttribute('aria-disabled')!=='true');if(!b)throw Error('no step '+d);b.click();},dir);
  await page.waitForFunction(w=>[...document.querySelectorAll('[data-budget-window-range]')].map(e=>e.textContent).join('|')!==w,was);};
 if(historical)await step('-1');
 if(future)await step('1');
 const trigger=page.locator('[data-operating-question="06"] > details > summary');
 await trigger.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-budget-detail-sheet]')?.open);
 const body=page.locator('[data-budget-detail-body]');assert.equal(await body.isVisible(),true);
 if(!baseline){
  assert.equal(await body.locator('h3').filter({hasText:/^Household Budget Total$/}).count(),1);
  assert.doesNotMatch(await body.innerText(),/Actual and original plan|Original plan:/);
  assert.match(await body.innerText(),/Actual \/ Planned/);
  const total=body.locator('[data-household-budget-progress-total]');
  const a=await total.locator('[data-budget-ratio-actual]').innerText(),p=await total.locator('[data-budget-ratio-plan]').innerText();
  assert.match(a,state===null||future?/Unknown/:new RegExp((completePending?'265.06':historical||incompletePending?'247.63':actuals[state]).replace('.','\\.')));
  if(incompletePending){
   assert.equal(f.packet.pendingCoverage,state.slice(8),'actual provider sanitized coverage, not a substituted publication');
   assert.equal(await total.locator('[data-budget-progress-partial]').count(),1);
   const nativeOther=body.locator('[data-budget-category="other-spending"] .household-budget-remaining dd');
   assert.match(await nativeOther.innerText(),beforeP1?/312\.74/:/Unavailable/,'opened household sheet propagates the same actual completeness to Other');
   if(!beforeP1)assert.equal(await body.locator('.household-budget-remaining dd').filter({hasText:/^Unavailable$/}).count(),7);
  }
  assert.match(p,historical?/Unknown/:/925\.00/,'original plan survives overspending and missing actuals');
  const info=body.locator('[data-budget-reserve-info]'),reserve=info.locator('[data-household-budget-total-amount]');
  assert.equal(await info.evaluate(el=>el.open),false);assert.equal(await reserve.isVisible(),false,'reserve is withheld from default visible totals');
  await total.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`household-${state}-${width}.png`),animations:'disabled'});
  const infoTrigger=info.locator(':scope > summary');await infoTrigger.focus();await page.keyboard.press('Enter');
  assert.equal(await reserve.isVisible(),true,'reserve math remains keyboard reachable');
  assert.match(await info.innerText(),historical?/Completed-period spending deduction/:/Protective spending reserve/);
  if(typeof state==='number')assert.match(await reserve.innerText(),state===1034.19?/1,509\.19/:state===618.73?/1,093\.73/:/925\.00/,'independent protective reserve is unchanged');
  if(state===137.26&&width===320){await reserve.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'household-reserve-info-320.png'),animations:'disabled'});}
  await infoTrigger.focus();await page.keyboard.press('Enter');assert.equal(await reserve.isVisible(),false);
 }else{
  assert.match(await body.innerText(),/Household Budget Total[\s\S]*Actual and original plan/);
  const evidence=body.locator('[data-budget-progress-evidence="household"]');await evidence.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,`household-${state}-${width}.png`),animations:'disabled'});
 }
 await page.keyboard.press('Escape');assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
 // #548 moved the roster off-screen: the visible Household list opens Other
 // spending by its data-blend-cat control (bars or rings, whichever shows).
 const otherTrigger=page.locator('[data-blend-cat="other-spending"]:visible').first();
 await otherTrigger.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-budget-detail-sheet]')?.open);
 const other=body.locator('[data-budget-category="other-spending"]');
 if(!baseline&&!historical){
  const metric=other.locator('.household-budget-remaining');
  assert.equal(await metric.locator('dt').innerText(),'Remaining');
  assert.match(await metric.locator('dd').innerText(),state===null||incompletePending&&!beforeP1?/Unavailable/:incompletePending?/312\.74/:completePending?/295\.31/:future?/450\.00/:new RegExp(remaining[state].replace('$','\\$').replace('.','\\.')));
  if(future){assert.match(await other.innerText(),/Projected/);assert.match(await metric.locator('dd').innerText(),/estimated/);}
 }else assert.equal(await other.locator('.household-budget-remaining').count(),0,'historical original remaining stays unknown');
 if(historical)assert.match(await other.innerText(),/Historical original plan unavailable/);
 // The transactions sit behind the sheet's Spent disclosure (spent drilldown).
 if(!future&&state!==null&&state!==0){
  const spent=other.locator('details:has([data-budget-spent-detail])').first();
  if(!await spent.evaluate(el=>el.open))await spent.locator(':scope > summary').click();
  assert.match(await other.innerText(),/invented-other/);
 }
 if(state===0)assert.match(await other.innerText(),/Spent[\s\S]*\$0\.00/,'complete zero spending needs no invented merchant');
 await page.screenshot({path:path.join(out,`other-remaining-${state}-${width}.png`),animations:'disabled'});
 if(incompletePending&&!baseline&&!beforeP1){
  const info=other.locator('[data-budget-remaining-info]'),control=info.locator(':scope > summary');
  assert.equal(await info.evaluate(el=>el.open),false);await control.focus();await page.keyboard.press('Enter');
  assert.equal(await info.locator('p').isVisible(),true);assert.match(await info.innerText(),/pending|coverage/i);
  if(state==='pending-partial'&&width===320)await page.screenshot({path:path.join(out,'other-remaining-pending-partial-info-320.png'),animations:'disabled'});
  await control.focus();await page.keyboard.press('Enter');assert.equal(await info.locator('p').isVisible(),false);
 }
 await page.keyboard.press('Escape');assert.equal(await otherTrigger.evaluate(el=>el===document.activeElement),true);
 assert.equal(await otherTrigger.evaluate(el=>{const r=el.getBoundingClientRect(),dock=document.querySelector('.sitenav-household');
  const limit=dock&&getComputedStyle(dock).position==='fixed'?dock.getBoundingClientRect().top:innerHeight;return r.top>=0&&r.bottom<=limit;}),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 if(incompletePending&&!baseline&&!beforeP1)assert.doesNotMatch(await otherTrigger.innerText(),/312\.74 left/);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await page.close();console.log(`PASS ${width}px ${state}: opened native actual/planned total, reserve Info, Other remaining, keyboard/focus and unavailable/history scope${baseline?' BASELINE':beforeP1?' P1 BASELINE':''}`);
}}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
