'use strict';
const { applyPlanKnobsAfterWiring, planKnobsInitSource } = require('./browser-plan-knobs');
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
 await page.addInitScript(applyPlanKnobsAfterWiring,{weeklyVariable:40});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!=='http://one-pot.test'){external.push(u.origin);return route.abort();}
  if(u.pathname==='/data.json')return route.fulfill({json:data});
  if(['/periods.json','/balance-history.json','/running-build.json'].includes(u.pathname))return route.fulfill({json:null});
  const file=path.resolve(assets,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(assets+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
  let body=fs.readFileSync(file);if(u.pathname==='/forecast.js')body=Buffer.concat([body,Buffer.from(`\n{const native=Forecast.recommend;Forecast.recommend=(...args)=>{const a=native(...args);window.__advice=a;window.__packet=a.savingsFunding;return a;};Forecast.savingsDailyFunding=()=>{throw Error('Forbidden page daily calculator fallback');};Forecast.savingsFundingTimeline=()=>{throw Error('Forbidden page timeline calculator fallback');};}\n`)]);
  return route.fulfill({body,contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html'});
 });
 await page.goto('http://one-pot.test/?view=classic');const summary=page.locator('[data-operating-question="savings"] > details > summary');await summary.waitFor();
 const packet=await page.evaluate(()=>window.__packet);assert.equal(packet.source,'Forecast.savingsDailyFunding');
 const backed=['ready','deposit','settled'].includes(mode),club=mode==='deposit'?105:95;
 assert.equal(packet.backing.status,backed?'ready':'unavailable');
 // Latest reported balances allocate Saved even when dated or pending (#595,
 // owner policy 2026-10-12): Saved follows goalAllocation, payment backing does not.
 const allocated=['ready','deposit','settled','stale','pending'].includes(mode);
 assert.equal(packet.goalAllocation.status,allocated?'ready':'unavailable');
 assert.ok(packet.backing.items.some(r=>r.id==='trip'),'unlinked requirement beyond short view survives');
 if(mode==='settled')assert.ok(!packet.backing.items.some(r=>r.id==='near'));
 const original=await page.evaluate(()=>JSON.stringify(App.data));
 const group=page.locator('[data-budget-savings-goals] [data-budget-savings-goal="group:club"] .budget-goal-amount').first();
 assert.match(await group.innerText(),allocated?new RegExp(club+'\\.00'):/Unavailable/);
 // The old funding-proposal panel left the live page (52acaa77, owner decision
 // 2026-11-11). Each backed item's Saved is read on the visible Savings goals
 // card instead: its member row in a group, else its own goal row.
 assert.equal(await page.locator('[data-budget-funding-section], [data-budget-funding-panel], [data-budget-funding-tab]').count(),0,'removed funding-proposal panel stays off the page');
 for(const item of packet.backing.items){const owner=packet.rows.filter(r=>(r.members||[]).some(m=>(m&&m.key||m)===item.key));assert.equal(owner.length,1,item.key+' has one goal row');
  const member=page.locator('[data-budget-savings-goals] .budget-goal-member[data-budget-savings-member="'+item.key+'"]');
  const cell=owner[0].members.length>1?member.locator('[data-budget-savings-member-saved]'):page.locator('[data-budget-savings-goals] [data-budget-savings-goal="'+owner[0].key+'"] .budget-goal-amount').first();
  if(owner[0].members.length>1)assert.equal(await member.count(),1);else assert.equal(await member.count(),0);
  assert.ok(await cell.isVisible(),item.key+' Saved is visible');
  assert.match(await cell.innerText(),item.saved==null?/Unavailable/:new RegExp(item.saved.toFixed(2).replace('.','\\.')));
 }
 await summary.focus();await page.keyboard.press('Enter');const dialog=page.locator('[data-budget-detail-sheet]'),body=page.locator('[data-budget-detail-body]');await dialog.waitFor({state:'visible'});
 assert.match(await body.locator('[data-budget-savings-total-goal="group:club"] [data-budget-savings-total-saved]').innerText(),allocated?new RegExp(club+'\\.00'):/Unavailable/);
 if(mode==='ready')await dialog.screenshot({path:path.join(output,'chronological-savings-detail-'+width+'.png')});
 await page.keyboard.press('Escape');assert.ok(await summary.evaluate(e=>e===document.activeElement),'focus restored to Savings trigger');
 const goal=page.locator('[data-budget-savings-goals] [data-budget-goal-open="group:club"]');await goal.focus();await page.keyboard.press('Enter');await dialog.waitFor({state:'visible'});await page.keyboard.press('Escape');assert.ok(await goal.evaluate(e=>e===document.activeElement),'goal sheet restores focus');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px/page width overflow');
 if(mode==='ready'||mode==='missing'&&width===320){await page.locator('[data-budget-savings-goals]').screenshot({path:path.join(output,'chronological-savings-'+mode+'-'+width+'.png')});}
 assert.equal(await page.evaluate(()=>JSON.stringify(App.data)),original,'inputs not mutated');
 const before=packet.rows.map(r=>[r.key,r.saved]);await page.evaluate(()=>App.rerender());await summary.waitFor();assert.deepEqual(await page.evaluate(()=>window.__packet.rows.map(r=>[r.key,r.saved])),before,'redraw replaces allocation');
 if(mode==='ready'){
  // The native chooser is hidden on the blend face; the visible period
  // control is the river (keyboard: ArrowRight), which keeps focus on remount.
  assert.equal(await page.locator('[data-budget-window-choose]').first().isVisible(),false);
  const rangeBefore=await page.locator('[data-budget-window-range]').first().textContent();
  const river=page.locator('.river');await river.focus();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(previous=>document.querySelector('[data-budget-window-range]')?.textContent!==previous,rangeBefore);
  await page.waitForFunction(()=>document.activeElement?.classList.contains('river'));
  assert.ok(await page.locator('.river').evaluate(e=>e===document.activeElement&&e.getBoundingClientRect().height>8),'period control restores visible focus');
  // Since #610 (2026-10-14) a projected period whose closing Savings has a
  // funding gap publishes no named Saved/top-up rows; it states the gap.
  const goalsCard=page.locator('[data-budget-savings-goals]');
  assert.equal(await goalsCard.locator('[data-budget-savings-goal]').count(),0,'future actual saving is not printed');
  const futureText=await goalsCard.innerText();
  assert.match(futureText,/Savings at period close: Unavailable\./,'future close stays unknown');
  assert.match(futureText,/Funding gap on 2026-10-29: \$\d[\d,]*\.\d\d\./,'future funding gap is stated');
  assert.match(futureText,/Named savings unavailable\./);
  assert.doesNotMatch(futureText,/calculated\s*\$[\d,]+\.\d\d\s*Saved/,'no future Saved figure is presented as calculated');
  const futureSummary=page.locator('[data-operating-question="savings"] > details > summary');
  await futureSummary.focus();await page.keyboard.press('Enter');await dialog.waitFor({state:'visible'});
  assert.equal(await body.locator('[data-budget-savings-total-goal]').count(),0,'future detail prints no named Saved');
  assert.match(await body.innerText(),/Named savings unavailable\./);
  await page.keyboard.press('Escape');assert.ok(await futureSummary.evaluate(e=>e===document.activeElement));
  if(width===320)await page.locator('[data-budget-savings-goals]').screenshot({path:path.join(output,'chronological-savings-future-320.png')});
  assert.ok(await page.evaluate(()=>window.__packet.schedule===window.__advice.planSpendPaydayFunding),'Forecast schedule alias matches the packet');
 }
 cases.push({mode,width,backing:packet.backing.status,goalAllocation:packet.goalAllocation.status,clubSaved:allocated?club:null});await page.close();console.log('PASS '+mode+' '+width+'px');
}assert.deepEqual(errors,[]);assert.deepEqual(external,[]);fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify({head,cases,errors,external,fixture:'independently invented chronological-savings-data',checks:'real App.boot; three Budget views; calculator fallbacks forbidden; 320/390/1440px; keyboard/focus; unknown evidence; redraw immutability'},null,2)+'\n');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
