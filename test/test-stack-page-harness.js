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
 * status() has three lines that each say "not usable"; every one has its own scenario below, and the mutation section
 * removes each line from a copy of the harness and shows a scenario then fails. After a fall-back on a later draw
 * nothing stale is returned (blockHtml, context, selectPeriod and the keys all say nothing).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

  // The next draw the shell makes throws, once (its first look inside its own root), then the page is left as it was.
  const breakNextDraw = p => {
    const root = p.document.__root; const original = root.querySelector;
    root.querySelector = function (...args) { root.querySelector = original; throw new Error('a later draw fails'); };
  };

  // Each status() line has a scenario that reaches it. A scenario returns the status and a few reads taken from it.
  const F2 = require('../public/forecast.js');
  const scenarios = {
    // The page fell back: Forecast throws when the shell asks for the plan.
    'fell-back': lib => lib.loadStackPage({ data: fixture(),
      Forecast: Object.assign({}, F2, { recommend: (...args) => {
        // Only the shell's own call throws (the classic page, which runs first, would stop the shell being reached).
        if (/stack-shell\.js/.test(new Error().stack)) throw new Error('forced');
        return F2.recommend(...args);
      } }) }),
    // The shell stays inert on the classic route: nothing is mounted.
    'not-mounted': lib => lib.loadStackPage({ data: fixture(),
      globals: { location: { pathname: '/', search: '?view=classic', hash: '', href: 'http://stack-page.test/?view=classic', reload() {} } } }),
    // ATLAS-080: a withheld settlement outcome publishes no plan, so the shell has no recommendation.
    'no-recommendation': lib => lib.loadStackPage({ data: Object.assign(fixture(), { settlementEvidenceStatus: { status: 'unavailable', reason: 'invalid-configuration' } }) }),
    'rendered': lib => lib.loadStackPage({ data: fixture() }),
  };
  const statusesOf = async lib => {
    const out = {};
    for (const [name, make] of Object.entries(scenarios)) out[name] = (await make(lib)).status();
    return out;
  };
  const expectedStatuses = { 'fell-back': 'fell-back', 'not-mounted': 'not-mounted', 'no-recommendation': 'no-recommendation', rendered: 'rendered' };
  const real = await statusesOf(require('./lib/budget-page-harness'));
  ok(JSON.stringify(real) === JSON.stringify(expectedStatuses),
    'each scenario reaches its own status: fell-back, not-mounted, no-recommendation and rendered', JSON.stringify(real));
  for (const name of ['fell-back', 'not-mounted', 'no-recommendation']) {
    const p = await scenarios[name](require('./lib/budget-page-harness'));
    ok(p.blockHtml('waterfall') === '' && p.context() === null && p.periodKeys().length === 0 && p.selectedKey() === null,
      'a page that is ' + name + ' returns no block HTML, context, periods or selection');
    ok(p.selectPeriod('2026-10-02') === null, 'and pressing a chip on it selects nothing');
  }

  // A press on a page that is not rendered never reaches the shell's handler (it would redraw a page that is gone).
  const handlerCallsOnFellBack = async lib => {
    const p = await lib.loadStackPage({ data: fixture() });
    const keys = p.periodKeys();
    breakNextDraw(p);
    p.selectPeriod(keys.find(k => k !== p.selectedKey()));          // the page falls back on this press
    let calls = 0;
    p.document.__root.listeners.click = [() => { calls++; }];
    p.selectPeriod(keys[0]);
    return calls;
  };
  ok((await handlerCallsOnFellBack(require('./lib/budget-page-harness'))) === 0,
    'a press on a page that fell back does not reach the shell\'s handler');

  // A fall-back on a later draw: the page rendered, then a later draw throws and the shell hands back the classic page.
  const later = await loadStackPage({ data: fixture() });
  const laterKeys = later.periodKeys();
  ok(later.status() === 'rendered' && later.blockHtml('waterfall').length > 200, 'the page rendered before the later draw');
  breakNextDraw(later);
  ok(later.selectPeriod(laterKeys.find(k => k !== later.selectedKey())) === null, 'pressing a chip whose draw throws selects nothing');
  ok(later.status() === 'fell-back', 'and the page reads fell-back', later.status());
  ok(later.blockHtml('waterfall') === '' && later.blockHtml('cards') === '' && later.context() === null
    && later.periodKeys().length === 0 && later.selectedKey() === null,
    'after the fall-back no stale block HTML, context, periods or selection is returned');
  ok(later.selectPeriod(laterKeys[0]) === null, 'and a later press selects nothing either');

  // Mutation: remove each status() line, and each gate on a read, from a copy of the harness; a scenario must then fail.
  const source = fs.readFileSync(path.join(__dirname, 'lib', 'budget-page-harness.js'), 'utf8');
  const mutants = [
    ['the errors line', "    if (errors.length) return 'fell-back';\n", ''],
    ['the not-mounted line', "    if (!root()) return 'not-mounted';\n", ''],
    ['the no-recommendation line', "    if (!ctx || !ctx.recommendation) return 'no-recommendation';\n", ''],
    ['the gate on blockHtml', "blockHtml: name => (live() && block(name)", "blockHtml: name => ((true) && block(name)"],
    ['the gate on selectPeriod', "      if (!live()) return null;\n      const handlers", "      const handlers"],
    ['the gate on selectedKey', "selectedKey: () => { const ctx = live() ? context() : null;", "selectedKey: () => { const ctx = context();"],
    ['the gate on periodKeys', "const ctx = live() ? context() : null;\n      const views", "const ctx = context();\n      const views"],
    ['the gate on context', "context: () => (live() ? context() : null),", "context: () => context(),"],
  ];
  for (const [what, from, to] of mutants) {
    assert.ok(source.split(from).length === 2, 'the mutation target appears once: ' + what);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-harness-'));
    try {
      fs.mkdirSync(path.join(tmp, 'test', 'lib'), { recursive: true });
      fs.symlinkSync(path.join(__dirname, '..', 'public'), path.join(tmp, 'public'));
      fs.writeFileSync(path.join(tmp, 'test', 'lib', 'budget-page-harness.js'), source.replace(from, to));
      const mutated = require(path.join(tmp, 'test', 'lib', 'budget-page-harness.js'));
      const seen = await statusesOf(mutated);
      let staleOk = true;
      const m = await mutated.loadStackPage({ data: fixture() });
      const mk = m.periodKeys();
      breakNextDraw(m);
      const pressed = m.selectPeriod(mk.find(k => k !== m.selectedKey()));
      staleOk = pressed === null && m.blockHtml('waterfall') === '' && m.context() === null && m.selectedKey() === null
        && m.periodKeys().length === 0;
      const statusSame = JSON.stringify(seen) === JSON.stringify(expectedStatuses);
      const pressedGone = (await handlerCallsOnFellBack(mutated)) === 0;
      ok(!statusSame || !staleOk || !pressedGone, 'removing ' + what + ' makes a scenario fail', JSON.stringify(seen) + ' stale-ok=' + staleOk + ' press-gated=' + pressedGone);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // The classic boot is still beside it.
  const classic = loadBudgetPage();
  ok(typeof classic.get('budgetSurfaceParts') === 'function', 'the classic page still boots in the same harness (until C1 S7)');

  console.log(`test-stack-page-harness: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
