'use strict';
// Ring geometry is the published SPENT share (Systems Review 5481323065
// R1): unobserved spending paints no geometry and never reads as zero;
// a withheld REMAINING qualification does not erase the observed spent
// figure Forecast still prints — it stays in the status and the
// accessible name while the ring mirrors the printed spent/plan pair.
// Face layout (owner amendment): the centre carries the published
// category name and the printed Actual / Planned pair sits beneath
// the circle; this suite asserts both alongside the geometry.
// Whole-dollar face (follow-on amendment; Option B): the
// beneath-circle pair renders each side in whole dollars, rounded
// UP once from its own typed published value (the canonical amount
// plan.js stamps on the row), while the source meta keeps exact
// cents — the pair assertions below use the face forms, the
// meta.includes assertions on the same fixture strings stay in
// cents, and that split is the proof the meta is untouched.
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-budget-unknown-ring.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ringEvidence = require('./fixtures/budget-blend-ring-evidence');
const { expected } = ringEvidence;
// The pair's whole-dollar face forms of the fixture pairs above
// (groceries $110.37 / $220.00; fuel $0.00 / $85.00), each rounded
// UP once from its own typed value ($110.37 -> $111).
const facePair = {
  groceries: { spent: '$111', planned: '$220' },
  zero: { spent: '$0', planned: '$85' },
};
const root = path.join(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [];
  const external = [];
  try {
    const open = async options => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 },
        colorScheme: 'light', reducedMotion: 'reduce' });
      // This suite proves the Rings view. Bars, the default since #821's
      // Refined design, is proved in browser-budget-house-bars.js.
      await page.addInitScript(() => { try { localStorage.setItem('atlas-house-view', 'rings'); } catch (e) { /* default view */ } });
      page.on('pageerror', err => errors.push(err.message));
      const data = ringEvidence.packet(options?.pendingCoverage || 'complete');
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) {
          return route.fulfill({ json: null });
        }
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({
          body: fs.readFileSync(file),
          contentType: file.endsWith('.js') ? 'application/javascript'
            : file.endsWith('.css') ? 'text/css' : 'text/html',
        });
      });
      await page.goto('http://budget.test/');
      await page.locator('[data-budget-surface]').waitFor();
      await page.locator('[data-blend-rings]').waitFor();
      return page;
    };
    const readRing = (page, id) => page.evaluate(category => {
      const row = document.querySelector('[data-budget-browse="spending"] [data-budget-category-open="' + CSS.escape(category) + '"]');
      const ring = document.querySelector('.blend-ring[data-blend-cat="' + CSS.escape(category) + '"]');
      const arc = ring?.querySelector('.rg-arc');
      const dash = (arc?.getAttribute('stroke-dasharray') || '').split(/\s+/).map(Number);
      return {
        status: row?.querySelector('.budget-category-status')?.textContent.trim(),
        meta: row?.querySelector('.budget-category-meta')?.textContent.replace(/\s+/g, ' ').trim(),
        scale: row?.querySelector('.budget-category-bar')?.getAttribute('data-budget-category-scale'),
        spentWidth: row?.querySelector('.budget-category-fill')?.style.width || '',
        known: !!ring?.classList.contains('is-known'),
        unknown: !!ring?.classList.contains('is-unknown'),
        dotted: !!ring?.querySelector('.rg-track.is-dotted'),
        arc: !!arc,
        arcFraction: arc ? dash[0] / dash[1] : null,
        liquid: !!ring?.querySelector('.blend-ring-liquid'),
        left: ring?.style.getPropertyValue('--left') ?? 'missing-ring',
        pct: ring?.style.getPropertyValue('--pct') ?? 'missing-ring',
        amount: ring?.querySelector('.blend-ring-v')?.textContent.trim(),
        pair: (ring?.querySelector('.blend-ring-pair')?.textContent || '').replace(/\s+/g, ' ').trim(),
        rowName: (row?.querySelector('.budget-category-name')?.textContent || '').trim(),
        label: ring?.getAttribute('aria-label') || '',
      };
    }, id);
    const noRingGeometry = (row, reason) => {
      assert.equal(row.unknown, true, reason);
      assert.equal(row.known, false, reason);
      assert.equal(row.dotted, true, reason);
      assert.equal(row.arc, false, reason);
      assert.equal(row.liquid, false, reason);
      assert.equal(row.left, '', reason);
      assert.equal(row.pct, '', reason);
    };
    const page = await open();
    const css = await page.evaluate(() => [...document.styleSheets].flatMap(sheet => {
      try { return [...sheet.cssRules].map(rule => rule.cssText); } catch (err) { return []; }
    }).join('\n'));
    assert.equal(/var\(\s*--left\s*,/.test(css), false, 'liquid height has no zero fallback');
    const known = await readRing(page, expected.groceries.id);
    // Independent fixture cents: 11037 observed of 22000 planned is the
    // spent share; 22000 minus 11037 leaves 10963 remaining (status).
    const spentFraction = 11037 / 22000;
    // The invented feed's newest spending row (Sep 25) is more than two
    // days before its observation (Oct 4), so Forecast.bankFeedFreshness
    // reads it stale and the native row carries the stale-feed mark (#821
    // owner decision 2026-11-08). The remaining amount itself is unchanged.
    assert.equal(known.status, expected.groceries.status + ' Incomplete');
    assert.equal(await page.locator('[data-budget-browse="spending"] [data-budget-category-open="'
      + expected.groceries.id + '"] .budget-category-status [data-budget-spent-incomplete]').count(), 1,
      'the suffix is the native stale-feed mark, not a changed remaining figure');
    assert.ok(known.meta.includes(expected.groceries.spent));
    assert.ok(known.meta.includes(expected.groceries.planned));
    assert.equal(known.amount, known.rowName, 'centre is the published category name (owner amendment), not the spent amount');
    assert.ok(known.amount, 'centre name is non-empty');
    assert.equal(known.pair, 'Spent ' + facePair.groceries.spent + ' / of planned ' + facePair.groceries.planned,
      'beneath the circle: the published Actual / Planned pair in whole dollars');
    assert.equal(known.known, true);
    assert.equal(known.liquid, true);
    assert.equal(known.arc, true);
    assert.ok(Math.abs(Number(known.left) - spentFraction) < 0.0001, 'liquid represents the independently reconciled spent fraction');
    assert.ok(Math.abs(known.arcFraction - spentFraction) < 0.0001, 'arc represents spent, not remaining');
    assert.match(known.label, /\$109\.63 left/, 'accessible name keeps the full printed remaining status');
    const zero = await readRing(page, expected.zero.id);
    assert.equal(zero.status, expected.zero.status + ' Incomplete', 'same stale-feed mark on the known-zero row');
    assert.equal(zero.amount, zero.rowName, 'true zero: centre is the published category name');
    assert.equal(zero.pair, 'Spent ' + facePair.zero.spent + ' / of planned ' + facePair.zero.planned,
      'true zero: the pair prints the known-zero actual as $0');
    assert.equal(zero.scale, 'numeric');
    assert.equal(parseFloat(zero.spentWidth), 0, 'fixture publishes actual zero spending');
    assert.ok(zero.meta.includes(expected.zero.spent));
    assert.ok(zero.meta.includes(expected.zero.planned));
    assert.equal(zero.known, true);
    assert.equal(zero.unknown, false);
    assert.equal(zero.liquid, false, 'R2: no liquid at a known zero — visibly empty');
    assert.equal(zero.arc, false, 'known zero draws no arc segment');
    assert.equal(zero.dotted, false);
    assert.equal(Number(zero.left), 0, 'confirmed zero spending fills nothing');
    // The period pill and its toolbar were retired; the native step stays
    // the period control (same pattern as browser-budget-house-bars.js).
    await page.evaluate(() => {
      const next = [...document.querySelectorAll('[data-budget-window-step="1"]')].find(b => b.getAttribute('aria-disabled') !== 'true');
      if (!next) throw new Error('no enabled next-period step');
      next.click();
    });
    await page.locator('[data-budget-window-range]').filter({ hasText: /Oct 9/ }).waitFor();
    await page.locator('[data-blend-rings]').waitFor();
    const ids = await page.locator('[data-budget-browse="spending"] .budget-category-row').evaluateAll(rows =>
      rows.map(row => row.getAttribute('data-budget-category-open')).filter(id => id !== 'other-spending'));
    const future = await Promise.all(ids.map(id => readRing(page, id)));
    const unobserved = future.filter(row => /Not observed/.test(row.status));
    assert.ok(unobserved.length > 0, 'the next period publishes Not observed categories');
    unobserved.forEach(row => {
      assert.equal(row.scale, 'unavailable');
      noRingGeometry(row, 'unobserved categories never imply a spent fraction');
    });
    assert.equal(future.some(row => row.left === '0' && row.unknown), false);
    await page.close();
    // These fixtures retain real numeric spent/plan bars while the native
    // publication withholds REMAINING because pending evidence is
    // incomplete. The ring's subject is spent (R1): the observed spent
    // figure Forecast still prints carries the geometry, and the
    // remaining qualification survives untouched in the status and the
    // accessible name — it is not the ring's geometry any more.
    for (const pendingCoverage of ['partial', 'unknown']) {
      const partialPage = await open({ pendingCoverage });
      const partial = await readRing(partialPage, expected.groceries.id);
      assert.equal(partial.status, expected.incompleteStatus);
      assert.equal(partial.scale, 'numeric', 'regression requires numeric source geometry');
      assert.ok(parseFloat(partial.spentWidth) > 0, 'observed spending survives the missing remaining qualification');
      assert.ok(partial.meta.includes(expected.groceries.spent));
      assert.ok(partial.meta.includes(expected.groceries.planned));
      assert.equal(partial.amount, partial.rowName, 'centre is the published category name (owner amendment)');
      assert.equal(partial.pair, 'Spent ' + facePair.groceries.spent + ' / of planned ' + facePair.groceries.planned,
        'beneath the circle: the printed Actual / Planned pair (whole dollars) survives the missing remaining qualification');
      assert.match(partial.label, /Remaining unavailable/, 'remaining qualification stays in the accessible name');
      assert.equal(partial.known, true, `${pendingCoverage}: observed spent paints the ring`);
      assert.equal(partial.arc, true);
      assert.equal(partial.liquid, true);
      assert.ok(Math.abs(Number(partial.left) - 11037 / 22000) < 0.0001, 'liquid level is the spent share');
      const zeroPartial = await readRing(partialPage, expected.zero.id);
      assert.equal(zeroPartial.status, expected.incompleteStatus);
      assert.equal(zeroPartial.scale, 'numeric');
      assert.equal(parseFloat(zeroPartial.spentWidth), 0, 'incomplete fixture retains observed zero spending');
      assert.ok(zeroPartial.meta.includes(expected.zero.spent));
      assert.ok(zeroPartial.meta.includes(expected.zero.planned));
      assert.equal(zeroPartial.amount, zeroPartial.rowName, 'observed zero: centre is the published name; remaining uncertainty is not the centre');
      assert.equal(zeroPartial.pair, 'Spent ' + facePair.zero.spent + ' / of planned ' + facePair.zero.planned,
        'observed zero: the pair prints the known-zero actual as $0');
      assert.match(zeroPartial.label, /Remaining unavailable/);
      assert.equal(zeroPartial.known, true);
      assert.equal(zeroPartial.arc, false, 'known zero draws no arc segment');
      assert.equal(zeroPartial.liquid, false, 'R2: no liquid at a known zero');
      await partialPage.close();
    }
    for (const widthEvidence of ['missing', 'blank']) {
      const incomplete = await open();
      await incomplete.evaluate(mode => {
        const row = document.querySelector('[data-budget-browse="spending"] [data-budget-category-open="groceries"]');
        const fill = row.querySelector('.budget-category-fill');
        if (mode === 'missing') fill.remove();
        else fill.style.width = '';
        // Withhold the redundant printed denominator too: a missing width must
        // not become confirmed zero through fallback parsing of absent data.
        row.querySelector('.budget-category-meta').textContent = 'Spent Unavailable / of planned Unavailable';
        document.querySelector('[data-blend-rings]')?.remove();
        document.querySelector('.blend-other')?.remove();
        document.querySelector('[data-budget-bento]')?.removeAttribute('data-blend-ready');
        document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
      }, widthEvidence);
      await incomplete.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const missing = await readRing(incomplete, 'groceries');
      assert.equal(missing.spentWidth, '');
      noRingGeometry(missing, widthEvidence + ' numeric evidence is not zero spending');
      await incomplete.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(`PASS spent rings: independently reconciled spent fractions, known zero empty, ${unobserved.length} Not observed next period, missing evidence withheld`);
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
