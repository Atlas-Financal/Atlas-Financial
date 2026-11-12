'use strict';
// Optional real-browser companion to test-household-path.js. Reuses #473's
// authenticated server and #471's native disclosure/navigation interaction.
// NODE_PATH=<Playwright packages> CHROME_PATH=<Chromium> node test/browser-household-path.js
// Expected DOM cents come only from household-path-data's supplied ledger.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { withServer } = require('./test-savings-evidence-integration');
const { fixture, variant, ledger } = require('./fixtures/household-path-data');
const shots = process.env.ATLAS_HOUSEHOLD_SCREENSHOTS || path.join(os.tmpdir(), 'atlas-household-path');
const money = n => '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const phases = [];
const executionHead = cp.execFileSync('git', ['-c', 'safe.directory=' + path.resolve(__dirname, '..').replace(/\\/g, '/'),
  'rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim();

async function session(server, width, steps, extras = true) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], writes = [];
  let page, control = null, activePhase = null, dataRequests = 0;
  try {
    const context = await browser.newContext({ viewport: { width, height: 900 },
      isMobile: width < 400, hasTouch: width < 400, reducedMotion: 'reduce',
      colorScheme: width === 320 ? 'dark' : 'light' });
    const split = server.cookie.indexOf('=');
    await context.addCookies([{ name: server.cookie.slice(0, split), value: server.cookie.slice(split + 1),
      url: server.base, httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== server.base) {
        external.push(route.request().url()); return route.abort();
      }
      if (route.request().method() !== 'GET') writes.push(route.request().method());
      if (new URL(route.request().url()).pathname === '/data.json') {
        dataRequests++;
        const held = control;
        if (held?.mode === 'unavailable-retry') return route.fulfill({ status: 503, json: { error: 'data unavailable' } });
        if (held) {
          try {
            const response = await route.fetch(); // Real authenticated synthetic server/overlay.
            if (held.mode === 'delayed') held.timer = setTimeout(held.release, 25000);
            await held.wait;
            await route.fulfill({ response });
            held.lateDisposition = 'fulfilled';
          } catch (error) {
            if (!held.cancelled) errors.push(error.message);
            held.lateDisposition = 'cancelled transport';
          } finally { clearTimeout(held.timer); held.complete(); }
          return;
        }
      }
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => {
      if (message.type() === 'error' && !(message.location().url === server.base + '/data.json' && /503/.test(message.text()))) errors.push(message.text());
    });
    page.on('response', response => {
      if (activePhase && response.url() === server.base + '/data.json') activePhase.dataResponseAt = performance.now();
    });
    const tap = locator => width < 400 ? locator.tap() : locator.click();
    const root = () => page.locator('[data-pay-period-swipe]');
    const nativeFunding = () => body().locator('[data-budget-daily-funding-evidence]');
    const waterfall = () => root().locator('[data-calendar-waterfall]');
    const overview = key => waterfall().locator(`[data-operating-question="${key}"] > details > summary`);
    const sheet = () => page.locator('[data-budget-detail-sheet]');
    const body = () => page.locator('[data-budget-detail-body]');
    const openSheet = async trigger => { await tap(trigger); await sheet().waitFor(); return body(); };
    const closeSheet = async trigger => {
      await page.keyboard.press('Escape'); await sheet().waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'native Info returns to its exact trigger');
    };
    const fundingTrigger = () => page.locator('[data-budget-funding-evidence="today"]');
    const openFunding = () => openSheet(fundingTrigger());
    const load = async input => {
      server.write(input);
      if (page.url().startsWith(server.base)) await page.reload(); else await page.goto(server.base);
      await page.locator('[data-budget-surface]').waitFor();
      await page.waitForFunction(() => !!document.querySelector('[data-budget-browse="bills"] [data-budget-bill-open]'));
    };
    async function check(e) {
      assert.equal(await page.evaluate(() => App.data.liveOverlay.applied), true);
      assert.equal(await page.evaluate(() => App.data.meta.asOf), e.date);
      assert.equal(await page.locator('[data-live-current-balance-amount]').first().innerText(), money(e.a),
        'Current Balance is Bills-only; From today uses both chequing accounts');
      const summaryCents = text => {
        const m = text.match(/(-?)\$([0-9,]+)\.([0-9]{2})/);
        assert.ok(m, 'one displayed CAD amount');
        return (m[1] ? -1 : 1) * (Number(m[2].replaceAll(',', '')) * 100 + Number(m[3]));
      };
      for (const [key, actual, planned] of [['02', 1000, 1000], ['04', e.billPaid ? 120 : 0, 120], ['06', e.spent, 400]]) {
        const actualText = await overview(key).locator('[data-budget-ratio-actual]').innerText();
        assert.equal(summaryCents(actualText), actual * 100, key + ' actual cents');
        if (key === '06' && e.key === 'purchases') assert.match(actualText, /estimated/, 'included pending spending retains its qualification');
        assert.match(await overview(key).locator('[data-budget-ratio-plan]').innerText(), new RegExp(money(planned).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), key + ' original plan');
      }
      for (const [key, value] of [['05', 880], ['07', e.periodResult]])
        assert.equal(await overview(key).locator('.budget-step-value').innerText(), money(value), key);
      assert.equal(summaryCents(await overview('05').locator('.budget-step-value').innerText())
        - summaryCents(await overview('07').locator('.budget-step-value').innerText()), e.budgetHold * 100,
      'visible full-period deductions reconcile to the supplied protective reserve, not actual spending');
      if (e.hold) assert.match(await page.locator('[data-budget-browse-remaining]').innerText(), /Unavailable/,
        'unresolved pending/posting evidence withholds remaining capacity, while known posted spending remains visible');
      await openSheet(overview('02'));
      const income = body().locator('[data-period-income="payroll"]');
      assert.equal(await income.count(), 1);
      assert.equal(await income.getAttribute('data-income-status'), 'received');
      await closeSheet(overview('02'));
      const bills = page.locator('[data-budget-browse="bills"]');
      const bill = bills.locator('[data-budget-bill-open="shaw"][data-budget-bill-date="2026-08-16"]');
      await bill.waitFor({ state: 'attached' });
      if (!(await bill.isVisible())) await tap(bills.locator(`[data-budget-bill-filter="${e.billPaid ? 'paid' : 'not-paid'}"]`));
      assert.equal(await bills.locator('[data-budget-bill-bucket="paid"] [data-budget-bill-open="shaw"]').count(), e.billPaid ? 1 : 0);
      await openSheet(bill);
      const evidence = await body().innerText();
      if (e.billPaid) {
        assert.match(evidence, /2026-08-16/); assert.match(evidence, /\$120\.00 \(debit\)/);
        assert.match(evidence, /Synthetic Bills/); assert.match(evidence, /Posted/);
      } else assert.match(evidence, /Transaction evidence is unavailable/);
      assert.doesNotMatch(evidence, /9100|providerTransactionId|Shaw Cable synthetic/);
      await closeSheet(bill);
      for (const [id, planned, spent] of [['groceries', 300, e.groceries], ['restaurants', 100, e.dining]]) {
        const trigger = page.locator(`[data-budget-category-open="${id}"][data-budget-browse-origin="spending"]`);
        const meta = await trigger.locator('.budget-category-meta').innerText();
        assert.ok(meta.includes(money(planned)) && meta.includes(money(spent)), id + ' actual/original');
        assert.ok((await trigger.locator('.budget-category-status').innerText()).includes(money(planned - spent)), id + ' remaining');
        if (spent) {
          await openSheet(trigger);
          const detail = body().locator('[data-budget-spent]');
          assert.equal(await detail.locator(':scope > summary .household-budget-spent-amount').innerText(), money(spent));
          assert.equal(await detail.evaluate(el => el.open), true, 'native category Info exposes its actual rows');
          assert.equal(await detail.locator('[data-budget-spent-total]').innerText(), money(spent));
          const amounts = await detail.locator('.household-budget-tx-amount').allTextContents();
          const cents = amounts.map(s => Math.round(Number(s.replace(/[^\d.-]/g, '')) * 100));
          assert.equal(cents.reduce((a, b) => a + b, 0), spent * 100, 'visible expanded rows sum to supplied ledger');
          if (id === 'groceries') assert.equal(amounts.length,
            e.key === 'purchases' || e.key === 'settlement' || e.key === 'refund-transfer' ? 2 : 3);
          assert.doesNotMatch(await detail.innerText(), /REFUND|TFR-|Shaw Cable/);
          await closeSheet(trigger);
        }
      }
      if (e.other) {
        const trigger = page.locator('[data-budget-category-open="other-spending"][data-budget-browse-origin="spending"]');
        await openSheet(trigger);
        const other = body();
        assert.equal(await other.locator('[data-budget-spent-total]').innerText(), '$35.00');
        assert.equal(await other.locator('.household-budget-tx-amount').count(), 1);
        await closeSheet(trigger);
      }
      await openFunding();
      // This incumbent household fixture has no purpose-pool configuration.
      // The active daily selector must qualify it, not display the earlier $420
      // calculation as a current grant. test-household-path retains that ledger's
      // server/Forecast numerical proof; existing daily browser fixtures prove
      // the separate configured positive and negative funding states.
      assert.equal(await nativeFunding().locator('[data-budget-daily-proposal]').innerText(), 'Unavailable');
      assert.match(await nativeFunding().innerText(), /Configured purpose pools are required/);
      assert.match(await nativeFunding().innerText(), /Starting assignments are unknown/);
      assert.doesNotMatch(await nativeFunding().innerText(), /\$/);
      await closeSheet(fundingTrigger());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), width + 'px overflow');
    }
    async function loadingRecovery() {
      const expected = ledger[ledger.length - 1];
      const notice = () => page.locator('.wrap > [role="status"]');
      const withheld = async () => {
        assert.equal(await page.evaluate(() => App.data), null, 'pending/failed/cancelled boot has no financial data');
        assert.equal(await page.locator('[data-live-current-balance-amount],[data-budget-surface]').count(), 0,
          'the real DOM publishes no usable figure before recovery');
      };
      const begin = async mode => {
        let release, complete;
        control = { mode, wait: new Promise(resolve => { release = resolve; }),
          done: new Promise(resolve => { complete = resolve; }), release: () => release(), complete: () => complete() };
        activePhase = { width, mode, navigationAt: performance.now(), synthetic: true };
        server.write(fixture('resolved'));
        if (page.url().startsWith(server.base)) await page.reload(); else await page.goto(server.base);
        return control;
      };
      const usable = async () => {
        await page.locator('[data-budget-surface]').waitFor();
        await page.waitForFunction(() => App.data?.meta.asOf === '2026-08-21'
          && !!document.querySelector('[data-budget-browse="bills"] [data-budget-bill-open]'));
        activePhase.usableAt = performance.now();
        assert.equal(await page.locator('[data-live-current-balance-amount]').first().innerText(), money(expected.a));
        assert.equal(await waterfall().locator('[data-operating-question="07"] > details > summary .budget-step-value').innerText(), money(expected.periodResult));
        const bill = page.locator('[data-budget-browse="bills"] [data-budget-bill-open="shaw"]');
        if (!(await bill.isVisible())) await tap(page.locator('[data-budget-bill-filter="paid"]'));
        await openSheet(bill);
        assert.match(await body().innerText(), /2026-08-16/);
        activePhase.firstDisclosureAt = performance.now();
        await closeSheet(bill);
        await openFunding();
        assert.equal(await nativeFunding().locator('[data-budget-daily-proposal]').innerText(), 'Unavailable');
        assert.match(await nativeFunding().innerText(), /Configured purpose pools are required/);
        await closeSheet(fundingTrigger());
        await page.locator('[data-budget-surface]').waitFor();
        await check(expected);
        await page.screenshot({ path: path.join(shots, `recovery-${activePhase.mode}-${width}.png`), fullPage: true });
        phases.push({ ...activePhase, navigationToResponseMs: activePhase.dataResponseAt - activePhase.navigationAt,
          responseToUsableMs: activePhase.usableAt - activePhase.dataResponseAt,
          usableToDisclosureMs: activePhase.firstDisclosureAt - activePhase.usableAt });
        console.log(`PASS recovery ${width}px ${activePhase.mode}: dated usable figures, bill/savings disclosure and month return`);
        activePhase = null;
      };
      const retry = async () => {
        const before = dataRequests;
        control = null;
        // Native DOM clicks exercise the real listener twice, including its removed element.
        const button = await notice().getByRole('button', { name: 'Retry', exact: true }).elementHandle();
        await button.evaluate(el => { el.click(); el.click(); });
        await usable();
        assert.equal(dataRequests, before + 1, 'repeated Retry starts one effective load');
        assert.equal(await notice().count(), 0);
      };
      const delayed = await begin('delayed');
      await notice().getByRole('button', { name: 'Cancel', exact: true }).waitFor();
      await withheld();
      await page.waitForTimeout(21000); // Cross the former 20s client bound with a real pending response.
      await withheld();
      assert.match(await notice().innerText(), /Loading current data/);
      await page.screenshot({ path: path.join(shots, `delayed-loading-${width}.png`), fullPage: true });
      await delayed.done; control = null;
      await usable();
      assert.ok(phases[phases.length - 1].navigationToResponseMs >= 25000, 'actual delayed success crosses the former client limit');

      const cancelled = await begin('cancel-retry');
      await notice().getByRole('button', { name: 'Cancel', exact: true }).waitFor();
      await withheld(); cancelled.cancelled = true;
      await tap(notice().getByRole('button', { name: 'Cancel', exact: true }));
      await notice().getByRole('button', { name: 'Retry', exact: true }).waitFor();
      assert.match(await notice().innerText(), /Loading cancelled/);
      cancelled.release(); await cancelled.done;
      await withheld(); // A held response released after abort cannot publish figures.
      activePhase.lateDisposition = cancelled.lateDisposition;
      await retry();

      await begin('unavailable-retry');
      await notice().getByRole('button', { name: 'Retry', exact: true }).waitFor();
      assert.match(await notice().innerText(), /Figures remain unavailable/);
      await withheld();
      await page.screenshot({ path: path.join(shots, `unavailable-${width}.png`), fullPage: true });
      await retry();
    }
    if (extras && width !== 320) await loadingRecovery();
    for (const e of steps) {
      await load(fixture(e.key)); await check(e);
      if (e.key === 'resolved' || e.hold) {
        await openFunding();
        await sheet().screenshot({ path: path.join(shots, `${e.key}-${width}.png`) });
        await closeSheet(fundingTrigger());
        if (e.key === 'resolved') await page.locator('[data-budget-browse="spending"]').screenshot({ path: path.join(shots, `spending-${width}.png`) });
      }
      console.log(`PASS browser ${width}px ${e.key}: supplied ledger cents and native Info; daily funding remains qualified`);
    }
    if (extras) {
      const last = ledger[ledger.length - 1];
      // Same packet reload plus reordered observation: no carried UI state.
      const reordered = fixture('resolved');
      reordered.payload.transactions.reverse(); reordered.payload.accounts.reverse(); reordered.map.mappings.reverse();
      await load(reordered); await check(last);
      const move = async key => {
        await page.locator('[data-budget-window-step="' + (key === 'ArrowRight' ? '1' : '-1') + '"]').focus();
        await page.keyboard.press('Enter');
      };
      await move('ArrowRight');
      const futureBill = page.locator('[data-budget-browse="bills"] [data-budget-bill-open="shaw"]');
      assert.equal(await futureBill.getAttribute('data-budget-bill-date'), '2026-08-30');
      await openSheet(futureBill);
      assert.doesNotMatch(await body().innerText(), /Transaction date|2026-08-16/);
      await closeSheet(futureBill);
      await move('ArrowLeft'); await check(last);
      // Actual Forecast route shows the remaining window, not Budget's full cycle.
      await page.goto(new URL('/planning.html', server.base).href);
      await page.waitForURL('**/planning.html');
      await tap(page.locator('button[data-trajectory-funding-granularity="pay-period"]').first());
      const road = page.locator('[data-road-waterfall-granularity="pay-period"]');
      await road.waitFor();
      assert.match(await page.locator('[data-road-timeline-granularity="pay-period"]').innerText(), /Aug 21.*Aug 27.*remaining/s);
      assert.match(await road.locator('[data-planning-road-wf-row="income-total"]').innerText(), /\$0\.00/);
      await page.goto(server.base + '/');
      await page.waitForURL(server.base + '/');
      await page.locator('[data-budget-surface]').waitFor();
      assert.equal(await page.locator('.sitenav, .sitenav-household').count(), 0);
      await check(last);
      for (const mode of ['missing', 'stale', 'floor']) {
        await load(variant(mode)); await openFunding();
        assert.equal(await nativeFunding().locator('[data-budget-daily-proposal]').innerText(), 'Unavailable');
        assert.doesNotMatch(await nativeFunding().innerText(), /\$/);
        await closeSheet(fundingTrigger());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      await load(fixture('resolved')); await check(last);
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(shots, `failure-${width}.png`), fullPage: true });
    console.error('Browser diagnostics:', JSON.stringify({ errors, external, writes,
      body: page ? (await page.locator('body').innerText()).slice(0, 1800) : '' }));
    throw error;
  } finally { if (control) { clearTimeout(control.timer); control.release(); } await browser.close(); }
}
async function main() {
  fs.mkdirSync(shots, { recursive: true });
  await withServer(fixture(), async server => {
    for (const width of [1440, 390, 320]) await session(server, width, ledger);
  });
  await withServer(fixture('resolved'), server => session(server, 390, [ledger[ledger.length - 1]], false));
  fs.writeFileSync(path.join(shots, 'loading-phases.json'), JSON.stringify({ synthetic: true, executionHead,
    browserCompanionSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), phases }, null, 2) + '\n');
  console.log('PASS household browser: authenticated full path, supplied ledger, refresh, process/browser restart, reorder, navigation, 1440/390/320px; screenshots ' + shots);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
