'use strict';
/* Future card minimums carry the card's latest published minimum (owner, Dale, lead 13's OD-028 record on #821): every
 * occurrence of a card's payment rows dated after the card's latest statement, with no statement of its own, takes that
 * statement's minimum, tagged estimated. Per card, across all its rows. A card with no statement keeps its plan amounts;
 * a closed card has no occurrences; a fixedInterestMinimum row takes max(fixed, carried); the HELOC's cash leg is
 * unchanged. One reader (obligationOccurrences), so the event stream the walk, the bill rows and cardMinimums read follows.
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
      // Cash Back: two rows handing over (day 4 until Oct, then day 20), the statement on the first row only.
      { id: 'cashback-old', debtId: 'cashback', effect: 'payment', label: 'Invented cash back minimum', frequency: 'monthly', day: 4,
        firstDue: '2026-08-04', lastDue: '2026-10-04', amount: 30, confidence: 'estimated', payingAccount: 'chequing-a',
        statementOccurrences: [statement('2026-10-04', '2026-10-04', 47)] },
      { id: 'cashback-new', debtId: 'cashback', effect: 'payment', label: 'Invented cash back minimum (new day)', frequency: 'monthly',
        day: 20, firstDue: '2026-10-20', amount: 30, confidence: 'estimated', payingAccount: 'chequing-a' },
      // Triangle: no statement, plan amount 40 stands.
      { id: 'triangle', debtId: 'triangle', effect: 'payment', label: 'Invented triangle minimum', frequency: 'monthly', day: 15,
        amount: 40, confidence: 'estimated', payingAccount: 'chequing-a' },
      // Amazon: a fixed interest minimum of 50 (3000 × 20% / 12) and a statement of 35: later occurrences take max(50, 35) = 50.
      { id: 'mbna', debtId: 'mbna', effect: 'payment', label: 'Invented amazon minimum', frequency: 'monthly', day: 8,
        amount: 20, fixedInterestMinimum: { balance: 3000, rate: 20, asOf: '2026-09-01' }, confidence: 'estimated', payingAccount: 'chequing-a',
        statementOccurrences: [statement('2026-10-08', '2026-10-08', 35)] },
      // TD card: closed in September, no occurrences ahead.
      { id: 'tdcc', debtId: 'tdcc', effect: 'payment', label: 'Invented TD minimum', frequency: 'monthly', day: 17,
        lastDue: '2026-09-17', amount: 15, confidence: 'estimated', payingAccount: 'chequing-a' },
    ],
  };
}
const occ = (p, id, from = '2026-10-01', to = '2027-01-31', Fx = F) =>
  Fx.obligationOccurrences(p.obligations.find(o => o.id === id), from, to, undefined, p).map(o => [o.date, o.amount, o.confidence]);

console.log('1. A card with a statement: later occurrences carry its minimum, estimated');
{
  const p = plan();
  const t = occ(p, 'travel');
  ok(JSON.stringify(t[0]) === JSON.stringify(['2026-10-12', 61, 'confirmed']), 'the October statement occurrence stays the statement (61, confirmed)', JSON.stringify(t[0]));
  ok(t.slice(1).length === 3 && t.slice(1).every(([, amount, trust]) => amount === 61 && trust === 'estimated'),
    'November, December and January carry 61, estimated (the plan said 25)', JSON.stringify(t.slice(1)));
  const without = F.obligationOccurrences(p.obligations[0], '2026-11-01', '2026-11-30').map(o => o.amount);
  ok(JSON.stringify(without) === '[25]', 'called without the plan (dates-only callers), the plan amount is unchanged', JSON.stringify(without));
}

console.log('2. Per card, across its rows');
{
  const p = plan();
  const next = occ(p, 'cashback-new');
  ok(next.length >= 3 && next.every(([, amount, trust]) => amount === 47 && trust === 'estimated'),
    'the successor row (no statement of its own) carries the card\'s latest statement, 47', JSON.stringify(next));
}

console.log('3. Controls');
{
  const p = plan();
  const tri = occ(p, 'triangle');
  ok(tri.length === 4 && tri.every(([, amount, trust]) => amount === 40 && trust === 'estimated'), 'a card with no statement keeps its plan amount (40)', JSON.stringify(tri));
  ok(occ(p, 'tdcc').length === 0, 'a closed card has no occurrences ahead');
  const mb = occ(p, 'mbna').slice(1);
  ok(mb.length === 3 && mb.every(([, amount]) => amount === 50), 'a fixed interest minimum row takes max(fixed 50, carried 35) = 50', JSON.stringify(mb));
  const before = occ(p, 'travel', '2026-09-01', '2026-09-30');
  ok(JSON.stringify(before) === JSON.stringify([['2026-09-10', 25, 'estimated']]), 'an occurrence before the statement keeps the plan amount', JSON.stringify(before));
}

console.log('4. The event stream follows (one reader)');
{
  const p = plan();
  const ev = F.expandEvents(p, '2026-11-01', '2026-11-30', {}).filter(e => e.kind === 'obligation' && e.debtId === 'travelvisa');
  ok(ev.length === 1 && ev[0].amount === -61 && ev[0].confidence === 'estimated', 'the walk\'s November Travel minimum is 61, estimated',
    JSON.stringify(ev.map(e => [e.date, e.amount, e.confidence])));
}

console.log('5. Mutant: the carry removed');
{
  const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
  const source = fs.readFileSync(FILE, 'utf8');
  const anchor = '    const carried = carriedCardMinimum(plan, row);\n';
  assert.equal(source.split(anchor).length, 2, 'mutant anchor found exactly once');
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(source.replace(anchor, '    const carried = null;\n'), FILE.replace(/\.js$/, '-no-carry.js'));
  const t = occ(plan(), 'travel', '2026-11-01', '2026-11-30', mod.exports);
  ok(JSON.stringify(t) === JSON.stringify([['2026-11-10', 25, 'estimated']]), 'MUTANT (no carry): November reads the plan\'s 25 again, which section 1 rejects', JSON.stringify(t));
}

console.log(`\nPASS future minimums carry the current minimum (${checks} checks)`);
