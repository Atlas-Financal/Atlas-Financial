'use strict';
// Card coverage stops qualifying 121 days after its confirmed opening, on a
// healthy ledger. This pins that boundary so it cannot move unseen, and so the
// rolling-opening work has a red-to-green target (steady-state audit, #1611
// 7233167483; build plan step 1, #1611 7234072548).
//
// Failure this detects: the day card coverage runs out of history changes, or
// the refusal stops being the history stamp alone.
// Decision it can change: whether a change to the reader's history window, the
// coverage opening or the coverage gate may merge without the boundary being
// re-stated here.
//
// Why the boundary exists (read, not asserted): the live reader asks for at
// most RECONCILE_HISTORY_DAYS of posted history (scripts/provider-observe.js,
// postedHistoryDaysForCarriedSettlement), and Forecast needs history from the
// confirmed opening through the as-of (public/forecast.js,
// coverage-history-incomplete). When the opening is older than the window, the
// first day of history is no longer read.
//
// Invented numbers only. World (test/fixtures/card-coverage-aggregate-world.js):
// Bills 500, one card with debt 400, one 80 card purchase on the opening day,
// never repaid. The opening is 2026-09-18. Expected dates are worked by hand:
//   opening + 120 days = 2027-01-16  (September has 12 days left after the
//   18th, then 31 + 30 + 31 = 92, then 16 January days: 12 + 92 + 16 = 120)
//   opening + 121 days = 2027-01-17
// and the window start the reader should ask for is the as-of minus the days it
// returns, also worked by hand below. The 80 purchase is unpaid on every day,
// so the reserve is 80 whenever coverage is ready.
//
// WHEN THE ROLLING OPENING LANDS: case 3 (day 121 withheld) is the behaviour it
// removes. That change updates case 3 in the same pull request and says so in
// its merge card. Cases 1, 2 and 4 should keep holding.
const assert = require('node:assert/strict');
const O = require('../scripts/provider-observe');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const OPENING = '2026-09-18';
const PURCHASE = [['card', 80, OPENING, 'purchase']];
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

// Calendar arithmetic independent of Forecast: whole UTC days on a plain Date.
function plusDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// One observation on a given as-of. The window is the one the real reader
// derives from the plan, unless `windowStart` overrides it (the control).
// A bounded read returns only rows inside its window, so older rows are dropped.
function observe(asOf, windowStart) {
  const probe = world(PURCHASE, { asOf });
  const now = probe.payload.fetchedAt;
  const days = O.postedHistoryDaysForCarriedSettlement({ now, plan: probe.data.plan, debts: probe.data.debts });
  const derivedStart = O.lunchMoneyTransactionsUrl(now, days).startDate;
  const start = windowStart || derivedStart;
  const x = world(PURCHASE, { asOf, windowStart: start,
    edit: w => { w.payload.transactions = w.payload.transactions.filter(t => t.date >= start); } });
  return { days, derivedStart, start, rows: x.payload.transactions.length, ...run(x) };
}
const issues = s => (s.coverage.issues || []).map(i => (i && i.code) || i);

// 0. The hand-worked dates, and the constant this test is about.
check(plusDays(OPENING, 120) === '2027-01-16', 'opening + 120 days is 2027-01-16');
check(plusDays(OPENING, 121) === '2027-01-17', 'opening + 121 days is 2027-01-17');
check(O.RECONCILE_HISTORY_DAYS === 120, 'the reader history cap is 120 days (got ' + O.RECONCILE_HISTORY_DAYS + ')');

// 1. Inside the horizon the reader reaches back to the opening and coverage is
//    ready with the unpaid 80 reserved. Day 0, a mid-point and day 119.
for (const n of [0, 60, 119]) {
  const asOf = plusDays(OPENING, n);
  const s = observe(asOf);
  check(s.derivedStart <= OPENING, 'day ' + n + ': the window starts on or before the opening (got ' + s.derivedStart + ')');
  check(s.rows === 1, 'day ' + n + ': the opening-day purchase is read');
  check(s.coverage.status === 'ready' && issues(s).length === 0, 'day ' + n + ': coverage ready ' + JSON.stringify(issues(s)));
  check(s.coverage.reservedCash === 80, 'day ' + n + ': the unpaid 80 is reserved (got ' + s.coverage.reservedCash + ')');
}

// 2. Day 120 is the last ready day: the reader asks for exactly the cap, the
//    window starts on the opening itself, and the reserve is still 80.
{
  const asOf = '2027-01-16';
  const s = observe(asOf);
  check(s.days === 120, 'day 120: the reader asks for 120 days (got ' + s.days + ')');
  check(s.derivedStart === OPENING, 'day 120: the window starts on the opening day (got ' + s.derivedStart + ')');
  check(s.derivedStart === plusDays(asOf, -120), 'day 120: window start is the as-of minus 120 days');
  check(s.rows === 1, 'day 120: the opening-day purchase is still read');
  check(s.coverage.status === 'ready' && issues(s).length === 0, 'day 120: coverage ready ' + JSON.stringify(issues(s)));
  check(s.coverage.reservedCash === 80, 'day 120: the unpaid 80 is reserved');
  check(s.packet.coverageStart === OPENING, 'day 120: published coverage starts on the opening');
  check(!s.advice.cardCoverageUnavailable, 'day 120: the plan does not report card coverage unavailable');
}

// 3. Day 121 is the first withheld day. The reader still asks for 120 days, so
//    the window starts one day after the opening, the opening-day purchase is
//    no longer read, and coverage is withheld for the history stamp alone.
{
  const asOf = '2027-01-17';
  const s = observe(asOf);
  check(s.days === 120, 'day 121: the reader still asks for 120 days, not 121 (got ' + s.days + ')');
  check(s.derivedStart === '2026-09-19', 'day 121: the window starts the day after the opening (got ' + s.derivedStart + ')');
  check(s.derivedStart === plusDays(asOf, -120), 'day 121: window start is the as-of minus 120 days');
  check(s.rows === 0, 'day 121: the opening-day purchase is outside the read');
  check(s.coverage.status === 'unavailable', 'day 121: coverage unavailable (got ' + s.coverage.status + ')');
  check(JSON.stringify(issues(s)) === JSON.stringify(['coverage-history-incomplete']),
    'day 121: the only issue is the history stamp ' + JSON.stringify(issues(s)));
  check(s.coverage.reservedCash === null, 'day 121: no reserve is published, not zero (got ' + s.coverage.reservedCash + ')');
  check(s.packet.coverageStart === '2026-09-19', 'day 121: published coverage starts after the opening');
  check(!!s.advice.cardCoverageUnavailable, 'day 121: the plan reports card coverage unavailable');
}

// 4. Control: on day 121 with the full history supplied, the same household is
//    ready with the same 80 reserved. So the refusal in case 3 comes from the
//    120-day cap and from nothing in the ledger: the purchase is still unpaid
//    and nothing else moved. This is the case a correct roll-forward must match.
{
  const asOf = '2027-01-17';
  const s = observe(asOf, OPENING);
  check(s.rows === 1, 'control: with history from the opening the purchase is read');
  check(s.coverage.status === 'ready' && issues(s).length === 0, 'control: coverage ready ' + JSON.stringify(issues(s)));
  check(s.coverage.reservedCash === 80, 'control: the unpaid 80 is reserved (got ' + s.coverage.reservedCash + ')');
  check(!s.advice.cardCoverageUnavailable, 'control: the plan does not report card coverage unavailable');
}

// 5. The boundary is exact: scanning days 100 to 140, every day up to 120 is
//    ready with 80 reserved and every later day is withheld. No second cliff.
{
  let lastReady = null;
  let firstWithheld = null;
  let bad = null;
  for (let n = 100; n <= 140; n++) {
    const s = observe(plusDays(OPENING, n));
    const ready = s.coverage.status === 'ready' && s.coverage.reservedCash === 80;
    const withheld = s.coverage.status === 'unavailable' && s.coverage.reservedCash === null;
    if (!ready && !withheld) bad = n;
    if (ready) { if (firstWithheld !== null) bad = n; lastReady = n; }
    if (withheld && firstWithheld === null) firstWithheld = n;
  }
  check(bad === null, 'scan: every day is cleanly ready or withheld, ready days first (bad day ' + bad + ')');
  check(lastReady === 120, 'scan: the last ready day is day 120 (got ' + lastReady + ')');
  check(firstWithheld === 121, 'scan: the first withheld day is day 121 (got ' + firstWithheld + ')');
}

console.log(`  PASS  card coverage is ready through day 120 after its opening and withheld from day 121, for the history window alone (${checks} checks)`);
