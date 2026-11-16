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
    // 52acaa77 (owner decision, 2026-11-11) removed the old funding section
    // and its [data-budget-daily-funding-evidence]. The same daily proposal
    // still publishes in the Planned Savings step evidence, opened from its
    // visible summary.
    const nativeFunding = () => body().locator('[data-budget-daily-savings]');
    const removedFunding = async () => assert.equal(await page.locator(
      '[data-budget-funding-section], [data-budget-funding-evidence], [data-budget-daily-funding-evidence]').count(), 0,
      'the removed funding section is absent');
    const waterfall = () => root().locator('[data-calendar-waterfall]');
    const overview = key => waterfall().locator(`[data-operating-question="${key}"] > details > summary`);
    const sheet = () => page.locator('[data-budget-detail-sheet]');
    const body = () => page.locator('[data-budget-detail-body]');
    const openSheet = async trigger => { await tap(trigger); await sheet().waitFor(); return body(); };
    const closeSheet = async trigger => {
      await page.keyboard.press('Escape'); await sheet().waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'native Info returns to its exact trigger');
    };
    const fundingTrigger = () => page.locator('[data-operating-question="savings"] > details > summary');
    const openFunding = async () => { await removedFunding(); return openSheet(fundingTrigger()); };
    // #548: the visible Bills tile row and Household ring open the same
    // native evidence as the off-screen roster rows.
    const tileBill = (id, date) => page.locator(`[data-blend-bill="${id}:${date}"]`);
    const ring = id => page.locator(`.blend-ring[data-blend-cat="${id}"]`);
    const step = dir => page.evaluate(d => document.querySelector(`[data-budget-window-step="${d}"]`).click(), dir);
    const load = async input => {
      server.write(input);
      // budget-blend.js gives an open sheet a history entry and steps back off it
      // (history.go) after it closes; let that land, or the reload is aborted.
      // Settled = the sheet history depth matches whether a sheet is still open.
      if (page.url().startsWith(server.base)) {
        await page.waitForFunction(() => !!document.querySelector('dialog[open]') === !!(history.state && history.state.atlasSheet));
        await page.reload();
      } else await page.goto(server.base);
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
      // The face prints Q07 a second time in whole dollars + cents; the
      // print hook [data-budget-result-amount] carries the published money2 text.
      const value07 = () => overview('07').locator('[data-budget-result-amount]').innerText();
      // 80cf9cca moved Balance after bills (05) into the Period figures panel
      // that the visible 07 result opens; its published value is unchanged.
      const value05 = () => page.locator('[data-budget-period-info-body] [data-operating-question="05"] > details > summary .budget-step-value').textContent();
      assert.equal(await value05(), money(880), '05');
      assert.equal(await value07(), money(e.periodResult), '07');
      assert.equal(summaryCents(await value05())
        - summaryCents(await value07()), e.budgetHold * 100,
      'visible full-period deductions reconcile to the supplied protective reserve, not actual spending');
      // The face lifts Still planned out of the tile into the Household Info
      // sheet, opened from the visible card title (budget-blend.js paintHousehold).
      if (e.hold) {
        const info = page.locator('[data-budget-browse-evidence="06"]');
        await openSheet(info);
        assert.match(await body().locator('[data-budget-browse-remaining]').innerText(), /Unavailable/,
          'unresolved pending/posting evidence withholds remaining capacity, while known posted spending remains visible');
        await closeSheet(info);
      }
      await openSheet(overview('02'));
      const income = body().locator('[data-period-income="payroll"]');
      assert.equal(await income.count(), 1);
      assert.equal(await income.getAttribute('data-income-status'), 'received');
      await closeSheet(overview('02'));
      const bills = page.locator('[data-budget-browse="bills"]');
      assert.equal(await bills.locator('[data-budget-bill-bucket="paid"] [data-budget-bill-open="shaw"]').count(), e.billPaid ? 1 : 0);
      const bill = tileBill('shaw', '2026-08-16');
      await openSheet(bill);
      const evidence = await body().innerText();
      if (e.billPaid) {
        assert.match(evidence, /2026-08-16/); assert.match(evidence, /\$120\.00 \(debit\)/);
        assert.match(evidence, /Synthetic Bills/); assert.match(evidence, /Posted/);
      } else assert.match(evidence, /Transaction evidence is unavailable/);
      assert.doesNotMatch(evidence, /9100|providerTransactionId|Shaw Cable synthetic/);
      await closeSheet(bill);
      for (const [id, planned, spent] of [['groceries', 300, e.groceries], ['restaurants', 100, e.dining]]) {
        const row = page.locator(`[data-budget-category-open="${id}"][data-budget-browse-origin="spending"]`);
        const trigger = ring(id);
        const meta = await row.locator('.budget-category-meta').textContent();
        assert.ok(meta.includes(money(planned)) && meta.includes(money(spent)), id + ' actual/original');
        assert.ok((await row.locator('.budget-category-status').textContent()).includes(money(planned - spent)), id + ' remaining');
        assert.ok((await trigger.getAttribute('aria-label')).includes(money(planned - spent)), id + ' visible ring names the same remaining');
        if (spent) {
          await openSheet(trigger);
          const detail = body().locator('[data-budget-spent]');
          // d7646367: an unresolved pending look-alike keeps the category
          // Spent estimated (the hold step only); every other step is exact.
          const spentText = (e.hold === 'pending-possible-replacement' && id === 'groceries' ? '≈ estimated ' : '') + money(spent);
          assert.equal(await detail.locator(':scope > summary .household-budget-spent-amount').innerText(), spentText);
          assert.equal(await detail.evaluate(el => el.open), true, 'native category Info exposes its actual rows');
          assert.equal(await detail.locator('[data-budget-spent-total]').innerText(), spentText);
          // d7646367: a pending look-alike stays listed, marked Possible
          // duplicate, and is not counted in Spent; the sum excludes only it.
          const duplicates = await detail.locator('.household-budget-tx:has([data-possible-duplicate]) .household-budget-tx-amount').allTextContents();
          assert.equal(duplicates.length, e.hold === 'pending-possible-replacement' && id === 'groceries' ? 1 : 0, 'possible-duplicate rows');
          const amounts = await detail.locator('.household-budget-tx:not(:has([data-possible-duplicate])) .household-budget-tx-amount').allTextContents();
          assert.equal(amounts.length + duplicates.length, await detail.locator('.household-budget-tx-amount').count());
          const cents = amounts.map(s => Math.round(Number(s.replace('−', '-').replace(/[^\d.-]/g, '')) * 100));
          assert.equal(cents.reduce((a, b) => a + b, 0), spent * 100, 'visible expanded rows sum to supplied ledger');
          // G3a (5adf0e8b): the identified $20 Groceries refund nets as its
          // own row (printed with U+2212, parsed above), from refund-transfer on.
          if (id === 'groceries') assert.equal(amounts.length,
            (e.key === 'purchases' || e.key === 'settlement' || e.key === 'refund-transfer' ? 2 : 3)
            + (['refund-transfer', 'ambiguous', 'resolved'].includes(e.key) ? 1 : 0));
          assert.doesNotMatch(await detail.innerText(), /REFUND|TFR-|Shaw Cable/);
          await closeSheet(trigger);
        }
      }
      if (e.other) {
        const trigger = ring('other-spending');
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
        assert.equal(await waterfall().locator('[data-operating-question="07"] > details > summary [data-budget-result-amount]').innerText(), money(expected.periodResult));
        const bill = tileBill('shaw', '2026-08-16');
        await openSheet(bill);
        assert.match(await body().innerText(), /2026-08-16/);
        activePhase.firstDisclosureAt = performance.now();
        await closeSheet(bill);
        await openFunding();
        assert.equal(await nativeFunding().locator('[data-budget-daily-proposal]').innerText(), 'Unavailable');
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
        await step(key === 'ArrowRight' ? '1' : '-1');
      };
      await move('ArrowRight');
      assert.equal(await page.locator('[data-budget-browse="bills"] [data-budget-bill-open="shaw"]').getAttribute('data-budget-bill-date'), '2026-08-30');
      const futureBill = tileBill('shaw', '2026-08-30');
      await openSheet(futureBill);
      assert.doesNotMatch(await body().innerText(), /Transaction date|2026-08-16/);
      await closeSheet(futureBill);
      await move('ArrowLeft'); await check(last);
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
