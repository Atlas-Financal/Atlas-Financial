'use strict';
// Speed-only change, figure-neutral proof (#822, lead order A).
//
// expandEventsInternal's obligation loop and applyMinimumSent used to rebuild
// cardMinimumState(plan, asOf, opts) once per event from identical inputs.
// They now evaluate it at most once per loop (minimumStateForLoop), and drop it
// with the loop. This suite proves the published Forecast result is unchanged:
// a reference copy of the shipped source is patched back to the per-event
// evaluation, and both copies must give deep-equal Forecast.recommend output
// (which carries paydayAllocation and its cent search) or the same thrown
// error, across the committed plan and a seeded corpus of invented card
// evidence. Nothing is printed except counts and case labels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const H = require('./acceptance/harness');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'public', 'forecast.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
// The two loop call sites that now pass a loop state. The reference strips
// that argument, so minimumPaymentFor builds the state per event exactly as
// the incumbent did, whatever the shipped loop state or its arguments do.
const CALLS = [
  ['minimumPaymentFor(plan, event, start, opts, loopState)', 'minimumPaymentFor(plan, event, start, opts)'],
  ['minimumPaymentFor(plan, evidenceEvent, start, opts, obligationMinimumState)', 'minimumPaymentFor(plan, evidenceEvent, start, opts)'],
];
const HELPER = 'function minimumStateIfAny(plan, asOf, opts) {';
const PAYMENT = 'function minimumPaymentFor(plan, event, asOf, opts, loopState) {';

function compile(source) {
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(source, FILE);
  return mod.exports;
}
function once(haystack, needle) {
  const at = haystack.indexOf(needle);
  assert.ok(at >= 0 && haystack.indexOf(needle, at + 1) < 0, 'patch anchor occurs exactly once: ' + needle);
}
for (const [call] of CALLS) once(SOURCE, call);
once(SOURCE, HELPER);
once(SOURCE, PAYMENT);
// Reference: every loop step evaluates the state afresh (the incumbent
// per-event behaviour), and counts each non-null evaluation and each matched
// send so the corpus is proved to reach the changed path rather than skip it.
const reference = compile(CALLS.reduce((src, [call, incumbent]) => src.replace(call, incumbent), SOURCE)
  .replace(HELPER, 'function minimumStateIfAny(plan, asOf, opts) {'
    + ' const found = referenceMinimumStateIfAny(plan, asOf, opts);'
    + ' if (found) globalThis.__atlasMinimumStateEvaluations = (globalThis.__atlasMinimumStateEvaluations || 0) + 1;'
    + ' return found; }\n  function referenceMinimumStateIfAny(plan, asOf, opts) {')
  .replace(PAYMENT, 'function minimumPaymentFor(plan, event, asOf, opts, loopState) {'
    + ' const sent = referenceMinimumPaymentFor(plan, event, asOf, opts, loopState);'
    + ' if (sent) globalThis.__atlasMatchedMinimumPayments = (globalThis.__atlasMatchedMinimumPayments || 0) + 1;'
    + ' return sent; }\n  function referenceMinimumPaymentFor(plan, event, asOf, opts, loopState) {'));
const shipped = compile(SOURCE);
assert.notEqual(reference, shipped, 'two independent engine copies');

function outcome(F, plan, asOf, opts) {
  try { return { ok: F.recommend(structuredClone(plan), asOf, structuredClone(opts)) }; }
  catch (err) { return { error: String(err && err.message) }; }
}
let reachedCases = 0, matchedCases = 0;
function compare(label, plan, asOf, opts) {
  globalThis.__atlasMinimumStateEvaluations = 0;
  globalThis.__atlasMatchedMinimumPayments = 0;
  const before = outcome(reference, plan, asOf, opts);
  const evaluations = globalThis.__atlasMinimumStateEvaluations;
  const matched = globalThis.__atlasMatchedMinimumPayments;
  const after = outcome(shipped, plan, asOf, opts);
  assert.deepStrictEqual(after, before, label + ': shipped output equals per-event reference');
  if (evaluations > 1) reachedCases++;
  if (matched > 0) matchedCases++;
}

// Seeded, reproducible invented evidence (mulberry32).
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const money = r => Math.round((5 + r() * 400) * 100) / 100;
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const hex = r => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');

function inventedCase(seed) {
  const r = rng(seed);
  const asOf = pick(r, ['2026-10-14', '2026-10-09', '2026-10-20']);
  const { data } = H.dataOf(H.baseWorld(asOf));
  const plan = data.plan;
  const cards = ['triangle', 'mbna', 'tdcc', 'cashback', 'travelvisa'];
  const debts = [];
  const optionRepresented = [];
  const count = 1 + Math.floor(r() * 3);
  for (let i = 0; i < count; i++) {
    const debtId = cards[(i + Math.floor(r() * 5)) % 5];
    if (debts.some(d => d.id === debtId)) continue;
    debts.push({ id: debtId, name: 'Invented card ' + i, balance: money(r) * 10, limit: 5000, apr: 0.2, minPayment: 25, kind: 'revolving' });
    // Upcoming occurrence (on or after every asOf choice) paid early, so a
    // valid send matches an event inside the walk; some cases stay invalid.
    const day = 21 + Math.floor(r() * 8);
    const amount = money(r);
    const row = { id: 'inv-min-' + i, debtId, effect: 'payment', label: 'Invented minimum ' + i,
      frequency: 'monthly', day, firstDue: '2026-09-01', amount, confidence: pick(r, ['confirmed', 'estimated']),
      payingAccount: pick(r, ['chequing-a', 'chequing-b']) };
    const scheduledDate = iso(2026, 10, day);
    if (r() < 0.5) {
      const dueDay = Math.min(28, day + 1 + Math.floor(r() * 3));
      row.statementOccurrences = [{ scheduledDate, dueDate: iso(2026, 10, dueDay), minimum: money(r), currency: 'cad', confidence: 'confirmed' }];
    }
    if (r() < 0.8) {
      const posted = iso(2026, 10, 1 + Math.floor(r() * 8));
      const valid = r() < 0.75;
      row.sentPayments = [{ scheduledDate, confirmed: valid || r() < 0.5, intent: valid ? 'minimum' : pick(r, ['minimum', 'purchase-backfill', 'unknown']),
        debitId: hex(r), postedOn: posted, amount: r() < 0.5 ? amount : money(r), currency: 'cad',
        fundingAccountId: valid ? row.payingAccount : 'chequing-x', pending: false,
        ...(r() < 0.6 ? { cashIncludedAsOf: posted } : {}) }];
      // Issuer satisfaction comes from represented evidence on the opening
      // or, separately, from the caller's opts.representedEvents.
      const roll = r();
      if (roll < 0.25) plan.opening.representedEvents.push({ id: row.id, date: scheduledDate });
      else if (roll < 0.6) optionRepresented.push({ id: row.id, date: scheduledDate });
      // An unparseable occurrence amount keeps a sent minimum's zero-cash
      // record in the walk; without the send it is excluded (ATLAS-077).
      if (valid && r() < 0.3) row.amount = 'invented-unparseable';
    }
    plan.obligations.push(row);
  }
  if (r() < 0.4) {
    const row = plan.obligations.find(o => !o.sentPayments);
    if (row) plan.cardMinimumCategoryEvidence = { source: 'lunchmoney-minimum-category', asOf,
      payments: [{ id: row.id, scheduledDate: iso(2026, 10, row.day), confirmed: true, intent: 'minimum', pending: false,
        currency: 'cad', amount: row.amount, postedOn: asOf, cashIncludedAsOf: asOf,
        fundingAccountId: row.payingAccount, debitId: hex(r) }] };
  }
  return { plan, asOf, opts: { debts, currentPeriodActuals: data.liveOverlay?.currentPeriodActuals || null,
    ...(optionRepresented.length ? { representedEvents: optionRepresented } : {}) } };
}

// 1. The committed plan (as the incumbent card-minimum suites use it).
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
for (const shift of [0, 3, 12]) {
  const asOf = shift ? reference.addDays(committed.meta.asOf, shift) : committed.meta.asOf;
  compare('committed plan +' + shift + 'd', committed.plan, asOf, { debts: committed.debts });
}
// 2. Invented acceptance world, unchanged (no card evidence: the guard path).
{
  const { data } = H.dataOf(H.baseWorld());
  compare('acceptance base world', data.plan, data.plan.opening.asOf, { currentPeriodActuals: data.liveOverlay?.currentPeriodActuals || null });
}
// 3. Seeded invented card evidence.
const CASES = 32;
for (let seed = 1; seed <= CASES; seed++) {
  const c = inventedCase(seed);
  compare('invented seed ' + seed, c.plan, c.asOf, c.opts);
}
// The corpus must exercise the changed loops with real minimum state, not
// only the early return: otherwise equality would prove nothing.
assert.ok(reachedCases >= 10, 'card-minimum loops reached with evidence in ' + reachedCases + ' cases');
// And a validated send must actually match an event (amount replaced in the
// walk) in enough cases for the comparison to cover that branch.
assert.ok(matchedCases >= 8, 'validated minimum sends matched an event in ' + matchedCases + ' cases');
console.log(`card-minimum loop-state equivalence: ${CASES + 4} cases deep-equal; ${reachedCases} reached the changed loops with evidence; ${matchedCases} matched a validated send`);
