'use strict';
// Household budget as bars (#821 Refined design, owner decision 2026-11-11).
//
// Claim: the Household categories read as bars by default, with a switch
// back to rings that is remembered per browser. The bars are the SAME
// buttons as the rings, restyled: nothing the household reads changes.
//
// What this proves, on the page a household actually reads:
//   1. Default view is Bars; the switch says so.
//   2. Every category prints the same name, the same Actual / Planned pair
//      and the same accessible name in both views (text compared across a
//      real switch, not against the painter's own helpers).
//   3. The bar fill is the published spent share. Expected shares come from
//      the invented fixture inputs alone (Groceries 110.37 of 220.00; Fuel
//      0.00 of 85.00), not from Forecast or the painter.
//   4. Spending not observed paints no fill: an unknown share never reads
//      as zero.
//   5. Tapping a bar opens the same category detail the ring opens.
//   6. The switch persists across a reload, and the page still works with
//      browser storage denied (default view, no error).
//   7. No sideways scroll at phone width.
//
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-budget-house-bars.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ringEvidence = require('./fixtures/budget-blend-ring-evidence');
const root = path.join(__dirname, '..');

// Independent of Forecast and of the painter: straight from the fixture inputs.
const SHARE = { groceries: 11037 / 22000, fuel: 0 };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [];
  const external = [];
  try {
    const open = async (opts = {}) => {
      const context = await browser.newContext({ viewport: { width: opts.width || 1440, height: 1000 },
        colorScheme: 'light', reducedMotion: 'reduce' });
      if (opts.denyStorage) {
        // Reads and writes of this preference are refused, as a browser with
        // blocked site data does; the rest of the page's storage is untouched.
        await context.addInitScript(() => {
          const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
          Storage.prototype.getItem = function (key) { if (key === 'atlas-house-view') throw new Error('storage denied'); return get.apply(this, arguments); };
          Storage.prototype.setItem = function (key) { if (key === 'atlas-house-view') throw new Error('storage denied'); return set.apply(this, arguments); };
        });
      }
      const page = await context.newPage();
      page.on('pageerror', err => errors.push(err.message));
      const data = opts.data || ringEvidence.packet('complete');
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
    // Everything a household can read or hear on the Household categories.
    const read = page => page.evaluate(() => {
      const rings = document.querySelector('[data-blend-rings]');
      const tidy = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        view: rings.getAttribute('data-blend-house-view'),
        pressed: [...document.querySelectorAll('[data-blend-house-views] button')]
          .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim()),
        rows: [...rings.querySelectorAll('.blend-ring')].map(button => {
          const after = getComputedStyle(button, '::after');
          const arc = button.querySelector('.blend-ring-g > svg');
          const stop = /(\d+(?:\.\d+)?)%/.exec(after.backgroundImage || '');
          return {
            id: button.getAttribute('data-blend-cat'),
            name: tidy(button.querySelector('.blend-ring-v')),
            pair: tidy(button.querySelector('.blend-ring-l')),
            label: button.getAttribute('aria-label'),
            known: button.classList.contains('is-known'),
            pct: button.style.getPropertyValue('--pct'),
            bar: after.content !== 'none' && parseFloat(after.height) > 0,
            barImage: after.backgroundImage,
            barStop: stop ? Number(stop[1]) / 100 : null,
            arcShown: !!arc && getComputedStyle(arc).display !== 'none',
            nameShown: (() => { const r = button.querySelector('.blend-ring-v')?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; })(),
          };
        }),
        totals: tidy(document.querySelector('.blend-house-totals')),
      };
    });
    const choose = async (page, name) => {
      await page.locator('[data-blend-house-views] button', { hasText: name }).click();
    };
    const stored = page => page.evaluate(() => localStorage.getItem('atlas-house-view'));

    // 1. Default view is Bars.
    const page = await open();
    const bars = await read(page);
    assert.equal(bars.view, 'bars', 'default view is bars');
    assert.deepEqual(bars.pressed, ['Bars'], 'the switch shows Bars as chosen');
    assert.equal(await stored(page), null, 'nothing is stored until the household chooses');
    assert.ok(bars.rows.length >= 2, 'the fixture categories are on the face');
    for (const row of bars.rows) {
      assert.ok(row.bar, row.id + ': a bar is drawn');
      assert.equal(row.arcShown, false, row.id + ': the ring is not drawn in the bars view');
      assert.ok(row.nameShown && row.name, row.id + ': the category name is visible');
      assert.ok(row.pair, row.id + ': the printed pair is visible');
      assert.ok(row.label, row.id + ': the accessible name is present');
    }

    // 3. The bar fill is the published spent share, from the fixture inputs alone.
    for (const [id, share] of Object.entries(SHARE)) {
      const row = bars.rows.find(r => r.id === id);
      assert.ok(row && row.known, id + ' is a known share');
      assert.ok(Math.abs(row.barStop - share) < 0.002, `${id} bar fill ${row.barStop} is the spent share ${share.toFixed(4)}`);
    }

    // 2. Same words in both views, across a real switch.
    await choose(page, 'Rings');
    const rings = await read(page);
    assert.equal(rings.view, 'rings');
    assert.deepEqual(rings.pressed, ['Rings']);
    assert.equal(await stored(page), 'rings', 'the choice is remembered');
    assert.equal(rings.rows.length, bars.rows.length, 'same categories in both views');
    rings.rows.forEach((ring, i) => {
      const bar = bars.rows[i];
      assert.equal(ring.id, bar.id);
      assert.equal(ring.name, bar.name, ring.id + ': same name in both views');
      assert.equal(ring.pair, bar.pair, ring.id + ': same printed pair in both views');
      assert.equal(ring.label, bar.label, ring.id + ': same accessible name in both views');
      assert.equal(ring.pct, bar.pct, ring.id + ': same share behind both views');
      assert.equal(ring.bar, false, ring.id + ': no bar is drawn in the rings view');
      assert.equal(ring.arcShown, true, ring.id + ': the ring is drawn in the rings view');
    });
    assert.equal(rings.totals, bars.totals, 'the totals row is the same in both views');

    // 6. The choice survives a reload, and switching back is remembered too.
    await page.reload();
    await page.locator('[data-blend-rings]').waitFor();
    assert.equal((await read(page)).view, 'rings', 'rings is still chosen after a reload');
    await choose(page, 'Bars');
    assert.equal(await stored(page), 'bars');
    assert.equal((await read(page)).view, 'bars');

    // 5. A bar opens the same category detail the ring opens.
    await page.locator('.blend-ring[data-blend-cat="groceries"]').click();
    await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-budget-detail-sheet]')?.open);
    await page.context().close();

    // 4. Spending not observed: no fill, never a zero-looking bar.
    // The next pay period publishes Not observed categories (same fixture).
    const unknownPage = await open();
    const rangeText = () => [...document.querySelectorAll('[data-budget-window-range]')].map(e => e.innerText).join('|');
    const before = await unknownPage.evaluate(rangeText);
    await unknownPage.evaluate(() => {
      const next = [...document.querySelectorAll('[data-budget-window-step="1"]')].find(b => b.getAttribute('aria-disabled') !== 'true');
      if (next) next.click();
    });
    await unknownPage.waitForFunction(was => [...document.querySelectorAll('[data-budget-window-range]')].map(e => e.innerText).join('|') !== was, before);
    await unknownPage.locator('[data-blend-rings]').waitFor();
    const unknown = await read(unknownPage);
    assert.equal(unknown.view, 'bars', 'a newly drawn period opens in the same view');
    assert.deepEqual(unknown.pressed, ['Bars'], 'the switch is redrawn with the period');
    const unobserved = unknown.rows.filter(r => !r.known);
    assert.ok(unobserved.length > 0, 'the next period leaves a spent share unknown');
    for (const row of unobserved) {
      assert.equal(row.pct, '', row.id + ': no share is set');
      assert.ok(row.bar, row.id + ': the empty track is still drawn');
      assert.ok(/repeating-linear-gradient/.test(row.barImage), row.id + ': an unknown share is hatched, not filled');
    }
    await unknownPage.context().close();

    // 6b. Storage denied: default view, switch still works, no error.
    const denied = await open({ denyStorage: true });
    assert.equal((await read(denied)).view, 'bars', 'default view applies when storage is denied');
    await choose(denied, 'Rings');
    assert.equal((await read(denied)).view, 'rings', 'the switch still works without storage');
    await denied.context().close();

    // 7. Phone width: no sideways scroll, bars inside the card.
    const phone = await open({ width: 390 });
    const fit = await phone.evaluate(() => {
      const card = document.querySelector('[data-budget-browse="spending"]').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.blend-ring')];
      const rows = buttons.map(b => b.getBoundingClientRect());
      return { page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        inside: rows.every(r => r.left >= card.left - 1 && r.right <= card.right + 1),
        // Names start at the row's left edge (a phone-only rule once centred them).
        left: buttons.every(b => b.querySelector('.blend-ring-v').getBoundingClientRect().left - b.getBoundingClientRect().left <= 12) };
    });
    assert.ok(fit.page, 'no sideways scroll at 390px');
    assert.ok(fit.inside, 'every bar sits inside the card at 390px');
    assert.ok(fit.left, 'category names are left-aligned at 390px');
    await phone.context().close();

    // 8. Edge shares, through the real page. Invented spending added to the
    // same fixture: Eating out exactly on plan (60.00 of 60.00) and Groceries
    // over plan (110.37 + 150.00 = 260.37 of 220.00). Expected from those
    // inputs alone: a full bar that is NOT marked over at exactly 100%, and
    // the over colour past it.
    const edge = await open({ data: require('./fixtures/other-period-target').build(137.26, undefined, {
      extraTx: [{ amount: 60, categoryLabel: 'Restaurants' }, { amount: 150, categoryLabel: 'Groceries' }] }).data });
    const edgeRead = () => edge.evaluate(() => [...document.querySelectorAll('.blend-ring')].map(button => {
      const after = getComputedStyle(button, '::after');
      const stop = /(\d+(?:\.\d+)?)%/.exec(after.backgroundImage || '');
      const pill = button.querySelector('.blend-over-pill');
      return { id: button.getAttribute('data-blend-cat'), over: button.classList.contains('is-over'),
        pct: button.style.getPropertyValue('--pct'), stop: stop ? Number(stop[1]) / 100 : null,
        image: after.backgroundImage, colour: after.backgroundColor,
        overColour: pill ? getComputedStyle(pill).color : null, pill: pill ? pill.textContent.replace(/\s+/g, ' ').trim() : null,
        pair: (button.querySelector('.blend-ring-l')?.textContent || '').replace(/\s+/g, ' ').trim(),
        label: button.getAttribute('aria-label') };
    }));
    const edgeBars = await edgeRead();
    const full = edgeBars.find(r => r.id === 'restaurants'), over = edgeBars.find(r => r.id === 'groceries');
    assert.ok(full && over, 'the two edge categories are on the face');
    assert.equal(Number(full.pct), 1, 'exactly on plan is a share of exactly 1');
    assert.equal(full.over, false, 'exactly on plan is not over plan');
    assert.equal(full.stop, 1, 'exactly on plan fills the whole bar');
    assert.ok(/linear-gradient/.test(full.image), 'exactly on plan keeps the category colour');
    assert.equal(over.over, true, 'spending past the plan is over plan');
    assert.equal(over.image, 'none', 'an over-plan bar is one solid colour');
    assert.equal(over.colour, over.overColour, 'an over-plan bar uses the Over plan colour');
    assert.ok(/Over plan/.test(over.pill), 'the Over plan pill stays on the bar');
    // Repeated switching: nothing duplicates, nothing drifts, the last choice is the stored one.
    const firstRings = await (async () => { await choose(edge, 'Rings'); return edgeRead(); })();
    for (const name of ['Bars', 'Rings', 'Bars', 'Bars', 'Rings', 'Rings', 'Bars']) await choose(edge, name);
    const afterToggles = await edgeRead();
    assert.deepEqual(afterToggles, edgeBars, 'the bars read exactly the same after repeated switching');
    assert.deepEqual(firstRings.map(r => [r.id, r.pair, r.label, r.pct, r.pill]), edgeBars.map(r => [r.id, r.pair, r.label, r.pct, r.pill]),
      'edge categories print the same pair, label, share and pill in both views');
    assert.equal(await edge.locator('[data-blend-house-views]').count(), 1, 'one switch after repeated switching');
    assert.equal(await edge.locator('[data-blend-rings]').count(), 1, 'one set of categories after repeated switching');
    assert.equal(await stored(edge), 'bars', 'the last choice is the stored one');
    await edge.context().close();

    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(external, [], 'no external requests');
    console.log('browser-budget-house-bars: PASS');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
