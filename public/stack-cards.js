/* Stack page: the Bills, Budget and Savings cards (behind ?view=stack only).
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
 *   stackSummary.bills.other                           (#1426)
 *   bills[].stackBillPart / .stackBillAmount  Forecast's own place for each row in that split and the amount it
 *     counts there: a card lists exactly its part's rows, so its rows add up to its head. A row with no mark is
 *     not listed (Forecast marks no row when it cannot say), never placed by a rule of this page.
 *   bills[].stackBillPaymentEvidence / .stackBillAmountTrust  the payment evidence and the counted amount's trust
 *   bills[].stackBillPaid  Forecast's paid check (stackBillPaidEvidence: 'posted-equal' (#1465) or 'posted-verified'
 *                          (Grok Bot's "bill verified" note)), the rows stackSummary.bills.paid sums
 *   stackSummary.bills.paid / .paidTrust  the Bills head's paid figure (Dale 2026-11-20 "bills needs the paid/owed")
 *   budgetProgress.household.actual.amount / .planned.amount      (existing)
 *   householdBudget[] rows: label, spent, planned                 (existing)
 *   stackSummary.savings.items[] {label, saved, needed, trust} and .totals {balance, saved, needed, unallocated,
 *     trust, reasons[]}  (owner rule 2026-11-20: the balance poured nearest due first; plain numbers or null)
 *   stackSummary.billsAccount {status, reason, now {amount, asOf, reason}, comingIn[], comingOut[] (status 'late'),
 *     householdToMove {amount}, alreadyOut[] (paid)}  the Bills account card (lead dispatch 2026-11-24)
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
  // The ctx of the build in progress (set for the duration of one build), so a bill row can ask its sheet what it shows.
  var buildCtx = null;
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
  // The look of an estimated figure: the shell's one treatment (StackBlocks.estClass), now none (owner decision, Dale,
  // 2026-11-23: no estimate styling). estAttr is the same for a bare element: empty when the treatment is none.
  function estCls(on) { var sb = root.StackBlocks; return on && sb && typeof sb.estClass === 'function' ? sb.estClass('estimated', null) : ''; }
  function estAttr(on) { var c = estCls(on).trim(); return c ? ' class="' + c + '"' : ''; }
  // A bill's printed name: the shell's one rule (StackBlocks.billName), or the label as given.
  function billName(label) {
    var sb = root.StackBlocks;
    return sb && typeof sb.billName === 'function' ? sb.billName(label) : (typeof label === 'string' ? label : '');
  }

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

  function strip(kind, title, sub, figure, figureOf, width, body, sep, tail, est, dash, srSub, noBar) {
    var f = figure == null ? (dash ? '<span class="sc-f">' + DASH + '</span>' : '') : '<span class="sc-f' + estCls(est) + '">' + esc(figure) +
      (figureOf == null ? '' : '<i>' + (sep || ' / ') + esc(figureOf) + (tail || '') + '</i>') + '</span>';
    // The bar sits in the head (always visible, closed or open), full width under the title and figure; an unpublished
    // figure draws an empty track, never a guessed fill.
    var bar = noBar ? '' : '<span class="sc-bar' + (figure == null ? '' : estCls(est)) + '" aria-hidden="true"><i style="width:' + width + '%"></i></span>';
    return '<details class="sc-card sc-' + kind + '" data-stack-card="' + kind + '" style="--sc-k:var(--sc-' + kind + ')">' +
      '<summary aria-expanded="false"><span class="sc-t">' + esc(title) + '</span>' + (sub ? '<span class="sc-s">' + esc(sub) + '</span>' : '') + (srSub ? '<span class="sc-sr">' + esc(srSub) + '</span>' : '') + f +
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
  // True when the row's tap-in sheet headline prints this row's amount and draws it soft: the sheet carries its estimate.
  function sheetMarks(r, target) {
    var sheet = root.StackSheet, sb = root.StackBlocks;
    if (!target || !buildCtx || !sheet || typeof sheet.billHeadline !== 'function' || !sb || typeof sb.isEstimated !== 'function') return false;
    var h = sheet.billHeadline(buildCtx, r);
    return !!h && isNum(h.amount) && isNum(r.stackBillAmount) && Math.round(h.amount * 100) === Math.round(r.stackBillAmount * 100)
      && sb.isEstimated(h.trust, estView);
  }
  function stateRow(label, r, target) {
    var amountText = money(r.stackBillAmount);
    var evidence = r.stackBillPaymentEvidence;
    // Forecast's one paid rule (stackBillPaidEvidence): a posted payment of exactly the plan, or one Grok Bot verified
    // with a "bill verified" note (counted at its own amount). The same rows stackSummary.bills.paid sums.
    var exact = r.stackBillPaid === true;
    // A pending or unmatched payment counts the plan; a differing posted payment may count above it (the Bills total
    // rule), so it is named from what it is, never "Planned".
    var name = amountText == null ? null : exact ? 'Paid ' + amountText
      : evidence === 'posted-differs' ? amountText + ', payment not confirmed' : 'Planned ' + amountText;
    // A row's estimate is marked in its tap-in sheet, so the card prints it plain (owner decision, Dale, 2026-11-22), but
    // only when that sheet actually shows this same amount with its estimate marking (StackSheet.billHeadline, the
    // sheet's own rule). A row with no sheet, a sheet whose headline is a dash (no or a mismatched history entry, an
    // unpublished amount) or a different amount keeps the soft look here: its only place (lead rulings on pre-review
    // 7075040773 and Atlas 7075134982: every figure stays tagged).
    var soft = amountText != null && isEst(r.stackBillAmountTrust) && !sheetMarks(r, target);
    return '<li class="sc-row sc-bill' + (target ? ' sc-go-row' : '') + '"' + sheetAttrs(target) + '><span class="sc-n">' + esc(label) + '</span>' +
      '<span class="sc-a' + estCls(soft) + '"' + (name ? ' aria-label="' + esc(name) + '"' : '') + '>' + (amountText == null ? DASH : esc(amountText)) + '</span>' +
      '<span class="sc-ck">' + (exact ? '<span class="sc-check" role="img" aria-label="Paid">\u2713</span>' : '') + '</span>' + (target ? RCV : '') + '</li>';
  }

  function billsCard(view) {
    var split = get(view, ['stackSummary', 'bills']) || {};
    var rows = partRows(view, 'other');
    // Dale (2026-11-20): "bills needs the paid/owed". The head is Forecast's paid (stackSummary.bills.paid, the
    // checked Bills rows) over the Bills total, as Budget prints spent / budget, and the bar is the shell's one
    // shared drawing ratio of the two, as Budget's. An unpublished paid is a dash and an empty bar, never $0.
    var paid = money(split.paid), total = money(split.other);
    var body = '<ul class="sc-list">' + rows.map(function (r) {
      return stateRow(billName(r.label || r.name) || 'Bill', r, billTarget('bill', r));
    }).join('') + '</ul>';
    // No greyed bill amounts on the rows (owner decision, Dale, 2026-11-22): an estimated bill amount keeps its published
    // trust and is drawn soft in its tap-in sheet (stack-sheet.js). The head (paid / total) and its bar have no sheet, so
    // they stay soft when estimated: the only place that total's trust can show (lead ruling, ATLAS LEAD 12, on
    // pre-review 7074755817; every figure stays tagged).
    return strip('bills', 'Bills', '', paid, total, paid == null ? 0 : fill(split.paid, split.other), rows.length ? body : '', ' / ', null,
      isEst(split.paidTrust, split.trust), true);
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
        (s == null && p == null ? '' : '<span class="sc-a">' + (s == null ? '' : '<span' + estAttr(est.spent) + '>' + esc(s) + '</span>')
          + (p == null ? '' : '<i' + estAttr(est.planned) + '> / ' + esc(p) + '</i>') + '</span>') + (tgt ? RCV : '') + '</li>';
    }).join('') + '</ul>';
    var head = money(spent);
    // No visible descriptor under the name (Dale, 2026-11-20); the words stay for a screen reader only.
    return strip('budget', 'Budget', '', head, money(planned), fill(spent, planned), cats.length ? body : '', ' / ', null, hhEst, true, 'spent / budget');
  }

  // Savings (owner rule, Dale 2026-11-20): the savings balance poured into the goals, nearest due first. Forecast
  // pours; this card prints. Head "$saved / $needed" with a bar; open, one row per goal, "$saved / $needed" with its
  // own small bar, then what is left over as Unallocated (only when Forecast publishes it above $0). A withheld figure
  // is a dash, never $0 and never hidden: the goal names always show. Forecast publishes the card for the current
  // and next periods only (stackSummary.savings is null elsewhere, and then there is no card).
  function savingsCard(view) {
    var sv = get(view, ['stackSummary', 'savings']);
    if (!sv || typeof sv !== 'object') return '';
    var items = Array.isArray(sv.items) ? sv.items.filter(function (i) { return i && i.label; }) : [];
    var t = sv.totals || {};
    var saved = money(t.saved), needed = money(t.needed);
    var known = saved != null && needed != null;
    var headEst = known && isEst(t.trust);
    var row = function (label, f, n, trust, width) {
      var est = estCls(isEst(trust));
      var right = f == null ? '<span class="sc-a">' + DASH + '</span>'
        : '<span class="sc-a' + est + '">' + esc(f) + (n == null ? '' : '<i> / ' + esc(n) + '</i>') + '</span>';
      var bar = width == null ? '' : '<span class="sc-mini sc-full' + est + '"><i style="width:' + width + '%"></i></span>';
      return bar ? '<li class="sc-row sc-own"><span class="sc-n">' + esc(label) + '</span>' + right + bar + '</li>'
        : '<li class="sc-row"><span><b class="sc-n">' + esc(label) + '</b></span>' + right + '</li>';
    };
    if (!items.length) {
      if (!t.balanceHeadTrust) return ''; // no goals in this period's pour
      var remainder = row('Unallocated', money(t.unallocated), null, t.trust, null);
      return strip('savings', 'Savings', 'Balance', money(t.balance), null, 0, '<ul class="sc-list">' + remainder + '</ul>',
        null, null, isEst(t.balanceHeadTrust), true);
    }
    var body = '<ul class="sc-list">' + items.map(function (i) {
      var f = money(i.saved), n = money(i.needed);
      return f != null && n != null ? row(i.label, f, n, i.trust, fill(i.saved, i.needed)) : row(i.label, null, null, null, null);
    }).join('') + (isNum(t.unallocated) && t.unallocated > 0 && known ? row('Unallocated', money(t.unallocated), null, t.trust, null) : '') + '</ul>';
    return strip('savings', 'Savings', '', known ? saved : null, known ? needed : null,
      known ? fill(t.saved, t.needed) : 0, body, ' / ', null, headEst, true);
  }

  // Bills account (lead dispatch 2026-11-24): the Bills bank account, read from Forecast's stackSummary.billsAccount (the
  // active pay period only; no card elsewhere). Closed: the bank reading now and its date, no projection and no bar; a
  // missing, misaligned or stale reading is a dash. Open: Coming in, Coming out this pay period
  // (Forecast's 'late' word on a past-due bill) with the Household budget still to move, and Already out (a check only
  // where Forecast's paid check is true). Every amount, date, word and list is Forecast's, printed as given; a bill row
  // opens its bill sheet. Unavailable lists show a dash.
  var DAY = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
  function day(iso) {
    return DAY && typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? DAY.format(new Date(iso + 'T12:00:00Z')) : '';
  }
  function accountRow(item, extra, check) {
    var target = item.billRow ? billTarget('bill', item) : null;
    var a = money(item.amount);
    var when = day(item.date) + (extra ? ' \u00b7 ' + extra : '');
    return '<li class="sc-row sc-acct' + (target ? ' sc-go-row' : '') + '"' + sheetAttrs(target) + '><span><b class="sc-n">' +
      esc(billName(item.label) || 'Item') + '</b>' + (when ? '<span class="sc-d">' + esc(when) + '</span>' : '') + '</span>' +
      '<span class="sc-a">' + (a == null ? DASH : esc(a)) + '</span>' +
      '<span class="sc-ck">' + (check ? '<span class="sc-check" role="img" aria-label="Paid">\u2713</span>' : '') + '</span>' +
      (target ? RCV : '') + '</li>';
  }
  function accountSection(caption, rows) {
    return rows ? '<li class="sc-cap">' + esc(caption) + '</li>' + rows : '';
  }
  function billsAccountCard(view) {
    var ba = get(view, ['stackSummary', 'billsAccount']);
    if (!ba || typeof ba !== 'object' || !ba.now) return '';
    var now = money(ba.now.amount);
    var sub = now == null ? '' : 'Bank reading ' + day(ba.now.asOf);
    var body;
    if (ba.status !== 'ready') {
      body = '<p class="sc-unavailable">' + DASH + '</p>';
    } else {
      var list = function (rows, fn) { return (Array.isArray(rows) ? rows : []).filter(function (r) { return r; }).map(fn).join(''); };
      var hh = ba.householdToMove || {};
      var hhRow = '<li class="sc-row sc-acct"><span><b class="sc-n">Household budget still to move</b></span>' +
        '<span class="sc-a">' + (money(hh.amount) == null ? DASH : esc(money(hh.amount))) + '</span><span class="sc-ck"></span></li>';
      body = '<ul class="sc-list">' +
        accountSection('Coming in', list(ba.comingIn, function (r) { return accountRow(r, null, false); })) +
        accountSection('Coming out \u00b7 this pay period', list(ba.comingOut, function (r) {
          return accountRow(r, r.status === 'late' ? 'late' : null, false);
        }) + hhRow) +
        accountSection('Already out', list(ba.alreadyOut, function (r) { return accountRow(r, null, r.paid === true); })) +
        '</ul>';
    }
    return strip('billsacct', 'Bills account', sub, now, now == null ? null : '', 0, body, ' now', null, false, true, null, true);
  }

  function buildCardsHTML(ctx) {
    var view = selectView(ctx);
    if (!view) return '';
    estView = view;
    buildCtx = ctx;
    try {
      return '<div class="sc-cards">' + billsCard(view) + budgetCard(view) + savingsCard(view) + billsAccountCard(view) + '</div>';
    } finally {
      estView = null;
      buildCtx = null;
    }
  }

  function render(container, ctx) {
    if (!container) return;
    container.innerHTML = buildCardsHTML(ctx);
    // Enter or Space on a focused row acts as a click; a card's open state is mirrored onto its head. Listened for on the
    // pile (once), because the shell places each card in its own slot of the pile (reorderable stacks), outside this
    // container; only this block's cards are handled.
    var host = (container.closest && container.closest('[data-stack-pile]')) || container;
    if (!host.__stackCardsKeys && typeof host.addEventListener === 'function') {
      host.__stackCardsKeys = true;
      host.addEventListener('toggle', function (e) {
        var d = e.target, sum = d && d.querySelector && d.classList && d.classList.contains('sc-card') && d.querySelector(':scope > summary');
        if (sum && d.hasAttribute) sum.setAttribute('aria-expanded', d.hasAttribute('open') ? 'true' : 'false');
      }, true);
      host.addEventListener('keydown', function (e) {
        var t = e.target;
        if ((e.key === 'Enter' || e.key === ' ') && t && t.getAttribute && t.getAttribute('data-stack-sheet') && t.closest && t.closest('.sc-card')
          && typeof t.click === 'function') {
          e.preventDefault();
          t.click();
        }
      });
    }
  }

  if (root.StackBlocks && typeof root.StackBlocks.register === 'function') root.StackBlocks.register('cards', render);
  if (typeof module !== 'undefined' && module.exports) module.exports = { render: render, buildCardsHTML: buildCardsHTML };
})(typeof window !== 'undefined' ? window : globalThis);
