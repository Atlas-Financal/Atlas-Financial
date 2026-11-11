'use strict';
/* Presentation only. Forecast owns the supplied transfer publication.
 * No fetch, saved decisions, financial arithmetic, provider IDs or keyword
 * inference. Positions are transient display navigation, never saved identity.
 * The single native Budget detail controller owns focus, Escape and dismissal.
 */
(function init(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TransactionReview = api;
})(globalThis, function buildApi() {
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  const account = id => ({ 'chequing-a': 'Bills account', 'chequing-b': 'Weekly spending account', savings: 'Savings' })[id] || 'Account unavailable';
  const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? '$' + value.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'Amount unavailable';
  function html(pub, { current = false } = {}) {
    const status = current && typeof pub?.status === 'string' ? pub.status : 'unavailable-missing';
    const observable = ['available-complete', 'available-posted-only', 'available-incomplete'].includes(status);
    const items = observable && Array.isArray(pub?.items) ? pub.items : [];
    const state = !current ? 'Choose the current pay period to inspect its observed transfers.'
      : status === 'unavailable-stale' ? 'Transaction evidence is not current. Current transfers cannot be confirmed.'
      : !observable ? 'Transaction evidence is unavailable. Current transfers cannot be confirmed.'
      : status === 'available-complete' ? (items.length ? 'Observed outgoing transfers for the current pay period.' : 'No unresolved outgoing transfers are listed in this current-period publication.')
      : 'Only an observed subset is available. Pending or transaction coverage is incomplete; additional transfers may exist.';
    const facts = items.map((item, index) => {
      // Only these Forecast-published display facts cross into HTML. Even if
      // the supplied row later grows, notes/payees/raw IDs never cross here.
      const label = date(item?.date) ? new Date(item.date + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Date unavailable';
      return '<article data-review-item' + (index ? ' hidden' : '') + '>'
        + '<p class="atlas-review-position" data-review-position>' + (index + 1) + ' of ' + items.length + ' observed transfers</p>'
        + '<h3>Outgoing e-transfer</h3><dl class="atlas-review-facts">'
        + '<div><dt>Date</dt><dd>' + escape(label) + '</dd></div>'
        + '<div><dt>Amount</dt><dd>' + escape(money(item?.amount)) + '</dd></div>'
        + '<div><dt>Account</dt><dd>' + escape(account(item?.account)) + '</dd></div>'
        + '<div><dt>Posting</dt><dd>' + (item?.pending === true ? 'Pending' : item?.pending === false ? 'Posted' : 'Unconfirmed') + '</dd></div></dl>'
        + '<h4>What was this transfer for?</h4><p>Purpose not yet confirmed.</p>'
        + '<p class="atlas-review-consequence">A purpose answer would not prove bill settlement, allocate a card payment, or establish account completeness.</p></article>';
    }).join('');
    return '<p class="atlas-review-mode">Read-only review</p>'
      + facts + (items.length > 1 ? '<nav class="atlas-review-navigation" aria-label="Observed transfer navigation"><button type="button" data-review-previous disabled>Previous transfer</button><button type="button" data-review-next>Next transfer</button></nav>' : '')
      + '<p>' + escape(state) + '</p>'
      + '<p class="atlas-review-coverage">The total number of owner questions is unavailable. Purchase and payment match review coverage is not yet connected.</p>';
  }
  function wire(mount, sheet, input) {
    const doc = mount?.ownerDocument;
    if (!doc || !sheet) return;
    const source = doc.querySelector('[data-transaction-review]');
    const trigger = doc.querySelector('[data-transaction-review-open]');
    const content = source?.querySelector('[data-review-content]');
    const dialog = mount.querySelector('[data-budget-detail-sheet]');
    if (!source || !trigger || !content || !dialog) return;
    const markup = html(input.publication, input);
    // Retain the same read-only display nodes across a presentation rerender.
    // Changed projected facts/period replace them. This markup is not saved
    // identity, a decision, or a cached provider/financial packet.
    if (content.reviewMarkup !== markup) {
      content.innerHTML = markup;
      content.reviewMarkup = markup;
    }
    trigger.setAttribute('aria-controls', dialog.id);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Review transactions: total unavailable');
    const items = [...content.querySelectorAll('[data-review-item]')];
    let selected = Math.max(0, items.findIndex(item => !item.hidden));
    const select = next => {
      selected = Math.max(0, Math.min(items.length - 1, next));
      items.forEach((item, i) => { item.hidden = i !== selected; });
      const previous = content.querySelector('[data-review-previous]'), forward = content.querySelector('[data-review-next]');
      if (previous) previous.disabled = selected === 0;
      if (forward) forward.disabled = selected === items.length - 1;
    };
    source.onclick = event => {
      if (event.target.closest('[data-review-return]')) { sheet.close(); return; }
      if (event.target.closest('[data-review-previous]')) select(selected - 1);
      if (event.target.closest('[data-review-next]')) select(selected + 1);
    };
    trigger.onclick = () => {
      if (!dialog.open) select(0);
      sheet.open(source, trigger, 'Review transactions');
    };
  }
  return { html, wire };
});
