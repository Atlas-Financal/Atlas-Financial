'use strict';
/* Default two-day late posting window for bill identity rules
 * (adopted bills blueprint #787 6595179923: "explicit identity windows;
 * #827 stays at two days"; acceptance scenario 6.7).
 *
 * A bill or obligation identity rule that names no postingDateRule matches a
 * payment posted on the due date or up to two days after it. It never
 * matches an earlier payment (early payment stays an explicit qualifier),
 * never three days late, and never changes an income rule or a rule with an
 * explicit postingDateRule. One payment never settles two occurrences.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js
 * fromObservation (provider-observe observe) -> liveOverlay
 * currentPeriodActuals.representedActuals, the list Forecast reads to mark
 * an occurrence PAID. Every expected value below is written by hand from the
 * rule above; nothing here calls the matcher to compute an expectation.
 * Invented numbers only.
 *
 * `node test/test-bill-late-posting-window.js`
 */
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12,
  confidence: 'confirmed', payee: 'Invented hydro' };

function world(bills, txs) {
  const w = H.baseWorld();
  w.bills = bills;
  w.transactions = txs;
  return w;
}
const pay = (date, amount = 90, payee = 'Invented hydro') =>
  H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee });
function represented(w) {
  const r = H.observe(w);
  if (r.error) throw r.error;
  return (r.packet && r.packet.representedActuals) || [];
}
const keyOf = list => list.map(x => `${x.id}@${x.date}<-${x.postedOn || x.date}`).sort();

console.log('Default bill window: due date to two days after');
for (const [posted, expected, label] of [
  ['2026-10-12', ['hydro@2026-10-12<-2026-10-12'], 'paid on the due date settles it (control)'],
  ['2026-10-13', ['hydro@2026-10-12<-2026-10-13'], 'one day late settles the Oct 12 occurrence'],
  ['2026-10-14', ['hydro@2026-10-12<-2026-10-14'], 'two days late settles the Oct 12 occurrence'],
]) {
  const got = keyOf(represented(world([{ ...HYDRO }], [pay(posted)])));
  ok(JSON.stringify(got) === JSON.stringify(expected), label, JSON.stringify(got));
}

console.log('Outside the window');
{
  // Three days late: as-of moved to Oct 15 so the posting is inside coverage.
  const w = world([{ ...HYDRO }], [pay('2026-10-15')]);
  w.asOf = '2026-10-15';
  const got = represented(w).filter(x => x.id === 'hydro');
  ok(got.length === 0, 'three days late does not settle the occurrence', JSON.stringify(got));
}
{
  const got = represented(world([{ ...HYDRO }], [pay('2026-10-11')])).filter(x => x.id === 'hydro');
  ok(got.length === 0, 'one day early does not settle without an explicit early rule', JSON.stringify(got));
}

console.log('Explicit rules and income are unchanged');
{
  // Oct 12, 2026 is a Monday: the weekend rule allows the due date only.
  const bill = { ...HYDRO, rule: { postingDateRule: 'same-day-or-weekend-next-business-day' } };
  const got = represented(world([bill], [pay('2026-10-13')])).filter(x => x.id === 'hydro');
  ok(got.length === 0, 'an explicit weekend rule keeps its own window (weekday +1 is not matched)', JSON.stringify(got));
}
{
  // Payroll is due Oct 9; a receipt from the employer one day later must not
  // settle the income occurrence through the bill window.
  const w = world([], [H.lm({ date: '2026-10-10', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' })]);
  const got = represented(w).filter(x => x.id === 'payroll');
  ok(got.length === 0, 'an income rule does not take the bill late window', JSON.stringify(got));
}
{
  const w = world([], [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' })]);
  const got = keyOf(represented(w).filter(x => x.id === 'payroll'));
  ok(JSON.stringify(got) === JSON.stringify(['payroll@2026-10-09<-2026-10-09']),
    'positive control: the on-date payroll receipt still settles', JSON.stringify(got));
}

console.log('One payment settles at most one occurrence');
{
  // Two bills from the same payee due Oct 12 and Oct 13. A single payment on
  // Oct 14 is inside both windows: it is ambiguous and settles neither.
  const water = { id: 'water', label: 'Invented water', amount: 90, frequency: 'once', date: '2026-10-13',
    confidence: 'confirmed', payee: 'Invented hydro' };
  const got = represented(world([{ ...HYDRO }, water], [pay('2026-10-14')]))
    .filter(x => x.id === 'hydro' || x.id === 'water');
  ok(got.length === 0, 'a payment inside two bills\' windows settles neither', JSON.stringify(got));
}
{
  // The same two bills, each paid by its own payment on its own due date.
  const water = { id: 'water', label: 'Invented water', amount: 90, frequency: 'once', date: '2026-10-13',
    confidence: 'confirmed', payee: 'Invented city water' };
  const got = keyOf(represented(world([{ ...HYDRO }, water],
    [pay('2026-10-12'), pay('2026-10-13', 90, 'Invented city water')]))
    .filter(x => x.id === 'hydro' || x.id === 'water'));
  ok(JSON.stringify(got) === JSON.stringify(['hydro@2026-10-12<-2026-10-12', 'water@2026-10-13<-2026-10-13']),
    'positive control: distinct payees settle their own occurrences', JSON.stringify(got));
}
{
  // Two same-payee payments, Oct 12 and Oct 14, are both candidates for the
  // one Oct 12 occurrence. Genuine ambiguity has no nearest-match tie-break:
  // the occurrence is not settled (it stays to confirm), never settled twice.
  const got = represented(world([{ ...HYDRO }], [pay('2026-10-12'), pay('2026-10-14')]))
    .filter(x => x.id === 'hydro');
  ok(got.length === 0, 'two candidate payments for one occurrence: ambiguous, not settled twice', JSON.stringify(got));
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll bill late-window checks passed.');
