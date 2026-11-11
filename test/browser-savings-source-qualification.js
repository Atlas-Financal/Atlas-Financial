'use strict';
const { applyPlanKnobsAfterWiring, planKnobsInitSource } = require('./browser-plan-knobs');
// Optional #723 real-browser acceptance. Synthetic source observations only.
// Reserve observations cross provider-observe; the fixture's independently
// proven operating ledger is retained, as in source-qualification-acceptance.
// This is NOT server-cache, live-provider or household acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const O = require(path.join(root, 'scripts/provider-observe'));
const fx = require('./fixtures/savings-v2-observation-data');
const output = process.env.ATLAS_SOURCE_QUALIFICATION_PROOF || path.join(os.tmpdir(), 'atlas-savings-source-qualification');
const DATE_HOLD = 'Both savings accounts require current, clear CAD cents evidence.';
const CARD_HOLD = 'Card payment sent; cash inclusion or issuer minimum satisfaction is unconfirmed. Additional cash is unknown.';
const starts = ['2026-10-02', '2026-10-16', '2026-10-30', '2026-10-02'];
const labels = ['Oct 2\u2013Oct 15', 'Oct 16\u2013Oct 29', 'Oct 30\u2013Nov 12', 'Oct 2\u2013Oct 15'];
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const proof = { executionHead: head, syntheticOnly: true, serverCacheAcceptance: false,
  householdAcceptance: false, cases: [], external: [], writes: [], pageErrors: [] };

function generation(stale, card) {
  const input = fx.input(card ? 'sender-unknown' : 'valid-v2');
  const stamp = stale ? '2026-10-04T19:00:00Z' : '2026-10-05T19:00:00Z';
  input.payload.accounts.slice(2).forEach(row => { row.balance_last_update = stamp; });
  const before = JSON.stringify(input);
  const report = O.observe({ provider: 'lunchmoney', ...input });
  eq(JSON.stringify(input), before, 'observer preserves source dates and source ledger');
  const data = { ...input.data, plan: { ...input.data.plan, savingsPoolObservation: report.savingsPools } };
  return { input, report, data };
}

async function navigate(page, start, direction) {
  await page.locator('.river').focus();
  // Actual keyboard period selection, without invoking App or the renderer.
  for (let n = 0; n < (direction === -2 ? 2 : 1); n++) {
    const prior = await page.locator('[data-budget-window-progress]').getAttribute('data-start');
    await page.keyboard.press(direction < 0 ? 'ArrowLeft' : 'ArrowRight');
    await page.waitForFunction(value => document.querySelector('[data-budget-window-progress]')?.dataset.start !== value, prior);
  }
  eq(await page.locator('[data-budget-window-progress]').getAttribute('data-start'), start, 'exact selected period');
}

async function packet(page) {
  return page.evaluate(() => {
    const d = App.data;
    const advice = Forecast.recommend(d.plan, d.meta.asOf,
      { ...d.plan.defaults, ...d.liveOverlay, weeklyVariable: 40, debts: d.debts || [] });
    const start = document.querySelector('[data-budget-window-progress]').dataset.start;
    const period = advice.payPeriodViews.find(row => row.start === start);
    return { inventory: advice.savingsInventory, card: advice.cardMinimumPayments,
      currentBacking: advice.savingsFunding.backing,
      publication: Forecast.savingsFundingPublication(advice.savingsFunding,
        { asOf: d.meta.asOf, advice, periodId: period.id }) };
  });
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  proof.browserVersion = browser.version();
  try {
    // Paired generations differ ONLY in reserve dates; the card sent-payment
    // evidence and all balances remain byte-identical. Positive control rules
    // out a generic unavailable renderer masquerading as this acceptance.
    const old = generation(true, true), current = generation(false, true);
    eq(old.data.plan.obligations, current.data.plan.obligations, 'date correction cannot resolve card evidence');
    eq(old.data.liveOverlay, current.data.liveOverlay, 'same independent operating evidence');
    for (const width of [1440, 390, 320]) for (const [mode, x] of [
      ['stale-reserve-card-held', old], ['current-reserve-card-held', current],
      ['current-reserve-clear-control', generation(false, false)],
    ]) {
      const stale = mode.startsWith('stale'), held = mode.endsWith('held');
      const row = { mode, viewport: { width, height: 1000 }, selections: [] };
      proof.cases.push(row);
      const sourceBefore = JSON.stringify(x), dataBefore = JSON.stringify(x.data);
      const page = await browser.newPage({ viewport: row.viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
      page.setDefaultTimeout(10000);
      await page.addInitScript(applyPlanKnobsAfterWiring, { weeklyVariable: 40 });
      page.on('pageerror', error => proof.pageErrors.push(error.message));
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== 'http://source-qualification.test') { proof.external.push(url.origin); return route.abort(); }
        if (request.method() !== 'GET') { proof.writes.push(request.method() + ' ' + url.pathname); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: x.data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(root, 'public', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'text/javascript'
          : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      try {
        await page.goto('http://source-qualification.test/');
        const tile = page.locator('[data-budget-savings-goals]'); await tile.waitFor();
        eq(await page.evaluate(() => innerWidth), width, 'true CSS viewport');
        let initial;
        for (let i = 0; i < starts.length; i++) {
          if (i) await navigate(page, starts[i], i === 3 ? -2 : 1);
          eq((await tile.locator('.budget-surface-eyebrow').first().innerText()).toLowerCase(), labels[i].toLowerCase(), 'visible selected-period label');
          const p = await packet(page), published = p.publication;
          // Frozen expectations from the independent fixture contract, not UI.
          eq(p.inventory.reportedStock.amount, 119, '9500 + 2400 posted cents survive both holds');
          eq(p.inventory.observedStock.amount, stale ? null : 119, 'reserve qualification is independent');
          // Selected future backing follows the withheld closing packet;
          // qualification of today's observed reserves belongs to currentBacking.
          eq(p.currentBacking.status, stale ? 'unavailable' : 'ready', 'date correction qualifies current backing only');
          if (stale) eq(p.currentBacking.reason, DATE_HOLD, 'precise reserve hold');
          eq(published.moneyMovementPermission, 'not-granted', 'no movement permission');
          eq(published.actionPermission, 'not-granted', 'no action permission');
          if (held) {
            eq(p.card.status, 'unavailable', 'unresolved card payment survives reserve correction');
            eq(published.period.status, 'unavailable', 'funding held');
            eq(published.period.reason, CARD_HOLD, 'precise independent card hold');
            eq(published.period.proposal, null, 'unknown proposal is not zero');
            if (i === 1 || i === 2) {
              eq(published.forecastClosing.status, 'unavailable', 'future close withheld');
              eq(published.forecastClosing.reason, stale ? DATE_HOLD : CARD_HOLD, 'closing priority retains separate holds');
              for (const key of ['stock', 'actualSaved', 'contribution', 'projectedContributions', 'projectedDraws'])
                eq(published.forecastClosing[key] ?? null, null, key + ' withheld');
              eq(published.forecastClosing.trust, 'unknown', 'unavailable close retains unknown trust');
              eq(await tile.locator('[data-budget-savings-forecast-stock]').innerText(),
                'Savings at period close: Unavailable.', 'visible close is unavailable, not zero');
            }
          } else if (i === 0 || i === 3) {
            // 200 cash - (80 groceries - 20 spent) - 40 bill - 20 buffer.
            eq(published.period.proposal, 80, 'independent positive control: 200 - 60 - 40 - 20');
          }
          const snapshot = await tile.innerText();
          if (i === 0) initial = snapshot;
          if (i === 3) eq(snapshot, initial, 'return to current restores the exact original surface');
          await (async t => { const p = t.locator('.blend-goals-panel'); if (await p.count() && !(await p.evaluate(n => n.open))) await t.locator('.blend-tile-head').click(); })(tile); // Refined face: Accounts & evidence opens from the savings detail.
          await tile.locator('[data-budget-funding-inventory]').click();
          const dialog = page.locator('[data-budget-detail-sheet]'); await dialog.waitFor({ state: 'visible' });
          const info = dialog.locator('[data-budget-savings-info]');
          if (!await info.evaluate(el => el.open)) await info.locator(':scope > summary').click();
          const text = await info.innerText();
          if (held) {
            eq(await dialog.locator('[data-budget-daily-proposal]').innerText(), 'Unavailable', 'visible proposal withheld');
            eq(text.includes(CARD_HOLD), true, 'card reason reachable through native Info');
            eq(text.includes(DATE_HOLD), stale, 'reserve hold disappears only when reserves qualify');
          } else if (i === 0 || i === 3) {
            assert.match(await dialog.locator('[data-budget-daily-proposal]').innerText(), /\$80\.00/); checks++;
          }
          if (i === 0 || i === 3) {
            const stock = page.locator('[data-operating-question="savings"] > details > summary');
            eq(await stock.locator('.budget-step-value').innerText(), '$119.00', 'known current stock stays visible');
            eq(await stock.locator('[data-budget-savings-observed-date]').innerText(),
              'Observed ' + (stale ? '2026-10-04' : '2026-10-05'), 'actual evidence date, not fetch date');
          }
          await dialog.screenshot({ path: path.join(output, mode + '-' + width + '-' + i + '.png'), animations: 'disabled' });
          await page.keyboard.press('Escape');
          eq(await tile.locator('[data-budget-funding-inventory]').evaluate(el => document.activeElement === el), true, 'focus restored');
          eq(await page.evaluate(() => JSON.stringify(App.data)), dataBefore, 'browser input unchanged');
          eq(JSON.stringify(x), sourceBefore, 'source generation unchanged');
          eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
          row.selections.push({ start: starts[i], publication: published, infoText: text });
        }
        console.log('PASS source qualification ' + mode + ' ' + width + ': current -> two future periods -> current');
      } finally { await page.close(); }
    }
    eq(proof.external, [], 'zero external requests'); eq(proof.writes, [], 'zero network writes');
    eq(proof.pageErrors, [], 'zero unexpected page errors');
    console.log('PASS source qualification: ' + proof.cases.length + ' cases / ' + checks + ' assertions; browser ' + proof.browserVersion);
  } catch (error) { proof.failure = error.stack; throw error; }
  finally {
    proof.checks = checks;
    fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
