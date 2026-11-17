'use strict';
// The unique coverage of the retired browser-budget-v3-period.js, re-expressed
// on the Budget face a household actually reads (budget-blend.js): the
// visible openers, not the hidden native rows the face prints from.
//
//   1. Household reserve: the visible "Household budget ›" opener reaches the
//      protective spending reserve Info, which starts closed, opens by
//      keyboard and prints $752.99; the hero prints $1,632.01, estimated.
//   2. Future-period goal requirements: on the next pay period, reached
//      through the visible period slider, period requirements do not stand in
//      for the missing observed savings stock, and the future goal prints its
//      requirement beside an unknown fulfilment, never "Current Forecast
//      requirement".
//   3. Unassigned Other spending (no target) is the unknown state: no share,
//      a hatched track in the default Bars view, the plan side Unavailable;
//      a known category beside it is not hatched.
//   4. An ambiguous bill occurrence opens all of that bill's evidence instead
//      of picking one payment.
//   5. Evidence-node identity and focus survive refresh and resize: an open
//      sheet refreshes to the fresh incumbent node, and dismissal returns
//      focus, visibly, to the exact visible trigger.
//
// Every figure below is hand-derived from the invented fixture
// (test/fixtures/budget-surface-data.js, pay period Aug 14-27, as of Aug 20):
//   income      2,600 received + 1,450 expected                    = 4,050
//   bills       1,400 mortgage + 120 hydro + 85 internet + 60 card  = 1,665
//   reserve     450 groceries + 160 fuel + 120 eating out
//               + 22.99 unassigned Other (no target, counted once) =   752.99
//   result      4,050 - 1,665 - 752.99                             = 1,632.01
//   groceries   212.40 + 96.15 = 308.55 spent of 450.00
//   Other       22.99 spent, no plan; the face pair rounds up to $23
//   School trip (400 by Sep 12) requires $195.00 in Aug 28 - Sep 10, as the
//   retired suite asserted; its fulfilment is not observed.
// Every request is intercepted; no server, provider or household data.
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-budget-period-face.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');

const norm = text => String(text || '').replace(/\s+/g, ' ').trim();

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [];
  const external = [];
  try {
    const open = async (width, options = {}) => {
      const page = await browser.newPage({ viewport: { width, height: 1000 },
        colorScheme: 'light', reducedMotion: 'reduce' });
      page.on('pageerror', err => errors.push(err.message));
      const data = fx.served(options);
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) {
          return route.fulfill({ json: null });
        }
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css')
          ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.locator('[data-budget-surface]').waitFor();
      await page.locator('[data-blend-rings]').waitFor();
      assert.equal(await page.evaluate(() => App.data.meta.title), 'Synthetic Budget surface');
      return page;
    };
    // Closing a sheet steps history back asynchronously; wait until the
    // dialog state and the history entry agree before the next interaction.
    const settled = page => page.waitForFunction(() =>
      !!document.querySelector('dialog[open]') === !!(history.state && history.state.atlasSheet));
    const sheetOpen = page => page.locator('[data-budget-detail-sheet][open]').waitFor({ state: 'visible' });
    const sheetClosed = async page => {
      await page.waitForFunction(() => !document.querySelector('[data-budget-detail-sheet]')?.open);
      await settled(page);
    };
    // The visible trigger regains focus: same selector, painted, hit-testable,
    // inside the viewport and clear of a fixed household dock.
    const focusReturnsTo = async (page, selector, what) => {
      await page.waitForFunction(sel => {
        const node = document.querySelector(sel);
        return !!node && node === document.activeElement;
      }, selector, { timeout: 5000 }).catch(() => {});
      const state = await page.evaluate(sel => {
        const node = document.querySelector(sel);
        if (!node) return { found: false };
        const r = node.getBoundingClientRect();
        const dock = document.querySelector('.sitenav-household');
        const limit = dock && getComputedStyle(dock).position === 'fixed' ? dock.getBoundingClientRect().top : innerHeight;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { found: true, focused: node === document.activeElement,
          painted: r.width > 8 && r.height > 8 && getComputedStyle(node).visibility !== 'hidden',
          inView: r.top >= 0 && r.bottom <= limit && r.left >= 0 && r.right <= innerWidth,
          hit: hit === node || node.contains(hit),
          active: document.activeElement && document.activeElement.outerHTML.slice(0, 120) };
      }, selector);
      assert.deepEqual({ found: state.found, focused: state.focused, painted: state.painted, inView: state.inView, hit: state.hit },
        { found: true, focused: true, painted: true, inView: true, hit: true },
        `${what}: focus returns, visibly, to the exact trigger ${selector} (active: ${state.active})`);
    };
    const selectedPeriod = page => page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
    const stepRiver = async (page, key) => {
      const before = await selectedPeriod(page);
      const river = page.locator('.river[role="slider"]');
      await river.focus();
      await page.keyboard.press(key);
      await page.waitForFunction(was => document.querySelector('[data-pay-period-swipe]')
        ?.getAttribute('data-selected-pay-period') !== was, before);
      await page.locator('[data-blend-rings]').waitFor();
      return selectedPeriod(page);
    };

    for (const width of [1440, 390]) {
      const page = await open(width);
      const where = `${width}px`;

      // 1. Household reserve through the visible Household evidence opener.
      const heroResult = page.locator('[data-blend-figures-open]');
      assert.equal(await heroResult.isVisible(), true, `${where}: the hero result is on the face`);
      assert.match(norm(await heroResult.innerText()), /\$1,632\.01/, `${where}: hero result 4,050 - 1,665 - 752.99`);
      assert.match(norm(await heroResult.innerText()), /estimated/, `${where}: the hero result keeps its estimated tag`);
      const householdSel = '[data-budget-browse-evidence="06"]';
      const household = page.locator(householdSel);
      assert.equal(await household.isVisible(), true, `${where}: the Household evidence opener is visible`);
      assert.equal(norm(await household.innerText()), 'Household budget ›');
      assert.equal(await page.locator('[data-budget-reserve-info]').isVisible(), false,
        `${where}: the reserve Info is not on the face by default`);
      await household.focus();
      await page.keyboard.press('Enter');
      await sheetOpen(page);
      assert.equal(await page.locator('[data-budget-detail-title]').innerText(), 'Household budget evidence');
      const reserve = page.locator('[data-budget-detail-body] [data-budget-reserve-info]');
      assert.equal(await reserve.count(), 1, `${where}: the Household evidence carries the reserve Info`);
      assert.equal(await reserve.evaluate(node => node.open), false, `${where}: the protective reserve Info starts closed`);
      const reserveAmount = reserve.locator('[data-household-budget-total-amount]');
      assert.equal(await reserveAmount.isVisible(), false, `${where}: the reserve amount is behind its Info`);
      await reserve.locator(':scope > summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await reserve.evaluate(node => node.open), true, `${where}: the reserve Info opens by keyboard`);
      assert.equal(await reserveAmount.isVisible(), true, `${where}: the reserve amount is keyboard reachable`);
      assert.equal(norm(await reserveAmount.innerText()), '$752.99',
        `${where}: reserve 450 + 160 + 120 + 22.99 unassigned`);
      assert.match(norm(await reserve.innerText()), /Protective spending reserve/);
      await page.keyboard.press('Escape');
      await sheetClosed(page);
      await focusReturnsTo(page, householdSel, `${where} Household reserve`);

      // 3. Unassigned Other spending without a target is the unknown state.
      const ringState = id => page.evaluate(cat => {
        const ring = document.querySelector('.blend-ring[data-blend-cat="' + CSS.escape(cat) + '"]');
        const after = ring && getComputedStyle(ring, '::after');
        return ring && { known: ring.classList.contains('is-known'), unknown: ring.classList.contains('is-unknown'),
          pct: ring.style.getPropertyValue('--pct'), pair: (ring.querySelector('.blend-ring-l')?.textContent || '').replace(/\s+/g, ' ').trim(),
          label: ring.getAttribute('aria-label') || '', view: ring.closest('[data-blend-rings]')?.getAttribute('data-blend-house-view'),
          barDrawn: after.content !== 'none' && parseFloat(after.height) > 0, barImage: after.backgroundImage,
          visible: ring.getClientRects().length > 0 };
      }, id);
      const other = await ringState('other-spending');
      assert.ok(other && other.visible, `${where}: the Other ring is on the face`);
      assert.equal(other.view, 'bars', `${where}: the default Household view is Bars`);
      assert.deepEqual({ known: other.known, unknown: other.unknown, pct: other.pct },
        { known: false, unknown: true, pct: '' }, `${where}: unassigned Other has no share; it is the unknown state`);
      assert.equal(other.pair, 'Spent $23 / of planned Unavailable',
        `${where}: the observed 22.99 is printed, the missing plan side is Unavailable, never zero`);
      assert.match(other.label, /\$22\.99/);
      assert.match(other.label, /Not yet assigned to a budget category/);
      assert.ok(other.barDrawn, `${where}: the Other track is still drawn`);
      assert.match(other.barImage, /repeating-linear-gradient/, `${where}: the unknown Other track is hatched`);
      const groceries = await ringState('groceries');
      assert.deepEqual({ known: groceries.known, unknown: groceries.unknown }, { known: true, unknown: false });
      assert.ok(Math.abs(Number(groceries.pct) - 308.55 / 450) < 0.001, `${where}: groceries share 308.55 / 450`);
      assert.doesNotMatch(groceries.barImage, /repeating-linear-gradient/, `${where}: a known share is never the unknown hatch`);

      // 2. Future-period goal requirements, through the visible slider.
      assert.equal(await page.locator('[data-budget-window-header]').first().isVisible(), false,
        `${where}: the native period arrows are hidden; the slider is the control`);
      assert.equal(await stepRiver(page, 'ArrowRight'), 'next-pay-period');
      assert.equal(await page.locator('.river[role="slider"]').evaluate(node => node === document.activeElement), true,
        `${where}: the slider keeps focus after stepping`);
      assert.match(norm(await page.locator('[data-budget-window-range]').first().textContent()), /Aug 28.*Sep 10/);
      const savingsValue = page.locator('[data-operating-question="savings"] .budget-step-value');
      assert.equal(await savingsValue.isVisible(), true, `${where}: the savings stock is on the face`);
      assert.equal(norm(await savingsValue.innerText()), 'Unavailable',
        `${where}: period requirements cannot substitute for missing observed savings stock`);
      assert.equal(await page.locator('[data-operating-question="savings"] [data-budget-ratio]').count(), 0,
        `${where}: no requirement-derived ratio stands in for the stock`);
      assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /Current Forecast requirement/,
        `${where}: the future period prints no "Current Forecast requirement"`);
      const goalSel = '[data-budget-savings-goals] [data-blend-goal="school-trip"]';
      const goal = page.locator(goalSel);
      assert.equal(norm(await goal.innerText()), 'School trip Not confirmed',
        `${where}: the future goal row reads Not confirmed, not a fulfilled amount`);
      await goal.focus();
      await page.keyboard.press('Enter');
      const explain = page.locator('dialog[open] [data-blend-explain-body]');
      await explain.waitFor({ state: 'visible' });
      assert.equal(norm(await explain.locator('[data-blend-explain-fact="fulfilled"] dd').innerText()), 'Unknown',
        `${where}: future fulfilment is unknown`);
      assert.match(norm(await explain.locator('[data-blend-explain-fact="required-this-period"] dd').innerText()),
        /^≈ estimated \$195\.00$/, `${where}: the period requirement is printed as an estimate`);
      assert.doesNotMatch(norm(await explain.innerText()), /Current Forecast requirement/);
      await explain.locator('[data-blend-explain-evidence]').focus();
      await page.keyboard.press('Enter');
      await sheetOpen(page);
      const fulfilment = page.locator('[data-budget-detail-body] [data-budget-goal-fulfillment-evidence="school-trip"]');
      assert.equal(await fulfilment.count(), 1, `${where}: the goal evidence is the selected goal's own record`);
      assert.match(norm(await fulfilment.innerText()),
        /Aug 28.*Sep 10.*Required this period: ≈ estimated \$195\.00.*Confirmed fulfilled this period: Unavailable.*Remaining this period: Unavailable.*Not confirmed/,
        `${where}: requirement printed, fulfilment and remaining unavailable`);
      assert.doesNotMatch(norm(await fulfilment.innerText()), /Current Forecast requirement/);
      await page.keyboard.press('Escape');
      await sheetClosed(page);
      await focusReturnsTo(page, goalSel, `${where} future goal`);
      assert.equal(await stepRiver(page, 'ArrowLeft'), 'this-pay-period');
      assert.match(norm(await page.locator('[data-budget-window-range]').first().textContent()), /Aug 14.*Aug 27/);

      // 4. An ambiguous bill occurrence opens all of that bill's evidence.
      const hydroSel = '.blend-bill-item[data-blend-bill="hydro:2026-08-18"]';
      const hydro = page.locator(hydroSel);
      assert.equal(await hydro.isVisible(), true, `${where}: Hydro is on the face`);
      await hydro.click();
      await sheetOpen(page);
      assert.equal(await page.locator('[data-budget-detail-body] > [data-bill-detail]').count(), 1,
        `${where}: control: one occurrence opens exactly that occurrence`);
      assert.equal(await page.locator('[data-budget-detail-body] > .budget-step-body').count(), 0);
      await page.keyboard.press('Escape');
      await sheetClosed(page);
      await page.locator('[data-period-bill="hydro"]').evaluate(node => {
        const detail = node.closest('[data-bill-detail]');
        const duplicate = detail.cloneNode(true);
        duplicate.setAttribute('data-test-ambiguous', '');
        detail.parentNode.appendChild(duplicate);
      });
      assert.equal(await page.locator('[data-period-bill="hydro"][data-bill-date="2026-08-18"]').count(), 2,
        `${where}: the fixture now publishes two Hydro occurrences on one date`);
      await hydro.focus();
      await page.keyboard.press('Enter');
      await sheetOpen(page);
      assert.equal(await page.locator('[data-budget-detail-body] > .budget-step-body').count(), 1,
        `${where}: an ambiguous occurrence opens all bill evidence instead of an arbitrary payment`);
      assert.equal(await page.locator('[data-budget-detail-body] [data-period-bill="hydro"]').count(), 2,
        `${where}: both ambiguous occurrences stay available`);
      assert.match(norm(await page.locator('[data-budget-detail-body]').textContent()), /Mortgage.*Hydro.*Internet/,
        `${where}: the whole bill evidence is open, not one payment`);
      assert.match(await page.locator('[data-budget-detail-body]').textContent(), /Missing evidence does not mean unpaid/);
      await page.keyboard.press('Escape');
      await sheetClosed(page);
      await focusReturnsTo(page, hydroSel, `${where} ambiguous Hydro`);
      await page.locator('[data-test-ambiguous]').evaluate(node => node.remove());

      // 5. Evidence identity and focus survive refresh and resize.
      for (const [name, selector, source] of [
        ['category', '.blend-ring[data-blend-cat="groceries"]', '[data-budget-category="groceries"]'],
        ['bill', hydroSel, '[data-bill-detail]:has(> [data-period-bill="hydro"])'],
        ['household', householdSel, '.budget-step-body'],
      ]) {
        const trigger = page.locator(selector);
        await trigger.scrollIntoViewIfNeeded();
        await trigger.focus();
        await page.keyboard.press('Enter');
        await sheetOpen(page);
        const body = page.locator(`[data-budget-detail-body] > ${source}`);
        assert.equal(await body.count(), 1, `${where} ${name}: the sheet holds the incumbent evidence`);
        // Compare the evidence, not the bill-state badge: budget-polish.js
        // decorates bill summaries only inside the operating surface, so a
        // bill refreshed while its sheet is open keeps the plain
        // "· to confirm" label until it returns to its source (reported
        // with this port; the status words and amount are unchanged).
        const evidenceText = () => body.evaluate(node => {
          const copy = node.cloneNode(true);
          if (copy.matches('[data-bill-detail]')) copy.querySelector(':scope > summary')?.remove();
          return copy.textContent.replace(/\s+/g, ' ').trim();
        });
        const beforeText = await evidenceText();
        await body.evaluate(node => { window.__beforeRefresh = node; });
        await page.evaluate(() => App.rerender());
        await page.waitForFunction(sel => document.querySelector('[data-budget-detail-sheet]')?.open
          && document.querySelectorAll('[data-budget-detail-body] > ' + sel).length === 1, source);
        assert.equal(await body.evaluate(node => node !== window.__beforeRefresh && node.isConnected), true,
          `${where} ${name}: refresh reopens the fresh incumbent evidence, not a cached node`);
        assert.equal(await evidenceText(), beforeText, `${where} ${name}: refreshed evidence reads the same`);
        if (name === 'bill') {
          assert.match(norm(await body.locator(':scope > summary').textContent()), /Hydro · Aug 18.*to confirm.*−\$120\.00/i,
            `${where}: the refreshed bill keeps its status words and amount`);
        }
        if (name === 'category') {
          assert.match(norm(await body.innerText()), /Synthetic grocer.*\$212\.40.*Synthetic market.*\$96\.15/,
            `${where}: groceries evidence lists 212.40 + 96.15`);
        }
        if (width === 390) {
          await page.locator('[data-budget-detail-sheet]').evaluate(node => { window.__beforeResize = node; });
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page.waitForFunction(sel => {
            const dialog = document.querySelector('[data-budget-detail-sheet]');
            return dialog?.open && !!document.activeElement?.closest('[data-budget-detail-sheet]')
              && document.querySelectorAll('[data-budget-detail-body] > ' + sel).length === 1;
          }, source);
          assert.equal(await evidenceText(), beforeText, `${name}: resized evidence reads the same`);
        }
        await page.keyboard.press('Escape');
        await sheetClosed(page);
        await focusReturnsTo(page, selector, `${where} ${name} after refresh${width === 390 ? ' and resize' : ''}`);
        if (width === 390) {
          // matchMedia changes before the page's change listener remounts;
          // wait for that real remount before opening the next sheet.
          await page.locator('[data-budget-detail-sheet]').evaluate(node => { window.__beforeResize = node; });
          await page.setViewportSize({ width: 390, height: 1000 });
          await page.waitForFunction(() => {
            const dialog = document.querySelector('[data-budget-detail-sheet]');
            return matchMedia('(max-width:640px)').matches && dialog && dialog !== window.__beforeResize && !dialog.open;
          });
          await page.locator('[data-blend-rings]').waitFor();
          await settled(page);
        }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
        `${where}: no horizontal page scroll`);
      await page.close();
      console.log(`PASS ${where}: household reserve, future goal requirement, unassigned Other unknown, ambiguous bill, refresh/resize focus`);
    }
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(external, [], 'no external requests');
    console.log('PASS budget period face: retired v3-period coverage on the visible Budget face');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
