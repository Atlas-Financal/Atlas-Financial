'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const threads = require('node:worker_threads');
const Live = require('../scripts/live-plan');
const Observe = require('../scripts/provider-observe');
const { world } = require('./fixtures/card-coverage-aggregate-world');
const { loadStackPage } = require('./lib/budget-page-harness');

const date = '2026-09-20';
const original = 'Invented utility';
const renamed = { payee: 'Invented new display name', notes: 'Invented memo' };
const identity = { rules: [{ eventId: 'lamp', payeePattern: original,
  atlasAccountId: 'chequing-a', direction: 'debit' }], billPaymentPayees: [] };
const settled = [16, 16, 200, 689];
const unlinked = [0, 16, 216, 673];

function input(attrs = {}, pendingCopy) {
  const bill = (changes) => ['bills', 16, date, 'purchase', {
    id: 105, payee: original, original_name: null, category_name: 'Utilities', ...changes,
  }];
  return world([
    ['card', 80, '2026-09-19', 'purchase', { id: 101, original_name: 'Invented grocer' }],
    ['bills', 25, date, 'cash', { id: 104, notes: 'card payment: Travel Visa', original_name: 'TFR-TO C/C' }],
    bill(attrs),
    ...(pendingCopy ? [bill({ is_pending: true, ...pendingCopy })] : []),
  ], { edit(x) {
    const { plan } = x.data;
    x.identity = identity;
    x.payload.tags = [];
    x.payload.categories = [];
    x.payload.pendingCoverage.truncated = false;
    x.payload.accounts.forEach(a => { a.last_fetch = date + 'T17:00:00Z'; });
    for (const [account, opening] of [[3001, 500], [3002, 0]]) {
      const debits = x.payload.transactions.filter(t => t.account_id === account && t.is_pending === false);
      x.payload.accounts.find(a => a.id === account).balance = opening - debits.reduce((sum, t) => sum + t.amount, 0);
    }
    x.payload.accounts[3].balance = 517;
    plan.budget.categories.push({ id: 'fuel', label: 'Fuel', from: ['Fuel'], class: 'essential',
      plannedPayday: 50, confidence: 'confirmed' });
    plan.bills = [{ id: 'lamp', label: original, frequency: 'monthly', day: 20,
      amount: 16, confidence: 'confirmed', payee: original }];
    plan.obligations.push({ id: 'mortgage', label: 'Invented mortgage', debtId: 'mortgage', effect: 'payment',
      frequency: 'once', date: '2026-09-24', amount: 95, confidence: 'confirmed', payingAccount: 'chequing-a' });
  } });
}

async function rendered(data, expected) {
  const page = await loadStackPage({ data });
  assert.equal(page.status(), 'rendered');
  const view = page.context().recommendation.payPeriodViews.find(v => v.start === page.selectedKey());
  const { bills, surplus } = view.stackSummary;
  assert.deepEqual([bills.paid, surplus.terms.bills, view.budgetHold, surplus.amount], expected);
  const [paid, scheduled, budget, remainder] = expected;
  const cards = page.blockHtml('cards').match(/<details\b[^>]*data-stack-card="bills"[\s\S]*?<\/details>/)?.[0];
  assert.match(cards, new RegExp(`data-stack-card="bills"[^>]*>[\\s\\S]*?\\$${paid}<i> / \\$${scheduled}</i>`));
  const waterfall = page.blockHtml('waterfall');
  assert.match(waterfall, new RegExp(`data-source="budgetHold">\\$${budget}<`));
  assert.match(waterfall, new RegExp(`data-source="stackSummary\\.surplus\\.amount">\\+\\$${remainder}<`));
}

async function observationCases() {
  const first = Live.fromObservation(input());
  // Independent fixture arithmetic: income 1105 less Bills 16, Budget 200,
  // mortgage 95 and Credit 105 leaves 689. The renamed $16 debit is that same bill.
  await rendered(first.data, settled);
  const fresh = Live.fromObservation(input(renamed));
  await rendered(fresh.data, unlinked);
  const refresh = (x, previous = first) => Live.fromObservation({ ...x,
    priorPostedBillReceipts: previous.report.postedBillReceipts });
  const refreshed = refresh(input(renamed));
  await rendered(refreshed.data, settled);
  const receipt = refreshed.report.obligationReconciliationReceipt.occurrences.find(row => row.id === 'lamp');
  assert.equal(receipt?.settlement, 'represented');
  await rendered(refresh(input({ ...renamed, payee: 'Invented second display edit' }), refreshed).data, settled);
  await rendered(refresh(input({ ...renamed, amount: 17 })).data, [0, 16, 217, 672]);
  await rendered(refresh(input({ ...renamed, account_id: 3002 })).data, unlinked);
  await rendered(refresh(input({ ...renamed, date: '2026-09-19' })).data, unlinked);
  await rendered(refresh(input({ ...renamed, id: 106 })).data, unlinked);
  for (const changes of [{ category_name: 'Transfer' }, { notes: 'item: Invented other bill' },
    { notes: 'card payment: Travel Visa' }, { recurring_id: 84 }, { original_name: 'Different bank descriptor' },
    { currency: 'usd' }, { exclude_from_budget: true }, { is_split_parent: true }]) {
    const contradicted = refresh(input({ ...renamed, ...changes }));
    assert.equal(contradicted.report.currentPeriodActuals.representedActuals.some(row => row.id === 'lamp'), false);
    await rendered(refresh(input(renamed), contradicted).data, unlinked);
  }
  const pending = Live.fromObservation(input({ is_pending: true }));
  assert.equal(pending.report.postedBillReceipts, undefined);
  await rendered(refresh(input({ ...renamed, id: 106 }, {}), pending).data, unlinked);
  for (const id of [105, 106]) {
    const prior = { plaid_metadata: { transaction_id: 'invented-pending' } };
    const linked = { id, plaid_metadata: { transaction_id: 'invented-posted', pending_transaction_id: 'invented-pending' } };
    await rendered(refresh(input({ ...linked, ...renamed }, prior), pending).data, unlinked);
    await rendered(refresh(input(linked, prior), pending).data, settled);
  }
  const mixed = input({ id: 106, ...renamed, plaid_metadata: { pending_transaction_id: 'invented-pending' } },
    { plaid_metadata: { transaction_id: 'invented-pending' } });
  mixed.identity = { ...identity, rules: [...identity.rules, { ...identity.rules[0],
    payeePattern: 'Invented second merchant', originalNamePattern: 'Invented bank descriptor' }] };
  await rendered(refresh(mixed, pending).data, unlinked);
  console.log('  PASS  posted receipt continuity, conflicting evidence and pending replacements through Stack');
}

async function archiveCase() {
  const History = require('../scripts/private-period-history');
  const before = Live.fromObservation(input());
  const next = input(renamed);
  const archive = History.capture({ ...next, accountMap: { ...next.accountMap, scope: 'live' }, periods: [],
    priorPostedBillReceipts: before.report.postedBillReceipts }, { now: () => new Date(next.payload.fetchedAt) });
  await rendered(archive.content.evidence.refreshedData, settled);
  assert.deepEqual(History.replayPublication(archive), archive.content.publication);
  assert.doesNotMatch(JSON.stringify(archive), /priorPostedBillReceipts|postedBillReceipts/);
  console.log('  PASS  period capture uses the served linkage while the receipt key stays in memory');
}

async function refreshCases() {
  const before = input();
  const after = input(renamed);
  let payload = before.payload, householdAccountId = 701, reads = 0;
  const provider = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    const url = new URL(req.url, 'http://127.0.0.1');
    reads++;
    const pending = url.searchParams.get('is_pending') === 'true';
    const body = {
      '/v2/me': { id: 1, account_id: householdAccountId },
      '/v2/plaid_accounts': { plaid_accounts: payload.accounts },
      '/v2/manual_accounts': { manual_accounts: [] },
      '/v2/categories': { categories: [] },
      '/v2/tags': { tags: [] },
      '/v2/transactions': { transactions: payload.transactions.filter(tx => !pending || tx.is_pending), has_more: false },
    }[url.pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body || {}));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const env = {
    ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
      .filter(name => process.env[name]).map(name => [name, process.env[name]])),
    ATLAS_LIVE_OVERLAY: 'live', ATLAS_LIVE_OVERLAY_NOW: before.payload.fetchedAt,
    ATLAS_LUNCHMONEY_API_BASE: `http://127.0.0.1:${provider.address().port}/v2`,
    LUNCHMONEY_ACCESS_TOKEN: 'INVENTED-READ-CANARY',
    ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify({ ...before.accountMap, scope: 'live' }),
  };
  const now = Date.now;
  const Worker = threads.Worker;
  const workers = [];
  Date.now = () => Date.parse(before.payload.fetchedAt);
  threads.Worker = class extends Worker {
    constructor(filename, options) {
      super(filename, { ...options, execArgv: ['--require', __filename] });
      workers.push(new Promise(resolve => this.once('exit', resolve)));
    }
  };
  try {
    const Refresh = require('../scripts/server-live-refresh');
    const force = () => Refresh.serve(before.data, env, { forceRefresh: true });
    await rendered(await force(), settled);
    payload = after.payload;
    await rendered(await force(), settled);
    const fetched = reads;
    const replay = await Refresh.serve(before.data, env, { preferObservation: true });
    assert.equal(reads, fetched, 'replay retained the same posted match without a provider request');
    await rendered(replay, settled);
    assert.equal(JSON.stringify(replay).includes('postedBillReceipts'), false, 'receipt proof stays server-side');
    householdAccountId++;
    await rendered(await force(), unlinked);
    householdAccountId--;
    await rendered(await force(), unlinked);
    console.log('  PASS  live worker refresh and replay retain posted proof only for the attested budget');
  } finally {
    Date.now = now;
    threads.Worker = Worker;
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await Promise.all(workers);
  }
}

if (!threads.isMainThread) {
  // Worker preload: inject invented rules into the production observation path.
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => file === Observe.DEFAULT_IDENTITY ? JSON.stringify(identity) : read(file, ...args);
} else {
  observationCases().then(archiveCase).then(refreshCases).catch(error => { console.error(error); process.exitCode = 1; });
}
