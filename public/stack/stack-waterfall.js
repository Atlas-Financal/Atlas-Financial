'use strict';
/* Stack page, waterfall block (B2; behind ?view=stack).
 *
 * The selected pay period's waterfall, copied from Forecast's publication:
 *
 *     Dale's income + Amanda's income + Other income = Total income
 *     − Bills − Budget − Mortgage − Credit
 *     = Surplus after deductions (or Deficit after deductions)
 *
 * Every amount is read from one named published value and printed as is
 * (L-001): no sum, difference or allocation of money happens here. The Total
 * is stackSummary.income.total, the Surplus is stackSummary.surplus.amount and
 * the Credit line is stackSummary.surplus.terms.credit, never added up on the
 * page. A value Forecast did not publish prints nothing for its row (F8),
 * never $0, so a saved close's withheld lines read blank.
 *
 * Sources, per row (see LINE_SOURCES):
 *   income lines   stackSummary.income.{dale,amanda,other,total}.amount
 *   Bills          stackSummary.bills.other
 *   Budget         budgetHold (the Household budget hold the surplus deducts)
 *   Mortgage       stackSummary.bills.mortgage
 *   Credit         stackSummary.surplus.terms.credit, opening in place to one
 *                  row per card: stackSummary.bills.cardMinimums[i].amount
 *   Surplus        stackSummary.surplus.amount
 *
 * Registered with the Stack shell as StackBlocks.register('waterfall', render),
 * render(container, ctx) with ctx = { data, plan, recommendation,
 * selectedPeriodKey, Forecast }. Pure apart from writing container.innerHTML
 * and one click listener for the Credit toggle. Its styles are its own file,
 * public/stack/stack-waterfall.css (linked by the shell). */
(function init(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.StackBlocks && typeof root.StackBlocks.register === 'function') root.StackBlocks.register('waterfall', api.render);
  if (root) root.StackWaterfall = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi() {
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isAmount = v => typeof v === 'number' && Number.isFinite(v);
  // Display only: the published number, to the cent, with a true minus sign.
  // Formatting, not arithmetic: the digits are the published value's own.
  const money = v => {
    const text = v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return text.replace('-', '−');
  };
  const signed = v => (v > 0 ? '+' : '') + money(v);

  // The one place each printed row names its published source.
  const LINE_SOURCES = Object.freeze({
    dale: 'stackSummary.income.dale.amount',
    amanda: 'stackSummary.income.amanda.amount',
    other: 'stackSummary.income.other.amount',
    total: 'stackSummary.income.total.amount',
    bills: 'stackSummary.bills.other',
    budget: 'budgetHold',
    mortgage: 'stackSummary.bills.mortgage',
    credit: 'stackSummary.surplus.terms.credit',
    surplus: 'stackSummary.surplus.amount',
  });
  const readPath = (view, path) => {
    let node = view;
    for (const key of path.split('.')) node = node && typeof node === 'object' ? node[key] : undefined;
    return node;
  };

  // The selected period: selectedPeriodKey is the period's start date
  // ('YYYY-MM-DD', lead ruling), matched on view.start only; with no key, the
  // current period.
  function selectedView(ctx) {
    const views = ctx && ctx.recommendation && Array.isArray(ctx.recommendation.payPeriodViews)
      ? ctx.recommendation.payPeriodViews.filter(v => v && typeof v === 'object') : [];
    const key = ctx ? ctx.selectedPeriodKey : null;
    if (key != null && key !== '') return views.find(v => v.start === key) || null;
    return views.find(v => v.timelineRole === 'current') || null;
  }
  const cardLabel = (ctx, debtId) => {
    const debt = ctx && ctx.data && Array.isArray(ctx.data.debts) ? ctx.data.debts.find(d => d && d.id === debtId) : null;
    return debt && typeof debt.label === 'string' && debt.label.trim() ? debt.label.trim() : String(debtId);
  };

  // One amount cell: the published value, or nothing (F8).
  function amountCell(view, key, { sign = false } = {}) {
    const value = readPath(view, LINE_SOURCES[key]);
    return isAmount(value)
      ? `<span class="n" data-source="${LINE_SOURCES[key]}">${escape(sign ? signed(value) : money(value))}</span>`
      : `<span class="n" data-source="${LINE_SOURCES[key]}" data-unpublished="true"></span>`;
  }
  const line = (op, label, cell, cls = '', row = '') =>
    `<li class="wf-line ${cls}" data-row="${row}"><span class="op" aria-hidden="true">${op}</span><span class="lab">${escape(label)}</span>${cell}</li>`;

  function creditRows(ctx, view) {
    const cards = view.stackSummary && view.stackSummary.bills ? view.stackSummary.bills.cardMinimums : null;
    if (!Array.isArray(cards)) return '';
    return cards.map((card, i) => {
      const source = `stackSummary.bills.cardMinimums.${i}.amount`;
      const cell = card && isAmount(card.amount)
        ? `<span class="n" data-source="${source}">${escape(money(card.amount))}</span>`
        : `<span class="n" data-source="${source}" data-unpublished="true"></span>`;
      return `<li class="wf-card" data-row="card" data-debt-id="${escape(card && card.debtId)}"><span><b>${escape(cardLabel(ctx, card && card.debtId))}</b><small>Minimum</small></span>${cell}</li>`;
    }).join('');
  }

  function html(ctx, state) {
    const view = selectedView(ctx);
    if (!view) return '<section class="stack-waterfall" data-block="waterfall" data-unpublished="true"></section>';
    const surplus = view.stackSummary && view.stackSummary.surplus;
    const amount = surplus && isAmount(surplus.amount) ? surplus.amount : null;
    // A label chosen by the published sign; no figure is derived from it.
    const deficit = amount !== null && amount < 0;
    const word = deficit ? 'Deficit after deductions' : 'Surplus after deductions';
    const open = state.creditOpen === true;
    const cards = creditRows(ctx, view);
    const credit = `<li class="wf-line wf-credit ${open ? 'open' : ''}" data-row="credit">
      <button type="button" class="wf-toggle" data-wf-toggle="credit" aria-expanded="${open}"${cards ? '' : ' disabled'}>
        <span class="op" aria-hidden="true">−</span><span class="lab">Credit</span>${amountCell(view, 'credit')}</button>
      <ul class="wf-cards"${open ? '' : ' hidden'}>${cards}</ul></li>`;
    const reason = amount === null && surplus && typeof surplus.reason === 'string'
      ? `<p class="wf-reason">${escape(surplus.reason)}</p>` : '';
    return `<section class="stack-waterfall" data-block="waterfall" data-period="${escape(view.start || '')}"${surplus && surplus.projected ? ' data-projected="true"' : ''}>
  <ul class="wf-math">
    ${line('', 'Dale’s income', amountCell(view, 'dale'), '', 'dale')}
    ${line('+', 'Amanda’s income', amountCell(view, 'amanda'), '', 'amanda')}
    ${line('+', 'Other income', amountCell(view, 'other'), '', 'other')}
    ${line('=', 'Total income', amountCell(view, 'total'), 'tot', 'total')}
    ${line('−', 'Bills', amountCell(view, 'bills'), '', 'bills')}
    ${line('−', 'Budget', amountCell(view, 'budget'), '', 'budget')}
    ${line('−', 'Mortgage', amountCell(view, 'mortgage'), '', 'mortgage')}
    ${credit}
  </ul>
  <div class="wf-slab${deficit ? ' neg' : ''}" data-row="surplus"><div class="sl"><span aria-hidden="true">=</span> ${word}</div>${amountCell(view, 'surplus', { sign: true })}${reason}</div>
</section>`;
  }

  // The shell's block entry point.
  function render(container, ctx) {
    if (!container) return;
    const state = container.__stackWaterfall || (container.__stackWaterfall = { creditOpen: false });
    container.innerHTML = html(ctx, state);
    if (!state.listening && typeof container.addEventListener === 'function') {
      state.listening = true;
      container.addEventListener('click', event => {
        const toggle = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-wf-toggle="credit"]') : null;
        if (!toggle || toggle.disabled) return;
        state.creditOpen = !state.creditOpen;
        render(container, state.ctx);
      });
    }
    state.ctx = ctx;
  }

  return { render, html, selectedView, LINE_SOURCES };
});
