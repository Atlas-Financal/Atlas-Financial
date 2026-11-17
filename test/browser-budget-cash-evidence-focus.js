'use strict';
// Browser proof: the "Current balance and funding details" (ⓘ) opener on the Budget face.
// It is the only route to the current-balance evidence, so it stays a keyboard stop; the
// face clips it, and it must show itself while it holds keyboard focus (and only then).
// Real page, invented world through the acceptance harness. Screenshots go to
// ATLAS_CASH_FOCUS_SHOTS when set. Run by hand: `node test/browser-budget-cash-evidence-focus.js`
const path = require('node:path');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const shots = process.env.ATLAS_CASH_FOCUS_SHOTS || '';
const world = () => {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
};
const box = p => p.page.locator('[data-budget-cash-how]').first().evaluate(el => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { w: Math.round(r.width), h: Math.round(r.height), hit: !!hit && (hit === el || el.contains(hit)), focused: el === document.activeElement };
});

(async () => {
  try {
    for (const width of [1440, 390, 320]) {
      await H.withBudget(world(), async p => {
        await p.page.setViewportSize({ width, height: 1000 });
        const before = await box(p);
        ok(before.w <= 1 && before.h <= 1, `${width}px: unfocused, the opener stays clipped (nothing new for mouse or touch)`, JSON.stringify(before));
        const hero = p.page.locator('.blend-hero').first();
        if (shots) await hero.screenshot({ path: path.join(shots, `cash-opener-unfocused-${width}.png`), animations: 'disabled' });
        // Reach it by keyboard, as a keyboard user does.
        await p.page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
        let reached = false;
        for (let i = 0; i < 80 && !reached; i++) {
          await p.page.keyboard.press('Tab');
          reached = await p.page.evaluate(() => !!document.activeElement && document.activeElement.matches('[data-budget-cash-how]'));
        }
        ok(reached, `${width}px: Tab reaches the opener`);
        const focused = await box(p);
        ok(focused.focused && focused.w >= 24 && focused.h >= 24 && focused.hit,
          `${width}px: while keyboard-focused it is visible and on top`, JSON.stringify(focused));
        if (shots) await hero.screenshot({ path: path.join(shots, `cash-opener-focused-${width}.png`), animations: 'disabled' });
        await p.page.keyboard.press('Enter');
        await p.page.waitForFunction(() => {
          const ev = document.querySelector('[data-budget-today-evidence]');
          return !!document.querySelector('dialog[open]') || (ev && !ev.hidden);
        }, null, { timeout: 5000 });
        ok(true, `${width}px: Enter opens the current-balance evidence`);
        await p.page.keyboard.press('Escape');
        ok(p.errors.length === 0, `${width}px: no page errors`, p.errors.join('; '));
      });
    }
  } catch (e) {
    failures++; console.error(e);
  } finally {
    await H.closeBrowser();
  }
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nPASS cash evidence opener focus browser proof');
})();
