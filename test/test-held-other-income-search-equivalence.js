'use strict';
// Speed-only change, figure-neutral proof (speed order R1, 2026-11-12).
//
// Since #980 the forward walk asks heldOtherIncomeKeys for the expected Other
// Income it must not rely on, inside every expandEvents. One payday cent
// search (maxFeasiblePaydayRemoval) probes the walk hundreds of times, so the
// hold set was rebuilt per probe, and each rebuild walks every transaction in
// the live packet. The search now hands its probes one holder and the hold set
// is computed once per search for identical inputs.
//
// This suite proves the published result is unchanged, three ways, on invented
// data only (test/fixtures/held-other-income-search-world.js):
//   1. reference: the shipped source with the holder switched off (every call
//      computes afresh, the incumbent behaviour) gives deep-equal
//      Forecast.recommend output, or the same thrown error;
//   2. per probe: a checking copy recomputes the hold set on EVERY reuse and
//      compares it with the reused set, so each probe is compared, not only
//      the final answer; the corpus must reach reuse and must reuse a
//      non-empty hold set (an expectation really held To confirm);
//   3. teeth: a copy whose reuse returns an empty set changes the result on
//      a world whose held expectation is still ahead of as-of, so the
//      comparison in 1 can fail.
// It also pins the saving it exists for: the fresh computations per forecast.
// Nothing is printed except counts and case labels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const World = require('./fixtures/held-other-income-search-world');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'public', 'forecast.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');

const HOLDER = 'const holder = reuse && reuse.plan === plan && Array.isArray(reuse.entries) ? reuse : null;';
const HIT = 'if (entry.start === start && heldOtherIncomeInputsMatch(entry.opts, opts)) return new Set(entry.keys);';
const COMPUTE = 'const computed = computeHeldOtherIncomeKeys(plan, opts, start, events, txs);';

function compile(source) {
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(source, FILE);
  return mod.exports;
}
function patched(needle, replacement) {
  const at = SOURCE.indexOf(needle);
  assert.ok(at >= 0 && SOURCE.indexOf(needle, at + 1) < 0, 'patch anchor occurs exactly once: ' + needle);
  return SOURCE.replace(needle, replacement);
}
const count = name => 'globalThis.__atlasHeldProof.' + name + ' += 1;';
// 1. Reference: no holder is ever honoured, so every call computes afresh.
const reference = compile(patched(HOLDER, 'const holder = null;')
  .replace(COMPUTE, count('fresh') + ' ' + COMPUTE));
// Shipped behaviour, counting fresh computations only.
const shipped = compile(patched(COMPUTE, count('fresh') + ' ' + COMPUTE));
// 2. Checking: on every reuse, recompute and compare the two sets.
const checking = compile(patched(HIT,
  'if (entry.start === start && heldOtherIncomeInputsMatch(entry.opts, opts)) {'
  + ' const again = computeHeldOtherIncomeKeys(plan, opts, start, events, txs);'
  + ' const a = [...entry.keys].sort(), b = [...again.keys].sort();'
  + ' ' + count('reuses')
  + ' if (a.length) ' + count('nonEmptyReuses')
  + ' if (again.fromEvents || a.length !== b.length || a.some((key, i) => key !== b[i])) ' + count('mismatches')
  + ' return new Set(entry.keys); }'));
// 3. Teeth: a reuse that forgets the hold set.
const forgetful = compile(patched(HIT,
  'if (entry.start === start && heldOtherIncomeInputsMatch(entry.opts, opts)) return new Set();'));
assert.ok(new Set([reference, shipped, checking, forgetful]).size === 4, 'four independent engine copies');

const reset = () => { globalThis.__atlasHeldProof = { fresh: 0, reuses: 0, nonEmptyReuses: 0, mismatches: 0 }; };
function outcome(F, data, asOf, extra) {
  reset();
  const input = structuredClone(data);
  const opts = Object.assign(World.recommendOptions(input), structuredClone(extra || {}));
  let result;
  try { result = { ok: F.recommend(input.plan, asOf, opts) }; }
  catch (err) { result = { error: String(err && err.message) }; }
  return { result, proof: globalThis.__atlasHeldProof };
}

const AS_OF = '2026-11-10';
// As-of sits in the pay period 2026-10-30 to 2026-11-12. An expectation dated
// after as-of is still in the forward walk, so holding it moves the search.
const REBATE = { date: '2026-11-12', amount: 200 };
// An expectation already past: it can be settled by a posted receipt.
const PAST_REBATE = { date: '2026-11-07', amount: 200 };
const CASES = [
  // An unrelated 50 in the rebate's pay period: the rebate is held To confirm.
  ['held, 268 purchases', { rebate: REBATE, receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] }, {}, true],
  // The same world with cash to spare, so the cent search has room both ways.
  ['held, cash to spare', { transactions: 120, days: 30, cash: 14000, rebate: REBATE, receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] }, {}, true],
  // An exact same-day receipt settles the rebate: nothing is held.
  ['settled by an exact receipt', { transactions: 120, days: 30, rebate: PAST_REBATE, receipts: [{ id: 'exact', date: '2026-11-07', amount: 200 }] }, {}, false],
  // No receipt in its period: the rebate is relied upon as planned.
  ['relied upon, no receipt', { transactions: 120, days: 30, rebate: REBATE }, {}, false],
  // An income override makes the exact receipt inexact, so the rebate is held.
  ['held through an income override', { transactions: 120, days: 30, rebate: PAST_REBATE, receipts: [{ id: 'exact', date: '2026-11-07', amount: 200 }] },
    { incomeOverrides: { rebate: 340 } }, true],
  // A caller-supplied disabled id travels with every probe.
  ['held, with a disabled dated cost', { transactions: 120, days: 30, rebate: REBATE, receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] },
    { disabled: ['c3'] }, true],
  // Receipts across several pay periods and a longer history.
  ['held, 400 purchases over 60 days', { transactions: 400, days: 60, rebate: REBATE,
    receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }, { id: 'older', date: '2026-10-12', amount: 75 }] }, {}, true],
  // No transactions beyond payroll: the hold set is empty and must stay empty.
  ['no purchases', { transactions: 0, rebate: REBATE }, {}, false],
];

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const rebateRow = advice => ((advice && advice.payPeriodViews) || []).flatMap(view => view.income || [])
  .find(row => row && row.id === 'rebate') || null;

let reuses = 0, nonEmptyReuses = 0, heldCases = 0, forgetfulDiffers = 0;
for (const [label, world, extra, expectHeld] of CASES) {
  console.log('\n=== ' + label + ' ===');
  const data = World.build(Object.assign({ asOf: AS_OF }, world));
  const before = outcome(reference, data, AS_OF, extra);
  const after = outcome(shipped, data, AS_OF, extra);
  const checked = outcome(checking, data, AS_OF, extra);
  ok(!before.result.error, 'the forecast completes on this invented world', before.result.error || '');
  let same = true;
  try { assert.deepStrictEqual(after.result, before.result); } catch (_) { same = false; }
  ok(same, 'Forecast.recommend output is deep-equal with and without the holder');
  let sameChecked = true;
  try { assert.deepStrictEqual(checked.result, before.result); } catch (_) { sameChecked = false; }
  ok(sameChecked, 'the checking copy publishes the same result');
  ok(checked.proof.mismatches === 0, 'every reused hold set equals a fresh computation at that probe',
    `${checked.proof.reuses} reuses, ${checked.proof.mismatches} mismatches`);
  const row = before.result.ok && rebateRow(before.result.ok);
  ok(!!row && (row.toConfirm === true) === expectHeld,
    expectHeld ? 'the expected rebate is held To confirm on this world' : 'the expected rebate is not held on this world');
  ok(after.proof.fresh <= before.proof.fresh, 'the holder never adds a computation',
    `${before.proof.fresh} without, ${after.proof.fresh} with`);
  if (world.transactions !== 0) {
    ok(checked.proof.reuses > 0, 'the payday search reaches reuse on this world', String(checked.proof.reuses));
    // The saving this change exists for: at least four in five rebuilds go.
    ok(after.proof.fresh * 5 <= before.proof.fresh, 'at least four in five hold-set rebuilds are gone',
      `${before.proof.fresh} -> ${after.proof.fresh}`);
  }
  reuses += checked.proof.reuses;
  nonEmptyReuses += checked.proof.nonEmptyReuses;
  if (expectHeld) {
    heldCases++;
    const mutant = outcome(forgetful, data, AS_OF, extra);
    let differs = false;
    try { assert.deepStrictEqual(mutant.result, before.result); } catch (_) { differs = true; }
    if (differs) forgetfulDiffers++;
  }
}

console.log('\n=== the corpus reaches what it claims ===');
ok(reuses > 0, 'reuse happened', String(reuses));
ok(nonEmptyReuses > 0, 'a non-empty hold set was reused (an expectation held To confirm inside the search)', String(nonEmptyReuses));
ok(heldCases > 0 && forgetfulDiffers > 0,
  'teeth: a reuse that forgets the hold set changes the published result on a held world',
  `${forgetfulDiffers} of ${heldCases} held worlds`);

console.log('\n=== a call without a holder is untouched ===');
{
  // Forecast.simulate is not a payday search: no holder exists, so the walk
  // computes the hold set itself and equals the reference.
  const data = World.build({ asOf: AS_OF, rebate: REBATE, receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] });
  const walk = F => { reset(); const d = structuredClone(data);
    return [F.simulate(d.plan, AS_OF, { horizonDays: 28, weeklyVariable: 0,
      currentPeriodActuals: d.liveOverlay.currentPeriodActuals }), globalThis.__atlasHeldProof.fresh]; };
  const [a, freshA] = walk(reference), [b, freshB] = walk(shipped);
  let same = true;
  try { assert.deepStrictEqual(b, a); } catch (_) { same = false; }
  ok(same && freshA === freshB && freshA > 0, 'Forecast.simulate computes the hold set exactly as before',
    `${freshA} and ${freshB} computations`);
}

delete globalThis.__atlasHeldProof;
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
