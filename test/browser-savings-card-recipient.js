'use strict';
// Real browser consumers, intercepted invented GETs only. Source flags come
// from the actual observer, then enter an independently qualified fixture ledger.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { source } = require('./fixtures/savings-card-recipient-data');
const future = require('./fixtures/savings-future-closing-data'), shell = require('./fixtures/savings-daily-consumer-data');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'public');
const out = process.env.ATLAS_CARD_BROWSER_PROOF || path.join(require('node:os').tmpdir(), 'atlas-card-recipient-proof');
fs.mkdirSync(out, { recursive: true });
const cases = [], served = {}, errors = [], external = [], writes = [];
// Independent invented ledger. #616 moves a period's sweep to the following
// payday: the Oct 16 receipt stays in Bills at the Oct 29 close, leaving the
// reported Savings119 unchanged. At the Nov 12 close, #620's full remainder
// has landed: inherited Bills80 + receipt1000 =1080; Savings119+1080=1199.
// The historical7.25 card debit is already in reported stock, never deducted
// again or attributed as a new Savings transfer. No goal is due in either view.
const CLOSES = [
  { start: '2026-10-16', stock: 119, printed: '$119.00' },
  { start: '2026-10-30', stock: 1199, printed: '$1,199.00' },
];
async function step(page, direction) {
  const before = await page.locator('[data-budget-window-progress]').getAttribute('data-start');
  await page.locator('.river').focus(); await page.keyboard.press(direction > 0 ? 'ArrowRight' : 'ArrowLeft');
  await page.waitForFunction(start => document.querySelector('[data-budget-window-progress]')?.dataset.start !== start, before);
}
async function assertClose(page, tile, mode, expected) {
  assert.equal(await page.locator('[data-budget-window-progress]').getAttribute('data-start'), expected.start);
  assert.equal(await tile.locator('[data-budget-savings-forecast-stock]').innerText(),
    'Savings at period close: ' + (mode === 'recognized' ? expected.printed : 'Unavailable') + '.',
    `${mode} ${expected.start}: exact independently pinned closing figure or withheld state`);
  // The producer is the subject under test, never the expected-money oracle.
  // A projected close cannot become actual Saved or permission to move money.
  const facts = await page.evaluate(start => {
    const d = App.data;
    const advice = Forecast.recommend(d.plan, d.meta.asOf,
      { ...d.plan.defaults, ...d.liveOverlay, weeklyVariable: 0, debts: d.debts || [] });
    const period = advice.payPeriodViews.find(p => p.start === start);
    const close = Forecast.savingsFundingPublication(advice.savingsFunding,
      { asOf: d.meta.asOf, advice, periodId: period.id }).forecastClosing;
    return { stock: close.stock, status: close.status, trust: close.trust,
      actualSaved: close.actualSaved, draws: close.projectedDraws,
      action: close.actionPermission, movement: close.moneyMovementPermission };
  }, expected.start);
  assert.equal(facts.actualSaved, null, 'projected stock is never actual Saved');
  assert.equal(facts.action, 'not-granted'); assert.equal(facts.movement, 'not-granted');
  if (mode === 'recognized') {
    assert.equal(facts.stock, expected.stock, 'published close matches the independent hand ledger');
    assert.equal(facts.status, 'ready'); assert.equal(facts.trust, 'estimated');
    assert.equal(facts.draws, 0, 'historical card debit is not a new goal draw');
  } else {
    assert.equal(facts.stock, null, 'withheld evidence never fabricates a zero closing stock');
    assert.equal(facts.status, 'unavailable'); assert.equal(facts.trust, 'unknown');
  }
  return facts;
}
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const width of [390, 1440]) for (const mode of ['recognized', 'ordinary-transfer', 'pending', 'cutoff', 'card-coverage']) {
      const observed = source(mode === 'ordinary-transfer' || mode === 'pending' ? mode : 'recognized');
      const x = future(), data = shell();
      const row = JSON.parse(JSON.stringify(observed.report.currentPeriodActuals.transactions[0]));
      if (mode === 'cutoff') row.date = x.asOf;
      x.opts.currentPeriodActuals.transactions.push(row);
      if (mode === 'card-coverage') x.opts.currentPeriodActuals.cardCoverageRequired = true;
      data.plan = x.plan; data.meta.asOf = x.asOf; data.debts = x.opts.debts || [];
      data.liveOverlay = { applied: true, operatingPlan: 'live', ...x.opts,
        observedCash: { asOf: x.asOf, complete: true, accounts: x.plan.startingCash.breakdown
          .filter(r => r.id.startsWith('chequing')).map(r => ({ ...r, evidenceDate: x.asOf })) } };
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      await page.addInitScript(() => localStorage.setItem('hfd-plan-knobs-v1', JSON.stringify({ weeklyVariable: 0 })));
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://savings-card.test') { external.push(u.origin); return route.abort(); }
        if (route.request().method() !== 'GET') { writes.push(route.request().method()); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(assets, '.' + (u.pathname === '/' ? '/index.html' : u.pathname));
        if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        const body = fs.readFileSync(file);
        served[path.relative(root, file).replaceAll('\\', '/')] = crypto.createHash('sha256').update(body).digest('hex');
        return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://savings-card.test/'); const tile = page.locator('[data-budget-savings-goals]');
      await tile.waitFor(); const current = await tile.innerText(), original = await page.evaluate(() => JSON.stringify(App.data));
      await step(page, 1); const next = await tile.innerText();
      const firstFacts = await assertClose(page, tile, mode, CLOSES[0]);
      if (mode === 'recognized') { assert.match(next, /Savings at period close: \$119\.00\./); assert.doesNotMatch(next, /Savings at period close: Unavailable/); }
      else assert.match(next, /Savings at period close: Unavailable/);
      // Existing sheet opener is keyboard-accessible. This does not claim phone
      // pointer acceptance of the separate tile affordance.
      await tile.locator('[data-budget-funding-inventory]').focus(); await page.keyboard.press('Enter');
      const dialog = page.locator('[data-budget-detail-sheet]'); await dialog.waitFor({ state: 'visible' });
      const info = dialog.locator('[data-budget-savings-info] > summary');
      if (!await info.evaluate(n => n.parentElement.open)) await info.click();
      const inventory = await dialog.locator('[data-savings-inventory]').innerText();
      const explanation = dialog.locator('[data-budget-savings-info] > div > p').first();
      const reason = await explanation.count() ? await explanation.innerText() : null;
      if (mode === 'recognized') assert.match(inventory, /Savings at period close: \$119\.00\./);
      if (mode === 'ordinary-transfer') assert.match(reason, /^A savings movement lacks unique, qualified posted evidence/);
      if (mode === 'pending') assert.match(reason, /^Pending savings movement/);
      if (mode === 'cutoff') assert.match(reason, /^Reported balance cutoffs cannot establish inclusion/);
      if (mode === 'card-coverage') assert.doesNotMatch(reason, /A savings movement lacks unique, qualified posted evidence/);
      await dialog.screenshot({ path: path.join(out, mode + '-' + width + '.png'), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await step(page, 1); const afterSweep = await tile.innerText();
      const secondFacts = await assertClose(page, tile, mode, CLOSES[1]);
      await tile.locator('[data-budget-funding-inventory]').focus(); await page.keyboard.press('Enter');
      await dialog.waitFor({ state: 'visible' });
      if (!await info.evaluate(n => n.parentElement.open)) await info.click();
      const laterInventory = await dialog.locator('[data-savings-inventory]').innerText();
      if (mode === 'recognized') assert.match(laterInventory, /Savings at period close: \$1,199\.00\./);
      else assert.match(laterInventory, /Savings at period close: Unknown\./);
      await page.keyboard.press('Escape');
      await step(page, -1); assert.equal(await tile.innerText(), next);
      await step(page, -1); assert.equal(await tile.innerText(), current);
      await step(page, 1); assert.equal(await tile.innerText(), next);
      await page.evaluate(() => App.rerender()); assert.equal(await tile.innerText(), next);
      assert.equal(await page.evaluate(() => JSON.stringify(App.data)), original);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      cases.push({ width, mode, next, inventory, reason, afterSweep, laterInventory, firstFacts, secondFacts, replay: true, immutable: true });
      console.log('PASS ' + mode + ' ' + width); await page.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ synthetic: true,
    head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    served, cases, errors, external, writes }, null, 2) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
