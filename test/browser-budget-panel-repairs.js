'use strict';
// Native App.boot -> Forecast -> Budget. Invented data, no live requests.
const assert = require('node:assert/strict');
const cards = require('./fixtures/card-period-movements-data');
const household = require('./fixtures/budget-household-all');
async function provePanelRepairs({ open, capture }) {
  const cases = [];
  for (const width of [320, 390, 760, 800, 900, 935, 1000, 1100, 1101, 1280, 1440]) {
    for (const theme of ['light', 'dark']) {
      const data = cards.helocServed();
      // A five-digit estimated income is larger than the original reported
      // clipping case. Forecast still computes and qualifies the amount.
      data.plan.income.find(row => row.id === 'partner').amount = 9876.54;
      data.plan.budget.categories = household.budgetCategories();
      const page = await open(width, theme, { data, reducedMotion: 'reduce' });
      const fit = await page.locator('.blend-hero').evaluate(hero => {
        const rect = node => node.getBoundingClientRect();
        const boundary = rect(hero);
        const escapedGlyphs = [];
        const fits = node => {
          const box = rect(node);
          const textBoxes = [];
          const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          while (walk.nextNode()) {
            const text = walk.currentNode, parent = text.parentElement;
            if (!text.textContent.trim() || parent.closest('.blend-clip,.budget-cash-sr,.blend-est,[hidden]')) continue;
            let hidden = false;
            for (let ancestor = parent; ancestor && ancestor !== hero; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor), box = rect(ancestor);
              if (style.display === 'none' || style.visibility === 'hidden' || style.clipPath === 'inset(50%)'
                || style.clip !== 'auto' || (ancestor.tagName === 'DETAILS' && !ancestor.open
                  && !ancestor.querySelector(':scope > summary')?.contains(parent))
                || (style.overflow === 'hidden' && box.width <= 2 && box.height <= 2)) hidden = true;
            }
            if (hidden) continue;
            const range = document.createRange(); range.selectNodeContents(text);
            const boxes = [...range.getClientRects()].filter(box => box.width > 0 && box.height > 0);
            for (const box of boxes) if (box.left < boundary.left - 1 || box.right > boundary.right + 1
              || box.top < boundary.top - 1 || box.bottom > boundary.bottom + 1) escapedGlyphs.push({ text: text.textContent, parent: parent.className,
                left: box.left, right: box.right, top: box.top, bottom: box.bottom });
            textBoxes.push(...boxes);
          }
          return box.left >= boundary.left - 1 && box.right <= boundary.right + 1
            && box.top >= boundary.top - 1 && box.bottom <= boundary.bottom + 1
            && node.scrollWidth <= node.clientWidth + 1
            && textBoxes.every(text => text.left >= boundary.left - 1 && text.right <= boundary.right + 1
              && text.top >= boundary.top - 1 && text.bottom <= boundary.bottom + 1);
        };
        const amounts = [...hero.querySelectorAll('[data-blend-term]')];
        const keyFor = { periodIncome: '02', assignedBills: '04', householdBudgetHold: '06', balanceAfterDeductions: '07' };
        const terms = amounts.map(node => {
          const key = node.dataset.blendTerm, source = hero.querySelector('[data-bad-term="' + key + '"]');
          const shown = node.cloneNode(true); shown.querySelector('.blend-after-funding')?.remove();
          const prompt = hero.querySelector('[data-operating-question="' + keyFor[key] + '"] .operating-prompt');
          const p = rect(prompt), v = rect(node);
          return { key, shown: shown.textContent.trim(), expected: source.querySelector('[data-bad-term-amount]')?.textContent.trim() || 'Unavailable',
            fits: fits(node), labelFits: fits(prompt), labelOverlapsAmount: key !== 'balanceAfterDeductions'
              && p.left < v.right - 1 && p.right > v.left + 1 && p.top < v.bottom - 1 && p.bottom > v.top + 1,
            nativeTrust: source.dataset.badTermTrust, estimatedCue: node.classList.contains('is-estimated'), title: node.title,
            box: { left: v.left, right: v.right, top: v.top, bottom: v.bottom },
            boundary: { left: boundary.left, right: boundary.right, top: boundary.top, bottom: boundary.bottom },
            scroll: [node.scrollWidth, node.clientWidth, node.scrollHeight, node.clientHeight] };
        });
        return { terms, pillFits: fits(hero.querySelector('.budget-today-cash')),
          footerFits: fits(hero.querySelector('.blend-hero-foot')),
          escapedGlyphs,
          chrome: ['.budget-today-cash', '.blend-hero-foot'].map(selector => { const n = hero.querySelector(selector), b = rect(n);
            return { selector, left: b.left, right: b.right, top: b.top, bottom: b.bottom,
              scroll: [n.scrollWidth, n.clientWidth, n.scrollHeight, n.clientHeight] }; }),
          badgesHidden: [...hero.querySelectorAll('.blend-est')].every(node => rect(node).width <= 1.01 && rect(node).height <= 1.01),
          boardOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      assert.equal(fit.terms.length, 4, `${width}/${theme} all four full amounts`);
      for (const term of fit.terms) {
        assert.equal(term.shown, term.expected, `${width}/${theme} ${term.key} copies native exact cents`);
        assert.ok(term.fits && term.labelFits && !term.labelOverlapsAmount,
          `${width}/${theme} ${term.key} fits without overlap: ${JSON.stringify(term)}`);
        assert.equal(term.estimatedCue, term.nativeTrust === 'estimated', 'native estimate qualification survives');
        if (term.estimatedCue) assert.match(term.title, /^Estimated/);
      }
      assert.ok(fit.pillFits && fit.footerFits && fit.badgesHidden && !fit.boardOverflow, `${width}/${theme} hero chrome fits: ${JSON.stringify(fit)}`);
      const rings = await page.locator('[data-blend-rings] .blend-ring').evaluateAll(els => els.map(el => ({
        id: el.getAttribute('data-blend-cat'),
        centre: (el.querySelector('.blend-ring-v')?.textContent || '').trim(),
      })));
      const nativeNames = await page.locator('.budget-category-row:not([data-budget-category-open="other-spending"])').evaluateAll(rows => rows.map(row => ({
        id: row.getAttribute('data-budget-category-open'),
        name: (row.querySelector('.budget-category-name')?.textContent || '').trim(),
      })));
      // The centre carries the native name, except the two personal
      // rings whose VISUAL centre is exactly the approved short label
      // (Systems Review 5482743628); their full native names stay in
      // the accessible names.
      const centreFor = ({ id, name }) => id === 'dale-guilt-free' ? 'Dale'
        : id === 'amanda-guilt-free' ? 'Amanda' : name;
      for (const row of nativeNames) {
        const expected = centreFor(row);
        assert.ok(rings.some(ring => ring.id === row.id && ring.centre === expected),
          `${width}/${theme} native ${row.name} remains visible as centre "${expected}": ${JSON.stringify(rings)}`);
      }
      assert.ok(rings.length >= 5, 'Household includes the personal rows');
      const heloc = page.locator('[data-budget-card-toggle="heloc"]');
      assert.equal(await heloc.count(), 1, 'one native HELOC row');
      // The card face prints the bare reported balance (the card-movements
      // contract: browser-card-period-movements.js "HELOC face is its bare
      // reported balance"); the period movement lives in the panel below.
      assert.match(await heloc.innerText(), /HELOC[\s\S]*Reported balance[\s\S]*\$42,025\.35/);
      await heloc.click();
      const panel = page.locator('[data-budget-card-panel="heloc"]');
      assert.equal(await panel.isVisible(), true, 'HELOC opens the existing native panel');
      // Opening/closing endpoints sit behind the panel's collapsed
      // "Balance and payment details" disclosure (card-movements contract,
      // browser-card-period-movements.js); expand it, then read both figures.
      const balanceDetails = panel.locator('details.card-movement-details');
      assert.equal(await balanceDetails.evaluate(el => el.open), false, 'HELOC balance details start collapsed');
      await balanceDetails.locator('> summary').click();
      assert.match(await panel.innerText(), /\$42,000\.00[\s\S]*\$42,025\.35/);
      assert.match(await panel.innerText(), /Pending[\s\S]*\$900\.00/);
      assert.match(await panel.innerText(), /Payments reduce the HELOC balance/);
      await page.keyboard.press('Escape');
      assert.equal(await panel.isVisible(), false);
      assert.equal(await heloc.evaluate(el => el === document.activeElement), true, 'close restores HELOC focus');
      if (width === 935) await capture(page, `budget-panels-${width}-${theme}.png`);
      cases.push({ width, theme, fit, householdLabels: rings, helocNet: 25.35, panelAndFocus: true });
      await page.close();
    }
  }
  for (const width of [320, 935]) for (const theme of ['light', 'dark']) {
    const data = cards.helocServed();
    delete data.liveOverlay.currentPeriodActuals;
    const page = await open(width, theme, { data, reducedMotion: 'reduce' });
    const reason = page.locator('[data-budget-spending-unavailable]');
    assert.equal(await reason.isVisible(), true, 'Household copies its native unavailable reason onto the face');
    assert.ok((await reason.innerText()).length > 10, 'missing evidence has an explanation');
    assert.ok((await page.locator('.blend-ring-pair').allTextContents()).every(text => /unavailable/i.test(text)),
      'missing observations never become zero or remaining dollars');
    const heloc = page.locator('[data-budget-card-toggle="heloc"]');
    // The face keeps the published reported balance and never shows a
    // movement it cannot observe; the unavailability is stated in the panel.
    assert.match(await heloc.innerText(), /Reported balance[\s\S]*\$42,025\.35/);
    assert.doesNotMatch(await heloc.innerText(), /[+\u2212-]\$|\$25\.35/, 'no unobserved movement on the face');
    await heloc.click();
    const panel = page.locator('[data-budget-card-panel="heloc"]');
    // The unavailability evidence sits in the collapsed balance disclosure.
    await panel.locator('details.card-movement-details > summary').click();
    assert.match(await panel.innerText(), /Observation unavailable[\s\S]*Net change remains unavailable/);
    await page.keyboard.press('Escape');
    if (width === 935) await capture(page, `budget-panels-${width}-${theme}-unavailable.png`);
    cases.push({ width, theme, unavailable: true, householdReasonVisible: true, helocUnavailable: true });
    await page.close();
  }
  const malformed = await open(935, 'light', { data: cards.helocObserved('malformed-only'), reducedMotion: 'reduce' });
  const malformedFace = await malformed.locator('[data-budget-card-toggle="heloc"]').innerText();
  assert.match(malformedFace, /Reported balance[\s\S]*\$42,025\.35/);
  assert.doesNotMatch(malformedFace, /[+\u2212-]\$|\$25\.35/, 'a malformed record never becomes a face movement');
  await malformed.locator('[data-budget-card-toggle="heloc"]').click();
  await malformed.locator('[data-budget-card-panel="heloc"] details.card-movement-details > summary').click();
  assert.match(await malformed.locator('[data-budget-card-panel="heloc"]').innerText(), /Transaction evidence unconfirmed/);
  cases.push({ width: 935, theme: 'light', realObservation: true, malformedRecordNotZero: true });
  await malformed.close();
  return { cases, inventedDataOnly: true, providerWrites: 0 };
}
module.exports = { provePanelRepairs };
