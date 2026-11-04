'use strict';
/* Forecast-owned posted card movement reporting. No DOM, cash/debt walk,
 * minimum allocation, balance write or provider fetch. Forecast supplies the
 * incumbent date/cents/classification/parent primitives below. */
(function init(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ForecastCardPeriod = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi() {
  const cardIdentities = [['travelvisa', 'Travel'], ['cashback', 'Cash Back'], ['tdcc', 'Emerald'],
    ['triangle', 'Triangle'], ['mbna', 'Amazon Mastercard']];
  function publish(input, primitives) {
    const { date, cents, skipParent, classify } = primitives;
    // PA-4a-2a: read coverage evidence with Forecast's one strict rule, so this
    // publication agrees with the reconciliation it reports.
    const covered = typeof primitives.coverageComplete === 'function'
      ? primitives.coverageComplete : value => value === 'complete';
    const { plan, debts, asOf, window, packet, balanceEvidence, overlay, paymentAllocations } = input;
    // HELOC is the owner's existing revolving facility. Use the same native
    // movement and endpoint evidence; its recorded balance is never a net.
    const identities = (debts || []).some(row => row?.id === 'heloc')
      ? cardIdentities.concat([['heloc', 'HELOC']]) : cardIdentities;
    const start = window?.start, end = window?.end;
    const role = date(start) && date(end) && date(asOf)
      ? start > asOf ? 'future' : end < asOf ? 'past' : 'current' : 'unknown';
    const through = role === 'future' ? null : role === 'past' ? end : asOf;
    const windowKnown = input.windowQualified === true && date(start) && date(end) && start <= end && date(asOf);
    const ledgerValid = Array.isArray(packet?.transactions);
    const rows = ledgerValid ? packet.transactions : [];
    const packetCurrent = packet?.schema === 'atlas-current-period-actuals/v1' && packet.observationAsOf === asOf;
    // PA-4a-2a: no coverage label without valid, ordered coverage bounds.
    const boundsValid = !!(date(packet?.coverageStart) && date(packet?.coverageThrough)
      && packet.coverageStart <= packet.coverageThrough);
    const coverage = packetCurrent && ledgerValid && covered(packet.transactionCoverage)
      && date(packet.coverageStart) && date(packet.coverageThrough)
      && packet.coverageStart <= start && packet.coverageThrough >= through;
    const known = new Set(identities.map(([id]) => id));
    const movementRole = tx => tx?.accountRole === 'revolving-credit' || tx?.accountRole === 'heloc';
    const duplicateCards = new Set();
    const aliasCards = new Set();
    const owners = new Map();
    const mark = (set, ids) => ids.forEach(id => { if (known.has(id)) set.add(id); });
    const remember = (map, key, aliases, pending, requireCrossCard) => {
      const prev = map.get(key);
      if (!prev) { map.set(key, { aliases: aliases.slice(), pending }); return; }
      const crossCard = aliases.some(id => !prev.aliases.includes(id)) || prev.aliases.some(id => !aliases.includes(id));
      if (!requireCrossCard || crossCard || prev.pending !== pending) {
        mark(duplicateCards, prev.aliases.concat(aliases));
        aliases.forEach(id => { if (!prev.aliases.includes(id)) prev.aliases.push(id); });
      }
    };
    // Date eligibility does not prove source independence. Register native
    // identities before amount/date slicing so a malformed, pre-window or
    // post-through counterpart still withholds the affected cards.
    for (const tx of rows) {
      if (!tx || !movementRole(tx)) continue;
      const aliases = [];
      if (tx.atlasAccountId != null && String(tx.atlasAccountId) !== '') aliases.push(String(tx.atlasAccountId));
      if (tx.account != null && String(tx.account) !== '' && String(tx.account) !== aliases[0])
        aliases.push(String(tx.account));
      if (aliases.length > 1) mark(aliasCards, aliases);
      if (tx.id != null && String(tx.id) !== '') remember(owners, 'id:' + String(tx.id), aliases, tx.pending === true, false);
      if (typeof tx.coverageRef === 'string' && tx.coverageRef.trim())
        remember(owners, 'ref:' + tx.coverageRef.trim(), aliases, tx.pending === true, true);
    }
    // Unknown identity can conceal a card movement; mapped rows remain useful.
    const unmapped = rows.some(tx => tx && (tx.accountRole === 'unmapped'
      || movementRole(tx) && (!known.has(tx.atlasAccountId || tx.account)
        || (tx.accountRole === 'heloc') !== ((tx.atlasAccountId || tx.account) === 'heloc'))));
    const balancePacket = balanceEvidence?.schema === 'atlas-card-period-balance-evidence/v1'
      && balanceEvidence.currency === 'CAD' && balanceEvidence.start === start
      && balanceEvidence.through === through && balanceEvidence.asOf === asOf ? balanceEvidence : null;
    const endpoint = (point, day, claim) => point && point.confirmed === true
      && point.currency === 'CAD' && cents(point.amount, true) !== null
      && point.date === day && date(point.date) && point.temporalClaim === claim
      && typeof point.evidenceRef === 'string' && point.evidenceRef.trim().length > 0;
    const safeMoney = tx => tx?.coverageCurrencyConflict !== true && tx?.currencySettlementUnconfirmed !== true
      && typeof tx?.currency === 'string' && tx.currency.trim().toLowerCase() === 'cad' ? cents(tx.amount, true) : null;
    const pointFact = point => point ? { amount: cents(point.amount, true) === null ? null : point.amount,
      date: date(point.date) ? point.date : null, temporalClaim: point.temporalClaim || null } : null;
    const cards = identities.map(([id, label]) => {
      const issues = [];
      const card = { id, label, status: role === 'future' ? 'not-observed' : 'unavailable',
        netChange: { amount: null, magnitude: null, direction: null, trust: 'unavailable', completeness: 'unavailable' },
        opening: null, closing: null, reportedBalance: null, posted: [], pending: [],
        postedCoverage: coverage ? 'complete-provider-response' : 'incomplete',
        pendingCoverage: role !== 'current' ? 'not-observed' : packetCurrent && ledgerValid && boundsValid && covered(packet.pendingCoverage) ? 'complete-provider-response' : 'unavailable',
        manualStatement: id === 'triangle' || id === 'mbna', reasons: issues };
      const debt = (debts || []).find(row => row?.id === id);
      // Preserve the actual observation date; never retime a manual balance.
      const observed = (overlay?.overlays || []).find(row => row?.locator === 'debts:' + id
        && row.field === 'balance' && cents(row.proposedValue, true) !== null
        && cents(row.proposedValue, true) === cents(debt?.balance, true)
        && date(row.evidenceDate) && row.evidenceDate <= asOf);
      if (role === 'current' && debt && cents(debt.balance, true) !== null) card.reportedBalance = {
        amount: debt.balance, date: date(observed?.evidenceDate) ? observed.evidenceDate
          : date(debt.evidenceDate) ? debt.evidenceDate : null,
        status: date(observed?.evidenceDate) || date(debt.evidenceDate) ? 'dated' : 'date-unavailable' };
      if (!windowKnown) { issues.push('selected-period-unavailable'); return card; }
      if (role === 'future') { issues.push('future-not-observed'); return card; }
      if (!packetCurrent) issues.push('observation-unavailable');
      if (!coverage) issues.push('posted-coverage-incomplete');
      if (unmapped) issues.push('unmapped-card-identity');
      if (duplicateCards.has(id)) issues.push('duplicate-identity');
      if (aliasCards.has(id)) issues.push('unmapped-card-identity');
      if ((packet?.cardCoverageUnconfirmed || []).length || (packet?.currencyUnconfirmed || []).length)
        issues.push('transaction-evidence-unconfirmed');
      const seen = new Set();
      let total = 0;
      for (const tx of rows) {
        if (!tx || (tx.atlasAccountId || tx.account) !== id
          || tx.accountRole !== (id === 'heloc' ? 'heloc' : 'revolving-credit')) continue;
        if (!date(tx.date)) { issues.push('transaction-date-unqualified'); continue; }
        if (tx.date < start || tx.date > through) continue;
        if (tx.pendingPostedAmbiguous === true || tx.pendingPostedDuplicate === true || tx.contradictoryEvidence === true)
          issues.push('transaction-evidence-unconfirmed');
        if (tx.isGroup === true) {
          if (skipParent(tx, packet)) continue;
          issues.push('parent-coverage-unqualified');
          continue;
        }
        const value = safeMoney(tx);
        const classification = classify(tx, plan, packet);
        // The spending classifier calls any signed credit a refund. That is
        // not proof of its transaction type: prefer explicit native identity,
        // and leave an unlabelled credit unconfirmed instead of guessing.
        const hint = typeof tx.kindHint === 'string' ? tx.kindHint.trim().toLowerCase() : '';
        const kind = ['payment', 'card-payment', 'bill-payment'].includes(hint) || tx.cardPaymentIdentity === true ? 'payment'
          : hint === 'refund' ? 'refund'
          : id === 'heloc' && hint === 'interest' || classification?.kind === 'interest' ? 'interest'
          : value != null && value < 0 ? 'credit-unconfirmed'
          : ['spend', 'bill', 'savings-item'].includes(classification?.kind) ? 'charge' : 'movement-unconfirmed';
        const published = { id: tx.id == null ? null : String(tx.id), date: tx.date,
          payee: typeof tx.displayedPayee === 'string' ? tx.displayedPayee : 'Card transaction',
          amount: value == null ? null : value / 100, magnitude: value == null ? null : Math.abs(value) / 100,
          direction: value == null ? null : value > 0 ? 'up' : value < 0 ? 'down' : 'flat',
          kind, pending: tx.pending === true };
        const allocation = paymentAllocations?.get(tx.coverageRef);
        if (id !== 'heloc' && (allocation || kind === 'payment' || kind === 'credit-unconfirmed')) {
          // Diagnostic proof is local to these exact legs. Unknown legacy
          // opening or another card does not erase an observed allocation.
          // Pending/replacement/duplicate and incomplete-window evidence cannot
          // turn a recorded purpose into a confirmed posted match.
          const qualified = allocation?.status === 'reconciled' && !published.pending
            && packetCurrent && coverage && covered(packet.pendingCoverage)
            && published.id && value !== null && !duplicateCards.has(id) && !aliasCards.has(id)
            && !tx.pendingPostedAmbiguous && !tx.pendingPostedDuplicate && !tx.contradictoryEvidence;
          published.paymentAllocation = qualified ? allocation : {
            status: 'unreconciled', kind: allocation?.kind || kind,
            reason: allocation?.status === 'unreconciled' ? allocation.reason
              : kind === 'credit-unconfirmed' ? 'credit-type-or-purpose-unconfirmed' : 'payment-intent-or-evidence-unconfirmed',
            backfill: null, cardPayment: null, otherPurpose: null, purchases: [] };
        }
        if (!published.id) issues.push('transaction-identity-unqualified');
        else if (seen.has(published.id)) issues.push('duplicate-identity');
        else seen.add(published.id);
        if (published.pending) {
          if (role === 'current') card.pending.push(published);
          continue;
        }
        card.posted.push(published);
        if (value == null) { issues.push('transaction-amount-unqualified'); continue; }
        total += value;
        if (!Number.isSafeInteger(total)) issues.push('movement-total-overflow');
      }
      card.posted.sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
      card.pending.sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
      const pointRows = Array.isArray(balancePacket?.cards) ? balancePacket.cards.filter(row => row?.id === id) : [];
      const points = pointRows.length === 1 ? pointRows[0] : null;
      if (pointRows.length > 1) issues.push('endpoint-identity-conflict');
      card.opening = endpoint(points?.opening, start, 'before-period-posted-movements') ? pointFact(points.opening) : null;
      card.closing = endpoint(points?.closing, through, 'through-published-posted-coverage') ? pointFact(points.closing) : null;
      if (!points?.opening) issues.push('opening-unavailable');
      else if (!endpoint(points.opening, start, 'before-period-posted-movements')) issues.push('opening-unqualified');
      if (!points?.closing) issues.push('closing-unavailable');
      else if (!endpoint(points.closing, through, 'through-published-posted-coverage')) issues.push('closing-unqualified');
      if (points?.opening?.evidenceRef === points?.closing?.evidenceRef && points?.opening) issues.push('endpoint-identity-conflict');
      if (!issues.length) {
        const change = cents(points.closing.amount, true) - cents(points.opening.amount, true);
        if (!Number.isSafeInteger(change) || change !== total) issues.push('balance-ledger-discrepancy');
        else {
          card.status = 'ready';
          card.netChange = { amount: change / 100, magnitude: Math.abs(change) / 100,
            direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat', trust: 'calculated', completeness: 'complete' };
        }
      }
      card.reasons = [...new Set(issues)];
      return card;
    });
    return { schema: 'atlas-card-period-movements/v1', source: 'Forecast.cardPeriodMovements', currency: 'CAD',
      asOf: date(asOf) ? asOf : null, start: date(start) ? start : null, end: date(end) ? end : null,
      through: date(through) ? through : null, role, cards,
      observationAsOf: date(packet?.observationAsOf) ? packet.observationAsOf : null,
      semantics: 'Posted liability movement, not spending-only totals, available cash, payment instructions or minimum settlement.' };
  }
  return { publish };
});
