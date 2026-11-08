'use strict';
/* Focused proof for Forecast.nextDue(). The correctness cases are hand
 * computed against a fixture event stream, not against the function that now
 * produces the answer. Live-plan selection is reconciled against the Plan
 * commitments themselves, not against a second hand-kept calendar.
 *
 * B74: nextDue reads the same expandEvents stream as the Plan calendar and
 * nextPaymentOut. It names ONE obligation; the day's cash-out total is a
 * different question.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const data = require('../data.json');
const AUG16_REV = '28d08a12a18691f34c32bc839d22cd526fc75111';
const aug16Pinned = JSON.parse(execFileSync('git', ['show', `${AUG16_REV}:data.json`], {
  encoding: 'utf8', cwd: path.join(__dirname, '..'),
}));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const clone = x => JSON.parse(JSON.stringify(x));

/* A stream built so that the excluded event is dated before the winner.
 * If the exclusion failed to bite, that item would win instead.
 *
 *   date         label                    amount   why it does or does not win
 *   2026-02-11   HELOC interest charged   -800.00  non-cash         → excluded
 *   2026-02-13   Car insurance            -210.00  WINNER
 *   2026-02-13   Dentist                  -275.00  same day, listed second
 *   2026-02-20   Mortgage                -1600.00  a week later
 *
 * As of 2026-02-10, the earliest eligible date is 13 February. Two obligations
 * share that date; Car insurance is first in stream order, so it is next due
 * at $210.00. $485.00 is what 13 February costs in total — nextPaymentOut.
 */
const AS_OF = '2026-02-10';
const EVENTS = [
  { date: '2026-02-11', label: 'HELOC interest charged', amount: -800, kind: 'noncash' },
  { date: '2026-02-13', label: 'Car insurance', amount: -210, kind: 'bill' },
  { date: '2026-02-13', label: 'Dentist', amount: -275, kind: 'commitment' },
  { date: '2026-02-20', label: 'Mortgage', amount: -1600, kind: 'obligation' },
];

console.log('=== hand-computed winner ===');
const next = F.nextDue(EVENTS, AS_OF);
ok(!!next, 'an eligible obligation is found');
ok(next && next.what === 'Car insurance',
  'Car insurance wins — the earliest eligible date, first on that date',
  next ? next.what : 'none');
ok(next && next.due === '2026-02-13', 'it is dated 13 February', next ? next.due : 'none');
ok(next && next.amount === 210, 'its own amount is reported', next ? String(next.amount) : 'none');
ok(next && next.daysUntil === 3, '10 Feb to 13 Feb is three days', next ? String(next.daysUntil) : 'none');
ok(next && next.amount !== 485,
  'the winner is one obligation, not the day total');

console.log('\n=== each exclusion is what kept the item out ===');
// CARRIED (audit, PR A): a past-due outflow still in the stream is one the
// cash walk still owes and deducts at as-of (onceOutflowDates /
// carriedUnresolvedJointCashOutflows; settled ones are absent). It is due
// TODAY and marked overdue with its scheduled date — never skipped for a
// later payment. Hand: Hydro 140, due Feb 6, as-of Feb 10 → due Feb 10, 0 days.
const MISSED = { date: '2026-02-06', label: 'Hydro — missed', amount: -140, kind: 'bill' };
const withMissed = F.nextDue([MISSED, ...EVENTS], AS_OF);
ok(withMissed && withMissed.what === 'Hydro — missed' && withMissed.due === AS_OF
  && withMissed.daysUntil === 0 && withMissed.amount === 140
  && withMissed.overdue === true && withMissed.scheduledDate === '2026-02-06',
  'a missed past-due bill still in the stream is next due today, overdue from 6 February',
  JSON.stringify(withMissed));
ok(!next.overdue, 'an on-time winner is not marked overdue');

// Settled items are absent from the stream (firstDue / already paid). Putting
// the phone bill back in, dated before the winner, takes it.
const withSettled = [
  { date: '2026-02-12', label: 'Phone bill', amount: -65, kind: 'bill' },
  ...EVENTS,
];
const withPhone = F.nextDue(withSettled, AS_OF);
ok(withPhone && withPhone.what === 'Phone bill',
  'a settled bill is next due only when it is put back in the stream',
  withPhone ? withPhone.what : 'none');
ok(next && next.what !== 'Phone bill',
  'and the published stream does not include it');

const asCash = clone(EVENTS);
asCash[0].kind = 'obligation';
const withCash = F.nextDue(asCash, AS_OF);
ok(withCash && withCash.what === 'HELOC interest charged',
  'the HELOC charge lost only because it is non-cash',
  withCash ? withCash.what : 'none');

console.log('\n=== same-day ordering is stated, not incidental ===');
const swapped = clone(EVENTS);
[swapped[1], swapped[2]] = [swapped[2], swapped[1]];
const afterSwap = F.nextDue(swapped, AS_OF);
ok(afterSwap && afterSwap.what === 'Dentist' && afterSwap.amount === 275,
  'listing Dentist first makes Dentist the answer',
  afterSwap ? afterSwap.what : 'none');
ok(next && next.amount < 275,
  'the larger same-day obligation does not win on size alone');
const repeated = new Set(Array.from({ length: 50 }, () => JSON.stringify(F.nextDue(EVENTS, AS_OF))));
ok(repeated.size === 1, 'repeated calls give one answer', `${repeated.size} distinct`);

console.log('\n=== both look-aheads share this stream ===');
const dayTotal = F.nextPaymentOut(EVENTS, AS_OF);
ok(dayTotal && dayTotal.date === next.due,
  'nextPaymentOut names the same date nextDue won',
  dayTotal ? dayTotal.date : 'none');
ok(dayTotal && dayTotal.amount === 485,
  'and sums both 13 February cash outflows to $485.00',
  dayTotal ? String(dayTotal.amount) : 'none');
ok(next && dayTotal && next.amount !== dayTotal.amount,
  'the two aggregations are different numbers from the same events');

console.log('\n=== boundaries ===');
const today = F.nextDue(EVENTS, '2026-02-13');
ok(today && today.what === 'Car insurance' && today.daysUntil === 0,
  'an obligation due today is next due, at zero days',
  today ? `${today.what} in ${today.daysUntil}d` : 'none');

const nothingLeft = F.nextDue(EVENTS.slice(0, 1), AS_OF);
ok(nothingLeft === null, 'no eligible item returns null', String(nothingLeft));
ok(F.nextDue([], AS_OF) === null, 'an empty stream returns null');
ok(F.nextDue(undefined, AS_OF) === null, 'a missing stream returns null');

console.log('\n=== pinned 2026-08-16 plan, from the Plan bills, not a second calendar ===');
const pinnedAsOf = aug16Pinned.meta.asOf;
const pinnedEnd = F.addDays(pinnedAsOf, (aug16Pinned.plan.windowDays || 91) - 1);
const pinnedEvents = F.expandEvents(aug16Pinned.plan, pinnedAsOf, pinnedEnd);
const pinnedNext = F.nextDue(pinnedEvents, pinnedAsOf);
const outstanding = (aug16Pinned.plan.bills || []).filter(b => /aug15-outstanding/.test(b.id));
ok(pinnedAsOf === '2026-08-16', 'pinned 28d08a12 as-of is 16 August');
ok(outstanding.length === 4 && outstanding.every(b => b.date === pinnedAsOf),
  'four unposted 15 August bills are reserved on that opening');
ok(pinnedNext && pinnedNext.due === pinnedAsOf
  && outstanding.some(b => b.label === pinnedNext.what && b.amount === pinnedNext.amount),
  'nextDue names one of those reserved bills, from the Plan',
  pinnedNext ? `${pinnedNext.what} ${pinnedNext.due} $${pinnedNext.amount}` : 'none');
const pinnedOut = F.nextPaymentOut(pinnedEvents, pinnedAsOf);
const independentOut = outstanding.reduce((s, b) => s + b.amount, 0);
ok(pinnedOut && pinnedOut.date === pinnedAsOf && pinnedOut.count === 4
  && Math.abs(pinnedOut.amount - independentOut) < 0.005,
  'nextPaymentOut on the same stream is the $307.87 day total',
  pinnedOut ? `${pinnedOut.date} $${pinnedOut.amount}` : 'none');

console.log('\n=== live plan: nextDue is taken from the current opening stream ===');
const asOf = data.meta.asOf;
ok(data.plan.opening && data.plan.opening.asOf === asOf,
  'live meta.asOf agrees with plan.opening.asOf', asOf);
const liveEvents = F.expandEvents(data.plan, asOf, F.addDays(asOf, (data.plan.windowDays || 91) - 1));
const live = F.nextDue(liveEvents, asOf);
ok(!live || liveEvents.some(e => e.label === live.what && e.date === (live.overdue ? live.scheduledDate : live.due)),
  'live nextDue is an event from expandEvents at the current as-of',
  live ? `${live.what} ${live.due} $${live.amount}` : 'none eligible');

console.log('\n=== page is a renderer ===');
const page = fs.readFileSync('public/deepdive.js', 'utf8');
ok(/Forecast\.nextDue\(/.test(page), 'Deep Dive reads the winner from Forecast.nextDue');
ok(/Forecast\.expandEvents\(/.test(page), 'Deep Dive derives the dated list from expandEvents');
ok(!/d\.upcoming\b/.test(page), 'Deep Dive no longer reads data.upcoming as a schedule');
ok(!/status\s*!==\s*'paid'/.test(page), 'Deep Dive no longer applies the paid rule itself');
ok(!/kind\s*!==\s*'noncash'/.test(page), 'Deep Dive no longer applies the non-cash rule itself');
ok(!/a\.due\s*<\s*b\.due/.test(page), 'Deep Dive no longer orders the obligations itself');
ok(/Next named payment due/.test(page),
  'the tile says this is one named obligation, not the day total');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
