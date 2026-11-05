'use strict';
const assert = require('node:assert/strict');

// These salary-only ledgers have no category IDs. Extend the immutable
// pre-protocol expected report with exactly the declared schema additions;
// never delete actual fields or relax comparison of any historical value.
module.exports = function minimumCategoryExpectation(report, input, historicalObserver) {
  assert.ok(!Object.hasOwn(report, 'cardMinimumCategoryEvidence'),
    'historical baseline predates the minimum category packet');
  const expected = JSON.parse(JSON.stringify(report));
  for (const field of ['transactions', 'collapsedTransactions']) {
    assert.ok(Array.isArray(expected[field]), field + ' remains part of whole-payload conservation');
    for (const tx of expected[field]) {
      assert.equal(tx.categoryId, null, 'salary fixture cannot supply a minimum category ID');
      assert.ok(!Object.hasOwn(tx, 'minimumCategoryDebt'), 'historical transaction predates the new leaf');
      tx.minimumCategoryDebt = null;
      const raw = input.payload.transactions.find(row => String(row.id) === tx.providerTransactionId);
      assert.ok(raw && typeof raw.is_pending === 'boolean', 'salary fixtures explicitly declare their posting status');
      tx.savingsPostingEvidence = raw.is_pending ? 'pending' : 'posted';
    }
  }
  expected.cardMinimumCategoryEvidence = {
    source: 'lunchmoney-minimum-category',
    asOf: historicalObserver.householdFinancialDate(input, report.observations),
    payments: [],
  };
  // Authorized addition (outgoing e-transfer review list): the sanitized
  // packet now stamps an identity boolean on every row and carries the
  // transaction window bounds. These salary-only ledgers contain no
  // SEND E-TFR descriptor, so every expected boolean is exactly false, and
  // the expected window is the report's own normalized window re-stamped
  // in the packet's shape — no historical value is deleted or relaxed.
  const packet = expected.currentPeriodActuals;
  assert.ok(packet && Array.isArray(packet.transactions),
    'current-period packet remains part of whole-report conservation');
  assert.ok(!Object.hasOwn(packet, 'transactionWindow'),
    'historical packet predates the window-bounds leaf');
  for (const tx of packet.transactions) {
    assert.ok(!Object.hasOwn(tx, 'outgoingETransferIdentity'),
      'historical packet row predates the identity boolean');
    tx.outgoingETransferIdentity = false;
  }
  const w = expected.transactionWindow || {};
  packet.transactionWindow = {
    startDate: w.startDate || null,
    endDate: w.endDate || null,
    complete: w.complete === true ? true : w.complete === false ? false : null,
    hasMore: w.hasMore === true ? true : w.hasMore === false ? false : null,
    truncated: w.truncated === true,
  };
  // P1 4253396900 addition: the packet also carries the dates-only
  // unprocessable-candidate list. These ledgers contain no SEND E-TFR
  // descriptor at all, so the exact expectation is the empty list.
  assert.ok(!Object.hasOwn(packet, 'outgoingETransferUnconfirmed'),
    'historical packet predates the outgoing e-transfer unconfirmed leaf');
  packet.outgoingETransferUnconfirmed = [];
  // C1/N2 addition: the packet also carries a per-account sync-evidence qualifier. These
  // salary-only ledgers carry no sync field on any account, so every household account
  // is exactly 'absent' with every field boolean false, and coverage is unaffected.
  assert.ok(!Object.hasOwn(packet, 'syncEvidence'), 'historical packet predates the sync-evidence leaf');
  const syncRoles = new Set(['household-cash', 'household-reserve', 'revolving-credit', 'heloc', 'mortgage']);
  packet.syncEvidence = [];
  for (const account of input.payload.accounts || []) {
    const mapping = input.accountMap.mappings.find(row => String(row.providerAccountId) === String(account.id));
    if (!mapping || !syncRoles.has(mapping.atlasRole) || !(mapping.canonical && mapping.canonical.id)) continue;
    assert.ok(!['last_fetch', 'plaid_last_successful_update', 'status'].some(key => Object.hasOwn(account, key)),
      'salary ledgers declare no sync field');
    packet.syncEvidence.push({ id: String(mapping.canonical.id), role: mapping.atlasRole, syncEvidence: 'absent',
      fields: { last_fetch: false, plaid_last_successful_update: false, status: false } });
  }
  assert.ok(!input.accountMap.mappings.some(row => ['savings', 'savings-dont-touch'].includes(row.canonical?.id)),
    'these salary-only ledgers have no canonical Savings accounts');
  assert.ok(!Object.hasOwn(expected.currentPeriodActuals, 'savingsMovementUnconfirmed'),
    'historical actuals predate the account-scoped Savings provenance leaf');
  expected.currentPeriodActuals.savingsMovementUnconfirmed = [];
  const rawWindow = input.payload.transactionWindow || input.payload.transaction_window || {};
  const originalDate = keys => {
    const values = keys.filter(key => Object.hasOwn(rawWindow, key)).map(key => rawWindow[key]);
    return values.length && values.every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && value === values[0]) ? values[0] : null;
  };
  const sourceWindow = { complete: Object.hasOwn(rawWindow, 'complete') && rawWindow.complete === true
    && ['hasMore', 'has_more', 'truncated'].every(key => !Object.hasOwn(rawWindow, key)
      || rawWindow[key] == null || rawWindow[key] === false),
    startDate: originalDate(['startDate', 'start_date']), endDate: originalDate(['endDate', 'end_date']) };
  assert.ok(!Object.hasOwn(expected.transactionWindow, 'savingsFetchCoverage'));
  assert.ok(!Object.hasOwn(expected.currentPeriodActuals, 'savingsFetchCoverage'));
  expected.currentPeriodActuals.savingsFetchCoverage = sourceWindow;
  expected.transactionWindow.savingsFetchCoverage = sourceWindow;
  for (const row of expected.currentPeriodActuals.transactions) {
    assert.equal(typeof row.pending, 'boolean');
    row.savingsPostingEvidence = row.pending ? 'pending' : 'posted';
  }
  // C1 (Atlas, #847): a row whose date is not a valid calendar date can no longer be scoped, so
  // the observer drops it from the packet exactly as it drops an undated row, and for an
  // account that feeds household figures the period's coverage reads incomplete. The historical
  // baseline kept the row, so the expectation removes exactly those rows and stamps coverage.
  const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    && Number.isFinite(Date.parse(value.slice(0, 10)))
    && new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === value.slice(0, 10);
  const coverageRoles = new Set(['household-cash', 'household-reserve', 'revolving-credit', 'heloc', 'mortgage']);
  const keptRows = [];
  let degraded = false;
  for (const row of expected.currentPeriodActuals.transactions) {
    if (validDay(row.date)) { keptRows.push(row); continue; }
    if (coverageRoles.has(row.accountRole)) degraded = true;
  }
  // Packet-local ids are sequential in the order rows are kept, so removing a row renumbers the rest.
  if (keptRows.length !== expected.currentPeriodActuals.transactions.length) {
    const renumbered = new Map();
    keptRows.forEach((row, i) => {
      assert.match(String(row.id), /^tx-\d+$/, 'packet-local ids are sequential');
      renumbered.set(row.id, 'tx-' + (i + 1));
      row.id = 'tx-' + (i + 1);
    });
    // Represented actuals point at packet-local ids; they follow the renumbering.
    for (const entry of expected.currentPeriodActuals.representedActuals || []) {
      if (entry && renumbered.has(entry.transactionId)) entry.transactionId = renumbered.get(entry.transactionId);
      if (entry && Array.isArray(entry.transactionIds)) {
        entry.transactionIds = entry.transactionIds.map(id => renumbered.has(id) ? renumbered.get(id) : id);
      }
    }
  }
  expected.currentPeriodActuals.transactions = keptRows;
  if (degraded) {
    assert.equal(expected.currentPeriodActuals.transactionCoverage, 'complete', 'historical coverage was complete');
    expected.currentPeriodActuals.transactionCoverage = 'incomplete';
  }
  return expected;
};
