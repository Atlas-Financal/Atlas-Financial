'use strict';
/* G1a (#731) — an owner-confirmed amount change on a recurring bill lands only
 * from its own occurrence. Convention: bill.amount is the NEW regular amount
 * and a dated amountSchedule term (from inclusive, until exclusive) keeps the
 * earlier occurrences at their old amount. Forecast.expandEvents owns the dated
 * occurrences; this file proves the inputs, with invented fixture numbers.
 *
 * - the changed amount applies only from its own occurrence;
 * - the old occurrence is unchanged;
 * - a missing amount (regular or term) reads Unknown, never zero;
 * - the live Hydro row carries its evidenced due day (estimated) and unchanged plan amount.
 *
 * `node test/test-bill-regular-change-boundary.js`
 */
const F = require('../public/forecast.js');
const live = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const J = x => JSON.stringify(x);
const cents = n => Math.round(Number(n) * 100);

const OLD = 50, NEW = 40; // invented
const bill = patch => Object.assign({
  id: 'rc', label: 'Synthetic Utility', frequency: 'monthly', day: 1, firstDue: '2027-01-01',
  amount: NEW, confidence: 'estimated', budgetCategory: null,
  amountSchedule: [{ from: '2027-01-01', until: '2027-02-01', amount: OLD }],
}, patch || {});
const plan = bills => ({ windowDays: 91, opening: { asOf: '2026-12-15' },
  commitments: [], obligations: [], income: [], bills,
  budget: { basis: 'ytd', categories: [{ id: 'other', label: 'Other', class: 'discretionary', from: ['Other'] }] } });
const events = (p, id) => F.expandEvents(p, '2026-12-15', '2027-04-30').filter(e => e.kind === 'bill' && e.id === (id || 'rc'));
const dollars = evs => evs.map(e => [e.date, -e.amount]);

console.log('=== 1. the change lands only from its own occurrence ===');
{
  const evs = events(plan([bill()]));
  ok(J(dollars(evs)) === J([['2027-01-01', OLD], ['2027-02-01', NEW], ['2027-03-01', NEW], ['2027-04-01', NEW]]),
    'old amount on its own occurrence, new amount from the next one on', J(dollars(evs)));
  ok(cents(-evs[0].amount) === cents(OLD) && cents(-evs[1].amount) === cents(NEW),
    'adjacent occurrences across the boundary differ by exactly the change (integer cents)');
}

console.log('\n=== 2. the old occurrence is unchanged by adding the change ===');
{
  const before = events(plan([bill({ amount: OLD, amountSchedule: undefined })]));
  const after = events(plan([bill()]));
  ok(J(dollars(before)[0]) === J(dollars(after)[0]) && J(before[0].date) === J(after[0].date),
    'the occurrence before the change is identical with and without it');
  ok(J(before.map(e => e.date)) === J(after.map(e => e.date)),
    'the change moves no date');
}

console.log('\n=== 3. missing facts read Unknown, never zero ===');
{
  const noRegular = events(plan([bill({ amount: null })]));
  const state = F.scheduledAmountState(plan([bill({ amount: null })]), '2026-12-15', '2027-04-30');
  ok(state.status === 'unavailable'
      && !noRegular.some(e => e.date >= '2027-02-01' && Number(e.amount) === 0),
    'a missing regular amount is Unavailable and never a zero cash hit',
    J(state.status) + ' ' + J(dollars(noRegular)));
  const noTerm = plan([bill({ amountSchedule: [{ from: '2027-01-01', until: '2027-02-01', amount: null }] })]);
  const stateT = F.scheduledAmountState(noTerm, '2026-12-15', '2027-04-30');
  ok(stateT.status === 'unavailable', 'a missing term amount is Unavailable, not the regular amount', stateT.status);
  const stateOk = F.scheduledAmountState(plan([bill()]), '2026-12-15', '2027-04-30');
  ok(stateOk.status === 'ready', 'control: the complete fixture is ready', stateOk.status);
}

console.log('\n=== 4. live Hydro row: evidenced due day, plan amount unchanged ===');
{
  const row = (live.plan.bills || []).find(b => b.id === 'hydro-equal-payment');
  ok(row && row.day === 30 && row.firstDue === '2026-10-30' && row.confidence === 'estimated',
    'due day is the 30th from the October 2026 occurrence, still tagged estimated (one bill evidences it)');
  ok(row && cents(row.amount) === 19900 && !('amountSchedule' in row),
    'plan amount stays $199.00 and no term is added: the first-occurrence credit net already yields the bill total');
  const evs = F.expandEvents(live.plan, '2026-09-01', '2027-03-31')
    .filter(e => e.id === 'hydro-equal-payment').sort((a, b) => a.date.localeCompare(b.date));
  const byDate = Object.fromEntries(evs.map(e => [e.date, cents(-e.amount)]));
  ok(byDate['2026-10-30'] === 14592 && byDate['2026-11-30'] === 19900 && byDate['2026-12-30'] === 19900
      && byDate['2027-01-30'] === 19900 && byDate['2027-02-28'] === 19900,
    'October occurrence is $145.92 (199.00 less the 53.08 credit), later months $199.00, February clamps to the 28th', J(byDate));
  ok(!evs.some(e => e.date < '2026-10-30'), 'no occurrence stays on the superseded 1st of the month');
  ok(!('paid' in row) && !('settledOn' in row) && !('statementOccurrences' in row),
    'the payment is not hand-marked in data.json; matching is left to the observer');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'ALL CHECKS PASSED'));
process.exit(failures === 0 ? 0 : 1);
