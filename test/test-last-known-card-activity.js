'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const threads = require('node:worker_threads');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Memory = require('../scripts/server-observation-memory');
const { world } = require('./fixtures/card-coverage-aggregate-world');
const { loadStackPage } = require('./lib/budget-page-harness');
const { provider, environment } = require('./test-server-observation-memory');
const { buildFiguresSnapshot } = require('../scripts/figures-snapshot');

const cardId = 'travelvisa';
const context = { accountMap: 'invented map', categoryMapping: [] };
const householdId = 4021;
const day = '2026-09-20';
const utility = 'Invented utility';
const utilityId = 'invented-card-proof-utility';
const receiptIdentity = { rules: [{ eventId: utilityId, payeePattern: utility,
  atlasAccountId: 'chequing-a', direction: 'debit' }], billPaymentPayees: [] };

// LivePlan's timing and identity inputs are invented in the worker too.
const periodsPath = path.resolve(__dirname, '../public/periods.json');
const identityPath = require('../scripts/provider-observe').DEFAULT_IDENTITY;
const readFile = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  if (file === periodsPath) return JSON.stringify({ monthly: [] });
  if (!threads.isMainThread && file === identityPath) return JSON.stringify(receiptIdentity);
  return readFile(file, ...args);
};

function observation(hour, { asOf = day, through = asOf, sync = true, extra = false,
  payingDebit = false, receipts = null } = {}) {
  const edited = receipts === 'edited';
  const input = world([['card', 80, '2026-09-18', 'purchase', { id: 88101 }],
    ['card', 37, '2026-09-19', 'purchase', { id: 88102 }],
    ...(payingDebit ? [['bills', 17, asOf, 'cash', { notes: 'card payment: Travel Visa' }]] : []),
    ...(receipts ? [
      ['bills', 25, asOf, 'cash', { id: 88103, category_name: edited ? 'Groceries' : 'Credit Card Payment',
        payee: edited ? 'Invented edited payer' : 'TFR-TO C/C', notes: edited ? null : 'card payment: Travel Visa' }],
      ['bills', 16, asOf, 'purchase', { id: 88104, payee: edited ? 'Invented renamed utility' : utility,
        original_name: null, category_name: 'Utilities' }],
    ] : []),
    ...(extra ? [['card', 12, asOf, 'purchase', { id: 88105 }]] : [])], { asOf, windowStart: '2026-09-18' });
  if (receipts) {
    input.data.plan.bills = [{ id: utilityId, label: utility, frequency: 'monthly', day: 20,
      amount: 16, confidence: 'confirmed', payee: utility }];
    input.identity = receiptIdentity;
  }
  const { payload } = input;
  Object.assign(payload, { categories: [], tags: [], fetchedAt: `${asOf}T${hour}:00:00Z` });
  payload.pendingCoverage.truncated = false;
  payload.transactionWindow.endDate = through;
  for (const account of payload.accounts) account.last_fetch = payload.fetchedAt;
  if (!sync) delete payload.accounts.find(account => account.id === 3004).last_fetch;
  const { data } = Live.fromObservation(input);
  return { data, evidence: { schema: Memory.SCHEMA, payload }, checkedAt: payload.fetchedAt, input };
}

function publish(memory, { data, evidence, checkedAt }, householdAccountId = householdId, activity = Forecast.cardActivityForDisplay(data)) {
  memory.publish('latest-source', evidence, { context, householdAccountId, lastBudgetAccountId: householdAccountId,
    credentialSource: 'env', data, checkedAt }, undefined, activity);
}

function served(memory, { data, checkedAt }, id = householdId, key = context) {
  return memory.withLastKnownCardActivity(key, id, checkedAt, data);
}

function read(data) {
  const result = Forecast.recommend(data.plan, Forecast.budgetAsOf(data), Forecast.budgetRecommendInputs(data));
  const view = result.payPeriodViews.find(row => row.timelineRole === 'current' || row.role === 'active');
  return { result, view, card: view.stackSummary.credit.lines.find(line => line.id === cardId) };
}

if (threads.isMainThread) (async () => {
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
    assert.equal(held.card.target.amount, 117, `${name}: target belongs to the retained charges`);
    assert.equal(held.card.stillToPayBack.amount, 117, `${name}: remainder belongs to the retained charges`);
    assert.equal(held.card.paidBack.amount, 0, `${name}: the retained ledger had no paying-side debit`);
    for (const field of ['spent', 'target', 'stillToPayBack', 'paidBack']) {
      assert.equal(held.card[field].trust, 'estimated', `${name}: ${field} has dated trust`);
    }
    assert.equal(held.card.activityObservedAt, good.checkedAt, name);
    assert.deepEqual(held.result.paydayAllocation, current.result.paydayAllocation, `${name}: cash permissions and caps`);
    assert.deepEqual(held.result.plannedDebt, current.result.plannedDebt, `${name}: extra debt`);
    assert.equal(held.result.weekly, current.result.weekly, `${name}: weekly cap`);
    assert.deepEqual(held.result.currentPeriodAction, current.result.currentPeriodAction, `${name}: operating action`);
    assert.deepEqual(held.view.stackSummary.surplus, current.view.stackSummary.surplus, `${name}: Surplus and Credit deduction`);
    assert.equal(held.view.stackSummary.creditBreakdown?.total, current.view.stackSummary.creditBreakdown?.total,
      `${name}: Credit deduction total`);
    const dropdown = held.view.stackSummary.creditBreakdown?.rows.find(row => row.debtId === cardId);
    assert.equal(dropdown?.amount, 117, `${name}: dropdown agrees with the card`);
    assert.equal(dropdown?.trust, 'estimated', name);
    const sweeps = result => result.payPeriodViews.map(v => [v.paydaySweep, v.cardMatchingEstimate?.paydaySweep]);
    assert.ok(current.result.payPeriodViews.some(v => Object.hasOwn(v, 'paydaySweep')));
    assert.deepEqual(sweeps(held.result), sweeps(current.result), `${name}: sweeps`);

    const page = await loadStackPage({ data });
    assert.equal(page.status(), 'rendered');
    const sheet = page.sandbox.StackSheet.html(page.context(), `card:${cardId}`);
    assert.match(sheet, /<dt>New charges<\/dt><dd[^>]*><span class="">\$117<\/span>/);
    assert.match(sheet, /<dt>Target<\/dt><dd[^>]*><span class="">\$117<\/span>/);
    assert.doesNotMatch(sheet, /Not yet known/);
    assert.match(page.blockHtml('credit'), /data-stack-sheet="card:travelvisa"[^]*?\/ \$117/);
    assert.match(page.blockHtml('waterfall'), /data-debt-id="travelvisa"[^]*?stackSummary\.creditBreakdown\.rows\.\d+\.amount">\$117/);

    const spentKey = `period.${held.view.start}.stackCard.${cardId}.spent`;
    const snapshot = buildFiguresSnapshot(data, []);
    assert.equal(snapshot[spentKey], 117, `${name}: figures snapshot sees what the Stack prints`);
    assert.equal(snapshot[spentKey + 'Trust'], 'estimated', name);
    assert.equal(buildFiguresSnapshot(thin.data, [])[spentKey], null, `${name}: cold snapshot has no retained figure`);

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

  {
    const memory = Memory.create();
    const good = observation('18'), thin = observation('19', { sync: false, payingDebit: true });
    publish(memory, good);
    publish(memory, thin);
    assert.equal(read(thin.data).card.paidBack.amount, 17, 'the latest payer debit is known to the current calculation');
    assert.equal(read(served(memory, thin)).card.paidBack.amount, 0, 'display keeps the earlier payer amount with its target');
    const unsupported = observation('20');
    const activity = Forecast.cardActivityForDisplay(unsupported.data);
    const lastCard = activity.cards.find(card => card.id === cardId);
    lastCard.paidBack = { amount: null, trust: 'unavailable', reasons: [] };
    publish(memory, unsupported, householdId, activity);
    const nextThin = observation('21', { sync: false });
    publish(memory, nextThin);
    assert.equal(read(served(memory, nextThin)).card.spent.amount, null,
      'a newer known charge reading without coherent repayment does not revive an older card or mix readings');
  }

  // The same worker must keep both receipt proofs in its current evidence
  // while selecting the earlier card line for display only.
  const good = observation('18', { receipts: 'original' });
  const thin = observation('19', { sync: false, receipts: 'edited' });
  const next = observation('20', { extra: true, receipts: 'edited' });
  const mock = await provider({ accountId: householdId });
  const canonical = good.input.data;
  const env = { ...environment(mock.base), ATLAS_LIVE_OVERLAY_NOW: good.checkedAt,
    ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify({ ...good.input.accountMap, scope: 'live' }) };
  const now = Date.now;
  const Worker = threads.Worker;
  const exits = [];
  let clock = good.checkedAt;
  Date.now = () => Date.parse(clock);
  // Advance the worker's clock without changing the server's job key.
  threads.Worker = class extends Worker {
    constructor(file, options) {
      super(file, { ...options, env: { ...options.env, ATLAS_LIVE_OVERLAY_NOW: clock },
        execArgv: [...process.execArgv, '--require', __filename] });
      exits.push(new Promise(resolve => this.once('exit', resolve)));
    }
  };
  try {
    const Refresh = require('../scripts/server-live-refresh');
    const force = async sample => {
      mock.payload(sample.evidence.payload);
      clock = sample.checkedAt;
      let check;
      const data = await Refresh.serve(canonical, env, { forceRefresh: true, onCheck: value => { check = value; } });
      assert.equal(check.qualified, true, 'the worker earned qualified current source evidence');
      return data;
    };
    const cold = read(thin.data);
    assert.equal(cold.card.paidBack.amount, 0, 'the edited payer needs an earlier proof');
    assert.equal(cold.view.stackSummary.bills.paid, 0, 'the renamed bill needs an earlier proof');
    const initial = read(await force(good));
    assert.deepEqual([initial.card.spent.amount, initial.card.paidBack.amount, initial.view.stackSummary.bills.paid], [117, 25, 16]);

    function assertThin(data) {
      const actuals = structuredClone(data);
      delete actuals.liveOverlay.lastKnownCardActivity;
      const current = read(actuals);
      assert.deepEqual([current.card.spent.amount, current.card.paidBack.amount, current.view.stackSummary.bills.paid],
        [null, 25, 16], 'the qualified source preserves both receipts independently of the display');
      const held = read(data);
      assert.deepEqual([held.card.spent.amount, held.card.target.amount, held.card.paidBack.amount, held.card.stillToPayBack.amount],
        [117, 117, 25, 92]);
      assert.equal(held.card.activityObservedAt, good.checkedAt);
    }

    assertThin(await force(thin));
    const reads = mock.calls.length;
    assertThin(await Refresh.serve(canonical, env, { preferObservation: true }));
    assert.equal(mock.calls.length, reads, 'source replay does not fetch the provider again');
    mock.mode('failure');
    assert.equal(read(await Refresh.serve(canonical, env, { forceRefresh: true })).card.spent.amount,
      117, 'a later failed provider check still renders the held card activity');
    mock.mode('ok');
    const complete = read(await force(next));
    assert.deepEqual([complete.card.spent.amount, complete.card.stillToPayBack.amount, complete.view.stackSummary.bills.paid],
      [129, 104, 16], 'the next complete refresh advances the dated picture and keeps the receipts');
    assert.equal(complete.card.activityObservedAt, undefined);
  } finally {
    Date.now = now;
    threads.Worker = Worker;
    await mock.close();
    await Promise.all(exits);
  }
  console.log('Last known card activity survives thinner observations in the Stack summary');
})().catch(error => { console.error(error); process.exitCode = 1; });
