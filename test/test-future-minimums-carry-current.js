'use strict';
/* Future card minimums carry the current published minimum (owner, Dale, #821 7173859561, 2026-11-25: "make the
 * minimums for future pay periods what the minimums are for this pay period"; lead 13). Every occurrence of a payment
 * row dated after that row's latest statement, with no statement of its own, takes that statement's minimum, tagged
 * estimated. Within the row only: a dated successor row (a card's rows hand over at lastDue / firstDue) keeps its own
 * planned amount, an owner-set fixed payment for example, until it has a statement of its own. A dated amount-schedule
 * term wins over the carry. A row with no statement keeps its plan amounts; a fixedInterestMinimum row takes
 * max(fixed, carried). One reader (CardMinimumContract.resolveOccurrences, under obligationOccurrences), so the walk,
 * the bill rows, cardMinimums and the un-noted payment inference (#1650) read one figure.
 * Invented plan only; every expectation is written by hand. `node test/test-future-minimums-carry-current.js` */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const F = require('../public/forecast.js');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

const statement = (scheduledDate, dueDate, minimum) => ({ scheduledDate, dueDate, minimum, currency: 'cad', confidence: 'confirmed' });
function plan() {
  return {
    income: [], bills: [], commitments: [], budget: {},
    obligations: [
      // Travel: plan says 25 a month; the October statement says 61.
      { id: 'travel', debtId: 'travelvisa', effect: 'payment', label: 'Invented travel minimum', frequency: 'monthly', day: 10,
        amount: 25, confidence: 'estimated', payingAccount: 'chequing-a', statementOccurrences: [statement('2026-10-10', '2026-10-12', 61)] },
      // Cash Back: two rows handing over (day 4 until Oct, then day 20 at an owner-set 30), the statement on the first only.
      { id: 'cashback-old', debtId: 'cashback', effect: 'payment', label: 'Invented cash back minimum', frequency: 'monthly', day: 4,
        firstDue: '2026-08-04', lastDue: '2026-10-04', amount: 30, confidence: 'estimated', payingAccount: 'chequing-a',
        statementOccurrences: [statement('2026-10-04', '2026-10-04', 47)] },
      { id: 'cashback-new', debtId: 'cashback', effect: 'payment', label: 'Invented cash back fixed payment (new day)', frequency: 'monthly',
        day: 20, firstDue: '2026-10-20', amount: 30, confidence: 'estimated', payingAccount: 'chequing-a' },
      // Triangle: no statement, plan amount 40 stands.
      { id: 'triangle', debtId: 'triangle', effect: 'payment', label: 'Invented triangle minimum', frequency: 'monthly', day: 15,
        amount: 40, confidence: 'estimated', payingAccount: 'chequing-a' },
      // Amazon: a fixed interest minimum of 50 (3000 × 20% / 12) and a statement of 35: later occurrences take max(50, 35) = 50.
      { id: 'mbna', debtId: 'mbna', effect: 'payment', label: 'Invented amazon minimum', frequency: 'monthly', day: 8,
        amount: 20, fixedInterestMinimum: { balance: 3000, rate: 20, asOf: '2026-09-01' }, confidence: 'estimated', payingAccount: 'chequing-a',
        statementOccurrences: [statement('2026-10-08', '2026-10-08', 35)] },
      // Emerald: a statement of 33 in October, and a dated amount schedule setting 70 from December.
      { id: 'emerald', debtId: 'tdcc', effect: 'payment', label: 'Invented emerald minimum', frequency: 'monthly', day: 17,
        amount: 15, confidence: 'estimated', payingAccount: 'chequing-a', statementOccurrences: [statement('2026-10-17', '2026-10-17', 33)],
        amountSchedule: [{ from: '2026-12-01', until: '2027-12-01', amount: 70, confidence: 'confirmed' }] },
    ],
  };
}
const occ = (p, id, from = '2026-10-01', to = '2027-01-31', Fx = F) =>
  Fx.obligationOccurrences(p.obligations.find(o => o.id === id), from, to).map(o => [o.date, o.amount, o.confidence]);
const J = JSON.stringify;

console.log('1. A row with a statement: later occurrences carry its minimum, estimated');
{
  const t = occ(plan(), 'travel');
  ok(J(t[0]) === J(['2026-10-12', 61, 'confirmed']), 'the October statement occurrence stays the statement (61, confirmed)', J(t[0]));
  ok(t.slice(1).length === 3 && t.slice(1).every(([, amount, trust]) => amount === 61 && trust === 'estimated'),
    'November, December and January carry 61, estimated (the plan said 25)', J(t.slice(1)));
  const before = occ(plan(), 'travel', '2026-09-01', '2026-09-30');
  ok(J(before) === J([['2026-09-10', 25, 'estimated']]), 'an occurrence before the statement keeps the plan amount', J(before));
}

console.log('2. Within the row only');
{
  const next = occ(plan(), 'cashback-new');
  ok(next.length >= 3 && next.every(([, amount, trust]) => amount === 30 && trust === 'estimated'),
    'a dated successor row with no statement of its own keeps its planned 30, not the old row\'s 47', J(next));
}

console.log('3. Controls');
{
  const p = plan();
  const tri = occ(p, 'triangle');
  ok(tri.length === 4 && tri.every(([, amount, trust]) => amount === 40 && trust === 'estimated'), 'a row with no statement keeps its plan amount (40)', J(tri));
  const mb = occ(p, 'mbna').slice(1);
  ok(mb.length === 3 && mb.every(([, amount]) => amount === 50), 'a fixed interest minimum row takes max(fixed 50, carried 35) = 50', J(mb));
  const em = occ(p, 'emerald');
  ok(J(em) === J([['2026-10-17', 33, 'confirmed'], ['2026-11-17', 33, 'estimated'], ['2026-12-17', 70, 'estimated'], ['2027-01-17', 70, 'estimated']]),
    'November carries 33, estimated; the dated amount schedule wins from December (70, tagged as the schedule resolves it today)', J(em));
}

console.log('4. One reader: the walk follows (the un-noted payment inference: test-infer-card-payment-destination 2b)');
{
  const p = plan();
  const ev = F.expandEvents(p, '2026-11-01', '2026-11-30', {}).filter(e => e.kind === 'obligation' && e.debtId === 'travelvisa');
  ok(ev.length === 1 && ev[0].amount === -61 && ev[0].confidence === 'estimated', 'the walk\'s November Travel minimum is 61, estimated',
    J(ev.map(e => [e.date, e.amount, e.confidence])));
}

console.log('5. Mutant: the carry removed');
{
  const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
  const source = fs.readFileSync(FILE, 'utf8');
  const anchor = '      if (latest && !statement && scheduledDate > latest.scheduledDate) {\n';
  assert.equal(source.split(anchor).length, 2, 'mutant anchor found exactly once');
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(source.replace(anchor, '      if (false) {\n'), FILE.replace(/\.js$/, '-no-carry.js'));
  const t = occ(plan(), 'travel', '2026-11-01', '2026-11-30', mod.exports);
  ok(J(t) === J([['2026-11-10', 25, 'estimated']]), 'MUTANT (no carry): November reads the plan\'s 25 again, which section 1 rejects', J(t));
}

console.log(`\nPASS future minimums carry the current minimum (${checks} checks)`);
