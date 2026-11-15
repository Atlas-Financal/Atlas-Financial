'use strict';
// Real page, local assets and independently invented observations only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.ATLAS_TEST_APP_ROOT || path.join(__dirname, '..');
const H = require(path.join(root, 'test/acceptance/harness'));
const O = require(path.join(root, 'scripts/provider-observe'));
const fx = require('./fixtures/savings-v2-observation-data');
const captureOnly = process.env.CAPTURE_ONLY === '1';
const out = process.env.PROOF_DIR || '/tmp/a23-savings-browser';
fs.mkdirSync(out, { recursive: true });
const reportLine = '[data-budget-savings-goals] > [data-savings-reported-balance]';
(async () => {
  let cases = 0;
  try {
    for (const width of [1440, 390, 320]) {
      for (const mode of ['valid-v2', 'stale-date', 'pending-movement', 'missing-date']) {
        const { data } = fx.served(mode, O);
        // Old stored evidence deliberately disagrees with the publication.
        data.plan.startingCash.heldElsewhere[0].value = 9876.54;
        const p = await H.openBudget(data, { width });
        try {
          const card = p.page.locator('[data-budget-savings-goals]');
          await card.waitFor({ state: 'visible' });
          const before = await p.page.evaluate(() => JSON.stringify(App.data));
          if (!captureOnly) {
            const line = p.page.locator(reportLine);
            await line.waitFor({ state: 'visible' });
            const actual = (await line.textContent()).replace(/\s+/g, ' ').trim();
            assert.match(actual, mode === 'missing-date' ? /Unavailable/ : /Reported combined savings: \$119\.00/);
            if (mode !== 'missing-date') assert.match(actual, /calculated.*provider-reported.*Balance dates [A-Z][a-z]{2} \d{1,2}/s);
            if (mode === 'stale-date') assert.match(actual, /Oct 4 - Oct 5.*not current/);
            if (mode === 'pending-movement') assert.match(actual, /Pending movement evidence is unresolved/);
            assert.doesNotMatch(actual, /9,876|spendable|available to spend|verified/i);
            assert.equal(await line.evaluate(el => !!el.closest('[data-operating-question="01"], .blend-hero')), false);
            assert.equal(await line.evaluate(el => el.previousElementSibling?.classList.contains('blend-tile-head')), true);
            // The existing three-tap evidence route prints the exact same line.
            await card.locator('[data-budget-funding-inventory]').click();
            const dialog = p.page.locator('[data-budget-detail-sheet]');
            await dialog.waitFor({ state: 'visible' });
            const info = dialog.locator('[data-budget-savings-info]');
            await info.locator(':scope > summary').click();
            const detail = info.locator('[data-savings-reported-balance]').first();
            await detail.waitFor({ state: 'visible' });
            assert.equal((await detail.textContent()).replace(/\s+/g, ' ').trim(), actual);
            await p.page.keyboard.press('Escape');
            // Native period navigation never relabels today's report as a close.
            await p.step(1);
            assert.equal(await p.page.locator(reportLine).count(), 0);
            await p.step(-1);
            assert.equal((await p.page.locator(reportLine).textContent()).replace(/\s+/g, ' ').trim(), actual);
            await p.page.evaluate(() => App.rerender());
            await p.page.locator(reportLine).waitFor({ state: 'visible' });
            assert.equal(await p.page.locator(reportLine).count(), 1);
            assert.equal((await p.page.locator(reportLine).textContent()).replace(/\s+/g, ' ').trim(), actual);
            assert.equal(await p.page.evaluate(() => JSON.stringify(App.data)), before);
          }
          assert.equal(await p.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
          assert.deepEqual(p.errors, []);
          await card.screenshot({ path: path.join(out, `${captureOnly ? 'before' : 'after'}-${mode}-${width}.png`) });
          cases++;
        } finally { await p.close(); }
      }
    }
    // Failed refresh retains a dated report while operating permission stays held.
    if (!captureOnly) {
      for (const prePolicy of [false, true]) {
        const w = H.baseWorld(); w.savingsPool = {};
        w.commitments = [{ id: 'trip', label: 'Invented trip', amount: 600, date: '2026-11-20', confidence: 'confirmed', sinkingFund: true }];
        w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
        const failed = structuredClone(w); failed.failRefresh = true; failed.coverage.complete = false;
        if (prePolicy) failed.dataPatch = data => {
          data.meta.asOf = data.plan.opening.asOf = '2026-10-13';
          data.plan.savingsEarmarks.allocationPolicy.effectiveFrom = '2026-10-14';
        };
        await H.withBudget([w, failed], async p => {
          await p.reload();
          const line = p.page.locator(reportLine);
          await line.waitFor({ state: 'visible' });
          assert.match(await line.innerText(), /calculated.*provider-reported.*Dated balance — not current/s);
          assert.ok(await p.page.locator('[data-operating-question="savings"][data-savings-evidence="carried"]').count());
          assert.deepEqual(p.errors, []);
        }, { width: 390 });
      }
      const legacy = fx.input().data;
      delete legacy.plan.savingsEarmarks.allocationPolicy;
      legacy.meta.asOf = legacy.plan.opening.asOf = '2026-08-19';
      delete legacy.liveOverlay;
      const p = await H.openBudget(legacy, { width: 390 });
      try {
        await p.page.locator('[data-budget-savings-goals] [data-budget-funding-inventory]').click();
        const dialog = p.page.locator('[data-budget-detail-sheet]');
        await dialog.waitFor({ state: 'visible' });
        await dialog.locator('[data-budget-savings-info] > summary').click();
        const old = dialog.locator('[data-savings-stored-opening]');
        await old.waitFor({ state: 'visible' });
        await old.scrollIntoViewIfNeeded();
        assert.match(await old.innerText(), /Stored opening evidence, as of 2026-08-19\. Current combined reported balance is unavailable/);
        await dialog.screenshot({ path: path.join(out, 'stored-opening-390.png') });
        assert.deepEqual(p.errors, []);
      } finally { await p.close(); }
    }
    console.log(`Savings discoverability browser: ${cases} viewport/state cases${captureOnly ? ' captured before' : ' checked; carried refresh, old opening, navigation and redraw checked'}. Screenshots: ${out}`);
  } finally { await H.closeBrowser(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
