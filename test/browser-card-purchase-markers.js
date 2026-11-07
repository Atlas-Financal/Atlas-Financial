'use strict';
// Full-page, intercepted synthetic data only. Optional Playwright dependency;
// use CHROME_PATH for an installed browser and NODE_PATH for external tooling.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require('playwright');
const Live = require('../scripts/live-plan');
const fixture = require('./fixtures/card-purchase-coverage-data');
const root = path.join(__dirname, '..');
const screenshots = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR || path.join(os.tmpdir(), 'atlas-card-purchase-markers');
fs.mkdirSync(screenshots, { recursive: true });
function served(stage) {
  const cutover = stage.startsWith('cutover');
  const x = fixture((stage.startsWith('carry') && stage !== 'carry-current')
    || (cutover && !['cutover-observed', 'cutover-same-day'].includes(stage))
    ? 'before' : ['partial', 'full', 'ambiguous'].includes(stage) ? 'backfill' : 'purchase');
  if (cutover) {
    x.data.plan.cardPurchaseCoverage.opening.asOf = '2026-09-19';
    x.payload.transactionWindow.startDate = '2026-09-19';
    x.data.plan.cardPurchaseCoverage.opening.purchases = [{ ref: 'synthetic-mid-cutover',
      accountId: 'travelvisa', date: '2026-09-18', amount: 21.37,
      covered: stage === 'cutover-covered' ? 21.37 : 0, categoryLabel: 'Groceries' }];
    if (stage === 'cutover-unknown') x.data.plan.cardPurchaseCoverage.opening.confirmed = false;
    if (['cutover-observed', 'cutover-same-day'].includes(stage)) {
      x.payload.transactionWindow.startDate = '2026-09-18';
      x.payload.transactions[0].date = stage === 'cutover-observed' ? '2026-09-18' : '2026-09-19';
      x.data.plan.cardPurchaseCoverage.opening.purchases = stage === 'cutover-observed' ? [{
        ref: fixture.ref(x, 80001), accountId: 'travelvisa', date: '2026-09-18',
        amount: 80, covered: 0, categoryLabel: 'Groceries' }] : [];
    }
    if (stage === 'cutover-history') {
      x.asOf = '2026-10-03';
      x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
      x.payload.transactionWindow.endDate = x.asOf;
      x.payload.accounts.forEach(a => { a.updated_at = x.asOf + 'T17:00:00Z'; });
    }
  }
  if (stage.startsWith('carry')) {
    x.data.plan.cardPurchaseCoverage.opening.purchases = [{ ref: 'synthetic-opening-only',
      accountId: 'travelvisa', date: '2026-09-10', amount: 30, covered: stage === 'carry-covered' ? 30 : 0,
      categoryLabel: 'Groceries' }];
    if (stage === 'carry-unknown') x.data.plan.cardPurchaseCoverage.opening.confirmed = false;
  }
  if (stage === 'unknown') delete x.data.plan.cardPurchaseCoverage;
  if (stage === 'pending') x.payload.transactions[0].is_pending = true;
  if (['partial', 'full', 'ambiguous'].includes(stage)) {
    const payment = stage === 'partial' ? 12.10 : 41.35;
    x.payload.transactions[0].amount = 41.35;
    x.payload.transactions[1].amount = payment; x.payload.transactions[2].amount = -payment;
    x.payload.accounts[0].balance = 500 - payment; x.payload.accounts[3].balance = 441.35 - payment;
    if (stage !== 'ambiguous') fixture.confirm(x, 'synthetic-confirmed-purpose', 80002, 80003, [[80001, payment]]);
  }
  const data = Live.fromObservation(x).data;
  data.meta.title = 'Synthetic card purchase markers';
  return data;
}
async function openGroceries(page) {
  const trigger = page.locator('[data-blend-cat="groceries"]');
  await trigger.scrollIntoViewIfNeeded();
  assert.equal(await trigger.isVisible(), true, 'Groceries category opener is visible');
  await trigger.focus(); await page.keyboard.press('Enter');
  await page.locator('[data-budget-detail-sheet][open]').waitFor();
  const category = page.locator('[data-budget-detail-body] [data-budget-category="groceries"]');
  assert.equal(await category.count(), 1, 'the category ring opens only the intended Groceries detail');
  assert.equal(await category.isVisible(), true, 'Groceries detail is visible in the open sheet');
  return trigger;
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [];
  try {
    for (const [width, colorScheme] of [[1440, 'light'], [390, 'light'], [320, 'light'], [390, 'dark']]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme, reducedMotion: 'reduce' });
      let data = served('purchase');
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') return route.abort();
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css'
          : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      for (const stage of ['purchase', 'partial', 'full', 'unknown', 'ambiguous', 'pending']) {
        data = served(stage);
        await page.goto('http://budget.test/');
        await page.locator('[data-budget-surface]').waitFor();
        const trigger = await openGroceries(page);
        const row = page.locator('[data-budget-detail-body] .household-budget-tx');
        assert.equal(await row.count(), 1, 'purchase remains one existing category row');
        assert.match(await row.innerText(), /Invented grocer/);
        assert.equal(await row.locator('svg[aria-hidden="true"]').count(), 1, 'visible card icon has a textual equivalent');
        const expected = stage === 'full' ? 'resolved' : ['unknown', 'ambiguous'].includes(stage) ? 'unconfirmed' : 'awaiting-coverage';
        assert.equal(await row.getAttribute('data-card-coverage'), expected);
        assert.equal(await row.evaluate(el => el.classList.contains('is-card-coverage-open')), stage !== 'full');
        assert.match(await row.innerText(), stage === 'partial' ? /29\.25 still to cover/ : stage === 'full'
          ? /Coverage resolved/ : ['unknown', 'ambiguous'].includes(stage) ? /Coverage unconfirmed/ : /80\.00 still to cover/);
        if (stage === 'pending') assert.match(await row.innerText(), /Pending/);
        const bounds = await row.evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth }));
        assert.ok(bounds.scroll <= bounds.width + 1, 'card transaction fits the existing sheet');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(screenshots, `${stage}-${width}-${colorScheme}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'keyboard focus returns to category');
        assert.doesNotMatch(await page.locator('body').innerText(), /Card purchases to cover/);
      }
      for (const stage of ['carry', 'carry-current', 'carry-unknown', 'carry-covered']) {
        data = served(stage);
        await page.goto('http://budget.test/');
        await page.locator('[data-budget-surface]').waitFor();
        const trigger = page.locator('[data-budget-browse-evidence="04"]');
        await trigger.focus(); await page.keyboard.press('Enter');
        const sheet = page.locator('[data-budget-detail-body]');
        const carry = sheet.locator('[data-card-earlier-periods]');
        if (stage === 'carry-covered') {
          assert.equal(await carry.count(), 0);
        } else {
          assert.equal(await carry.count(), 1);
          const bills = carry.locator('xpath=ancestor::details[1]');
          if (await bills.count() && !(await bills.evaluate(el => el.open))) {
            await bills.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
          }
          await carry.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
          assert.equal(await carry.evaluate(el => el.open), true);
          assert.match(await carry.innerText(), stage !== 'carry-unknown' ? /30\.00 still to cover/ : /Coverage unconfirmed/);
          if (stage !== 'carry-unknown') {
            assert.match(await carry.innerText(), /2026-09-10/);
            assert.match(await carry.innerText(), /Groceries/);
            assert.doesNotMatch(await carry.innerText(), /80\.00/);
          }
          else assert.doesNotMatch(await carry.innerText(), /30\.00|still to cover/);
          assert.ok(await carry.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(screenshots, `${stage}-${width}-${colorScheme}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
        if (stage === 'carry-current') {
          const category = await openGroceries(page);
          const row = page.locator('[data-budget-detail-body] .household-budget-tx');
          assert.equal(await row.count(), 1);
          assert.match(await row.innerText(), /80\.00 still to cover/);
          await page.keyboard.press('Escape');
          assert.equal(await category.evaluate(el => el === document.activeElement), true, 'keyboard focus returns to category');
        }
      }
      for (const stage of ['cutover', 'cutover-covered', 'cutover-unknown', 'cutover-observed', 'cutover-same-day', 'cutover-history']) {
        data = served(stage);
        await page.goto('http://budget.test/');
        await page.locator('[data-budget-surface]').waitFor();
        const trigger = page.locator('[data-budget-browse-evidence="04"]');
        await trigger.focus(); await page.keyboard.press('Enter');
        const carry = page.locator('[data-budget-detail-body] [data-card-earlier-periods]');
        const excluded = ['cutover-covered', 'cutover-observed', 'cutover-same-day'].includes(stage);
        assert.equal(await carry.count(), excluded ? 0 : 1);
        if (!excluded) {
          await carry.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
          assert.equal(await carry.evaluate(el => el.open), true);
          if (stage === 'cutover-unknown') {
            assert.match(await carry.innerText(), /Coverage unconfirmed/);
            assert.doesNotMatch(await carry.innerText(), /21\.37|still to cover/);
          } else {
            assert.match(await carry.innerText(), /2026-09-18/);
            assert.match(await carry.innerText(), /Groceries/);
            assert.match(await carry.innerText(), /21\.37 still to cover/);
          }
          assert.ok(await carry.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(screenshots, `${stage}-${width}-${colorScheme}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
        if (['cutover-observed', 'cutover-same-day'].includes(stage)) {
          const category = await openGroceries(page);
          const row = page.locator('[data-budget-detail-body] .household-budget-tx');
          assert.equal(await row.count(), 1);
          assert.match(await row.innerText(), /80\.00 still to cover/);
          await page.keyboard.press('Escape');
          assert.equal(await category.evaluate(el => el === document.activeElement), true, 'keyboard focus returns to category');
        }
      }
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', cases: 64, widths: [1440, 390, 320], themes: ['light', 'dark'], screenshots }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
