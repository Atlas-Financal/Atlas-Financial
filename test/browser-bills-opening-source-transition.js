'use strict';
const { applyPlanKnobsAfterWiring, planKnobsInitSource } = require('./browser-plan-knobs');
// #728: real App.boot/recomputation, synthetic source packets, no server/provider.
// NODE_PATH=<approved Playwright modules> CHROME_PATH=<Chromium executable>
// node test/browser-bills-opening-source-transition.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { chromium } = require('playwright');
const fixture = require('./fixtures/savings-daily-consumer-data');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'public');
const origin = 'http://bills-source.test';
const output = process.env.ATLAS_BILLS_SOURCE_PROOF
  || fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bills-source-'));
const started = Date.now();
const receipt = {
  executionHead: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  testSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  node: process.version, syntheticOnly: true, checks: 0, failures: [], observations: [],
  pageErrors: [], external: [], mutations: [],
};
fs.mkdirSync(output, { recursive: true });
function check(label, verify) {
  receipt.checks++;
  try { verify(); } catch (error) {
    receipt.failures.push({ label, message: error.message });
    console.error('FAIL ' + label + ': ' + error.message);
  }
}
const states = [
  { name: 'known', amount: 200, proposal: 80 },
  { name: 'absent', amount: null, proposal: null },
  { name: 'null', amount: null, proposal: null },
  { name: 'empty', amount: null, proposal: null },
  { name: 'zero', amount: 0 }, // Known zero alone does not qualify every funding claim.
  { name: 'restored', amount: 200, proposal: 80 },
];
function packet(state) {
  const data = fixture('ready');
  const rows = [data.plan.startingCash.breakdown, data.liveOverlay.observedCash.accounts];
  for (const list of rows) {
    const index = list.findIndex(row => row.id === 'chequing-a');
    assert.notEqual(index, -1, 'fixture contains the Bills source row');
    if (state.name === 'absent') list.splice(index, 1);
    else list[index].value = state.name === 'empty' ? '' : state.amount;
  }
  // Only the two Bills source rows may vary; all dates, Weekly, reserves,
  // transactions, and independent policy/settlement evidence remain intact.
  const withoutBills = value => {
    const copy = structuredClone(value);
    copy.plan.startingCash.breakdown = copy.plan.startingCash.breakdown.filter(row => row.id !== 'chequing-a');
    copy.liveOverlay.observedCash.accounts = copy.liveOverlay.observedCash.accounts.filter(row => row.id !== 'chequing-a');
    return copy;
  };
  assert.deepEqual(withoutBills(data), withoutBills(fixture('ready')));
  assert.equal(data.meta.asOf, '2026-10-05');
  return data;
}
// Independent oracle from the unchanged fixture's invented ledger:
// Bills 200 - household remaining (80 - 20 spent) - bill 40 - floor 20 = 80.
// Independently reported Savings 95 + 24 = 119; Weekly is evidenced numeric 0.
const oracle = fixture('ready');
assert.deepEqual(oracle.plan.startingCash.breakdown.map(row => [row.id, row.value]),
  [['chequing-a', 200], ['chequing-b', 0], ['savings', 95]]);
assert.deepEqual(oracle.plan.savingsPoolObservation.accounts.map(row => row.value), [95, 24]);

async function visibleText(locator, label) {
  await locator.waitFor({ state: 'visible' });
  const visible = await locator.isVisible() && await locator.evaluate(element => {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0
        || node.classList.contains('blend-clip')) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  check(label + ' is visibly rendered', () => assert.equal(visible, true));
  return (await locator.innerText()).trim();
}
async function inspect(page, state, width, phase, includeDetail = true) {
  const label = width + 'px ' + state.name + ' ' + phase;
  let hero;
  if (phase === 'next-period') {
    // budget-blend.css deliberately hides today's balance on a noncurrent
    // selection. Check that actual display rule, then the visible value on Back.
    hero = 'hidden on noncurrent period';
    const shown = await page.locator('[data-budget-cash-hero]').isVisible();
    const display = await page.locator('[data-budget-today-cash]').evaluate(element => getComputedStyle(element).display);
    check(label + ' current balance stays off the future face', () => assert.equal(shown, false));
    check(label + ' current balance container is display none', () => assert.equal(display, 'none'));
  } else {
    hero = await visibleText(page.locator('[data-budget-cash-hero]'), label + ' Current Balance');
    check(label + ' Bills amount', () => assert.equal(hero,
      state.amount === null ? 'Unavailable' : '$' + state.amount.toFixed(2)));
  }
  // budget-blend moves this native row from the waterfall into the visible hub.
  const savingsSummary = page.locator('[data-operating-question="savings"] > details > summary').first();
  const savings = await visibleText(savingsSummary.locator('.budget-step-value'), label + ' Savings');
  check(label + ' independent Savings remains 119', () => assert.match(savings, /\$119\.00/));
  // Reveal the actual Savings goals disclosure before reading its Today lens.
  const goalsPanel = page.locator('.blend-goals-panel');
  const goalsHeader = page.locator('[data-budget-savings-goals] .blend-tile-head');
  if (!await goalsPanel.evaluate(element => element.open)) await goalsHeader.click();
  const todayTab = page.locator('[data-budget-funding-tab="today"]');
  await todayTab.click();
  const proposal = await visibleText(page.locator('[data-budget-funding-panel="today"] [data-budget-funding-proposal]'), label + ' current contribution');
  if (state.proposal === null) {
    check(label + ' dependent contribution is unavailable', () => assert.equal(proposal, 'Unavailable'));
  } else if (state.proposal === 80) {
    check(label + ' established contribution is 80', () => assert.match(proposal, /\$80\.00/));
  }
  await goalsHeader.click();
  // Today stays a current-position lens even when next period is selected.
  // Open the Savings detail only in the current period, where it is daily.
  if (includeDetail) {
    await savingsSummary.click();
    const dialog = page.locator('[data-budget-detail-sheet]');
    await dialog.waitFor({ state: 'visible' });
    const daily = await visibleText(dialog.locator('[data-budget-daily-proposal]'), label + ' daily contribution');
    if (state.proposal === null) check(label + ' daily contribution is unavailable', () => assert.equal(daily, 'Unavailable'));
    else if (state.proposal === 80) check(label + ' daily contribution is 80', () => assert.match(daily, /\$80\.00/));
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }
  receipt.observations.push({ width, state: state.name, phase, hero, savings, proposal });
}
const settle = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function stepPeriod(page, key, before) {
  // The current visible period control; native window-step buttons are parked.
  await page.locator('.river').focus();
  await page.keyboard.press(key);
  await page.waitForFunction(previous => document.querySelector('[data-pay-period-swipe]')
    ?.getAttribute('data-selected-pay-period') !== previous, before);
  await settle(page);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  receipt.browser = browser.version();
  try {
    for (const width of [1440, 390, 320]) {
      let data = packet(states[0]);
      const context = await browser.newContext({ viewport: { width, height: 1000 },
        reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (!['GET', 'HEAD'].includes(request.method())) {
          receipt.mutations.push({ method: request.method(), path: url.pathname });
          return route.abort();
        }
        if (url.origin !== origin) { receipt.external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css'
          : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.png') ? 'image/png'
            : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => receipt.pageErrors.push(error.message));
      await page.addInitScript(applyPlanKnobsAfterWiring, { weeklyVariable: 40 });
      await page.goto(origin + '/');
      await page.locator('[data-budget-cash-hero]').waitFor();
      await settle(page);
      const currentId = await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
      for (const state of states) {
        data = packet(state);
        const unchanged = await page.evaluate(next => {
          App.data.plan = next.plan; App.data.liveOverlay = next.liveOverlay;
          const before = JSON.stringify(App.data);
          App.rerender(); // Native renderPlan -> Forecast.recommend -> visible consumer.
          return JSON.stringify(App.data) === before;
        }, data);
        await settle(page);
        check(width + 'px ' + state.name + ' recomputation does not mutate inputs', () => assert.equal(unchanged, true));
        await inspect(page, state, width, 'refresh');
        // A second paint with the same source detects stale render/cache reuse.
        await page.evaluate(() => App.rerender());
        await settle(page);
        await inspect(page, state, width, 'repeat');
        await stepPeriod(page, 'ArrowRight', currentId);
        const nextId = await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
        check(width + 'px ' + state.name + ' selected period changes', () => assert.notEqual(nextId, currentId));
        await inspect(page, state, width, 'next-period', false);
        await stepPeriod(page, 'ArrowLeft', nextId);
        const backId = await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
        check(width + 'px ' + state.name + ' returns to current period', () => assert.equal(backId, currentId));
        await inspect(page, state, width, 'back');
        await page.reload(); // App.boot fetches this same source packet afresh.
        await settle(page);
        await inspect(page, state, width, 'reload');
        await page.locator('[data-budget-today-cash]').screenshot({ path: path.join(output, state.name + '-' + width + '.png') });
        console.log('Checked ' + width + 'px ' + state.name + ': refresh, repeat, next/back, reload');
      }
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => {
  receipt.failures.push({ label: 'browser execution', message: error.stack || error.message });
  console.error(error);
}).finally(() => {
  check('all six source states complete five lifecycle checkpoints at three widths', () => assert.equal(receipt.observations.length, 90));
  check('no page errors', () => assert.deepEqual(receipt.pageErrors, []));
  check('no external requests', () => assert.deepEqual(receipt.external, []));
  check('no mutation requests', () => assert.deepEqual(receipt.mutations, []));
  receipt.elapsedMs = Date.now() - started;
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(receipt, null, 2));
  console.log((receipt.failures.length ? 'FAIL' : 'PASS') + ' Bills source transition: '
    + receipt.checks + ' checks, ' + receipt.failures.length + ' failures, '
    + receipt.observations.length + ' visible states, ' + receipt.elapsedMs + 'ms; proof ' + output);
  process.exitCode = receipt.failures.length ? 1 : 0;
});
