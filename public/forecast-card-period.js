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
  // Inferred destination (owner, Dale, #821 7174658128, amending rule 17 for this case): a posted Bills or Weekly debit
  // that the paying side calls a card payment but that carries no `card payment:` note (and no conflicting destination)
  // counts toward a card or the HELOC when one of two rules names exactly one line. A note always wins; internal household
  // movements are excluded before this runs (unnotedHouseholdMovement). Read only: a landing is read as evidence, nothing
  // on the card side changes.
  //   1. Two-sided: a row on exactly one card or HELOC account of the opposite amount, posted or pending (not replaced by its
  //      posted twin), dated within INFER_WINDOW_DAYS of the debit. Pairing is one to one; a landing that pairs with a
  //      note-tied debit is reserved for it first. Trust: calculated on a posted landing, estimated on a pending one.
  //   2. Expected amount: otherwise, the debit is within INFER_TOLERANCE (the larger of $1 and 1%) of a scheduled minimum
  //      Forecast expects for exactly one line in the period (primitives.expectedMinimumCents, the plan's own scheduled
  //      occurrences, so the HELOC settlement and Paid back read one figure). Trust: estimated.
  //   Ambiguity (two lines, two debits for one landing, or two debits for one line's minimum) attributes nothing.
  // Returns every unassigned debit with its inferred destination, or null to stay unassigned.
  const INFER_WINDOW_DAYS = 3;
  const INFER_TOLERANCE = cents => Math.max(100, Math.round(Math.abs(cents) * 0.01));
  function inferDestinations(packet, start, end, assigned, unassigned, byCard, primitives) {
    const out = unassigned.map(entry => ({ ...entry, inferred: null }));
    const noteless = out.filter(entry => entry.value > 0 && !entry.destination.reason
      && typeof primitives.cardPaymentNote === 'function' && !primitives.cardPaymentNote(entry.tx));
    // A debit whose own row names a line may only be confirmed to that line; two names that disagree infer nothing.
    const named = new Map(noteless.map(d => [d, typeof primitives.namedDestination === 'function' ? primitives.namedDestination(d.tx) : null]));
    const allowed = (d, cardId) => !named.get(d) || named.get(d) === cardId;
    const rows = Array.isArray(packet && packet.transactions) ? packet.transactions : [];
    const landings = [];
    for (const tx of rows) {
      if (!tx || !['revolving-credit', 'heloc'].includes(tx.accountRole) || tx.contradictoryEvidence === true) continue;
      // Only a payment or transfer receipt can be a landing (never a purchase refund), and never a split parent.
      if (typeof primitives.cardPaymentLanding !== 'function' || !primitives.cardPaymentLanding(tx)) continue;
      if (typeof primitives.skipParent === 'function' && primitives.skipParent(tx, packet)) continue;
      const cardId = tx.atlasAccountId || tx.account;
      if (!byCard.has(cardId) || !primitives.date(tx.date)) continue;
      const pending = tx.pending === true;
      if (pending && (tx.pendingPostedDuplicate === true || primitives.replacedPending?.(tx))) continue;
      // The payer path's own evidence checks (Codex on #1650): conflicting account aliases or an ambiguous pending/posted
      // pairing are not evidence of a destination.
      const aliases = [tx.atlasAccountId, tx.account, tx.accountId].filter(v => v != null).map(String);
      if (new Set(aliases).size > 1 || tx.pendingPostedAmbiguous === true || tx.isGroup === true) continue;
      if (!pending && !(tx.pending === false && tx.savingsPostingEvidence !== 'pending')) continue;
      const cents = primitives.money(tx);
      if (cents === null || !(cents < 0)) continue;
      landings.push({ tx, cardId, cents, pending, used: false });
    }
    const near = (debit, landing) => landing.cents === -debit.value
      && landing.tx.date >= primitives.addDays(debit.tx.date, -INFER_WINDOW_DAYS)
      && landing.tx.date <= primitives.addDays(debit.tx.date, INFER_WINDOW_DAYS);
    // Note-tied (or otherwise named) payments take their own landing first, when it is the only one.
    for (const debit of assigned) {
      if (!(debit.value > 0)) continue;
      const own = landings.filter(l => !l.used && l.cardId === debit.cardId && near(debit, l));
      if (own.length === 1) own[0].used = true;
    }
    // Rule 1.
    // A debit that matches any landing, reserved or not, competed for it: it never falls through to the minimum rule
    // (Codex on #1650), so a reserved landing's twin stays unassigned.
    const competed = new Set(noteless.filter(d => landings.some(l => near(d, l))));
    const candidates = new Map(noteless.map(d => [d, named.get(d) === 'conflict' ? [] : landings.filter(l => !l.used && near(d, l) && allowed(d, l.cardId))]));
    for (const d of noteless) {
      const mine = candidates.get(d);
      if (mine.length !== 1) continue;
      const landing = mine[0];
      if (noteless.filter(other => candidates.get(other).includes(landing)).length !== 1) continue;
      landing.used = true;
      d.inferred = { cardId: landing.cardId, ...(landing.pending ? { reason: 'card-payment-inferred-pending-landing' } : {}) };
    }
    // Rule 2.
    const expected = typeof primitives.expectedMinimumCents === 'function' ? primitives.expectedMinimumCents(start, end) : null;
    if (expected instanceof Map) {
      const byLine = new Map();
      for (const d of noteless) {
        if (d.inferred || competed.has(d) || named.get(d) === 'conflict') continue;
        // A minimum that an already-named payment matches is taken: it is never claimed again by a second debit.
        const taken = (cardId, amount) => assigned.some(a => a.cardId === cardId && Math.abs(a.value - amount) <= INFER_TOLERANCE(amount));
        const lines = [...expected].filter(([cardId, amounts]) => byCard.has(cardId) && allowed(d, cardId)
          && amounts.some(amount => !taken(cardId, amount) && Math.abs(d.value - amount) <= INFER_TOLERANCE(amount))).map(([cardId]) => cardId);
        if (lines.length !== 1) continue;
        byLine.set(lines[0], (byLine.get(lines[0]) || []).concat([d]));
      }
      for (const [cardId, debits] of byLine) {
        if (debits.length === 1) debits[0].inferred = { cardId, reason: 'card-payment-inferred-by-minimum' };
      }
    }
    return out.map(entry => ({ tx: entry.tx, value: entry.value, destination: entry.inferred, reason: entry.destination.reason }));
  }
  // The paying account owns this figure. Card postings, allocations and balances cannot establish who sent a payment.
  function periodPayerPayments(packet, start, through, observed, primitives, end) {
    const unconfirmedPayments = [];
    // The HELOC is paid from Bills like a card (Dale, #821 7161929211), so it has a paying-side bucket too.
    const byCard = new Map(cardIdentities.concat([['heloc']]).map(([id]) => [id, { cents: 0, reasons: new Set(), gaps: new Set() }]));
    const globalGaps = new Set();
    const query = packet?.transactionWindow;
    const syncRows = Array.isArray(packet?.syncEvidence) ? packet.syncEvidence : [];
    const payerSync = syncRows.filter(row => ['household-cash', 'household-reserve'].includes(row?.role));
    // The walk over the period's posted paying-side rows: per card its cents, reasons and gaps (in `buckets`), gaps with no
    // card identity in `outside`; returns the assigned and unassigned rows and whether a debit was seen.
    const walk = (buckets, outside) => {
      let debitSeen = false;
      const candidates = [];
      const seen = new Set(), duplicates = new Set();
      for (const tx of packet.transactions) {
        if (!tx || (tx.pending === true && tx.savingsPostingEvidence !== 'posted') || primitives.skipParent(tx, packet)) continue;
        // Register every posted row before checking its role, category or period. Conflicting copies can disagree on all three.
        const id = tx.id == null ? '' : String(tx.id).trim();
        const keys = id ? ['id:' + id] : [];
        if (typeof tx.coverageRef === 'string' && tx.coverageRef.trim()) keys.push('ref:' + tx.coverageRef.trim());
        for (const key of keys) {
          if (seen.has(key)) duplicates.add(key);
          seen.add(key);
        }
        const destination = primitives.payingSidePayment(tx);
        if (destination) candidates.push({ tx, destination, id, keys });
      }
      const unassigned = [], assigned = [];
      for (const { tx, destination, id, keys } of candidates) {
        const bucket = buckets.get(destination.cardId);
        const gaps = bucket ? bucket.gaps : outside;
        if (!primitives.date(tx.date)) { gaps.add('transaction-date-unqualified'); continue; }
        if (tx.date < start || tx.date > through) continue;
        const value = primitives.money(tx);
        if (value === null) { gaps.add('transaction-amount-unqualified'); continue; }
        if (value === 0) continue;
        const aliases = [tx.atlasAccountId, tx.account, tx.accountId].filter(v => v != null).map(String);
        const settlementAmbiguous = tx.pendingPostedAmbiguous === true;
        const evidenceConflict = !id || tx.pending !== false || tx.savingsPostingEvidence !== 'posted'
          || new Set(aliases).size > 1 || tx.isGroup === true || tx.contradictoryEvidence === true;
        // An incoming deposit with no card identity cannot withhold Credit through its own
        // settlement ambiguity. A card candidate, or a conflict that could hide a debit or
        // reversal, still opens the gap.
        const outsideDeposit = !bucket && value < 0 && typeof primitives.incomingCardReversal === 'function' && !primitives.incomingCardReversal(tx);
        if (evidenceConflict || (settlementAmbiguous && !outsideDeposit)) {
          gaps.add('paying-side-evidence-unconfirmed');
          continue;
        }
        // Before any skip below: a copy with this identity can carry another classification and
        // never reach this loop, so only a row with a unique identity is passed over as a deposit.
        if (keys.some(key => duplicates.has(key))) {
          gaps.add('duplicate-identity');
          continue;
        }
        debitSeen ||= value > 0;
        // An internal debit can show the payer was observed without supplying a card payment or reversal.
        if (primitives.unnotedHouseholdMovement?.(tx)) continue;
        if (!bucket) {
          // No card identity, and a unique identity: an incoming deposit is not a payment and not a reversal.
          if (outsideDeposit) continue;
          unassigned.push({ tx, value, destination });
        } else if (value < 0) {
          bucket.gaps.add('payment-direction-unresolved');
        } else {
          bucket.cents += value;
          if (!Number.isSafeInteger(bucket.cents)) bucket.gaps.add('transaction-amount-unqualified');
          if (destination.trust === 'estimated') bucket.reasons.add(destination.reason || 'card-payment-by-amount');
          assigned.push({ tx, value, cardId: destination.cardId });
        }
      }
      return { assigned, unassigned, debitSeen };
    };
    if (!observed || !query || query.complete !== true || query.hasMore !== false || query.truncated !== false
      || (typeof primitives.coverageComplete === 'function' && !primitives.coverageComplete(query))
      || query.startDate !== packet.coverageStart || query.endDate !== packet.coverageThrough
      || payerSync.some(row => row.syncEvidence === 'failed')
      || typeof primitives.payingSidePayment !== 'function') {
      globalGaps.add('paying-side-coverage-incomplete');
      // Veto only (OD-045; lead decision on #1671): the gap stands and the partial rows supply no amount, destination,
      // receipt, unconfirmed entry or decision. The same walk, on a throwaway copy, only adds the reversal, conflict and
      // evidence gaps it finds to each card, so a current observed contradiction beats a held line (heldCardLineCoversPayerGap
      // in forecast.js accepts coverage reasons alone). Rows that cannot be inspected fail closed.
      const inspectable = Array.isArray(packet?.transactions) && typeof primitives.payingSidePayment === 'function'
        && typeof primitives.date === 'function' && typeof primitives.money === 'function' && typeof primitives.skipParent === 'function'
        && !!primitives.date(start) && !!primitives.date(through);
      if (!inspectable) {
        for (const bucket of byCard.values()) bucket.gaps.add('paying-side-rows-uninspected');
      } else {
        const shadow = new Map([...byCard.keys()].map(id => [id, { cents: 0, reasons: new Set(), gaps: new Set() }]));
        const outside = new Set();
        const { unassigned } = walk(shadow, outside);
        // An incoming row with no card identity that is not an outside deposit is a reversal of some card's payment.
        const reversal = unassigned.some(({ value }) => value < 0);
        for (const [id, bucket] of byCard) {
          for (const gap of [...shadow.get(id).gaps, ...outside]) bucket.gaps.add(gap);
          if (reversal) bucket.gaps.add('payment-direction-unresolved');
        }
      }
    } else {
      // A page can be complete while the paying account is unseen. Require a proven payer sync or an observed debit.
      let payerObserved = payerSync.some(row => row.id && row.syncEvidence === 'proven' && !row.reason
        && (row.fields?.last_fetch === true || row.fields?.plaid_last_successful_update === true)
        && syncRows.filter(other => other?.id === row.id).length === 1);
      const { assigned, unassigned, debitSeen } = walk(byCard, globalGaps);
      payerObserved ||= debitSeen;
      for (const { tx, value, destination, reason } of inferDestinations(packet, start, end || through, assigned, unassigned, byCard, primitives)) {
        if (destination) {
          const bucket = byCard.get(destination.cardId);
          bucket.cents += value;
          if (!Number.isSafeInteger(bucket.cents)) bucket.gaps.add('transaction-amount-unqualified');
          if (destination.reason) bucket.reasons.add(destination.reason);
        } else {
          unconfirmedPayments.push({ date: tx.date, amount: value / 100, ...(reason ? { reason } : {}) });
        }
      }
      if (!payerObserved) globalGaps.add('paying-account-not-observed');
    }
    const paid = id => {
      const { cents, reasons, gaps } = byCard.get(id);
      if (globalGaps.size || gaps.size) return { amount: null, trust: 'unavailable', reasons: [...new Set([...globalGaps, ...gaps])] };
      // An empty interval proves no named debit was seen. It cannot establish payment from an unseen account.
      if (!cents && !reasons.size) reasons.add('no-confirmed-paying-side-payments');
      return { amount: cents / 100, trust: reasons.size ? 'estimated' : 'calculated', reasons: [...reasons] };
    };
    return { paid, unconfirmedPayments };
  }
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
    const payer = periodPayerPayments(packet, start, through, windowKnown && through && coverage, primitives, end);
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
    // The one money qualification for a card row is Forecast's (primitives.money, Forecast.cardMoneyCents): the card
    // publication and Forecast.pendingHoldReleases both read it, so a row the card would withhold never drops a hold.
    const safeMoney = primitives.money;
    const pointFact = point => point ? { amount: cents(point.amount, true) === null ? null : point.amount,
      date: date(point.date) ? point.date : null, temporalClaim: point.temporalClaim || null } : null;
    const cards = identities.map(([id, label]) => {
      const issues = [];
      const card = { id, label, status: role === 'future' ? 'not-observed' : 'unavailable',
        netChange: { amount: null, magnitude: null, direction: null, trust: 'unavailable', completeness: 'unavailable' },
        payerPaid: payer.paid(id),
        ...(id !== 'heloc' ? { postedMovement: { amount: null, magnitude: null, direction: null,
          trust: 'unavailable', completeness: 'unavailable', reasons: issues } } : {}),
        opening: null, closing: null, reportedBalance: null, posted: [], pending: [],
        postedCoverage: coverage ? 'complete-provider-response' : 'incomplete',
        pendingCoverage: role !== 'current' ? 'not-observed' : packetCurrent && ledgerValid && boundsValid && covered(packet.pendingCoverage) ? 'complete-provider-response' : 'unavailable',
        manualStatement: id === 'triangle' || id === 'mbna', reasons: issues,
        // The HELOC's own sync row, read the way the cards' is (below): 'proven', another published state ('absent',
        // 'failed'), or 'missing' when the packet carries no single row for it. Only the Credit row's paid figure reads it.
        ...(id === 'heloc' ? { syncState: (() => {
          const rowsFor = Array.isArray(packet?.syncEvidence) ? packet.syncEvidence.filter(row => row?.id === 'heloc') : [];
          return rowsFor.length === 1 && typeof rowsFor[0].syncEvidence === 'string' && rowsFor[0].syncEvidence ? rowsFor[0].syncEvidence : 'missing';
        })() } : {}) };
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
      const replacedPending = tx => tx && tx.pending === true && typeof primitives.replacedPending === 'function' && primitives.replacedPending(tx) === true;
      // The Stack's pending-inclusive Spent / Paid (stackCards) only: a flagged row whose partner, by Forecast's own pairing
      // (pendingPostedPartner, the rows it matched one for one), is on this card, on the other side, with the pending side
      // replaced, is that pair accounted for. Each such row's flag is counted here; the posted movement and the endpoint
      // reconciliation keep every flag as before. Anything else fails closed.
      const ownById = new Map(rows.filter(tx => tx && tx.id != null && (tx.atlasAccountId || tx.account) === id
        && tx.accountRole === 'revolving-credit').map(tx => [String(tx.id), tx]));
      const pairAccounted = tx => {
        if (id === 'heloc' || typeof primitives.pendingPostedPartner !== 'function') return false;
        const partnerId = primitives.pendingPostedPartner(tx);
        const partner = partnerId == null ? null : ownById.get(String(partnerId));
        // The partner must fall inside this period too ([start, through]); otherwise the pair is not accounted for here.
        // Forecast's pairing key includes the date, so a pair shares one date today; the guard keeps failing closed if
        // the key ever changes.
        if (!partner || !date(partner.date) || partner.date < start || !through || partner.date > through
          || (partner.pending === true) === (tx.pending === true) || partner.pendingPostedAmbiguous === true
          || partner.contradictoryEvidence === true || String(primitives.pendingPostedPartner(partner)) !== String(tx.id)) return false;
        return replacedPending(tx.pending === true ? tx : partner);
      };
      let pairRelief = 0;
      for (const tx of rows) {
        if (!tx || (tx.atlasAccountId || tx.account) !== id
          || tx.accountRole !== (id === 'heloc' ? 'heloc' : 'revolving-credit')) continue;
        if (!date(tx.date)) { issues.push('transaction-date-unqualified'); continue; }
        if (tx.date < start || tx.date > through) continue;
        // A pending hold and its release (Forecast's pendingHoldReleases, owner decision 2026-11-23): neither leg is a
        // charge or an unconfirmed credit on the card, so neither is listed or counted, and Spent is not withheld for it.
        if (tx.pending === true && typeof primitives.holdReleaseLeg === 'function' && primitives.holdReleaseLeg(tx) === true) continue;
        // A pending row Forecast's one pending/posted pairing calls replaced by its posted twin (the household budget's rule,
        // `replacedPending`) is that same charge: it is never counted, and its posted twin counts once (Dale, 2026-11-22: "when
        // the actual charge comes in, I don't want to have that doubled up"). Every flag still withholds the posted movement
        // and the endpoint reconciliation, exactly as before; a pair Forecast itself matched is relieved for the Stack's
        // Spent / Paid only (pairRelief, below).
        const replaced = replacedPending(tx);
        if (tx.pendingPostedAmbiguous === true || tx.pendingPostedDuplicate === true || tx.contradictoryEvidence === true) {
          issues.push('transaction-evidence-unconfirmed');
          if (tx.pendingPostedDuplicate === true && tx.pendingPostedAmbiguous !== true && tx.contradictoryEvidence !== true
            && pairAccounted(tx)) pairRelief += 1;
        }
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
        // and leave a standalone credit unconfirmed even with a refund hint.
        const hint = typeof tx.kindHint === 'string' ? tx.kindHint.trim().toLowerCase() : '';
        const positiveNonCharge = id !== 'heloc' && value > 0 && (tx.isIncome === true
          || ['transfer', 'internal-transfer', 'refund', 'income'].includes(hint)
          || ['transfer', 'refund', 'income'].includes(classification?.kind));
        const kind = ['payment', 'card-payment', 'bill-payment'].includes(hint) || tx.cardPaymentIdentity === true ? 'payment'
          : positiveNonCharge ? 'movement-unconfirmed'
          : id === 'heloc' && hint === 'interest' || classification?.kind === 'interest' ? 'interest'
          : value != null && value < 0 ? 'credit-unconfirmed'
          : ['spend', 'bill', 'savings-item'].includes(classification?.kind) ? 'charge' : 'movement-unconfirmed';
        // Stack can recognize a charge to repay without assigning it to a household budget row.
        const chargeCategoryUnconfirmed = id !== 'heloc' && kind === 'movement-unconfirmed' && value > 0
          && !positiveNonCharge && ['unclassified', 'unmapped', 'business', 'external'].includes(classification?.kind);
        const published = { id: tx.id == null ? null : String(tx.id), date: tx.date,
          // The ledger's payee, else its merchant (never the generic fallback where the ledger has a name).
          payee: typeof tx.displayedPayee === 'string' && tx.displayedPayee.trim() ? tx.displayedPayee
            : typeof tx.originalMerchant === 'string' && tx.originalMerchant.trim() ? tx.originalMerchant
            : id === 'heloc' ? 'Transaction' : 'Card transaction',
          // Display only: the item text of an "item:" note, shown instead of
          // the payee. Present only when there is one; `payee` is unchanged
          // and nothing here reads the field.
          ...(DisplayName && DisplayName.itemName(tx) ? { displayName: DisplayName.itemName(tx) } : {}),
          amount: value == null ? null : value / 100, magnitude: value == null ? null : Math.abs(value) / 100,
          direction: value == null ? null : value > 0 ? 'up' : value < 0 ? 'down' : 'flat',
          kind, pending: tx.pending === true, ...(replaced ? { replacedByPosted: true } : {}),
          ...(chargeCategoryUnconfirmed ? { chargeCategoryUnconfirmed,
            otherChargeCounted: primitives.otherChargeCounted?.(tx) === true } : {}) };
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
        // The Stack's own gate: the posted movement's gaps less exactly the flags of pairs Forecast matched (each such flag
        // pushed one 'transaction-evidence-unconfirmed' above). Published only when a pair was relieved, so every other card
        // is unchanged; stackCards reads it in place of the posted movement's verdict.
        if (pairRelief > 0) {
          const stackGaps = gaps.slice();
          for (let n = 0; n < pairRelief; n++) {
            const at = stackGaps.indexOf('transaction-evidence-unconfirmed');
            if (at < 0) { stackGaps.push('transaction-evidence-unconfirmed'); break; }
            stackGaps.splice(at, 1);
          }
          card.stackPendingGaps = [...new Set(stackGaps)];
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
      through: date(through) ? through : null, role, cards, unconfirmedPayments: payer.unconfirmedPayments,
      observationAsOf: date(packet?.observationAsOf) ? packet.observationAsOf : null,
      semantics: 'Posted liability movement, not spending-only totals, available cash, payment instructions or minimum settlement.' };
  }
  // Stack Wallet A6 (lead dispatch, 2026-11-19): per card, in one pay period,
  // how much was paid onto the card against how much was spent on it. A pure
  // reading of one publish() result: posted rows plus the pending rows not
  // replaced by a posted twin (Dale, 2026-11-22), the same kinds publish()
  // assigns, no amount or date heuristic. A figure that cannot be stated is
  // null with a reason, never 0. Each figure carries a trust word:
  // 'calculated', 'estimated' (an unreconciled payment, a charge with an
  // unconfirmed category, or a figure a pending row adds to), or 'unavailable'.
  const STACK_TRUST_ORDER = ['calculated', 'estimated', 'unavailable'];
  // An unrecognised trust word is the weakest there is ('unavailable'), never silently dropped from the comparison.
  const weakest = (...words) => STACK_TRUST_ORDER[Math.max(...words.map(w => (STACK_TRUST_ORDER.includes(w) ? STACK_TRUST_ORDER.indexOf(w) : STACK_TRUST_ORDER.length - 1)))];
  // A covered check counts as covered only on evidence Forecast stands behind: a published true whose trust is calculated or
  // estimated. 'unavailable' (or any other word) is not covered.
  const COVERED_TRUST = ['calculated', 'verified', 'estimated'];
  const coveredOn = line => line.minimumCovered.value === true && COVERED_TRUST.includes(line.minimumCovered.trust);
  // The published card summary leaves out the internal inputs (paidPosted, chargesCounted), so its shape
  // is unchanged.
  function stackCards(publication) {
    const cards = stackCardFigures(publication);
    return cards && cards.map(({ paidPosted, chargesCounted, ...card }) => card);
  }
  function stackCardFigures(publication) {
    const pub = publication && publication.source === 'Forecast.cardPeriodMovements'
      && publication.currency === 'CAD' && Array.isArray(publication.cards) ? publication : null;
    if (!pub) return null;
    const figure = (amount, trust, reasons) => amount == null
      ? { amount: null, trust: 'unavailable', reasons: [...new Set(reasons)] }
      : { amount, trust, reasons: [...new Set(reasons)] };
    return pub.cards.filter(card => card && card.id !== 'heloc').map(card => {
      // Pending rows count (Dale, 2026-11-22: "we know the actual charge is coming ... it can count towards the spend"), each
      // exactly as the same row would if posted, except one Forecast's pairing calls replaced by its posted twin: that is the
      // same charge, so it is not counted and the posted twin counts once ("I don't want to have that doubled up"). Like the
      // household budget's pairing, no row is dropped from view: a replaced pending row is still listed.
      const allPending = (Array.isArray(card.pending) ? card.pending : []).map(row => ({ ...row, pending: true }));
      const posted = (Array.isArray(card.posted) ? card.posted : []).map(row => ({ ...row, pending: false }));
      const rows = posted.concat(allPending.filter(row => row.replacedByPosted !== true));
      const transactions = posted.concat(allPending).map(row => ({ date: row.date, name: row.displayName || row.payee,
        amount: row.amount, kind: row.kind, payment: row.kind === 'payment', pending: row.pending }))
        .sort((a, b) => a.date.localeCompare(b.date) || (a.pending === b.pending ? 0 : a.pending ? 1 : -1));
      const movement = card.postedMovement;
      // A card whose only withheld evidence is a pending/posted pair Forecast matched reads the Stack's own gate (publish).
      const gaps = Array.isArray(card.stackPendingGaps) ? card.stackPendingGaps
        : movement && movement.trust === 'calculated' && movement.completeness === 'complete'
        ? [] : (movement && Array.isArray(movement.reasons) && movement.reasons.length ? movement.reasons : ['posted-movement-unavailable']);
      let paidCents = 0, spentCents = 0, postedPaidCents = 0, chargeCents = 0;
      const paidReasons = [], spentReasons = [], postedPaidReasons = [];
      let paidTrust = 'calculated', spentTrust = 'calculated', postedPaidTrust = 'calculated';
      for (const row of rows) {
        const value = typeof row.amount === 'number' && Number.isFinite(row.amount) ? Math.round(row.amount * 100) : null;
        // A figure a pending row adds to is an estimate until the row posts: never calculated.
        if (row.pending && value != null) {
          if (row.kind === 'payment') { paidTrust = 'estimated'; paidReasons.push('includes-pending'); }
          else if (row.kind === 'charge' || row.kind === 'interest' || row.kind === 'refund') { spentTrust = 'estimated'; spentReasons.push('includes-pending'); }
        }
        if (value == null) {
          paidReasons.push('transaction-amount-unqualified'); spentReasons.push('transaction-amount-unqualified');
          // The posted-only paid reads posted rows only: a pending row's problem never withholds it.
          if (!row.pending) postedPaidReasons.push('transaction-amount-unqualified');
          continue;
        }
        if (row.kind === 'payment') {
          paidCents += -value;
          // A payment the card ledger has not reconciled (or carries no
          // allocation at all) is estimated; only a reconciled one is calculated.
          if (!row.paymentAllocation || row.paymentAllocation.status !== 'reconciled') {
            paidTrust = 'estimated'; paidReasons.push('card-payment-unconfirmed');
            if (!row.pending) { postedPaidTrust = 'estimated'; postedPaidReasons.push('card-payment-unconfirmed'); }
          }
          if (!row.pending) postedPaidCents += -value;
        } else if (row.chargeCategoryUnconfirmed) {
          spentCents += value;
          if (row.otherChargeCounted) chargeCents += value;
          spentTrust = 'estimated';
          spentReasons.push('charge-category-unconfirmed');
          if (row.pending) spentReasons.push('includes-pending');
        } else if (row.kind === 'charge' || row.kind === 'interest' || row.kind === 'refund') {
          spentCents += value;
          // A charge is a household purchase, a card-paid bill or a savings item (the classifier's spend / bill / savings-item):
          // each is already deducted above the Credit line (the Household budget hold, the bills, the item term).
          if (row.kind === 'charge') chargeCents += value;
        }
        else if (row.kind === 'credit-unconfirmed') {
          paidReasons.push('card-credit-purpose-unconfirmed'); spentReasons.push('card-credit-purpose-unconfirmed');
          if (!row.pending) postedPaidReasons.push('card-credit-purpose-unconfirmed');
        } else spentReasons.push('card-movement-unconfirmed');
      }
      const blocked = reasons => gaps.length || reasons.some(r =>
        !['card-payment-unconfirmed', 'includes-pending', 'charge-category-unconfirmed'].includes(r));
      const paid = blocked(paidReasons) ? figure(null, null, gaps.concat(paidReasons))
        : figure(paidCents / 100, paidTrust, paidReasons);
      // Paid from posted payments only (lead ruling, ATLAS LEAD 12, 2026-11-22): a pending payment can fail or reverse, so
      // it counts in Paid (estimated) but never, by itself, makes a minimum covered or counts toward the minimums paid.
      // Internal to this module: stackCreditLines reads it; neither stackCards nor a Credit line publishes it.
      const paidPosted = blocked(postedPaidReasons) ? figure(null, null, gaps.concat(postedPaidReasons))
        : figure(postedPaidCents / 100, postedPaidTrust, postedPaidReasons);
      const spent = blocked(spentReasons) ? figure(null, null, gaps.concat(spentReasons))
        : figure(spentCents / 100, spentTrust, spentReasons);
      // The charges inside Spent that are already deducted above (desk ruling (E), #1573): read on the same rows as Spent,
      // so withheld exactly when Spent is. Internal to this module, like paidPosted: stackCreditLines reads it.
      const chargesCounted = blocked(spentReasons) ? figure(null, null, gaps.concat(spentReasons))
        : figure(chargeCents / 100, spentTrust, spentReasons);
      const net = paid.amount == null || spent.amount == null
        ? figure(null, null, paid.reasons.concat(spent.reasons))
        : figure((paidCents - spentCents) / 100, weakest(paid.trust, spent.trust), paid.reasons.concat(spent.reasons));
      const state = net.amount == null ? null
        : !rows.length ? 'no-activity'
        : paidCents > spentCents ? 'ahead' : paidCents < spentCents ? 'behind' : 'even';
      return { id: card.id, label: card.label, paid, paidPosted, chargesCounted, spent, net, state,
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
  // `utilisation` (optional): Forecast.utilisation's rows (used against limit, pending included), read for each card's
  // over-limit amount; never recomputed here.
  function stackCreditLines(publication, bills, utilisation, beyondMinimumPaid) {
    // Card-side posted payments remain an input to the independent over-limit authority.
    const cards = stackCardFigures(publication);
    if (!cards) return null;
    const future = publication.role === 'future';
    const unconfirmedPayments = Array.isArray(publication.unconfirmedPayments) ? publication.unconfirmedPayments : [];
    const hasUnassignedReversal = unconfirmedPayments.some(payment => payment.amount < 0);
    // Unassigned transfers affect the head and cards with a positive repayment target. Their amounts stay unallocated.
    const unassignedReasons = unconfirmedPayments.map(payment => payment.reason).filter(Boolean);
    const withUnassignedPayments = figure => unconfirmedPayments.length
      ? { ...figure, trust: weakest(figure.trust, 'estimated'),
        reasons: [...new Set(figure.reasons.concat('card-payment-destination-unconfirmed', unassignedReasons))] } : figure;
    const minimumIsDue = minimum => cents(minimum.amount) > 0;
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
    // The paid figure a Credit row and the Credit head both read (Dale, 2026-11-20: "0/ owed total if nothing has been paid yet",
    // "Just normal font"): one rule per line, so the head, which sums the due spend cards' paidToward, and the rows cannot
    // disagree. { amount, trust, reasons }:
    //   * a line with a qualified paying-side ledger (a spend card, or the HELOC paid from Bills): its period debits naming
    //     that line, with their own trust;
    //   * a card Forecast cannot see counts $0 (trust estimated in the data), by owner decision: a manual / no-ledger card in
    //     the current period, any line in an upcoming period (nothing is observed yet), and a HELOC whose account has no
    //     publication card; the one exception to the never-0 rule above;
    //   * missing history withholds it (null, unavailable, with reasons): a line whose paying-side ledger is withheld (a
    //     failed payer sync, incomplete coverage, an unidentified reversal).
    const countedZero = reasons => ({ amount: 0, trust: 'estimated', reasons: ['paid-unavailable-counted-as-zero'].concat(reasons) });
    const withheldPaid = reasons => ({ amount: null, trust: 'unavailable', reasons: ['paid-unavailable'].concat(reasons) });
    // Every line's Paid back is the paying side's (the cards since #1628; the HELOC since Dale's ruling, #821 7161929211: "It can
    // be counted when it leaves the bills account"). The HELOC's own "TFR-FR" receipt is never read for it, so it is neither
    // counted twice nor a reversal (Grok Bot, rule 17, Plan #6).
    const paidTowardOf = (card, pubCard) => {
      // A HELOC whose account has no publication card keeps its unobserved reading: $0 in an upcoming period, withheld in a past
      // one, an estimated $0 in the current one.
      if (card.id === 'heloc' && !pubCard) return future ? countedZero(['future-not-observed'])
        : publication.role !== 'current' ? withheldPaid(['not-current-period']) : countedZero(['heloc-not-observed']);
      const paid = pubCard?.payerPaid;
      if (['current', 'past'].includes(publication.role) && paid && typeof paid.amount === 'number' && Number.isSafeInteger(Math.round(paid.amount * 100))
        && paid.amount >= 0 && ['estimated', 'calculated'].includes(paid.trust) && Array.isArray(paid.reasons)) return paid;
      const reasons = future ? ['future-not-observed']
        : Array.isArray(paid?.reasons) && paid.reasons.length ? paid.reasons : ['paying-side-coverage-incomplete'];
      return future || (publication.role === 'current' && pubCard?.manualStatement === true && !reasons.includes('payment-direction-unresolved'))
        ? countedZero(reasons) : withheldPaid(reasons);
    };
    // The card's repayment target for the period (Dale, 2026-11-23, OD-028: "if I don't want to go over limit ... this needs to
    // be tacked on, or if there's a fee, that fee needs to be tacked on to what I need to repay onto that card"):
    //   target = max(statement minimum, the period's new charges, the amount that brings an over-limit card under its limit),
    // counted once (desk ruling on Neon 7113251603, Plan #6): the three come from one balance, never summed.
    // New charges are the card's published Spent (pending counted, a replaced pending once; fees and interest are charges).
    // The over-limit amount is Forecast.utilisation's overLimitBy for the card, a figure as of today, so it counts in the
    // current period only (overLimitOf). Where Spent is withheld the target is the larger of the minimum and the over-limit
    // amount, a lower bound tagged estimated with its reason; an unknown over-limit is the same. A withheld minimum withholds the target. Never a
    // confident wrong number. The HELOC keeps its own rule: its target is its minimum.
    const utilRows = Array.isArray(utilisation) ? utilisation : null;
    const overLimitOf = (id, card) => {
      if (publication.role !== 'current') return { cents: 0, trust: 'calculated', reasons: [] };
      if (!utilRows) return { cents: 0, trust: 'estimated', reasons: ['over-limit-unavailable'] };
      const rows = utilRows.filter(row => row && row.id === id);
      if (rows.length > 1) return { cents: 0, trust: 'estimated', reasons: ['over-limit-unavailable'] };
      if (!rows.length) return { cents: 0, trust: 'calculated', reasons: [] };
      const by = cents(rows[0].overLimitBy);
      if (by === null) return { cents: 0, trust: 'estimated', reasons: ['over-limit-unknown'] };
      const stale = rows[0].balanceTrust === 'estimated';
      const out = { cents: Math.max(0, by), trust: stale ? 'estimated' : 'calculated',
        reasons: stale ? ['over-limit-balance-estimated'] : [] };
      // This period's posted payments are already off the observed balance, so the observed amount over the limit can be
      // smaller than the amount the period's charges and payments are on (desk, Plan #6, on Neon 7113251603 item 2 and
      // review 7116017401). A payment counts back only where a qualified closing endpoint is tied to the exact provider
      // observation behind utilisation's posted balance; the live route carries no such link (no card balance evidence
      // reaches it), so no payment is ever added back. Where a payment this period could have hidden an overage (the card
      // is over its limit, or its used balance plus its posted payments would be, or its posted payments are unknown), the
      // observed amount stands as a lower bound, estimated with over-limit-payments-unproven. The test only lowers trust; it
      // never raises a figure.
      const paid = card && card.paidPosted;
      const paidCents = paid && paid.amount !== null && paid.amount !== undefined ? cents(paid.amount) : null;
      const used = cents(rows[0].used), limit = cents(rows[0].limit);
      const couldHide = paidCents === null ? true
        : paidCents > 0 && (by > 0 || used === null || limit === null || used + paidCents > limit);
      if (card && card.id !== 'heloc' && couldHide) { out.trust = 'estimated'; out.reasons.push('over-limit-payments-unproven'); }
      return out;
    };
    const targetOf = (card, minimum) => {
      const noneDue = minimum.amount === null && minimum.reasons.includes('no-minimum-due-in-period');
      // The HELOC: its minimum, or a published 0 when none is due this period (nothing to repay, never "withheld").
      if (card.id === 'heloc') return noneDue
        ? { amount: 0, trust: STACK_TRUST_ORDER.includes(splitTrust) ? splitTrust : 'estimated', reasons: [], newCharges: null, minimum: 0, overLimitBy: null }
        : { amount: minimum.amount, trust: minimum.trust, reasons: minimum.reasons.slice(), newCharges: null, minimum: minimum.amount, overLimitBy: null };
      if (minimum.amount === null && !noneDue) return { amount: null, trust: 'unavailable',
        reasons: ['minimum-unavailable'].concat(minimum.reasons), newCharges: null, minimum: null, overLimitBy: null };
      const minCents = noneDue ? 0 : cents(minimum.amount);
      const minTrust = noneDue ? (STACK_TRUST_ORDER.includes(splitTrust) ? splitTrust : 'estimated') : minimum.trust;
      const charges = cents(card.spent.amount);
      const over = overLimitOf(card.id, card);
      const reasons = over.reasons.slice();
      if (charges === null) reasons.push('new-charges-unavailable');
      else if (card.spent.reasons.includes('charge-category-unconfirmed')) reasons.push('charge-category-unconfirmed');
      // What must be repaid this period, counted once (Neon 7113251603 item 2; desk ruling, Plan #6): the minimum, the
      // period's new charges and the amount over the limit come from one balance, so the target is the largest of them,
      // never their sum. Repaying a charge that pushed the card over its limit is the same dollar as bringing it back
      // under; an over-limit amount older than this period's charges is the larger term and stands. The over-limit amount
      // is the observed one (overLimitOf): where a payment this period may have reduced it, the target is a lower bound,
      // estimated, never raised by a payment the balance is not proven to include.
      const amount = Math.max(minCents, charges === null ? 0 : charges, over.cents);
      return { amount: amount / 100,
        trust: weakest(minTrust, charges === null ? 'estimated' : card.spent.trust, over.trust),
        reasons: [...new Set(reasons)],
        newCharges: charges === null ? null : charges / 100, minimum: minCents / 100,
        overLimitBy: over.reasons.includes('over-limit-unknown') || over.reasons.includes('over-limit-unavailable') ? null : over.cents / 100 };
    };
    // The Credit deduction (desk ruling (E), #1573, Plan #6): "The Credit deduction is their sum minus the qualifying charges
    // already counted above, each deducted from that sum only once." Per card:
    //   due = max(0, target − charges already counted above)
    //   deduction = due − the part of the cash already paid beyond its minimum that covers due above the minimum
    // The charges already counted above are the card's charges inside Spent that the Household budget hold, the bills or
    // the item term already deduct, including unassigned purchases admitted to the Other spending hold. Cash paid beyond the minimum
    // (manualCardPaymentBeyondMinimum, its own named term) is deducted there in full; only the part of it that pays the
    // target above the minimum would be counted twice, so only that part is netted: a payment beyond the target stays the
    // cash it is. Floored at 0 (due): a refund never hands cash back through Credit. A withheld target withholds the deduction; withheld counted charges deduct none of them (the
    // target in full, the cautious side), estimated with their reason.
    const beyondOf = id => {
      const v = beyondMinimumPaid instanceof Map ? beyondMinimumPaid.get(id) : null;
      return Number.isSafeInteger(v) && v > 0 ? v : 0;
    };
    const deductionOf = (card, target) => {
      if (target.amount === null) return { amount: null, trust: 'unavailable', reasons: ['target-unavailable'].concat(target.reasons),
        target: null, alreadyCounted: null, beyondMinimumPaid: null };
      const counted = card.chargesCounted || null;
      const countedCents = card.id === 'heloc' ? 0 : counted && counted.amount !== null ? cents(counted.amount) : null;
      const beyond = beyondOf(card.id);
      const reasons = countedCents === null ? ['already-counted-unavailable'] : [];
      const due = Math.max(0, cents(target.amount) - (countedCents || 0));
      const minimumCents = Number.isFinite(target.minimum) ? Math.round(target.minimum * 100) : 0;
      const netted = Math.min(beyond, Math.max(0, due - minimumCents));
      const amount = due - netted;
      // The two parts of target − deduction, published so a reader can show them without subtracting totals (OD-033; desk,
      // Plan #6: no catch-all offset): countedOffset = min(target, alreadyCounted), the part of the target the charges already
      // counted above cover (withheld counted charges cover none of it); beyondNetted = the part of the cash paid beyond the
      // minimum netted here. target − countedOffset − beyondNetted = amount, per line.
      const offset = Math.min(cents(target.amount), countedCents || 0);
      return { amount: amount / 100,
        trust: weakest(target.trust, countedCents === null ? 'estimated' : card.id === 'heloc' ? target.trust : counted.trust),
        reasons, target: target.amount, alreadyCounted: countedCents === null ? null : countedCents / 100,
        beyondMinimumPaid: beyond / 100, countedOffset: offset / 100, beyondNetted: netted / 100 };
    };
    const lines = cards.concat([heloc]).map(card => {
      const minimum = minimumOf(card.id);
      const target = targetOf(card, minimum);
      const deduction = deductionOf(card, target);
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
      const payment = paidTowardOf(card, published(card.id));
      // An unknown target (cents null) is qualified like a positive one: only a known $0 target leaves the row unqualified.
      const targetOpen = cents(target.amount) === null || cents(target.amount) > 0;
      const paidToward = targetOpen ? withUnassignedPayments(payment) : payment;
      // Every line publishes the payer's posted debits.
      const paidBack = paidToward;
      const targetCents = target.amount === null ? null : cents(target.amount);
      // Named debits still show what was sent. An unidentified return leaves repayment progress unresolved.
      const progress = hasUnassignedReversal && targetOpen
        ? { amount: null, trust: 'unavailable', reasons: [...new Set(paidBack.reasons.concat('payment-direction-unresolved'))] }
        : paidBack;
      const towardCents = cents(progress.amount);
      // A lower-bound target cannot establish full repayment. With unknown charges, withhold a remainder
      // below half a dollar because the Stack displays whole dollars and would print it as $0.
      const chargesUnavailable = target.reasons.includes('new-charges-unavailable');
      const remainderCents = targetCents === null || towardCents === null ? null : Math.max(0, targetCents - towardCents);
      const remainderUnavailable = remainderCents === null || (chargesUnavailable && remainderCents < 50);
      const coverageReasons = [...new Set((targetCents === null ? target.reasons : [])
        .concat(towardCents === null ? progress.reasons : [], chargesUnavailable ? ['new-charges-unavailable'] : []))];
      const stillToPayBack = remainderUnavailable
        ? { amount: null, trust: 'unavailable', reasons: coverageReasons }
        : { amount: remainderCents / 100, trust: weakest(target.trust, progress.trust), reasons: [] };
      const targetCovered = remainderUnavailable || chargesUnavailable
        ? { value: 'unknown', trust: 'unavailable', reasons: coverageReasons.slice() }
        : { value: targetCents > 0 && towardCents >= targetCents, trust: weakest(target.trust, progress.trust), reasons: [] };
      // Covered reads posted payments only: a pending payment never by itself makes a minimum covered (lead ruling, 2026-11-22).
      const paidForMinimum = progress;
      const covered = paidForMinimum.amount === null || minimum.amount === null
        || paidForMinimum.reasons.includes('paid-unavailable-counted-as-zero') ? 'unknown'
        : cents(paidForMinimum.amount) >= cents(minimum.amount);
      const { paidPosted, chargesCounted, ...shown } = card;
      return { ...shown, balance, minimum, target, deduction, paidToward, paidBack, stillToPayBack, targetCovered, status, ...(status === null ? { statusReasons: future ? [] : reasons } : {}), toGo,
        minimumCovered: { value: covered,
          trust: covered === 'unknown' ? 'unavailable' : weakest(paidForMinimum.trust, minimum.trust),
          reasons: covered === 'unknown' ? [...new Set(paidForMinimum.reasons.concat(minimum.reasons))] : [] } };
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
    // The minimums due, over every listed credit line, the HELOC included: one membership for "Credit" (lead ruling,
    // ATLAS LEAD 12, 2026-11-22, on Dale's walk of the Stack page). Each line's minimum is its rows of the period's bills
    // split (stackSummary.bills.cardMinimums), the same rows the waterfall's Credit line sums (stackSurplus terms.credit),
    // so the Credit head's due and the waterfall's Credit are one figure. minimumsDue is the sum of those lines' published
    // minimum amounts, withheld (amount null) when any line's minimum is withheld for a reason other than
    // no-minimum-due-in-period, never a partial sum. The counts say how many lines have a minimum due and how many of those
    // are published covered (minimumCovered.value === true), so a bar of covered over due is full only when every due
    // minimum is covered (the HELOC's is published from the paying side, like a card's); they are null when the minimums
    // are withheld. Trust is the weakest input, as for the other totals.
    const minimumOff = line => line.minimum.amount === null && !line.minimum.reasons.includes('no-minimum-due-in-period');
    const withheldMins = lines.filter(minimumOff);
    // A published $0 minimum is nothing owed: it is not due, so it is out of the sum and both counts.
    const dueLines = lines.filter(line => minimumIsDue(line.minimum));
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
      // The paid side of the Credit head: the sum of each due line's paidToward, the HELOC's included (the figure its row
      // prints, one paying-side rule for every line),
      // uncapped (an overpaid card counts its full paid). A $0 when nothing was paid; withheld (null, unavailable, with its
      // reasons) when any due card's paidToward is withheld, never a partial sum. Trust is the weakest of the figures.
      const unseen = dueLines.filter(line => line.paidToward.amount === null);
      totals.minimumsPaid = unseen.length
        ? { amount: null, trust: 'unavailable', reasons: [...new Set(['paid-unavailable'].concat(unseen.flatMap(line => line.paidToward.reasons.filter(r => r !== 'paid-unavailable'))))] }
        : { amount: dueLines.reduce((sum, line) => sum + cents(line.paidToward.amount), 0) / 100,
          trust: dueLines.length ? weakest(...dueLines.map(line => line.paidToward.trust)) : splitTrust,
          reasons: [...new Set(dueLines.flatMap(line => line.paidToward.reasons))] };
      totals.minimumsDueCount = dueLines.length;
      totals.minimumsCoveredCount = dueLines.filter(coveredOn).length;
      // Future payments are unobserved by definition. Their placeholders inherit the scheduled minimum's trust.
      totals.minimumsCoveredTrust = dueLines.length
        ? weakest(...dueLines.flatMap(line => [line.minimum.trust,
          future && line.minimumCovered.value === 'unknown' ? line.minimum.trust : line.minimumCovered.trust]))
        : splitTrust;
    }
    totals.minimumsPaid = withUnassignedPayments(totals.minimumsPaid);
    // The ledger cannot assign this credit back to a card. Withhold the head even when its due-card set is empty.
    if (hasUnassignedReversal) {
      totals.minimumsPaid = { amount: null, trust: 'unavailable',
        reasons: [...new Set(totals.minimumsPaid.reasons.concat('payment-direction-unresolved'))] };
      if (dueLines.length) {
        totals.minimumsCoveredCount = null;
        totals.minimumsCoveredTrust = 'unavailable';
      }
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
    // The Credit deduction over every listed line, the HELOC included (the same membership as the minimums due): withheld
    // (amount null) when any line's deduction is, never a partial sum.
    const offDeduction = lines.filter(line => line.deduction.amount === null);
    totals.deduction = offDeduction.length
      ? { amount: null, trust: 'unavailable', reasons: [...new Set(offDeduction.flatMap(line => line.deduction.reasons))] }
      : { amount: lines.reduce((sum, line) => sum + cents(line.deduction.amount), 0) / 100,
        trust: weakest(...lines.map(line => line.deduction.trust)),
        reasons: [...new Set(lines.flatMap(line => line.deduction.reasons))] };
    Object.assign(totals, creditHeadTotals(lines, unconfirmedPayments));
    return { lines, totals, unconfirmedPayments };
  }
  function creditHeadTotals(lines, unconfirmedPayments) {
    const out = {};
    // The Credit head (OD-052, Dale, 2026-11-25: "it should be [total paid back]/[sum of the card targets]"), over the lines
    // the page shows (stackCreditLines's own, or a current view's retained display lines, #1669). Over those with something
    // to pay back (a target above $0, or a withheld one), the HELOC included: the sum of their printed Paid back over the
    // sum of their targets, so the head adds up against those rows. A line with a published $0 target
    // adds nothing to either side (as a card with no minimum due added nothing to the old head), so a quiet card with no
    // payment evidence never withholds the head. Each side is withheld (amount null) when any of its lines' figures is,
    // never a partial sum. An unidentified return withholds the paid side, as it withholds each such line's progress.
    // targetCovered is true only when every such line is published covered, so an overpaid card never shows another card's
    // shortfall as covered.
    const openLines = lines.filter(line => cents(line.target.amount) === null || cents(line.target.amount) > 0);
    const unseenPaid = openLines.filter(line => line.paidBack.amount === null);
    const reversalHeld = (unconfirmedPayments || []).some(payment => payment.amount < 0) && openLines.length > 0;
    out.paidBack = unseenPaid.length || reversalHeld
      ? { amount: null, trust: 'unavailable',
        reasons: [...new Set(unseenPaid.flatMap(line => line.paidBack.reasons).concat(reversalHeld ? ['payment-direction-unresolved'] : []))] }
      : { amount: openLines.reduce((sum, line) => sum + cents(line.paidBack.amount), 0) / 100,
        trust: openLines.length ? weakest(...openLines.map(line => line.paidBack.trust)) : weakest(...lines.map(line => line.target.trust)),
        reasons: [...new Set(openLines.flatMap(line => line.paidBack.reasons))] };
    const unseenTarget = lines.filter(line => line.target.amount === null);
    out.target = unseenTarget.length
      ? { amount: null, trust: 'unavailable', reasons: [...new Set(unseenTarget.flatMap(line => line.target.reasons))] }
      : { amount: lines.reduce((sum, line) => sum + cents(line.target.amount), 0) / 100,
        trust: weakest(...lines.map(line => line.target.trust)), reasons: [] };
    const coverUnknown = !openLines.length || openLines.some(line => line.targetCovered.value === 'unknown');
    out.targetCovered = coverUnknown
      ? { value: openLines.length ? 'unknown' : false, trust: openLines.length ? 'unavailable' : weakest(...lines.map(line => line.target.trust)),
        reasons: openLines.length ? [...new Set(openLines.flatMap(line => line.targetCovered.reasons))] : [] }
      : { value: openLines.every(line => line.targetCovered.value === true),
        trust: weakest(...openLines.map(line => line.targetCovered.trust)), reasons: [] };
    return out;
  }
  return { publish, stackCards, stackCreditLines, creditHeadTotals };
});
