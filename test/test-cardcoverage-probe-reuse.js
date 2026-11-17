'use strict';
// cardCoverageState is computed once per maxFeasiblePaydayRemoval search
// instead of once per cent-search probe, and that reuse never changes a
// published Forecast result.
//
// Synthetic inputs only: test/fixtures/cardcov-probe-inputs.json was generated
// from test/fixtures/cardcov-probe-data.js (seeded, invented values) through
// the live overlay with synthetic periods. No household data is read.
//
// Independence: the reference is the same engine source with the reuse path
// textually disabled (the incumbent once-per-probe behaviour), evaluated in
// its own module instance. Counts come from counters injected into a private
// copy of the source; public/forecast.js exposes no test hook.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sourceText } = require('./test-source-text');
const LmGroups = require('./lm-groups-fixture.js');

const SRC_PATH = path.join(__dirname, '..', 'public', 'forecast.js');
const SOURCE = sourceText(fs.readFileSync(SRC_PATH, 'utf8'));
const INPUTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cardcov-probe-inputs.json'), 'utf8'));
const clone = v => structuredClone(v);
// A confirmed synthetic commitment 20 days out makes paydayAllocation's cent
// search (maxFeasiblePaydayRemoval) probe instead of fitting on the first try.
const BASE = (() => {
  const i = structuredClone(INPUTS);
  i.plan = LmGroups.groupPlan(i.plan);
  i.opts.currentPeriodActuals = LmGroups.groupPacket(i.opts.currentPeriodActuals, i.plan);
  const d = new Date(i.asOf + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 20);
  i.plan.commitments.push({ id: 'synthetic-near-commitment', label: 'Synthetic near commitment',
    date: d.toISOString().slice(0, 10), amount: 2500, confidence: 'confirmed' });
  return i;
})();

const ANCHOR_COVERAGE = 'function cardCoverageState(plan, asOf, opts) {';
const ANCHOR_SIM = 'function simulateModel(plan, asOf, opts) {\n    opts = opts || {};';
const REUSE_SWITCH = 'const reuse = opts.cardCoverageReuse;';

function once(text, needle) {
  const n = text.split(needle).length - 1;
  assert.strictEqual(n, 1, `expected exactly one "${needle.split('\n')[0]}" in public/forecast.js, found ${n}`);
}

function load({ reuse }) {
  once(SOURCE, ANCHOR_COVERAGE);
  once(SOURCE, ANCHOR_SIM);
  let src = SOURCE
    .replace(ANCHOR_COVERAGE, ANCHOR_COVERAGE + '\n    __counts.cardCoverageState++;')
    .replace(ANCHOR_SIM, ANCHOR_SIM + '\n    __counts.simulateModel++;');
  const hasReuse = SOURCE.includes(REUSE_SWITCH);
  if (hasReuse) { once(SOURCE, '  const Forecast = {'); src = src.replace('  const Forecast = {', '  __counts.probeCardCoverage = probeCardCoverage;\n  const Forecast = {'); }
  if (!reuse && hasReuse) src = src.replace(REUSE_SWITCH, 'const reuse = null;');
  const counts = { cardCoverageState: 0, simulateModel: 0 };
  const mod = { exports: {} };
  const req = id => require(path.join(path.dirname(SRC_PATH), id));
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__counts', src)(mod, mod.exports, req, counts);
  return { F: mod.exports, counts, hasReuse };
}

const withReuse = load({ reuse: true });
const reference = load({ reuse: false });

function evaluate(engine, input) {
  engine.counts.cardCoverageState = 0;
  engine.counts.simulateModel = 0;
  const advice = engine.F.recommend(input.plan, input.asOf, input.opts);
  return { advice, cardCoverageState: engine.counts.cardCoverageState, simulateModel: engine.counts.simulateModel };
}
const ser = v => JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? `__num:${x}` : x === undefined ? '__undef' : x));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (err) { failures++; console.log('FAIL ' + name + '\n  ' + String(err && err.message || err).split('\n').join('\n  ')); }
}

// Bound: each cent search may compute card coverage once; every other call
// site in one recommend() evaluation (master walk, funding sequence, payday
// allocation, recommend's published coverage) still computes it directly.
// On this fixture that is 41-45 per evaluation, independent of the probe count
// (136-239 probes); one-per-probe was 161-265. 60 leaves margin for
// incidental call-site changes and stays far below one-per-probe.
const MAX_CARD_COVERAGE_PER_EVALUATION = 60;

const base = evaluate(withReuse, clone(BASE));
const baseRef = evaluate(reference, clone(BASE));
console.log(`counts per evaluation: reuse cardCoverageState=${base.cardCoverageState} simulateModel=${base.simulateModel}; ` +
  `reference cardCoverageState=${baseRef.cardCoverageState} simulateModel=${baseRef.simulateModel}`);

check('cardCoverageState invocations per recommend() evaluation are bounded', () => {
  assert.ok(base.simulateModel > 100, `fixture must exercise the probe search (simulateModel=${base.simulateModel})`);
  assert.ok(base.cardCoverageState <= MAX_CARD_COVERAGE_PER_EVALUATION,
    `cardCoverageState ran ${base.cardCoverageState} times in one evaluation (simulateModel ${base.simulateModel}); bound ${MAX_CARD_COVERAGE_PER_EVALUATION}`);
});

check('the probe search itself is unchanged (same simulateModel count with and without reuse)', () => {
  assert.strictEqual(base.simulateModel, baseRef.simulateModel);
});

check('complete recommend() output deep-equals the no-reuse reference on the base fixture', () => {
  assert.strictEqual(ser(base.advice), ser(baseRef.advice));
  assert.strictEqual(base.advice.sim.cardPurchaseCoverage && base.advice.sim.cardPurchaseCoverage.status, 'ready');
});

// Synthetic matrix. Each variant changes one input cardCoverageState or the
// search reads. Output must equal the reference on the same input, and the
// coverage-relevant variants must actually move the output (not served stale).
const variants = {
  'asOf +1 day': (i) => { i.asOf = withReuse.F.addDays(i.asOf, 1); },
  'asOf +9 days': (i) => { i.asOf = withReuse.F.addDays(i.asOf, 9); },
  'card purchase added to actuals': (i) => {
    const t = i.opts.currentPeriodActuals.transactions; const c = clone(t.find(x => x.atlasAccountId && x.atlasAccountId.startsWith('card')) || t[t.length - 1]);
    c.id = 'synthetic-extra'; c.coverageRef = 'synthetic-extra'; c.amount = 640; t.push(c); },
  'chequing spend added to actuals': (i) => {
    const t = i.opts.currentPeriodActuals.transactions; const c = clone(t.find(x => x.atlasAccountId === 'chequing-b') || t[t.length - 1]);
    c.id = 'synthetic-extra-2'; c.coverageRef = 'synthetic-extra-2'; c.amount = 910; t.push(c); },
  'actuals removed': (i) => { i.opts.currentPeriodActuals = null; },
  'debt balance changed': (i) => { i.opts.debts[0].balance += 4000; },
  'Bills opening balance changed': (i) => { i.plan.startingCash.breakdown[0].value -= 900; },
  'large bill inside the window': (i) => { i.plan.bills.push({ id: 'synthetic-big', label: 'Synthetic big bill', frequency: 'once',
    date: withReuse.F.addDays(i.asOf, 3), amount: 7000, confidence: 'confirmed', payingAccount: 'chequing-a' }); },
  'no funding sources': (i) => { i.opts.fundingSources = []; },
  'targetBuffer raised': (i) => { i.opts.targetBuffer = (i.opts.targetBuffer || 0) + 600; },
  'card coverage opening absent (unknown evidence)': (i) => { delete i.plan.cardPurchaseCoverage; },
};
const mustMove = new Set(['asOf +9 days', 'card purchase added to actuals', 'actuals removed', 'Bills opening balance changed',
  'large bill inside the window', 'card coverage opening absent (unknown evidence)']);
const results = {};
for (const [name, mutate] of Object.entries(variants)) {
  check(`matrix: ${name} — equals no-reuse reference${mustMove.has(name) ? ' and moves the output' : ''}`, () => {
    const a = clone(BASE); mutate(a); const b = clone(BASE); mutate(b);
    const got = evaluate(withReuse, a), ref = evaluate(reference, b);
    results[name] = got;
    assert.strictEqual(ser(got.advice), ser(ref.advice), 'output differs from reference');
    assert.strictEqual(got.simulateModel, ref.simulateModel, 'probe count differs');
    console.log(`  ${name}: cardCoverageState ${got.cardCoverageState} (reference ${ref.cardCoverageState}), simulateModel ${got.simulateModel}`);
    assert.ok(got.cardCoverageState <= MAX_CARD_COVERAGE_PER_EVALUATION, `count ${got.cardCoverageState}`);
    if (mustMove.has(name)) assert.notStrictEqual(ser(got.advice), ser(base.advice), 'variant did not change output; stale-reuse control is vacuous');
  });
}

check('unknown card evidence stays unknown (no reuse converts unavailable into a figure)', () => {
  const r = results['card coverage opening absent (unknown evidence)'];
  assert.ok(r, 'variant ran');
  assert.strictEqual(r.advice.sim.cardPurchaseCoverage.status, 'unavailable');
  assert.strictEqual(r.advice.weekly, null);
  assert.strictEqual(r.advice.paydayAllocation.protectedPath.status, 'unavailable');
});

check('caller mutation of inputs and outputs between evaluations does not leak', () => {
  const a = clone(BASE);
  const first = evaluate(withReuse, a);
  // Mutate the returned advice and every coverage input in place.
  first.advice.weekly = 123456; if (first.advice.sim.cardPurchaseCoverage) first.advice.sim.cardPurchaseCoverage.status = 'tampered';
  a.opts.currentPeriodActuals.transactions.push({ id: 'synthetic-late', coverageRef: 'synthetic-late', date: a.asOf, amount: 777, currency: 'cad',
    pending: false, atlasAccountId: 'chequing-b', accountRole: 'household-cash' });
  a.opts.debts[0].balance += 2500; a.plan.startingCash.breakdown[0].value -= 1200;
  const again = evaluate(withReuse, a);
  const refMutated = evaluate(reference, (() => { const r = clone(BASE); r.opts.currentPeriodActuals.transactions.push(clone(a.opts.currentPeriodActuals.transactions.at(-1))); r.opts.debts[0].balance += 2500; r.plan.startingCash.breakdown[0].value -= 1200; return r; })());
  assert.strictEqual(ser(again.advice), ser(refMutated.advice), 'same mutated objects re-evaluated must equal reference');
  const fresh = evaluate(withReuse, clone(BASE));
  assert.strictEqual(ser(fresh.advice), ser(baseRef.advice), 'a fresh evaluation after mutation must equal the pristine reference');
});

{
  const x = clone(BASE), y = clone(BASE); variants['large bill inside the window'](y);
  const order = [x, y, x, y].map(i => ser(evaluate(withReuse, clone(i)).advice));
  const refX = ser(evaluate(reference, clone(x)).advice), refY = ser(evaluate(reference, clone(y)).advice);
  check('interleaved X,Y,X,Y evaluations each equal their own reference', () => {
    assert.deepStrictEqual(order, [refX, refY, refX, refY]);
    assert.notStrictEqual(refX, refY);
  });
}

check('a reuse holder serves only its exact inputs; any other input is computed fresh', () => {
  const probe = withReuse.counts.probeCardCoverage;
  assert.strictEqual(typeof probe, 'function', 'probeCardCoverage present');
  const i = clone(BASE);
  const holder = { plan: i.plan, asOf: i.asOf, currentPeriodActuals: i.opts.currentPeriodActuals, debts: i.opts.debts,
    representedEvents: i.opts.representedEvents, computed: false, value: null };
  const optsFor = o => Object.assign({}, o, { cardCoverageReuse: holder });
  const direct = (plan, asOf, opts) => { const o = Object.assign({}, opts); delete o.cardCoverageReuse; return ser(probe(plan, asOf, o)); };
  withReuse.counts.cardCoverageState = 0;
  const first = probe(i.plan, i.asOf, optsFor(i.opts));
  const second = probe(i.plan, i.asOf, optsFor(Object.assign({}, i.opts, { disabled: ['bill0'], plannedFlows: [{ date: i.asOf, amount: -5 }] })));
  assert.strictEqual(withReuse.counts.cardCoverageState, 1, 'matching inputs reuse one computation');
  assert.strictEqual(first, second);
  const cases = {
    'other plan object (deep-equal)': [clone(i.plan), i.asOf, i.opts],
    'other asOf': [i.plan, withReuse.F.addDays(i.asOf, 1), i.opts],
    'other actuals object': [i.plan, i.asOf, Object.assign({}, i.opts, { currentPeriodActuals: clone(i.opts.currentPeriodActuals) })],
    'actuals absent': [i.plan, i.asOf, Object.assign({}, i.opts, { currentPeriodActuals: null })],
    'other debts object': [i.plan, i.asOf, Object.assign({}, i.opts, { debts: clone(i.opts.debts) })],
    'representedEvents supplied': [i.plan, i.asOf, Object.assign({}, i.opts, { representedEvents: [] })],
  };
  for (const [name, [plan, asOf, opts]] of Object.entries(cases)) {
    const before = withReuse.counts.cardCoverageState;
    const got = probe(plan, asOf, optsFor(opts));
    assert.strictEqual(withReuse.counts.cardCoverageState, before + 1, `${name}: must compute fresh`);
    assert.notStrictEqual(got, first, `${name}: must not return the holder's object`);
    assert.strictEqual(ser(got), direct(plan, asOf, opts), `${name}: equals a direct computation`);
  }
});

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('cardCoverageState probe reuse: all checks passed');
