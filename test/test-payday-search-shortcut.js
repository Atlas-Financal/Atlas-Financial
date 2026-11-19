'use strict';
/* The payday feasibility search takes fewer probes and finds the same
 * boundary (LEAD 10 hotspot #2).
 *
 * maxFeasiblePaydayRemoval (public/forecast.js) now remembers each probe
 * within one search and tries the boundary its top probe's shortfall points
 * at, verified by fits(g) and not fits(g + 1), before bisecting. This test
 * holds it to the full binary search it replaces, which this test builds
 * itself from the same source with the memo and the shortcut switched off:
 *
 *   1. on every invented figures input (test/fixtures/figures-inputs) at its
 *      own as-of date and +3, +7, +14 and +30 days, every search returns the
 *      same boundary and the complete advice is identical, with fewer probes;
 *   2. the order the search relies on holds: on those inputs at two dates,
 *      21 removals spread over three times each search's range show no
 *      feasible amount above an infeasible one, and each returned boundary
 *      is a real edge (it fits and one cent more does not), or the range top.
 *
 * Invented inputs only. `node test/test-payday-search-shortcut.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Snap = require('../scripts/figures-snapshot.js');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${label}${detail !== '' ? ' — ' + detail : ''}`); }
};

const SOURCE = fs.readFileSync(path.join(__dirname, '../public/forecast.js'), 'utf8');
const replaceOnce = (text, from, to, label) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error('anchor not found exactly once: ' + label);
  return parts.join(to);
};
// Every search's answer, arguments and probe count, recorded by a wrapper
// around the unchanged function. reference: the memo and the shortcut off.
function load({ reference }) {
  let text = replaceOnce(SOURCE, '  function maxFeasiblePaydayRemoval(plan, asOf, masterOpts, loBound, hiBound, extraDisabled) {',
    '  function maxFeasiblePaydayRemoval(...args) {\n'
    + '    const before = __probe.n; const answer = maxFeasiblePaydayRemovalInner(...args);\n'
    + '    __probe.searches.push({ args, answer, probes: __probe.n - before }); return answer;\n  }\n'
    + '  function maxFeasiblePaydayRemovalInner(plan, asOf, masterOpts, loBound, hiBound, extraDisabled) {', 'wrapper');
  text = replaceOnce(text, '  function protectedPlanCheck(plan, asOf, opts) {',
    '  function protectedPlanCheck(plan, asOf, opts) { __probe.n++;', 'probe counter');
  text = replaceOnce(text, '  const Forecast = {', '  const Forecast = { __paydayPlanCheck: paydayPlanCheck,', 'export');
  if (reference) {
    text = replaceOnce(text, '      let result = checked.get(cents);', '      let result;', 'memo off');
    text = replaceOnce(text, '    if (guess != null && guess >= loC && guess < hiC && fits(guess)) {',
      '    if (false) {', 'shortcut off');
  }
  const probe = { n: 0, searches: [] };
  const context = { module: { exports: {} }, __probe: probe };
  vm.runInNewContext(text, context, { filename: reference ? 'forecast-reference.js' : 'forecast-shortcut.js' });
  return { F: context.module.exports, probe };
}

const inputs = Snap.loadInventedInputs();
const run = (mod, input, shift) => {
  const data = structuredClone(input.doc.data);
  const asOf = mod.F.addDays(data.meta.asOf, shift);
  const before = mod.probe.searches.length;
  const advice = mod.F.recommend(data.plan, asOf,
    Snap.pageOptions(data, input.doc.periods == null ? null : structuredClone(input.doc.periods)));
  return { json: JSON.stringify(advice), searches: mod.probe.searches.slice(before) };
};

console.log('1. Same boundary and identical advice as the full binary search, with fewer probes');
{
  const shortcut = load({ reference: false }), reference = load({ reference: true });
  let evaluations = 0, searches = 0, sameAnswers = 0, sameAdvice = 0, probesNow = 0, probesBefore = 0;
  for (const input of inputs) {
    for (const shift of [0, 3, 7, 14, 30]) {
      const a = run(shortcut, input, shift), b = run(reference, input, shift);
      evaluations++;
      if (a.json === b.json) sameAdvice++;
      else ok(false, `${input.id} +${shift}: advice identical`);
      ok(a.searches.length === b.searches.length, `${input.id} +${shift}: same number of searches`,
        `${a.searches.length} vs ${b.searches.length}`);
      for (let i = 0; i < Math.min(a.searches.length, b.searches.length); i++) {
        searches++;
        if (Object.is(a.searches[i].answer, b.searches[i].answer)) sameAnswers++;
        else ok(false, `${input.id} +${shift} search ${i}: same boundary`, `${a.searches[i].answer} vs ${b.searches[i].answer}`);
        probesNow += a.searches[i].probes;
        probesBefore += b.searches[i].probes;
      }
    }
  }
  ok(evaluations === inputs.length * 5 && sameAdvice === evaluations, `complete advice identical on all ${evaluations} evaluations`,
    `${sameAdvice} of ${evaluations}`);
  ok(searches > 50 && sameAnswers === searches, `every one of ${searches} searches returns the same boundary`, `${sameAnswers} of ${searches}`);
  ok(probesNow < probesBefore * 0.6, `fewer probes: ${probesNow} vs ${probesBefore} (${Math.round(100 * (1 - probesNow / probesBefore))}% fewer)`);
  console.log(`  probes: ${probesBefore} -> ${probesNow} over ${searches} searches`);
}

console.log('2. The order the search relies on holds, and every boundary is a real edge');
{
  const mod = load({ reference: true });
  let swept = 0, points = 0, violations = 0, edges = 0, edgeFailures = 0;
  for (const input of inputs) {
    for (const shift of [0, 14]) {
      const { searches } = run(mod, input, shift);
      for (const s of searches) {
        const [plan, asOf, masterOpts, loBound, hiBound, extraDisabled] = s.args;
        const fits = cents => mod.F.__paydayPlanCheck(plan, asOf, masterOpts, cents / 100, extraDisabled).feasible;
        const lo = Math.round(loBound * 100), hi = Math.max(lo, Math.round(hiBound * 100));
        const span = Math.max(1, hi - lo);
        const xs = [...new Set(Array.from({ length: 21 }, (_, i) => lo - span + Math.round(i * 3 * span / 20)))].sort((x, y) => x - y);
        let seenInfeasible = false;
        for (const x of xs) {
          points++;
          if (!fits(x)) seenInfeasible = true;
          else if (seenInfeasible) violations++;
        }
        swept++;
        const b = Math.round(s.answer * 100);
        if (b >= lo && b < hi) {
          edges++;
          if (!(fits(b) && !fits(b + 1))) edgeFailures++;
        }
      }
    }
  }
  ok(swept > 20 && violations === 0, `no feasible removal above an infeasible one: ${swept} searches, ${points} removals`, String(violations));
  ok(edges > 10 && edgeFailures === 0, `each in-range boundary fits and one cent more does not (${edges} boundaries)`, String(edgeFailures));
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} payday-search checks passed`);
process.exit(failures ? 1 : 0);
