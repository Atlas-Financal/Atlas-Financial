'use strict';
const { stepPeriod, openPeriodFigures } = require('./helpers/visible-period-navigation');
// Optional actual-page proof. Independent invented observation/overlay fixture;
// every request is intercepted, and no server or provider credential is used.
// CHROME_PATH=<Chromium executable> node test/browser-budget-v3-period.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const screenshots = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR
  || path.join(require('node:os').tmpdir(), 'atlas-budget-v3-period');
fs.mkdirSync(screenshots, { recursive: true });
async function geometry(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'no horizontal page scroll');
  const escaped = await page.locator('.budget-step-summary,.budget-category-row,.budget-bill-row').evaluateAll(rows => rows.flatMap(row =>
    [...row.children].filter(el => {
      const a = el.getBoundingClientRect(), b = row.getBoundingClientRect();
      return a.width && (a.left < b.left - 1 || a.right > b.right + 1 || el.scrollWidth > el.clientWidth + 1);
    }).map(el => ({className:el.className, text:el.textContent, scroll:el.scrollWidth, client:el.clientWidth}))));
  assert.deepEqual(escaped, [], 'summary children fit their row');
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [];
  try {
    for (const width of [1440, 390, 320]) {
      let data = fx.served();
      const page = await browser.newPage({ viewport: { width, height: 1000 },
        colorScheme: 'light', reducedMotion: 'reduce' });
      const screenshot = async options => {
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        return page.screenshot({ animations: 'disabled', ...options });
      };
      page.on('pageerror', err => errors.push(err.message));
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
      const boot = async () => {
        await page.goto('http://budget.test/');
        await page.locator('[data-budget-surface]').waitFor();
        assert.equal(await page.evaluate(() => App.data.meta.title), 'Synthetic Budget surface');
      };
      await boot();
      await geometry(page);
      const reserveInfo=page.locator('[data-budget-browse="spending"] [data-budget-browse-evidence="06"]');
      assert.match(await reserveInfo.innerText(),/^Info$/);
      assert.doesNotMatch(await page.locator('[data-budget-browse="spending"]').innerText(),/whichever is higher/,
        'actual/original-plan browse does not carry the reserve explanation by default');
      assert.equal(await page.locator('[data-budget-reserve-rule]').isVisible(),false);
      await reserveInfo.focus();await page.keyboard.press('Enter');
      const reserveDisclosure=page.locator('[data-budget-detail-body] [data-budget-reserve-info]');
      assert.equal(await reserveDisclosure.evaluate(node=>node.open),false,'protective reserve Info starts closed');
      assert.equal(await reserveDisclosure.locator('[data-household-budget-total-amount]').isVisible(),false);
      const reserveDisclosureTrigger=reserveDisclosure.locator(':scope > summary');
      await reserveDisclosureTrigger.focus();await page.keyboard.press('Enter');
      assert.equal(await reserveDisclosure.locator('[data-household-budget-total-amount]').isVisible(),true,'reserve remains keyboard reachable');
      assert.match(await page.locator('[data-budget-detail-body]').innerText(),/Reserve calculation:[\s\S]*whichever is higher[\s\S]*unassigned spending/);
      assert.match(await page.locator('[data-budget-detail-body] [data-household-budget-total-amount]').innerText(),/752\.99/);
      await screenshot({path:path.join(screenshots,`reserve-info-${width}.png`),fullPage:false});
      await page.keyboard.press('Escape');
      assert.equal(await reserveInfo.evaluate(node=>node===document.activeElement),true,'Info returns to its exact spending trigger');
      await page.evaluate(()=>window.scrollTo(0,0));
      const trackBounds = await page.locator('[data-calendar-waterfall] .budget-waterfall-track').evaluateAll(rows => rows.filter(row => getComputedStyle(row).display !== 'none').map(row => {
        const r = row.getBoundingClientRect(); return [r.left, r.width];
      }));
      assert.ok(trackBounds.every(([left, width]) => Math.abs(left - trackBounds[0][0]) < .01
        && Math.abs(width - trackBounds[0][1]) < .01), 'visible deduction tracks share the same rendered origin and width');
      for (const id of ['05', '07']) assert.equal(await page.locator(`[data-operating-question="${id}"] .budget-waterfall-track`).isVisible(), false,
        'derived balance rows show their numeric value without a progress claim');
      const hero = page.locator('[data-budget-period-result]');
      assert.match(await hero.innerText(), /1,632\.01/); // 4050 - 1665 - 752.99
      assert.match(await hero.innerText(), /estimated/);
      assert.doesNotMatch(await hero.locator('summary').innerText(), /Before savings|After proposed funding/);
      for (const id of ['02','04','06','savings','07']) assert.equal(await page.locator(`[data-operating-question="${id}"] > details > summary .budget-step-caption`).count(),0,
        'owner-requested totals have no descriptive subtitles');
      const overview = page.locator('.budget-surface-grid > .budget-surface-card');
      assert.equal(await overview.count(), 1, 'one primary current-balance-to-deductions overview');
      assert.equal(await overview.locator('[data-live-current-balance-amount]').count(), 1);
      assert.equal(await overview.locator('[data-budget-period-result]').count(), 1);
      assert.equal(await page.locator('[data-budget-period-result]').count(), 1);
      assert.equal(await page.locator('[data-operating-question="07"] .budget-step-body').innerText().then(text => text.includes('$1,632.01')), false,
        'expanded result explains scope without repeating the final amount');
      assert.equal(await page.locator('[data-budget-cash-hero]').innerText(), '$1,215.00');
      assert.match(await page.locator('.budget-cash-sub').innerText(), /Bills account only/);
      assert.equal(await page.locator('[data-live-current-balance-amount]').count(), 1);
      assert.equal(await page.locator('[data-budget-today-evidence]').isVisible(), false);
      assert.equal(await page.locator('[data-budget-cash-answer]').isVisible(), false);
      assert.equal(await page.locator('[data-budget-cash-detail]').isVisible(), false);
      assert.equal(await page.locator('[data-budget-cash-keep]').isVisible(), false);
      assert.equal(await page.locator('[data-from-today-proposal]').isVisible(), false);
      assert.equal(await page.locator('.budget-surface-today').evaluate(el => getComputedStyle(el).position), 'static');
      assert.match(await page.locator('[data-budget-window-range]').innerText(), /Aug 14.*Aug 27/);
      assert.match(await page.locator('[data-budget-window-progress]').innerText(), /Day 7 of 14[\s\S]*Aug 28.*8 days/);
      assert.equal(await page.locator('.budget-window-days > span').count(), 14);
      assert.equal(await page.locator('.budget-window-days > .is-today').count(), 1);
      assert.equal(await page.locator('[data-budget-wheel="period"]').isVisible(), false);
      const selectedId = await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
      // #548 replaces the modal wheel with a visible keyboard slider.
      const choosePeriod = page.getByRole('slider', { name: 'Pay period', exact: true });
      await choosePeriod.focus();
      assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el => el.open), false);
      assert.equal(await choosePeriod.evaluate(el => el === document.activeElement), true);
      if (width === 390) await screenshot({ path: path.join(screenshots, 'period-picker-390.png'), fullPage: true });
      await stepPeriod(page, 'ArrowRight');
      assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el => el.open), false);
      assert.match(await page.locator('[data-budget-window-range]').innerText(), /Aug 28.*Sep 10/);
      assert.match(await page.locator('[data-budget-goal-open="school-trip"] [data-budget-goal-required]').innerText(), /195\.00/);
      assert.match(await page.locator('[data-budget-goal-open="school-trip"] [data-budget-goal-fulfilled]').innerText(), /Unknown/);
      assert.equal(await page.locator('[data-operating-question="savings"] .budget-step-value').innerText(), 'Unavailable',
        'period requirements cannot substitute for missing observed savings stock');
      assert.equal(await page.locator('[data-operating-question="savings"] [data-budget-ratio]').count(), 0);
      assert.match(await page.locator('[data-budget-browse="spending"]').innerText(), /Projected plan.*spending not observed/);
      assert.equal(await page.locator('[data-budget-browse-remaining]').count(), 0, 'future selection does not borrow current remaining spending');
      assert.equal(await choosePeriod.evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('[data-budget-cash-hero]').innerText(), '$1,215.00');
      await stepPeriod(page, 'ArrowLeft');
      assert.equal(await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period'), selectedId);
      await page.keyboard.press('Escape');
      assert.equal(await choosePeriod.evaluate(el => el === document.activeElement), true);
      await stepPeriod(page, 'ArrowRight');
      assert.match(await page.locator('[data-budget-window-range]').innerText(), /Aug 28.*Sep 10/);
      assert.equal(await choosePeriod.evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('.budget-window-days > .is-today').count(), 0);
      await screenshot({path:path.join(screenshots,`future-requirements-${width}.png`),fullPage:true});
      const futureGoal=page.locator('[data-budget-goal-open="school-trip"]');
      assert.match(await futureGoal.innerText(),/Not confirmed[\s\S]*Unknown[\s\S]*195\.00[\s\S]*Required this period[\s\S]*Current Forecast requirement/);
      await futureGoal.focus();await page.keyboard.press('Enter');
      assert.match(await page.locator('[data-budget-detail-body] [data-budget-goal-fulfillment-evidence="school-trip"]').innerText(),
        /Required this period[\s\S]*195\.00[\s\S]*Confirmed fulfilled this period: Unavailable[\s\S]*Remaining this period: Unavailable[\s\S]*Not confirmed/);
      await page.keyboard.press('Escape');
      assert.equal(await futureGoal.evaluate(node=>node===document.activeElement),true);
      await page.locator('[data-budget-savings-goals]').screenshot({path:path.join(screenshots,`goal-requirements-${width}.png`),animations:'disabled',style:'.sitenav-household { visibility:hidden !important; }'});
      await stepPeriod(page, 'ArrowLeft', 'mouse');
      assert.equal(await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period'), selectedId);
      const focusVisible = locator => locator.evaluate(el => {
        const r = el.getBoundingClientRect(), modalBody = el.closest('[data-budget-detail-body]');
        const dock = document.querySelector('.sitenav-household');
        const limit = modalBody ? Math.min(innerHeight, modalBody.getBoundingClientRect().bottom)
          : dock && getComputedStyle(dock).position === 'fixed' ? dock.getBoundingClientRect().top : innerHeight;
        return r.top >= (modalBody ? modalBody.getBoundingClientRect().top : 0) && r.bottom <= limit;
      });
      const grocery = page.locator('[data-budget-category-open="groceries"][data-budget-browse-origin="spending"]');
      assert.match(await grocery.locator('.budget-category-meta').innerText(), /308\.55[\s\S]*\/[\s\S]*450\.00/);
      assert.match(await grocery.locator('.budget-category-status').innerText(), /141\.45 left/);
      const fill = await grocery.locator('.budget-category-fill').evaluate(el => parseFloat(el.style.width));
      assert.ok(Math.abs(fill - 308.55 / 450 * 100) < .001, 'independent category ratio within CSS percentage serialization precision');
      const hatch = await page.locator('[data-budget-category-open="other-spending"][data-budget-browse-origin="spending"] .budget-category-bar').evaluate(el => {
        const r = el.getBoundingClientRect(); return {width:r.width,height:r.height,image:getComputedStyle(el).backgroundImage};
      });
      assert.ok(hatch.width > 0 && hatch.height > 0, `unassigned track visible: ${JSON.stringify(hatch)}`);
      assert.match(hatch.image, /repeating-linear-gradient/);
      assert.match(await page.locator('[data-budget-browse="bills"] [data-budget-ratio]').innerText(), /1,400\.00[\s\S]*1,665\.00/);
      assert.equal(await page.locator('[data-budget-browse="bills"] [data-budget-progress-partial]').innerText(), '*');
      assert.doesNotMatch(await page.locator('[data-budget-browse="bills"]').innerText(), /Partial actuals|Paid \/ original scheduled plan/);
      assert.equal(await page.locator('.budget-bills-progress-wrapper .budget-waterfall-bar').count(), 0,'unverified Hydro prevents a complete paid progress bar');
      assert.match(await page.locator('[data-budget-browse-hold]').innerText(), /444\.49[\s\S]*730\.00/);
      assert.match(await page.locator('[data-operating-question="02"] .budget-step-value').innerText(), /2,600\.00[\s\S]*4,050\.00/);
      assert.match(await page.locator('[data-budget-browse-remaining]').innerText(), /308\.50/);
      assert.match(await page.locator('[data-budget-browse-bills-remaining]').innerText(), /265\.00/);
      for (const id of ['groceries', 'fuel', 'restaurants', 'other-spending']) {
        const trigger = page.locator(`[data-budget-category-open="${id}"][data-budget-browse-origin="spending"]`);
        await page.locator(`[data-budget-category="${id}"]`).evaluate(node => { window.__browseSource = node; });
        await trigger.focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-budget-detail-body] > [data-budget-category]').evaluate(node => node === window.__browseSource), true);
        assert.equal(await page.locator('[data-budget-detail-body] [data-budget-spent]').evaluate(node => node.open), true);
        assert.equal(await focusVisible(page.locator('[data-budget-detail-body] .household-budget-spent-summary')), true);
        assert.ok(await page.locator('[data-budget-detail-body] .household-budget-tx').count() > 0);
        if (id === 'groceries') {
          assert.match(await page.locator('[data-budget-detail-body]').innerText(), /Synthetic grocer[\s\S]*212\.40[\s\S]*Synthetic market[\s\S]*96\.15/);
        }
        await page.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
        assert.equal(await focusVisible(trigger), true, 'category Back focus is visible above the dock');
        assert.equal(await page.locator(`[data-budget-category="${id}"]`).evaluate(node => node === window.__browseSource), true, `${width}px ${id}: original evidence node restored after Back`);
      }
      const paid = page.locator('[data-budget-bill-filter="paid"]');
      await paid.focus(); await page.keyboard.press('Enter');
      assert.equal(await paid.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-budget-bill-bucket="not-paid"]').isVisible(), false);
      assert.equal(await page.locator('[data-budget-bill-bucket="paid"]').isVisible(), true);
      await page.keyboard.press('Enter');
      const notPaid = page.locator('[data-budget-bill-filter="not-paid"]');
      await notPaid.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('[data-budget-bill-bucket="paid"]').isVisible(), false);
      assert.match(await page.locator('[data-budget-bill-bucket="not-paid"]').innerText(), /Not paid[\s\S]*Not confirmed/);
      await page.keyboard.press('Enter');
      for (const id of ['card-minimum', 'internet', 'hydro', 'mortgage']) {
        const trigger = page.locator(`[data-budget-bill-open="${id}"][data-budget-browse-origin="bills"]`);
        await page.locator(`[data-period-bill="${id}"]`).evaluate(node => { window.__browseBill = node.closest('[data-bill-detail]'); });
        await trigger.focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-budget-detail-body] > [data-bill-detail]').evaluate(node => node === window.__browseBill), true);
        assert.equal(await page.locator('[data-budget-detail-body] > [data-bill-detail]').evaluate(node => node.open), true);
        const evidence = await page.locator('[data-budget-detail-body]').innerText();
        assert.match(evidence, /Payment evidence/);
        if (id === 'mortgage') assert.match(evidence, /2026-08-15[\s\S]*1,400\.00[\s\S]*Synthetic bills account/);
        else assert.match(evidence, /Transaction evidence is unavailable for this bill occurrence\. Missing evidence does not mean unpaid\./);
        await page.locator('[data-budget-detail-close]').click();
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
        assert.equal(await focusVisible(trigger), true, 'bill Back focus is visible above the dock');
        assert.equal(await page.locator(`[data-period-bill="${id}"]`).evaluate(node => node.closest('[data-bill-detail]') === window.__browseBill), true);
      }
      assert.equal(await notPaid.getAttribute('aria-pressed'), 'false', 'clicking a selected filter restores all bills');
      // Capture separately from original-node identity checks: Chromium's
      // full-page capture can dispatch a phone media-query rerender.
      for (const [trigger, name] of [[grocery, 'category'], [page.locator('[data-budget-bill-open="hydro"][data-budget-browse-origin="bills"]'), 'bill']]) {
        await trigger.click();
        await screenshot({ path: path.join(screenshots, `${name}-sheet-${width}.png`), fullPage: false });
        await page.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
      }
      for (const trigger of [page.locator('[data-budget-browse-origin="attention"][data-budget-category-open]'), page.locator('[data-budget-browse-origin="attention"][data-budget-bill-open]')]) {
        await trigger.focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el => el.open), true);
        await page.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'attention returns to its own trigger, not the category/bill row');
        assert.equal(await focusVisible(trigger), true, 'attention Back focus is visible above the dock');
      }
      for (const [selector, sourceSelector, name] of [
        ['[data-budget-category-open="groceries"][data-budget-browse-origin="spending"]', '[data-budget-category="groceries"]', 'category'],
        ['[data-budget-bill-open="hydro"][data-budget-browse-origin="bills"]', '[data-bill-detail]:has(> summary[data-period-bill="hydro"])', 'bill'],
        ['[data-budget-category-open="other-spending"][data-budget-browse-origin="attention"]', '[data-budget-category="other-spending"]', 'attention'],
      ]) {
        const trigger = page.locator(selector);
        await trigger.focus(); await page.keyboard.press('Enter');
        // Establish the visible, original evidence sheet before forcing a
        // refresh; an outside hidden source is not proof that Enter opened it.
        await page.locator('[data-budget-detail-sheet]').waitFor({state:'visible'});
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el=>el.open), true);
        await page.locator(`[data-budget-detail-body] > ${sourceSelector}`).evaluate(node => { window.__beforeRerender = node; });
        await page.evaluate(() => App.rerender());
        await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open);
        assert.equal(await page.locator(`[data-budget-detail-body] > ${sourceSelector}`).evaluate(node => node !== window.__beforeRerender && node.isConnected), true,
          'sheet reopens the refreshed incumbent evidence, not a cached financial node');
        if (width === 390) {
          await page.locator('[data-budget-detail-sheet]').evaluate(node => { window.__beforeViewportDialog = node; });
          await page.setViewportSize({width:1440,height:1000});
          await page.waitForFunction(() => {
            const dialog = document.querySelector('[data-budget-detail-sheet]');
            return dialog !== window.__beforeViewportDialog && dialog?.open && !!document.activeElement.closest('[data-budget-detail-sheet]');
          });
          if (name !== 'bill') assert.equal(await focusVisible(page.locator('[data-budget-detail-body] .household-budget-spent-summary')), true);
          await screenshot({path:path.join(screenshots,`${name}-resized-1440.png`),fullPage:false});
        }
        await page.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true, `${name}: exact trigger after refresh/resize`);
        assert.equal(await focusVisible(trigger), true, `${name}: refreshed/resized Back target is visible`);
        if (width === 390) {
          await page.locator('[data-budget-detail-sheet]').evaluate(node => { window.__beforeViewportDialog = node; });
          await page.setViewportSize({width:390,height:1000});
          // matchMedia changes before App's change listener remounts the page.
          // Require that real remount before opening the next evidence sheet.
          await page.waitForFunction(() => {
            const dialog = document.querySelector('[data-budget-detail-sheet]');
            return matchMedia('(max-width:640px)').matches && dialog !== window.__beforeViewportDialog && dialog && !dialog.open;
          });
        }
      }
      if (width === 320) {
        await page.locator('[data-period-bill="hydro"]').evaluate(node => {
          const detail = node.closest('[data-bill-detail]'), duplicate = detail.cloneNode(true);
          duplicate.setAttribute('data-test-ambiguous', ''); detail.parentNode.appendChild(duplicate);
        });
        const trigger = page.locator('[data-budget-bill-open="hydro"][data-budget-browse-origin="bills"]');
        await trigger.click();
        assert.equal(await page.locator('[data-budget-detail-body] > .budget-step-body').count(), 1,
          'ambiguous occurrence opens all bill evidence instead of picking an arbitrary payment');
        assert.match(await page.locator('[data-budget-detail-body]').textContent(), /Missing evidence does not mean unpaid/);
        assert.equal(await page.locator('[data-budget-detail-body] [data-period-bill="hydro"]').count(), 2,
          'all ambiguous occurrences stay available in their native disclosures');
        await page.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
        await page.locator('[data-test-ambiguous]').evaluate(node => node.remove());
      }
      await page.evaluate(() => document.activeElement.blur()); await page.mouse.move(0,0);
      for (const part of ['spending','bills','attention']) await page.locator(`[data-budget-browse="${part}"]`).screenshot({path:path.join(screenshots,`${part}-${width}.png`),animations:'disabled',style:'.sitenav-household{visibility:hidden!important}'});
      if (width < 960) for (const section of ['spending', 'bills', 'upcoming']) {
        const trigger = page.locator(`[data-budget-section="${section}"]`);
        await trigger.focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el => el.open), false);
        const heading = page.locator(section === 'upcoming' ? '#budget-funding-heading' : `[data-budget-browse="${section}"] h2`);
        assert.equal(await heading.evaluate(el => el === document.activeElement), true);
        assert.equal(await focusVisible(heading), true, 'section heading is keyboard reachable above the dock');
        assert.equal(await trigger.getAttribute('aria-current'), 'location');
      }
      if (width < 960) await page.locator('[data-budget-section="overview"]').click();
      await screenshot({ path: path.join(screenshots, `current-${width}.png`), fullPage: true });
      const periodCropStyle = '.sitenav-household { visibility:hidden !important; }';
      await page.locator('[data-calendar-waterfall]').screenshot({ path: path.join(screenshots, `period-${width}.png`), style: periodCropStyle });
      // The compact sheet moves the incumbent evidence node, keeps the page
      // inert, and returns to the exact summary without duplicating its figures.
      for (const id of ['02', '04', '05', '06', 'savings', '07']) {
        const summary = page.locator(`[data-operating-question="${id}"] > details > summary`);
        await page.locator(`[data-operating-question="${id}"] .budget-step-body`).evaluate(node => { window.__originalBudgetEvidence = node; });
        await summary.focus();
        const focusBounds = await summary.evaluate(el => {
          const r = el.getBoundingClientRect(), dock = document.querySelector('.sitenav-household');
          const dockTop = dock && getComputedStyle(dock).position === 'fixed' ? dock.getBoundingClientRect().top : innerHeight;
          return {top:r.top,bottom:r.bottom,limit:dockTop};
        });
        assert.ok(focusBounds.top >= 0 && focusBounds.bottom <= focusBounds.limit, `period focus clear of dock: ${JSON.stringify(focusBounds)}`);
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el => el.open), true);
        assert.equal(await page.locator('[data-budget-detail-body] > .budget-step-body').evaluate(el => el === window.__originalBudgetEvidence), true);
        assert.equal(await page.locator('[data-budget-detail-close]').evaluate(el => el === document.activeElement), true);
        assert.equal(await page.evaluate(() => document.body.classList.contains('budget-detail-open')), true);
        await geometry(page);
        if (id === '04') assert.match(await page.locator('[data-budget-detail-body]').innerText(), /1,400\.00|Mortgage/);
        if (id === '06') assert.match(await page.locator('[data-budget-detail-body]').innerText(), /Synthetic grocer|Groceries/);
        await page.keyboard.press('Escape');
        assert.equal(await summary.evaluate(el => el.parentElement.open), false);
        assert.equal(await summary.evaluate(el => el === document.activeElement), true);
        assert.equal(await page.locator(`[data-operating-question="${id}"] .budget-step-body`).evaluate(el => el === window.__originalBudgetEvidence), true);
        await page.keyboard.press('Space');
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el => el.open), true);
        await page.keyboard.press('Escape');
      }
      // Compact overview: ⓘ opens the whole incumbent evidence, with exact
      // return focus. Next payday opens the exact published funding row.
      const how = page.locator('[data-budget-cash-how]');
      await how.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('[data-budget-today-evidence]').isVisible(), true);
      assert.equal(await page.locator('[data-budget-cash-detail]').isVisible(), true);
      assert.equal(await page.locator('[data-budget-cash-keep]').isVisible(), true);
      assert.match(await page.locator('[data-budget-cash-keep]').innerText(), /After bills & essentials.*across chequing/);
      assert.match(await page.locator('[data-budget-cash-answer]').innerText(), /873\.50[\s\S]*501\.50/);
      assert.match(await page.locator('.budget-cash-plan-scope').innerText(), /Across chequing accounts/);
      await page.locator('[data-budget-cash-detail]').screenshot({ path: path.join(screenshots, `today-details-${width}.png`) });
      assert.equal(await page.locator('[data-budget-detail-close]').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('[data-budget-detail-sheet]')), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('[data-budget-detail-close]').evaluate(el => el === document.activeElement), true);
      // Native modal background is inert, including programmatic focus.
      await page.locator('.g-river-wrap .river').evaluate(el => el.focus());
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('[data-budget-detail-sheet]')), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-budget-today-evidence]').isVisible(), false);
      assert.equal(await how.evaluate(el => el === document.activeElement), true);
      const periodInfo = page.locator('.budget-period-info > summary');
      await periodInfo.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('[data-from-today-proposal]').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-from-today-proposal]').isVisible(), false);
      assert.equal(await periodInfo.evaluate(el => el === document.activeElement), true);
      const nextPayday = page.locator('[data-budget-cash-next]');
      await nextPayday.focus(); await page.keyboard.press('Enter');
      const funding = page.locator('[data-payday-breakdown="planned-cost-funding"]');
      assert.equal(await funding.evaluate(el => el.open), true);
      assert.equal(await funding.locator('summary').evaluate(el => el === document.activeElement), true);
      assert.equal(await funding.locator('summary').evaluate(el => {
        const r = el.getBoundingClientRect(), body = el.closest('[data-budget-detail-body]').getBoundingClientRect();
        return r.top >= body.top && r.bottom <= Math.min(body.bottom, innerHeight);
      }), true, 'Next payday focuses the funding row visibly inside the sheet, including after scrolling');
      assert.match(await funding.innerText(), /August 28 payday/);
      if (width === 390) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open
          && !!document.activeElement.closest('[data-budget-detail-sheet]'));
        assert.equal(await focusVisible(funding.locator('summary')), true, 'resized Next payday focus remains inside the sheet viewport');
        await screenshot({ path: path.join(screenshots, 'next-payday-resized-1440.png'), fullPage: true });
        await page.locator('[data-budget-detail-close]').click();
        assert.equal(await nextPayday.evaluate(el => el === document.activeElement), true,
          '390-to-1440 resize returns to Next payday, never Info or body');
        await page.setViewportSize({ width: 390, height: 1000 });
        await nextPayday.focus(); await page.keyboard.press('Enter');
        assert.equal(await funding.locator('summary').evaluate(el => el === document.activeElement), true);
        assert.equal(await focusVisible(funding.locator('summary')), true, 'returned mobile Next payday focus remains inside the sheet viewport');
      }
      await geometry(page);
      await page.locator('[data-budget-detail-close]').click();
      assert.equal(await nextPayday.evaluate(el => el === document.activeElement), true);
      await how.click();
      const todaySummaries = page.locator('.budget-surface-today [data-payday-breakdown] > summary');
      // The original financial evidence is still keyboard reachable, with
      // focused controls inside the viewport rather than under sticky chrome.
      for (let i = 0; i < await todaySummaries.count(); i++) {
        await todaySummaries.nth(i).focus();
        const bounds = await page.evaluate(() => {
          const r = document.activeElement.getBoundingClientRect(); return [r.top, r.bottom, innerHeight];
        });
        assert.ok(bounds[0] >= 0 && bounds[1] <= bounds[2], `Today focus visible: ${bounds}`);
        await page.keyboard.press('Enter');
        await geometry(page);
      }
      await page.locator('[data-budget-detail-close]').click();
      assert.equal(await how.evaluate(el => el === document.activeElement), true);
      // Rerender restores the switch or picker instead of falling back to body.
      await openPeriodFigures(page);
      const month = page.locator('[data-budget-detail-sheet] [data-budget-granularity="month"]');
      await month.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('[data-budget-granularity="month"]').evaluate(el => el === document.activeElement), true);
      const picker = page.locator('[data-budget-month-picker]');
      const options = await picker.locator('option').evaluateAll(els => els.map(el => el.value));
      await picker.focus(); await picker.selectOption(options[options.length - 1]);
      assert.equal(await page.locator('[data-budget-month-picker]').evaluate(el => el === document.activeElement), true);
      await page.locator('.budget-granularity [data-budget-granularity="pay-period"]').focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('.budget-granularity [data-budget-granularity="pay-period"]').evaluate(el => el === document.activeElement), true);
      const drill = page.locator('[data-budget-drilldown-picker]');
      if (await drill.count()) {
        const periods = await drill.locator('option').evaluateAll(els => els.map(el => el.value));
        await drill.focus(); await drill.selectOption(periods[periods.length - 1]);
        assert.equal(await page.locator('[data-budget-drilldown-picker]').evaluate(el => el === document.activeElement), true);
      }
      await page.locator('[data-budget-drilldown-exit]').click();
      await page.waitForFunction(() => document.querySelector('[data-blend-figures-open]') === document.activeElement);
      assert.equal(await page.locator('[data-blend-figures-open]').evaluate(el => el === document.activeElement), true,
        'return from Month restores the visible granularity opener');
      // Signed Forecast results keep known trust. No-income geometry is an
      // explicit unscaled known state; it must never become an unknown hatch.
      for (const [name, options, expected] of [
        ['deficit', { periodInternet: 1800 }, '82.99'],
        ['overflow', { periodInternet: 10000 }, '8,282.99'],
        ['zero-income', { zeroIncome: true }, '2,417.99'],
      ]) {
        data = fx.served(options); await boot(); await geometry(page);
        const final = page.locator('[data-operating-question="07"] > details > summary');
        assert.match(await final.innerText(), new RegExp(expected.replace('.', '\\.')));
        assert.equal(await final.locator('[data-sign="negative"]').count(), 1);
        assert.equal(await final.locator('.is-unknown').count(), 0);
        assert.equal(await page.locator('[data-operating-question="06"] > details > summary .is-unknown').count(), 0);
        if (name === 'deficit') {
          assert.equal(await page.locator('[data-operating-question="06"] .budget-waterfall-bar').count(), 1,'spent/original plan does not borrow the negative financial balance');
          assert.equal(await final.locator('.budget-waterfall-bar.is-negative').count(), 1);
          assert.equal(await page.locator('[data-operating-question="05"] .budget-waterfall-zero').count(), 1);
          assert.equal(await final.locator('.budget-waterfall-zero').count(), 1);
        } else if (name === 'overflow') {
          assert.equal(await final.locator('.is-overflow-start').count(), 1);
        } else {
          assert.match(await page.locator('[data-operating-question="02"] > details > summary').innerText(), /0\.00/);
          assert.equal(await page.locator('[data-operating-question="02"] [data-budget-bar-state="zero-plan"]').count(), 1);
          assert.equal(await page.locator('[data-operating-question="02"] .budget-waterfall-bar').count(), 0);
          assert.equal(await page.locator('[data-operating-question="05"] [data-budget-bar-state="zero-income"]').count(), 1);
          assert.equal(await final.locator('[data-budget-bar-state="zero-income"]').count(), 1);
          assert.equal(await page.locator('[data-operating-question="06"] .budget-waterfall-bar').count(), 1);
        }
        await screenshot({ path: path.join(screenshots, `${name}-${width}.png`), fullPage: true });
        await page.locator('[data-calendar-waterfall]').screenshot({ path: path.join(screenshots, `${name}-period-${width}.png`), style: periodCropStyle });
      }
      // Both #488 review defects, through actual Forecast historical paths.
      // Null spent from incomplete coverage is not observed history; sealed
      // planned bills with historical remaining $0 are not an actionable clear.
      for (const [coverage, settlement] of [['missing','unverified'], ['partial','unverified'],
        ['truncated','unverified'], ['full','unverified'], ['full','paid'], ['posted-only','unverified']]) {
        data = fx.historical(coverage, settlement); await boot();
        await stepPeriod(page, 'ArrowLeft', 'mouse');
        assert.match(await page.locator('[data-budget-window-range]').innerText(), /Jul 31.*Aug 13/);
        const spending = page.locator('[data-budget-browse="spending"]');
        const bills = page.locator('[data-budget-browse="bills"]');
        const observed = ['full', 'posted-only'].includes(coverage);
        assert.match(await spending.locator('.budget-browse-counts').innerText(), observed
          ? /Observed spending.*completed period/ : /Spending unavailable.*completed period/);
        assert.match(await spending.locator('[data-budget-browse-hold]').innerText(), observed ? /66\.75/ : /Unknown/);
        const groceries = spending.locator('[data-budget-category-open="groceries"]');
        assert.match(await groceries.innerText(), observed ? /47\.25/ : /Spending unavailable/);
        assert.equal(await groceries.locator('.budget-category-fill').count(),0,'historical original target is unknown even with complete spending coverage');
        assert.match(await spending.locator('[data-budget-ratio-plan]').innerText(),/unknown/i);
        assert.equal(await bills.locator('[data-budget-browse-bills-remaining]').count(), 0);
        assert.match(await bills.locator('h2').innerText(), /105\.00/,'historical original bill plan remains available');
        assert.match(await bills.innerText(), /Completed-period bills/);
        assert.match(await bills.innerText(), /Historical settlement evidence, not an amount due now/);
        if (settlement === 'unverified') assert.match(await bills.innerText(), /To confirm[\s\S]*Synthetic historical service/);
        else assert.equal(await bills.locator('[data-budget-bill-bucket="paid"]').isVisible(), true);
        assert.equal((await bills.innerText()).includes('left to pay or confirm'), false);
        await geometry(page);
        if (['missing', 'full'].includes(coverage)) await screenshot({
          path:path.join(screenshots, `history-${coverage}-${settlement}-${width}.png`), fullPage:true });
        if (coverage === 'partial' && width === 320) await screenshot({path:path.join(screenshots,'history-partial-320.png'),fullPage:true});
        await groceries.focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el=>el.open), true);
        assert.match(await page.locator('[data-budget-detail-body]').innerText(),/Historical original plan unavailable/);
        assert.doesNotMatch(await page.locator('[data-budget-detail-body]').innerText(),/450\.00|613\.27|Planned|Remaining|\/week/);
        if (observed) assert.match(await page.locator('[data-budget-detail-body]').innerText(), /Synthetic historical grocer[\s\S]*47\.25/);
        await page.keyboard.press('Escape');
        assert.equal(await groceries.evaluate(el=>el===document.activeElement), true);
        if (settlement === 'paid') {
          await bills.locator('[data-budget-bill-filter="paid"]').focus();
          await page.keyboard.press('Enter');
          assert.equal(await bills.locator('[data-budget-bill-bucket="paid"]').isVisible(), true);
        }
        const bill = bills.locator('[data-budget-bill-open="historical-service"]');
        await bill.focus();
        assert.equal(await bill.evaluate(el=>el===document.activeElement), true);
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el=>el.open), true);
        assert.match(await page.locator('[data-budget-detail-body]').innerText(), /Synthetic historical service[\s\S]*105\.00/);
        await page.keyboard.press('Escape');
        assert.equal(await bill.evaluate(el=>el===document.activeElement), true);
        await stepPeriod(page, 'ArrowRight', 'mouse');
        assert.match(await page.locator('[data-budget-browse-bills-remaining]').innerText(), settlement === 'paid' ? /265\.00/ : /370\.00/);
        await stepPeriod(page, 'ArrowRight', 'mouse');
        assert.match(await page.locator('[data-budget-browse="spending"] .budget-browse-counts').innerText(), /Projected plan.*spending not observed/);
      }
      // P1: editing today's target cannot reconstruct an original history plan.
      for (const target of [450,613.27]) {
      data=fx.fundingHistorical('full','paid');
      data.plan.budget.categories.find(row=>row.id==='groceries').plannedPayday=target;
      const sealedInputs=JSON.stringify(data);
      await boot();await stepPeriod(page, 'ArrowLeft', 'mouse');
      const revisedHistory=page.locator('[data-budget-browse="spending"]');
      assert.match(await revisedHistory.locator('[data-budget-ratio-actual]').innerText(),/66\.75/);
      assert.match(await revisedHistory.locator('[data-budget-ratio-plan]').innerText(),/Unknown/);
      assert.doesNotMatch(await revisedHistory.innerText(),/613\.27|450\.00|402\.75 left|566\.02 left/);
      assert.equal(await revisedHistory.locator('.budget-category-fill').count(),0);
      await geometry(page);
      await revisedHistory.screenshot({path:path.join(screenshots,`history-target-edit-${width}.png`),animations:'disabled',style:'.sitenav-household{visibility:hidden!important}'});
      const revisedGrocery=revisedHistory.locator('[data-budget-category-open="groceries"]');
      const assertHistorySheet=async (withTotal=false) => {
        const sheetBody=page.locator('[data-budget-detail-body]');
        assert.equal(await page.locator('[data-budget-detail-sheet]').evaluate(el=>el.open),true);
        assert.match(await sheetBody.innerText(),/Historical original plan unavailable/);
        assert.match(await sheetBody.innerText(),/Synthetic historical grocer[\s\S]*47\.25/);
        assert.doesNotMatch(await sheetBody.innerText(),/450\.00|613\.27|402\.75|566\.02|\/week/);
        assert.equal(await sheetBody.locator('[data-budget-category]').count(),withTotal?3:1);
        const categoryTerms=sheetBody.locator('[data-budget-category] dt');
        assert.ok(await categoryTerms.count()>0,'native category terms are present');
        assert.doesNotMatch(await categoryTerms.allTextContents().then(labels=>labels.join(' ')),/Planned|Remaining/,
          'native historical categories do not print current targets or remaining amounts');
        const total=sheetBody.locator('[data-household-budget-progress-total]');
        assert.equal(await total.count(),withTotal?1:0);
        if(withTotal)assert.match(await total.locator('[data-budget-ratio-plan]').innerText(),/Unknown/,
          'the total retains a truthful Actual / Planned label with its original plan explicitly unknown');
        assert.equal(await sheetBody.locator('.budget-category-fill,.budget-category-pace').count(),0);
      };
      for (const id of ['groceries','fuel','restaurants']) {
        const trigger=revisedHistory.locator(`[data-budget-category-open="${id}"]`);
        await page.locator(`[data-budget-category="${id}"]`).evaluate(node=>{window.__historicalCategorySource=node;});
        await trigger.focus();await page.keyboard.press('Enter');
        const sheetBody=page.locator('[data-budget-detail-body]');
        assert.match(await sheetBody.innerText(),/Historical original plan unavailable/);
        assert.doesNotMatch(await sheetBody.innerText(),/450\.00|613\.27|160\.00|120\.00|Planned|Remaining|\/week/);
        assert.equal(await sheetBody.locator('[data-budget-category]').evaluate(node=>node===window.__historicalCategorySource),true,
          'context travels with the same native category node');
        if(id==='groceries') {
          await assertHistorySheet();
          await page.evaluate(()=>App.rerender());
          await page.waitForFunction(()=>document.querySelector('[data-budget-detail-sheet]')?.open);
          await assertHistorySheet();
          if(target===613.27) await screenshot({path:path.join(screenshots,`history-category-target-edit-${width}.png`),fullPage:false});
        }
        await page.keyboard.press('Escape');assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
      }
      // Full Household details and the individual sheet must carry the same
      // unavailable original-plan meaning; opening transactions cannot lose it.
      const fullDetails=revisedHistory.locator('[data-budget-browse-evidence="06"]');
      await fullDetails.focus();await page.keyboard.press('Enter');
      await assertHistorySheet(true);
      assert.equal(await page.locator('[data-budget-detail-body] [data-budget-historical-original-plan="unavailable"]').count(),3);
      await page.keyboard.press('Escape');assert.equal(await fullDetails.evaluate(el=>el===document.activeElement),true);
      await stepPeriod(page, 'ArrowRight', 'mouse');
      await revisedGrocery.focus();await page.keyboard.press('Enter');
      assert.match(await page.locator('[data-budget-detail-body]').innerText(),new RegExp(`Planned[\\s\\S]*${target.toFixed(2).replace('.','\\.')}`),
        'current authored target remains available after historical navigation');
      assert.equal(await page.locator('[data-budget-detail-body] [data-budget-historical-original-plan]').count(),0);
      await page.keyboard.press('Escape');
      await stepPeriod(page, 'ArrowLeft', 'mouse');
      await revisedGrocery.focus();await page.keyboard.press('Enter');await assertHistorySheet();
      await page.keyboard.press('Escape');assert.equal(await revisedGrocery.evaluate(el=>el===document.activeElement),true);
      assert.equal(JSON.stringify(data),sealedInputs,'presentation never modifies sealed fixture rows');
      }
      // P2: a valid typed receipt precedes its scheduled occurrence date.
      // This is Forecast -> active UI proof, not provider identity matching.
      data=fx.served({earlyInternet:true});await boot();
      const earlyBills=page.locator('[data-budget-browse="bills"]');
      assert.match(await earlyBills.locator('h2').innerText(),/1,485\.00[\s\S]*1,665\.00/);
      assert.match(await earlyBills.locator('[data-budget-bill-filter="paid"]').innerText(),/2/);
      const earlyInternet=earlyBills.locator('[data-budget-bill-open="internet"]');
      assert.match(await earlyInternet.innerText(),/Paid/);
      await geometry(page);
      await earlyBills.screenshot({path:path.join(screenshots,`early-paid-bill-${width}.png`),animations:'disabled',style:'.sitenav-household{visibility:hidden!important}'});
      await earlyInternet.focus();await page.keyboard.press('Enter');
      assert.match(await page.locator('[data-budget-detail-body]').innerText(),/Internet[\s\S]*85\.00/);
      await page.keyboard.press('Escape');assert.equal(await earlyInternet.evaluate(el=>el===document.activeElement),true);
      // Configured pools with unknown assignments must retain the withholding reason.
      data = fx.served({ withheldSavings: true }); await boot(); await geometry(page);
      assert.equal(await page.locator('[data-budget-cash-hero]').innerText(), '$1,215.00');
      assert.equal(await page.locator('[data-budget-cash-withheld]').count(), 0);
      await how.focus(); await page.keyboard.press('Enter');
      assert.match(await page.locator('[data-budget-today-evidence]').innerText(), /withheld|unavailable|unknown/i);
      await page.locator('[data-budget-cash-back]').focus(); await page.keyboard.press('Enter');
      assert.equal(await how.evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('.budget-cash-chart').count(), 0);
      const accounts = page.locator('.budget-savings-accounts');
      assert.equal(await accounts.evaluate(node => node.open), false);
      await accounts.locator('summary').focus(); await page.keyboard.press('Enter');
      assert.match(await page.locator('#savings-inventory').innerText(), /Assignments unknown/);
      await page.keyboard.press('Enter');
      await page.locator('.budget-period-info > summary').click();
      await page.locator('[data-from-today-proposal] summary').click();
      assert.match(await page.locator('[data-budget-detail-body]').innerText(), /withheld|withholding/);
      await screenshot({ path: path.join(screenshots, `withheld-${width}.png`), fullPage: true });
      data = fx.served({ spendingCash: -50, savingsCash: 8000 }); await boot(); await geometry(page);
      assert.equal(await page.locator('[data-budget-cash-hero]').innerText(), '$1,215.00');
      await how.click();
      assert.match(await page.locator('[data-budget-cash-part="household"]').innerText(), /308\.50/);
      await screenshot({ path: path.join(screenshots, `negative-spending-${width}.png`), fullPage: true });
      data = fx.served({ groceriesExtra: 200 }); await boot(); await geometry(page);
      assert.match(await page.locator('[data-budget-period-result]').innerText(), /1,573\.46/);
      assert.match(await page.locator('[data-operating-question="06"] > details > summary').innerText(), /644\.49[\s\S]*730\.00/);
      assert.equal(await page.locator('[data-budget-cash-hero]').innerText(), '$1,215.00');
      await screenshot({ path: path.join(screenshots, `overspending-${width}.png`), fullPage: true });
      data = fx.served({ unavailablePlan: true }); await boot();
      assert.equal(await page.locator('[data-budget-period-result]').count(), 0);
      assert.match(await page.locator('[data-budget-surface="unavailable"]').innerText(), /Last trusted opening/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await screenshot({ path: path.join(screenshots, `unavailable-${width}.png`), fullPage: true });
      data = fx.served({ deficitPeriod: true }); await boot(); await geometry(page);
      assert.match(await page.locator('[data-budget-period-result]').innerText(), /3,367\.99/);
      assert.match(await page.locator('[data-operating-question="07"] .budget-step-value').innerText(), /estimated/);
      const trackState = id => page.locator(`[data-operating-question="${id}"] .budget-waterfall-track`)
        .evaluate(el => ({ deficit: el.classList.contains('is-deficit'), unknown: el.classList.contains('is-unknown'),
          hatch: getComputedStyle(el).backgroundImage }));
      const householdTrack = await trackState('06');
      const finalTrack = await trackState('07');
      assert.deepEqual({ deficit: householdTrack.deficit, unknown: householdTrack.unknown }, { deficit: false, unknown: false });
      assert.deepEqual({ deficit: finalTrack.deficit, unknown: finalTrack.unknown }, { deficit: true, unknown: false });
      assert.ok(!finalTrack.hatch.includes('repeating-linear-gradient'), 'known deficit is not the unknown hatch');
      assert.equal(await page.locator('[data-operating-question="savings"] .budget-waterfall-track').count(), 0);
      assert.equal(await page.locator('[data-operating-question="savings"] .budget-step-value').innerText(), 'Unavailable',
        'missing stock remains unavailable in a deficit period without deduction geometry');
      await screenshot({ path: path.join(screenshots, `levy-deficit-${width}.png`), fullPage: true });
      await page.locator('[data-calendar-waterfall]').screenshot({ path: path.join(screenshots, `levy-deficit-period-${width}.png`), style: periodCropStyle });
      // Preserve the concurrent no-observation zero-income regression separately
      // from the observation/overlay fixture, which retains actual Other Spend.
      data = fx.served({ zeroIncomeWithoutSpend: true }); await boot(); await geometry(page);
      assert.equal(await page.locator('[data-budget-category-open="groceries"][data-budget-browse-origin="spending"] .budget-category-fill').count(), 0);
      assert.match(await page.locator('[data-budget-category-open="groceries"][data-budget-browse-origin="spending"]').innerText(), /Spending unavailable/);
      assert.match(await page.locator('[data-budget-period-result]').innerText(), /2,395\.00/);
      assert.match(await page.locator('[data-operating-question="02"] .budget-step-value').innerText(), /0\.00/);
      assert.match(await page.locator('[data-operating-question="07"] .budget-step-value').innerText(), /estimated/);
      const zeroIncomeTrack = page.locator('[data-operating-question="02"] .budget-waterfall-track');
      assert.equal(await zeroIncomeTrack.evaluate(el => el.classList.contains('is-unknown')), true,'missing observations cannot become zero income received');
      for (const id of ['02', '04', '05', '06', '07']) {
        const track = await trackState(id);
        const actualUnavailable=['02','04','06'].includes(id);
        assert.equal(track.unknown, actualUnavailable);
        assert.equal(track.hatch.includes('repeating-linear-gradient'),actualUnavailable);
        assert.equal(await page.locator(`[data-operating-question="${id}"] .budget-waterfall-bar`).count(), 0);
        assert.equal(track.deficit,['05','07'].includes(id));
      }
      assert.equal(await page.locator('[data-operating-question="savings"] .budget-waterfall-track').count(), 0);
      assert.equal(await page.locator('[data-operating-question="savings"] .budget-step-value').innerText(), 'Unavailable',
        'zero income cannot manufacture a zero savings balance');
      await screenshot({ path: path.join(screenshots, `zero-income-no-observations-${width}.png`), fullPage: true });
      await page.locator('[data-calendar-waterfall]').screenshot({ path: path.join(screenshots, `zero-income-no-observations-period-${width}.png`), style: periodCropStyle });
      await page.close();
      console.log(`PASS ${width}px: financial hero, geometry, evidence, keyboard reachability, focus restoration, unknown assignments, unavailable plan and known deficit`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('PASS actual App.boot → Forecast → active Budget renderer; no external requests or page errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
