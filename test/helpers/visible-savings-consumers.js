'use strict';

// Use the visible Savings goals title; the funding source now lives in its
// disclosure. Re-open through the same keyboard path after a page refresh.
async function openSavingsFunding(page) {
  const title = page.locator('[data-budget-savings-goals] > .blend-tile-head');
  await title.waitFor({ state: 'visible' });
  if (await title.getAttribute('aria-expanded') !== 'true') {
    await title.focus();
    await page.keyboard.press('Enter');
  }
  await page.locator('[data-budget-funding-section]').waitFor({ state: 'visible' });
}

module.exports = { openSavingsFunding };
