'use strict';
const assert = require('node:assert/strict');

// Drive the household's visible period control. No renderer calls, hidden
// native buttons, or financial expectations are used to select a period.
async function stepPeriod(page, key) {
  assert.ok(key === 'ArrowLeft' || key === 'ArrowRight', 'one adjacent period per step');
  const selected = page.locator('[data-pay-period-swipe]');
  const previous = await selected.getAttribute('data-selected-pay-period');
  assert.ok(previous, 'the source period has an identity before navigation');
  const river = page.getByRole('slider', { name: 'Pay period', exact: true });
  await river.waitFor({ state: 'visible' });
  const index = Number(await river.getAttribute('aria-valuenow'));
  assert.ok(Number.isInteger(index) && index > 0, 'the visible river identifies its selected period');
  await river.focus();
  assert.equal(await river.evaluate(el => el === document.activeElement), true, 'visible period control takes keyboard focus');
  await page.keyboard.press(key);
  await page.waitForFunction(({ previous, nextIndex }) => {
    const next = document.querySelector('[data-pay-period-swipe]')?.getAttribute('data-selected-pay-period');
    const control = document.querySelector('.g-river-wrap .river');
    return next && next !== previous && control?.getAttribute('aria-valuenow') === String(nextIndex)
      && control === document.activeElement;
  }, { previous, nextIndex: index + (key === 'ArrowRight' ? 1 : -1) });
  assert.equal(await river.isVisible(), true, 'selection restores focus to the visible period control');
  return selected.getAttribute('data-selected-pay-period');
}

async function openPeriodFigures(page) {
  const trigger = page.locator('[data-blend-figures-open]');
  await trigger.waitFor({ state: 'visible' });
  await trigger.focus();
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'visible figures opener takes keyboard focus');
  await page.keyboard.press('Enter');
  const dialog = page.locator('[data-budget-detail-sheet]');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'figures opener exposes its expanded state');
  assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'figures disclosure receives keyboard focus');
}

module.exports = { stepPeriod, openPeriodFigures };
