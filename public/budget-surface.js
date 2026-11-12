'use strict';
/* The one active Budget renderer for #operating-surface-body.
 *
 * Layout only. Every financial section is an incumbent component passed in
 * by public/plan.js (`parts`), rendered whole: this file selects which
 * component to show for the chosen view and arranges them. It does not call
 * Forecast, read a money field, total, label a trust state, or reword a
 * component's output.
 */
(function init(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BudgetSurface = api;
})(globalThis, function buildApi() {
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function card(kind, body, opts = {}) {
    if (!body) return '';
    const label = opts.label ? ` aria-label="${escape(opts.label)}"` : '';
    return `<section class="budget-surface-card budget-surface-${kind}" data-budget-surface-section="${kind}"${label}>
      ${opts.eyebrow ? `<p class="budget-surface-eyebrow">${escape(opts.eyebrow)}</p>` : ''}
      ${body}
    </section>`;
  }

  function movementsSection(ctx, parts) {
    const html = parts.cardMovementsHtml ? parts.cardMovementsHtml(ctx) : '';
    return html ? `<div class="budget-blend-tile budget-blend-card-movements">${html}</div>` : '';
  }

  function payPeriodView(ctx, parts) {
    const today = parts.todayHtml(ctx);
    const period = parts.periodHtml(ctx);
    return `<div class="budget-bento" data-budget-bento>
    <div class="budget-surface-grid">
      ${card('period', `<div class="budget-blend-hero-layout">${parts.headerHtml ? parts.headerHtml(ctx) : ''}
        <div class="budget-surface-today" data-budget-surface-section="today">${today}</div><!--budget-current-position-end-->${period}</div>`,
        { label: 'Selected pay period and current Bills position' })}
    </div>${movementsSection(ctx, parts)}${parts.browseHtml ? parts.browseHtml(ctx) : ''}${parts.fundingHtml ? parts.fundingHtml(ctx) : ''}</div>`;
  }

  function html(ctx, parts) {
    if (parts.planUnavailable(ctx)) {
      return `<div class="payday-operating-sheet budget-surface" data-payday-sheet data-budget-surface="unavailable">
        ${card('unavailable', parts.unavailableHtml(ctx), { eyebrow: 'Budget', label: 'Current plan unavailable' })}
        ${movementsSection(ctx, parts)}
        ${parts.detailSheetHtml ? parts.detailSheetHtml() : ''}
      </div>`;
    }
    return `<div class="payday-operating-sheet budget-stepped-sheet budget-surface" data-payday-sheet data-budget-surface="pay-period">
      ${payPeriodView(ctx, parts)}
      ${parts.detailSheetHtml ? parts.detailSheetHtml() : ''}
    </div>`;
  }

  return { html };
});
