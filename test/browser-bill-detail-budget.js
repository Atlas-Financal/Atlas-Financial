'use strict';
// Full Budget document/App.boot/Forecast/BudgetPolish with synthetic packets.
// Static local transport; this does not exercise auth or a deployed provider.
// NODE_PATH=<playwright modules> CHROME_PATH=<chromium> node test/browser-bill-detail-budget.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { fixture, cardObservation } = require('./test-bill-detail');
const root = path.join(__dirname, '..', 'public');
function servedFixture() {
  return { accounts: [], ...fixture(), meta: { asOf: '2026-08-20', title: 'Synthetic bill evidence review' } };
}

(async () => {
  let data = servedFixture(), browser;
  const errors = [], external = [], writes = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (['/data.json', '/periods.json', '/balance-history.json'].includes(pathname)) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(pathname === '/data.json' ? data : null));
    }
    const file = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
    for (const width of [1440, 390, 320]) {
      data = servedFixture();
      const context = await browser.newContext({ viewport: { width, height: 900 },
        hasTouch: width < 400, isMobile: width < 400, reducedMotion: 'reduce',
        colorScheme: width === 320 ? 'dark' : 'light' });
      await context.route('**/*', route => {
        if (route.request().method() !== 'GET') writes.push(route.request().method());
        if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      const load = async () => {
        await page.goto(base + '/?view=classic');
        await page.locator('[data-pay-period-swipe]').waitFor();
        await page.waitForFunction(() => typeof BillDetail !== 'undefined' && App.data &&
          document.querySelector('[data-period-bill="bill"][data-atlas-bill-row]'));
      };
      const tap = async locator => width < 400 ? locator.tap() : locator.click();
      // The Bills step opens the detail sheet (a modal dialog) holding the
      // period's bill roster; a roster row opens that bill's detail in a nested
      // sheet with its evidence disclosure already open. Escape closes both.
      const sheet = page.locator('[data-budget-detail-sheet]');
      const sheetOpen = () => sheet.evaluate(el => el.open);
      const bill = () => sheet.locator('[data-bill-detail] [data-period-bill="bill"]').first();
      const details = () => sheet.locator('[data-bill-detail]');
      const paymentBody = () => details().locator('.bill-detail-body');
      // The blend face folds the published bill facts into a closed
      // "Published bill evidence" disclosure; open it, then read the whole body.
      const readBill = async () => {
        const published = details().locator('.blend-bill-published');
        if (!(await published.evaluate(el => el.open))) await tap(published.locator(':scope > summary'));
        return paymentBody().innerText();
      };
      const openBills = async () => {
        if (!(await sheetOpen())) await tap(page.locator('[data-operating-question="04"] .budget-step-summary'));
        assert.equal(await sheetOpen(), true);
      };
      const openBill = async () => {
        await openBills();
        if (!(await details().isVisible())) await tap(sheet.locator('[data-budget-bill-open="bill"]'));
        await details().waitFor({ state: 'visible' });
      };
      const closeSheet = async () => {
        if (await sheetOpen()) await page.keyboard.press('Escape');
        assert.equal(await sheetOpen(), false);
      };
      // The visible period control is the river slider; the native wheels are
      // hidden and selected through it (budget-blend.js).
      const river = async key => {
        await closeSheet();
        await page.locator('.river').focus();
        await page.keyboard.press(key);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForTimeout(500);
      };
      const snapshot = () => page.evaluate(() => JSON.stringify({ data: App.data,
        advice: Forecast.recommend(App.data.plan, App.data.meta.asOf, simOpts({
          fundingSources: App.data.plan.funding && App.data.plan.funding.options,
          periods: App.periods, currentPeriodActuals: App.data.liveOverlay.currentPeriodActuals,
          operatingPlan: App.data.liveOverlay.operatingPlan, observedCash: App.data.liveOverlay.observedCash,
          operatingPlanNote: App.data.liveOverlay.operatingPlanNote,
        })) }));
      await load();
      const baseline = await snapshot();
      assert.equal(await sheetOpen(), false);
      await openBill();
      // Partly-paid PR (Grok rule 17, rule 1): the invented 97.50 payment is below the 100 plan, so the line reads Partly paid (not PAID).
      assert.equal(await bill().getAttribute('data-bill-status'), 'partly paid');
      assert.equal(await bill().getAttribute('data-bill-date'), '2026-08-19');
      assert.match(await bill().locator('[data-atlas-bill-state="to-pay"]').textContent(), /^Partly paid$/);
      assert.match(await bill().locator('.blend-bill-summary-amount').innerText(), /^−\$97\.50$/);
      assert.ok((await bill().boundingBox()).height >= 44);
      assert.equal(await details().evaluate(el => el.open), true,
        'the bill sheet opens with its payment evidence disclosed');
      assert.equal(await sheet.evaluate(el => el.contains(document.activeElement)), true);
      const printed = await readBill();
      for (const value of ['2026-08-19', '2026-08-18', '$100.00', '$97.50', '$0.00', 'Synthetic bills account', 'Posted']) assert.ok(printed.includes(value), value);
      // Back returns to the roster with focus on the row that opened the bill.
      await sheet.locator('[data-budget-detail-back]').click();
      assert.equal(await details().isVisible(), false);
      assert.equal(await sheet.locator('[data-budget-bill-open="bill"]')
        .evaluate(el => el === document.activeElement), true);
      await openBill();
      // Closing the whole sheet and reopening keeps every fact; nothing toggles
      // a Forecast publication.
      await closeSheet();
      await openBill();
      assert.equal(await details().evaluate(el => el.open), true);
      assert.equal(await snapshot(), baseline);
      // The disclosure itself still dismisses by touch/click on its row.
      await tap(bill());
      assert.equal(await details().evaluate(el => el.open), false, 'touch/click dismissal');

      // Real river keyboard selection, next period then back.
      await river('ArrowRight');
      await openBill();
      assert.equal(await bill().getAttribute('data-bill-date'), '2026-09-02');
      assert.doesNotMatch(await readBill(), /Transaction date|2026-08-18/);
      assert.match(await readBill(), /Missing evidence does not mean unpaid/);
      await river('ArrowLeft');
      await openBill();
      assert.equal(await bill().getAttribute('data-bill-date'), '2026-08-19');
      assert.match(await readBill(), /2026-08-18/);
      assert.equal(await snapshot(), baseline, 'navigation leaves all Forecast publications unchanged');

      // Actual rerender closes old bill DOM and takes the current served packet.
      await page.evaluate(() => App.rerender());
      await page.waitForTimeout(300);
      await closeSheet();
      await openBill();
      assert.match(await readBill(), /2026-08-18/);
      for (const change of [
        p => { p.representedActuals = []; },
        p => { p.observationAsOf = '2026-08-19'; },
        p => { p.transactions[0].date = '2026-02-30'; },
        p => { p.transactions.push({ ...p.transactions[0], amount: 99 }); },
        p => { p.representedActuals.push({ ...p.representedActuals[0], id: 'another-bill' }); },
      ]) {
        data = servedFixture(); change(data.liveOverlay.currentPeriodActuals);
        await load();
        assert.equal(await sheetOpen(), false, 'refresh removes previously opened evidence');
        await openBill();
        assert.match(await readBill(), /Transaction evidence is unavailable/);
        assert.doesNotMatch(await readBill(), /Transaction date|Transaction amount/);
      }

      data = servedFixture(); data.liveOverlay.currentPeriodActuals.transactions[0].pending = true;
      await load(); await openBill();
      assert.match(await readBill(), /Pending — not a posted payment/);
      assert.equal(await bill().getAttribute('data-bill-status'), 'partly paid', 'transaction state does not re-decide Forecast status');

      data = servedFixture();
      const hostile = '<img src=x onerror="window.hacked=true">' + 'Long label '.repeat(18);
      Object.assign(data.liveOverlay.currentPeriodActuals.transactions[0], {
        payee: hostile, notes: 'PRIVATE NOTES', providerTransactionId: 'PRIVATE PROVIDER ID',
      });
      await load(); await openBill();
      assert.doesNotMatch(await readBill(), /PRIVATE|Long label|tx-1/);
      // Hostile plain row text through the actual Budget printers: the bill's own
      // label and payer come from the served packet, not transaction evidence.
      data = servedFixture();
      data.plan.bills.find(row => row.id === 'bill').label = hostile;
      await load(); await openBill();
      assert.equal(await details().locator('img,script').count(), 0);
      assert.equal(await details().locator('svg').evaluateAll(nodes =>
        nodes.every(node => node.closest('.blend-bill-symbol[aria-hidden="true"]'))), true,
      'only the decorative bill symbol may carry an svg');
      assert.equal(await page.evaluate(() => window.hacked === true), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (width < 400) {
        const summaryBox = await bill().boundingBox(), labelBox = await bill().locator('.blend-bill-summary-label').boundingBox();
        assert.ok(labelBox.width >= summaryBox.width * 0.4, 'phone label keeps room alongside the badge and amount');
      }
      const output = process.env.ATLAS_BILL_EVIDENCE_SCREENSHOTS;
      if (output) { fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, `budget-bill-${width}.png`), fullPage: true }); }

      // Actual route navigation back to Budget gets a fresh packet.
      await page.goto('about:blank');
      await page.waitForURL('about:blank');
      data = servedFixture(); data.liveOverlay.currentPeriodActuals.representedActuals = [];
      await page.goto(base + '/?view=classic');
      await page.waitForURL(base + '/?view=classic');
      assert.equal(await page.locator('.sitenav, .sitenav-household').count(), 0);
      await page.locator('[data-pay-period-swipe]').waitFor();
      await openBill();
      assert.doesNotMatch(await readBill(), /Transaction date|2026-08-18/);

      data = servedFixture(); data.liveOverlay.operatingPlan = 'unavailable';
      data.liveOverlay.operatingPlanNote = 'Synthetic failed advancing observation';
      await page.goto(base + '/?view=classic');
      await page.locator('#operating-surface-body [data-operating-plan="unavailable"]').first().waitFor();
      assert.equal(await page.locator('#operating-surface-body [data-bill-detail]').count(), 0);
      assert.doesNotMatch(await page.locator('#operating-surface-body').innerText(), /Transaction date|2026-08-18/);
      data = servedFixture(); await load(); await openBill();
      assert.match(await readBill(), /2026-08-18/);
      if (output) {
        await page.screenshot({ path: path.join(output, `budget-normal-${width}.png`) });
      }
      // Real sanitized card-payment pipeline, preserving every signed leg.
      for (const mode of ['posted', 'split', 'unknown', 'pending', 'refund', 'reversal']) {
        data = { accounts: [], ...cardObservation(mode) };
        await load(); await openBill();
        const before = await snapshot();
        const printed = await readBill();
        if (['posted', 'split', 'unknown'].includes(mode)) {
          assert.match(printed, mode === 'split' ? /\u2212\$125\.00 \(credit\)/ : /\u2212\$250\.00 \(credit\)/);
          assert.match(printed, /Actual\s+\u2212\$250\.00/);
          assert.match(printed, /sign alone does not identify a payment, refund or reversal/);
          // A posted provider payment is a calculated actual: Forecast's
          // displayAmountTrust is 'calculated', so the row prints it bare, not "about".
          assert.equal(await bill().getAttribute('data-bill-status'), 'PAID');
          assert.equal(await bill().locator('.blend-bill-summary-amount').innerText(), '−$250.00');
          if (mode === 'split') assert.equal((printed.match(/\(credit\)/g) || []).length, 2);
        } else {
          assert.match(printed, /Transaction evidence is unavailable/);
          assert.doesNotMatch(printed, /Transaction amount|\(credit\)/);
        }
        assert.doesNotMatch(printed, /Synthetic private note|8101|8102|8002/);
        assert.equal(await snapshot(), before);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      // Signed evidence never trusts a direction/type hint. Zero is unknown;
      // a pending linked credit is explicitly not a posted payment.
      for (const [amount, pending, direction] of [[250, false, 'debit'], [0, false, 'direction unavailable'], [-250, true, 'credit']]) {
        data = { accounts: [], ...cardObservation() };
        Object.assign(data.liveOverlay.currentPeriodActuals.transactions[0], { amount, pending,
          kindHint: '<img src=x onerror="window.hacked=true">', direction: '<svg onload=bad>', notes: 'PRIVATE SIGN NOTE' });
        await load(); await openBill();
        const printed = await readBill();
        assert.ok(printed.includes(`${amount < 0 ? '−$250.00' : amount > 0 ? '$250.00' : '$0.00'} (${direction})`));
        assert.match(printed, /Actual\s+\u2212\$250\.00/);
        if (pending) assert.match(printed, /Pending — not a posted payment/);
        assert.doesNotMatch(printed, /PRIVATE|onerror|onload/);
        assert.equal(await details().locator('img,script').count(), 0);
        assert.equal(await details().locator('svg').evaluateAll(nodes =>
          nodes.every(node => node.closest('.blend-bill-symbol[aria-hidden="true"]'))), true);
        assert.equal(await page.evaluate(() => window.hacked === true), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await context.close();
      console.log(`PASS integrated Budget bill evidence: ${width}px, detail-sheet keyboard/touch, badges, nested bill sheet, refresh/navigation, period identity, signed debit/credit, pending/split/refund/reversal, unavailable and hostile evidence`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
