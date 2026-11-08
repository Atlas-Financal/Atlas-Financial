'use strict';
// Invented source reports only. Intercept every request; no authenticated site.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const fixture=require('./fixtures/payday-gap-reserve-data'),shell=require('./fixtures/savings-daily-consumer-data');
const root=path.resolve(__dirname,'..'),base=process.env.ATLAS_GAP_BASE_APP_ROOT;
if(!base)throw new Error('ATLAS_GAP_BASE_APP_ROOT must name the frozen base checkout.');
const out=process.env.ATLAS_GAP_BROWSER_PROOF||path.join(require('node:os').tmpdir(),'atlas-payday-gap-proof');
fs.mkdirSync(out,{recursive:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const served={},cases=[],errors=[],external=[],writes=[];
function dataFor(revision) {
  const i=fixture.input();i.asOf=i.x.asOf='2026-10-14';i.plan.income[0].anchor='2026-10-09';
  i.plan.income[1].date='2026-10-23';i.plan.income[2].date='2026-11-06';
  i.plan.income.push({id:'p3',label:'Invented third receipt',frequency:'once',date:'2026-11-20',amount:1000,confidence:'confirmed'});
  i.window.endDate=i.asOf;
  const canonical=shell('ready');canonical.meta={asOf:'2026-09-29',title:'Invented payday-gap browser proof'};
  canonical.plan=i.plan;canonical.debts=[];
  const payload=fixture.payload(i);payload.fetchedAt='2026-10-14T18:00:00Z';
  payload.accounts.forEach(a=>{a.updated_at=a.balance_last_update='2026-10-14T17:55:00Z';});
  const Live=require(path.join(revision,'scripts/live-plan'));
  const r=Live.fromObservation({data:canonical,payload,accountMap:i.accountMap});
  r.data.meta.asOf=i.asOf;
  return {data:r.data,earned:r.report.currentPeriodActuals.paydayGapComplete,snapshot:r.data.plan.opening.paydaySnapshot};
}
async function next(page) {
  const before=await page.locator('[data-budget-window-progress]').getAttribute('data-start');
  await page.locator('.river').focus();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(start=>document.querySelector('[data-budget-window-progress]')?.dataset.start!==start,before);
}
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{for(const width of [390,1440])for(const [mode,revision]of [['before',base],['after',root]]){
    const source=dataFor(revision),assets=path.join(revision,'public');served[mode]??={};
    const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
    await page.addInitScript(()=>localStorage.setItem('hfd-plan-knobs-v1',JSON.stringify({weeklyVariable:0})));
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(u.origin!=='http://payday-gap.test'){external.push(u.origin);return route.abort();}
      if(route.request().method()!=='GET'){writes.push(route.request().method());return route.abort();}
      if(u.pathname==='/data.json')return route.fulfill({json:source.data});
      if(['/periods.json','/balance-history.json','/running-build.json'].includes(u.pathname))return route.fulfill({json:null});
      const file=path.resolve(assets,'.'+(u.pathname==='/'?'/index.html':u.pathname));
      if(!file.startsWith(assets+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
      const body=fs.readFileSync(file);served[mode][path.relative(revision,file).replaceAll('\\','/')]=hash(body);
      return route.fulfill({body,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('http://payday-gap.test/');
    const tile=page.locator('[data-budget-savings-goals]');await tile.waitFor();
    const initial=await page.evaluate(()=>JSON.stringify(App.data));
    const dates=[];for(let n=0;n<3;n++){await next(page);dates.push(await page.locator('[data-budget-window-progress]').getAttribute('data-start'));}
    assert.deepEqual(dates,['2026-10-23','2026-11-06','2026-11-20']);
    await tile.locator('[data-budget-funding-inventory]').focus();await page.keyboard.press('Enter');
    const dialog=page.locator('[data-budget-detail-sheet]');await dialog.waitFor({state:'visible'});
    const summary=dialog.locator('[data-budget-savings-info]>summary');
    if(!await summary.evaluate(n=>n.parentElement.open))await summary.click();
    const reason=await dialog.locator('[data-budget-savings-info]>div>p').first().textContent().catch(()=>null);
    const publication=await page.evaluate(()=>{const d=App.data,
      a=Forecast.recommend(d.plan,d.meta.asOf,{...d.plan.defaults,...d.liveOverlay,weeklyVariable:0,debts:d.debts||[]}),views=a.savingsFunding.periodViews;
      const v=views.find(v=>v.start==='2026-11-20');const c=Forecast.savingsFundingPublication(a.savingsFunding,{asOf:'2026-10-14',advice:a,periodId:v.id}).forecastClosing;
      return {start:c.start,end:c.end,status:c.status,stock:c.stock,operating:c.operatingCash,reason:c.reason,actualSaved:c.actualSaved,permission:c.moneyMovementPermission};});
    assert.equal(publication.start,'2026-11-20');assert.equal(publication.end,'2026-12-03');
    if(mode==='before'){assert.equal(source.earned,false);assert.equal(publication.status,'unavailable');assert.equal(publication.stock,null);
      assert.equal(reason,'No original payday cash observation supports the cycle bridge.');}
    else{assert.equal(source.earned,true);assert.equal(source.snapshot.opening,70+30+20-7);assert.equal(publication.status,'ready');
      assert.equal(publication.stock+publication.operating,119+113+3000);
      assert.ok((await dialog.innerText()).includes(publication.stock.toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2})));}
    assert.equal(publication.actualSaved,null);assert.equal(publication.permission,'not-granted');
    assert.equal(await page.evaluate(()=>JSON.stringify(App.data)),initial);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await dialog.screenshot({path:path.join(out,mode+'-'+width+'.png'),animations:'disabled'});
    cases.push({mode,width,dates,publication,inputUnchanged:true});console.log('PASS '+mode+' '+width);await page.close();
  }}finally{await browser.close();}
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(writes,[]);
  const bindings={};for(const [mode,revision]of [['before',base],['after',root]]){
    bindings[mode]={};for(const file of ['scripts/provider-observe.js','scripts/live-plan.js','test/fixtures/payday-gap-reserve-data.js']){
      if(fs.existsSync(path.join(revision,file)))bindings[mode][file]=hash(fs.readFileSync(path.join(revision,file)));
    }
  }
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({synthetic:true,base:'52532e1719e39643b048a8783609719220ad2ddf',cases,served,bindings,errors,external,writes},null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
