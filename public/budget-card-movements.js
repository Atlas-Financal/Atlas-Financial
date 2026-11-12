'use strict';
/* Copy Forecast's sealed card movement publication. No ledger arithmetic,
 * balance inference, minimum allocation, provider calls or money writes.
 * Card detail opens through the native Budget detail sheet
 * (budgetDetailSheetController in public/plan.js): the trigger carries
 * aria-haspopup="dialog" and, once wired, aria-controls naming the actual
 * dialog. There is no inline expansion state here — the sheet controller
 * records the stable card identity (data-budget-card-toggle /
 * data-budget-card-panel) at open() and restores it across remounts. */
(function init(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BudgetCardMovements = api;
})(globalThis, function buildApi() {
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reasons = {
    'opening-unavailable': 'Opening balance unavailable', 'closing-unavailable': 'Closing balance unavailable',
    'opening-unqualified': 'Opening evidence unconfirmed', 'closing-unqualified': 'Closing evidence unconfirmed',
    'posted-coverage-incomplete': 'Posted coverage incomplete', 'observation-unavailable': 'Observation unavailable',
    'future-not-observed': 'Future period not observed', 'selected-period-unavailable': 'Selected period unavailable',
    'balance-ledger-discrepancy': 'Balances and posted activity do not reconcile',
    'endpoint-identity-conflict': 'Balance evidence conflicts', 'unmapped-card-identity': 'Account identity unconfirmed',
    'transaction-evidence-unconfirmed': 'Transaction evidence unconfirmed', 'transaction-amount-unqualified': 'Transaction amount unconfirmed',
    'transaction-date-unqualified': 'Transaction date unconfirmed', 'transaction-identity-unqualified': 'Transaction identity unconfirmed',
    'duplicate-identity': 'Duplicate transaction identity', 'parent-coverage-unqualified': 'Split transaction coverage unconfirmed',
    'movement-total-overflow': 'Movement total unavailable'
  };
  const kinds = { charge: 'Posted charge', payment: 'Posted payment · household purpose unconfirmed',
    refund: 'Posted refund', interest: 'Posted interest', 'credit-unconfirmed': 'Credit · type unconfirmed',
    'movement-unconfirmed': 'Movement · type unconfirmed' };
  // Face rule (Atlas UI task 2 second follow-on): the trigger's
  // right-hand slot prints the publication's own reported balance as the
  // bare amount — no 'Balance' prefix, no as-of date, no source suffix,
  // for every card — or, when the publication carries no usable reported
  // balance, the state word 'Unavailable' in the same slot. A malformed
  // (non-finite or non-numeric) amount is rejected the same way, never
  // rendered as a figure. Provenance — the dated observation and its
  // manual-statement source — lives in the detail panel, which keeps the
  // complete evidence for every card. The panel is unchanged by this
  // rule — it prints no net figure, only its pre-existing evidence
  // wording (for example 'Net change remains unavailable.' when a card
  // carries reasons).
  // Period direction line (owner request, #821 6809860818; Dale picked
  // option B): under the balance, the face copies Forecast's own posted
  // net change for the selected period — '+$X this period' when more went
  // onto the card than came off it, '−$X this period' for the reverse,
  // 'No change this period' for a true zero. It prints only when the
  // card is 'ready', carries no reasons, and its netChange is complete and
  // calculated with a finite magnitude and a known direction; otherwise
  // nothing prints (never an estimate, never a more certain tag). The
  // sign and words carry the direction; colour only repeats them. The
  // page does no arithmetic: magnitude and direction are printed as
  // published, and pending activity is not part of it.
  // Face display name: the Amazon card — canonical id 'mbna' in
  // Forecast's identity table — prints exactly 'Amazon' on the trigger;
  // every other card keeps its publication label, and the panel heading
  // and screen-reader action keep the full publication label.
  // Heading rule (Systems Review 5485851551 R1): the strip's semantic
  // heading and the region's accessible name are exactly 'Credit cards'
  // in every state — no 'Card movement' name and no period dates in the
  // heading. The blend skin's painted tile title repeats the same words;
  // the contract lives here, in the semantics every skin shares.
  // A manual-statement balance dated before the page's own date prints a
  // small "as of <date>" beside it. Display only: a provider-fresh row, a
  // same-day statement and an undated one print exactly as before.
  const staleManual = (card, asOf) => card.manualStatement === true && typeof asOf === 'string'
    && typeof card.reportedBalance?.date === 'string' && card.reportedBalance.date < asOf;
  const balance = (card, money, day, asOf) => {
    const reported = card.reportedBalance;
    if (!reported || typeof reported.amount !== 'number' || !Number.isFinite(reported.amount))
      return '<span class="card-movement-sr">Reported balance </span><span class="card-movement-balance is-unavailable">Unavailable</span>';
    const note = staleManual(card, asOf) ? ` <small class="card-movement-asof" data-card-movement-asof>as of ${day(reported.date)}</small>` : '';
    return `<span class="card-movement-sr">Reported balance </span><span class="card-movement-balance">${money(reported.amount)}${note}</span>`;
  };
  const movement = (card, money) => {
    const net = card.netChange;
    if (card.status !== 'ready' || !Array.isArray(card.reasons) || card.reasons.length || !net
      || net.completeness !== 'complete' || net.trust !== 'calculated'
      || typeof net.magnitude !== 'number' || !Number.isFinite(net.magnitude)
      || !['up', 'down', 'flat'].includes(net.direction)) return '';
    const text = net.direction === 'up' ? `+${money(net.magnitude)} this period`
      : net.direction === 'down' ? `−${money(net.magnitude)} this period` : 'No change this period';
    return `<span class="card-movement-net is-${escape(net.direction)}" data-card-movement-net="${escape(net.direction)}">${text}</span>`;
  };
  function html(pub, format) {
    if (!pub || pub.schema !== 'atlas-card-period-movements/v1'
      || pub.source !== 'Forecast.cardPeriodMovements' || pub.currency !== 'CAD' || !Array.isArray(pub.cards)) return '';
    const money = value => typeof value === 'number' && Number.isFinite(value) ? escape(format.money(value)) : 'Unavailable';
    // One malformed card or transaction degrades only itself: it prints an
    // Unavailable row and every other card and row still renders.
    const safe = (render, fallback) => item => {
      try { return render(item); } catch (err) { return fallback(item); }
    };
    const cardName = card => escape(card && typeof card.label === 'string' && card.label ? card.label : 'Card');
    const cardId = card => escape(card && card.id != null ? card.id : '');
    const rows = list => (Array.isArray(list) ? list : []);
    // A missing or non-list collection is unreadable, never an observed empty
    // list: it can never support "no movements returned".
    const unreadableList = name => `<p class="card-movement-note" data-card-movement-list="unavailable">${name} activity unavailable — this list could not be read.</p>`;
    const day = value => value ? escape(format.date(value)) : 'Date unavailable';
    const allocationConfirmed = tx => {
      const row = tx && tx.paymentAllocation;
      return row?.status === 'reconciled' && !tx.pending
        && ['payment', 'reversal'].includes(row.kind)
        && typeof row.backfill === 'number' && Number.isFinite(row.backfill) && row.backfill >= 0
        && typeof row.cardPayment === 'number' && Number.isFinite(row.cardPayment) && row.cardPayment >= 0;
    };
    const allocation = tx => {
      const row = tx.paymentAllocation;
      if (!row) return '';
      const confirmed = allocationConfirmed(tx);
      const why = {
        'coverage-reversal-unconfirmed': 'Reversal match or allocation unconfirmed.',
        'coverage-identity-ambiguous': 'Transaction identity ambiguous; allocation unconfirmed.',
        'coverage-replacement-ambiguous': 'Pending/posted identity unconfirmed; allocation unavailable.',
        'coverage-currency-or-amount-unconfirmed': 'Transaction units or amount unconfirmed.',
        'coverage-allocation-conflict': 'Allocation claims conflict; purchase coverage unconfirmed.',
        'coverage-reversal-allocation-conflict': 'Reversal allocation claims conflict; amounts unconfirmed.',
        'credit-type-or-purpose-unconfirmed': 'Credit type and household purpose unconfirmed.'
      };
      const text = confirmed
        ? row.kind === 'reversal'
          ? 'Confirmed allocation reversal: purchase coverage removed ' + money(row.backfill) + ' / other allocation reversed ' + money(row.cardPayment)
          : 'Confirmed payment allocation: purchase coverage ' + money(row.backfill) + ' / other allocation ' + money(row.cardPayment)
        : escape(why[row.reason] || 'Payment match or purchase purpose unconfirmed.');
      const purchases = confirmed ? (Array.isArray(row.purchases) ? row.purchases : []).map(purchase =>
        '<small>' + day(purchase.date) + ' · ' + escape(purchase.categoryLabel || 'Category unavailable')
          + ' · ' + money(purchase.amount) + '</small>').join('') : '';
      return '<small data-card-payment-allocation="' + (confirmed ? 'reconciled' : 'unreconciled') + '">'
        + text + '</small>' + purchases;
    };
    // The payment cautions qualify movements. They print, word for word,
    // unless the panel itself states an observed empty period: both lists
    // read, both empty, both under a complete provider response, and not a
    // future period. An unreadable list, incomplete coverage or a future
    // period is not an observed empty list, so the caution stays. The
    // allocation caution prints whenever a listed row carries an allocation.
    const observedEmpty = card => Array.isArray(card.posted) && card.posted.length === 0
      && Array.isArray(card.pending) && card.pending.length === 0
      && card.postedCoverage === 'complete-provider-response'
      && card.pendingCoverage === 'complete-provider-response' && pub.role !== 'future';
    const listed = card => !observedEmpty(card);
    const allocated = card => [...rows(card.posted), ...rows(card.pending)].some(tx => tx && tx.paymentAllocation);
    const reported = card => card.reportedBalance && typeof card.reportedBalance.amount === 'number'
      && Number.isFinite(card.reportedBalance.amount) ? card.reportedBalance : null;
    // Panel lead (Atlas-approved card-detail panel cleanup): the panel
    // opens with the publication's own reported balance — the amount, its
    // as-of date and the manual-statement qualification stay attached to
    // the lead — or with the unavailable state when the publication
    // carries no usable reported balance. Nothing is inferred: a missing
    // balance is never printed as $0.00, and a published $0 stays $0.00.
    const lead = card => {
      const stock = reported(card);
      return stock
        ? `<p class="card-movement-lead">Reported balance ${money(stock.amount)} · ${day(stock.date)}${card.manualStatement ? ' · Manual statement observation' : ''}</p>`
        : '<p class="card-movement-lead">Reported balance Unavailable</p>';
    };
    // The period endpoints and their remnant evidence sit behind one
    // native disclosure, collapsed initially. Every figure, date and
    // qualification that printed before still prints, verbatim, inside.
    const balanceDetails = card => `<details class="card-movement-details"><summary>Balance and payment details</summary>
        <div class="card-movement-balances"><span><small>Opening · ${day(card.opening?.date)}</small><strong>${money(card.opening?.amount)}</strong></span><span><small>Closing · ${day(card.closing?.date)}</small><strong>${money(card.closing?.amount)}</strong></span></div>
        ${card.reasons.length ? `<p class="card-movement-evidence">${card.reasons.map(reason => escape(reasons[reason] || 'Evidence unconfirmed')).join(' · ')}. Net change remains unavailable.</p>` : ''}
        ${reported(card) ? '<p class="card-movement-evidence">This dated observation does not establish both period endpoints.</p>' : ''}
        ${pub.observationAsOf ? `<p class="card-movement-evidence">Provider observation · ${day(pub.observationAsOf)}</p>` : ''}
      </details>`;
    const transactionRow = tx => `<div class="card-movement-row" data-card-movement-transaction="${escape(tx.id)}" data-card-movement-kind="${escape(tx.kind)}">
      <time datetime="${escape(tx.date)}">${day(tx.date)}</time><span><b>${escape(typeof tx.displayName === 'string' && tx.displayName ? tx.displayName : tx.payee)}</b><small>${tx.pending ? 'Pending authorization' : allocationConfirmed(tx) ? tx.paymentAllocation.kind === 'reversal' ? 'Posted allocation reversal' : 'Posted payment' : tx.paymentAllocation?.kind === 'reversal' ? 'Posted movement · reversal allocation unconfirmed' : escape(kinds[tx.kind] || 'Movement · type unconfirmed')}</small>${allocation(tx)}</span>
      <span class="card-movement-amount ${tx.pending ? '' : 'is-' + escape(tx.direction)}">${tx.direction === 'up' ? '+' : tx.direction === 'down' ? '−' : ''}${money(tx.magnitude)}</span></div>`;
    const transaction = safe(transactionRow, () =>
      '<div class="card-movement-row" data-card-movement-transaction="unavailable"><span><b>Transaction unavailable</b><small>This row could not be read</small></span><span class="card-movement-amount">Unavailable</span></div>');
    const trigger = safe(card => `<button type="button" class="card-movement-trigger" data-budget-card-toggle="${escape(card.id)}" aria-haspopup="dialog"><span class="card-movement-title">${escape(card.id === 'mbna' ? 'Amazon' : card.label)}<span class="card-movement-chevron" aria-hidden="true">⌄</span></span>${balance(card, money, day, pub.asOf)}${movement(card, money)}<span class="card-movement-sr">Show ${escape(card.label)} activity</span></button>`,
      card => `<button type="button" class="card-movement-trigger" data-budget-card-toggle="${cardId(card)}" data-card-movement-unavailable="true" aria-haspopup="dialog"><span class="card-movement-title">${cardName(card)}<span class="card-movement-chevron" aria-hidden="true">⌄</span></span><span class="card-movement-balance is-unavailable">Unavailable</span><span class="card-movement-sr">Show ${cardName(card)} activity</span></button>`);
    return `<section class="card-movement-strip" data-budget-card-movements data-card-period-start="${escape(pub.start)}" data-card-period-end="${escape(pub.end)}" aria-label="Credit cards">
      <div class="card-movement-heading"><h2>Credit cards</h2><p>Posted${pub.through ? ' through ' + day(pub.through) : ' activity not observed'}</p></div>
      <div class="card-movement-track">${pub.cards.map(trigger).join('')}</div>
      ${pub.cards.map(safe(card => `<section class="card-movement-panel" id="budget-card-panel-${escape(card.id)}" data-budget-card-panel="${escape(card.id)}" aria-label="${escape(card.label)} activity" hidden>
        ${lead(card)}
        ${balanceDetails(card)}
        <h4 class="card-movement-ledger-heading">Posted activity${!Array.isArray(card.posted) ? ' · unavailable' : card.postedCoverage === 'complete-provider-response' ? '' : ' · coverage incomplete'}</h4>
        ${!Array.isArray(card.posted) ? unreadableList('Posted') : card.posted.map(transaction).join('') || `<p class="card-movement-note">${card.postedCoverage === 'complete-provider-response' && pub.role !== 'future' ? 'No posted movements returned in this period.' : 'No qualified posted activity available.'}</p>`}
        <div class="card-movement-pending"><h4 class="card-movement-ledger-heading">Pending</h4>${!Array.isArray(card.pending) ? unreadableList('Pending') : card.pending.map(transaction).join('') || `<p class="card-movement-note">${card.pendingCoverage === 'complete-provider-response' ? 'No pending authorizations returned.' : card.pendingCoverage === 'not-observed' ? 'Pending activity not observed for this selected period.' : 'Pending coverage unavailable.'}</p>`}</div>
        ${listed(card) ? `<p class="card-movement-note">Payments reduce the ${card.id === 'heloc' ? 'HELOC' : 'card'} balance. ${card.id !== 'heloc' && rows(card.posted).some(allocationConfirmed) ? 'Household allocation does not automatically settle scheduled minimums; lender confirmation remains separate.' : 'Purpose unconfirmed: payments do not automatically settle scheduled minimums; lender confirmation remains separate.'}</p>` : ''}
        ${card.id !== 'heloc' && allocated(card) ? '<p class="card-movement-note">Payment and reversal allocations are shown separately. This window does not establish historical coverage or available cash. Issuer minimum satisfaction remains separate.</p>' : ''}
      </section>`, card => `<section class="card-movement-panel" id="budget-card-panel-${cardId(card)}" data-budget-card-panel="${cardId(card)}" data-card-movement-unavailable="true" aria-label="${cardName(card)} activity" hidden><p class="card-movement-lead">${cardName(card)} activity unavailable — this card could not be read.</p></section>`)).join('')}</section>`;
  }
  function wire(mount, sheet) {
    if (!mount || typeof mount.querySelector !== 'function') return;
    const strip = mount.querySelector('[data-budget-card-movements]');
    if (!strip) return;
    const dialog = mount.querySelector('[data-budget-detail-sheet]');
    const buttons = [...strip.querySelectorAll('[data-budget-card-toggle]')];
    const panels = [...strip.querySelectorAll('[data-budget-card-panel]')];
    buttons.forEach(button => {
      button.setAttribute('aria-haspopup', 'dialog');
      if (dialog?.id) button.setAttribute('aria-controls', dialog.id);
      button.addEventListener('click', () => {
        if (!sheet || typeof sheet.open !== 'function') return;
        const id = button.getAttribute('data-budget-card-toggle');
        const panel = panels.find(node => node.getAttribute('data-budget-card-panel') === id);
        if (!panel) return;
        // The sheet re-homes this same panel node across opens, so an
        // expanded balance disclosure would otherwise survive a close;
        // the panel always opens with the disclosure collapsed.
        const details = typeof panel.querySelector === 'function'
          ? panel.querySelector('details.card-movement-details') : null;
        if (details) details.open = false;
        sheet.open(panel, button, panel.getAttribute('aria-label') || 'Card activity');
      });
    });
  }
  return { html, wire };
});
