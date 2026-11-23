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

console.log('\n=== 3. every caller convention names the same occurrence (Codex P1 / review 7102257430) ===');
{
  const P = require('../scripts/provider-observe.js');
  const row = (extra) => Object.assign({ id: 'card-once', label: 'Card minimum', debtId: 'card-x', effect: 'payment',
    amount: 50, confidence: 'confirmed', payingAccount: 'chequing-a', frequency: 'once', date: '2026-10-20' }, extra || {});
  const moveTo24 = { statementOccurrences: [{ scheduledDate: '2026-10-20', dueDate: '2026-10-24', minimum: 50, currency: 'cad', confidence: 'confirmed' }] };
  const plan = obligations => ({ opening: { asOf: '2026-11-25' }, income: [], bills: [], commitments: [], budget: { categories: [] },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 1 }] }, obligations });
  const moved = plan([row(moveTo24)]);
  // representedKeySet path: the statement-moved date.
  ok(F.carriedOnceJointCashOutflow(moved, 'card-once', '2026-10-24', '2026-11-25') === true, 'moved date (representedKeySet path) matches');
  // provider-observe carriedOnceJointCashOccurrences and live-plan representedCandidateAllowed pass the original date.
  ok(F.carriedOnceJointCashOutflow(moved, 'card-once', '2026-10-20', '2026-11-25') === true, 'original date (provider-observe / live-plan path) matches');
  ok(F.carriedOnceJointCashOutflow(moved, 'card-once', '2026-10-22', '2026-11-25') === false, 'any other date does not match');
  ok(F.carriedOnceJointCashOutflow(moved, 'card-once', '2026-10-24', '2026-10-24') === false, 'not before the as-of: not carried');
  // A second once row with the same original date but a different id is its own occurrence.
  const two = plan([row(moveTo24), row({ id: 'other-once', debtId: 'card-y', date: '2026-10-20' })]);
  ok(F.carriedOnceJointCashOutflow(two, 'other-once', '2026-10-24', '2026-11-25') === false, 'different id: the first row\'s moved date does not match it');
  ok(F.carriedOnceJointCashOutflow(two, 'other-once', '2026-10-20', '2026-11-25') === true, 'different id: its own date still matches');
  ok(F.carriedOnceJointCashOutflow(plan([]), 'card-once', '2026-10-20', '2026-11-25') === false, 'an absent (unauthored) row is never carried');
  // The provider settlement lookup window still reaches the moved minimum's posting (36 days, as on the parent).
  const days = p => P.postedHistoryDaysForCarriedSettlement({ now: '2026-11-25T12:00:00Z', plan: p });
  ok(days(moved) === 36, 'provider lookup window covers the moved minimum (36 days)', days(moved));
  ok(days(plan([row()])) === 36, 'control: unmoved minimum window 36 days', days(plan([row()])));
  ok(days(plan([])) === P.CURRENT_STATE_HISTORY_DAYS, 'control: no carried row keeps the ordinary window', days(plan([])));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
