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
 *     {saved, entitlement, entitlement, completeness ('pool-level' | 'none'), excluded[], reasons[]}  (A5; plain numbers or null)
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
    // A whole-dollar value prints without cents ($0, $350); any cents still print.
    var whole = Math.round(Math.abs(v) * 100) % 100 === 0;
    var s = Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
    return (v < 0 ? '−' : '') + '$' + s;
  }

  // Forecast's trust word travels with its figure (CLAUDE.md: tag every figure). Only
  // 'estimated' needs a mark; 'unavailable' figures are null and print nothing.
  // The page carries no text label (owner decision): the mark is visual only.
  function isEst() {
    for (var i = 0; i < arguments.length; i++) if (arguments[i] === 'estimated') return true;
    return false;
  }
  // No label: an estimated figure is drawn softer (class stack-est), never worded.
  function estCls(on) { return on ? ' stack-est' : ''; }
  function estWrap(tag, on, html) { return '<' + tag + (on ? ' class="stack-est"' : '') + '>' + html + '</' + tag + '>'; }

  // A bar's fill as a CSS percentage, from the shell's one shared drawing ratio (StackBlocks.barWidth, 0 to 1,
  // or null for no bar). Drawing only; never printed.
  function fill(part, whole) {
    var sb = root.StackBlocks;
    var r = sb && typeof sb.barWidth === 'function' ? sb.barWidth(part, whole) : null;
    return r == null ? 0 : r * 100;
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

  function strip(kind, title, sub, figure, figureOf, width, body, sep, tail, est) {
    var f = figure == null ? '' : '<span class="sc-f' + estCls(est) + '">' + esc(figure) +
      (figureOf == null ? '' : '<i>' + (sep || ' / ') + esc(figureOf) + (tail || '') + '</i>') + '</span>';
    return '<details class="sc-card sc-' + kind + '" data-stack-card="' + kind + '" style="--sc-k:var(--sc-' + kind + ')">' +
      '<summary><span class="sc-t">' + esc(title) + '</span>' + (sub ? '<span class="sc-s">' + esc(sub) + '</span>' : '') + f + '</summary>' +
      '<div class="sc-bar' + (figure == null ? '' : estCls(est)) + '"><i style="width:' + width + '%"></i></div>' + body + '</details>';
  }

  // Tappable by attribute only; the shell's sheet owns what opens. A row without
  // the ids to name its target carries no attribute.
  function sheetAttrs(target) {
    return target ? ' data-stack-sheet="' + esc(target) + '" role="button" tabindex="0"' : '';
  }
  function billTarget(kind, r) {
    return r && r.id != null && r.date != null ? kind + ':' + r.id + '@' + r.date : null;
  }

  function stateWord(row) { return row.paidState === 'paid' ? 'Paid' : 'Not paid'; }
  function stateRow(label, amountText, paid, word, target) {
    return '<li class="sc-row"' + sheetAttrs(target) + '><span><b class="sc-n">' + esc(label) + '</b><small class="sc-st' + (paid ? ' sc-paid' : '') + '">' +
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
      return stateRow(r.label || r.name || 'Bill', money(r.amount), r.paidState === 'paid', stateWord(r), billTarget('bill', r));
    }).join('') + '</ul>';
    var sub = rows.length ? paid + ' of ' + rows.length + ' paid' : 'paid / total';
    return strip('bills', 'Bills', sub, total, null, fill(paid, rows.length), rows.length ? body : '', null, null, isEst(split.trust));
  }

  function budgetCard(view) {
    var hh = get(view, ['budgetProgress', 'household']) || {};
    var spent = get(hh, ['actual', 'amount']), planned = get(hh, ['planned', 'amount']);
    var cats = (Array.isArray(view.householdBudget) ? view.householdBudget : []).filter(function (c) {
      return c && !c.informational && c.label;
    });
    // Forecast withholds the original plan (household.planned.amount null) for a completed period
    // without a dated snapshot: then no category denominator and no progress geometry is shown.
    var planPublished = isNum(planned);
    var hhEst = isEst(get(hh, ['actual', 'trust']), get(hh, ['planned', 'trust']));
    var body = '<ul class="sc-list">' + cats.map(function (c) {
      var s = money(c.spent), p = planPublished ? money(c.planned) : null;
      // Forecast's published semantics, as plan.js householdBudgetRowHtml reads them: the row is estimated by
      // its confidence or trust; the plan is estimated when its own trust is absent or estimated (an Other row
      // only with a dated plan); spent is estimated when the plan's trust is calculated or spentTrust says so.
      var other = c.otherSpending === true;
      var dated = other && typeof c.targetEffectiveFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.targetEffectiveFrom) && isNum(c.planned);
      var rowEst = c.confidence === 'estimated' || c.trust === 'estimated';
      var plannedEst = (!other || dated) && rowEst && (c.plannedTrust == null || c.plannedTrust === 'estimated');
      var spentEst = rowEst && (c.plannedTrust === 'calculated' || c.spentTrust === 'estimated');
      return '<li class="sc-row"' + sheetAttrs(c.id != null ? 'budget:' + c.id : null) + '><span><b class="sc-n">' + esc(c.label) + '</b>' +
        (p == null ? '' : '<span class="sc-mini"><i style="width:' + fill(c.spent, c.planned) + '%"></i></span>') + '</span>' +
        (s == null && p == null ? '' : '<span class="sc-a">' + (s == null ? '' : estWrap('span', spentEst, esc(s))) + (p == null ? '' : estWrap('i', plannedEst, ' / ' + esc(p))) + '</span>') + '</li>';
    }).join('') + '</ul>';
    var head = money(spent);
    return strip('budget', 'Budget', 'spent / budget', head, money(planned), fill(spent, planned), cats.length ? body : '', null, null, hhEst);
  }

  function mortgageCard(view) {
    var total = money(get(view, ['stackSummary', 'bills', 'mortgage']));
    var row = (Array.isArray(view.bills) ? view.bills : []).filter(function (r) {
      return isMortgageRow(r) && r.paidState && r.paidState !== 'carried';
    })[0];
    var paid = !!row && row.paidState === 'paid';
    var body = row ? '<ul class="sc-list">' + stateRow(row.label || row.name || 'Mortgage', money(row.amount), paid, stateWord(row), billTarget('mortgage', row)) + '</ul>' : '';
    var sub = row ? stateWord(row) : 'paid / total';
    return strip('mortgage', 'Mortgage', sub, total, null, paid ? 100 : 0, body, null, null, isEst(get(view, ['stackSummary', 'bills', 'trust'])));
  }

  // Savings (owner-approved design): "$saved of $needed" and a bar; open, one
  // row per goal with its own small bar. No Funded / Not funded wording.
  // Nothing renders until Forecast publishes stackSummary.savings (F8).
  function savingsCard(view) {
    var sv = get(view, ['stackSummary', 'savings']);
    if (!sv || typeof sv !== 'object') return '';
    var items = Array.isArray(sv.items) ? sv.items.filter(function (i) { return i && i.label; }) : [];
    var t = sv.totals || {};
    var amt = function (v) { return v; }; // plain numbers or null (A5)
    var has = function (list, code) { return Array.isArray(list) && list.indexOf(code) >= 0; };
    var labelOf = {};
    items.forEach(function (i) { if (i.id != null) labelOf[String(i.id)] = i.label; });
    var exLabels = (Array.isArray(t.excluded) ? t.excluded : []).map(function (id) { return labelOf[String(id)]; })
      .filter(function (l) { return l; }); // an id with no listed item has no label to print
    var ex = exLabels.length ? 'excludes ' + exLabels.join(', ') : null;
    // Header: current period, the pool's "moved of entitlement this period" (only when both
    // are published); a next or future period, the planned total with nothing moved; a past
    // period, no amount. A withheld value prints nothing, never $0.
    var moved = money(t.saved), entitlement = money(t.entitlement), planned = money(t.needed);
    var head, headOf = null, sub, tail = null, sep = null, width = 0;
    if (moved != null && entitlement != null) {
      head = moved; headOf = entitlement; sep = ' moved of '; tail = ' this period'; sub = '';
      width = fill(t.saved, t.entitlement);
    } else if (has(t.reasons, 'future-period') && planned != null) {
      head = planned; sub = 'planned this period';
    } else { head = null; sub = ''; }
    if (head == null && !items.length) return '';
    var headEst = head != null && isEst(t.trust, moved != null && entitlement != null ? t.entitlementTrust : null);
    if (ex) sub = ex;
    var body = '<ul class="sc-list">' + items.map(function (i) {
      var s = money(i.saved), n = money(i.needed), tg = money(i.periodTarget);
      var own = s != null; // this goal's own published saved value (current period, nearest due first)
      if (own) {
        // "$saved of $periodTarget" with a full-width bar; periodTarget is Forecast's, not added here.
        return '<li class="sc-row sc-own"><span class="sc-n">' + esc(i.label) + '</span>' +
          '<span class="sc-a' + estCls(isEst(i.savedTrust, i.trust)) + '">' + esc(s) + (tg == null ? '' : '<i> of ' + esc(tg) + '</i>') + '</span>' +
          '<span class="sc-mini sc-full' + estCls(isEst(i.savedTrust, i.trust)) + '"><i style="width:' + fill(i.saved, i.periodTarget) + '%"></i></span></li>';
      }
      var word = has(i.reasons, 'net-of-period-transfers') ? 'still to set aside ' : 'needs ';
      var right = n == null || has(i.reasons, 'past-period') ? ''
        : has(i.reasons, 'future-period') ? '<span class="sc-a' + estCls(isEst(i.trust)) + '">' + esc(n) + '<i> planned this period</i></span>'
        : '<span class="sc-a' + estCls(isEst(i.trust)) + '"><i>' + word + '</i>' + esc(n) + '</span>';
      return '<li class="sc-row"><span><b class="sc-n">' + esc(i.label) + '</b></span>' + right + '</li>';
    }).join('') + '</ul>';
    return strip('savings', 'Savings', sub, head, headOf, width, items.length ? body : '', sep, tail, headEst);
  }

  function buildCardsHTML(ctx) {
    var view = selectView(ctx);
    if (!view) return '';
    return '<div class="sc-cards">' + billsCard(view) + budgetCard(view) + mortgageCard(view) + savingsCard(view) + '</div>';
  }

  function render(container, ctx) {
    if (!container) return;
    container.innerHTML = buildCardsHTML(ctx);
    // Enter or Space on a focused row acts as a click (once per container).
    if (!container.__stackCardsKeys && typeof container.addEventListener === 'function') {
      container.__stackCardsKeys = true;
      container.addEventListener('keydown', function (e) {
        var t = e.target;
        if ((e.key === 'Enter' || e.key === ' ') && t && t.getAttribute && t.getAttribute('data-stack-sheet') && typeof t.click === 'function') {
          e.preventDefault();
          t.click();
        }
      });
    }
  }

  if (root.StackBlocks && typeof root.StackBlocks.register === 'function') root.StackBlocks.register('cards', render);
  if (typeof module !== 'undefined' && module.exports) module.exports = { render: render, buildCardsHTML: buildCardsHTML };
})(typeof window !== 'undefined' ? window : globalThis);
