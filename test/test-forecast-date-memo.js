'use strict';
/* Forecast's date-arithmetic memos (LEAD 10) change no answer.
 *
 * addDays and diffDays (through toUTC) are memoised in public/forecast.js.
 * This test holds them to an independent reference written here, not to
 * Forecast's own code:
 *   1. every date 2019-01-01 .. 2033-12-31 at offsets from -400 to +400 days,
 *      each asked twice (the second answer comes from the memo), and far more
 *      distinct inputs than the memo bound, so eviction is exercised;
 *   2. malformed input behaves exactly as the unmemoised code did: the same
 *      thrown error (type and message) or the same value, on first and repeat
 *      calls, and an error is never remembered;
 *   3. an offset that is not a plain number is never memoised, so an object
 *      whose text and number disagree cannot poison a later answer;
 *   4. answers are primitives (a string, a number), so no caller can mutate a
 *      remembered result;
 *   5. forecast.js still loads as a browser script (window.Forecast, no
 *      module), with the memo working there.
 *
 * `node test/test-forecast-date-memo.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast.js');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${label}${detail !== '' ? ' — ' + detail : ''}`); }
};

// Independent reference: calendar arithmetic with setUTCDate on a fresh Date.
const pad = (n, w = 2) => String(n).padStart(w, '0');
function refAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + n);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
// The unmemoised code as it stood on main, for malformed-input behaviour.
const oldToUTC = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const oldAddDays = (iso, n) => new Date(oldToUTC(iso) + n * 86400000).toISOString().slice(0, 10);
const oldDiffDays = (a, b) => Math.round((oldToUTC(b) - oldToUTC(a)) / 86400000);
const outcome = fn => {
  try { const value = fn(); return { value }; } catch (error) { return { error: error.constructor.name + ': ' + error.message }; }
};
const same = (a, b) => ('error' in a) ? a.error === b.error : (!('error' in b) && Object.is(a.value, b.value));

console.log('1. Every date, every offset, against an independent reference');
{
  const offsets = [-400, -366, -365, -91, -35, -31, -14, -7, -1, 0, 1, 2, 7, 13, 14, 28, 31, 35, 91, 182, 365, 366, 400];
  let date = '2019-01-01', compared = 0, wrong = 0, firstWrong = '';
  const days = [];
  while (date <= '2033-12-31') { days.push(date); date = refAddDays(date, 1); }
  for (let pass = 0; pass < 2; pass++) {
    for (const day of days) {
      for (const n of offsets) {
        const got = F.addDays(day, n), want = refAddDays(day, n);
        compared++;
        if (got !== want) { wrong++; if (!firstWrong) firstWrong = `${day} ${n}: ${got} vs ${want}`; }
      }
    }
  }
  ok(wrong === 0, `addDays matches the reference on ${compared} calls (${days.length} days x ${offsets.length} offsets, twice)`, firstWrong);
  ok(days.length * offsets.length > 8192, 'more distinct inputs than the memo bound, so it clears and refills', String(days.length * offsets.length));
  let diffWrong = 0;
  for (let i = 0; i < days.length; i += 7) {
    for (const n of [-400, -1, 0, 1, 30, 400]) {
      const other = refAddDays(days[i], n);
      if (F.diffDays(days[i], other) !== n || F.diffDays(days[i], other) !== n) diffWrong++;
    }
  }
  ok(diffWrong === 0, 'diffDays (through the toUTC memo) returns the offset back, twice', String(diffWrong));
}

console.log('2. Malformed input behaves exactly as before, first call and repeat');
{
  const isos = [null, undefined, 5, '', 'garbage', '2026-13-40', '2026-02-30', '2026-1-5', ' 2026-01-05', '2026-01-05T00:00:00Z',
    new String('2026-01-05'), ['2026', '01', '05'], { split: () => [2026, 1, 5] }];
  const ns = [1, 0, -0, -3, 1.5, NaN, Infinity, null, undefined, '2', '1e1', true];
  for (const iso of isos) {
    for (const n of ns) {
      const before = outcome(() => oldAddDays(iso, n));
      const first = outcome(() => F.addDays(iso, n)), again = outcome(() => F.addDays(iso, n));
      ok(same(before, first) && same(before, again), `addDays(${String(iso)}, ${String(n)}) as before`,
        JSON.stringify({ before, first, again }));
    }
    const before = outcome(() => oldDiffDays(iso, '2026-01-10'));
    const first = outcome(() => F.diffDays(iso, '2026-01-10')), again = outcome(() => F.diffDays(iso, '2026-01-10'));
    ok(same(before, first) && same(before, again), `diffDays(${String(iso)}, ...) as before`, JSON.stringify({ before, first, again }));
  }
  // A call that throws leaves nothing behind: a good call on the same date still answers.
  ok(F.addDays('2026-03-01', 1) === '2026-03-02', 'after the failing calls, a good call answers normally');
}

console.log('3. An offset that is not a plain number is never memoised');
{
  // Text and number disagree: as a key it would read "1", as arithmetic 2.
  const tricky = { [Symbol.toPrimitive]: hint => (hint === 'number' ? 2 : '1') };
  const a = F.addDays('2026-05-10', tricky);
  const b = F.addDays('2026-05-10', 1);
  ok(a === '2026-05-12' && b === '2026-05-11', 'an object offset uses its number (2 days) and does not poison offset 1', JSON.stringify({ a, b }));
  const c = F.addDays('2026-05-10', '3'), d = F.addDays('2026-05-10', 3);
  ok(c === '2026-05-13' && d === '2026-05-13', 'a string offset answers as before', JSON.stringify({ c, d }));
  // A date that is not a plain string is never memoised either: an object
  // whose split changes between calls answers afresh each time, as before.
  let day = 4;
  const moving = { split: () => ['2026', '01', String(++day)] };
  const first = F.diffDays(moving, '2026-01-10'), second = F.diffDays(moving, '2026-01-10');
  ok(first === 5 && second === 4, 'a non-string date is evaluated on every call (5, then 4)', JSON.stringify({ first, second }));
}

console.log('4. Answers are primitives');
ok(typeof F.addDays('2026-07-01', 5) === 'string' && typeof F.diffDays('2026-07-01', '2026-07-06') === 'number',
  'addDays returns a string and diffDays a number; nothing mutable is remembered');

console.log('5. forecast.js still loads as a browser script');
{
  const source = fs.readFileSync(path.join(__dirname, '../public/forecast.js'), 'utf8');
  const window = {};
  const context = vm.createContext({ window, console, Intl, Date, Math, JSON, Map, Set, WeakMap, Number, String, Object, Array,
    Symbol, Error, TypeError, RangeError, RegExp, Boolean, Promise, structuredClone, isFinite, isNaN, parseFloat, parseInt });
  let error = null;
  try { vm.runInContext(source, context, { filename: 'forecast.js' }); } catch (e) { error = e; }
  ok(!error, 'evaluates with window and no module', error && error.message);
  const BF = window.Forecast;
  ok(BF && typeof BF.addDays === 'function', 'window.Forecast is published');
  if (BF) {
    ok(BF.addDays('2026-12-31', 1) === '2027-01-01' && BF.addDays('2026-12-31', 1) === '2027-01-01'
      && BF.diffDays('2026-02-27', '2026-03-01') === 2, 'the browser copy answers, first call and memo');
  }
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} date-memo checks passed`);
process.exit(failures ? 1 : 0);
