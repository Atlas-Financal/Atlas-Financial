'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {chromium}=require('playwright'),fx=require('./fixtures/provider-v2-credit-date-data');
const root=process.env.ATLAS_TEST_APP_ROOT||path.resolve(__dirname,'..'),Live=require(path.join(root,'scripts/live-plan'));
const head=cp.execFileSync('git',['-c','safe.directory='+root.replace(/\\/g,'/'),'rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const output=process.env.ATLAS_V2_CREDIT_PROOF||path.join(require('node:os').tmpdir(),'atlas-v2-credit-date');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});const cases=[],errors=[],external=[];
 try{
  for(const width of [1440,390,320])for(const mode of fx.modes){
   const {data}=fx.served(mode,Live),before=JSON.stringify(data),page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{
    const url=new URL(route.request().url());if(url.origin!=='http://credit-date.test'){external.push(url.origin);return route.abort();}
    if(url.pathname==='/data.json')return route.fulfill({json:data});
    if(['/periods.json','/balance-history.json','/running-build.json'].includes(url.pathname))return route.fulfill({json:null});
    const file=path.resolve(root,'public','.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(path.join(root,'public')+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
    return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html'});
   });
   await page.goto('http://credit-date.test/?view=classic');const cash=page.locator('[data-live-current-balance-amount]');await cash.waitFor();
   assert.equal(await cash.innerText(),'$600.00','active Budget cash remains independent of posted/available/limit credit');
   assert.equal(await page.locator('[data-budget-surface="pay-period"]').count(),1,'one active Budget renderer');
   assert.equal(await page.evaluate(()=>App.data.debts[0].balance),fx.qualified.has(mode)?438.16:551.37,'Budget consumes same qualified stock packet');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Budget no horizontal overflow');
   const trigger=page.locator('[data-budget-cash-how]');await trigger.focus();await page.keyboard.press('Enter');
   const dialog=page.locator('[data-budget-detail-sheet]');await dialog.waitFor({state:'visible'});await page.keyboard.press('Escape');
   assert.equal(await trigger.evaluate(el=>el===document.activeElement),true,'exact cash evidence focus restoration');
   assert.equal(await page.evaluate(()=>JSON.stringify(App.data)),before,'Budget source unchanged');
   await page.screenshot({path:path.join(output,mode+'-budget-'+width+'.png'),fullPage:true,animations:'disabled'});
   cases.push({mode,width,stockQualified:fx.qualified.has(mode),cashIsolated:true,noOverflow:true,focusRestored:true,inputUnchanged:true});await page.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({executionHead:head,syntheticOnly:true,productionCredentialsUsed:false,cases,errors,external},null,2)+'\n');
  console.log('PASS actual Budget App.boot with qualified Credit stock packet: '+cases.length+' semantic-date cases, cash isolation, 320px and keyboard/focus');
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
