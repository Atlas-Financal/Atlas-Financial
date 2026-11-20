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
 *   stackSummary.bills.other / .mortgage                           (#1426)
 *   bills[].stackBillPart / .stackBillAmount  Forecast's own place for each row in that split and the amount it
 *     counts there: a card lists exactly its part's rows, so its rows add up to its head. A row with no mark is
 *     not listed (Forecast marks no row when it cannot say), never placed by a rule of this page.
 *   bills[].stackBillPaymentEvidence / .stackBillAmountTrust  the paid check only for 'posted-equal' (#1465)
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

  // Formatting only: the page's one money format (StackBlocks.money, whole dollars); null for an unpublished amount.
  function money(v) {
    return isNum(v) ? root.StackBlocks.money(v) : null;
  }

  // Forecast's trust word travels with its figure (CLAUDE.md: tag every figure). Only
  // 'estimated' needs a mark; 'unavailable' figures are null and print nothing.
  // The page carries no text label (owner decision): the mark is visual only.
  // B5: the shell's one rule (StackBlocks.isEstimated): a figure is soft when its published trust is estimated, or
  // when the selected pay period is projected (estView, set for the duration of one build).
  var estView = null;
  function isEst() {
    var sb = root.StackBlocks;
    if (!sb || typeof sb.isEstimated !== 'function') return false;
    if (sb.isEstimated(null, estView)) return true;
    for (var i = 0; i < arguments.length; i++) if (sb.isEstimated(arguments[i], null)) return true;
    return false;
  }
  // A budget category's printed amounts, by Forecast's budget-row semantics (the shell's one reader).
  function budgetEst(c) {
    var sb = root.StackBlocks;
    var t = sb && typeof sb.budgetTrust === 'function' ? sb.budgetTrust(c) : {};
    return { spent: isEst(t.spent), planned: isEst(t.planned) };
  }
  // No label: an estimated figure is drawn softer (class stack-est), never worded.
  function estCls(on) { return on ? ' stack-est' : ''; }

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

  // The rows Forecast placed in one part of the bills split (stackBillPart), in published order.
  function partRows(view, part) {
    return (Array.isArray(view.bills) ? view.bills : []).filter(function (r) { return r && r.stackBillPart === part; });
  }

  function strip(kind, title, sub, figure, figureOf, width, body, sep, tail, est, dash) {
    var f = figure == null ? (dash ? '<span class="sc-f">' + DASH + '</span>' : '') : '<span class="sc-f' + estCls(est) + '">' + esc(figure) +
      (figureOf == null ? '' : '<i>' + (sep || ' / ') + esc(figureOf) + (tail || '') + '</i>') + '</span>';
    // The bar sits in the head (always visible, closed or open), full width under the title and figure; an unpublished
    // figure draws an empty track, never a guessed fill.
    var bar = '<span class="sc-bar' + (figure == null ? '' : estCls(est)) + '" aria-hidden="true"><i style="width:' + width + '%"></i></span>';
    return '<details class="sc-card sc-' + kind + '" data-stack-card="' + kind + '" style="--sc-k:var(--sc-' + kind + ')">' +
      '<summary aria-expanded="false"><span class="sc-t">' + esc(title) + '</span>' + (sub ? '<span class="sc-s">' + esc(sub) + '</span>' : '') + f +
      '<span class="sc-go" aria-hidden="true">' + CHEV + '</span>' + bar + '</summary>' + body + '</details>';
  }

  // Tappable by attribute only; the shell's sheet owns what opens. A row without
  // the ids to name its target carries no attribute.
  function sheetAttrs(target) {
    return target ? ' data-stack-sheet="' + esc(target) + '" role="button" tabindex="0"' : '';
  }
  function billTarget(kind, r) {
    return r && r.id != null && r.date != null ? kind + ':' + r.id + '@' + r.date : null;
  }

  var DASH = '\u2014';
  // The round go button on every card head: a chevron that turns when the card is open.
  var CHEV = '<svg class="sc-chev" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2.5 9.5 7 5 11.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // The row's chevron, on every row that opens a sheet (static: it does not turn like the card's go button).
  var RCV = '<svg class="sc-cv" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2.5 9.5 7 5 11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // A bill row (owner decision, Dale 2026-11-20 on #1465: "a check for confirmed and no check for not confirmed"):
  // the item, the amount Forecast counted, and the check only for a confirmed payment, a posted payment exactly the
  // amount shown (stackBillPaymentEvidence 'posted-equal'). A pending, differing or unmatched payment shows no check and
  // the amount is named as the plan ("Planned $X"), or, for a differing posted payment, "$X, payment not confirmed". No status word is visible. An unpublished amount is a dash, never a zero.
  function stateRow(label, r, target) {
    var amountText = money(r.stackBillAmount);
    var evidence = r.stackBillPaymentEvidence;
    var exact = evidence === 'posted-equal';
    var soft = isEst(r.stackBillAmountTrust);
    // A pending or unmatched payment counts the plan; a differing posted payment may count above it (the Bills total
    // rule), so it is named from what it is, never "Planned".
    var name = amountText == null ? null : exact ? 'Paid ' + amountText
      : evidence === 'posted-differs' ? amountText + ', payment not confirmed' : 'Planned ' + amountText;
    return '<li class="sc-row sc-bill' + (target ? ' sc-go-row' : '') + '"' + sheetAttrs(target) + '><span class="sc-n">' + esc(label) + '</span>' +
      '<span class="sc-a' + estCls(soft) + '"' + (name ? ' aria-label="' + esc(name) + '"' : '') + '>' + (amountText == null ? DASH : esc(amountText)) + '</span>' +
      '<span class="sc-ck">' + (exact ? '<span class="sc-check" role="img" aria-label="Paid">\u2713</span>' : '') + '</span>' + (target ? RCV : '') + '</li>';
  }

  function billsCard(view) {
    var split = get(view, ['stackSummary', 'bills']) || {};
    var rows = partRows(view, 'other');
    // The Bills and Mortgage bars stay an empty track until Forecast publishes a paid figure to fill them (the head's
    // total is not a paid amount, and a count of paid rows is not a share of money).
    var total = money(split.other);
    var body = '<ul class="sc-list">' + rows.map(function (r) {
      return stateRow(r.label || r.name || 'Bill', r, billTarget('bill', r));
    }).join('') + '</ul>';
    return strip('bills', 'Bills', '', total, null, 0, rows.length ? body : '', null, null, isEst(split.trust), true);
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
      var est = budgetEst(c);
      var tgt = c.id != null ? 'budget:' + c.id : null;
      // The mini bar is always drawn under the name; with no published plan it is an empty track, never a guessed fill.
      return '<li class="sc-row' + (tgt ? ' sc-go-row' : '') + '"' + sheetAttrs(tgt) + '><span><b class="sc-n">' + esc(c.label) + '</b>' +
        '<span class="sc-mini' + estCls(est.spent || est.planned) + '"><i style="width:' + (p == null ? 0 : fill(c.spent, c.planned)) + '%"></i></span></span>' +
        (s == null && p == null ? '' : '<span class="sc-a">' + (s == null ? '' : '<span' + (est.spent ? ' class="stack-est"' : '') + '>' + esc(s) + '</span>')
          + (p == null ? '' : '<i' + (est.planned ? ' class="stack-est"' : '') + '> / ' + esc(p) + '</i>') + '</span>') + (tgt ? RCV : '') + '</li>';
    }).join('') + '</ul>';
    var head = money(spent);
    return strip('budget', 'Budget', 'spent / budget', head, money(planned), fill(spent, planned), cats.length ? body : '', ' / ', null, hhEst, true);
  }

  function mortgageCard(view) {
    var total = money(get(view, ['stackSummary', 'bills', 'mortgage']));
    var rows = partRows(view, 'mortgage');
    var body = rows.length ? '<ul class="sc-list">' + rows.map(function (r) {
      return stateRow(r.label || r.name || 'Mortgage', r, billTarget('mortgage', r));
    }).join('') + '</ul>' : '';
    return strip('mortgage', 'Mortgage', '', total, null, 0, body, null, null, isEst(get(view, ['stackSummary', 'bills', 'trust'])), true);
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
    // Header: current period, the pool's "moved of entitlement this period" (only when both
    // are published); a next or future period, the planned total with nothing moved; a past
    // period, no amount. A withheld value prints nothing, never $0.
    var moved = money(t.saved), entitlement = money(t.entitlement), planned = money(t.needed);
    var head, headOf = null, sub, tail = null, sep = null, width = 0;
    if (moved != null && entitlement != null) {
      head = moved; headOf = entitlement; sep = ' / '; sub = '';
      width = fill(t.saved, t.entitlement);
    } else if (has(t.reasons, 'future-period') && planned != null) {
      head = planned; sub = '';
    } else { head = null; sub = ''; }
    // No savings goals published at all: no card. A past period with nothing to print: no card (nothing is due in
    // the past, and a list of names and dashes is clutter). A current or future period whose figures are withheld
    // keeps its card with dashes: an unknown must not read as "nothing due".
    var printable = items.some(function (i) { return isNum(i.saved) || (has(i.reasons, 'future-period') && isNum(i.needed)); });
    if (head == null && !items.length) return '';
    if (head == null && !printable && view.timelineRole === 'past') return '';
    var headEst = head != null && isEst(t.trust, moved != null && entitlement != null ? t.entitlementTrust : null);
    var body = '<ul class="sc-list">' + items.map(function (i) {
      var s = money(i.saved), n = money(i.needed), tg = money(i.periodTarget);
      var own = s != null; // this goal's own published saved value (current period, nearest due first)
      if (own) {
        // "$saved of $periodTarget" with a full-width bar; periodTarget is Forecast's, not added here.
        return '<li class="sc-row sc-own"><span class="sc-n">' + esc(i.label) + '</span>' +
          '<span class="sc-a' + estCls(isEst(i.savedTrust, i.trust)) + '">' + esc(s) + (tg == null ? '' : '<i> / ' + esc(tg) + '</i>') + '</span>' +
          '<span class="sc-mini sc-full' + estCls(isEst(i.savedTrust, i.trust)) + '"><i style="width:' + fill(i.saved, i.periodTarget) + '%"></i></span></li>';
      }
      // No words (owner rule): a future period shows only its planned amount; any other row with no published
      // saved figure shows a dash (the net still-to-set-aside figure is not printed, so it never reads as the target).
      var right = has(i.reasons, 'future-period') && n != null
        ? '<span class="sc-a' + estCls(isEst(i.trust)) + '">' + esc(n) + '</span>'
        : '<span class="sc-a">' + DASH + '</span>';
      return '<li class="sc-row"><span><b class="sc-n">' + esc(i.label) + '</b></span>' + right + '</li>';
    }).join('') + '</ul>';
    return strip('savings', 'Savings', sub, head, headOf, width, items.length ? body : '', sep, tail, headEst, true);
  }

  function buildCardsHTML(ctx) {
    var view = selectView(ctx);
    if (!view) return '';
    estView = view;
    try {
      return '<div class="sc-cards">' + billsCard(view) + budgetCard(view) + mortgageCard(view) + savingsCard(view) + '</div>';
    } finally {
      estView = null;
    }
  }

  function render(container, ctx) {
    if (!container) return;
    container.innerHTML = buildCardsHTML(ctx);
    // Enter or Space on a focused row acts as a click (once per container); a card's open state is mirrored onto its head.
    if (!container.__stackCardsKeys && typeof container.addEventListener === 'function') {
      container.__stackCardsKeys = true;
      container.addEventListener('toggle', function (e) {
        var d = e.target, sum = d && d.querySelector && d.querySelector(':scope > summary');
        if (sum && d.hasAttribute) sum.setAttribute('aria-expanded', d.hasAttribute('open') ? 'true' : 'false');
      }, true);
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
