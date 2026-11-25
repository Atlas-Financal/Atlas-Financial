'use strict';
/* T3 bug hunt 2, finding 1 (#1607 7147675369): when the period's transaction feed does not cover through the as-of day
 * (`coverageThrough` before it, remainingClaim 'unavailable'), a named household category's spent is unknown, so what is
 * Left (and Over) is unknown too. Main published `remaining = planned` and `overspend: 0` with no trust, and the Stack
 * sheet printed "Left $<whole plan>" while the card head, the Other row and the household total withheld.
 *
 *   1. The hunt's invented repro (test/fixtures/other-period-target.js, coverageThrough one day before the as-of):
 *      on main every named category publishes its whole plan as remaining and the Groceries sheet reads "Left $220";
 *      on this head every named category publishes remaining and overspend null, as the Other row does, and the sheet
 *      prints no Left, as the Other sheet does.
 *   2. Unchanged: the hold (each category still reserves its plan), the household total's withhold, a current feed
 *      (Left = plan − spent), and a later period with no actuals in play (Left = its plan).
 *   3. A mutant removing the coverage-lost condition is caught.
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
  const from = 'remaining: coverageLost ? null : remaining,';
  assert.ok(src.includes(from));
  const M = engine(src.replace(from, 'remaining,'));
  ok(rows(active(advise(M, world(true)))).get('groceries').remaining === 220, 'mutant caught: without the condition Left is the whole plan again');
}
console.log(`\n${checks} checks passed`);
