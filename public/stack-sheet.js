/* Stack Wallet block 'sheet' (B4): the bottom sheet for a tapped line item.
 *
 * Any block marks a tappable row with data-stack-sheet="<kind>:<id>"; this block opens the sheet for it with that
 * item's published fields from the selected pay period. Blocks never call each other.
 *   bill:<id>@<date>   a row of the selected view's bills (mortgage:<id>@<date> reads the same way); its amounts come
 *                      from Forecast's billHistory (#1446), the one source for an occurrence's amount and trust
 *   budget:<id>        a row of the selected view's householdBudget, with the transactions Forecast counted into its Spent
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
  // labelCls: the same treatment for a label that carries a figure of its own (Credit's "Minimum $30").
  const row = (label, value, cls = '', labelCls = '') => (value === '' || value == null ? ''
    : `<div><dt${labelCls ? ` class="${labelCls.trim()}"` : ''}>${esc(label)}</dt><dd class="stack-n${cls}">${esc(value)}</dd></div>`);
  const est = (trust, v) => (window.StackBlocks.estClass ? window.StackBlocks.estClass(trust, v) : '');

  // The kicker names the kind and the selected pay period's range ("Bill · Nov 13 – 26"), the shell's one range label.
  function head(kicker, title) {
    const v = view(), range = v && window.StackBlocks.rangeLabel ? window.StackBlocks.rangeLabel(v) : '';
    return '<div class="stack-sheet-grab" aria-hidden="true"></div><div class="stack-sheet-head"><div>'
      + `<small class="stack-sheet-kicker">${esc(range ? `${kicker} \u00b7 ${range}` : kicker)}</small><h3 id="stack-sheet-title">${esc(title)}</h3></div>`
      + '<button class="stack-sheet-close" type="button" data-stack-sheet-close aria-label="Close">'
      + '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
      + '</button></div>';
  }

  // A bill: its published amount, and a green check only when it is paid (#1429's paidState; owner direction: no Paid or
  // Not paid word, nothing when unpaid). An unpaid bill also shows its scheduled date and planned paying account, each
  // alone with no label word (owner, 2026-11-20: no explanatory text). A paid bill shows neither: next to the check they
  // would read as when and from where it was paid, which they are not (bill.date is the schedule, payerLabel the plan;
  // Atlas on #1444). The observed payment fields (postedOn, paidFromLabel) are never read here.
  //
  // Its amounts come from Forecast's billHistory (#1446; lead ruling, 2026-11-20): every published occurrence of the bill,
  // newest first, each { date, amount, amountBasis, trust, paidState } with its amount and trust together. The headline is
  // this occurrence's entry (same date); with no entry, or an unpublished amount, it is a dash, never bill.amount and never
  // $0. Below it, the bill's past occurrences: those dated before this one and on or before Forecast's observation date
  // (data.meta.asOf, the date recommend ran with), so a future schedule is never listed as past. Each shows its date,
  // amount (soft when estimated, a dash when unpublished) and a check when paid, no words. A paid occurrence whose
  // amount is still the schedule (amountBasis 'schedule': a pending payment, no actual posted) shows the check with a
  // dash, never the scheduled amount, which beside the check would read as the amount paid (Atlas on #1453). The page
  // joins nothing across periods and reads the basis only to withhold.
  const plain = (value, cls = '') => (value ? `<p class="stack-sheet-plain${cls}">${esc(value)}</p>` : '');
  const DASH = '<span role="img" aria-label="not available">\u2014</span>';
  const CHECK = '<span class="stack-sheet-check" role="img" aria-label="Paid">\u2713</span>';
  function occurrences(id) {
    const all = ctx && ctx.recommendation && ctx.recommendation.billHistory;
    const list = all && typeof all === 'object' && Object.prototype.hasOwnProperty.call(all, id) ? all[id] : null;
    return Array.isArray(list) ? list.filter(e => e && typeof e === 'object' && typeof e.date === 'string') : [];
  }
  // An entry's amount as printed beside its paid state: nothing to show when unpublished, or when it is a schedule on a
  // paid occurrence.
  const shownAmount = (entry, paid) => (entry && num(entry.amount) && !(paid && entry.amountBasis === 'schedule') ? entry.amount : null);
  const amountHtml = amount => (amount === null ? DASH : esc(money(amount)));
  // The tapped row's occurrence identity, as Forecast keys billHistory (#1455, billOccurrenceIdentity): its occurrenceKey
  // when it publishes one for this bill, else id@scheduledDate, else id@date. Never inferred from a similar date or amount.
  const rowOccurrence = bill => (typeof bill.occurrenceKey === 'string' && bill.occurrenceKey.startsWith(bill.id + '@')
    ? bill.occurrenceKey : `${bill.id}@${typeof bill.scheduledDate === 'string' && bill.scheduledDate ? bill.scheduledDate : bill.date}`);
  function billHtml(bill, kicker, v) {
    const paid = bill.paidState === 'paid';
    const list = occurrences(bill.id);
    const identity = rowOccurrence(bill);
    // This occurrence's entry, found by identity (a statement may have moved its date; a coinciding date never borrows
    // another occurrence). Only a history that publishes no identity at all falls back to the date. The entry is shown
    // only when it describes this same copy of the occurrence: the row's own date and paid state. A saved close's copy
    // (its old date, or its unpaid state) never shows the current copy's amount; the headline is a dash instead
    // (Atlas on #1455 and #1456).
    const keyed = list.some(e => typeof e.occurrence === 'string');
    const match = keyed ? list.find(e => e.occurrence === identity) : list.find(e => e.date === bill.date);
    const entry = match && match.paidState === bill.paidState && match.date === bill.date ? match : null;
    const asOf = ctx && ctx.data && ctx.data.meta && typeof ctx.data.meta.asOf === 'string' ? ctx.data.meta.asOf : null;
    const earlier = asOf ? list.filter(e => e !== match && (!keyed || e.occurrence !== identity) && e.date < bill.date && e.date <= asOf) : [];
    const headAmount = shownAmount(entry, paid);
    return head(kicker, bill.label || '')
      + `<div class="stack-sheet-big stack-n${headAmount === null ? '' : est(entry.trust, v)}">${amountHtml(headAmount)}</div>`
      + (paid ? CHECK : plain(date(bill.date), ' stack-n') + plain(bill.payerLabel || ''))
      + (earlier.length ? '<ul class="stack-sheet-hist">' + earlier.map(e => {
        const ePaid = e.paidState === 'paid', amount = shownAmount(e, ePaid);
        return '<li>' + `<span class="stack-sheet-txd">${esc(date(e.date))}</span>`
          + `<span class="stack-sheet-txa stack-n${amount === null ? '' : est(e.trust, v)}">${amountHtml(amount)}</span>`
          + `<span class="stack-sheet-histck">${ePaid ? CHECK : ''}</span></li>`;
      }).join('') + '</ul>' : '');
  }

  // A household budget category: spent of planned, and what is left (or over) as Forecast publishes it.
  function budgetHtml(item, v) {
    const over = num(item.overspend) && item.overspend > 0;
    const t = window.StackBlocks.budgetTrust ? window.StackBlocks.budgetTrust(item) : {};
    const spent = est(t.spent, v), planned = est(t.planned, v), rest = est(t.remaining, v);
    // Spent and planned each carry their own treatment, side by side (never nested, so neither inherits the other's).
    // The headline carries Spent and the budget; the list below carries one row, Left (Over when over budget).
    return head('Budget', item.label || '')
      + `<div class="stack-sheet-big stack-n"><span${spent ? ` class="${spent.trim()}"` : ''}>${esc(money(item.spent))}</span>`
      + `${num(item.planned) ? `<i${planned ? ` class="${planned.trim()}"` : ''}> / ${esc(money(item.planned))}</i>` : ''}</div>`
      + '<dl>' + (over ? row('Over', money(item.overspend), rest) : row('Left', money(item.remaining), rest)) + '</dl>'
      + budgetTransactionsHtml(item, v);
  }

  // The transactions Forecast counted into a category's Spent: the row's recon[], less the pending copy of a posted
  // transaction (the same exclusion Spent makes). Listed only when Forecast says the rows reconcile to the published
  // Spent (reconMatchesSpent === true; absent or false: nothing, so a rounding case that cannot reconcile never
  // shows a list that disagrees with the figure) and Spent is proven for this exact period: not a saved close (its
  // recon is borrowed from today's recomputed row), nothing withheld, not a projected period. Otherwise nothing, with
  // no explanation. Newest first (display order of rows Forecast already assigned, not categorisation); name, date
  // and amount as published (Lunch Money's own name); no category logic and no arithmetic here.
  function budgetTransactionsHtml(item, v) {
    if (!v || v.capturedClose || item.reconMatchesSpent !== true || item.withheldReason || item.projected === true) return '';
    const rows = (Array.isArray(item.recon) ? item.recon : [])
      .filter(r => r && typeof r === 'object' && num(r.amount)
        && !(r.pendingPostedDuplicate === true && r.pending === true && r.pendingAmountEstimated !== true))
      .map((r, i) => ({ r, i, d: typeof r.date === 'string' ? r.date : '' }))
      .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : a.i - b.i));
    return rows.length ? '<ul class="stack-sheet-tx">' + rows.map(({ r }) => '<li>'
      + `<span class="stack-sheet-txd">${esc(date(r.date))}</span>`
      + `<span class="stack-sheet-txl">${esc(r.displayedPayee || r.originalMerchant || '')}</span>`
      + `<span class="stack-sheet-txa stack-n">${esc(money(r.amount))}</span></li>`).join('') + '</ul>' : '';
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

  // While a sheet is open the page behind it must not scroll (iOS Safari scrolls the body through overflow:hidden). The
  // lock is position:fixed on the body at top:-scrollY (stack-sheet.css, html.stack-sheet-open), and the position is
  // restored on close. Every way a sheet goes away (close, Escape, a re-render) goes through unlock().
  let lockY = null;
  function lock() {
    if (lockY !== null) return;
    const root = document.documentElement;
    lockY = window.pageYOffset || root.scrollTop || 0;
    root.style.setProperty('--stack-lock-top', '-' + lockY + 'px');
    root.classList.add('stack-sheet-open');
  }
  function unlock() {
    if (lockY === null) return;
    const root = document.documentElement, y = lockY;
    lockY = null;
    root.classList.remove('stack-sheet-open');
    root.style.removeProperty('--stack-lock-top');
    try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, y); }
  }

  function open(key, from) {
    const item = container && find(key);
    if (!item || !item.html) return;
    lastRow = from || null;
    lock();
    container.innerHTML = `<div class="stack-sheet-scrim" data-stack-sheet-scrim><div class="stack-sheet" data-kind="${esc(item.kind)}"`
      + ` role="dialog" aria-modal="true" aria-labelledby="stack-sheet-title">${item.html}</div></div>`;
    const button = container.querySelector('[data-stack-sheet-close]');
    if (button) button.focus();
  }
  function close() {
    if (!container || !container.firstChild) return;
    container.innerHTML = '';
    unlock();
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
    unlock();
    wire();
  });
})();
