'use strict';

// Dale 2026-10-07: exact Lunch Money categorization is household minimum
// confirmation. Observation only: no provider/canonical write, issuer receipt,
// recurrence or financial calculation authority is introduced here.
const Forecast = require('../public/forecast.js');
const crypto = require('crypto');
const SOURCE = 'lunchmoney-minimum-category';
const CATEGORIES = Object.freeze({
  'Minimum payment - Triangle Mastercard': 'triangle',
  'Minimum payment - Amazon Mastercard': 'mbna',
  'Minimum payment - TD Emerald Flex': 'tdcc',
  'Minimum payment - TD Cash Back Visa': 'cashback',
  'Minimum payment - TD Travel Visa': 'travelvisa',
});
const CARD_IDS = new Set(Object.values(CATEGORIES));
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const cents = value => typeof value === 'number' && Number.isFinite(value)
  && Number.isSafeInteger(Math.round(value * 100))
  && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7 ? Math.round(value * 100) : null;

function categoryDebt(category) {
  return category && !category.isIncome && !category.isGroup && !category.archived
    && category.excludeFromBudget === true && category.excludeFromTotals === true
    && typeof category.name === 'string' && Object.hasOwn(CATEGORIES, category.name)
    ? CATEGORIES[category.name] : null;
}

function observe(input) {
  const { plan, accountMap, asOf, transactionWindow: window, pendingCoverage,
    transactions = [], matchesIdentity, matchesReversalIdentity, alreadyAllocated, cycleOpensOn,
    isExplicitlyPosted } = input;
  const packet = { source: SOURCE, asOf, payments: [] };
  if (!iso(asOf) || !window || window.complete !== true || window.hasMore === true
      || window.truncated === true || !iso(window.startDate) || !iso(window.endDate)
      || window.endDate < asOf || pendingCoverage?.complete !== true
      || typeof cycleOpensOn !== 'function') return packet;
  const mapping = tx => (accountMap?.mappings || []).find(m =>
    String(m.providerAccountId) === String(tx.providerAccountId));
  // Work from the current complete observation, never a previous derived packet.
  const schedule = { ...plan, opening: undefined, cardMinimumCategoryEvidence: undefined };
  const events = Forecast.expandEvents(schedule, Forecast.addDays(asOf, -62), Forecast.addDays(asOf, 62));
  const ownerDebits = new Set((plan.obligations || []).flatMap(row =>
    Array.isArray(row.sentPayments) ? row.sentPayments.map(p => p?.debitId).filter(Boolean) : []));
  const verifiedIndependentOwnerDebitIds = [];
  for (const row of plan.obligations || []) for (const owner of Array.isArray(row.sentPayments) ? row.sentPayments : []) {
    if (owner?.confirmed !== true || owner.pending !== false || owner.currency !== 'cad'
        || !/^[a-f0-9]{64}$/.test(owner.debitId || '')) continue;
    const linked = transactions.filter(tx => isExplicitlyPosted?.(tx) === true
      && tx.pending !== true && !tx.contradictoryEvidence && !tx.isGroup && !tx.parentId
      && tx.currency === 'cad' && iso(tx.date) && tx.date <= asOf
      && tx.date >= window.startDate && tx.date <= window.endDate && tx.date === owner.postedOn
      && cents(tx.amount) > 0 && cents(tx.amount) === cents(owner.amount)
      && mapping(tx)?.atlasRole === 'household-cash'
      && mapping(tx)?.canonical?.id === owner.fundingAccountId
      // Owner allocation already names its purpose/card. This verifies only
      // its explicit hash-to-provider movement link, not a new merchant match.
      && crypto.createHash('sha256').update(SOURCE + ':' + tx.providerTransactionId).digest('hex') === owner.debitId);
    if (linked.length === 1) verifiedIndependentOwnerDebitIds.push(owner.debitId);
  }
  const hits = [];
  for (const tx of transactions) {
    const debtId = CARD_IDS.has(tx.minimumCategoryDebt) ? tx.minimumCategoryDebt : null;
    const map = mapping(tx), amount = cents(tx.amount);
    if (!debtId || tx.pending === true || tx.contradictoryEvidence === true
        || tx.isGroup || tx.parentId || tx.currency !== 'cad' || tx.isIncome === true
        || !(amount > 0) || !iso(tx.date) || tx.date > asOf || tx.date < window.startDate
        || tx.date > window.endDate || map?.atlasRole !== 'household-cash'
        || map.canonical?.collection !== 'cash'
        || !['chequing-a', 'chequing-b'].includes(map.canonical.id)
        || /refund|revers|return/i.test(`${tx.payee || ''} ${tx.originalName || ''}`)) continue;
    const debitId = crypto.createHash('sha256').update(SOURCE + ':' + tx.providerTransactionId).digest('hex');
    // Stable identity is consumed once across all owner allocations, not only
    // the occurrence currently selected by the provider lookup window.
    if (ownerDebits.has(debitId) || alreadyAllocated?.(tx)) continue;
    const rows = (plan.obligations || []).filter(r => r.debtId === debtId
      && r.effect === 'payment' && !r.nonCash && r.payingAccount === map.canonical.id
      && (r.sentPayments == null || Array.isArray(r.sentPayments)));
    const compatible = [];
    for (const row of rows) {
      if (!matchesIdentity(tx, row)) continue;
      const debt = (plan.debts || []).find(d => d.id === debtId);
      for (const event of events.filter(e => e.id === row.id && e.kind === 'obligation')) {
        if (tx.date < cycleOpensOn(event.date, debt?.statementCloseDay)
            || tx.date > Forecast.addDays(event.date, 7)) continue;
        const original = event.scheduledDate || event.date;
        // No owner confirmation is overridden or duplicated by provider intent.
        if ((row.sentPayments || []).some(p => p.scheduledDate === original)) continue;
        compatible.push({ row, event, original });
      }
    }
    if (compatible.length !== 1) continue;
    const target = compatible[0];
    if (Forecast.minimumCategoryAllocationConflict(plan, { id: target.row.id, debitId,
      postedOn: tx.date, amount: tx.amount, currency: 'cad', fundingAccountId: map.canonical.id,
      verifiedIndependentOwnerDebitIds })) continue;
    // A posted reversal of this categorized movement withdraws derived proof.
    // A generic purchase refund is not silently interpreted as a payment reversal.
    const reversed = transactions.some(other => other !== tx && other.pending !== true
      && other.currency === 'cad' && iso(other.date) && other.date >= tx.date && other.date <= asOf
      && ((other.minimumCategoryDebt === debtId && other.amount < 0
        && mapping(other)?.canonical?.id === map.canonical.id)
        || (other.amount < 0 && /revers/i.test(`${other.payee || ''} ${other.originalName || ''}`)
          // Several cards share bank aliases. An explicitly resolved different
          // card category outranks that alias for a funding-side return.
          && (!CARD_IDS.has(other.minimumCategoryDebt) || other.minimumCategoryDebt === debtId)
          && mapping(other)?.canonical?.id === map.canonical.id
          && matchesReversalIdentity?.(other, target.row))
        || (/payment.*revers|revers.*payment/i.test(`${other.payee || ''} ${other.originalName || ''}`)
          && mapping(other)?.canonical?.id === debtId)));
    if (reversed) continue;
    hits.push({ tx, map, amount, debitId, ...target });
  }
  for (const hit of hits) {
    const { tx, map, row, original, debitId } = hit;
    // A stable debit cannot confirm several cycles; several debits for one
    // occurrence are ambiguous in this bounded protocol (no guessed allocation).
    if (transactions.filter(t => t.providerTransactionId === tx.providerTransactionId && t.pending !== true).length !== 1
        || hits.filter(h => h.row.id === row.id && h.original === original).length !== 1) continue;
    packet.payments.push({ id: row.id, scheduledDate: original, confirmed: true,
      intent: 'minimum', debitId, postedOn: tx.date, amount: tx.amount,
      currency: 'cad', fundingAccountId: map.canonical.id, pending: false, cashIncludedAsOf: asOf,
      movementIdentity: { source: SOURCE, debitId },
      ...(verifiedIndependentOwnerDebitIds.length ? { verifiedIndependentOwnerDebitIds } : {}) });
  }
  return packet;
}

module.exports = { SOURCE, CATEGORIES, categoryDebt, observe };
