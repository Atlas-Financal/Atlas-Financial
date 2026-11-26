'use strict';

const assert = require('node:assert/strict');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Memory = require('../scripts/server-observation-memory');
const { world } = require('./fixtures/card-coverage-aggregate-world');
const { loadStackPage } = require('./lib/budget-page-harness');
const { provider, environment } = require('./test-server-observation-memory');

const cardId = 'travelvisa';
const context = { accountMap: 'invented map', categoryMapping: [] };
const householdId = 4021;
const day = '2026-09-20';

function observation(hour, { asOf = day, through = asOf, sync = true, extra = false } = {}) {
  const input = world([['card', 80, '2026-09-18', 'purchase'], ['card', 37, '2026-09-19', 'purchase'],
    ...(extra ? [['card', 12, asOf, 'purchase']] : [])], { asOf, windowStart: '2026-09-18' });
  const { payload } = input;
  Object.assign(payload, { categories: [], tags: [], fetchedAt: `${asOf}T${hour}:00:00Z` });
  payload.pendingCoverage.truncated = false;
  payload.transactionWindow.endDate = through;
  for (const account of payload.accounts) account.last_fetch = payload.fetchedAt;
  if (!sync) delete payload.accounts.find(account => account.id === 3004).last_fetch;
  const { data } = Live.fromObservation(input);
  return { data, evidence: { schema: Memory.SCHEMA, payload }, checkedAt: payload.fetchedAt, input };
}

function publish(memory, { data, evidence, checkedAt }, householdAccountId = householdId) {
  memory.publish('latest-source', evidence, { context, householdAccountId, lastBudgetAccountId: householdAccountId,
    credentialSource: 'env', data, checkedAt });
}

function served(memory, { data, checkedAt }, id = householdId, key = context) {
  return memory.withLastKnownCardActivity(key, id, checkedAt, data);
}

function read(data) {
  const result = Forecast.recommend(data.plan, Forecast.budgetAsOf(data), Forecast.budgetRecommendInputs(data));
  const view = result.payPeriodViews.find(row => row.timelineRole === 'current' || row.role === 'active');
  return { result, view, card: view.stackSummary.credit.lines.find(line => line.id === cardId) };
}

(async () => {
  for (const [name, options] of [['missing sync', { sync: false }], ['short query', { through: '2026-09-19' }]]) {
    const memory = Memory.create();
    const good = observation('18'), thin = observation('19', options);
    publish(memory, good);
    assert.equal(read(served(memory, good)).card.spent.amount, 80 + 37);
    assert.equal(read(thin.data).card.spent.amount, null, name);
    assert.equal(read(served(Memory.create(), thin)).card.spent.amount, null, `${name}: cold display`);

    publish(memory, thin);
    assert.equal(memory.read('latest-source').payload.fetchedAt, thin.checkedAt);
    assert.equal(memory.readDisplay(context).checkedAt, thin.checkedAt, `${name}: publish current evidence separately`);
    const data = served(memory, thin);
    const held = read(data), current = read(thin.data);
    assert.equal(held.card.spent.amount, 80 + 37, `${name}: last supported charges remain visible`);
    assert.equal(held.card.spent.trust, 'estimated', name);
    assert.equal(held.card.activityObservedAt, good.checkedAt, name);
    assert.deepEqual(held.result.paydayAllocation, current.result.paydayAllocation, `${name}: cash permissions and caps`);
    assert.deepEqual(held.card.targetCovered, current.card.targetCovered, `${name}: repayment coverage`);
    assert.deepEqual(held.view.stackSummary.creditBreakdown, current.view.stackSummary.creditBreakdown, `${name}: Credit deductions`);
    const sweeps = result => result.payPeriodViews.map(v => [v.paydaySweep, v.cardMatchingEstimate?.paydaySweep]);
    assert.ok(current.result.payPeriodViews.some(v => Object.hasOwn(v, 'paydaySweep')));
    assert.deepEqual(sweeps(held.result), sweeps(current.result), `${name}: sweeps`);

    if (name === 'missing sync') {
      const page = await loadStackPage({ data });
      assert.equal(page.status(), 'rendered');
      const pageCard = page.sandbox.StackCredit.line(page.context(), cardId);
      assert.equal(pageCard.spent.amount, 117);
      assert.equal(pageCard.spent.trust, 'estimated');
    }

    assert.equal(read(served(memory, thin, householdId + 1)).card.spent.amount, null, `${name}: different household`);
    assert.equal(read(served(memory, thin, householdId, { ...context, accountMap: 'different map' })).card.spent.amount,
      null, `${name}: different account mapping`);
    const otherPeriod = observation('19', { asOf: '2026-10-04', sync: false });
    assert.equal(read(served(memory, otherPeriod)).card.spent.amount, null, `${name}: different period`);

    const newer = observation('20', { extra: true });
    publish(memory, newer);
    assert.equal(read(served(memory, newer)).card.spent.amount, 80 + 37 + 12, `${name}: complete refresh wins`);
    const nextThin = observation('21', { sync: false });
    publish(memory, nextThin);
    assert.equal(read(served(memory, nextThin)).card.spent.amount, 129, `${name}: refreshed amount becomes last known`);
    publish(memory, nextThin, householdId + 1);
    assert.equal(read(served(memory, nextThin, householdId + 1)).card.spent.amount, null, `${name}: new household publish`);
    assert.equal(read(served(memory, nextThin)).card.spent.amount, null, `${name}: old household activity was retired`);
  }

  // Exercise the actual server worker, publication and replay with an invented
  // provider. The short-window branch above supplies the window directly.
  const mock = await provider({ accountId: householdId });
  const Refresh = require('../scripts/server-live-refresh');
  const good = observation('18'), thin = observation('19', { sync: false });
  const canonical = good.input.data;
  const env = { ...environment(mock.base),
    ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify({ ...good.input.accountMap, scope: 'live' }) };
  const now = Date.now;
  try {
    const force = async sample => {
      mock.payload(sample.evidence.payload);
      Date.now = () => Date.parse(sample.checkedAt);
      env.ATLAS_LIVE_OVERLAY_NOW = sample.checkedAt;
      let check;
      const data = await Refresh.serve(canonical, env, { forceRefresh: true, onCheck: value => { check = value; } });
      assert.equal(check.qualified, true, 'the worker earned qualified current source evidence');
      return data;
    };
    assert.equal(read(await force(good)).card.spent.amount, 117);
    assert.equal(read(await force(thin)).card.spent.amount, 117, 'forced refresh serves the held card activity');
    assert.equal(read(await Refresh.serve(canonical, env, { preferObservation: true })).card.spent.amount,
      117, 'ordinary load replaying the thinner source also serves the held activity');
    mock.mode('failure');
    assert.equal(read(await Refresh.serve(canonical, env, { forceRefresh: true })).card.spent.amount,
      117, 'a later failed provider check still renders the held card activity');
  } finally {
    Date.now = now;
    await mock.close();
  }
  console.log('Last known card activity survives thinner observations in the Stack summary');
})().catch(error => { console.error(error); process.exitCode = 1; });
