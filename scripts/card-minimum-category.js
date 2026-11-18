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
// A "card payment: <card>" note is evidence only for the TD cards, whose
// issuer receipt is the card's own posted PAYMENT - THANK YOU credit. Triangle
// and MBNA have no card feed and stay To confirm (lead dispatch U4, option A).
const NOTE_CARD_IDS = new Set(['cashback', 'travelvisa', 'tdcc']);
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
    isExplicitlyPosted, coverageReference } = input;
  const packet = { source: SOURCE, asOf, payments: [], disagreements: [] };
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
  // Owner allocations by debit, to compare with the ledger's own link (Grok Bot Q2, Plan #6,
  // 2026-11-17): same debit and occurrence, the owner record wins; a different card or
  // occurrence is a disagreement, so neither counts and the debit reads To confirm.
  const ownerByDebit = new Map();
  for (const row of plan.obligations || []) for (const owner of Array.isArray(row.sentPayments) ? row.sentPayments : []) {
    if (!owner || typeof owner.debitId !== 'string') continue;
    const list = ownerByDebit.get(owner.debitId) || [];
    list.push({ id: row.id, scheduledDate: owner.scheduledDate });
    ownerByDebit.set(owner.debitId, list);
  }
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
    // An exact minimum category is household confirmation (Dale 2026-10-07).
    // Otherwise a note naming exactly one TD card is a candidate, kept only if
    // card coverage pairs it with that card's posted credit (qualifyNotePayments).
    // The category, when present, wins unchanged.
    const noted = Forecast.cardPaymentNoteDestination({ notes: tx.notes });
    const byCategory = CARD_IDS.has(tx.minimumCategoryDebt) ? tx.minimumCategoryDebt : null;
    const byNote = !byCategory && NOTE_CARD_IDS.has(noted) && typeof coverageReference === 'function' ? noted : null;
    const debtId = byCategory || byNote;
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
    const owned = ownerDebits.has(debitId);
    if (!owned && alreadyAllocated?.(tx)) continue;
    const rows = (plan.obligations || []).filter(r => r.debtId === debtId
      && r.effect === 'payment' && !r.nonCash && r.payingAccount === map.canonical.id
      && (r.sentPayments == null || Array.isArray(r.sentPayments)));
    const compatible = [];
    for (const row of rows) {
      // The note names the card; its identity is proved by coverage's pairing.
      if (!byNote && !matchesIdentity(tx, row)) continue;
      const debt = (plan.debts || []).find(d => d.id === debtId);
      for (const event of events.filter(e => e.id === row.id && e.kind === 'obligation')) {
        if (tx.date < cycleOpensOn(event.date, debt?.statementCloseDay)
            || tx.date > Forecast.addDays(event.date, 7)) continue;
        const original = event.scheduledDate || event.date;
        // No owner confirmation is overridden or duplicated by provider intent.
        if (!owned && (row.sentPayments || []).some(p => p.scheduledDate === original)) continue;
        compatible.push({ row, event, original });
      }
    }
    if (owned) {
      // The ledger names exactly one card occurrence for a debit the owner also records: agreement
      // leaves the owner record alone; any other card or occurrence is a disagreement.
      const records = ownerByDebit.get(debitId) || [];
      if (compatible.length === 1 && !(records.length === 1 && records[0].id === compatible[0].row.id
          && records[0].scheduledDate === compatible[0].original)) packet.disagreements.push(debitId);
      continue;
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
    hits.push({ tx, map, amount, debitId, byNote: !!byNote, ...target });
  }
  for (const hit of hits) {
    const { tx, map, row, original, debitId, byNote } = hit;
    // A stable debit cannot confirm several cycles; several debits for one
    // occurrence are ambiguous in this bounded protocol (no guessed allocation).
    if (transactions.filter(t => t.providerTransactionId === tx.providerTransactionId && t.pending !== true).length !== 1
        || hits.filter(h => h.row.id === row.id && h.original === original).length !== 1) continue;
    packet.payments.push({ id: row.id, scheduledDate: original, confirmed: true,
      intent: 'minimum', debitId, postedOn: tx.date, amount: tx.amount,
      currency: 'cad', fundingAccountId: map.canonical.id, pending: false, cashIncludedAsOf: asOf,
      movementIdentity: { source: SOURCE, debitId },
      ...(byNote ? { evidence: 'card-payment-note', coverageRef: coverageReference(tx), debtId: row.debtId } : {}),
      ...(verifiedIndependentOwnerDebitIds.length ? { verifiedIndependentOwnerDebitIds } : {}) });
  }
  return packet;
}

// Keep a note candidate only when card coverage paired that debit, by its
// note, with a posted PAYMENT - THANK YOU credit on the same card; drop the
// internal join fields either way. Category evidence passes unchanged.
function qualifyNotePayments(packet, receipts) {
  if (!packet || !Array.isArray(packet.payments)) return packet;
  const paired = new Set((receipts || []).filter(r => r && r.debitRef && r.card).map(r => r.debitRef + '|' + r.card));
  const payments = [];
  for (const p of packet.payments) {
    if (p?.evidence !== 'card-payment-note') { payments.push(p); continue; }
    const { coverageRef, debtId, ...kept } = p;
    if (coverageRef && paired.has(coverageRef + '|' + debtId)) payments.push(kept);
  }
  return { ...packet, payments };
}

module.exports = { SOURCE, CATEGORIES, NOTE_CARD_IDS, categoryDebt, observe, qualifyNotePayments };
