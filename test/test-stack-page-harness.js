'use strict';
/* The Stack page boots in a test the way the classic page does (C1 S4: the harness the later batches ride on).
 * `node test/test-stack-page-harness.js`
 *
 * test/lib/budget-page-harness.js loadStackPage() runs the real stack-shell.js and its four blocks against a
 * recording DOM and hands back what each block drew. Invented data only. The harness must not be able to go green
 * by showing nothing, so each claim here is paired with one that fails when the page is broken:
 *   - a page that renders is reported 'rendered', and a document the shell cannot use is not;
 *   - the blocks draw, the selected pay period is one of the offered ones, and pressing another chip redraws;
 *   - what is drawn follows Forecast: a Forecast that publishes no pay periods leaves nothing to select or draw;
 *   - the classic boot is still there beside it (it stays until C1 S7).
 */
const assert = require('node:assert/strict');
const { loadStackPage, loadBudgetPage, STACK_SCRIPTS } = require('./lib/budget-page-harness');
const { pageScripts } = require('./lib/page-scripts');
const fixture = require('./fixtures/savings-daily-consumer-data');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

(async () => {
  ok(STACK_SCRIPTS.filter(f => /^stack-/.test(f)).length === 5 && STACK_SCRIPTS.includes('plan.js'),
    'the harness loads the shell, its four blocks, and plan.js (which holds the settlement gate until C1 S5)');
  const pageFiles = pageScripts().map(s => s.file.replace('public/', ''));
  ok(pageFiles.filter(f => /^stack-/.test(f)).every(f => STACK_SCRIPTS.includes(f)),
    'every Stack script the page loads is one the harness loads');

  const data = fixture();
  const page = await loadStackPage({ data });
  ok(page.status() === 'rendered', 'the Stack page renders the invented household', page.status());
  ok(page.errors.length === 0, 'the shell did not fall back to the classic page', String(page.errors.length));
  for (const name of ['waterfall', 'cards', 'credit']) ok(page.blockHtml(name).length > 200, 'the ' + name + ' block drew into its container');
  const keys = page.periodKeys();
  ok(keys.length >= 4, 'the page offers several pay periods', String(keys.length));
  ok(keys.includes(page.selectedKey()), 'the selected pay period is one of the offered ones', String(page.selectedKey()));
  ok(!!page.context() && !!page.context().recommendation && !!page.context().plan,
    'the context the shell hands its blocks carries the plan and the Forecast recommendation');

  const before = page.blockHtml('waterfall');
  const target = keys.find(k => k !== page.selectedKey());
  ok(page.selectPeriod(target) === target, 'pressing a pay period chip selects that period', target);
  ok(page.blockHtml('waterfall') !== before, 'the waterfall redraws for the newly selected period');
  ok(page.errors.length === 0, 'selecting a period raises no error');

  // A document the shell cannot use is never reported as rendered (the status is the guard against a vacuous pass).
  const broken = fixture(); delete broken.plan;
  const brokenPage = await loadStackPage({ data: broken });
  ok(brokenPage.status() !== 'rendered', 'a document with no plan is not reported as rendered', brokenPage.status());

  // What the page draws follows Forecast: with no pay periods published there is nothing to select or draw.
  const F = require('../public/forecast.js');
  const quiet = Object.assign({}, F, {
    recommend: (...args) => Object.assign({}, F.recommend(...args), { payPeriodViews: [] }),
  });
  const empty = await loadStackPage({ data: fixture(), Forecast: quiet });
  ok(empty.periodKeys().length === 0, 'a Forecast that publishes no pay periods leaves none to select');
  ok(empty.blockHtml('waterfall') !== page.blockHtml('waterfall') || empty.blockHtml('waterfall') === '',
    'and the waterfall no longer draws what it drew');

  // The classic boot is still beside it.
  const classic = loadBudgetPage();
  ok(typeof classic.get('budgetSurfaceParts') === 'function', 'the classic page still boots in the same harness (until C1 S7)');

  console.log(`test-stack-page-harness: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
