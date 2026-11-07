'use strict';
const { stepPeriod } = require('./helpers/visible-period-navigation');
// Real App.boot and active pages; invented HTTP fixture, no external requests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {chromium}=require('playwright'),fx=require('./fixtures/chronological-savings-data');
const root=path.resolve(__dirname,'..'),assets=process.env.ATLAS_SAVINGS_ASSETS||path.join(root,'public');
const output=process.env.ATLAS_SAVINGS_PROOF||path.join(require('node:os').tmpdir(),'atlas-one-pot-proof');
const head=cp.execFileSync('git',['-c','safe.directory='+root,'rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
fs.mkdirSync(output,{recursive:true});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});const errors=[],external=[],cases=[];
try{for(const width of [1440,390,320])for(const mode of ['ready','deposit','settled','missing','stale','pending','negative','undated']){
 const data=fx.data(mode),page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
 await page.addInitScript(()=>localStorage.setItem('hfd-plan-knobs-v1',JSON.stringify({weeklyVariable:40})));
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!=='http://one-pot.test'){external.push(u.origin);return route.abort();}
  if(u.pathname==='/data.json')return route.fulfill({json:data});
  if(['/periods.json','/balance-history.json','/running-build.json'].includes(u.pathname))return route.fulfill({json:null});
  const file=path.resolve(assets,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(assets+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
  let body=fs.readFileSync(file);if(u.pathname==='/forecast.js')body=Buffer.concat([body,Buffer.from(`\n{const native=Forecast.recommend;Forecast.recommend=(...args)=>{const a=native(...args);window.__advice=a;window.__packet=a.savingsFunding;return a;};Forecast.savingsDailyFunding=()=>{throw Error('Forbidden page daily calculator fallback');};Forecast.savingsFundingTimeline=()=>{throw Error('Forbidden page timeline calculator fallback');};}\n`)]);
  return route.fulfill({body,contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html'});
 });
 await page.goto('http://one-pot.test/');const summary=page.locator('[data-calendar-waterfall]').first().locator('[data-operating-question="savings"] > details > summary');await summary.waitFor();
 const packet=await page.evaluate(()=>window.__packet);assert.equal(packet.source,'Forecast.savingsDailyFunding');
 const backed=['ready','deposit','settled'].includes(mode),club=mode==='deposit'?105:95;
 assert.equal(packet.backing.status,backed?'ready':'unavailable');
 assert.ok(packet.backing.items.some(r=>r.id==='trip'),'unlinked requirement beyond short view survives');
 if(mode==='settled')assert.ok(!packet.backing.items.some(r=>r.id==='near'));
 const original=await page.evaluate(()=>JSON.stringify(App.data));
 const group=page.locator('[data-budget-savings-goals] [data-budget-savings-goal="group:club"] .budget-goal-amount').first();
 assert.match(await group.innerText(),backed?new RegExp(club+'\\.00'):/Unavailable/);
 for(const item of packet.backing.items){const row=page.locator('[data-budget-funding-panel="today"] [data-budget-funding-cost="'+item.key+'"]');assert.equal(await row.count(),1);
  assert.match(await row.locator('[data-budget-funding-saved]').innerText(),item.saved==null?/Unavailable/:new RegExp(item.saved.toFixed(2).replace('.','\\.')));
 }
 await summary.focus();await page.keyboard.press('Enter');const dialog=page.locator('[data-budget-detail-sheet]'),body=page.locator('[data-budget-detail-body]');await dialog.waitFor({state:'visible'});
 assert.match(await body.locator('[data-budget-savings-total-goal="group:club"] [data-budget-savings-total-saved]').innerText(),backed?new RegExp(club+'\\.00'):/Unavailable/);
 if(mode==='ready')await dialog.screenshot({path:path.join(output,'chronological-savings-detail-'+width+'.png')});
 await page.keyboard.press('Escape');assert.ok(await summary.evaluate(e=>e===document.activeElement),'focus restored to Savings trigger');
 const goal=page.locator('[data-budget-savings-goals] [data-budget-goal-open="group:club"]');await goal.focus();await page.keyboard.press('Enter');await dialog.waitFor({state:'visible'});await page.keyboard.press('Escape');assert.ok(await goal.evaluate(e=>e===document.activeElement),'goal sheet restores focus');
 const today=page.locator('[data-budget-funding-tab="today"]');await today.focus();await page.keyboard.press('ArrowRight');assert.ok(await page.locator('[data-budget-funding-tab="payday"]').evaluate(e=>e===document.activeElement));for(const item of packet.backing.items){const row=page.locator('[data-budget-funding-panel="payday"] [data-budget-funding-cost="'+item.key+'"]');assert.equal(await row.count(),1);assert.match(await row.locator('[data-budget-funding-saved]').innerText(),item.saved==null?/Unavailable/:new RegExp(item.saved.toFixed(2).replace('.','\\.')));}
 if(mode==='ready')await page.locator('[data-budget-funding-section]').screenshot({path:path.join(output,'chronological-savings-payday-'+width+'.png')});
 await page.keyboard.press('Home');assert.ok(await today.evaluate(e=>e===document.activeElement));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px/page width overflow');
 if(mode==='ready'||mode==='missing'&&width===320){await page.locator('[data-budget-funding-section]').screenshot({path:path.join(output,'chronological-savings-'+mode+'-'+width+'.png')});}
 assert.equal(await page.evaluate(()=>JSON.stringify(App.data)),original,'inputs not mutated');
 const before=packet.rows.map(r=>[r.key,r.saved]);await page.evaluate(()=>App.rerender());await summary.waitFor();assert.deepEqual(await page.evaluate(()=>window.__packet.rows.map(r=>[r.key,r.saved])),before,'redraw replaces allocation');
 if(mode==='ready'){
  // #548 exposes selection directly on the river instead of a modal wheel.
  const chooser=page.getByRole('slider',{name:'Pay period',exact:true});
  await stepPeriod(page,'ArrowRight');
  assert.equal(await dialog.evaluate(el=>el.open),false,'visible period navigation does not open a modal picker');
  assert.ok(await chooser.evaluate(e=>e===document.activeElement),'visible period selector retains focus');
  await page.keyboard.press('Escape');assert.ok(await chooser.evaluate(e=>e===document.activeElement),'Escape keeps focus on the visible period selector');
  const nextGoal=page.locator('[data-budget-savings-goals] [data-budget-savings-goal="group:club"]');
  assert.match(await nextGoal.locator('.budget-goal-amount').first().innerText(),/Unavailable/,'future actual saving remains unknown');
  assert.match(await nextGoal.innerText(),/Projected top-up:[\s\S]*135\.00/);
  const futureSummary=page.locator('[data-calendar-waterfall]').first().locator('[data-operating-question="savings"] > details > summary');
  await futureSummary.focus();await page.keyboard.press('Enter');await dialog.waitFor({state:'visible'});
  assert.match(await body.locator('[data-budget-savings-total-goal="group:club"] [data-budget-savings-total-saved]').innerText(),/Unavailable/);
  assert.match(await body.locator('[data-budget-savings-total-goal="group:club"] [data-budget-savings-proposed]').innerText(),/135\.00/);
  await page.keyboard.press('Escape');assert.ok(await futureSummary.evaluate(e=>e===document.activeElement));
  if(width===320)await page.locator('[data-budget-funding-section]').screenshot({path:path.join(output,'chronological-savings-future-320.png')});
  await page.goto('http://one-pot.test/plan-spend.html');await page.locator('[data-savings-goal="group:club"]').waitFor();
  assert.match(await page.locator('[data-savings-goal="group:club"] [data-savings-backed]').innerText(),/95\.00/);
  assert.match(await page.locator('[data-plan-spend-card="summary"] [data-plan-spend-fact="protected"]').innerText(),/95\.00/);
  assert.match(await page.locator('[data-plan-spend-card="summary"] [data-plan-spend-fact="protected"]').innerText(),/Currently backed for this cost/);
  assert.ok(await page.evaluate(()=>window.__packet.schedule===window.__advice.planSpendPaydayFunding),'Plan Spend uses the same schedule alias');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'chronological-savings-plan-spend-'+width+'.png'),fullPage:true});
 }
 cases.push({mode,width,backing:packet.backing.status,clubSaved:backed?club:null});await page.close();console.log('PASS '+mode+' '+width+'px');
}assert.deepEqual(errors,[]);assert.deepEqual(external,[]);fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify({head,cases,errors,external,fixture:'independently invented chronological-savings-data',checks:'real App.boot; three Budget views and Plan Spend; calculator fallbacks forbidden; 320/390/1440px; keyboard/focus; unknown evidence; redraw immutability'},null,2)+'\n');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
