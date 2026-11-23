'use strict';
// Gemini hunt 4, finding 2: a once card minimum whose statement moved its due
// date is not replayed after it is represented. representedKeySet maps the
// represented date to the statement's due date before asking
// carriedOnceJointCashOutflow, which compared the once row's UNMOVED date, so
// the moved occurrence was still carried and deducted again. Invented values.
//
// Cash 1000 at 2026-10-30. A 50 once minimum scheduled 2026-10-20, moved by
// its statement to 2026-10-24, both before the as-of. Represented (already
// paid): nothing deducted, ending 1000. Not represented: carried once, 950.
const F = require('../public/forecast.js');
let failures = 0;
function ok(cond, label, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
const debts = [{ id: 'card-x', label: 'Invented card', structure: 'Revolving', secured: false, balance: 500, pending: 0, rate: 0.2, limit: 2000 }];
function run({ moved = true, represented = true, freq = 'once' } = {}) {
  const ob = Object.assign({ id: 'card-once', label: 'Card minimum', debtId: 'card-x', effect: 'payment', amount: 50,
    confidence: 'confirmed', payingAccount: 'chequing-a' },
    freq === 'once' ? { frequency: 'once', date: '2026-10-20' } : { frequency: 'monthly', day: 20 });
  if (moved) ob.statementOccurrences = [{ scheduledDate: '2026-10-20', dueDate: '2026-10-24', minimum: 50, currency: 'cad', confidence: 'confirmed' }];
  const plan = {
    opening: { asOf: '2026-10-30', representedEvents: represented ? [{ id: 'card-once', date: '2026-10-20' }] : [] },
    startingCash: { asOf: '2026-10-30', breakdown: [
      { id: 'chequing-a', value: 1000, confidence: 'confirmed', evidenceDate: '2026-10-30' },
      { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: '2026-10-30' },
    ] },
    income: [], bills: [], commitments: [], obligations: [ob], budget: { categories: [] },
  };
  const sim = F.simulate(plan, '2026-10-30', { debts, weeklyVariable: 0, horizonDays: 10, viewDays: 10 });
  return { ending: sim.ending, events: (sim.events || []).filter(e => e.id === 'card-once').map(e => e.date) };
}

console.log('\n=== 1. a moved once minimum that is represented is not replayed ===');
{
  const r = run();
  ok(r.ending === 1000 && r.events.length === 0, 'moved + represented: no deduction, ending 1000', r);
  const n = run({ represented: false });
  ok(n.ending === 950 && JSON.stringify(n.events) === '["2026-10-24"]', 'moved + not represented: carried once on its moved date (950)', n);
}

console.log('\n=== 2. unchanged cases ===');
{
  const r = run({ moved: false });
  ok(r.ending === 1000 && r.events.length === 0, 'unmoved + represented: no deduction (as before)', r);
  const n = run({ moved: false, represented: false });
  ok(n.ending === 950 && JSON.stringify(n.events) === '["2026-10-20"]', 'unmoved + not represented: carried on its own date (as before)', n);
  // A recurring row is never a carried once outflow: the past occurrence is not replayed either way.
  const rec = run({ freq: 'monthly' });
  const recNot = run({ freq: 'monthly', represented: false });
  ok(rec.ending === recNot.ending, 'recurring row: unaffected by this path', { represented: rec, notRepresented: recNot });
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
