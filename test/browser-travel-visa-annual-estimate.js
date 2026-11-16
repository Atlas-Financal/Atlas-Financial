'use strict';
// Actual native Budget boot; independent invented household only.
// node test/browser-travel-visa-annual-estimate.js [installed-browser] [output]
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.join(__dirname,'..'),out=process.argv[3]||path.join(require('node:os').tmpdir(),'invented-annual-estimate');
fs.mkdirSync(out,{recursive:true});
const head=cp.execFileSync('git',['-c','safe.directory='+root.replace(/\\/g,'/'),'rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
function fixture(){
 const d=require('./fixtures/budget-surface-data').canonical();
 d.meta={asOf:'2031-04-01',title:'Invented annual fee estimate'};
 d.plan.opening={asOf:d.meta.asOf,representedEvents:[]};
 d.plan.cardPurchaseCoverage=require('./fixtures/card-coverage-opening')(d.meta.asOf);
 d.plan.startingCash.breakdown[0].value=1200;d.plan.startingCash.breakdown[1].value=100;
 d.plan.defaults.targetBuffer=0;
 d.plan.income=[{id:'payroll',label:'Invented salary',frequency:'biweekly',anchor:'2031-04-02',amount:1800,confidence:'confirmed'}];
 d.plan.bills=[{id:'invented-card-fee',label:'Invented annual fee estimate',frequency:'yearly',month:4,day:23,firstDue:'2031-04-23',
   amount:73.41,confidence:'estimated',dateConfidence:'estimated',jointCash:false,payingAccount:'travelvisa',
   note:'Independent invented planning estimate. Amount and date remain estimated; no issuer due date or payment is claimed.'}];
 d.plan.commitments=[];return d;
}
const states=[],errors=[],external=[],writes=[];
(async()=>{
 const browser=await chromium.launch({executablePath:process.argv[2]||undefined,headless:true});
 try{
  for(const width of [1440,390,320]){
   const d=fixture(),page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
   page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://estimate.test'){external.push(url.origin);return route.abort();}
    if(route.request().method()!=='GET')writes.push(route.request().method());
    if(url.pathname==='/data.json')return route.fulfill({json:d});
    if(['/periods.json','/balance-history.json','/running-build.json'].includes(url.pathname))return route.fulfill({json:null});
    const file=path.join(root,'public',url.pathname==='/'?'index.html':url.pathname.slice(1));
    return fs.existsSync(file)?route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
   });
   await page.goto('http://estimate.test/');
   await page.locator('[data-budget-surface]').waitFor();
   // The Budget page prints this bill as a funding item with its estimate mark and planning date.
   const item=page.locator('[data-budget-funding-item="invented-card-fee"]').first();await item.waitFor({state:'attached'});
   const text=await item.textContent();assert.match(text,/73\.41/);assert.match(text,/estimated/i);
   assert.match(text,/2031-04-23/);assert.doesNotMatch(text,/payment due|issuer minimum/i);
   const event=await page.evaluate(()=>Forecast.expandEvents(App.data.plan,'2031-04-01','2031-04-30').find(r=>r.id==='invented-card-fee'));
   assert.equal(event.amount,-73.41);assert.equal(event.confidence,'estimated');assert.equal(event.cardPaid,true);
   assert.equal(event.jointCash,false);assert.equal(event.payingAccount,'travelvisa');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no viewport overflow');
   await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
   await page.screenshot({path:path.join(out,'estimate-'+width+'.png'),fullPage:true,animations:'disabled'});
   const goal=page.locator('[data-blend-goal="invented-card-fee"]');
   await goal.focus();await page.keyboard.press('Enter');
   await page.locator('dialog[open]').waitFor();assert.match(await page.locator('dialog[open]').innerText(),/Invented annual fee estimate/,'goal window reachable by keyboard');
   await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0,'goal window closes');
   states.push({width,synthetic:true,text:text.replace(/\s+/g,' ').trim(),event});
   await page.close();console.log('PASS '+width+'px: actual Budget, estimated funding item and date, native card-paid reserve, keyboard, no overflow');
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(writes,[]);
  const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f),'utf8').replace(/\r\n/g,'\n')).digest('hex');
  fs.writeFileSync(path.join(out,'browser-proof.json'),JSON.stringify({head,synthetic:true,sourceHashEncoding:'UTF-8 LF (git blob)',
   forecastSha256:hash('public/forecast.js'),rendererSha256:hash('public/plan.js'),browserSha256:hash('test/browser-travel-visa-annual-estimate.js'),states},null,2)+'\n');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
