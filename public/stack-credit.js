/* Stack Wallet block 'credit' (B4): the Credit card. Design: the Stack Wallet artifact (invented data).
 *
 * Reads Forecast.stackCreditLines (A6b, LEDGER A) for the selected pay period:
 *   Forecast.stackCreditLines(Forecast.cardPeriodMovements(plan, debts, asOf, {start, end},
 *     {currentPeriodActuals, cardPeriodBalanceEvidence, liveOverlay}), view.stackSummary.bills)
 *   -> { lines: [{ id, label, paid, spent, net, minimum, toGo (figures {amount|null, trust, reasons}), status,
 *                  minimumCovered: {value: true|false|'unknown'}, transactions }],
 *        totals: { paid, spent, trust, completeness: 'complete'|'partial'|'none', excluded: [ids], reasons } }
 *
 * Closed: "Credit" and paid / spent from totals, only when the total is complete (a partial or missing total prints
 * no figure and no bar). Open: one row per line: "$A of $B", the coral remaining amount when published as to go, the
 * tick when paid back, and "Minimum $X" with a ✓ only when covered. HELOC shows its minimum only. Each row opens the sheet
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
  const num = v => typeof v === 'number' && Number.isFinite(v);
  // The page's one money format (StackBlocks.money, whole dollars); '' for an unpublished amount.
  const money = v => window.StackBlocks.money(v);
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
      // Each line's name: its Lunch Money account's (StackBlocks.cardName), else Forecast's label.
      const name = line => window.StackBlocks && typeof window.StackBlocks.cardName === 'function'
        ? window.StackBlocks.cardName(d, line.id, line.label) : line.label;
      out = result && Array.isArray(result.lines) && result.totals
        ? { lines: result.lines.map(line => (line && typeof line === 'object' ? { ...line, label: name(line) } : line)), totals: result.totals, view }
        : null;
    }
    readings.set(ctx, out);
    return out;
  }
  const bar = (part, of, cls) => {
    const width = window.StackBlocks.barWidth ? window.StackBlocks.barWidth(part, of) : null;
    return width == null ? '' : `<span class="${cls}" aria-hidden="true"><i style="width:${(width * 100).toFixed(1)}%"></i></span>`;
  };
  // B5: the shell's one trust treatment, from the published trust of the figures printed (never inferred).
  const trustOf = figure => (figure && typeof figure === 'object' ? figure.trust : undefined);
  const est = (view, ...trusts) => (window.StackBlocks.estClass && trusts.some(t => window.StackBlocks.isEstimated(t, view))
    ? ' stack-est' : '');

  // Coverage is read only from the published check (minimumCovered.value): true, false, or null for 'unknown' or absent.
  // An unknown must read as neither covered nor short, so it prints no ✓ and no colour.
  // A published check counts only on trust the page may show: calculated or verified (plain) or estimated (soft). A check
  // whose trust is unavailable, unknown or any other word is no check: no green, no ✓, and it is not counted as covered.
  const COVERAGE_TRUST = ['calculated', 'verified', 'estimated'];
  const coverage = line => (line.minimumCovered && (line.minimumCovered.value === true || line.minimumCovered.value === false)
    && COVERAGE_TRUST.includes(line.minimumCovered.trust) ? line.minimumCovered.value : null);
  const dash = '<span class="stack-credit-dash stack-est" role="img" aria-label="not available">—</span>';

  // One line, read for the design's right-hand figure "X / minimum" (Dale, 2026-11-20: he approved the Credit Minimum
  // mock-up). Only published values are compared or printed; nothing is added or subtracted here:
  //   * paid or spent unpublished (a manual card, the HELOC): X is Forecast's published paidToward in normal type (a $0
  //     when nothing was paid or the card cannot be seen, the HELOC's posted payments), the one figure the head also sums
  //     (Dale, 2026-11-20); a dash only when Forecast withholds it (past period, failed sync), plain ink, no tick;
  //   * status 'to-go' (Forecast says spending is above payments): X is the published toGo, in red;
  //   * otherwise X is the published paid, in green with the filled ✓ only when minimumCovered is published true, a
  //     minimum is due, something was spent or paid and the period is not upcoming; plain ink when it is false or unknown;
  //   * nothing spent and nothing paid: "$0 / $min" in plain ink, no tick;
  //   * no minimum due (null): X alone, no "/ min", no tick.
  // Each field carries the shell's one soft treatment from its own published trust (X: the figures it is read from; the
  // minimum: its own; the tick: the coverage check's, with the minimum's and paid's).
  function readLine(line, view) {
    const paid = amountOf(line.paid), spent = amountOf(line.spent), cv = coverage(line);
    // A published $0 minimum is nothing owed: it reads as "not due" (X alone), like Forecast's explicit
    // no-minimum-due-in-period. Any other null minimum (the bills split withheld, an unqualified amount, an absent field) is an
    // unavailable minimum, which prints a dash, never reassurance.
    const published = amountOf(line.minimum);
    const min = published === 0 ? null : published;
    const minReasons = line.minimum && Array.isArray(line.minimum.reasons) ? line.minimum.reasons : [];
    const notDue = published === 0 || (published == null && minReasons.includes('no-minimum-due-in-period'));
    const out = { paid, spent, min, notDue, minOff: published == null && !notDue, x: null, tone: '', ok: false, xSoft: ' stack-est', minSoft: est(view, trustOf(line.minimum)), tickSoft: '' };
    // The ✓ circle means "minimum covered" and nothing else (Dale: "once that minimum is paid I want a check mark"): a
    // published true on trust the page may show, with a minimum due. The colour then shows over or under, so a red row can
    // carry the ✓ too. It agrees with the head bar and the waterfall, which count the same check.
    if (min != null && cv === true) {
      out.ok = true;
      out.tickSoft = est(view, trustOf(line.minimumCovered), trustOf(line.minimum), trustOf(line.paid));
    }
    const toward = amountOf(line.paidToward);
    if (paid == null || spent == null) {
      // Not read from a card ledger: the published paidToward, in normal type (no soft styling), never a guess.
      if (toward != null) { out.x = toward; out.xSoft = ''; }
    }
    if (paid != null && spent != null) {
      if (line.status === 'to-go') {
        out.x = amountOf(line.toGo);
        out.tone = out.x != null ? 'bad' : '';
        out.xSoft = est(view, trustOf(line.paid), trustOf(line.spent), trustOf(line.toGo));
      } else {
        out.x = paid;
        out.xSoft = est(view, trustOf(line.paid), trustOf(line.spent));
        // Green: the minimum is covered, the row is not red, something was spent or paid, and the period is not upcoming.
        if (out.ok && !(paid === 0 && spent === 0) && line.status !== 'upcoming') out.tone = 'good';
      }
    }
    return out;
  }
  // The figure: "X / min" (the minimum muted), the colour on X alone.
  // X is named for a screen reader so colour is never the only signal: "Owes $20 more than paid back" when red, "Paid $20"
  // otherwise (", estimated" when soft). The visible text stays the number; role="img" makes the name the announcement.
  const xName = r => (r.x == null ? '' : `${r.tone === 'bad' ? 'Owes ' + money(r.x) + ' more than paid back' : 'Paid ' + money(r.x)}${r.xSoft ? ', estimated' : ''}`);
  // X carries its direction as a printed sign (Dale, 2026-11-20: "I just need the plus minus there"): "\u2212$150" when the
  // card is behind (the published toGo, red), "+$250" for a published payment, a bare "$0" for nothing. The sign is text
  // joined to the shell's money format and chosen by comparing the published figure with zero, never by arithmetic.
  const signed = r => (r.tone === 'bad' ? '\u2212' + money(r.x) : r.x > 0 ? '+' + money(r.x) : money(r.x));
  const figureHtml = r => `<span class="stack-credit-x${r.tone ? ` is-${r.tone}` : ''}${r.x == null ? '' : r.xSoft}"${r.x == null ? '' : ` role="img" aria-label="${esc(xName(r))}"`}>${r.x == null ? dash : esc(signed(r))}</span>`
    + (r.min != null ? `<i class="stack-credit-of${r.minSoft}"> / ${esc(money(r.min))}</i>` : r.minOff ? `<i class="stack-credit-of"> / ${dash}</i>` : '');
  const paidOfSpent = line => (amountOf(line.paid) != null && amountOf(line.spent) != null
    ? `${money(amountOf(line.paid))} of ${money(amountOf(line.spent))}` : '');
  // The card's last balance snapshot (#1447's line.balance, a stock, never a movement): printed only where the line's
  // paid and spent are not both published, with its own trust (soft when estimated). Nothing when unpublished, never $0.
  const balanceShown = line => line.id !== 'heloc' && !paidOfSpent(line) && amountOf(line.balance) != null;
  // Its screen-reader name says what the bare number measures (Atlas on #1454): "Last balance $X", or "Last balance,
  // estimated, $X" when soft. The visible text stays the number alone; role="img" makes the name the one announcement.
  const balanceAttrs = (line, soft) => `role="img" aria-label="Last balance${soft ? ', estimated,' : ''} ${esc(money(amountOf(line.balance)))}"`;

  function lineHtml(line, view) {
    const r = readLine(line, view);
    const tick = r.ok ? ` is-on${r.tickSoft}" role="img" aria-label="Minimum covered${r.tickSoft ? ', estimated' : ''}"` : '"';
    return `<li><button class="stack-credit-line" type="button" data-stack-sheet="card:${esc(line.id)}">`
      + `<span class="stack-credit-tick${tick}>${TICK}</span>`
      + `<span class="stack-credit-name"><span class="stack-credit-top"><b>${esc(line.label)}</b></span>`
      + (balanceShown(line) ? `<small class="stack-credit-bal stack-n${est(view, trustOf(line.balance))}" data-stack-credit-balance ${balanceAttrs(line, est(view, trustOf(line.balance)))}>${esc(money(amountOf(line.balance)))}</small>` : '')
      + '</span>'
      // The figure sits on the right, centred on the row, as in the design.
      + `<span class="stack-credit-fig stack-n">${figureHtml(r)}</span>`
      + `${CHEV}</button></li>`;
  }

  let open = false;
  function cardHtml(reading) {
    const t = reading.totals, view = reading.view;
    // Both sides are Forecast's published totals over exactly the cards whose minimums are due (the HELOC left out), never
    // added up here: totals.minimumsPaid (paid toward them: $0 when nothing was paid, a due card Forecast cannot see counting
    // $0 by owner decision) over totals.minimumsDue. The paid figure prints in normal type, whatever its trust word (Dale,
    // 2026-11-20: no estimated distinction). A past period with incomplete posted coverage withholds minimumsPaid, so the paid
    // side is a dash there; the minimums due is a dash when it is withheld.
    // The bar is covered over due, from Forecast's two published counts, so it is full only when every due minimum is covered.
    const mp = t.minimumsPaid && typeof t.minimumsPaid === 'object' ? t.minimumsPaid : null;
    const paidShown = !!mp && num(mp.amount);
    const md = t.minimumsDue && typeof t.minimumsDue === 'object' ? t.minimumsDue : null;
    const due = md && num(md.amount) ? md.amount : null;
    const dueEst = est(view, md ? md.trust : null);
    const countsShown = num(t.minimumsDueCount) && num(t.minimumsCoveredCount);
    return `<section class="stack-credit${open ? ' is-open' : ''}" data-stack-credit>`
      + `<button class="stack-credit-head" type="button" data-stack-credit-toggle aria-expanded="${open}">`
      + '<span class="stack-credit-hd"><span class="stack-credit-title">Credit</span>'
      + '<span class="stack-credit-sr">paid / card minimums due</span>'
      // "paid / card minimums due": paid toward them is a published $0 when nothing has been paid; a withheld part is a soft
      // dash, never a blank or a guessed fill.
      + (paidShown || due != null
        ? `<span class="stack-credit-figure stack-n" data-stack-credit-total>${paidShown ? `<span>${esc(money(mp.amount))}</span>` : dash}`
          + (due != null ? `<i class="${dueEst.trim()}"> / ${esc(money(due))}</i>` : `<i> / ${dash}</i>`) + '</span>'
        : '<span class="stack-credit-figure stack-n stack-est" data-stack-credit-total data-unpublished>—</span>')
      + '</span><span class="stack-credit-go">' + CHEV + '</span></button>'
      // A bar with no ratio to draw (counts withheld, or nothing due) is an empty track, never a guessed fill.
      + ((countsShown && bar(t.minimumsCoveredCount, t.minimumsDueCount, 'stack-credit-bar' + est(view, t.minimumsCoveredTrust)))
        || '<span class="stack-credit-bar" aria-hidden="true"><i style="width:0%"></i></span>')
      + `<div class="stack-credit-exp"${open ? '' : ' inert'}><div><ul class="stack-credit-list">`
      + reading.lines.map(line => lineHtml(line, view)).join('') + '</ul></div></div></section>';
  }

  // The sheet's view of one line (stack-sheet.js asks for it with its own helpers): the same "X / minimum" figure as the
  // row, in the same colour, then "Paid onto it", "Spent on it" and "Minimum" (with its ✓ when covered, "Not due this
  // period" when no minimum is due), then the dated transactions.
  function sheetHtml(line, h, view) {
    const heloc = line.id === 'heloc';
    const r = readLine(line, view);
    const rowHtml = (label, valueHtml) => `<div><dt>${h.esc(label)}</dt><dd class="stack-n">${valueHtml}</dd></div>`;
    const soft = (text, cls) => `<span class="${cls.trim()}">${h.esc(text)}</span>`;
    const tx = Array.isArray(line.transactions) ? line.transactions : [];
    return h.head('Credit', line.label || '')
      + (r.x != null || r.min != null || !balanceShown(line)
        ? `<div class="stack-sheet-big stack-credit-big stack-n">${figureHtml(r)}</div>`
        : `<div class="stack-sheet-big stack-n${est(view, trustOf(line.balance))}" data-stack-credit-balance ${balanceAttrs(line, est(view, trustOf(line.balance)))}>${h.esc(h.money(amountOf(line.balance)))}</div>`)
      + '<dl>' + (heloc ? '' : (r.paid != null ? rowHtml('Paid onto it', soft(h.money(r.paid), est(view, trustOf(line.paid)))) : '')
        + (r.spent != null ? rowHtml('Spent on it', soft(h.money(r.spent), est(view, trustOf(line.spent)))) : ''))
      + (r.min != null
        ? rowHtml('Minimum', soft(h.money(r.min), r.minSoft) + (r.ok ? ' ' + soft('✓', r.tickSoft) : ''))
        : rowHtml('Minimum', r.notDue ? 'Not due this period' : dash))
      + '</dl>'
      + (heloc ? '' : '<h4 class="stack-sheet-txh">Transactions</h4>' + (tx.length
        ? '<ul class="stack-sheet-tx">' + tx.map(t => {
          // A payment onto the card is published negative with payment: true; its printed value's minus sign becomes "+".
          const printed = h.txMoney(t.amount);
          const shown = t.payment ? printed.replace(/^−/, '+') : printed;
          return `<li class="${t.payment ? 'is-pay' : ''}${t.pending ? ' is-pending' : ''}">`
            + `<span class="stack-sheet-txd">${h.esc(h.date(t.date))}</span><span class="stack-sheet-txl">${h.esc(t.name || '')}</span>`
            + `<span class="stack-sheet-txa stack-n">${h.esc(shown)}</span></li>`;
        }).join('') + '</ul>'
        : ''));
  }

  window.StackCredit = {
    read,
    line: (ctx, id) => { const r = read(ctx); return r ? r.lines.find(l => l && l.id === id) || null : null; },
    view: ctx => { const r = read(ctx); return r ? r.view : null; },
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
