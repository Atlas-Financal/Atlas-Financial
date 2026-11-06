'use strict';
// Savings R1: household-external rows may omit account aliases in the daily
// savings funding transaction loop, and only that explicit role may. External
// rows stay external: they add no household cash, savings stock or transfer
// credit, and every other identity / evidence / safety gate is unchanged.
// Synthetic, independently invented ledgers only; no household/provider data.
// Run: node --test test/test-savings-daily-external-alias-contract.js
const assert = require('node:assert/strict');
const test = require('node:test');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const { fixture, transfer, clone } = require('./fixtures/savings-daily-allocation-contract');

const ALIAS_REASON = 'Transaction account aliases are missing or contradictory.';
const IDENTITY_REASON = 'A transaction has unavailable date, currency, amount or account identity.';
const PURPOSE_REASON = 'A cash location has contradictory or unconfigured household purpose.';
const DUPLICATE_REASON = 'Repeated transaction identity has contradictory evidence.';
const TRANSFER_REASON = 'A pending or unmatched household transfer/cash movement remains encumbering.';
const COVERAGE_REASON = 'Explicit complete current-cycle cash and transaction evidence is required.';
const PAST_REASON = 'Unpaid past requirements remain protected until evidenced settlement.';

function run(input) {
  const before = JSON.stringify(input);
  const out = F.savingsDailyFunding(input.plan, input.debts || [], input.asOf, input.opts);
  assert.equal(JSON.stringify(input), before, 'savingsDailyFunding never mutates its inputs');
  assert.equal(out.source, 'Forecast.savingsDailyFunding');
  return out;
}
const txs = input => input.opts.currentPeriodActuals.transactions;
// Exactly the shape scripts/provider-observe.js emits for an external mapping:
// atlasAccountId/account null, no accountId key, lowercase provider currency.
function externalRow(overrides = {}) {
  return { id: 'ext-1', date: '2026-10-04', amount: 12.34, pending: false, currency: 'cad',
    accountRole: 'household-external', atlasAccountId: null, account: null,
    categoryLabel: 'Shopping', kindHint: null, excludeFromTotals: false, ...overrides };
}
function withRow(row, input = fixture()) { txs(input).push(row); return input; }
function withheld(out, reason) {
  assert.equal(out.status, 'unavailable');
  assert.equal(out.period.status, 'unavailable');
  assert.equal(out.period.availableNow, null);
  assert.equal(out.period.proposal, null);
  if (reason) assert.equal(out.reason, reason);
}
function sameAsBase(out, base) {
  assert.equal(out.status, 'ready');
  assert.notEqual(out.reason, ALIAS_REASON);
  // Status, period proposal, lenses and the growing-savings timeline rows are
  // byte-identical to what base publishes for the same ledger without the
  // external row (i.e. base minus the withhold).
  assert.deepEqual(out, base);
}

test('1. explicit external row with null aliases is no longer withheld; output identical to base', () => {
  const base = run(fixture());
  assert.equal(base.status, 'ready');
  assert.equal(base.period.availableNow, 80);
  for (const aliases of [
    { atlasAccountId: null, account: null },
    { atlasAccountId: null, account: null, accountId: null },
    { atlasAccountId: '', account: '', accountId: '' },
    { atlasAccountId: undefined, account: undefined },
  ]) {
    const row = externalRow(); Object.assign(row, aliases);
    if (aliases.atlasAccountId === undefined) { delete row.atlasAccountId; delete row.account; }
    sameAsBase(run(withRow(row)), base);
  }
  // Same for a debit, a credit and a pending external row.
  sameAsBase(run(withRow(externalRow({ amount: -45.5 }))), base);
  sameAsBase(run(withRow(externalRow({ pending: true }))), base);
});

test('2. missing aliases still fail for household-cash, household-reserve and revolving-credit', () => {
  for (const role of ['household-cash', 'household-reserve', 'revolving-credit']) {
    for (const blank of [null, '', undefined]) {
      const row = externalRow({ accountRole: role, atlasAccountId: blank, account: blank, accountId: blank });
      withheld(run(withRow(row)), ALIAS_REASON);
    }
  }
});

test('3. an external row claiming a canonical chequing or savings id still fails', () => {
  for (const id of ['chequing-a', 'chequing-b', 'savings', 'savings-dont-touch']) {
    for (const key of ['atlasAccountId', 'accountId', 'account']) {
      withheld(run(withRow(externalRow({ atlasAccountId: null, account: null, [key]: id }))), PURPOSE_REASON);
    }
  }
});

test('4. contradictory present aliases still fail for every role', () => {
  for (const role of ['household-cash', 'household-reserve', 'revolving-credit', 'household-external']) {
    for (const [a, b, c] of [['acct-x', 'acct-y', null], ['acct-x', null, 'acct-y'], [null, 'acct-x', 'acct-y'], ['acct-x', 0, null]]) {
      withheld(run(withRow(externalRow({ accountRole: role, atlasAccountId: a, accountId: b, account: c }))), ALIAS_REASON);
    }
  }
  // Pre-existing behaviour: a falsy-but-present alias is not "absent".
  withheld(run(withRow(externalRow({ atlasAccountId: 0 }))), ALIAS_REASON);
  withheld(run(withRow(externalRow({ account: false }))), ALIAS_REASON);
});

test('5. date, currency, amount, id, duplicate-ID and role checks are kept for null-alias external rows', () => {
  for (const [name, edit] of [
    ['missing id', { id: null }], ['empty id', { id: '' }],
    ['invalid date', { date: '2026-13-40' }], ['missing date', { date: null }], ['future date', { date: '2026-10-06' }],
    ['missing currency', { currency: null }], ['foreign currency', { currency: 'usd' }],
    ['missing amount', { amount: null }], ['non-numeric amount', { amount: 'twelve' }],
    ['unmapped role', { accountRole: 'unmapped' }], ['heloc role', { accountRole: 'heloc' }],
    ['missing role', { accountRole: undefined }], ['near-miss role', { accountRole: 'household_external' }],
  ]) {
    assert.equal(run(withRow(externalRow(edit))).reason, IDENTITY_REASON, name);
  }
  // Duplicate provider identity: an exact repeat counts once; a contradictory repeat withholds.
  const base = run(fixture());
  const repeat = withRow(externalRow()); txs(repeat).push(externalRow());
  sameAsBase(run(repeat), base);
  const contradictory = withRow(externalRow()); txs(contradictory).push(externalRow({ amount: 99 }));
  withheld(run(contradictory), DUPLICATE_REASON);
  // An external row may not reuse a household row's id with different evidence.
  withheld(run(withRow(externalRow({ id: 'food-1' }))), DUPLICATE_REASON);
});

test('6. external rows add no household cash, savings stock or transfer credit', () => {
  const base = run(transfer(fixture(), 30));
  assert.equal(base.status, 'ready');
  for (const amount of [-500, 500, -30, 30]) {
    const out = run(withRow(externalRow({ amount, date: '2026-10-05' }), transfer(fixture(), 30)));
    sameAsBase(out, base);
    assert.equal(out.stock.amount, base.stock.amount, 'savings stock unchanged');
    assert.equal(out.period.transferred, 30, 'transfer credit unchanged');
    assert.equal(out.period.currentCash, base.period.currentCash, 'household cash unchanged');
    assert.equal(out.period.alreadySavedIncome, base.period.alreadySavedIncome, 'no saved-income credit');
    assert.equal(out.period.entitlement, base.period.entitlement, 'no entitlement credit');
  }
  // An external inflow cannot be claimed as an income receipt that already landed in savings.
  const income = fixture(); txs(income).push(externalRow({ id: 'ext-income', amount: -200, date: '2026-10-02', isIncome: true }));
  income.opts.currentPeriodActuals.representedActuals[0].transactionId = 'ext-income';
  // It cannot reconcile as household receipt evidence, so funding fails closed.
  withheld(run(income), 'Native received income does not reconcile to the complete posted receipt evidence.');
});

test('7. real provider-observe packet -> Forecast: external null-alias row withheld before, published after', () => {
  const map = { mappings: [
    { providerAccountId: '1001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
    { providerAccountId: '1002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
    { providerAccountId: '1003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-reserve' },
    { providerAccountId: '1004', canonical: { collection: 'cash', id: 'savings-dont-touch' }, atlasRole: 'household-reserve' },
    { providerAccountId: '9001', atlasRole: O.EXTERNAL_LIVE_ROLE },
  ] };
  const report = withExternal => ({
    fetchedAt: '2026-10-05T18:00:00.000Z',
    transactionWindow: { startDate: '2026-10-02', endDate: '2026-10-05', complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
    collapsedTransactions: [
      { date: '2026-10-02', amount: -200, pending: false, savingsPostingEvidence: 'posted', isIncome: true, currency: 'cad', payee: 'Invented payroll',
        originalName: 'Invented payroll', categoryLabel: 'Income', providerAccountId: '1001', providerTransactionId: 'p-income' },
      { date: '2026-10-03', amount: 20, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', payee: 'Invented grocer',
        originalName: 'Invented grocer', categoryLabel: 'Groceries', providerAccountId: '1001', providerTransactionId: 'p-food' },
    ].concat(withExternal ? [{ date: '2026-10-04', amount: 12.34, pending: false, currency: 'cad',
      payee: 'Invented outside merchant', originalName: 'Invented outside merchant', categoryLabel: 'Shopping',
      providerAccountId: '9001', providerTransactionId: 'p-ext' }] : []),
    representedEventCandidates: [{ id: 'payroll', date: '2026-10-02', observedAmount: 200, providerTransactionId: 'p-income' }],
  });
  const forecastFor = withExternal => {
    const input = fixture();
    const packet = O.sanitizedCurrentPeriodActuals(report(withExternal), { asOf: input.asOf, plan: input.plan, accountMap: map });
    assert.ok(O.currentPeriodActualsLooksSanitized(packet));
    assert.equal(packet.transactionCoverage, 'complete');
    assert.equal(packet.pendingCoverage, 'complete');
    input.opts.currentPeriodActuals = packet;
    return { packet, out: run(input) };
  };
  const without = forecastFor(false);
  assert.equal(without.out.status, 'ready', 'observer packet without the external row publishes');
  const withExt = forecastFor(true);
  const ext = withExt.packet.transactions.filter(tx => tx.accountRole === 'household-external');
  assert.equal(ext.length, 1, 'the real observer emits the external row');
  assert.equal(ext[0].atlasAccountId, null, 'observer sets atlasAccountId null for external');
  assert.equal(ext[0].account, null, 'observer sets account null for external');
  assert.ok(!ext[0].accountId, 'observer emits no accountId for external');
  // Pre-fix this returned unavailable with ALIAS_REASON; post-fix it is the base publication.
  sameAsBase(withExt.out, without.out);
  assert.equal(withExt.out.period.availableNow, 80);
  assert.equal(withExt.out.period.proposal, 80);
});

test('8. the unmatched-transfer guard is not bypassed for external or household rows', () => {
  // A null-alias external row that looks like an internal transfer still encumbers.
  withheld(run(withRow(externalRow({ kindHint: 'transfer', originalMerchant: 'ZZ999 TFR-FR Invented', excludeFromTotals: true, amount: -50 }))), TRANSFER_REASON);
  withheld(run(withRow(externalRow({ internalTransferIdentity: true, amount: 50 }))), TRANSFER_REASON);
  // A one-legged household transfer still encumbers even with an external row present.
  const oneLeg = withRow(externalRow());
  const legs = transfer(fixture(), 30).opts.currentPeriodActuals.transactions.slice(-2);
  txs(oneLeg).push(legs[0]);
  oneLeg.plan.startingCash.breakdown[0].value -= 30;
  withheld(run(oneLeg), TRANSFER_REASON);
  // A pending household-cash movement still encumbers.
  withheld(run(withRow({ ...clone(txs(fixture())[1]), id: 'food-pending', pending: true }, withRow(externalRow()))), TRANSFER_REASON);
  // A matched pair with an external row present still counts once.
  const paired = withRow(externalRow(), transfer(fixture(), 30));
  assert.equal(run(paired).period.transferred, 30);
});

test('9. the undated-requirement gate and other safety gates are unchanged with an external row present', () => {
  const undated = withRow(externalRow());
  undated.plan.commitments.push({ id: 'undated-protected', label: 'Invented undated obligation',
    when: 'TBD', amount: 1000, confidence: 'confirmed', adjustable: false });
  const out = run(undated);
  assert.equal(out.period.status, 'ready'); assert.equal(out.period.availableNow, 0);
  const past = withRow(externalRow());
  past.plan.commitments.push({ id: 'past', label: 'Invented past cost', date: '2026-10-04', amount: 15, confidence: 'confirmed', adjustable: false });
  withheld(run(past), PAST_REASON);
  const incomplete = withRow(externalRow()); incomplete.opts.currentPeriodActuals.transactionCoverage = 'truncated';
  withheld(run(incomplete), COVERAGE_REASON);
  const pendingIncomplete = withRow(externalRow()); pendingIncomplete.opts.currentPeriodActuals.pendingCoverage = 'partial';
  withheld(run(pendingIncomplete), COVERAGE_REASON);
  const missingBill = withRow(externalRow()); delete missingBill.plan.bills[0].amount;
  // S1 repair (PR #620 blocker 3): an unamounted bill now makes the
  // native Budget period basis itself unavailable (the waterfall load
  // is unknown, not zero), so the funding builder withholds at its
  // basis gate with this reason instead of the later bill-amount gate.
  // The withhold outcome is unchanged.
  withheld(run(missingBill), 'The native Budget period basis is unavailable.');
  const floor = withRow(externalRow()); floor.plan.defaults.targetBuffer = 50;
  withheld(run(floor), 'Known operating cash on 2026-10-29 cannot preserve the existing cash/card floor.');
});
