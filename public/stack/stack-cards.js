/* Stack page: the Bills, Budget and Mortgage cards (behind ?view=stack only).
 *
 * Presentation only. Every printed amount is a value Forecast published,
 * printed as given (lesson L-001): no sums, differences or percentages of
 * money here. A figure that is not published (null, missing, not a finite
 * number) prints nothing, never $0. A bar width may use a ratio computed only
 * for drawing; it is never printed.
 *
 * Reads, from the selected pay period view:
 *   stackSummary.bills.other / .mortgage / .cardMinimums[].debtId  (#1426)
 *   bills[].paidState  'paid' | 'not-paid' | 'carried'            (#1429)
 *   budgetProgress.household.actual.amount / .planned.amount      (existing)
 *   householdBudget[] rows: label, spent, planned                 (existing)
 */
(function (root) {
  'use strict';

  var STYLE_ID = 'stack-cards-style';
  var CSS = [
    '.sc-cards{--sc-ink:#121316;--sc-muted:#6c6d74;--sc-line:rgba(18,19,22,.13);--sc-bar:rgba(18,19,22,.13);',
    '--sc-bills:#c6c9ff;--sc-budget:#dff06e;--sc-mort:#f5bfe3;display:flex;flex-direction:column;gap:12px;font-family:inherit}',
    '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .sc-cards{--sc-ink:#121316;--sc-muted:#3b3c44}}',
    ':root[data-theme="dark"] .sc-cards{--sc-ink:#121316;--sc-muted:#3b3c44}',
    '.sc-card{background:var(--sc-k);color:var(--sc-ink);border-radius:32px;padding:16px 20px;min-width:0}',
    '.sc-card>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:minmax(0,1fr) auto;',
    'grid-template-areas:"t f" "s f";align-items:center;column-gap:10px}',
    '.sc-card>summary::-webkit-details-marker{display:none}',
    '.sc-card>summary:focus-visible{outline:2px solid currentColor;outline-offset:3px;border-radius:12px}',
    '.sc-t{grid-area:t;font-size:18px;font-weight:800;letter-spacing:-.02em}',
    '.sc-s{grid-area:s;font-size:13.5px;font-weight:500;opacity:.68}',
    '.sc-f{grid-area:f;font-size:24px;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.sc-f i{font-style:normal;font-size:.6em;font-weight:600;opacity:.68}',
    '.sc-bar{height:8px;border-radius:4px;background:var(--sc-bar);margin-top:12px;overflow:hidden}',
    '.sc-bar i{display:block;height:100%;border-radius:4px;background:var(--sc-ink)}',
    '.sc-card[open] .sc-bar{height:12px}',
    '.sc-list{list-style:none;margin:14px 0 0;padding:0}',
    '.sc-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;min-height:54px;',
    'padding:8px 0;border-top:1.5px solid var(--sc-line)}',
    '.sc-n{font-size:17px;font-weight:600;display:block}',
    '.sc-st{font-size:13.5px;font-weight:500;opacity:.68;display:block}',
    '.sc-st.sc-paid{opacity:1;font-weight:700}',
    '.sc-a{font-size:18px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.sc-a i{font-style:normal;font-weight:500;opacity:.68}',
    '.sc-mini{height:6px;border-radius:3px;background:var(--sc-bar);margin-top:8px;overflow:hidden}',
    '.sc-mini i{display:block;height:100%;border-radius:3px;background:var(--sc-ink)}'
  ].join('');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // Formatting only: prints the published number as dollars. No arithmetic.
  function money(v) {
    if (!isNum(v)) return null;
    var s = Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '−' : '') + '$' + s;
  }

  // Bar width for drawing only; never printed.
  function drawWidth(part, whole) {
    if (!isNum(part) || !isNum(whole) || whole <= 0) return 0;
    return Math.max(0, Math.min(100, part / whole * 100));
  }

  function selectView(ctx) {
    var rec = ctx && ctx.recommendation;
    var views = rec && Array.isArray(rec.payPeriodViews) ? rec.payPeriodViews : [];
    var key = ctx ? ctx.selectedPeriodKey : null;
    if (key == null) return null;
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      if (v && (v.key === key || v.periodKey === key || v.id === key || v.start === key)) return v;
    }
    return null;
  }

  function get(o, path) {
    for (var i = 0; i < path.length; i++) {
      if (o == null || typeof o !== 'object') return undefined;
      o = o[path[i]];
    }
    return o;
  }

  function isMortgageRow(r) { return !!r && (r.debtId === 'mortgage' || r.id === 'mortgage'); }

  function strip(kind, title, sub, figure, figureOf, width, body) {
    var f = figure == null ? '' : '<span class="sc-f">' + esc(figure) +
      (figureOf == null ? '' : '<i> / ' + esc(figureOf) + '</i>') + '</span>';
    return '<details class="sc-card sc-' + kind + '" data-stack-card="' + kind + '" style="--sc-k:var(--sc-' + kind + ')">' +
      '<summary><span class="sc-t">' + esc(title) + '</span><span class="sc-s">' + esc(sub) + '</span>' + f + '</summary>' +
      '<div class="sc-bar"><i style="width:' + width + '%"></i></div>' + body + '</details>';
  }

  function stateWord(row) { return row.paidState === 'paid' ? 'Paid' : 'Not paid'; }
  function stateRow(label, amountText, paid, word) {
    return '<li class="sc-row"><span><b class="sc-n">' + esc(label) + '</b><small class="sc-st' + (paid ? ' sc-paid' : '') + '">' +
      esc(word) + '</small></span>' + (amountText == null ? '' : '<span class="sc-a">' + esc(amountText) + '</span>') + '</li>';
  }

  function billsCard(view) {
    var split = get(view, ['stackSummary', 'bills']) || {};
    var cardIds = {};
    (Array.isArray(split.cardMinimums) ? split.cardMinimums : []).forEach(function (c) { if (c) cardIds[String(c.debtId)] = true; });
    var rows = (Array.isArray(view.bills) ? view.bills : []).filter(function (r) {
      return r && r.paidState && r.paidState !== 'carried' && !isMortgageRow(r) && !(r.debtId != null && cardIds[String(r.debtId)]);
    });
    var paid = rows.filter(function (r) { return r.paidState === 'paid'; }).length; // a count of rows, not money
    var total = money(split.other);
    var body = '<ul class="sc-list">' + rows.map(function (r) {
      return stateRow(r.label || r.name || 'Bill', money(r.amount), r.paidState === 'paid', stateWord(r));
    }).join('') + '</ul>';
    var sub = rows.length ? paid + ' of ' + rows.length + ' paid' : 'paid / total';
    return strip('bills', 'Bills', sub, total, null, drawWidth(paid, rows.length), rows.length ? body : '');
  }

  function budgetCard(view) {
    var hh = get(view, ['budgetProgress', 'household']) || {};
    var spent = get(hh, ['actual', 'amount']), planned = get(hh, ['planned', 'amount']);
    var cats = (Array.isArray(view.householdBudget) ? view.householdBudget : []).filter(function (c) {
      return c && !c.informational && c.label;
    });
    var body = '<ul class="sc-list">' + cats.map(function (c) {
      var s = money(c.spent), p = money(c.planned);
      return '<li class="sc-row"><span><b class="sc-n">' + esc(c.label) + '</b><span class="sc-mini"><i style="width:' +
        drawWidth(c.spent, c.planned) + '%"></i></span></span>' +
        (s == null && p == null ? '' : '<span class="sc-a">' + (s == null ? '' : esc(s)) + (p == null ? '' : '<i> / ' + esc(p) + '</i>') + '</span>') + '</li>';
    }).join('') + '</ul>';
    return strip('budget', 'Budget', 'spent / budget', money(spent), money(planned), drawWidth(spent, planned), cats.length ? body : '');
  }

  function mortgageCard(view) {
    var total = money(get(view, ['stackSummary', 'bills', 'mortgage']));
    var row = (Array.isArray(view.bills) ? view.bills : []).filter(function (r) {
      return isMortgageRow(r) && r.paidState && r.paidState !== 'carried';
    })[0];
    var paid = !!row && row.paidState === 'paid';
    var body = row ? '<ul class="sc-list">' + stateRow(row.label || row.name || 'Mortgage', money(row.amount), paid, stateWord(row)) + '</ul>' : '';
    var sub = row ? stateWord(row) : 'paid / total';
    return strip('mortgage', 'Mortgage', sub, total, null, paid ? 100 : 0, body);
  }

  function buildCardsHTML(ctx) {
    var view = selectView(ctx);
    if (!view) return '';
    return '<div class="sc-cards">' + billsCard(view) + budgetCard(view) + mortgageCard(view) + '</div>';
  }

  function render(container, ctx) {
    if (!container) return;
    if (typeof document !== 'undefined' && document.head && !document.getElementById(STYLE_ID)) {
      var st = document.createElement('style');
      st.id = STYLE_ID; st.textContent = CSS;
      document.head.appendChild(st);
    }
    container.innerHTML = buildCardsHTML(ctx);
  }

  if (root.StackBlocks && typeof root.StackBlocks.register === 'function') root.StackBlocks.register('cards', render);
  if (typeof module !== 'undefined' && module.exports) module.exports = { render: render, buildCardsHTML: buildCardsHTML, CSS: CSS };
})(typeof window !== 'undefined' ? window : globalThis);
