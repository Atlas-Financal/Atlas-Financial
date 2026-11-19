'use strict';
/* The walk's date list gives the same dates, and the advice is unchanged
 * (ATLAS LEAD 11, speed-up 4).
 *
 * simulateModel (public/forecast.js) walks its days from a list built by
 * walkDateList(start, days) instead of calling addDays(start, i) on every
 * day. The last list is kept for exactly that start and length, frozen.
 * This test holds it to an independent calendar reference and to a copy of
 * the same source with the list switched off:
 *
 *   1. every start 2019-01-01 .. 2033-12-31 at lengths 0, 1, 7, 28, 91, 92,
 *      182, 365 and 400, asked so that the same length follows a different
 *      start and a different length follows the same start, matches the
 *      reference date for date, and so does every
 *      (start, length) the corpus below actually walks; a kept list is frozen
 *      and is handed back only for the same start and length;
 *   2. a reference copy with the list off gives identical advice on all 60
 *      invented figures evaluations (12 inputs at +0/3/7/14/30 days), on two
 *      held-income worlds and on a 753-transaction harness world;
 *   3. mutants are caught, by the sweep in 1 or by the advice in 2: an
 *      off-by-one list, a list kept across a different start, a list too
 *      short for the requested length (kept for any length), and a longer
 *      kept list whose own length drives the walk past what was asked. On
 *      this corpus no two walks in a row share a length but not a start, so
 *      the cross-start mutant changes no advice here; the sweep asks for
 *      exactly that pattern and catches it.
 *
 * Why a walk cannot read past its length: the list is handed back only when
 * its length equals the requested days, and the loop reads indexes below
 * days. Mutant 4 shows what would break if either held only loosely.
 *
 * Invented data only. `node test/test-walk-date-list.js`
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
const P = 'globalThis.__atlasWalkProof';
const READ = '      const date = walkDates[i];';
const KEY = 'if (walkDateMemo && walkDateMemo.start === start && walkDateMemo.dates.length === days) return walkDateMemo.dates;';
const PUSH = '    for (let i = 0; i < days; i++) dates.push(addDays(start, i));';
const LOOP = '    const walkDates = walkDateList(start, days);\n    for (let i = 0; i < days; i++) {';
// Every copy exports the list and records each (start, days) a walk asks for.
const instrumented = text => replaceOnce(
  replaceOnce(text, '  function walkDateList(start, days) {',
    `  function walkDateList(start, days) { if (${P}) ${P}.asked.push([start, days]);`, 'record'),
  '  const Forecast = {', '  const Forecast = { __walkDateList: walkDateList,', 'export');
const SHIPPED = instrumented(SOURCE);
const copies = {
  shipped: compile(SHIPPED, 'shipped'),
  reference: compile(replaceOnce(SHIPPED, READ, '      const date = addDays(start, i);', 'list off'), 'reference'),
  offByOne: compile(replaceOnce(SHIPPED, PUSH, PUSH.replace('addDays(start, i)', 'addDays(start, i + 1)'), 'off by one'), 'off-by-one'),
  anyStart: compile(replaceOnce(SHIPPED, KEY, KEY.replace('walkDateMemo.start === start && ', ''), 'any start'), 'any-start'),
  anyLength: compile(replaceOnce(SHIPPED, KEY, KEY.replace(' && walkDateMemo.dates.length === days', ''), 'any length'), 'any-length'),
  readsPast: compile(replaceOnce(replaceOnce(SHIPPED, KEY, KEY.replace('walkDateMemo.dates.length === days', 'walkDateMemo.dates.length >= days'), 'longer kept'),
    LOOP, '    const walkDates = walkDateList(start, days);\n    for (let i = 0; i < walkDates.length; i++) {', 'walk reads past'), 'reads-past'),
};
ok(new Set(Object.values(copies)).size === Object.keys(copies).length, `${Object.keys(copies).length} independent engine copies`);

// Independent calendar reference: setUTCDate on a fresh Date.
const pad = (n, w = 2) => String(n).padStart(w, '0');
function refAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + n);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
const matches = (list, start, days) => Array.isArray(list) && list.length === days && list.every((d, i) => d === refAddDays(start, i));

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
function run(F, c) {
  globalThis.__atlasWalkProof = { asked: [] };
  let json;
  try { json = JSON.stringify(F.recommend(...c.args(F))); } catch (err) { json = 'error: ' + (err && err.message); }
  const asked = globalThis.__atlasWalkProof.asked;
  globalThis.__atlasWalkProof = null;
  return { json, asked };
}

// Every start 2019-2033. Each step asks, in turn: a length; the previous
// start at that same length (a kept list must not cross starts); the previous
// start at another length; and this start at that other length (a kept list
// must not cross lengths).
function sweep(L) {
  const lengths = [0, 1, 7, 28, 91, 92, 182, 365, 400];
  let compared = 0, wrong = 0, firstWrong = '';
  let day = '2019-01-01', k = 0;
  while (day <= '2033-12-31') {
    const n = lengths[k % lengths.length], m = lengths[(k + 4) % lengths.length], prev = refAddDays(day, -1);
    for (const [start, len] of [[day, n], [prev, n], [prev, m], [day, m]]) {
      compared++;
      let list;
      try { list = L(start, len); } catch (_) { list = null; }
      if (!matches(list, start, len)) { wrong++; if (!firstWrong) firstWrong = `${start} x ${len}`; }
    }
    day = refAddDays(day, 1); k++;
  }
  return { compared, wrong, firstWrong };
}
console.log('1. The list matches an independent calendar, and a kept list is frozen and exact');
{
  const L = copies.shipped.__walkDateList;
  const { compared, wrong, firstWrong } = sweep(L);
  ok(compared > 20000 && wrong === 0, `${compared} lists over every start 2019-2033 match the reference date for date`, firstWrong);
  const a = L('2026-02-27', 5), b = L('2026-02-27', 5);
  ok(a === b && Object.isFrozen(a), 'the same start and length hands back the same frozen list');
  let threw = false;
  try { a[0] = '1999-01-01'; } catch (_) { threw = true; }
  ok(threw && a[0] === '2026-02-27', 'a write to a kept list throws and changes nothing');
  ok(L('2026-02-27', 6) !== a && matches(L('2026-02-27', 6), '2026-02-27', 6)
    && L('2026-02-28', 5) !== a && matches(L('2026-02-28', 5), '2026-02-28', 5),
    'another length or another start builds a new, correct list');
  ok(matches(L('2028-02-27', 4), '2028-02-27', 4) && L('2028-02-27', 4)[2] === '2028-02-29', 'a leap day falls where the calendar puts it');
}

console.log('2. Identical advice with the list off and on');
let walked = 0;
{
  let same = 0, corpusWrong = 0;
  const seen = new Set();
  for (const c of cases) {
    const on = run(copies.shipped, c), off = run(copies.reference, c);
    if (on.json === off.json && !on.json.startsWith('error')) same++;
    else ok(false, `${c.id}: advice identical`);
    for (const [start, days] of on.asked) {
      walked++;
      const key = start + '|' + days;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!matches(copies.reference.__walkDateList(start, days), start, days)) corpusWrong++;
    }
  }
  ok(cases.filter(c => c.kind === 'invented').length === 60 && same === cases.length,
    `advice identical on all ${cases.length} cases (60 invented evaluations, 2 held worlds, the 753-transaction world)`, `${same} of ${cases.length}`);
  ok(walked > 1000 && corpusWrong === 0, `every one of ${seen.size} distinct (start, length) the corpus walks matches the reference`,
    `${walked} walks, ${corpusWrong} wrong`);
}

console.log('3. Mutants are caught');
for (const [name, label] of [['offByOne', 'an off-by-one list'], ['anyStart', 'a list kept across a different start'],
  ['anyLength', 'a list too short for the requested length (kept for any length)'],
  ['readsPast', 'a longer kept list whose own length drives the walk']]) {
  let differs = 0;
  for (const c of cases) if (run(copies[name], c).json !== run(copies.reference, c).json) differs++;
  const s = sweep(copies[name].__walkDateList);
  ok(differs > 0 || s.wrong > 0, `${label} is caught`, `advice differs on ${differs} of ${cases.length} cases; ${s.wrong} of ${s.compared} swept lists wrong`);
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} walk date list checks passed`);
process.exit(failures ? 1 : 0);
