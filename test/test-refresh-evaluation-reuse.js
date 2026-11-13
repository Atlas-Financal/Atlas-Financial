'use strict';
// Invented provider fixture only. Real observer, overlay, trust and Forecast.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));
const O = require(path.join(root, 'scripts/provider-observe'));
const OA = require(path.join(root, 'scripts/operating-answer'));
const Live = require(path.join(root, 'scripts/live-plan'));
const Fixture = require(path.join(root, 'test/fixtures/budget-surface-data'));
const clone = value => structuredClone(value);
const originalRecommend = F.recommend;
const Memory = require(path.join(root, 'scripts/server-observation-memory'));

function acquisition(t, payload = Fixture.payload()) {
  payload.tags ||= []; // Healthy source metadata is required for replay retention.
  t.mock.method(O, 'loadLiveAccountMap', () => clone(Fixture.map));
  t.mock.method(O, 'resolveLiveCredential', async () => ({ token: 'SYNTHETIC-OFFLINE-NOT-A-CREDENTIAL', source: 'env' }));
  t.mock.method(O, 'fetchLunchMoneyLive', async () => clone(payload));
  for (const name of ['node:http', 'node:https']) {
    t.mock.method(require(name), 'request', () => { throw new Error('unexpected network'); });
  }
}
async function serve(data = Fixture.canonical(), options = {}) {
  let check;
  const result = await Live.applyForServer(data, { ATLAS_LIVE_OVERLAY: 'live' },
    { ...options, onObservation(value) { check = value; } });
  return { data: result, check };
}
function countForecast(t, implementation = originalRecommend) {
  let calls = 0;
  t.mock.method(F, 'recommend', (...args) => { calls++; return implementation(...args); });
  return () => calls;
}

test('qualified fresh read observes twice but evaluates identical Forecast input once', async t => {
  acquisition(t);
  const calls = countForecast(t);
  const observe = t.mock.method(O, 'observe');
  const data = Fixture.canonical(), before = clone(data);
  const result = await serve(data);
  assert.equal(result.data.liveOverlay.applied, true);
  assert.equal(result.check.qualified, true);
  assert(result.check.evidence, 'replay source evidence is still earned');
  assert.equal(observe.mock.calls.length, 2, 'source projection is independently re-observed');
  assert.equal(calls(), 1, 'duplicate refresh-trust Forecast evaluation is eliminated');
  assert.deepEqual(data, before, 'canonical input remains immutable');
  assert.equal(result.data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value, 1215,
    'invented provider Bills stock is preserved, not recalculated by reuse');
});

test('complete served data and qualification equal an uncached evaluation', async t => {
  acquisition(t);
  const optimized = await serve();
  t.mock.method(OA, 'createRefreshEvaluation', () => ({ fromRefreshedState: OA.fromRefreshedState }));
  const calls = countForecast(t);
  const uncached = await serve();
  assert.equal(calls(), 2, 'uncached control really executes both evaluations');
  assert.deepEqual(optimized, uncached, 'compare the complete result and observation check, not selected totals');
});

test('recurring-linked source evidence survives replay without a second Forecast', async t => {
  const data = Fixture.canonical(), payload = Fixture.payload();
  data.plan.budget.categories.push({ id: 'pets', label: 'Invented pet food',
    class: 'essential', plannedPayday: 100, confidence: 'confirmed',
    dogFoodLunchMoneyRecurringIds: ['8801'], dogFoodLunchMoneyCategoryIds: ['88'] });
  payload.categories.push({ id: 88, name: 'Pet supplies', is_income: false });
  payload.transactions.push({ id: 92888, account_id: 1002, date: '2026-08-19',
    amount: 23, currency: 'cad', payee: 'Invented linked supplier', category_id: 88,
    recurring_id: 8801, is_pending: false, status: 'cleared' });
  acquisition(t, payload);
  const calls = countForecast(t), observe = t.mock.method(O, 'observe');
  const optimized = await serve(data);
  const flags = result => result.currentPeriodActuals.transactions
    .filter(row => row.dogFoodLunchMoneyLink === true).map(row => [row.dogFood, row.dogFoodLunchMoneyLink]);
  assert.deepEqual(flags(observe.mock.calls[0].result), [[true, true]],
    'the original provider linkage, not merchant text, earns the existing flags');
  assert.equal(observe.mock.calls.length, 2, 'both complete observations still execute');
  assert.deepEqual(flags(observe.mock.calls[1].result), [[true, true]],
    'projection must not discard evidence consumed by the observer');
  assert.deepEqual(observe.mock.calls[1].result, observe.mock.calls[0].result,
    'the complete independently repeated observation is conserved');
  assert.equal(calls(), 1, 'identical Forecast arguments reuse the first evaluation');
  assert.equal(optimized.check.qualified, true);
  assert(optimized.check.evidence, 'complete replay equality earns retention');
  assert.equal(optimized.check.evidence.payload.transactions.at(-1).recurring_id, 8801);
  assert(!JSON.stringify(optimized.data).includes('recurring_id'), 'raw linkage stays private');
  const retained = await serve(data, { evidence: optimized.check.evidence });
  assert.deepEqual(retained.data, optimized.data, 'retained source recomputes the same complete served data');
  assert.equal(calls(), 2, 'a later read evaluates Forecast afresh, never caches a served response');
  t.mock.method(OA, 'createRefreshEvaluation', () => ({ fromRefreshedState: OA.fromRefreshedState }));
  assert.deepEqual(await serve(data), optimized, 'complete served output and receipt equal independent uncached evaluation');
  assert.equal(calls(), 4, 'uncached control really evaluates both overlays');
});

test('recurring source identity preserves scalar type and absence; arbitrary objects remain refused', () => {
  for (const value of [8801, '8801', null, 0, '']) {
    const payload = { ...Fixture.payload(), tags: [] };
    payload.transactions[0].recurring_id = value;
    const projected = Memory.sourceInputs(payload);
    assert.equal(projected.transactions[0].recurring_id, value);
  }
  const payload = { ...Fixture.payload(), tags: [] };
  assert.equal(Object.hasOwn(Memory.sourceInputs(payload).transactions[0], 'recurring_id'), false);
  for (const value of [{ secret: 'synthetic-private-canary' }, [8801], NaN, Infinity]) {
    payload.transactions[0].recurring_id = value;
    assert.throws(() => Memory.sourceInputs(payload), /observation-input-invalid/);
  }
});

for (const balance of [0, -7.25]) test('zero/negative observations preserve complete output: ' + balance, async t => {
  const payload = Fixture.payload(); payload.accounts.find(a => String(a.id) === '1001').balance = balance;
  acquisition(t, payload);
  const optimized = await serve();
  t.mock.method(OA, 'createRefreshEvaluation', () => ({ fromRefreshedState: OA.fromRefreshedState }));
  assert.deepEqual(optimized, await serve());
});

test('repeated reads and concurrent acquisitions have independent evaluations', async t => {
  acquisition(t);
  const calls = countForecast(t);
  const [a, b] = await Promise.all([serve(), serve()]);
  assert.deepEqual(a, b);
  assert.equal(calls(), 2, 'one Forecast per request, never a cross-request hit');
  await serve();
  assert.equal(calls(), 3, 'a later identical request recomputes');
});

test('changed replay input computes again and cannot retain unequal replay evidence', async t => {
  acquisition(t);
  const observe = O.observe; let observations = 0;
  t.mock.method(O, 'observe', (...args) => {
    const report = observe(...args);
    if (++observations === 2) report.currentPeriodActuals.transactions.push({
      id: 'invented-replay-change', date: '2026-08-20', amount: 2, currency: 'CAD',
      pending: false, atlasAccountId: 'chequing-b', accountRole: 'household-cash',
      displayedPayee: 'Invented changed observation',
    });
    return report;
  });
  const calls = countForecast(t);
  const result = await serve();
  assert.equal(observations, 2);
  assert.equal(calls(), 2, 'changed actuals cannot reuse the primary answer');
  assert.equal(result.check.evidence, null, 'full replay inequality still withholds retention');
});

test('Forecast exceptions are retried and preserve the uncached unknown result', async t => {
  acquisition(t);
  const calls = countForecast(t, () => { throw new Error('invented forecast failure'); });
  const optimized = await serve();
  assert.equal(calls(), 2, 'a thrown evaluation is never cached');
  t.mock.method(OA, 'createRefreshEvaluation', () => ({ fromRefreshedState: OA.fromRefreshedState }));
  assert.deepEqual(optimized, await serve());
  assert.equal(optimized.data.refreshTrust.remainingClaim, 'unavailable');
});

test('incomplete observation retains the same fail-closed response', async t => {
  const payload = Fixture.payload(); payload.pendingCoverage.complete = false;
  acquisition(t, payload);
  const optimized = await serve();
  t.mock.method(OA, 'createRefreshEvaluation', () => ({ fromRefreshedState: OA.fromRefreshedState }));
  assert.deepEqual(optimized, await serve());
  assert.equal(optimized.check.qualified, false);
  assert.equal(optimized.check.evidence, null);
});

function stubAdvice() {
  return { weekly: 12, currentPeriodAction: { remainingClaim: 'complete', coverage: { status: 'complete' } },
    paydayAllocation: { available: 0, obligations: { wanted: 4, allocated: 4, shortfall: 0, items: [{ id: 'invented', amount: 4 }] } } };
}
function evaluationData() {
  const data = Fixture.canonical();
  data.liveOverlay = { applied: true, effectiveAsOf: '2026-08-20', operatingPlan: 'live',
    currentPeriodActuals: { observationAsOf: '2026-08-20', transactions: [] },
    observedCash: { asOf: '2026-08-20', accounts: [] } };
  return data;
}

test('one evaluation snapshots inputs and isolates both returned-result mutations', t => {
  const advice = stubAdvice(), calls = countForecast(t, () => advice);
  const evaluation = OA.createRefreshEvaluation(), data = evaluationData();
  const first = evaluation.fromRefreshedState(data);
  first.protectedObligations.items[0].amount = 999;
  advice.currentPeriodAction.coverage.status = 'mutated';
  const second = evaluation.fromRefreshedState(clone(data));
  assert.equal(second.protectedObligations.items[0].amount, 4);
  assert.equal(second.limitations.coverage.status, 'complete');
  second.limitations.coverage.status = 'changed again';
  assert.equal(evaluation.fromRefreshedState(data).limitations.coverage.status, 'complete');
  assert.equal(calls(), 1);
});

for (const [name, mutate] of [
  ['date', d => { d.liveOverlay.effectiveAsOf = '2026-08-21'; }],
  ['plan', d => { d.plan.income[0].amount++; }],
  ['actuals', d => { d.liveOverlay.currentPeriodActuals.transactions.push({ id: 'invented' }); }],
  ['cash', d => { d.liveOverlay.observedCash.accounts.push({ id: 'invented', value: 0 }); }],
  ['debts', d => { d.debts[0].balance++; }],
  ['funding', d => { d.plan.funding = { options: [{ id: 'invented', amount: 0 }] }; }],
  ['extra', d => { d.revolvingExtra.push({ id: 'invented', amount: 0 }); }],
  ['buffer', d => { d.plan.defaults.targetBuffer++; }],
  ['trust', d => { d.liveOverlay.operatingPlan = 'unavailable'; }],
]) test('changed full input misses without mutating stored input: ' + name, t => {
  const calls = countForecast(t, stubAdvice);
  const evaluation = OA.createRefreshEvaluation(), data = evaluationData();
  evaluation.fromRefreshedState(data);
  mutate(data);
  evaluation.fromRefreshedState(data);
  assert.equal(calls(), 2);
});

test('freshly loaded periods participate in exact input matching', t => {
  const fs = require('node:fs'), read = fs.readFileSync;
  let version = 1;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    return String(file).endsWith('periods.json') ? JSON.stringify({ version }) : Reflect.apply(read, this, [file, ...args]);
  });
  const calls = countForecast(t, stubAdvice), evaluation = OA.createRefreshEvaluation(), data = evaluationData();
  evaluation.fromRefreshedState(data);
  version++;
  evaluation.fromRefreshedState(data);
  assert.equal(calls(), 2);
});

test('failed or uncloneable evaluations do not become reusable answers', t => {
  let fail = true;
  const calls = countForecast(t, () => { if (fail) throw new Error('invented'); return stubAdvice(); });
  const evaluation = OA.createRefreshEvaluation(), data = evaluationData();
  assert.throws(() => evaluation.fromRefreshedState(data), /invented/);
  fail = false; evaluation.fromRefreshedState(data);
  assert.equal(calls(), 2);
  data.plan.diagnosticCallback = () => {};
  evaluation.fromRefreshedState(data); evaluation.fromRefreshedState(data);
  assert.equal(calls(), 4, 'uncloneable input falls back to normal Forecast calls');
});

test('a Forecast that mutates its input cannot create a reusable entry', t => {
  const calls = countForecast(t, plan => { plan.diagnostic = (plan.diagnostic || 0) + 1; return stubAdvice(); });
  const evaluation = OA.createRefreshEvaluation(), data = evaluationData();
  evaluation.fromRefreshedState(data); evaluation.fromRefreshedState(data);
  assert.equal(calls(), 2);
});

test('uncloneable answers are returned normally and never reused', t => {
  const calls = countForecast(t, () => ({ ...stubAdvice(), unsupported: () => {} }));
  const evaluation = OA.createRefreshEvaluation(), data = evaluationData();
  evaluation.fromRefreshedState(data); evaluation.fromRefreshedState(data);
  assert.equal(calls(), 2);
});

test('one-entry retention replaces a changed input and does not retain an exception', t => {
  let fail = false;
  const calls = countForecast(t, () => { if (fail) throw new Error('invented'); return stubAdvice(); });
  const evaluation = OA.createRefreshEvaluation(), a = evaluationData(), b = clone(a);
  b.plan.defaults.targetBuffer++;
  evaluation.fromRefreshedState(a); evaluation.fromRefreshedState(b); evaluation.fromRefreshedState(a);
  assert.equal(calls(), 3, 'A/B/A recomputes; this is not a growing cache');
  fail = true; assert.throws(() => evaluation.fromRefreshedState(b), /invented/);
  fail = false; evaluation.fromRefreshedState(a);
  assert.equal(calls(), 5, 'failure cleared the earlier successful entry');
});

test('replacing the Forecast implementation cannot reuse an earlier answer', t => {
  const evaluation = OA.createRefreshEvaluation(), data = evaluationData();
  const first = t.mock.method(F, 'recommend', stubAdvice);
  evaluation.fromRefreshedState(data);
  const second = t.mock.method(F, 'recommend', () => ({ ...stubAdvice(), weekly: 23 }));
  assert.equal(evaluation.fromRefreshedState(data).currentSpendingPermission.weekly, 23);
  assert.equal(first.mock.calls.length, 1); assert.equal(second.mock.calls.length, 1);
});

test('ordinary projectors and differing mode remain independently evaluated', t => {
  const calls = countForecast(t, stubAdvice), data = evaluationData();
  OA.fromRefreshedState(data); OA.fromRefreshedState(data);
  assert.equal(calls(), 2);
  const evaluation = OA.createRefreshEvaluation();
  evaluation.fromRefreshedState(data); evaluation.fromRefreshedState(data, { mode: 'canonical' });
  assert.equal(calls(), 4);
});

test('null and NaN cash collide in JSON text but remain distinct evaluation inputs', t => {
  const calls = countForecast(t, (_plan, _asOf, options) => ({
    ...stubAdvice(), paydayAllocation: { available: options.observedCash.accounts[0].value },
  }));
  const evaluation = OA.createRefreshEvaluation(), data = evaluationData();
  data.liveOverlay.observedCash.accounts = [{ id: 'invented', value: null }];
  const before = JSON.stringify(data);
  assert.equal(evaluation.fromRefreshedState(data).moneyAvailable.value, null);
  data.liveOverlay.observedCash.accounts[0].value = NaN;
  assert.equal(JSON.stringify(data), before, 'a JSON-string key would collide');
  assert(Number.isNaN(evaluation.fromRefreshedState(data).moneyAvailable.value),
    'the native numeric distinction reaches the independent producer');
  assert.equal(calls(), 2);
});

test('advice simOptions aliases cannot poison retained advice or bind a hit to old options', t => {
  let produced;
  const calls = countForecast(t, (_plan, _asOf, options) => {
    produced = { ...stubAdvice(), simOptions: options,
      currentPeriodAction: { remainingClaim: 'complete', coverage: options.currentPeriodActuals.coverage },
      paydayAllocation: { protectedPath: options.fundingSources[0] } };
    return produced;
  });
  const evaluation = OA.createRefreshEvaluation(), data = evaluationData();
  data.plan.funding = { options: [{ id: 'invented', amount: 3 }] };
  data.liveOverlay.currentPeriodActuals.coverage = { status: 'complete', nested: { count: 1 } };
  const equalInput = clone(data);
  evaluation.fromRefreshedState(data);
  assert.equal(produced.simOptions.fundingSources, data.plan.funding.options, 'control has caller references');
  produced.simOptions.fundingSources[0].amount = 999;
  produced.simOptions.currentPeriodActuals.coverage.nested.count = 999;
  const hit = evaluation.fromRefreshedState(equalInput);
  assert.equal(hit.futureCostProtection.protectedPath.amount, 3);
  assert.equal(hit.limitations.coverage.nested.count, 1);
  assert.notEqual(hit.limitations.coverage, produced.simOptions.currentPeriodActuals.coverage);
  hit.limitations.coverage.nested.count = 444;
  assert.equal(evaluation.fromRefreshedState(equalInput).limitations.coverage.nested.count, 1);
  assert.equal(calls(), 1, 'equal detached input reuses a detached snapshot, not old caller references');
});

test('MCP packet options still receive their own Forecast evaluation', async t => {
  acquisition(t);
  const calls = countForecast(t);
  const served = await serve();
  assert.equal(calls(), 1);
  const Assistant = require(path.join(root, 'scripts/assistant-packet'));
  Assistant.buildPacket({ data: served.data, env: {}, now: Fixture.payload().fetchedAt });
  assert.equal(calls(), 2, 'the packet builder is outside the per-refresh evaluation');
});
