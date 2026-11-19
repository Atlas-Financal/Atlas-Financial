'use strict';
/* Each week's low is read from its own days, and every answer is unchanged
 * (ATLAS LEAD 11, speed-up 6).
 *
 * simulateModel (public/forecast.js) found each week's low by filtering every
 * day of the walk by date, once per week: weeks x days work on every
 * simulation. It now reads week wi's own rows, 7 * wi .. 7 * wi + 6 (fewer in
 * a short final week), starting from the week's seed, with Math.min. That is
 * the same set of rows only while the day loop pushes exactly one row per
 * walked day, in order. This test holds that invariant and the answer:
 *
 *   1. at every walk the corpus makes, in the shipped engine: `daily` has one
 *      row per walked day (daily.length === days), row i is the walk's day i,
 *      week k starts on row 7k and ends six days later, and each week's
 *      published low equals the incumbent filter over every day (the seeds
 *      are taken before the week pass). A change that filtered or extended
 *      `daily` between the day loop and the week pass (a measured-only push,
 *      say) fails here rather than letting the fix diverge; section 4 shows it;
 *   2. the real week pass, run on crafted rows (NaN, -0 and +0, a short final
 *      week, a single day, a seed below or above every day), gives the
 *      incumbent filter's answer, Object.is for Object.is;
 *   3. a reference copy with the incumbent filter gives identical advice on
 *      all 60 invented figures evaluations, two held-income worlds and a
 *      753-transaction harness world;
 *   4. mutants are caught: an off-by-one window (from row 7wi + 1, or six
 *      rows), windows that ignore the short final week, `<` in place of
 *      Math.min, a week pass that forgets the seed, and a day loop that pushes
 *      only measured days.
 *
 * Invented data only. `node test/test-week-low-own-days.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Snap = require('../scripts/figures-snapshot.js');
const World = require('./fixtures/held-other-income-search-world');
const H = require('./acceptance/harness.js');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};

const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const replaceOnce = (text, from, to, label) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error('anchor not found exactly once: ' + label);
  return parts.join(to);
};
function compile(text, name) {
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(text, FILE.replace(/\.js$/, '-' + name + '.js'));
  return mod.exports;
}
const P = 'globalThis.__atlasWeekLowProof';
const BEFORE = '    for (let wi = 0; wi < weeks.length; wi++) {\n      const w = weeks[wi];';
const LOW = '      for (let j = wi * 7, stop = Math.min(wi * 7 + 7, daily.length); j < stop; j++) low = Math.min(low, daily[j].balance);';
const AFTER = '      delete w.measuredOpening;\n    }\n';
const PUSH = '      daily.push({ date, balance });';
const INCUMBENT = '      const low = Math.min(seed, ...daily.filter(d => d.date >= w.start && d.date <= w.end).map(d => d.balance));';
// Instrument a copy: before the week pass, check the one-row-per-day
// invariant and keep each week's seed; optionally swap in crafted rows; after
// it, compare every published low with the incumbent filter over every day.
function instrumented(text) {
  text = replaceOnce(text, BEFORE, `    if (${P} && ${P}.craft) {
      daily.length = 0; for (const d of ${P}.craft.daily) daily.push(d);
      weeks.length = 0; for (const w of ${P}.craft.weeks) weeks.push(Object.assign({}, w));
    } else if (${P}) {
      ${P}.walks++;
      if (daily.length !== days) ${P}.badLength++;
      for (let i = 0; i < daily.length; i++) if (!daily[i] || daily[i].date !== walkDates[i]) { ${P}.badDate++; break; }
      weeks.forEach((w, k) => {
        if (!daily[7 * k] || w.start !== daily[7 * k].date || w.end !== addDays(w.start, 6)) ${P}.badWeek++;
      });
    }
    const __seeds = weeks.map(w => (w.measuredOpening != null ? w.measuredOpening : w.opening));
` + BEFORE, 'before week pass');
  text = replaceOnce(text, AFTER, AFTER + `    if (${P}) {
      const lows = weeks.map((w, k) => Math.min(__seeds[k], ...daily.filter(d => d.date >= w.start && d.date <= w.end).map(d => d.balance)));
      if (${P}.craft) { ${P}.craft.got = weeks.map(w => w.low); ${P}.craft.want = lows; throw new Error('__crafted__'); }
      weeks.forEach((w, k) => { ${P}.weeks++; if (!Object.is(w.low, lows[k])) ${P}.lowDiffer++; });
    }
`, 'after week pass');
  return text;
}
const SHIPPED = instrumented(SOURCE);
const mutate = (from, to, label) => compile(replaceOnce(SHIPPED, from, to, label), label);
const copies = {
  shipped: compile(SHIPPED, 'shipped'),
  // The incumbent: the date filter over every day, in place of the index read.
  reference: mutate('      let low = seed;\n' + LOW, INCUMBENT, 'incumbent filter'),
  fromNext: mutate(LOW, LOW.replace('let j = wi * 7,', 'let j = wi * 7 + 1,'), 'from-next-row'),
  sixRows: mutate(LOW, LOW.replace('Math.min(wi * 7 + 7, daily.length)', 'Math.min(wi * 7 + 6, daily.length)'), 'six-rows'),
  ignoresShortWeek: mutate(LOW, LOW.replace('stop = Math.min(wi * 7 + 7, daily.length)', 'stop = wi * 7 + 7')
    .replace('low = Math.min(low, daily[j].balance)', 'low = Math.min(low, daily[j] ? daily[j].balance : -Infinity)'), 'ignores-short-week'),
  lessThan: mutate(LOW, LOW.replace('low = Math.min(low, daily[j].balance);', '{ if (daily[j].balance < low) low = daily[j].balance; }'), 'less-than'),
  noSeed: mutate('      let low = seed;\n', '      let low = Infinity;\n', 'no-seed'),
  measuredOnly: mutate(PUSH, '      if (measured) daily.push({ date, balance });', 'measured-only-push'),
};
ok(new Set(Object.values(copies)).size === Object.keys(copies).length, `${Object.keys(copies).length} independent engine copies`);

// The corpus: each case returns the recommend arguments, freshly cloned.
const cases = [];
for (const input of Snap.loadInventedInputs()) {
  for (const shift of [0, 3, 7, 14, 30]) {
    cases.push({ id: `${input.id} +${shift}`, kind: 'invented', args: F => {
      const data = structuredClone(input.doc.data);
      return [data.plan, F.addDays(data.meta.asOf, shift),
        Snap.pageOptions(data, input.doc.periods == null ? null : structuredClone(input.doc.periods))];
    } });
  }
}
const HELD_AS_OF = '2026-11-10';
for (const [label, world] of [
  ['held world, 120 purchases', { transactions: 120, days: 30, rebate: { date: '2026-11-12', amount: 200 },
    receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] }],
  ['held world with the payroll walk', { walk: true, transactions: 120, days: 30, rebate: { date: '2026-11-12', amount: 200 },
    receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] }],
]) {
  const data = World.build(Object.assign({ asOf: HELD_AS_OF }, world));
  cases.push({ id: label, kind: 'held', args: () => {
    const d = structuredClone(data);
    return [d.plan, HELD_AS_OF, World.recommendOptions(d)];
  } });
}
{
  // The harness world with 753 invented purchases (567 fall on or before as-of).
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  for (let i = 0; i < 753; i++) {
    const d = H.lm({ date: '2026-' + (i % 2 ? '10' : '09') + '-' + String(1 + (i % 28)).padStart(2, '0'),
      amount: 5 + (i % 37), category: i % 3 ? 'Groceries' : 'Restaurants', account: 'chequing-a', payee: 'Invented merchant ' + (i % 50) });
    if (d.date <= w.asOf) w.transactions.push(d);
  }
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  cases.push({ id: `harness world, ${w.transactions.length - 1} purchases`, kind: 'large', args: () => {
    const d = structuredClone(data);
    return [d.plan, w.asOf, { debts: d.debts, currentPeriodActuals: structuredClone(packet) }];
  } });
}
const fresh = () => ({ walks: 0, weeks: 0, badLength: 0, badDate: 0, badWeek: 0, lowDiffer: 0, craft: null });
function run(F, c) {
  const proof = globalThis.__atlasWeekLowProof = fresh();
  let json;
  try { json = JSON.stringify(F.recommend(...c.args(F))); } catch (err) { json = 'error: ' + (err && err.message); }
  globalThis.__atlasWeekLowProof = null;
  return { json, proof };
}
const sum = (rs, k) => rs.reduce((n, r) => n + r.proof[k], 0);

console.log('1. At every walk: one row per day, aligned weeks, and each low equals the incumbent filter');
const shippedRuns = cases.map(c => run(copies.shipped, c));
{
  const walks = sum(shippedRuns, 'walks'), weeks = sum(shippedRuns, 'weeks');
  ok(walks > 1000 && sum(shippedRuns, 'badLength') === 0 && sum(shippedRuns, 'badDate') === 0,
    `${walks} walks: daily has exactly one row per walked day, row i on the walk's day i`,
    JSON.stringify({ badLength: sum(shippedRuns, 'badLength'), badDate: sum(shippedRuns, 'badDate') }));
  ok(sum(shippedRuns, 'badWeek') === 0, 'every week starts on row 7k and ends six days later', String(sum(shippedRuns, 'badWeek')));
  ok(weeks > 20000 && sum(shippedRuns, 'lowDiffer') === 0, `all ${weeks} published week lows equal the incumbent filter over every day`,
    String(sum(shippedRuns, 'lowDiffer')));
}

console.log('2. The real week pass on crafted rows gives the incumbent answer');
// A small invented world, simulated with crafted rows swapped in before the
// week pass. Each case: the days' balances (consecutive dates), and the seeds.
const craftWorld = (() => { const c = cases.find(x => x.kind === 'held'); return c.args(copies.shipped); })();
const day0 = '2026-03-01';
const craftCase = (balances, seeds) => {
  const daily = balances.map((balance, i) => ({ date: copies.shipped.addDays(day0, i), balance }));
  const weeks = seeds.map((opening, k) => ({ start: copies.shipped.addDays(day0, 7 * k), end: copies.shipped.addDays(day0, 7 * k + 6), opening }));
  return { daily, weeks };
};
const crafted = [
  ['NaN on one day', [5, NaN, 7, 1, 2, 3, 4, 9], [10, 10]],
  ['-0 and +0', [0, -0, 0, 3, 3, 3, 3, -0, 0], [0, 0]],
  ['+0 seed with a -0 day', [1, 1, -0, 1, 1, 1, 1], [0]],
  ['a short final week', [9, 8, 7, 6, 5, 4, 3, 2, 1, 0.5], [20, 20]],
  ['a single day', [4], [6]],
  ['the seed below every day', [5, 6, 7, 8, 9, 10, 11], [-3]],
  ['the seed above every day', [-5, -6, -7, -8, -9, -10, -11, -1, -2], [100, 100]],
  ['Infinity and -Infinity', [Infinity, 3, -Infinity, 1, 1, 1, 1], [2]],
];
function craftedLows(F, rows, seeds) {
  const proof = globalThis.__atlasWeekLowProof = fresh();
  proof.craft = craftCase(rows, seeds);
  const [plan, asOf, opts] = craftWorld;
  try { F.simulate(structuredClone(plan), asOf, Object.assign({}, opts, { horizonDays: 14 })); } catch (err) {
    if (!err || err.message !== '__crafted__') throw err;
  }
  globalThis.__atlasWeekLowProof = null;
  return { got: proof.craft.got, want: proof.craft.want };
}
{
  for (const [label, rows, seeds] of crafted) {
    const r = craftedLows(copies.shipped, rows, seeds);
    ok(Array.isArray(r.got) && r.got.length === r.want.length && r.got.every((v, i) => Object.is(v, r.want[i])),
      `${label}: the published lows are the incumbent's, Object.is`, JSON.stringify({ got: String(r.got), want: String(r.want) }));
  }
}

console.log('3. Identical advice with the incumbent filter');
{
  let same = 0;
  cases.forEach((c, i) => {
    const off = run(copies.reference, c);
    if (shippedRuns[i].json === off.json && !off.json.startsWith('error')) same++;
    else ok(false, `${c.id}: advice identical`);
  });
  ok(cases.filter(c => c.kind === 'invented').length === 60 && same === cases.length,
    `advice identical on all ${cases.length} cases (60 invented evaluations, 2 held worlds, the 753-transaction world)`, `${same} of ${cases.length}`);
}

console.log('4. Mutants are caught');
const caught = name => {
  let advice = 0, invariant = 0, cases2 = 0;
  cases.forEach((c, i) => {
    const r = run(copies[name], c);
    if (r.json !== shippedRuns[i].json) advice++;
    invariant += r.proof.badLength + r.proof.badDate + r.proof.badWeek + r.proof.lowDiffer;
  });
  for (const [, rows, seeds] of crafted) {
    let r;
    try { r = craftedLows(copies[name], rows, seeds); } catch (_) { cases2++; continue; }
    if (!(Array.isArray(r.got) && r.got.every((v, j) => Object.is(v, r.want[j])))) cases2++;
  }
  return { advice, invariant, crafted: cases2 };
};
for (const [name, label] of [['fromNext', 'a window from row 7wi + 1'], ['sixRows', 'a six-row window'],
  ['ignoresShortWeek', 'windows that ignore the short final week'], ['lessThan', '< in place of Math.min'],
  ['noSeed', 'a week pass that forgets the seed'], ['measuredOnly', 'a day loop that pushes only measured days']]) {
  const r = caught(name);
  ok(r.advice + r.invariant + r.crafted > 0, `${label} is caught`, JSON.stringify(r));
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} week-low checks passed`);
process.exit(failures ? 1 : 0);
