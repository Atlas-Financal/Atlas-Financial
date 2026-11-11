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
// #797 admits only a reported-balance estimate for the same-day cutoff
// ambiguity. The other independent holds still withhold the closing figure.
// #643 prints closing and period-funding holds in order, deduplicated.
const BACKING_HOLD = 'A savings movement lacks unique, qualified posted evidence. Balance-cutoff inclusion is unproven; bank backing and new contributions are withheld.';
const TRANSFER_HOLD = 'A pending or unmatched household transfer/cash movement remains encumbering.';
const PENDING_HOLD = 'Pending savings movement withholds backing and contributions; known posted stock is retained.';
const CUTOFF_HOLD = 'Reported balance cutoffs cannot establish inclusion of the savings movement. Bank backing and new contributions are withheld.';
const PERIOD_HOLD = 'This selected period has no qualified projected top-up.';
const CARD_HOLD = 'Confirm the card-coverage opening, transaction units and explicit purchase/payment links before using available cash.';
const HOLDS = {
  recognized: [], 'ordinary-transfer': [TRANSFER_HOLD, PERIOD_HOLD],
  pending: [PENDING_HOLD, PERIOD_HOLD], cutoff: [PERIOD_HOLD], 'card-coverage': [CARD_HOLD],
};
const BACKING_REASONS = { 'ordinary-transfer': BACKING_HOLD, pending: PENDING_HOLD, cutoff: CUTOFF_HOLD };
const ASSUMPTIONS = [
  'Starts from the reported Savings balance dated 2026-10-07.',
  'An unqualified Savings movement may or may not already be included in that reported balance.',
  'The current-period sweep counts proven household transfers only.',
];
const ESTIMATE_BASIS = 'Estimated from the reported Savings balance dated 2026-10-07. '
  + ASSUMPTIONS.join(' ') + ' Verified backing is withheld: ' + CUTOFF_HOLD;
async function step(page, direction) {
  const before = await page.locator('[data-budget-window-progress]').getAttribute('data-start');
  await page.locator('.river').focus(); await page.keyboard.press(direction > 0 ? 'ArrowRight' : 'ArrowLeft');
  await page.waitForFunction(start => document.querySelector('[data-budget-window-progress]')?.dataset.start !== start, before);
}
async function assertClose(page, tile, mode, expected) {
  const estimate = mode === 'cutoff', ready = mode === 'recognized' || estimate;
  assert.equal(await page.locator('[data-budget-window-progress]').getAttribute('data-start'), expected.start);
  assert.equal((await tile.locator('[data-budget-savings-forecast-stock]').innerText()).replace(/\s+/g, ' '),
    'Savings at period close: ' + (estimate ? '≈ estimated ' + expected.printed : ready ? expected.printed : 'Unavailable') + '.',
    `${mode} ${expected.start}: exact independently pinned closing figure or withheld state`);
  const basis = tile.locator('[data-budget-savings-estimate-basis]');
  assert.equal(await basis.count(), estimate ? 1 : 0, 'only the cutoff-ambiguous case gets an estimate basis');
  if (estimate) {
    assert.ok(await basis.isVisible(), 'estimate qualification is visible beside the closing figure');
    assert.equal(await basis.innerText(), ESTIMATE_BASIS, 'the dated basis keeps every assumption and the withheld backing reason');
  }
  // The producer is the subject under test, never the expected-money oracle.
  // A projected close cannot become actual Saved or permission to move money.
  const facts = await page.evaluate(start => {
    const d = App.data;
    const advice = Forecast.recommend(d.plan, d.meta.asOf,
      { ...d.plan.defaults, ...d.liveOverlay, weeklyVariable: 0, debts: d.debts || [] });
    const period = advice.payPeriodViews.find(p => p.start === start);
    const packet = Forecast.savingsFundingPublication(advice.savingsFunding,
      { asOf: d.meta.asOf, advice, periodId: period.id });
    const close = packet.forecastClosing;
    return { stock: close.stock, status: close.status, trust: close.trust,
      actualSaved: close.actualSaved, draws: close.projectedDraws,
      action: close.actionPermission, movement: close.moneyMovementPermission,
      nature: close.nature, balanceAsOf: close.balanceAsOf, assumptions: close.assumptions, verifiedReason: close.verifiedReason,
      selectedBackingStatus: packet.backing.status,
      backingStatus: advice.savingsFunding.backing.status,
      backingReason: advice.savingsFunding.backing.status === 'unavailable' ? advice.savingsFunding.backing.reason : null,
      actualTransferred: packet.backing.actualTransferred,
      periodStatus: advice.savingsFunding.period.status, proposal: advice.savingsFunding.period.proposal };
  }, expected.start);
  assert.equal(facts.actualSaved, null, 'projected stock is never actual Saved');
  assert.equal(facts.action, 'not-granted'); assert.equal(facts.movement, 'not-granted');
  assert.equal(facts.actualTransferred, null, 'reported stock never proves a transfer');
  assert.equal(facts.selectedBackingStatus, 'unavailable', 'a projected period never borrows actual current backing');
  assert.equal(facts.backingStatus, BACKING_REASONS[mode] ? 'unavailable' : 'ready');
  assert.equal(facts.backingReason, BACKING_REASONS[mode] || null, 'recipient, pending and cutoff backing gates retain their specific reason');
  if (ready) {
    assert.equal(facts.stock, expected.stock, 'published close matches the independent hand ledger');
    assert.equal(facts.status, 'ready'); assert.equal(facts.trust, 'estimated');
    assert.equal(facts.draws, 0, 'historical card debit is not a new goal draw');
    assert.equal(facts.nature, estimate ? 'reported-balance-estimate' : 'if-eligible-surplus-saved');
  } else {
    assert.equal(facts.stock, null, 'withheld evidence never fabricates a zero closing stock');
    assert.equal(facts.status, 'unavailable'); assert.equal(facts.trust, 'unknown');
  }
  if (mode !== 'recognized') {
    assert.equal(facts.periodStatus, 'unavailable', 'a closing estimate never enables a current funding proposal');
    assert.equal(facts.proposal, null, 'withheld proposal never becomes a real zero or transfer instruction');
  }
  if (estimate) {
    assert.equal(facts.balanceAsOf, '2026-10-07');
    assert.deepEqual(facts.assumptions, ASSUMPTIONS);
    assert.equal(facts.verifiedReason, CUTOFF_HOLD);
  }
  return facts;
}
async function assertEvidence(dialog, mode, expected) {
  const inventoryNode = dialog.locator('[data-savings-inventory]');
  const inventory = await inventoryNode.innerText();
  const reasons = await dialog.locator('[data-budget-savings-info] > div > p').allInnerTexts();
  // The later clean close has no matching qualified top-up for its complete
  // Oct 30–Nov 12 window. #643 keeps that independent hold even though the
  // projected Savings close itself is ready; it cannot silently disappear.
  const expectedHolds = mode === 'recognized' && expected.start === '2026-10-30' ? [PERIOD_HOLD] : HOLDS[mode];
  assert.deepEqual(reasons, expectedHolds, `${mode}: exact ordered independent holds, with no lost or duplicate reason`);
  const estimate = mode === 'cutoff';
  const basis = inventoryNode.locator('[data-savings-closing-estimate]');
  assert.equal(await basis.count(), estimate ? 1 : 0);
  if (estimate) {
    assert.ok(await basis.isVisible(), 'inventory estimate explanation is visible');
    assert.equal(await basis.innerText(), ESTIMATE_BASIS);
    assert.equal(await inventoryNode.locator(':scope > p').first().innerText(),
      'Savings at period close: ≈ ' + expected.printed + ' (estimated).', 'inventory figure keeps its own estimate mark');
  } else if (mode !== 'recognized') assert.match(inventory, /Savings at period close: Unknown\./);
  return { inventory, reasons };
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
      if (mode === 'recognized') { assert.match(next, /1,119\.00/); assert.doesNotMatch(next, /Savings at period close: Unavailable/); }
      else if (mode !== 'cutoff') assert.match(next, /Savings at period close: Unavailable/);
      // Existing sheet opener is keyboard-accessible. This does not claim phone
      // pointer acceptance of the separate tile affordance.
      await (async t => { const p = t.locator('.blend-goals-panel'); if (await p.count() && !(await p.evaluate(n => n.open))) await t.locator('.blend-tile-head').click(); })(tile); // Refined face: Accounts & evidence opens from the savings detail.
      await tile.locator('[data-budget-funding-inventory]').focus(); await page.keyboard.press('Enter');
      const dialog = page.locator('[data-budget-detail-sheet]'); await dialog.waitFor({ state: 'visible' });
      const info = dialog.locator('[data-budget-savings-info] > summary');
      if (!await info.evaluate(n => n.parentElement.open)) await info.click();
      const { inventory, reasons } = await assertEvidence(dialog, mode, CLOSES[0]);
      if (mode === 'recognized') assert.match(inventory, /1,119\.00/);
      await dialog.screenshot({ path: path.join(out, mode + '-' + width + '.png'), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await step(page, 1); const afterSweep = await tile.innerText();
      const secondFacts = await assertClose(page, tile, mode, CLOSES[1]);
      await (async t => { const p = t.locator('.blend-goals-panel'); if (await p.count() && !(await p.evaluate(n => n.open))) await t.locator('.blend-tile-head').click(); })(tile); // Refined face: Accounts & evidence opens from the savings detail.
      await tile.locator('[data-budget-funding-inventory]').focus(); await page.keyboard.press('Enter');
      await dialog.waitFor({ state: 'visible' });
      if (!await info.evaluate(n => n.parentElement.open)) await info.click();
      const { inventory: laterInventory, reasons: laterReasons } = await assertEvidence(dialog, mode, CLOSES[1]);
      if (mode === 'recognized') assert.match(laterInventory, /Savings at period close: \$1,199\.00\./);
      await page.keyboard.press('Escape');
      await step(page, -1); assert.equal(await tile.innerText(), next);
      await step(page, -1); assert.equal(await tile.innerText(), current);
      await step(page, 1); assert.equal(await tile.innerText(), next);
      await page.evaluate(() => App.rerender()); assert.equal(await tile.innerText(), next);
      assert.equal(await page.evaluate(() => JSON.stringify(App.data)), original);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      cases.push({ width, mode, next, inventory, reasons, afterSweep, laterInventory, laterReasons, firstFacts, secondFacts, replay: true, immutable: true });
      console.log('PASS ' + mode + ' ' + width); await page.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ synthetic: true,
    head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    served, cases, errors, external, writes }, null, 2) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
