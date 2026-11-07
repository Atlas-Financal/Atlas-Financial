'use strict';
/* Opt-in bounded late posting window for bill identity rules
 * (adopted bills blueprint #787 6595179923: "explicit identity windows;
 * #827 stays at two days"; acceptance scenario 6.7, spec clarified by the
 * lead to declare the window explicitly).
 *
 * A rule naming postingDateRule 'due-or-up-to-two-days-after' matches a
 * payment posted on the due date or up to two days after it. It never
 * matches an earlier payment and never three days late. A rule with no
 * postingDateRule stays same-day, and the committed production identity
 * rules are untouched. One payment never settles two occurrences.
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
const fs = require('fs');
const path = require('path');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const WINDOW = { postingDateRule: 'due-or-up-to-two-days-after' };
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12,
  confidence: 'confirmed', payee: 'Invented hydro' };
const windowed = extra => ({ ...HYDRO, rule: { ...WINDOW }, ...(extra || {}) });

function world(bills, txs, asOf) {
  const w = H.baseWorld(asOf);
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
const hydro = list => list.filter(x => x.id === 'hydro');

console.log('Opt-in window: due date to two days after');
for (const [posted, expected, label] of [
  ['2026-10-12', ['hydro@2026-10-12<-2026-10-12'], 'paid on the due date settles it (control)'],
  ['2026-10-13', ['hydro@2026-10-12<-2026-10-13'], 'one day late settles the Oct 12 occurrence'],
  ['2026-10-14', ['hydro@2026-10-12<-2026-10-14'], 'two days late settles the Oct 12 occurrence'],
]) {
  const got = keyOf(hydro(represented(world([windowed()], [pay(posted)]))));
  ok(JSON.stringify(got) === JSON.stringify(expected), label, JSON.stringify(got));
}
{
  // As-of Oct 15 so the three-days-late posting is inside coverage.
  const got = hydro(represented(world([windowed()], [pay('2026-10-15')], '2026-10-15')));
  ok(got.length === 0, 'three days late does not settle the occurrence', JSON.stringify(got));
}
{
  const got = hydro(represented(world([windowed()], [pay('2026-10-11')])));
  ok(got.length === 0, 'one day early does not settle (the window is late-only)', JSON.stringify(got));
}

console.log('No window declared: same-day only (unchanged default)');
{
  const got = keyOf(hydro(represented(world([{ ...HYDRO }], [pay('2026-10-12')]))));
  ok(JSON.stringify(got) === JSON.stringify(['hydro@2026-10-12<-2026-10-12']),
    'positive control: a same-day payment settles without a window', JSON.stringify(got));
}
for (const posted of ['2026-10-13', '2026-10-14']) {
  const got = hydro(represented(world([{ ...HYDRO }], [pay(posted)])));
  ok(got.length === 0, `a rule without a window does not settle from ${posted}`, JSON.stringify(got));
}
{
  // Oct 12, 2026 is a Monday: the explicit weekend rule allows the due date only.
  const bill = { ...HYDRO, rule: { postingDateRule: 'same-day-or-weekend-next-business-day' } };
  const got = hydro(represented(world([bill], [pay('2026-10-13')])));
  ok(got.length === 0, 'an explicit weekend rule keeps its own window (weekday +1 is not matched)', JSON.stringify(got));
}

console.log('Committed production identity rules are untouched');
{
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'connectivity',
    'transaction-identity.json'), 'utf8'));
  const rules = doc.rules || doc;
  ok(Array.isArray(rules) && rules.length > 0, 'positive control: production identity rules load', rules.length);
  const users = rules.filter(r => r && r.postingDateRule === WINDOW.postingDateRule).map(r => r.eventId);
  ok(users.length === 0, 'no production rule opts into the new window', JSON.stringify(users));
  const prime = rules.find(r => r && r.eventId === 'amazon-prime');
  ok(prime && !prime.postingDateRule, 'amazon-prime keeps its same-day identity (no postingDateRule)',
    prime && String(prime.postingDateRule));
}

console.log('One payment settles at most one occurrence');
{
  // Two windowed bills from the same payee due Oct 12 and Oct 13. A single
  // payment on Oct 14 is inside both windows: it is ambiguous and settles neither.
  const water = { id: 'water', label: 'Invented water', amount: 90, frequency: 'once', date: '2026-10-13',
    confidence: 'confirmed', payee: 'Invented hydro', rule: { ...WINDOW } };
  const got = represented(world([windowed(), water], [pay('2026-10-14')]))
    .filter(x => x.id === 'hydro' || x.id === 'water');
  ok(got.length === 0, 'a payment inside two bills\' windows settles neither', JSON.stringify(got));
}
{
  // Two same-payee payments, Oct 12 and Oct 14, are both candidates for the
  // one windowed Oct 12 occurrence. No nearest-match tie-break: it is not
  // settled (stays to confirm), and never settled twice.
  const got = hydro(represented(world([windowed()], [pay('2026-10-12'), pay('2026-10-14')])));
  ok(got.length === 0, 'two candidate payments for one occurrence: ambiguous, not settled twice', JSON.stringify(got));
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll bill late-window checks passed.');
