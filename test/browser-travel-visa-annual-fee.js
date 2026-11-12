'use strict';
// Real App.boot with an independently invented household. The real Forecast
// publishes the Travel Visa annual fee's yearly-bill funding row (verified
// in-process below, straight from the fixture input): the Budget Savings
// surfaces must not print it as a goal, must print one aggregate note per
// surface, and the Bills panel must show it once as an upcoming annual bill
// — visible under All, hidden under every status filter and any day filter.
// Publication figures are compared against the in-process Forecast packet,
// never against the renderers under test.
// node test/browser-travel-visa-annual-fee.js [installed-browser] [output]
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const cp = require('node:child_process'), crypto = require('node:crypto');
const { chromium } = require('playwright');
const F = require('../public/forecast');
const fixture = require('./fixtures/travel-visa-annual-fee-data');
const root = path.resolve(__dirname, '..');
const out = process.argv[3] || path.join(require('node:os').tmpdir(), 'atlas-travel-visa-annual-fee');
fs.mkdirSync(out, { recursive: true });
const head = cp.execFileSync('git', ['-c', 'safe.directory=' + root.replace(/\\/g, '/'), 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const FEE_KEY = 'yearly-bill:travelvisa-annual-fee-2027';

// Independent publication anchor: Forecast's own packet for the fixture.
const { input } = fixture('ready');
const published = F.savingsDailyFunding(input.plan, [], input.asOf, input.opts);
assert.equal(published.status, 'ready', 'fixture publication is ready');
const feeRow = published.rows.find(r => r.key === FEE_KEY);
assert.ok(feeRow, 'Forecast publishes the fee funding row (protection intact)');
assert.equal(feeRow.needed, 149);
const feeItem = [...published.backing.items, ...published.unresolved]
  .find(i => i.source === 'yearly-card-paid-bill' && i.id === 'travelvisa-annual-fee-2027');
assert.ok(feeItem, 'Forecast publishes the fee backing item by source + id');
assert.equal(feeItem.date, '2027-10-06');
assert.equal(feeItem.trust, 'estimated');
const proposalText = published.period.proposal.toFixed(2);

(async () => {
  const browser = await chromium.launch({ executablePath: process.argv[2] || process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], states = [];
  try {
    for (const mode of ['ready', 'no-fee']) {
      const { data } = fixture(mode);
      for (const width of [1440, 390, 320]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
        page.setDefaultTimeout(20000);
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== 'http://visa-fee.test') { external.push(url.origin); return route.abort(); }
          if (url.pathname === '/data.json') return route.fulfill({ json: data });
          if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
          const file = path.resolve(root, 'public', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
          if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
          return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
        });
        await page.goto('http://visa-fee.test/');
        await page.locator('[data-budget-surface]').waitFor();
        const card = page.locator('[data-budget-savings-goals]');
        const bills = page.locator('[data-budget-browse="bills"]');
        await card.waitFor(); await bills.waitFor();
        if (mode === 'ready') {
          // Saving-for card: fee absent, control present, one note.
          assert.equal(await card.locator(`[data-budget-savings-goal="${FEE_KEY}"]`).count(), 0, 'card: fee is not a savings goal');
          assert.equal(await card.locator('[data-budget-savings-goal="yearly-bill:home-cost"]').count(), 1, 'card: control yearly bill still prints');
          const cardHtml = await card.evaluate(el => el.innerHTML.split('<div data-budget-funding-savings')[0]);
          assert.equal((cardHtml.match(/data-budget-savings-annual-bill-note/g) || []).length, 0, 'card: no note on the card (display tidy-up)');
          assert.ok(!cardHtml.includes('Travel Visa annual fee is treated as a bill'), 'card: the sentence is absent from the card');
          // Bills roster: the blend tile keeps the roster in a sheet panel;
          // open it the way a user does, via the Bills detail toggle.
          assert.ok(await bills.locator('[data-budget-bill-open]').count() > 0, 'bills: native bill rows still print');
          await bills.locator('[data-blend-bills-open]').click();
          const sheetDialog = page.locator('[data-budget-detail-sheet]');
          await sheetDialog.waitFor({ state: 'visible' });
          const sheetBody = page.locator('[data-budget-detail-body]');
          const bucket = sheetBody.locator('[data-budget-bill-bucket="upcoming"]');
          assert.equal(await bucket.count(), 1, 'bills: upcoming bucket exists');
          assert.equal(await bucket.isVisible(), true, 'bills: upcoming bucket is visible under All');
          const bucketText = await bucket.innerText();
          // Systems Review 5484047605: the heading must be RENDERED, not
          // only present in the DOM — the roster skin hides native group
          // headings, so textContent alone proved nothing. Require a
          // visible heading with rendered innerText in both themes.
          const heading = bucket.locator('> h3');
          assert.equal(await heading.isVisible(), true, 'bills: upcoming heading is visible under All');
          assert.match(await heading.innerText(), /Upcoming annual bills/i,
            'bills: the bucket heading renders as visible text');
          for (const theme of ['dark', 'light']) {
            await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
            assert.equal(await heading.isVisible(), true, `bills: upcoming heading is visible in the ${theme} theme`);
            assert.match(await heading.innerText(), /Upcoming annual bills/i,
              `bills: the bucket heading renders as visible text in the ${theme} theme`);
          }
          await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
          // Regression (5484047605): the exception is scoped to the upcoming
          // bucket only — native roster group headings keep the sheet skin's
          // hidden behaviour.
          const nativeHeadings = sheetBody.locator('[data-budget-bill-bucket]:not([data-budget-bill-bucket="upcoming"]) > h3');
          assert.ok(await nativeHeadings.count() > 0, 'bills: native roster groups still print their headings in the DOM');
          for (let i = 0; i < await nativeHeadings.count(); i++) {
            assert.equal(await nativeHeadings.nth(i).isVisible(), false,
              'bills: native group headings stay hidden under the sheet skin');
          }
          assert.match(bucketText, /Travel Visa annual fee/);
          assert.match(bucketText, /149\.00/);
          assert.match(bucketText, /October 6, 2027/);
          assert.match(bucketText, /estimated/i);
          assert.equal(await bucket.locator('[data-budget-bill-open]').count(), 0, 'bills: the entry is plain markup, never a bill-open row');
          // Status filters hide the bucket; All restores it.
          for (const choice of ['paid', 'due', 'check']) {
            await sheetBody.locator(`[data-budget-bill-filter="${choice}"]`).click();
            assert.equal(await bucket.evaluate(el => el.hidden), true, `bills: upcoming bucket hides under the ${choice} filter`);
          }
          await sheetBody.locator('[data-budget-bill-filter="all"]').click();
          assert.equal(await bucket.evaluate(el => el.hidden), false, 'bills: upcoming bucket returns under All');
          assert.equal(await bucket.isVisible(), true, 'bills: upcoming bucket is visible again under All');
          // Day filter hides the bucket (its rows are not bill-open rows).
          await sheetBody.locator('[data-blend-bills-panel]').evaluate(panel => {
            panel.setAttribute('data-budget-bill-day', '2026-10-10');
            budgetApplyBillFilter(panel, 'all');
          });
          assert.equal(await bucket.evaluate(el => el.hidden), true, 'bills: upcoming bucket hides under a day filter');
          await sheetBody.locator('[data-blend-bills-panel]').evaluate(panel => {
            panel.removeAttribute('data-budget-bill-day');
            budgetApplyBillFilter(panel, 'all');
          });
          assert.equal(await bucket.evaluate(el => el.hidden), false, 'bills: upcoming bucket returns when the day filter clears');
          await sheetDialog.screenshot({ path: path.join(out, `bills-ready-${width}.png`), animations: 'disabled' });
          await page.keyboard.press('Escape');
          await card.screenshot({ path: path.join(out, `savings-ready-${width}.png`), animations: 'disabled' });
        } else {
          assert.equal(await card.locator(`[data-budget-savings-goal="${FEE_KEY}"]`).count(), 0, 'no-fee: no fee goal');
          assert.equal(await page.locator('[data-budget-savings-annual-bill-note], [data-savings-annual-bill-note]').count(), 0, 'no-fee: no note anywhere');
          assert.equal(await bills.locator('[data-budget-bill-bucket="upcoming"]').count(), 0, 'no-fee: no upcoming bucket');
          assert.equal(await card.locator('[data-budget-savings-goal="yearly-bill:home-cost"]').count(), 1, 'no-fee: control yearly bill still prints');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
        states.push({ mode, width });
        await page.close();
        console.log(`Verified ${mode} at ${width}px`);
      }
      // Savings detail sheet at desktop width (real sheet, real renderers).
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(20000);
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://visa-fee.test') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(root, 'public', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://visa-fee.test/');
      // On the current blend layout the savings operating question lives in
      // the hero sheet, not inside the calendar waterfall; its summary opens
      // the same daily-savings detail sheet.
      const summary = page.locator('[data-operating-question="savings"] > details > summary');
      await summary.waitFor();
      await summary.focus(); await page.keyboard.press('Enter');
      const dialog = page.locator('[data-budget-detail-sheet]'), body = page.locator('[data-budget-detail-body]');
      await dialog.waitFor({ state: 'visible' });
      if (mode === 'ready') {
        assert.equal(await body.locator(`[data-budget-savings-total-goal="${FEE_KEY}"]`).count(), 0, 'sheet: fee is not a savings row');
        assert.equal(await body.locator('[data-budget-savings-total-goal="yearly-bill:home-cost"]').count(), 1, 'sheet: control yearly bill still prints');
        assert.match(await body.locator('[data-budget-savings-total-goal="yearly-bill:home-cost"] [data-budget-savings-total-needed]').innerText(), /24\.00/);
        assert.equal(await body.locator('[data-budget-savings-annual-bill-note]').count(), 1, 'sheet: exactly one note in the detail list');
        assert.match(await body.locator('[data-budget-daily-proposal]').innerText(), new RegExp(proposalText.replace('.', '\\.')),
          'sheet: the published period proposal matches the in-process Forecast packet');
        const info = body.locator('[data-budget-savings-info] > summary');
        await info.focus(); await page.keyboard.press('Enter');
        const inventory = body.locator('.savings-inventory');
        assert.equal(await inventory.locator(`[data-savings-goal="${FEE_KEY}"]`).count(), 0, 'inventory: fee article is not printed');
        assert.equal(await inventory.locator('[data-savings-goal="yearly-bill:home-cost"]').count(), 1, 'inventory: control article still prints');
        assert.equal(await inventory.locator('[data-savings-annual-bill-note]').count(), 1, 'inventory: exactly one note');
      } else {
        assert.equal(await body.locator('[data-budget-savings-annual-bill-note], [data-savings-annual-bill-note]').count(), 0, 'no-fee sheet: no note');
      }
      await page.keyboard.press('Escape');
      await page.close();
      console.log(`Verified ${mode} savings sheet`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    fs.writeFileSync(path.join(out, 'browser-proof.json'), JSON.stringify({ head, synthetic: true,
      sourceHashEncoding: 'UTF-8 LF (git blob)',
      sources: { 'public/plan.js': hash('public/plan.js'), 'public/savings-inventory.js': hash('public/savings-inventory.js'),
        'public/budget-surface.css': hash('public/budget-surface.css'), 'public/budget-sheet-motion.css': hash('public/budget-sheet-motion.css'), 'public/forecast.js': hash('public/forecast.js'),
        'test/browser-travel-visa-annual-fee.js': hash('test/browser-travel-visa-annual-fee.js') },
      publishedFeeRow: { key: feeRow.key, needed: feeRow.needed, date: feeItem.date, trust: feeItem.trust },
      states }, null, 2) + '\n');
    console.log('PASS browser-travel-visa-annual-fee: real App.boot, fee excluded from Savings with per-surface notes, '
      + 'Upcoming annual bills visible under All and hidden under status/day filters, publication figures anchored in-process');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
