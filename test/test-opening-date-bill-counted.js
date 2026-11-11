'use strict';
/* Audit finding 15: a bill due exactly on the dated opening date has no
 * payment evidence in the opening cash, so it counts in today's position
 * exactly once, and the Bills total agrees with the "To confirm" list. A bill
 * that a posted debit already paid on that date is not counted twice.
 *
 * Invented world through the production path (scripts/live-plan.js overlay,
 * then Forecast.recommend, the allocation the Plan page prints as
 * "Bills & required minimums"): canonical opening cut 2026-10-12, live
 * as-of 2026-10-14, one monthly bill of 90, no household figure.
 *
 * Hand-worked expectations (from the inputs, not from Atlas):
 *   bill due the 11th (before the opening): inside the opening cash, so it
 *       contributes 0 and its row reads "in opening".
 *   bill due the 12th (the opening date), no bank evidence: contributes 90
 *       once; its row reads still due / unverified ("To confirm").
 *   bill due the 13th (after the opening): contributes 90.
 *   bill due the 12th and paid by a debit on the 12th: contributes 0 (not 90
 *       again); its row reads PAID.
 *   bill due the 12th and a second, unpaid bill due the 12th: 90 total.
 *   bill due the 15th: 90 (control: nothing near the opening date moves).
 *
 * `node test/test-opening-date-bill-counted.js`
 */
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');
const Op = require('../scripts/operating-answer.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
};
const OPENING = '2026-10-12';
const bill = (id, day) => ({ id, label: 'Invented ' + id, amount: 90, frequency: 'monthly', day, confidence: 'confirmed', payee: 'Invented ' + id });
const world = (bills, extraTx) => {
  const w = H.baseWorld('2026-10-14');
  w.bills = bills;
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })]
    .concat(extraTx || []);
  w.productionOpened = true;
  w.canonicalAsOf = OPENING;
  w.planPatch = plan => {
    const { priorAsOf, ...kept } = plan.opening || {};
    plan.opening = { ...kept, asOf: OPENING, representedEvents: kept.representedEvents || [] };
    for (const row of plan.startingCash.breakdown) row.evidenceDate = OPENING;
  };
  const sav = w.accounts.find(a => a.id === 'savings' && !a.held);
  if (sav) { sav.reserve = false; sav.role = 'household-cash'; }
  return w;
};
const run = (bills, extraTx) => {
  const data = H.dataOf(world(bills, extraTx)).data;
  const advice = F.recommend(data.plan, '2026-10-14', Op.recommendOpts(data, {}));
  const rows = [];
  (function walk(o, depth) {
    if (!o || depth > 6) return;
    if (Array.isArray(o)) return o.forEach(x => walk(x, depth + 1));
    if (typeof o !== 'object') return;
    if (typeof o.id === 'string' && 'status' in o && 'settlement' in o) rows.push(o.id + ':' + o.status + '|' + o.settlement);
    Object.values(o).forEach(x => walk(x, depth + 1));
  })(advice.defaultView, 0);
  return { allocated: advice.paydayAllocation.obligations.allocated, rows: new Set(rows) };
};
const pay = (day, payee) => H.lm({ date: '2026-10-' + day, amount: 90, category: 'Utilities', account: 'chequing-a', payee });

let r = run([bill('hydro', 11)]);
ok(r.allocated === 0 && r.rows.has('hydro:in opening|opening'), 'due before the opening: inside the opening cash, counts 0 (unchanged)', `allocated=${r.allocated}`);
r = run([bill('hydro', 12)]);
ok(r.allocated === 90 && r.rows.has('hydro:still due|unverified'),
  'due on the opening date, no evidence: counts 90 once and the row is To confirm (total and list agree)', `allocated=${r.allocated} ${[...r.rows]}`);
r = run([bill('hydro', 13)]);
ok(r.allocated === 90 && r.rows.has('hydro:still due|unverified'), 'due the day after the opening: counts 90 (unchanged)', `allocated=${r.allocated}`);
r = run([bill('hydro', 12)], [pay('12', 'Invented hydro')]);
ok(r.allocated === 0 && r.rows.has('hydro:PAID|represented'),
  'due on the opening date and paid by a debit that day: not counted again, row is PAID', `allocated=${r.allocated} ${[...r.rows]}`);
r = run([bill('hydro', 12), bill('net', 12)], [pay('12', 'Invented hydro')]);
ok(r.allocated === 90 && r.rows.has('hydro:PAID|represented') && r.rows.has('net:still due|unverified'),
  'two bills on the opening date, one paid: only the unpaid one counts (90)', `allocated=${r.allocated} ${[...r.rows]}`);
r = run([bill('hydro', 15)]);
ok(r.allocated === 90 && r.rows.has('hydro:still due|upcoming'), 'control: a bill due after today still counts 90 and reads upcoming', `allocated=${r.allocated}`);

/* An unknown amount on the opening date is unknown, not silently dropped. */
const unknownPlan = amount => ({
  defaults: { targetBuffer: 0 }, startingCash: { amount: 2000 },
  opening: { asOf: '2026-10-14', priorAsOf: OPENING, representedEvents: [] },
  income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
  bills: [{ id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 12, amount, confidence: 'confirmed' }],
  obligations: [], commitments: [], budget: { categories: [] },
});
const state = amount => F.scheduledAmountState(unknownPlan(amount), '2026-10-14', '2027-01-12');
ok(state(90).status === 'ready', 'control: a known 90 bill on the opening date leaves the walk ready');
ok(state('12abc').status === 'unavailable' && state('12abc').unknowns.some(u => u.id === 'hydro'),
  'an unreadable amount on the opening date is unknown, not silently dropped');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
