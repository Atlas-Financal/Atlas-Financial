'use strict';
// Manual real-browser proof. Use an installed Playwright module and browser:
// node test/browser/recorded-cash-labels.cjs <playwright-module> <browser-exe> <out-dir>
// Every response is local source or an independent invented fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {chromium}=require(process.argv[2]||'playwright'),root=path.resolve(__dirname,'../..'),out=path.resolve(process.argv[4]||path.join(os.tmpdir(),'atlas-recorded-cash-browser'));
const fx=require('../fixtures/recorded-cash-labels-data'),data=fx.data(),history=fx.history(true),original=JSON.stringify(data),historyBefore=JSON.stringify(history);
const head=cp.execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true,...(process.argv[3]?{executablePath:process.argv[3]}:{})}),cases=[],errors=[],external=[];
try{for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});let missingHistory=false;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!=='http://cash-scope.test'){external.push(url.origin);return route.abort();}
  if(url.pathname==='/data.json')return route.fulfill({json:data});
  if(url.pathname==='/balance-history.json')return route.fulfill({json:missingHistory?null:history});
  if(['/periods.json','/running-build.json'].includes(url.pathname))return route.fulfill({json:null});
  const file=path.resolve(root,'public','.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(path.join(root,'public')+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
  return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});
 });
 await page.goto('http://cash-scope.test/');await page.locator('[data-budget-surface]').waitFor();
 const note=page.locator('#hero-note');assert.match(await note.textContent(),/Chequing A and Chequing B \(designated Savings is reserve evidence/);assert.match(await note.textContent(),/2026-08-20/);
 assert.doesNotMatch(await page.locator('#assumption-list').textContent(),/Chequing A, Chequing B and Savings/);
 const historySummary=page.locator('#recorded-balances > summary');await historySummary.focus();await page.keyboard.press('Enter');
 const summary=page.locator('.recorded-cash-scope summary');await page.keyboard.press('Tab');assert.equal(await summary.evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('Enter');assert.equal(await summary.evaluate(el=>el.parentElement.open),true);
 const scope=page.locator('.recorded-cash-scope');assert.match(await scope.innerText(),/does not show what is safe to spend/);
 for(const snapshot of history.snapshots){const row=scope.locator('li').filter({has:page.locator('time[datetime="'+snapshot.asOf+'"]')});assert.equal(await row.count(),1);for(const account of snapshot.accounts)assert.ok((await row.innerText()).includes(account.label));}
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.ok((await scope.boundingBox()).width<=480.1,'long included labels stay within membership measure');
 await page.keyboard.press('Enter');assert.equal(await summary.evaluate(el=>el.parentElement.open),false);assert.equal(await summary.evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('Enter');assert.equal(await summary.evaluate(el=>el.parentElement.open),true);
 await scope.screenshot({path:path.join(out,'membership-'+width+'.png'),animations:'disabled'});
 await page.locator('#balance-history').screenshot({path:path.join(out,'history-'+width+'.png'),animations:'disabled'});
 assert.equal(await page.evaluate(()=>JSON.stringify(App.data)),original);
 // Inspect the retained 13-week note printer. Its legacy parent remains hidden
 // in production; the independently reachable history disclosure is tested above.
 await page.evaluate(()=>{document.getElementById('road-ahead').hidden=false;});
 const details=note.locator('xpath=ancestor::details[1]');await details.locator(':scope > summary').focus();await page.keyboard.press('Enter');
 await note.screenshot({path:path.join(out,'budget-note-'+width+'.png'),animations:'disabled'});
 // Deep Dive and Records were removed (#822 slice 4, bc8aae32); their checks went with them.
 missingHistory=true;await page.goto('http://cash-scope.test/');await page.locator('[data-budget-surface]').waitFor();
 await page.locator('#recorded-balances > summary').focus();await page.keyboard.press('Enter');
 assert.match(await page.locator('#balance-history').innerText(),/Dated openings are not available/);assert.equal(await page.locator('.recorded-cash-scope').count(),0);
 cases.push({width,datedMembership:true,longNamesRetained:true,keyboardOpenCloseFocus:true,noPageOverflow:true,currentNotesCorrect:true,missingHistoryWithheld:true,inputsUnchanged:true});await page.close();console.log('PASS real browser cash scope '+width+'px');
 }assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(JSON.stringify(history),historyBefore);
 fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({head,fixtureOnly:true,cases,errors,external},null,2)+'\n');
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
