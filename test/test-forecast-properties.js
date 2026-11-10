'use strict';
/* Property tests (fast-check) on the real Forecast engine, public/forecast.js,
 * over generated INVENTED plans. No household data is read.
 *
 *  (a) every dated cash event (bills, commitments, income) in a window is
 *      emitted exactly once and lands in exactly one pay period: no
 *      duplicates, no drops, no stray events.
 *  (b) a dated commitment with a valid settledOn on or before the window
 *      opening emits nothing, in this window or any later one; a settledOn
 *      after the opening, or a garbage/impossible one, still emits (fail
 *      closed).
 *
 * Expected values are derived here by hand from the generated inputs
 * (calendar arithmetic via Date.UTC, amounts in integer cents), never by
 * calling the engine's own date or amount helpers.
 *
 * Deterministic by default: fixed seed, 200 runs. Wider local runs:
 *   FC_RUNS=5000 FC_SEED=123 node test/test-forecast-properties.js
 * On failure fast-check prints the seed and the shrunk counterexample. */
const fc = require('fast-check');
const F = require('../public/forecast.js');

const RUNS = Number(process.env.FC_RUNS) > 0 ? Number(process.env.FC_RUNS) : 200;
const SEED = process.env.FC_SEED != null && process.env.FC_SEED !== ''
  ? Number(process.env.FC_SEED) : 20261109;
let failures = 0;
function property(label, arb, predicate) {
  try {
    fc.assert(fc.property(arb, predicate), { seed: SEED, numRuns: RUNS });
    console.log(`  PASS  ${label}  (seed ${SEED}, runs ${RUNS})`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${label}  (seed ${SEED}, runs ${RUNS})`);
    console.log(String(error.message).split('\n').map(l => '        ' + l).join('\n'));
  }
}

// ---- independent calendar helpers (UTC days, no engine code) -------------
const DAY = 86400000;
const BASE = Date.UTC(2027, 10, 1);            // window openings roam around here
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const plusDays = (d, n) => iso(Date.parse(d + 'T00:00:00Z') + n * DAY);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Windows: roam 2027-2029 so leap day 2028-02-29 and month ends are reachable.
const startArb = fc.integer({ min: -400, max: 700 }).map(n => plusDays(iso(BASE), n));
const lenArb = fc.integer({ min: 0, max: 70 });
// Item dates are offsets from the window, biased to the boundaries.
const offsetArb = len => fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(-1, 0, 1, len - 1, len, len + 1) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: len }) },
  { weight: 1, arbitrary: fc.integer({ min: -20, max: len + 20 }) });
const centsArb = fc.integer({ min: 1, max: 999999 });
// Amounts: valid cents values, plus values that must fail closed.
const NONPOSITIVE = [0, -0, -5, -0.01];
const badAmountArb = fc.constantFrom(...NONPOSITIVE, NaN, Infinity, null, undefined, '', 'abc', true, [5], {});

function numericAmount(raw) {                  // hand-written: what counts as a point amount
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') { const n = Number(raw); return Number.isFinite(n) ? n : null; }
  return null;
}
// Scoped: on current main a commitment with a zero or negative point amount
// still emits an event (0, or a POSITIVE amount for a negative one), unlike a
// bill, which drops it. That is reported in the PR, not fixed here, so the
// commitment generator below leaves nonpositive amounts out.
const badCommitmentAmountArb = badAmountArb.filter(v => !NONPOSITIVE.some(n => Object.is(n, v)));
const keyOf = e => `${e.kind}|${e.id}|${e.date}`;
const cents = x => Math.round(x * 100);

// ---- (a) every dated cash event once, in exactly one pay period -----------
const planCase = fc.tuple(startArb, lenArb).chain(([start, len]) => {
  const off = offsetArb(len);
  const bill = fc.record({ off, amt: fc.oneof({ weight: 4, arbitrary: centsArb.map(c => c / 100) },
    { weight: 1, arbitrary: badAmountArb }) });
  const commitment = fc.record({
    off, amt: fc.oneof({ weight: 4, arbitrary: centsArb.map(c => c / 100) }, { weight: 1, arbitrary: badCommitmentAmountArb }),
    shape: fc.constantFrom('date', 'monthOnly', 'byMonthOnly', 'garbageWhen', 'garbageDate'),
  });
  const income = fc.record({ anchorOff: fc.integer({ min: -40, max: len + 40 }), c: centsArb });
  return fc.record({
    start: fc.constant(start), len: fc.constant(len),
    bills: fc.array(bill, { maxLength: 6 }),
    commitments: fc.array(commitment, { maxLength: 6 }),
    income: fc.array(income, { maxLength: 3 }),
    monthlyDay: fc.option(fc.integer({ min: 1, max: 31 }), { nil: null }),
  });
});

property('(a) every cash event emitted exactly once and in exactly one pay period', planCase, c => {
  const start = c.start, end = plusDays(start, c.len);
  const plan = { income: [], bills: [], commitments: [], obligations: [] };
  const expected = [];                           // [key, cents]
  c.bills.forEach((b, i) => {
    const date = plusDays(start, b.off), id = `bill-${i}`;
    plan.bills.push({ id, label: id, frequency: 'once', date, amount: b.amt, confidence: 'estimated' });
    const n = numericAmount(b.amt);
    // A once bill dated before the opening and still on the plan is unpaid:
    // the engine carries it once at its own date (documented in forecast.js
    // onceOutflowDates), so it is expected too, outside every pay period.
    if (n != null && n > 0 && date <= end) expected.push([`bill|${id}|${date}`, -cents(n)]);
  });
  if (c.monthlyDay != null) {
    plan.bills.push({ id: 'bill-monthly', label: 'm', frequency: 'monthly', day: c.monthlyDay, amount: 12.34, confidence: 'estimated' });
    // hand-derived: one per calendar month, day clamped to month end, inside window
    let [y, m] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
    for (let k = 0; k < 4; k++) {
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const d = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(c.monthlyDay, dim)).padStart(2, '0')}`;
      if (d >= start && d <= end) expected.push([`bill|bill-monthly|${d}`, -1234]);
      if (++m > 12) { m = 1; y++; }
    }
  }
  c.commitments.forEach((m, i) => {
    const id = `commit-${i}`, date = plusDays(start, m.off);
    const row = { id, label: id, amount: m.amt, confidence: 'estimated' };
    let cashDate = null;
    if (m.shape === 'date') { row.date = date; cashDate = date; }
    else if (m.shape === 'monthOnly' || m.shape === 'byMonthOnly') {
      const mon = MONTHS[Number(date.slice(5, 7)) - 1];
      row.when = (m.shape === 'byMonthOnly' ? 'by ' : '') + `${mon} ${date.slice(0, 4)}`;
      cashDate = `${date.slice(0, 7)}-15`;       // owner rule: month-only is the 15th
    } else if (m.shape === 'garbageWhen') row.when = 'sometime spring';
    else row.date = '2027-13-01';                 // not a date shape: not a cash date (see PR: 2027-02-31 is a separate finding)
    plan.commitments.push(row);
    const n = numericAmount(m.amt);
    if (cashDate && n != null && n > 0 && cashDate >= start && cashDate <= end) expected.push([`commitment|${id}|${cashDate}`, -cents(n)]);
  });
  c.income.forEach((s, i) => {
    const id = `pay-${i}`, anchor = plusDays(start, s.anchorOff);
    plan.income.push({ id, label: id, frequency: 'biweekly', anchor, amount: s.c / 100, confidence: 'verified' });
    for (let d = plusDays(anchor, -14 * 10); d <= end; d = plusDays(d, 14))
      if (d >= start && (Date.parse(d) - Date.parse(anchor)) % (14 * DAY) === 0) expected.push([`income|${id}|${d}`, s.c]);
  });

  const events = F.expandEvents(plan, start, end, {});
  // exactly once: engine multiset equals the hand-derived multiset
  const got = events.map(e => [keyOf(e), cents(e.amount)]).sort((x, y) => (x[0] + x[1]).localeCompare(y[0] + y[1]));
  const want = expected.slice().sort((x, y) => (x[0] + x[1]).localeCompare(y[0] + y[1]));
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`event multiset differs\n got:  ${JSON.stringify(got)}\n want: ${JSON.stringify(want)}\n window ${start}..${end}`);
  }
  // exactly one pay period: consecutive 14-day periods tile the window
  const periods = [];
  for (let s = start; s <= end; s = plusDays(s, 14)) periods.push([s, plusDays(s, 13) < end ? plusDays(s, 13) : end]);
  let placed = 0;
  for (const e of events.filter(e => e.date >= start)) {
    const hits = periods.filter(([a, b]) => e.date >= a && e.date <= b).length;
    if (hits !== 1) throw new Error(`event ${keyOf(e)} lands in ${hits} periods`);
    placed++;
  }
  // and period-by-period walks agree with the whole-window walk (no drop/dup at seams)
  // (carried pre-opening once bills are excluded: they are not period events)
  const perPeriod = periods.flatMap(([a, b]) => F.expandEvents(plan, a, b, {}).filter(e => e.date >= a));
  const seamOnce = events.filter(e => e.date >= start).map(keyOf).sort();
  const seamGot = perPeriod.map(keyOf).sort();
  if (JSON.stringify(seamGot) !== JSON.stringify(seamOnce)) {
    throw new Error(`per-period walks differ from whole-window walk\n whole: ${seamOnce}\n split: ${seamGot}`);
  }
  return placed === events.filter(e => e.date >= start).length;
});

// ---- (b) settledOn: settled by the opening reserves nothing; else fail closed
const settledCase = fc.tuple(startArb, lenArb).chain(([start, len]) => fc.record({
  start: fc.constant(start), len: fc.constant(len),
  dateOff: offsetArb(len),
  amt: centsArb,
  shape: fc.constantFrom('date', 'monthOnly'),
  settle: fc.oneof(
    { weight: 5, arbitrary: fc.record({ kind: fc.constant('valid'), off: fc.integer({ min: -400, max: len + 400 }) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('garbage'),
      value: fc.constantFrom('', 'abc', '2026-13-01', '2027-02-31', '2027-2-3', '20270203', 'yesterday',
        null, undefined, 0, 20270203, true, {}, [], '2027-02-03T00:00:00Z', ' 2027-02-03', '2027-02-29', '2100-02-29') }) }),
  // a sibling on the same date must keep firing
  sibling: fc.boolean(),
}));

property('(b) settledOn on/before opening emits nothing; later or invalid still emits', settledCase, c => {
  const start = c.start, end = plusDays(start, c.len);
  const date = plusDays(start, c.dateOff);
  const row = { id: 'target', label: 't', amount: c.amt / 100, confidence: 'estimated' };
  let cashDate;
  if (c.shape === 'date') { row.date = date; cashDate = date; }
  else { row.when = `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`; cashDate = `${date.slice(0, 7)}-15`; }
  // hand-written truth of "valid settledOn": YYYY-MM-DD that is a real calendar day
  let settledOn, validSettled = false;
  if (c.settle.kind === 'valid') { settledOn = plusDays(start, c.settle.off); validSettled = true; }
  else {
    settledOn = c.settle.value;
    if (typeof settledOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(settledOn)) {
      const d = new Date(settledOn + 'T00:00:00Z');
      validSettled = !isNaN(d) && iso(d.getTime()) === settledOn;
    }
  }
  if (settledOn !== undefined) row.settledOn = settledOn;
  const plan = { income: [], bills: [], obligations: [], commitments: [row] };
  if (c.sibling) plan.commitments.push({ id: 'sibling', label: 's', date: cashDate, amount: 1, confidence: 'estimated' });

  const settledByOpening = validSettled && settledOn <= start;
  const inWindow = cashDate >= start && cashDate <= end;
  const events = F.expandEvents(plan, start, end, {});
  const target = events.filter(e => e.id === 'target');
  const want = !settledByOpening && inWindow ? 1 : 0;
  if (target.length !== want) {
    throw new Error(`target emitted ${target.length}, want ${want} (settledOn=${JSON.stringify(settledOn)}, start=${start}, cashDate=${cashDate})`);
  }
  if (c.sibling && events.filter(e => e.id === 'sibling').length !== (inWindow ? 1 : 0)) {
    throw new Error('settled row suppressed its same-date sibling, or sibling was dropped');
  }
  if (settledByOpening) {
    // reserves nothing in any later period either: later openings are still settled
    for (const later of [plusDays(start, 1), plusDays(start, 30), plusDays(end, 1)]) {
      const rest = F.expandEvents(plan, later, plusDays(later, 400), {});
      if (rest.some(e => e.id === 'target')) throw new Error(`settled row reserved cash in a later period from ${later}`);
    }
  }
  return true;
});

console.log(failures ? `\n${failures} property failure(s)` : '\nAll property checks passed');
process.exit(failures ? 1 : 0);
