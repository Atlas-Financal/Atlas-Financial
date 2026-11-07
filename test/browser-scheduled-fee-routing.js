'use strict';
const { stepPeriod, openPeriodFigures } = require('./helpers/visible-period-navigation');
// Actual App.boot on independent invented observations; all network intercepted.
// Optional: node test/browser-scheduled-fee-routing.js [chrome-path] [output-dir]
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const fx=require('./fixtures/scheduled-fee-routing-data');
const Live=require('../scripts/live-plan');
const root=path.join(__dirname,'..'),out=process.argv[3]||path.join(require('node:os').tmpdir(),'scheduled-fee-routing');
fs.mkdirSync(out,{recursive:true});
const head=cp.execFileSync('git',['-c','safe.directory='+root.replace(/\\/g,'/'),'rev-parse','HEAD'],
  {cwd:root,encoding:'utf8'}).trim();
const errors=[],writes=[],external=[],states=[];
const visibleText=text=>text.replace(/\s+/g,' ').trim();
const sourceHash=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n')).digest('hex');
(async()=>{
  const browser=await chromium.launch({executablePath:process.argv[2]||undefined,headless:true});
  try {
    for(const width of [1440,390,320]) for(const state of ['below','equal','above','coverage-withheld','early-below','early-above']) {
      const early=state.startsWith('early-'),below=state==='below'||state==='early-below';
      const above=state==='above'||state==='early-above';
      const posted=above?28:state==='equal'?24:16;
      const data=Live.fromObservation((early?fx.early:fx)(posted,below)).data;
      data.meta.title='Invented scheduled fee routing';
      if(state==='coverage-withheld') data.liveOverlay.currentPeriodActuals.transactionCoverage='truncated';
      const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce',colorScheme:'light'});
      page.setDefaultTimeout(10000);
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.origin!=='http://fees.test'){external.push(url.origin);return route.abort();}
        if(route.request().method()!=='GET')writes.push(route.request().method());
        if(url.pathname==='/data.json')return route.fulfill({json:data});
        if(['/periods.json','/balance-history.json','/running-build.json'].includes(url.pathname))return route.fulfill({json:null});
        const file=path.join(root,'public',url.pathname==='/'?'index.html':url.pathname.slice(1));
        return fs.existsSync(file)?route.fulfill({body:fs.readFileSync(file),
          contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'})
          :route.fulfill({status:404,body:''});
      });
      await page.goto('http://fees.test/');
      await page.locator('[data-budget-surface]').waitFor();
      assert.equal(await page.evaluate(()=>App.data.meta.title),'Invented scheduled fee routing');
      const trigger=page.locator('[data-operating-question="04"] > details > summary');
      const header=visibleText(await trigger.innerText());
      if(state==='coverage-withheld')assert.match(header,/Unknown/);
      else assert.ok(header.includes(posted.toFixed(2)),header);
      assert.ok(header.includes('24.00'),'original plan remains 24');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no viewport overflow');
      const native=await page.evaluate(()=>{
        const day=App.data.plan.opening.asOf,packet=App.data.liveOverlay.currentPeriodActuals;
        const advice=Forecast.recommend(App.data.plan,day,{debts:App.data.debts,currentPeriodActuals:packet});
        const p=advice.payPeriodViews.find(row=>row.start<=day&&row.end>=day);
        const bill=p.bills.find(row=>row.id==='tdfees'),other=p.householdBudget.find(row=>row.otherSpending);
        return {planned:p.budgetProgress.bills.planned.amount,actual:p.budgetProgress.bills.actual.amount,
          remaining:p.remainingBills,bad:p.balanceAfterDeductions,available:p.fromTodayFunding.availableNow??null,
          fee:bill.scheduledFeeAllowance??null,other:other?.spent??0,cardReserve:advice.cardPurchaseCoverage.reservedCash};
      });
      assert.equal(native.planned,24);
      if(state==='coverage-withheld'){assert.equal(native.actual,null);assert.equal(native.available,null);}
      else {
        assert.equal(native.actual,posted);
        assert.equal(native.remaining,Math.max(0,24-posted));
        assert.equal(native.bad,above?822:below?808.44:826);
        assert.equal(native.available,above?422:below?408.44:426);
        assert.equal(native.other,below?17.56:0);
        assert.equal(native.cardReserve,below?13.37:0);
      }
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
      await page.screenshot({path:path.join(out,state+'-'+width+'.png'),fullPage:true,animations:'disabled'});
      await trigger.focus();await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('[data-budget-detail-sheet]')?.open);
      const body=page.locator('[data-budget-detail-body]');
      const evidence=await body.locator('[data-budget-progress-evidence="bills"]').innerText();
      if(below) {
        assert.match(await body.innerText(),/Remaining bill reserve/);
        assert.match(await body.locator('[data-scheduled-fee-reserve]').innerText(),/not another payment due/);
        assert.match(await page.locator('[data-budget-browse="bills"]').innerText(),/8\.00 still reserved for bills/);
      } else if(state==='equal'||above) {
        assert.equal(await body.locator('[data-scheduled-fee-reserve]').count(),0);
      }
      if(state==='coverage-withheld')assert.match(evidence,/Actual: Unavailable/);
      else assert.ok(evidence.includes('Actual: $'+posted.toFixed(2)),evidence);
      await page.screenshot({path:path.join(out,state+'-info-'+width+'.png'),animations:'disabled'});
      await page.keyboard.press('Escape');
      assert.equal(await trigger.evaluate(el=>el===document.activeElement),true,'keyboard focus restored');
      const selected=await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
      await stepPeriod(page, 'ArrowRight');
      await stepPeriod(page, 'ArrowLeft');
      assert.equal(await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period'),selected);
      assert.equal(visibleText(await trigger.innerText()),header,'period return retains sealed figures');
      await openPeriodFigures(page);
      await page.locator('[aria-label="Budget planning granularity"] [data-budget-granularity="month"]').click();
      await page.locator('[data-budget-month-view]').waitFor();
      await page.locator('[aria-label="Budget planning granularity"] [data-budget-granularity="pay-period"]').click();
      if(await page.locator('[data-budget-drilldown-exit]').count())await page.locator('[data-budget-drilldown-exit]').click();
      assert.equal(visibleText(await trigger.innerText()),header,'month return retains sealed figures');
      await page.setViewportSize({width:width===1440?390:1440,height:1000});
      assert.equal(visibleText(await trigger.innerText()),header,'resize retains sealed figures');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      states.push({width,state,header:header.replace(/\s+/g,' ').trim(),native,synthetic:true});
      await page.close();
      console.log('PASS '+width+'px '+state+': App.boot, progress/Info, conserved fee terms, keyboard and navigation');
    }
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.deepEqual(external,[]);
    fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({synthetic:true,executionHead:head,
      sourceHashEncoding:'UTF-8 LF (git blob)',planSha256:sourceHash('public/plan.js'),
      forecastSha256:sourceHash('public/forecast.js'),
      browserSha256:sourceHash('test/browser-scheduled-fee-routing.js'),states},null,2)+'\n');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
