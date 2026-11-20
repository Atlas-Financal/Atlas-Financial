'use strict';
/* Forecast-owned posted card movement reporting. No DOM, cash/debt walk,
 * minimum allocation, balance write or provider fetch. Forecast supplies the
 * incumbent date/cents/classification/parent primitives below. */
(function init(root, factory) {
  const api = factory(typeof module !== 'undefined' && module.exports && typeof require === 'function'
    ? require('./display-name') : root.DisplayName);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ForecastCardPeriod = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi(DisplayName) {
  const BALANCE_VERDICTS = ['stale', 'current', 'not-assessed', 'undated', 'after-as-of'];
  const cardIdentities = [['travelvisa', 'Travel'], ['cashback', 'Cash Back'], ['tdcc', 'Emerald'],
    ['triangle', 'Triangle'], ['mbna', 'Amazon Mastercard']];
  function publish(input, primitives) {
    const { date, cents, addDays, skipParent, classify } = primitives;
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
        ...(id !== 'heloc' ? { postedMovement: { amount: null, magnitude: null, direction: null,
          trust: 'unavailable', completeness: 'unavailable', reasons: issues } } : {}),
        opening: null, closing: null, reportedBalance: null, posted: [], pending: [],
        postedCoverage: coverage ? 'complete-provider-response' : 'incomplete',
        pendingCoverage: role !== 'current' ? 'not-observed' : packetCurrent && ledgerValid && boundsValid && covered(packet.pendingCoverage) ? 'complete-provider-response' : 'unavailable',
        manualStatement: id === 'triangle' || id === 'mbna', reasons: issues };
      const debt = (debts || []).find(row => row?.id === id);
      // Preserve the actual observation date; never retime a manual balance.
      const observations = Array.isArray(overlay?.overlays) ? overlay.overlays : [];
      const observed = observations.find(row => row?.locator === 'debts:' + id
        && row.field === 'balance' && cents(row.proposedValue, true) !== null
        && cents(row.proposedValue, true) === cents(debt?.balance, true)
        && date(row.evidenceDate) && row.evidenceDate <= asOf);
      if (role === 'current' && debt && cents(debt.balance, true) !== null) card.reportedBalance = {
        amount: debt.balance, date: date(observed?.evidenceDate) ? observed.evidenceDate
          : date(debt.evidenceDate) ? debt.evidenceDate : null,
        status: date(observed?.evidenceDate) || date(debt.evidenceDate) ? 'dated' : 'date-unavailable' };
      // Forecast's verdict on this snapshot's own published date rides with it:
      // 'stale', 'current', 'not-assessed', 'undated' or 'after-as-of' (never
      // decided here).
      const verdict = card.reportedBalance && typeof primitives.balanceFreshness === 'function'
        ? primitives.balanceFreshness(debt, card.reportedBalance.date) : null;
      if (verdict && BALANCE_VERDICTS.includes(verdict.status)) card.reportedBalance.freshness =
        verdict.status === 'stale' ? { status: 'stale', balanceAsOf: date(verdict.balanceAsOf) ? verdict.balanceAsOf : null,
          cycleStart: verdict.cycleStart || null } : { status: verdict.status };
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
      const postingIssues = [];
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
        if (tx.pending !== false && tx.pending !== true
          || tx.savingsPostingEvidence !== (tx.pending ? 'pending' : 'posted'))
          postingIssues.push('posting-evidence-unqualified');
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
          payee: typeof tx.displayedPayee === 'string' ? tx.displayedPayee : id === 'heloc' ? 'Transaction' : 'Card transaction',
          // Display only: the item text of an "item:" note, shown instead of
          // the payee. Present only when there is one; `payee` is unchanged
          // and nothing here reads the field.
          ...(DisplayName && DisplayName.itemName(tx) ? { displayName: DisplayName.itemName(tx) } : {}),
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
      // Owner 2026-11-13: the card face reports posted activity so far, not
      // closing minus opening. Keep endpoint reconciliation below independent.
      // Positive account sync evidence is required for this new claim: an
      // empty manual ledger or a balance date cannot establish a known zero.
      // Sync age remains informational under the 2026-11-10 owner rule; the
      // current observation, query coverage and explicit failures are gates.
      if (id !== 'heloc') {
        const gaps = issues.concat(postingIssues);
        // Revised A1 (2026-11-14): preserve known dated evidence at any age.
        // This producer supplies a BALANCE observation date, not a per-card
        // successful-sync instant or a transaction-through watermark. A MATCH
        // with no overlay row, or a canonical fallback date, cannot supply it.
        const ownDates = observations.filter(row => row?.locator === 'debts:' + id && row.field === 'balance');
        // Refusal metadata has no value to bind its date to the shown balance.
        // It cannot substitute for this matching dated observation.
        const ownDate = overlay?.applied === true && ownDates.length === 1 && ownDates[0] === observed
          ? observed.evidenceDate : null;
        if (!ownDate) gaps.push('account-date-evidence-unavailable');
        const query = packet?.transactionWindow;
        if (role !== 'current') gaps.push('current-period-not-observed');
        if (!covered(query) || query?.hasMore !== false || query?.truncated !== false
          || !date(query?.startDate) || !date(query?.endDate)
          || query.startDate !== packet?.coverageStart || query.endDate !== packet?.coverageThrough)
          gaps.push('declared-query-incomplete');
        if (!covered(packet?.pendingCoverage)) gaps.push('pending-coverage-incomplete');
        const sync = Array.isArray(packet?.syncEvidence) ? packet.syncEvidence.filter(row => row?.id === id) : [];
        if (sync.length !== 1 || sync[0].role !== 'revolving-credit' || sync[0].syncEvidence !== 'proven'
          || sync[0].reason || !(sync[0].fields?.last_fetch === true || sync[0].fields?.plaid_last_successful_update === true))
          gaps.push('account-transaction-evidence-unavailable');
        if (!Array.isArray(packet?.cardCoverageUnconfirmed) || !Array.isArray(packet?.currencyUnconfirmed))
          gaps.push('transaction-evidence-unconfirmed');
        if (rows.some(tx => !tx || typeof tx !== 'object' || Array.isArray(tx) || typeof tx.accountRole !== 'string'))
          gaps.push('transaction-evidence-unconfirmed');
        const refs = new Set();
        for (const tx of rows) {
          if (!tx || tx.atlasAccountId !== id && tx.account !== id) continue;
          if (tx.accountRole !== 'revolving-credit') gaps.push('unmapped-card-identity');
          if (!date(tx.date) || tx.date < start || tx.date > through || skipParent(tx, packet)) continue;
          if (typeof tx.coverageRef !== 'string' || !tx.coverageRef.trim() || refs.has(tx.coverageRef))
            gaps.push('transaction-identity-unqualified');
          refs.add(tx.coverageRef);
        }
        card.postedMovement = gaps.length ? { amount: null, magnitude: null, direction: null,
          trust: 'unavailable', completeness: 'unavailable', reasons: [...new Set(gaps)] }
          : { amount: total / 100, magnitude: Math.abs(total) / 100,
            direction: total > 0 ? 'up' : total < 0 ? 'down' : 'flat',
            observation: { kind: 'provider-balance', date: ownDate, showDate: ownDate < addDays(asOf, -1) },
            trust: 'calculated', completeness: 'complete', reasons: [] };
      }
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
  // Stack Wallet A6 (lead dispatch, 2026-11-19): per card, in one pay period,
  // how much was paid onto the card against how much was spent on it. A pure
  // reading of one publish() result: posted rows only (the card ledger is
  // posted-only), the same kinds publish() assigns, no amount or date
  // heuristic. A figure that cannot be stated is null with a reason, never 0.
  // Each figure carries a trust word: 'calculated', 'estimated' (a payment
  // whose source the card ledger has not reconciled), or 'unavailable'.
  const STACK_TRUST_ORDER = ['calculated', 'estimated', 'unavailable'];
  // An unrecognised trust word is the weakest there is ('unavailable'), never silently dropped from the comparison.
  const weakest = (...words) => STACK_TRUST_ORDER[Math.max(...words.map(w => (STACK_TRUST_ORDER.includes(w) ? STACK_TRUST_ORDER.indexOf(w) : STACK_TRUST_ORDER.length - 1)))];
  // A covered check counts as covered only on evidence Forecast stands behind: a published true whose trust is calculated or
  // estimated. 'unavailable' (or any other word) is not covered.
  const COVERED_TRUST = ['calculated', 'verified', 'estimated'];
  const coveredOn = line => line.minimumCovered.value === true && COVERED_TRUST.includes(line.minimumCovered.trust);
  function stackCards(publication) {
    const pub = publication && publication.source === 'Forecast.cardPeriodMovements'
      && publication.currency === 'CAD' && Array.isArray(publication.cards) ? publication : null;
    if (!pub) return null;
    const figure = (amount, trust, reasons) => amount == null
      ? { amount: null, trust: 'unavailable', reasons: [...new Set(reasons)] }
      : { amount, trust, reasons: [...new Set(reasons)] };
    return pub.cards.filter(card => card && card.id !== 'heloc').map(card => {
      const rows = (Array.isArray(card.posted) ? card.posted : []).map(row => ({ ...row, pending: false }))
        .concat((Array.isArray(card.pending) ? card.pending : []).map(row => ({ ...row, pending: true })));
      const transactions = rows.map(row => ({ date: row.date, name: row.displayName || row.payee,
        amount: row.amount, kind: row.kind, payment: row.kind === 'payment', pending: row.pending }))
        .sort((a, b) => a.date.localeCompare(b.date) || (a.pending === b.pending ? 0 : a.pending ? 1 : -1));
      const movement = card.postedMovement;
      const gaps = movement && movement.trust === 'calculated' && movement.completeness === 'complete'
        ? [] : (movement && Array.isArray(movement.reasons) && movement.reasons.length ? movement.reasons : ['posted-movement-unavailable']);
      let paidCents = 0, spentCents = 0;
      const paidReasons = [], spentReasons = [];
      let paidTrust = 'calculated';
      for (const row of card.posted || []) {
        const value = typeof row.amount === 'number' && Number.isFinite(row.amount) ? Math.round(row.amount * 100) : null;
        if (value == null) { paidReasons.push('transaction-amount-unqualified'); spentReasons.push('transaction-amount-unqualified'); continue; }
        if (row.kind === 'payment') {
          paidCents += -value;
          // A payment the card ledger has not reconciled (or carries no
          // allocation at all) is estimated; only a reconciled one is calculated.
          if (!row.paymentAllocation || row.paymentAllocation.status !== 'reconciled') {
            paidTrust = 'estimated'; paidReasons.push('card-payment-unconfirmed');
          }
        } else if (row.kind === 'charge' || row.kind === 'interest' || row.kind === 'refund') spentCents += value;
        else if (row.kind === 'credit-unconfirmed') {
          paidReasons.push('card-credit-purpose-unconfirmed'); spentReasons.push('card-credit-purpose-unconfirmed');
        } else spentReasons.push('card-movement-unconfirmed');
      }
      const blocked = reasons => gaps.length || reasons.some(r => r !== 'card-payment-unconfirmed');
      const paid = blocked(paidReasons) ? figure(null, null, gaps.concat(paidReasons))
        : figure(paidCents / 100, paidTrust, paidReasons);
      const spent = blocked(spentReasons) ? figure(null, null, gaps.concat(spentReasons))
        : figure(spentCents / 100, 'calculated', spentReasons);
      const net = paid.amount == null || spent.amount == null
        ? figure(null, null, paid.reasons.concat(spent.reasons))
        : figure((paidCents - spentCents) / 100, weakest(paid.trust, spent.trust), paid.reasons.concat(spent.reasons));
      const state = net.amount == null ? null
        : !(card.posted || []).length ? 'no-activity'
        : paidCents > spentCents ? 'ahead' : paidCents < spentCents ? 'behind' : 'even';
      return { id: card.id, label: card.label, paid, spent, net, state,
        ...(state == null ? { stateReasons: net.reasons } : {}), transactions };
    });
  }
  // Stack Wallet A6b (lead dispatch, 2026-11-19): the Credit lines, per card
  // and pay period, from the card's paid / spent (stackCards) and the card's
  // minimum. The minimum is derived, never recomputed: the card's row of the
  // period's published bills split (stackSummary.bills.cardMinimums, the rows
  // the waterfall's Credit line sums), so the card and the waterfall cannot
  // disagree. Owner rule: "simple, has more money been put on the card than
  // came off it"; no per-transaction matching.
  //   status   'upcoming' for a future period; else 'paid-back' when paid >=
  //            spent; else 'to-go', with toGo = spent - paid. Null with
  //            reasons when paid or spent is null.
  //   minimumCovered  true when paid >= minimum, false when paid < minimum,
  //            'unknown' when either is null.
  // Each figure is { amount, trust, reasons }; trust is the weakest input.
  // HELOC is one of the credit lines: its minimum only, since the card ledger
  // publishes no paid / spent for it.
  //   balance  (Dale, 2026-11-20) the card's last balance snapshot: the
  //            publication's reportedBalance, current period only, with its
  //            date. It is a stock, never a paid / spent movement. It reads
  //            'estimated' when Forecast's verdict says it predates the card's
  //            statement cycle, when it has no date, or when a manual card's
  //            balance predates the as-of day, or when the card's cycle was
  //            never assessed and the balance predates the as-of day; else
  //            FRESH_BALANCE_TRUST ('calculated', lead ruling 2026-11-20: the
  //            word the Stack gives a fully evidenced movement from the same
  //            feed; never 'verified').
  //            Null with 'not-current-period' outside the current period.
  const LINE_LABELS = { heloc: 'HELOC' };
  const FRESH_BALANCE_TRUST = 'calculated';
  function balanceOf(card, publication) {
    if (publication.role !== 'current') return { amount: null, asOf: null, trust: 'unavailable', reasons: ['not-current-period'] };
    const reported = card && card.reportedBalance;
    const amount = reported && cents(reported.amount) !== null ? cents(reported.amount) / 100 : null;
    if (amount === null) return { amount: null, asOf: null, trust: 'unavailable', reasons: ['balance-unavailable'] };
    const asOf = typeof reported.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reported.date) ? reported.date : null;
    const reasons = [];
    const assessment = reported.freshness && reported.freshness.status;
    const beforeAsOf = asOf && typeof publication.asOf === 'string' && asOf < publication.asOf;
    if (!asOf || assessment === 'undated') reasons.push('balance-date-unavailable');
    // Atlas, #1447: a snapshot dated after the as-of day is unproven, never current.
    else if (assessment === 'after-as-of') reasons.push('balance-date-after-as-of');
    // No Forecast verdict for this snapshot: it cannot earn current trust.
    else if (!BALANCE_VERDICTS.includes(assessment)) reasons.push('balance-assessment-unavailable');
    else {
      if (assessment === 'stale') reasons.push('balance-before-statement-cycle');
      if (card.manualStatement === true && beforeAsOf) reasons.push('manual-balance-before-as-of');
      // Lead ruling (2026-11-20): a card whose cycle was never assessed is
      // fresh only when its balance is dated on the as-of day.
      else if (assessment === 'not-assessed' && beforeAsOf) reasons.push('balance-cycle-unassessed-before-as-of');
    }
    return { amount, asOf, trust: reasons.length ? 'estimated' : FRESH_BALANCE_TRUST, reasons };
  }
  const cents = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null;
  function stackCreditLines(publication, bills) {
    const cards = stackCards(publication);
    if (!cards) return null;
    const future = publication.role === 'future';
    const split = bills && Array.isArray(bills.cardMinimums) ? bills : null;
    const splitTrust = split && typeof split.trust === 'string' && split.trust ? split.trust : 'unavailable';
    const minimumOf = id => {
      if (!split) return { amount: null, trust: 'unavailable', reasons: ['bills-split-unavailable'] };
      const rows = split.cardMinimums.filter(row => row && String(row.debtId) === id);
      if (!rows.length) return { amount: null, trust: 'unavailable', reasons: ['no-minimum-due-in-period'] };
      const total = rows.reduce((sum, row) => sum === null || cents(row.amount) === null ? null : sum + cents(row.amount), 0);
      return total === null ? { amount: null, trust: 'unavailable', reasons: ['minimum-amount-unqualified'] }
        : { amount: total / 100, trust: splitTrust, reasons: [] };
    };
    const unavailable = reason => ({ amount: null, trust: 'unavailable', reasons: [reason] });
    const heloc = { id: 'heloc', label: LINE_LABELS.heloc,
      paid: unavailable('not-a-spend-card'), spent: unavailable('not-a-spend-card'),
      net: unavailable('not-a-spend-card'), state: null, stateReasons: ['not-a-spend-card'],
      transactions: [] };
    const published = id => publication.cards.find(row => row && row.id === id) || null;
    const lines = cards.concat([heloc]).map(card => {
      const minimum = minimumOf(card.id);
      const balance = balanceOf(published(card.id), publication);
      const paid = card.paid, spent = card.spent;
      const known = paid.amount !== null && spent.amount !== null;
      const inputsTrust = weakest(paid.trust, spent.trust);
      let status = null, toGo;
      const reasons = [...new Set(paid.reasons.concat(spent.reasons))];
      if (future) { status = 'upcoming'; toGo = { amount: null, trust: 'unavailable', reasons: ['future-period'] }; }
      else if (!known) toGo = { amount: null, trust: 'unavailable', reasons };
      else {
        const gap = cents(spent.amount) - cents(paid.amount);
        status = gap > 0 ? 'to-go' : 'paid-back';
        toGo = { amount: gap > 0 ? gap / 100 : 0, trust: inputsTrust, reasons };
      }
      const covered = paid.amount === null || minimum.amount === null ? 'unknown'
        : cents(paid.amount) >= cents(minimum.amount);
      return { ...card, balance, minimum, status, ...(status === null ? { statusReasons: future ? [] : reasons } : {}), toGo,
        minimumCovered: { value: covered,
          trust: covered === 'unknown' ? 'unavailable' : weakest(paid.trust, minimum.trust),
          reasons: covered === 'unknown' ? [...new Set(paid.reasons.concat(minimum.reasons))] : [] } };
    });
    // Totals over the stated cards only (lead ruling, 2026-11-19): a partial
    // sum is incomplete, not an estimate, so its completeness is explicit and
    // its trust is the stated lines' own. HELOC is never in the totals and is
    // not listed as excluded: it is not a spend card.
    const spendLines = lines.filter(line => line.id !== 'heloc');
    const stated = spendLines.filter(line => line.paid.amount !== null && line.spent.amount !== null);
    const excluded = spendLines.filter(line => !stated.includes(line)).map(line => line.id);
    const totals = !stated.length
      ? { paid: null, spent: null, trust: 'unavailable', completeness: 'none', excluded,
        reasons: [...new Set(spendLines.flatMap(line => line.paid.reasons.concat(line.spent.reasons)))] }
      : { paid: stated.reduce((sum, line) => sum + cents(line.paid.amount), 0) / 100,
        spent: stated.reduce((sum, line) => sum + cents(line.spent.amount), 0) / 100,
        trust: weakest(...stated.flatMap(line => [line.paid.trust, line.spent.trust])),
        completeness: excluded.length ? 'partial' : 'complete', excluded,
        reasons: excluded.length ? ['some-cards-unavailable'] : [] };
    // The minimums due, over exactly the spend cards the paid total is over (HELOC excluded: its minimum is part of the
    // period's Credit line in the waterfall, a different figure by membership). minimumsDue is the sum of those cards'
    // published minimum amounts, withheld (amount null) when any card's minimum is withheld for a reason other than
    // no-minimum-due-in-period, never a partial sum. The counts say how many cards have a minimum due and how many of those
    // are published covered (minimumCovered.value === true), so a bar of covered over due is full only when every due
    // minimum is covered; they are null when the minimums are withheld. Trust is the weakest input, as for the other totals.
    const minimumOff = line => line.minimum.amount === null && !line.minimum.reasons.includes('no-minimum-due-in-period');
    const withheldMins = spendLines.filter(minimumOff);
    // A published $0 minimum is nothing owed: it is not due, so it is out of the sum and both counts.
    const dueLines = spendLines.filter(line => line.minimum.amount !== null && cents(line.minimum.amount) > 0);
    if (withheldMins.length) {
      totals.minimumsDue = { amount: null, trust: 'unavailable',
        reasons: [...new Set(withheldMins.flatMap(line => line.minimum.reasons))] };
      totals.minimumsDueCount = null;
      totals.minimumsCoveredCount = null;
      totals.minimumsCoveredTrust = 'unavailable';
      totals.minimumsPaid = { amount: null, trust: 'unavailable', reasons: ['minimums-due-withheld'] };
    } else {
      totals.minimumsDue = { amount: dueLines.reduce((sum, line) => sum + cents(line.minimum.amount), 0) / 100,
        trust: dueLines.length ? weakest(...dueLines.map(line => line.minimum.trust)) : splitTrust, reasons: [] };
      // The paid side of the Credit head, over exactly the cards in minimumsDue (Dale, 2026-11-20: "$0 / owed if nothing has been
      // paid"). Each due card's published paid, uncapped (an overpaid card counts its full paid, like its own row); $0 when
      // nothing was paid. Owner decision (Dale, 2026-11-20: "I don't need a distinction with estimated"): a due MANUAL / no-ledger
      // card (Triangle, Amazon: manualStatement in the publication) that Forecast cannot see counts $0 in the current period, and
      // every card counts $0 in an upcoming one (nothing is observed yet), the one exception to the never-0 rule, with the trust word kept honest (estimated) in the data. Missing HISTORY is
      // not an unseen card: a card with a feed whose paid is withheld (a failed sync, incomplete posted coverage) or any unseen card
      // in a PAST period withholds the whole figure (null, unavailable, with its reasons), since a $0 there could hide a real
      // payment. A payment still to confirm on an observed card is that card's estimated paid, number shown. HELOC is not here.
      const unseen = dueLines.filter(line => line.paid.amount === null);
      const unseenManual = line => !!(published(line.id) && published(line.id).manualStatement === true);
      const missingHistory = unseen.some(line => publication.role === 'past' || (publication.role !== 'future' && !unseenManual(line)));
      const unseenReasons = [...new Set(unseen.flatMap(line => line.paid.reasons))];
      totals.minimumsPaid = missingHistory
        ? { amount: null, trust: 'unavailable', reasons: ['paid-unavailable'].concat(unseenReasons.filter(r => r !== 'paid-unavailable')) }
        : { amount: dueLines.reduce((sum, line) => sum + (line.paid.amount === null ? 0 : cents(line.paid.amount)), 0) / 100,
          trust: dueLines.length ? weakest(...dueLines.map(line => line.paid.amount === null ? 'estimated' : line.paid.trust)) : splitTrust,
          reasons: unseen.length ? ['paid-unavailable-counted-as-zero'].concat(unseenReasons) : [] };
      totals.minimumsDueCount = dueLines.length;
      totals.minimumsCoveredCount = dueLines.filter(coveredOn).length;
      totals.minimumsCoveredTrust = dueLines.length
        ? weakest(...dueLines.flatMap(line => [line.minimum.trust, line.minimumCovered.value === 'unknown' ? line.minimum.trust : line.minimumCovered.trust]))
        : splitTrust;
    }
    // The balance total is over the spend cards' snapshots (HELOC excluded, as
    // above), with the weakest trust: a stale snapshot is counted and keeps the
    // total estimated; only a card with no snapshot at all is excluded.
    const withBalance = spendLines.filter(line => line.balance.amount !== null);
    const noBalance = spendLines.filter(line => line.balance.amount === null).map(line => line.id);
    totals.balance = !withBalance.length
      ? { amount: null, trust: 'unavailable', completeness: 'none', excluded: noBalance,
        reasons: [...new Set(spendLines.flatMap(line => line.balance.reasons))] }
      : { amount: withBalance.reduce((sum, line) => sum + cents(line.balance.amount), 0) / 100,
        trust: weakest(...withBalance.map(line => line.balance.trust)),
        completeness: noBalance.length ? 'partial' : 'complete', excluded: noBalance,
        reasons: noBalance.length ? ['some-balances-unavailable'] : [] };
    return { lines, totals };
  }
  return { publish, stackCards, stackCreditLines };
});
