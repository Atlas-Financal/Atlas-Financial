/* Stack page: the Bills, Budget and Mortgage cards (behind ?view=stack only).
 *
 * Presentation only. Every printed amount is a value Forecast published,
 * printed as given (lesson L-001): no sums, differences or percentages of
 * money here. A figure that is not published (null, missing, not a finite
 * number) prints nothing, never $0. A bar width may use a ratio computed only
 * for drawing; it is never printed.
 *
 * Styles live in stack-cards.css (linked by the shell under ?view=stack).
 *
 * Reads, from the selected pay period view:
 *   stackSummary.bills.other / .mortgage / .cardMinimums[].debtId  (#1426)
 *   bills[].paidState  'paid' | 'not-paid' | 'carried'            (#1429)
 *   budgetProgress.household.actual.amount / .planned.amount      (existing)
 *   householdBudget[] rows: label, spent, planned                 (existing)
 *   stackSummary.savings.items[] {label, saved, needed} and .totals
 *     {saved, needed, completeness, excludedLabels[]}             (A5; shape assumed until it merges)
 */
(function (root) {
  'use strict';


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
      if (v && v.start === key) return v; // key contract: the period's start date, 'YYYY-MM-DD'
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

  function strip(kind, title, sub, figure, figureOf, width, body, sep) {
    var f = figure == null ? '' : '<span class="sc-f">' + esc(figure) +
      (figureOf == null ? '' : '<i>' + (sep || ' / ') + esc(figureOf) + '</i>') + '</span>';
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

  // Savings (owner-approved design): "$saved of $needed" and a bar; open, one
  // row per goal with its own small bar. No Funded / Not funded wording.
  // Nothing renders until Forecast publishes stackSummary.savings (F8).
  function savingsCard(view) {
    var sv = get(view, ['stackSummary', 'savings']);
    if (!sv || typeof sv !== 'object') return '';
    var items = Array.isArray(sv.items) ? sv.items.filter(function (i) { return i && i.label; }) : [];
    var t = sv.totals || {};
    var saved = money(t.saved), needed = money(t.needed);
    if (saved == null && needed == null && !items.length) return '';
    var ex = t.completeness === 'partial' && Array.isArray(t.excludedLabels) && t.excludedLabels.length
      ? 'excludes ' + t.excludedLabels.join(', ') : null;
    var body = '<ul class="sc-list">' + items.map(function (i) {
      var s = money(i.saved), n = money(i.needed);
      return '<li class="sc-row"><span><b class="sc-n">' + esc(i.label) + '</b><span class="sc-mini"><i style="width:' +
        drawWidth(i.saved, i.needed) + '%"></i></span></span>' +
        (s == null && n == null ? '' : '<span class="sc-a">' + (s == null ? '' : esc(s)) +
          (n == null ? '' : '<i> of ' + esc(n) + '</i>') + '</span>') + '</li>';
    }).join('') + '</ul>';
    return strip('savings', 'Savings', ex || 'saved / needed', saved, needed, drawWidth(t.saved, t.needed), items.length ? body : '', ' of ');
  }

  function buildCardsHTML(ctx) {
    var view = selectView(ctx);
    if (!view) return '';
    return '<div class="sc-cards">' + billsCard(view) + budgetCard(view) + mortgageCard(view) + savingsCard(view) + '</div>';
  }

  function render(container, ctx) {
    if (!container) return;
    container.innerHTML = buildCardsHTML(ctx);
  }

  if (root.StackBlocks && typeof root.StackBlocks.register === 'function') root.StackBlocks.register('cards', render);
  if (typeof module !== 'undefined' && module.exports) module.exports = { render: render, buildCardsHTML: buildCardsHTML };
})(typeof window !== 'undefined' ? window : globalThis);
