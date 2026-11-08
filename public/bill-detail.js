/* Read-only Budget disclosure. Forecast owns the supplied bill row.
 * Consumer: periodBillLine/calendarPeriodBillsHtml in public/plan.js.
 * No fetching, matching, settlement decisions, totals, or retained packets.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BillDetail = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const text = value => typeof value === 'string' ? value : '';
  const escape = value => text(value).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  const money = value => typeof value === 'number' && Number.isFinite(value)
    ? '$' + value.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : 'Unavailable';
  const unavailable = reason => ({ reason, asOf: null, payments: [] });

  // The observer publishes transactionId as the first transactionIds entry.
  // Repeated ids are harmless; disagreeing single/plural links are not.
  function links(row) {
    const hasMany = row.transactionIds != null;
    if (hasMany && !Array.isArray(row.transactionIds)) return null;
    const ids = hasMany ? row.transactionIds.slice() : [];
    if (row.transactionId != null) {
      if (hasMany && !ids.includes(row.transactionId)) return null;
      ids.unshift(row.transactionId);
    }
    if (!ids.length || ids.some(id => !text(id))) return null;
    return [...new Set(ids)];
  }

  function transaction(row, asOf) {
    if (!row || !date(row.date) || row.date > asOf
      || typeof row.amount !== 'number' || !Number.isFinite(row.amount)
      || typeof row.pending !== 'boolean'
      || row.pendingPostedDuplicate === true || row.pendingPostedAmbiguous === true
      || row.contradictoryEvidence === true) return null;
    const account = text(row.atlasAccountId) || text(row.account);
    if (!account || (row.atlasAccountId && row.account && row.atlasAccountId !== row.account)) return null;
    // Explicit projection: provider fields, merchant, notes, tags and raw ids
    // never enter the result, DOM, attributes, or accessible name.
    return { date: row.date, amount: row.amount, account, pending: row.pending };
  }

  function evidence(row, data) {
    const overlay = data && data.liveOverlay;
    const packet = overlay && overlay.currentPeriodActuals;
    const asOf = data && data.plan && data.plan.opening && data.plan.opening.asOf;
    if (!row || !text(row.id) || !date(row.date)) return unavailable('occurrence');
    if (!overlay || overlay.applied !== true || overlay.operatingPlan === 'unavailable'
      || !date(asOf) || overlay.effectiveAsOf !== asOf || overlay.observedAsOf !== asOf
      || (data.meta && data.meta.asOf !== asOf)
      || !packet || packet.schema !== 'atlas-current-period-actuals/v1'
      || packet.observationAsOf !== asOf) return unavailable('observation');
    if (!Array.isArray(packet.representedActuals) || !Array.isArray(packet.transactions)) {
      return unavailable('links');
    }
    const matches = packet.representedActuals.filter(item => item
      && item.id === row.id && item.date === row.date);
    if (!matches.length) return unavailable('links');
    const ids = links(matches[0]);
    if (!ids) return unavailable('links');
    // Exact duplicate occurrences may repeat; conflicting occurrence records
    // must not silently choose one or combine separate evidence claims.
    const signature = item => JSON.stringify([links(item)?.slice().sort(), item.actual, item.postedOn]);
    if (matches.some(item => signature(item) !== signature(matches[0]))) return unavailable('conflict');
    const reused = packet.representedActuals.some(item => item
      && (item.id !== row.id || item.date !== row.date)
      && [item.transactionId, ...(Array.isArray(item.transactionIds) ? item.transactionIds : [])]
        .some(id => ids.includes(id)));
    if (reused) return unavailable('conflict');
    const payments = [];
    for (const id of ids) {
      const found = packet.transactions.filter(item => item && item.id === id);
      if (!found.length) return unavailable('links');
      const projected = found.map(item => transaction(item, asOf));
      if (projected.some(item => !item)) return unavailable('transaction');
      if (projected.some(item => JSON.stringify(item) !== JSON.stringify(projected[0]))) {
        return unavailable('conflict');
      }
      payments.push(projected[0]);
    }
    return { reason: null, asOf, payments };
  }

  // #962 D3: debits the observer held as a probable payment of this exact
  // occurrence (bill identity, date within days of the due date). They are
  // shown as to-confirm candidates only; they never settle the bill.
  function candidates(row, data) {
    const overlay = data && data.liveOverlay;
    const packet = overlay && overlay.currentPeriodActuals;
    const asOf = data && data.plan && data.plan.opening && data.plan.opening.asOf;
    if (!row || !text(row.id) || !date(row.date) || !packet || !Array.isArray(packet.transactions)) return [];
    return packet.transactions.filter(item => item && item.nearDueBillCandidate
      && item.nearDueBillCandidate.id === row.id && item.nearDueBillCandidate.date === row.date)
      .map(item => transaction(item, asOf)).filter(Boolean);
  }

  function accountLabel(id, data) {
    const cash = data && data.plan && data.plan.startingCash;
    const rows = [...(cash && cash.breakdown || []), ...(cash && cash.heldElsewhere || []),
      ...(data && data.debts || []), ...(data && data.revolvingExtra || [])];
    const labels = [...new Set(rows.filter(row => row && row.id === id)
      .map(row => text(row.label)).filter(Boolean))];
    return labels.length === 1 ? labels[0] : 'Account label unavailable';
  }

  function fact(label, value) {
    return '<div><dt>' + escape(label) + '</dt><dd>' + escape(value) + '</dd></div>';
  }

  // summary contains only plain display strings from the incumbent row printer
  // (glanceLineLabel/glanceSignedMoney); it is escaped, never trusted markup.
  // Replacing this HTML on refresh/period switch intentionally closes details
  // and discards all prior evidence. There is no transaction-id cache.
  function html(row, data, summary) {
    row = row || {};
    summary = summary || {};
    const found = evidence(row, data);
    const paid = row.status === 'PAID';
    const recorded = row.cashPaymentStatus === 'sent'
      && ['paid', 'partial', 'sent'].includes(row.householdPaymentStatus);
    const sentDates = Array.isArray(row.cashSentDates) ? row.cashSentDates.filter(date) : [];
    const recordedProof = row.cashPaymentStatus === 'sent' && row.householdPaymentStatus === 'unconfirmed'
      ? '<p>Payment allocation unconfirmed. Records reuse the same payment with conflicting or duplicate allocations. The household payment action cannot be confirmed.</p><dl>'
        + fact('Lender minimum confirmation', row.issuerMinimumStatus === 'satisfied' ? 'Confirmed' : 'Not confirmed')
        + fact('Included in cash opening', row.cashInclusionStatus === 'included' ? 'Confirmed' : 'Not confirmed')
        + '</dl>'
      : recorded ? '<p>'
      + (row.householdPaymentStatus === 'paid' ? 'Paid — money sent toward this minimum.'
        : row.householdPaymentStatus === 'partial' ? 'Partial payment sent toward this minimum.'
          : 'Money sent toward this minimum; the full required amount is not confirmed.')
      + ' This records the household payment action, not lender confirmation.</p><dl>'
      + fact('Money sent', money(row.cashPaid))
      + fact('Sent on', sentDates.length ? sentDates.join(', ') : 'Unavailable')
      + fact('Lender minimum confirmation', row.issuerMinimumStatus === 'satisfied' ? 'Confirmed' : 'Not confirmed')
      + fact('Included in cash opening', row.cashInclusionStatus === 'included' ? 'Confirmed' : 'Not confirmed')
      + '</dl>' : '';
    const missing = paid
      ? 'This bill is marked PAID by Forecast. Transaction evidence is unavailable.'
      : 'Transaction evidence is unavailable for this bill occurrence.';
    const reason = found.reason === 'conflict' ? ' The linked records conflict.' : '';
    const payments = found.payments.map(payment => '<li><dl>'
      + fact('Transaction date', payment.date)
      + fact('Transaction amount', money(payment.amount) + ' ('
        + (payment.amount > 0 ? 'debit' : payment.amount < 0 ? 'credit' : 'direction unavailable') + ')')
      + fact('Transaction account', accountLabel(payment.account, data))
      + fact('Transaction state', payment.pending ? 'Pending — not a posted payment' : 'Posted')
      + '</dl></li>').join('');
    const proof = payments
      ? '<p>Linked transaction evidence · observation as of ' + escape(found.asOf)
        + '</p><ul class="bill-detail-payments">' + payments + '</ul>'
        + '<p>Debits are positive and credits negative for the transaction account. A card payment may be a credit; the sign alone does not identify a payment, refund or reversal.</p>'
        + '<p>Transaction state does not change Forecast’s published bill status or amounts.</p>'
      : '<p>' + missing + reason + ' Missing evidence does not mean unpaid.</p>';
    const held = row.status === 'PAID' ? [] : candidates(row, data);
    const candidateProof = held.length
      ? '<p data-bill-payment-candidate>Possible payment — to confirm. A debit from this bill\u2019s payee was not matched to this due date. It is kept out of household spending, and this bill stays reserved until it is confirmed.</p><ul class="bill-detail-payments">'
        + held.map(payment => '<li><dl>'
          + fact('Transaction date', payment.date)
          + fact('Transaction amount', money(payment.amount))
          + fact('Transaction account', accountLabel(payment.account, data))
          + fact('Transaction state', payment.pending ? 'Pending — not a posted payment' : 'Posted')
          + '</dl></li>').join('') + '</ul>'
      : '';
    const dateAttr = date(row.date) ? ' data-bill-date="' + escape(row.date) + '"' : '';
    return '<details class="bill-detail" data-bill-detail><summary class="operating-line"'
      + ' data-period-bill="' + escape(row.id) + '" data-bill-status="'
      + escape(text(summary.status) || text(row.status)) + '"' + dateAttr
      + ' data-bill-settlement="' + escape(text(row.settlement)) + '">'
      + '<span>' + escape(text(summary.label) || text(row.label) || 'Bill details') + '</span>'
      + '<span>' + escape(summary.amount) + '</span>'
      + '</summary>'
      + '<div class="bill-detail-body"><h4>' + escape(text(row.label) || 'Bill details') + '</h4><dl>'
      + fact('Published status', text(row.status) || 'Unavailable')
      + fact('Settlement', text(row.settlement) || 'Unavailable')
      + fact('Due date', date(row.date)
        ? row.date + (row.dateConfidence === 'estimated' ? ' · estimated' : '')
        : 'Unavailable')
      + fact('Planned', money(row.planned)) + fact('Actual', money(row.actual))
      + fact('Remaining', money(row.remaining))
      + fact('Planned payer', text(row.payerLabel) || 'Unavailable')
      + fact('Published confidence', text(row.confidence) || 'Unavailable')
      + '</dl><h4>Payment evidence</h4>' + recordedProof + proof + candidateProof + '</div></details>';
  }
  const VISA_REASONS = {
    'payment-intent-unconfirmed': 'Link the Bills debit and confirm which purchases this payment covers. Amount and timing do not prove its purpose.',
    'incomplete-evidence': 'The purchase window is incomplete, so this payment is not split.',
    'ambiguous-credit': 'A credit in the window is neither a payment nor a refund.',
    'pending-possible-replacement': 'Pending and posted entries do not establish one purchase.',
    'pending-settlement-ambiguous': 'Pending and posted entries do not establish one purchase.',
    'missing-amount': 'The payment amount is missing.',
    'missing-date': 'The payment date is missing.',
    'missing-account': 'The card account is missing.',
    'contradictory-account': 'The card account is contradictory.',
    'missing-identity': 'The payment has no transaction identity.',
  };

  // Formats Forecast.visaPaymentPublication rows. No addition, comparison,
  // or other money math: backfill and card payment are printed as supplied.
  function visaPaymentsHtml(rows, coverage) {
    const payments = Array.isArray(rows) ? rows : [];
    const earlier = coverage && coverage.earlierPeriods;
    const carry = earlier && (earlier.status === 'ready' || earlier.status === 'unconfirmed')
      ? '<details class="bill-detail" data-card-earlier-periods><summary><span>Earlier periods</span><span>'
        + escape(earlier.status === 'ready' ? money(earlier.remaining) + ' still to cover' : 'Coverage unconfirmed')
        + '</span></summary><div class="bill-detail-body">'
        + (earlier.status === 'ready' ? (Array.isArray(earlier.cards) ? earlier.cards : []).map(card =>
          '<div class="operating-line"><span>' + escape(text(card.accountLabel) || 'Credit card')
          + ' · ' + escape(String(card.purchaseCount)) + ' purchase(s) · '
          + escape(date(card.earliestDate) ? card.earliestDate : 'Date unavailable')
          + ' – ' + escape(date(card.latestDate) ? card.latestDate : 'Date unavailable')
          + '</span><span>' + escape(money(card.remaining)) + '</span></div>'
          + '<ul class="visa-payment-purchases">'
          + (Array.isArray(card.purchases) ? card.purchases : []).map(purchase =>
            '<li>' + escape(date(purchase.date) ? purchase.date : 'Date unavailable')
            + ' · ' + escape(text(purchase.categoryLabel) || 'Category unavailable')
            + ' · ' + escape(money(purchase.remaining)) + ' still to cover</li>').join('')
          + '</ul>').join('')
          + '<p>Opening and earlier purchases carry forward until confirmed coverage or refund. This disclosure does not add them to current-period spending.</p>'
          : '<p>Confirm the opening and purchase/payment evidence before using available cash. Earlier coverage has not been established.</p>')
        + '</div></details>' : '';
    if (!payments.length) return carry;
    const blocks = payments.map(row => {
      if (!row || typeof row !== 'object') return '';
      const label = text(row.accountLabel) || 'Visa';
      const when = date(row.date) ? row.date : 'Date unavailable';
      const split = row.status === 'reconciled'
        && typeof row.backfill === 'number' && typeof row.cardPayment === 'number'
        ? 'Confirmed backfill ' + money(row.backfill) + ' / other allocation ' + money(row.cardPayment)
        : 'Unreconciled — ' + (VISA_REASONS[row.reason] || 'This payment could not be reconciled.');
      const covered = (Array.isArray(row.purchases) ? row.purchases : []).map(item =>
        '<li>' + escape(date(item && item.date) ? item.date : 'Date unavailable')
        + ' · ' + escape(money(item && item.amount))
        + ' · ' + escape(text(item && item.categoryLabel) || 'Category unavailable')
        + '</li>').join('');
      return '<div class="operating-line" data-visa-payment="' + escape(text(row.status) || 'unreconciled')
        + '"><span>' + escape(label) + ' · ' + escape(when) + '</span><span>'
        + escape(split) + '</span></div>'
        + (covered ? '<ul class="visa-payment-purchases">' + covered + '</ul>' : '');
    }).join('');
    // Purchases live in their original category transaction rows. Keep this
    // drawer for payment allocation evidence, without a second purchase list.
    return carry + '<div class="visa-payment-backfill" data-visa-payment-backfill><h4>Card payment allocations</h4>'
      + blocks + '<p>Household allocation and issuer minimum confirmation are separate.</p></div>';
  }

  return { html, evidence, candidates, visaPaymentsHtml };
});
