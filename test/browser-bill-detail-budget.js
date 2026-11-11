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
        await page.goto(base);
        await page.locator('[data-pay-period-swipe]').waitFor();
        await page.waitForFunction(() => typeof BillDetail !== 'undefined' && App.data &&
          document.querySelector('[data-period-bill="bill"][data-atlas-bill-row]'));
      };
      const tap = async locator => width < 400 ? locator.tap() : locator.click();
      const bill = () => page.locator('[data-pay-period-swipe] [data-calendar-waterfall] [data-period-bill="bill"]').first();
      const details = () => bill().locator('..');
      const outer = () => page.locator('[data-pay-period-swipe] [data-calendar-waterfall] [data-operating-question="04"] > details');
      const openBills = async () => {
        if (!(await outer().evaluate(el => el.open))) await tap(outer().locator(':scope > summary'));
      };
      const snapshot = () => page.evaluate(() => JSON.stringify({ data: App.data,
        advice: Forecast.recommend(App.data.plan, App.data.meta.asOf, simOpts({
          fundingSources: App.data.plan.funding && App.data.plan.funding.options,
          periods: App.periods, currentPeriodActuals: App.data.liveOverlay.currentPeriodActuals,
          operatingPlan: App.data.liveOverlay.operatingPlan, observedCash: App.data.liveOverlay.observedCash,
          operatingPlanNote: App.data.liveOverlay.operatingPlanNote,
        })) }));
      const paymentBody = () => details().locator('.bill-detail-body');
      await load();
      const baseline = await snapshot();
      await openBills();
      assert.equal(await details().evaluate(el => el.open), false);
      assert.equal(await bill().getAttribute('data-bill-status'), 'PAID');
      assert.equal(await bill().getAttribute('data-bill-date'), '2026-08-19');
      assert.equal(await bill().locator('[data-atlas-bill-state="paid"]').innerText(), 'PAID');
      assert.match(await bill().locator(':scope > span:last-child').innerText(), /about −\$97.50/);
      assert.ok((await bill().boundingBox()).height >= 44);
      await bill().focus();
      await page.keyboard.press('Enter');
      assert.equal(await details().evaluate(el => el.open), true);
      assert.equal(await bill().evaluate(el => el === document.activeElement), true);
      const printed = await paymentBody().innerText();
      for (const value of ['2026-08-19', '2026-08-18', '$100.00', '$97.50', '$0.00', 'Synthetic bills account', 'Posted']) assert.ok(printed.includes(value), value);
      await page.keyboard.press('Space');
      await page.waitForFunction(() => !document.querySelector('[data-pay-period-swipe] [data-bill-detail]').open);
      await tap(bill());
      assert.equal(await details().evaluate(el => el.open), true);
      // Parent disclosure toggling does not toggle the child or move facts.
      await tap(outer().locator(':scope > summary'));
      assert.equal(await outer().evaluate(el => el.open), false);
      await openBills();
      assert.equal(await details().evaluate(el => el.open), true);
      assert.equal(await snapshot(), baseline);
      await tap(bill());
      assert.equal(await details().evaluate(el => el.open), false, 'touch/click dismissal');

      // Real pay-period wheel keyboard handler and touch/click selection.
      const wheel = () => page.locator('[data-budget-wheel="period"]');
      await wheel().locator('[aria-current="true"]').focus();
      await page.keyboard.press('ArrowRight');
      await openBills();
      assert.equal(await bill().getAttribute('data-bill-date'), '2026-09-02');
      assert.equal(await details().evaluate(el => el.open), false);
      await tap(bill());
      assert.doesNotMatch(await paymentBody().innerText(), /Transaction date|2026-08-18/);
      assert.match(await paymentBody().innerText(), /Missing evidence does not mean unpaid/);
      const selectedIndex = Number(await wheel().locator('[aria-current="true"]').getAttribute('data-wheel-index'));
      await tap(wheel().locator(`[data-wheel-index="${selectedIndex - 1}"]`));
      await openBills();
      assert.equal(await bill().getAttribute('data-bill-date'), '2026-08-19');
      assert.equal(await details().evaluate(el => el.open), false);
      await tap(bill());
      assert.match(await paymentBody().innerText(), /2026-08-18/);
      assert.equal(await snapshot(), baseline, 'navigation leaves all Forecast publications unchanged');

      // Actual rerender closes old bill DOM and takes the current served packet.
      await page.evaluate(() => App.rerender());
      await openBills();
      assert.equal(await details().evaluate(el => el.open), false);
      await tap(bill());
      assert.match(await paymentBody().innerText(), /2026-08-18/);
      for (const change of [
        p => { p.representedActuals = []; },
        p => { p.observationAsOf = '2026-08-19'; },
        p => { p.transactions[0].date = '2026-02-30'; },
        p => { p.transactions.push({ ...p.transactions[0], amount: 99 }); },
        p => { p.representedActuals.push({ ...p.representedActuals[0], id: 'another-bill' }); },
      ]) {
        data = servedFixture(); change(data.liveOverlay.currentPeriodActuals);
        await load(); await openBills();
        assert.equal(await details().evaluate(el => el.open), false, 'refresh removes previously opened evidence');
        await tap(bill());
        assert.match(await paymentBody().innerText(), /Transaction evidence is unavailable/);
        assert.doesNotMatch(await paymentBody().innerText(), /Transaction date|Transaction amount/);
      }

      data = servedFixture(); data.liveOverlay.currentPeriodActuals.transactions[0].pending = true;
      await load(); await openBills(); await tap(bill());
      assert.match(await paymentBody().innerText(), /Pending — not a posted payment/);
      assert.equal(await bill().getAttribute('data-bill-status'), 'PAID', 'transaction state does not re-decide Forecast status');

      data = servedFixture();
      const hostile = '<img src=x onerror="window.hacked=true">' + 'Long label '.repeat(18);
      Object.assign(data.liveOverlay.currentPeriodActuals.transactions[0], {
        payee: hostile, notes: 'PRIVATE NOTES', providerTransactionId: 'PRIVATE PROVIDER ID',
      });
      await load(); await openBills(); await tap(bill());
      assert.doesNotMatch(await paymentBody().innerText(), /PRIVATE|Long label|tx-1/);
      // Hostile plain row text through the actual Budget printer and its live
      // BudgetPolish observer. Other unrelated page printers are not under test.
      await page.evaluate(hostileText => {
        const row = Forecast.recommend(App.data.plan, App.data.meta.asOf, {
          currentPeriodActuals: App.data.liveOverlay.currentPeriodActuals,
        }).defaultView.calendarPeriods[0].bills.find(r => r.id === 'bill');
        document.querySelector('[data-pay-period-swipe] [data-period-bill="bill"]').parentElement.outerHTML =
          periodBillLine({ ...row, label: hostileText, payerLabel: hostileText });
      }, hostile);
      await page.waitForFunction(() => document.querySelector('[data-pay-period-swipe] [data-period-bill="bill"]').hasAttribute('data-atlas-bill-row'));
      await tap(bill());
      assert.equal(await details().locator('img,svg,script').count(), 0);
      assert.equal(await page.evaluate(() => window.hacked === true), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (width < 400) {
        const summaryBox = await bill().boundingBox(), labelBox = await bill().locator(':scope > span:first-child').boundingBox();
        assert.ok(labelBox.width >= summaryBox.width * 0.85, 'phone label has a full row alongside existing badges');
      }
      const output = process.env.ATLAS_BILL_EVIDENCE_SCREENSHOTS;
      if (output) { fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, `budget-bill-${width}.png`), fullPage: true }); }

      // Actual route navigation back to Budget gets a fresh packet.
      await page.goto(new URL('/bills.html', base).href);
      await page.waitForURL('**/bills.html');
      data = servedFixture(); data.liveOverlay.currentPeriodActuals.representedActuals = [];
      await page.goto(base + '/');
      await page.waitForURL(base + '/');
      assert.equal(await page.locator('.sitenav, .sitenav-household').count(), 0);
      await page.locator('[data-pay-period-swipe]').waitFor();
      await openBills(); await tap(bill());
      assert.doesNotMatch(await paymentBody().innerText(), /Transaction date|2026-08-18/);

      data = servedFixture(); data.liveOverlay.operatingPlan = 'unavailable';
      data.liveOverlay.operatingPlanNote = 'Synthetic failed advancing observation';
      await page.goto(base);
      await page.locator('#operating-surface-body [data-operating-plan="unavailable"]').first().waitFor();
      assert.equal(await page.locator('#operating-surface-body [data-bill-detail]').count(), 0);
      assert.doesNotMatch(await page.locator('#operating-surface-body').innerText(), /Transaction date|2026-08-18/);
      data = servedFixture(); await load(); await openBills();
      assert.equal(await details().evaluate(el => el.open), false);
      await tap(bill()); assert.match(await paymentBody().innerText(), /2026-08-18/);
      if (output) {
        await bill().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `budget-normal-${width}.png`) });
      }
      // Real sanitized card-payment pipeline, preserving every signed leg.
      for (const mode of ['posted', 'split', 'unknown', 'pending', 'refund', 'reversal']) {
        data = { accounts: [], ...cardObservation(mode) };
        await load(); await openBills();
        assert.equal(await details().evaluate(el => el.open), false);
        const before = await snapshot();
        await bill().focus(); await page.keyboard.press('Enter');
        const printed = await paymentBody().innerText();
        if (['posted', 'split', 'unknown'].includes(mode)) {
          assert.match(printed, mode === 'split' ? /\$-125\.00 \(credit\)/ : /\$-250\.00 \(credit\)/);
          assert.match(printed, /Actual\s+\$-250\.00/);
          assert.match(printed, /sign alone does not identify a payment, refund or reversal/);
          assert.match(await bill().locator(':scope > span:last-child').innerText(), /about −\$250.00/);
          if (mode === 'split') assert.equal((printed.match(/\(credit\)/g) || []).length, 2);
        } else {
          assert.match(printed, /Transaction evidence is unavailable/);
          assert.doesNotMatch(printed, /Transaction amount|\(credit\)/);
        }
        assert.doesNotMatch(printed, /Synthetic private note|8101|8102|8002/);
        assert.equal(await snapshot(), before);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await tap(bill());
        assert.equal(await details().evaluate(el => el.open), false);
      }
      // Signed evidence never trusts a direction/type hint. Zero is unknown;
      // a pending linked credit is explicitly not a posted payment.
      for (const [amount, pending, direction] of [[250, false, 'debit'], [0, false, 'direction unavailable'], [-250, true, 'credit']]) {
        data = { accounts: [], ...cardObservation() };
        Object.assign(data.liveOverlay.currentPeriodActuals.transactions[0], { amount, pending,
          kindHint: '<img src=x onerror="window.hacked=true">', direction: '<svg onload=bad>', notes: 'PRIVATE SIGN NOTE' });
        await load(); await openBills(); await tap(bill());
        const printed = await paymentBody().innerText();
        assert.ok(printed.includes(`${amount < 0 ? '$-250.00' : amount > 0 ? '$250.00' : '$0.00'} (${direction})`));
        assert.match(printed, /Actual\s+\$-250\.00/);
        if (pending) assert.match(printed, /Pending — not a posted payment/);
        assert.doesNotMatch(printed, /PRIVATE|onerror|onload/);
        assert.equal(await details().locator('img,svg,script').count(), 0);
        assert.equal(await page.evaluate(() => window.hacked === true), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await context.close();
      console.log(`PASS integrated Budget bill evidence: ${width}px, native keyboard/touch, badges, nested steps, refresh/navigation, period identity, signed debit/credit, pending/split/refund/reversal, unavailable and hostile evidence`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
