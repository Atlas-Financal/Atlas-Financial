/* Stack Wallet block 'sheet' (B4): the bottom sheet for a tapped line item.
 *
 * Any block marks a tappable row with data-stack-sheet="<kind>:<id>"; this block opens the sheet for it with that
 * item's published fields from the selected pay period. Blocks never call each other.
 *   bill:<id>@<date>   a row of the selected view's bills (mortgage:<id>@<date> reads the same way)
 *   budget:<id>        a row of the selected view's householdBudget
 *   card:<id>          a credit line (window.StackCredit.line(ctx, id), the credit block's one Forecast reading)
 * Escape, the close button or the scrim closes it; focus returns to the row.
 *
 * L-001: prints only what Forecast publishes. No arithmetic on money; a field that is not published prints nothing.
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
  // A published amount as printed: dollars, cents only when the figure has them. Nothing for an unpublished amount.
  const money = v => (num(v) ? (Number.isInteger(v) ? whole : cents).format(v).replace('-', '−') : '');
  const day = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const date = iso => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? day.format(new Date(`${iso}T12:00:00Z`)) : '');

  let ctx = null, lastRow = null, container = null;
  const view = () => (ctx && ctx.recommendation && Array.isArray(ctx.recommendation.payPeriodViews)
    ? ctx.recommendation.payPeriodViews.find(v => v && v.start === ctx.selectedPeriodKey) : null) || null;
  // cls: the shell's trust treatment for the value (' stack-est' or ''), from the value's published trust.
  const row = (label, value, cls = '') => (value === '' || value == null ? ''
    : `<div><dt>${esc(label)}</dt><dd class="stack-n${cls}">${esc(value)}</dd></div>`);
  const est = (trust, v) => (window.StackBlocks.estClass ? window.StackBlocks.estClass(trust, v) : '');

  function head(kicker, title) {
    return '<div class="stack-sheet-grab" aria-hidden="true"></div><div class="stack-sheet-head"><div>'
      + `<small class="stack-sheet-kicker">${esc(kicker)}</small><h3 id="stack-sheet-title">${esc(title)}</h3></div>`
      + '<button class="stack-sheet-close" type="button" data-stack-sheet-close aria-label="Close">'
      + '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
      + '</button></div>';
  }

  // A bill: its published amount, and a green check only when it is paid (#1429's paidState; owner direction: no Paid or
  // Not paid word, nothing when unpaid). An unpaid bill also shows its scheduled date and planned paying account, each
  // alone with no label word (owner, 2026-11-20: no explanatory text). A paid bill shows neither: next to the check they
  // would read as when and from where it was paid, which they are not (bill.date is the schedule, payerLabel the plan;
  // Atlas on #1444). The observed payment fields (postedOn, paidFromLabel) are never read here.
  const plain = (value, cls = '') => (value ? `<p class="stack-sheet-plain${cls}">${esc(value)}</p>` : '');
  function billHtml(bill, kicker, v) {
    const paid = bill.paidState === 'paid';
    return head(kicker, bill.label || '')
      + `<div class="stack-sheet-big stack-n${est(bill.displayAmountTrust, v)}">${esc(money(bill.amount))}</div>`
      + (paid ? '<span class="stack-sheet-check" role="img" aria-label="Paid">\u2713</span>'
        : plain(date(bill.date), ' stack-n') + plain(bill.payerLabel || ''));
  }

  // A household budget category: spent of planned, and what is left (or over) as Forecast publishes it.
  function budgetHtml(item, v) {
    const over = num(item.overspend) && item.overspend > 0;
    const t = window.StackBlocks.budgetTrust ? window.StackBlocks.budgetTrust(item) : {};
    const spent = est(t.spent, v), planned = est(t.planned, v), rest = est(t.remaining, v);
    // Spent and planned each carry their own treatment, side by side (never nested, so neither inherits the other's).
    return head('Budget', item.label || '')
      + `<div class="stack-sheet-big stack-n"><span${spent ? ` class="${spent.trim()}"` : ''}>${esc(money(item.spent))}</span>`
      + `${num(item.planned) ? `<i${planned ? ` class="${planned.trim()}"` : ''}> / ${esc(money(item.planned))}</i>` : ''}</div>`
      + '<dl>' + row('Spent', money(item.spent), spent) + row('Budget', money(item.planned), planned)
      + (over ? row('Over', money(item.overspend), rest) : row('Left', money(item.remaining), rest)) + '</dl>';
  }

  // A credit line, from the credit block's reading of Forecast.stackCreditLines.
  function cardHtml(line) {
    const credit = window.StackCredit;
    return credit && typeof credit.sheetHtml === 'function'
      ? credit.sheetHtml(line, { head, row, money, date, esc }, typeof credit.view === 'function' ? credit.view(ctx) : null) : '';
  }

  function find(key) {
    const v = view();
    const at = key.indexOf(':');
    const kind = key.slice(0, at), id = key.slice(at + 1);
    if (!v) return null;
    if (kind === 'bill' || kind === 'mortgage') {
      const bill = (Array.isArray(v.bills) ? v.bills : []).find(b => b && `${b.id}@${b.date}` === id);
      return bill ? { kind, html: billHtml(bill, kind === 'mortgage' ? 'Mortgage' : 'Bill', v) } : null;
    }
    if (kind === 'budget') {
      const item = (Array.isArray(v.householdBudget) ? v.householdBudget : []).find(b => b && b.id === id);
      return item ? { kind, html: budgetHtml(item, v) } : null;
    }
    if (kind === 'card') {
      const line = window.StackCredit && typeof window.StackCredit.line === 'function' ? window.StackCredit.line(ctx, id) : null;
      return line ? { kind, html: cardHtml(line) } : null;
    }
    return null;
  }

  function open(key, from) {
    const item = container && find(key);
    if (!item || !item.html) return;
    lastRow = from || null;
    container.innerHTML = `<div class="stack-sheet-scrim" data-stack-sheet-scrim><div class="stack-sheet" data-kind="${esc(item.kind)}"`
      + ` role="dialog" aria-modal="true" aria-labelledby="stack-sheet-title">${item.html}</div></div>`;
    const button = container.querySelector('[data-stack-sheet-close]');
    if (button) button.focus();
  }
  function close() {
    if (!container || !container.firstChild) return;
    container.innerHTML = '';
    if (lastRow && lastRow.isConnected) lastRow.focus({ preventScroll: true });
    lastRow = null;
  }

  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    document.addEventListener('click', event => {
      const target = event.target;
      if (!target || !target.closest) return;
      if (container && container.firstChild && (target.closest('[data-stack-sheet-close]')
        || target === container.querySelector('[data-stack-sheet-scrim]'))) { close(); return; }
      const rowEl = target.closest('[data-stack-sheet]');
      const root = document.getElementById('stack-root');
      if (rowEl && root && root.contains(rowEl)) open(rowEl.getAttribute('data-stack-sheet'), rowEl);
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  }

  // For tests and for keyboard openers: the sheet's markup for one item of a ctx, or null.
  window.StackSheet = { html: (context, key) => { const saved = ctx; ctx = context; const item = find(key); ctx = saved; return item ? item.html : null; } };

  window.StackBlocks.register('sheet', (el, context) => {
    container = el;
    ctx = context;
    // A re-render (a new period or new data) closes an open sheet: its item may no longer be the selected one.
    container.innerHTML = '';
    wire();
  });
})();
