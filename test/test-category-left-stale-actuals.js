'use strict';
/* T3 bug hunt 2, findings 1 and 2 (#1607 7147675369; scope from ATLAS LEAD 13): what a household category has Left
 * (or Over) is published only with the full claim on the period's spending (remainingClaim 'precise'), as the household
 * delta is.
 *   Finding 1: the feed does not cover through the as-of day (`coverageThrough` before it, claim 'unavailable'), so
 *   spent is unknown; main published `remaining = planned`, `overspend: 0`, and the sheet read "Left $<whole plan>".
 *   Finding 2: pending coverage is unknown or partial (claim 'posted-only'), so posted spent is a lower bound; main
 *   published `remaining = planned − posted` with no trust, and the sheets read "Left $313" (Other) and "Left $110".
 * Now every row's remaining and overspend are null, with remainingTrust 'unavailable' and Forecast's own reason.
 *
 *   1. Finding 1's invented repro (test/fixtures/other-period-target.js, coverageThrough one day before the as-of):
 *      on main every named category publishes its whole plan as remaining and the Groceries sheet reads "Left $220";
 *      on this head every named category publishes remaining and overspend null, as the Other row does, and the sheet
 *      prints no Left, as the Other sheet does.
 *   1b. Finding 2's invented repros (pendingCoverage 'unknown' and 'partial'): main printed "Left $313" (Other) and
 *      "Left $110" (Groceries); this head withholds every row's Left with the coverage reason. Spent stays published.
 *   2. Unchanged: the hold (each category still reserves its plan), the household total (published as partial for
 *      finding 2, withheld for finding 1), a complete feed (Left = plan − spent, byte-equal to main), and a later period
 *      with no actuals in play (Left = its plan).
 *   3. Mutants: the full-claim rule removed, and the posted-only case let through, are each caught.
 *
 * Invented data only. `node test/test-category-left-stale-actuals.js`
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast.js');
const fx = require('./fixtures/other-period-target.js');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const BASE = '2ea0cc18a6cc02456bb2e73f08b66088dc507aa4'; // main before this change
function engine(source) {
  const c = { console };
  c.window = c;
  vm.createContext(c);
  for (const file of ['public/display-name.js', 'public/forecast-card-period.js']) vm.runInContext(read(file), c);
  vm.runInContext(source, c);
  return c.Forecast;
}
const OLD = engine(cp.execFileSync('git', ['show', BASE + ':public/forecast.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const NAMED = ['groceries', 'fuel', 'pets', 'restaurants', 'dale-guilt-free', 'amanda-guilt-free'];

function world(stale) {
  const x = fx.build(137.26, fx.asOf);
  if (stale) x.packet.coverageThrough = '2026-10-03'; // one day before the as-of 2026-10-04
  return x;
}
const advise = (E, x) => E.recommend(x.plan, x.date, { ...x.plan.defaults, debts: [], currentPeriodActuals: x.packet });
const active = rec => rec.payPeriodViews.find(v => v.role === 'active');
const rows = view => new Map((view.householdBudget || []).map(r => [r.id, r]));

function sheet(rec, x, key) {
  const ctx = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '?view=classic' }, document: { addEventListener() {}, getElementById: () => null } };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  for (const f of ['waterfall', 'cards', 'credit', 'sheet']) vm.runInContext(read(`public/stack-${f}.js`), ctx);
  const v = active(rec);
  const html = ctx.StackSheet.html({ recommendation: rec, selectedPeriodKey: v.start, data: x.data, plan: x.plan, Forecast: F }, key);
  return html ? html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

console.log('1. The feed does not cover through today');
{
  const x = world(true);
  const before = rows(active(advise(OLD, x)));
  ok(NAMED.every(id => before.get(id).spent === null && before.get(id).remaining === before.get(id).planned && before.get(id).overspend === 0),
    'main: every named category publishes its whole plan as Left and 0 Over while its spent is unknown (the defect)');
  ok(/Groceries \/ \$220 Left \$220/.test(sheet(advise(OLD, x), x, 'budget:groceries')), 'main: the Groceries sheet reads "Left $220"');
  const rec = advise(F, x), now = rows(active(rec));
  ok(NAMED.every(id => now.get(id).spent === null && now.get(id).remaining === null && now.get(id).overspend === null),
    'this head: every named category publishes Left and Over unknown (null)', JSON.stringify(NAMED.map(id => [id, now.get(id).remaining])));
  const reason = 'Transaction actuals are not current through the financial as-of.';
  ok([...now.values()].every(r => r.remainingTrust === 'unavailable' && r.remainingReason === reason),
    'every row is tagged remainingTrust unavailable with Forecast\'s own coverage reason', JSON.stringify([...now.values()].map(r => r.remainingReason)));
  const other = now.get('other-spending');
  ok(other && other.remaining === null && other.overspend === null, 'the same as the Other row');
  const g = sheet(rec, x, 'budget:groceries'), o = sheet(rec, x, 'budget:other-spending');
  ok(/Groceries \/ \$220$/.test(g) && !/Left|Over/.test(g) && !/Left|Over/.test(o),
    'the Groceries sheet prints no Left, as the Other sheet does', g);
  const hh = active(rec).budgetProgress.household;
  ok(hh.actual.amount === null && hh.delta.amount === null && hh.delta.trust === 'unavailable', 'the household total stays withheld');
  ok(NAMED.every(id => now.get(id).hold === before.get(id).hold && now.get(id).planned === before.get(id).planned),
    'each category\'s hold and plan are unchanged (it still reserves its plan)');
  ok(active(rec).budgetHold === active(advise(OLD, x)).budgetHold, 'the period\'s Household budget hold is unchanged');
}

console.log('1b. Pending coverage unknown or partial (finding 2)');
for (const pendingCoverage of ['unknown', 'partial']) {
  const x = fx.build(137.26, fx.asOf, { pendingCoverage });
  const recOld = advise(OLD, x), rec = advise(F, x);
  const before = rows(active(recOld)), now = rows(active(rec));
  ok(before.get('other-spending').remaining === 312.74 && before.get('groceries').remaining === 109.63,
    pendingCoverage + ', main: Other publishes 450.00 − 137.26 = 312.74 left and Groceries 220.00 − 110.37 = 109.63, as fact (the defect)');
  ok(/Left \$313/.test(sheet(recOld, x, 'budget:other-spending')) && /Left \$110/.test(sheet(recOld, x, 'budget:groceries')),
    pendingCoverage + ', main: the sheets read "Left $313" and "Left $110"');
  const reason = 'Pending coverage is not complete. Observed pending still constrains remaining; additional unknown pending may exist.';
  ok([...now.values()].every(r => r.remaining === null && r.overspend === null && r.remainingTrust === 'unavailable' && r.remainingReason === reason),
    pendingCoverage + ', this head: every row\'s Left and Over are withheld, with the coverage reason', JSON.stringify([...now.values()].map(r => [r.id, r.remaining, r.remainingReason])));
  ok(now.get('groceries').spent === 110.37 && now.get('other-spending').spent === 137.26
    && [...now.values()].every(r => r.hold === before.get(r.id).hold && r.planned === before.get(r.id).planned),
    pendingCoverage + ': spent (the posted lower bound), the plan and the hold are unchanged');
  ok(!/Left|Over/.test(sheet(rec, x, 'budget:other-spending')) && !/Left|Over/.test(sheet(rec, x, 'budget:groceries')),
    pendingCoverage + ': the sheets print no Left');
  ok(JSON.stringify(active(rec).budgetProgress) === JSON.stringify(active(recOld).budgetProgress) && active(rec).budgetHold === active(recOld).budgetHold,
    pendingCoverage + ': the household total (published as partial, no badge per OD-034) and the hold are byte-equal to main');
}

console.log('2. Unchanged where the feed is current, or no actuals are in play');
{
  const x = world(false);
  const a = advise(F, x), b = advise(OLD, x);
  ok(JSON.stringify(active(a).householdBudget) === JSON.stringify(active(b).householdBudget),
    'a current feed: every category row is byte-equal to main');
  const g = rows(active(a)).get('groceries');
  ok(g.spent === 110.37 && g.remaining === 109.63 && g.overspend === 0, 'Groceries: 220.00 − 110.37 = 109.63 left (worked by hand)', JSON.stringify(g));
  const later = (rec, E) => rec.payPeriodViews.find(v => v.role === 'future');
  const st = world(true), fa = later(advise(F, st)), fb = later(advise(OLD, st));
  ok(fa && JSON.stringify(fa.householdBudget) === JSON.stringify(fb.householdBudget)
    && rows(fa).get('groceries').remaining === rows(fa).get('groceries').planned,
    'a later period (no actuals in play): Left is its plan, as on main');
}

console.log('3. Mutant');
{
  const src = read('public/forecast.js');
  const from = "if (useActuals && !lookback && packet && coverage.remainingClaim !== 'precise') {";
  assert.ok(src.includes(from));
  const M1 = engine(src.replace(from, 'if (false) {'));
  ok(rows(active(advise(M1, world(true)))).get('groceries').remaining === 220, 'mutant caught: without the rule Left is the whole plan again');
  const M2 = engine(src.replace(from, "if (useActuals && !lookback && packet && coverage.remainingClaim === 'unavailable') {"));
  ok(rows(active(advise(M2, fx.build(137.26, fx.asOf, { pendingCoverage: 'unknown' })))).get('other-spending').remaining === 312.74,
    'mutant caught: letting the posted-only claim through prints the upper bound as Left again');
}
console.log(`\n${checks} checks passed`);
