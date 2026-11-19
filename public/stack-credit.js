/* Stack Wallet block 'credit' (B4): the Credit card. Design: the Stack Wallet artifact (invented data).
 *
 * Reads Forecast.stackCreditLines (A6b, LEDGER A) for the selected pay period:
 *   Forecast.stackCreditLines(Forecast.cardPeriodMovements(plan, debts, asOf, {start, end},
 *     {currentPeriodActuals, cardPeriodBalanceEvidence, liveOverlay}), view.stackSummary.bills)
 *   -> { lines: [{ id, label, paid, spent, net, minimum, toGo (figures {amount|null, trust, reasons}), status,
 *                  minimumCovered: {value: true|false|'unknown'}, transactions }],
 *        totals: { paid, spent, trust, completeness: 'complete'|'partial'|'none', excluded: [ids], reasons } }
 *
 * Closed: "Credit", paid back / spent from totals, and when the total is partial "excludes <card names>".
 * Open: one row per line: "Paid back $A of $B", the published status word ("Paid back", "$X to go" in coral,
 * "Upcoming"), and "Minimum $X covered ✓" / "not yet". HELOC shows its minimum only. Each row opens the sheet
 * (data-stack-sheet="card:<id>"), which reads the same line through window.StackCredit.
 *
 * L-001: prints only what Forecast publishes. No arithmetic on money: a bar's width comes from the shell's one
 * drawing helper (StackBlocks.barWidth), never printed; an unpublished figure prints nothing, never $0.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.StackBlocks) return;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const whole = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 });
  const cents = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const money = v => (num(v) ? (Number.isInteger(v) ? whole : cents).format(v).replace('-', '−') : '');
  const amountOf = figure => (figure && num(figure.amount) ? figure.amount : null);
  const TICK = '<svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 6.3 5 8.6l4.5-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHEV = '<svg class="stack-chev" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2.5 9.5 7 5 11.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // The one Forecast reading per render: memoised on the ctx object the shell passes to every block, so the sheet
  // reads the same lines this card prints.
  const readings = new WeakMap();
  function read(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    if (readings.has(ctx)) return readings.get(ctx);
    let out = null;
    const F = ctx.Forecast;
    const views = ctx.recommendation && Array.isArray(ctx.recommendation.payPeriodViews) ? ctx.recommendation.payPeriodViews : [];
    const view = views.find(v => v && v.start === ctx.selectedPeriodKey);
    const d = ctx.data;
    if (F && typeof F.stackCreditLines === 'function' && typeof F.cardPeriodMovements === 'function' && view && d) {
      const overlay = d.liveOverlay && d.liveOverlay.applied === true ? d.liveOverlay : null;
      const publication = F.cardPeriodMovements(ctx.plan, d.debts, d.meta && d.meta.asOf, { start: view.start, end: view.end }, {
        currentPeriodActuals: overlay ? overlay.currentPeriodActuals : null,
        cardPeriodBalanceEvidence: overlay ? overlay.cardPeriodBalanceEvidence : null,
        liveOverlay: overlay,
      });
      const result = F.stackCreditLines(publication, view.stackSummary ? view.stackSummary.bills : null);
      out = result && Array.isArray(result.lines) && result.totals ? result : null;
    }
    readings.set(ctx, out);
    return out;
  }
  const bar = (part, of, cls) => {
    const width = window.StackBlocks.barWidth ? window.StackBlocks.barWidth(part, of) : null;
    return width == null ? '' : `<span class="${cls}" aria-hidden="true"><i style="width:${(width * 100).toFixed(1)}%"></i></span>`;
  };

  // The published status word: "Paid back", "$X to go" (coral), "Upcoming"; nothing when status is null.
  function statusOf(line) {
    if (line.status === 'paid-back') return { cls: 'is-ok', text: 'Paid back' };
    if (line.status === 'to-go') return amountOf(line.toGo) == null ? null : { cls: 'is-togo', text: `${money(amountOf(line.toGo))} to go` };
    if (line.status === 'upcoming') return { cls: 'is-up', text: 'Upcoming' };
    return null;
  }
  // "Minimum $X covered ✓" / "Minimum $X not yet"; nothing when the minimum or its check is not published.
  function minimumText(line) {
    const min = amountOf(line.minimum), covered = line.minimumCovered && line.minimumCovered.value;
    if (min == null || (covered !== true && covered !== false)) return '';
    return `Minimum ${money(min)} ${covered ? 'covered ✓' : 'not yet'}`;
  }
  const paidOfSpent = line => (amountOf(line.paid) != null && amountOf(line.spent) != null
    ? `Paid back ${money(amountOf(line.paid))} of ${money(amountOf(line.spent))}` : '');

  function lineHtml(line) {
    const heloc = line.id === 'heloc';
    const status = heloc ? null : statusOf(line);
    const sub = heloc ? '' : paidOfSpent(line);
    const min = minimumText(line);
    const ok = status && status.cls === 'is-ok';
    return `<li><button class="stack-credit-line" type="button" data-stack-sheet="card:${esc(line.id)}">`
      + `<span class="stack-credit-tick${ok ? ' is-on' : ''}">${TICK}</span>`
      + `<span class="stack-credit-name"><b>${esc(line.label)}</b>`
      + (sub ? `<small>${esc(sub)}</small>` : '')
      + (heloc ? '' : bar(amountOf(line.paid), amountOf(line.spent), 'stack-credit-minibar'))
      + (min ? `<small class="stack-credit-min">${esc(min)}</small>` : '') + '</span>'
      + `<span class="stack-credit-status stack-n ${status ? status.cls : ''}">${status ? esc(status.text) : ''}</span>`
      + `${CHEV}</button></li>`;
  }

  let open = false;
  function cardHtml(reading) {
    const t = reading.totals;
    const labels = new Map(reading.lines.map(line => [line.id, line.label]));
    const excluded = t.completeness === 'partial' && Array.isArray(t.excluded)
      ? t.excluded.map(id => labels.get(id) || id).filter(Boolean) : [];
    // A partial total is printed only with the cards it leaves out; a partial total naming none prints nothing.
    const shown = num(t.paid) && num(t.spent)
      && (t.completeness === 'complete' || (t.completeness === 'partial' && excluded.length > 0));
    return `<section class="stack-credit${open ? ' is-open' : ''}" data-stack-credit>`
      + `<button class="stack-credit-head" type="button" data-stack-credit-toggle aria-expanded="${open}">`
      + '<span class="stack-credit-hd"><span class="stack-credit-title">Credit</span>'
      + (shown ? `<span class="stack-credit-figure stack-n" data-stack-credit-total>${esc(money(t.paid))}<i> / ${esc(money(t.spent))}</i></span>` : '')
      + (shown ? '<span class="stack-credit-sub">paid back / spent</span>' : '')
      + (excluded.length ? `<span class="stack-credit-excludes" data-stack-credit-excludes>excludes ${esc(excluded.join(', '))}</span>` : '')
      + '</span><span class="stack-credit-go">' + CHEV + '</span></button>'
      + (shown ? bar(t.paid, t.spent, 'stack-credit-bar') : '')
      + `<div class="stack-credit-exp"${open ? '' : ' inert'}><div><ul class="stack-credit-list">`
      + reading.lines.map(lineHtml).join('') + '</ul></div></div></section>';
  }

  // The sheet's view of one line (stack-sheet.js asks for it with its own helpers).
  function sheetHtml(line, h) {
    const heloc = line.id === 'heloc';
    const status = heloc ? null : statusOf(line);
    const paid = amountOf(line.paid), spent = amountOf(line.spent), min = amountOf(line.minimum);
    const covered = line.minimumCovered && line.minimumCovered.value;
    const tx = Array.isArray(line.transactions) ? line.transactions : [];
    return h.head('Credit', line.label || '')
      + (paid != null && spent != null ? `<div class="stack-sheet-big stack-n">${h.esc(h.money(paid))}<i> of ${h.esc(h.money(spent))}</i></div>` : '')
      + (status ? `<span class="stack-sheet-pill ${status.cls}${status.cls === 'is-ok' ? ' is-on' : ''}">${h.esc(status.text)}</span>` : '')
      + (heloc ? '' : bar(paid, spent, 'stack-sheet-bar'))
      + '<dl>' + (heloc ? '' : h.row('Spent on it this pay period', h.money(spent)) + h.row('Paid onto it', h.money(paid)))
      + (min != null && (covered === true || covered === false) ? h.row(`Minimum ${h.money(min)}`, covered ? 'Covered ✓' : 'Not yet') : '')
      + '</dl>'
      + (heloc ? '' : '<h4 class="stack-sheet-txh">Transactions</h4>' + (tx.length
        ? '<ul class="stack-sheet-tx">' + tx.map(t => {
          // A payment onto the card is published negative with payment: true; it prints as "+" and its size.
          const size = num(t.amount) ? h.money(Math.abs(t.amount)) : '';
          return `<li class="${t.payment ? 'is-pay' : ''}${t.pending ? ' is-pending' : ''}">`
            + `<span class="stack-sheet-txd">${h.esc(h.date(t.date))}</span><span class="stack-sheet-txl">${h.esc(t.name || '')}</span>`
            + `<span class="stack-sheet-txa stack-n">${size ? (t.payment ? '+' : '') + h.esc(size) : ''}</span></li>`;
        }).join('') + '</ul>'
        : ''));
  }

  window.StackCredit = {
    read,
    line: (ctx, id) => { const r = read(ctx); return r ? r.lines.find(l => l && l.id === id) || null : null; },
    sheetHtml,
  };

  let listening = null;
  window.StackBlocks.register('credit', (container, ctx) => {
    const reading = read(ctx);
    container.innerHTML = reading ? cardHtml(reading) : '';
    if (listening !== container && container.addEventListener) {
      listening = container;
      container.addEventListener('click', event => {
        const toggle = event.target && event.target.closest && event.target.closest('[data-stack-credit-toggle]');
        if (!toggle) return;
        open = !open;
        const section = container.querySelector('[data-stack-credit]');
        if (!section) return;
        section.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        const exp = section.querySelector('.stack-credit-exp');
        if (exp) exp.toggleAttribute('inert', !open);
      });
    }
  });
})();
