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
  // The sign goes before the dollar sign (U+2212, no space), as on every other Atlas page.
  // A value that rounds to zero prints unsigned, as budget-blend does.
  const money = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable';
    const abs = Math.abs(value).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (value < 0 && /[1-9]/.test(abs) ? '−$' : '$') + abs;
  };
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
    // Same freshness gate as evidence(): a stale or unapplied overlay names nothing.
    if (!overlay || overlay.applied !== true || overlay.operatingPlan === 'unavailable'
      || !date(asOf) || overlay.effectiveAsOf !== asOf || overlay.observedAsOf !== asOf
      || (data.meta && data.meta.asOf !== asOf)
      || packet.schema !== 'atlas-current-period-actuals/v1' || packet.observationAsOf !== asOf) return [];
    // Forecast.classifyCurrentPeriodTransaction.nearDueBillCandidateHeld is the one test of a hold. A debit it
    // does not hold (across a payday) is Other spending: it is listed with
    // its ledger category and a Lunch Money pointer, never as a possible
    // payment. Without Forecast nothing is called a possible payment.
    const F = forecast();
    return packet.transactions.filter(item => item && item.nearDueBillCandidate
      && item.nearDueBillCandidate.id === row.id && item.nearDueBillCandidate.date === row.date)
      .map(item => {
        const projected = transaction(item, asOf);
        if (!projected) return null;
        const test = F && F.classifyCurrentPeriodTransaction && F.classifyCurrentPeriodTransaction.nearDueBillCandidateHeld;
        const held = typeof test === 'function' && !!test(data.plan, item);
        return held ? projected
          : { ...projected, otherSpending: true, category: text(item.categoryLabel).trim() || 'Uncategorised' };
      }).filter(Boolean);
  }

  function forecast() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      try { return require('./forecast'); } catch (e) { return null; }
    }
    return typeof globalThis === 'object' && globalThis.Forecast ? globalThis.Forecast : null;
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

  // Dale (2026-11-18): the "Last 6 months" box. Prints this row's published
  // payment series (liveOverlay.billPaymentHistory) through
  // Forecast.billPaymentHistorySummary, which owns the buckets, average and
  // range. Dates and amounts only; every value is calculated from Lunch Money
  // and carries the read date. Without a current series it says Unavailable
  // and why. A month with no identified payment is an empty bar, never $0.
  const HISTORY_REASONS = {
    observation: 'the live Lunch Money read is not current',
    'history-unavailable': 'the Lunch Money payment history could not be read',
    'history-incomplete': 'the Lunch Money payment history read was incomplete',
    'history-too-short': 'the payment history read does not reach back six months',
    'no-identity': 'this bill has no payment identity to find its payments by',
    'paid-in-parts': 'this bill is paid in parts, so one debit is not one payment',
    'duplicate-record': 'Lunch Money returned one of this bill\u2019s payments more than once',
    summary: 'the payment history could not be summarised',
  };
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = m => MONTH_NAMES[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
  function historyUnavailable(reason) {
    return '<section class="bill-detail-history" data-bill-history data-bill-history-status="unavailable"'
      + ' data-bill-history-reason="' + escape(reason) + '"><h4>Last 6 months</h4>'
      + '<p class="bill-history-unavailable">Unavailable</p>'
      + '<p>Unavailable · ' + escape(HISTORY_REASONS[reason] || HISTORY_REASONS.summary) + '.</p>'
      + '<p>Average: Unavailable · Range: Unavailable.</p></section>';
  }
  function historyHtml(row, data) {
    const overlay = data && data.liveOverlay;
    const asOf = data && data.plan && data.plan.opening && data.plan.opening.asOf;
    const series = overlay && overlay.billPaymentHistory;
    if (!row || !text(row.id) || !overlay || overlay.applied !== true || overlay.operatingPlan === 'unavailable'
      || !date(asOf) || overlay.effectiveAsOf !== asOf || overlay.observedAsOf !== asOf
      || (data.meta && data.meta.asOf !== asOf)) return historyUnavailable('observation');
    if (!series || series.source !== 'lunchmoney-payment-history') return historyUnavailable('history-unavailable');
    if (series.status !== 'complete') return historyUnavailable(HISTORY_REASONS[series.reason] ? series.reason : 'history-unavailable');
    if (series.asOf !== asOf || !Array.isArray(series.bills)) return historyUnavailable('observation');
    const entries = series.bills.filter(item => item && item.billId === row.id);
    if (!entries.length) return historyUnavailable('no-identity');
    if (entries.length > 1) return historyUnavailable('summary');
    if (entries[0].status === 'unavailable') return historyUnavailable(['paid-in-parts', 'duplicate-record'].includes(entries[0].reason) ? entries[0].reason : 'summary');
    const F = forecast();
    const summary = F && typeof F.billPaymentHistorySummary === 'function'
      ? F.billPaymentHistorySummary(entries[0], series.months) : null;
    if (!summary) return historyUnavailable('summary');
    const read = escape(series.asOf);
    const peak = Math.max(0, ...summary.months.map(m => m.total || 0));
    const bars = summary.months.map(m => {
      const paid = m.total != null;
      const share = paid && peak > 0 ? Math.max(4, Math.round(m.total / peak * 100)) : 0;
      const label = monthLabel(m.month);
      // One payment: its date (the amount is the bar's). Several: each date and amount.
      // A month where a shared-payee row was left out says so, never "No payment identified".
      const left = m.leftOut === true;
      const detail = (!paid ? (left ? 'Payment left out (shared payee)' : 'No payment identified')
        : m.payments.length === 1 ? m.payments[0].date
          : m.payments.map(p => p.date + ' ' + money(p.amount)).join(', '))
        + (paid && left ? ' · a payment left out (shared payee)' : '');
      return '<li data-bill-history-month="' + escape(m.month) + '" data-bill-history-paid="' + (paid ? 'true' : 'false') + '"'
        + (left ? ' data-bill-history-left-out="true"' : '')
        + ' style="--bill-history-share:' + share + '%"'
        + ' aria-label="' + escape(label + ': ' + (paid ? money(m.total) + ' paid, ' + detail : detail)) + '">'
        + '<span class="bill-history-bar" aria-hidden="true"></span>'
        + '<span class="bill-history-month">' + escape(label) + '</span>'
        + '<span class="bill-history-amount">' + escape(paid ? money(m.total) : '—') + '</span>'
        + '<span class="bill-history-dates">' + escape(detail) + '</span></li>';
    }).join('');
    const stats = summary.average == null
      ? 'Average: not enough history · Range: not enough history'
      : 'Average payment: ' + money(summary.average) + ' · Range: ' + money(summary.min) + ' – ' + money(summary.max);
    const left = entries[0].excludedAmbiguous;
    const leftNote = Number.isInteger(left) && left > 0
      ? '<p data-bill-history-excluded>' + escape(String(left)) + (left === 1 ? ' payment matched' : ' payments matched')
        + ' another bill too and ' + (left === 1 ? 'is' : 'are') + ' left out.</p>' : '';
    return '<section class="bill-detail-history" data-bill-history data-bill-history-status="complete">'
      + '<h4>Last 6 months</h4>'
      + '<p class="bill-history-source">Source: Lunch Money posted payments · read ' + read + '</p>'
      + '<ol class="bill-history-months">' + bars + '</ol>'
      + '<p data-bill-history-stats>' + escape(stats) + ' · Lunch Money, read ' + read + '.</p>'
      + leftNote
      + '<p>An empty month means no payment was identified for this bill, not that $0 was paid. A month marked left out had a payment that also matched another bill.</p></section>';
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
    const trusted = paid && row.settlementBasis === 'schedule-trust-on-due';
    const missing = trusted
      ? 'Settled by schedule · payment not observed. The schedule counts this bill as settled on its due date at the scheduled amount.'
      : paid
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
    // The sign note explains a credit. It prints, word for word, whenever a
    // linked transaction is not a plain debit; a plain debit needs none.
    const signNote = found.payments.some(payment => !(payment.amount > 0))
      ? '<p>Debits are positive and credits negative for the transaction account. A card payment may be a credit; the sign alone does not identify a payment, refund or reversal.</p>' : '';
    const proof = payments
      ? '<p>Linked transaction evidence · observation as of ' + escape(found.asOf)
        + '</p><ul class="bill-detail-payments">' + payments + '</ul>'
        + signNote
      : '<p>' + missing + reason + ' Missing evidence does not mean unpaid.</p>';
    const listed = row.status === 'PAID' ? [] : candidates(row, data);
    const held = listed.filter(payment => !payment.otherSpending);
    const counted = listed.filter(payment => payment.otherSpending);
    const candidateProof = held.length
      ? '<p data-bill-payment-candidate>Possible payment — to confirm. A debit from this bill\u2019s payee was not matched to this due date. It does not settle this bill, which stays reserved until it is confirmed.</p><ul class="bill-detail-payments">'
        + held.map(payment => '<li><dl>'
          + fact('Transaction date', payment.date)
          + fact('Transaction amount', money(payment.amount))
          + fact('Transaction account', accountLabel(payment.account, data))
          + fact('Transaction state', payment.pending ? 'Pending — not a posted payment' : 'Posted')
          + '</dl></li>').join('') + '</ul>'
      : '';
    const otherProof = counted.length
      ? '<ul class="bill-detail-payments" data-bill-other-spending>'
        + counted.map(payment => '<li><dl>'
          + fact('Transaction date', payment.date)
          + fact('Transaction amount', money(payment.amount))
          + fact('Category', payment.category)
          + '</dl><p>Review in Lunch Money</p></li>').join('') + '</ul>'
      : '';
    const dateAttr = date(row.date) ? ' data-bill-date="' + escape(row.date) + '"' : '';
    return '<details class="bill-detail" data-bill-detail><summary class="operating-line"'
      + ' data-period-bill="' + escape(row.id) + '" data-bill-status="'
      + escape(text(summary.status) || text(row.status)) + '"' + dateAttr
      + ' data-bill-settlement="' + escape(text(row.settlement)) + '"'
      + (trusted ? ' data-bill-basis="schedule-trust-on-due"' : '') + '>'
      + '<span>' + escape(text(summary.label) || text(row.label) || 'Bill details') + '</span>'
      + '<span>' + escape(summary.amount) + '</span>'
      + '</summary>'
      + '<div class="bill-detail-body"><h4>' + escape(text(row.label) || 'Bill details') + '</h4><dl>'
      + fact('Published status', trusted ? 'Settled by schedule' : text(row.status) || 'Unavailable')
      + fact('Settlement', text(row.settlement) || 'Unavailable')
      + (trusted ? fact('Settlement basis', 'Settled by schedule · payment not observed') : '')
      + fact('Due date', date(row.scheduledDue || row.date)
        ? (row.scheduledDue || row.date)
        : 'Unavailable')
      + (date(row.scheduledDue) && date(row.date) && row.scheduledDue !== row.date
        ? fact('Occurrence date', row.date) : '')
      + fact('Planned', money(row.planned)) + fact('Actual', money(row.actual))
      + fact('Remaining', money(row.remaining))
      + (row.paymentState === 'partly-paid' && typeof row.shortfall === 'number' && row.shortfall > 0
        && (row.shortfallTrust === 'calculated' || row.shortfallTrust === 'estimated')
        ? fact('Partly paid', money(row.shortfall) + ' still to pay') : '')
      + (typeof row.excess === 'number' && row.excess > 0
        && (row.excessTrust === 'calculated' || row.excessTrust === 'estimated')
        ? fact('Paid over planned', money(row.excess) + ' excess'
          + (row.excessReview === true ? ' · Review in Lunch Money' : '')) : '')
      + fact('Planned payer', text(row.payerLabel) || 'Unavailable')
      + '</dl><h4>Payment evidence</h4>' + recordedProof + proof + candidateProof + otherProof
      + historyHtml(row, data) + '</div></details>';
  }

  // The card ledger owns the reasons and their lines (Forecast.CARD_PAYMENT_REASONS, #1416): the page prints the
  // line for the reason it was given, and invents none. A reason the set does not hold (only possible if the rows did
  // not come from Forecast.visaPaymentPublication) prints the ledger's own fail-closed line; with no ledger loaded,
  // the row says only that it is unreconciled.
  function cardPaymentReasonText(reason) {
    const F = forecast();
    const lines = F && F.CARD_PAYMENT_REASONS;
    if (!lines) return 'reason unavailable.';
    return Object.hasOwn(lines, reason || '') ? lines[reason] : lines['payment-reason-unavailable'];
  }

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
    // Lead dispatch 2026-11-18 (Dale): a card payment whose card is
    // unconfirmed, or a card credit whose purpose is unconfirmed, counts
    // toward no card and is listed here To confirm. Printed as
    // supplied by Forecast (cardPurchaseCoverage.toConfirm); no money math.
    const fromLabel = id => id === 'chequing-a' ? 'Bills' : id === 'savings' ? 'Savings' : 'A household account';
    const pendingRows = (coverage && coverage.trust === 'estimated' && Array.isArray(coverage.toConfirm)
      ? coverage.toConfirm : []).filter(row => row && typeof row === 'object');
    // A payment already listed in the Budget To confirm is pointed to, never
    // asked a second time (lead ruling, ATLAS LEAD 11, 2026-11-19).
    const listedElsewhere = coverage && coverage.trust === 'estimated'
      && Number.isInteger(coverage.toConfirmListedUnderHeld) && coverage.toConfirmListedUnderHeld > 0
      ? coverage.toConfirmListedUnderHeld : 0;
    const listedNote = listedElsewhere
      ? '<p data-card-payment-listed-under-held>' + escape(String(listedElsewhere))
        + (listedElsewhere === 1 ? ' card payment whose card is not confirmed is' : ' card payments whose card is not confirmed are')
        + ' listed under To confirm. Until confirmed, it counts toward no card, so card purchases stay set aside.</p>'
      : '';
    const toConfirm = (pendingRows.length
      ? '<div class="visa-payment-to-confirm" data-card-payment-to-confirm data-trust="estimated"><h4>To confirm</h4>'
        + pendingRows.map(row => '<div class="operating-line" data-card-payment-to-confirm-row><span>'
          + escape(text(row.question) || 'To confirm: which card did this pay?') + '</span><span>'
          + escape(date(row.date) ? row.date : 'Date unavailable') + ' · ' + escape(money(row.amount))
          + (text(row.onCard) ? ' · on ' + escape(text(row.onCard)) : ' · from ' + escape(fromLabel(row.fromAccount)))
          + '</span></div>').join('')
        + '<p>Until each row is confirmed, it counts toward no card, so card purchases stay set aside.</p></div>'
      : '') + listedNote;
    if (!payments.length) return carry + toConfirm;
    const blocks = payments.map(row => {
      if (!row || typeof row !== 'object') return '';
      const label = text(row.accountLabel) || 'Visa';
      const when = date(row.date) ? row.date : 'Date unavailable';
      const split = row.status === 'reconciled'
        && typeof row.backfill === 'number' && typeof row.cardPayment === 'number'
        ? 'Confirmed backfill ' + money(row.backfill) + ' / other allocation ' + money(row.cardPayment)
        : 'Unreconciled — ' + cardPaymentReasonText(row.reason);
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
    return carry + toConfirm + '<div class="visa-payment-backfill" data-visa-payment-backfill><h4>Card payment allocations</h4>'
      + blocks + '<p>Household allocation and issuer minimum confirmation are separate.</p></div>';
  }

  return { html, historyHtml, evidence, candidates, visaPaymentsHtml };
});
