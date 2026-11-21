'use strict';
/* The acceptance harness opens either page (C1 S4): the classic Budget page, which every scenario was written
 * against, and the Stack page, the default route since B7.
 * `node test/test-acceptance-harness-views.js`
 *
 * Before this change openBudget opened "/", which is the Stack page, and waited for the classic surface, an element
 * the Stack page hides: every scenario timed out and the advisory scoreboard could not run. The default view is now
 * 'classic' (/?view=classic) until C1 S7 removes that page; { view: 'stack' } opens the Stack page and reads it
 * through stackText / stackRows / periods / selectPeriod. Invented world, headless Chromium; skipped where Playwright
 * is not installed (the hosted jobs install no browser).
 */
function hasBrowser() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}
if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
  console.log('  SKIP  Playwright Chromium is not available here');
  process.exit(0);
}
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

(async () => {
  try {
    await H.withBudget(H.baseWorld(), async p => {
      ok(p.view === 'classic', 'the default view is the classic page');
      ok((await p.text('[data-budget-surface]')).length > 100, 'the classic Budget surface has its text');
      ok((await p.stackText()) === '' || !(await p.stackText('waterfall')), 'the classic page has no Stack waterfall');
      ok(p.errors.length === 0, 'no page error on the classic page', p.errors.join(' | '));
    });

    await H.withBudget(H.baseWorld(), async p => {
      ok(p.view === 'stack', 'view: stack opens the Stack page');
      const waterfall = await p.stackText('waterfall');
      ok(waterfall.length > 50 && /income/i.test(waterfall), 'the Stack waterfall has its text (the income rows)');
      ok(/Bills/.test(await p.stackText('cards')) && /Credit/.test(await p.stackText('credit')), 'the cards block (Bills, Budget) and the Credit block have theirs');
      const periods = await p.periods();
      ok(periods.length >= 4, 'the Stack page offers several pay periods', String(periods.length));
      const before = await p.stackText('waterfall');
      await p.selectPeriod(periods[3]);
      ok((await p.stackText('waterfall')) !== before, 'pressing a period chip redraws the waterfall');
      ok((await p.stackRows('[data-stack-period]')).length === periods.length, 'stackRows reads inside the Stack page');
      ok(p.errors.length === 0, 'no page error on the Stack page', p.errors.join(' | '));
    }, { view: 'stack' });

    let threw = false;
    try { await H.withBudget(H.baseWorld(), async () => {}, { view: 'bogus' }); } catch (error) { threw = /unknown view/.test(error.message); }
    ok(threw, 'an unknown view is refused');
  } finally { await H.closeBrowser(); }
  console.log(`test-acceptance-harness-views: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
