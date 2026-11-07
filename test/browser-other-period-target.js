'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');
const {stepPeriod}=require('./helpers/visible-period-navigation');
const fx=require('./fixtures/other-period-target'),root=path.join(__dirname,'..');
const out=process.env.ATLAS_BUDGET_SCREENSHOTS_DIR||path.join(require('os').tmpdir(),'other-target-browser');fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
try{for(const width of [1440,390,320])for(const spent of width===320?[137.26,450,618.73,null,'history','next']:[137.26,450,618.73]){
 const historical=spent==='history',future=spent==='next',actual=historical||future?137.26:spent;
 const f=fx.build(actual??137.26,historical?'2026-10-18':fx.asOf);if(spent===null)f.packet.transactionCoverage='truncated';
 const page=await browser.newPage({viewport:{width,height:1000},colorScheme:'light',reducedMotion:'reduce'}),errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!=='http://budget.test'){external.push(u.origin);return route.abort();}
 if(u.pathname==='/data.json')return route.fulfill({json:f.data});
 if(['/periods.json','/balance-history.json','/running-build.json'].includes(u.pathname))return route.fulfill({json:null});
 const file=path.join(root,'public',u.pathname==='/'?'index.html':u.pathname.slice(1));
 if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
 return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});});
 await page.goto('http://budget.test/');await page.locator('[data-budget-surface]').waitFor();
 if(historical){await stepPeriod(page,'ArrowLeft', 'mouse');assert.match(await page.locator('[data-budget-window-range]').innerText(),/Sep 25.*Oct 8/);}
 if(future){await stepPeriod(page,'ArrowRight', 'mouse');assert.match(await page.locator('[data-budget-window-range]').innerText(),/Oct 9.*Oct 22/);}
 const row=page.locator('[data-budget-category-open="other-spending"][data-budget-browse-origin="spending"]');
 if(historical){assert.match(await row.innerText(),/137\.26/);assert.doesNotMatch(await row.innerText(),/450\.00|312\.74 left/,'configured target is not an original completed-period plan');}
 else if(future){assert.match(await row.innerText(),/Not observed[\s\S]*450\.00/);assert.doesNotMatch(await row.innerText(),/137\.26|450\.00 left/);}
 else if(spent!==null)assert.match(await row.innerText(),new RegExp(spent.toFixed(2).replace('.','\\.')+'[\\s\\S]*450\\.00'));
 else{assert.match(await row.innerText(),/Spending unavailable[\s\S]*450\.00/);assert.doesNotMatch(await row.innerText(),/450\.00 left/);}
 assert.equal(await row.locator('[data-budget-category-scale="numeric"]').count(),spent===null||historical||future?0:1);
 const household=await page.locator('[data-operating-question="06"] > details > summary').innerText();
 assert.match(household,historical?/Unknown/:/925\.00/,'unconfirmed original historical denominator stays unknown');
 if(!historical&&!future&&spent!==null){
  // Posted cash already incorporates consumed spend. This independent DOM
  // oracle protects against reserving a second 450 in Today's money.
  const unusedCents=Math.max(0,45000-Math.round(spent*100));
  const expected=((36463+unusedCents)/100).toFixed(2);
  const cashInfo=page.locator('[data-budget-cash-how]');
  await cashInfo.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('[data-budget-detail-sheet]')?.open);
  const cashRow=page.locator('[data-budget-detail-body] [data-payday-breakdown="Current household spending"] > summary');
  assert.equal(await cashRow.isVisible(),true,'the native cash evidence is actually visible');
  const today=await cashRow.innerText();
  assert.match(today,new RegExp(expected.replace('.','\\.')),'Today reserves named remaining 364.63 plus unused Other only');
  await page.screenshot({path:path.join(out,`other-${spent}-cash-${width}.png`),animations:'disabled'});
  await page.keyboard.press('Escape');assert.equal(await cashInfo.evaluate(el=>el===document.activeElement),true);
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 await page.screenshot({path:path.join(out,`other-${spent}-${width}.png`),fullPage:true,animations:'disabled'});
 await row.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-budget-detail-sheet]')?.open);
 const detail=await page.locator('[data-budget-detail-body]').innerText();
 if(spent!==null&&!future)assert.match(detail,/invented-other/);else assert.match(detail,/Spent[\s\S]*Unavailable/);
 assert.match(detail,historical?/Configured target[\s\S]*450\.00/:/Planned[\s\S]*450\.00/,'dated Other target is labeled according to its period evidence');
 if(historical)assert.match(detail,/Historical original plan unavailable/);
 if(future){assert.match(detail,/estimated[\s\S]*450\.00/);assert.match(detail,/Projected/);assert.doesNotMatch(detail,/invented-other/);}
 await page.screenshot({path:path.join(out,`other-${spent}-info-${width}.png`),animations:'disabled'});
 await page.keyboard.press('Escape');assert.equal(await row.evaluate(el=>el===document.activeElement),true);
 assert.equal(await row.evaluate(el=>{const r=el.getBoundingClientRect(),dock=document.querySelector('.sitenav-household');
  const limit=dock&&getComputedStyle(dock).position==='fixed'?dock.getBoundingClientRect().top:innerHeight;
  return r.top>=0&&r.bottom<=limit;}),true,'restored category focus remains physically visible above the mobile dock');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await page.close();console.log(`PASS ${width}px Other actual ${spent} / planned 450, numeric bar, immutable recon, keyboard and focus`);
 }}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
