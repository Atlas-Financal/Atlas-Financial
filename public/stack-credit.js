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

  // The published status, without words (owner, 2026-11-20: names, numbers, bars and the ✓ only): paid back is the
  // tick; "to go" is the coral remaining amount alone; upcoming and an unpublished status print nothing.
  // The design's wording (Dale, 2026-11-20: follow the design): "Paid back" with its tick, or the coral "$X to go" from the
  // published toGo; upcoming and an unpublished status print nothing.
  function statusOf(line) {
    if (line.status === 'paid-back') return { cls: 'is-ok', text: 'Paid back' };
    if (line.status === 'to-go') return amountOf(line.toGo) == null ? null : { cls: 'is-togo', text: `${money(amountOf(line.toGo))} to go` };
    return null;
  }
  // The paid-back mark (the row's filled tick, the sheet's ✓) is a claim of its own: the card's spending this pay period
  // is paid back, not that its balance or any bill is paid. It shows whenever the published status is paid-back (a
  // missing mark would read as not paid), and carries the shell's one soft treatment when paid, spent or toGo is
  // estimated or the period is projected (owner: estimates are slightly softer). Its screen-reader name is "Paid back",
  // or "Paid back, estimated" when soft; nothing visible is added. (Atlas on #1444; the lead's ruling.)
  const paidBackEst = (line, view) => est(view, trustOf(line.paid), trustOf(line.spent), trustOf(line.toGo));
  const paidBackName = soft => `role="img" aria-label="Paid back${soft ? ', estimated' : ''}"`;

  // "Minimum $X" whenever the minimum amount is published, whatever its coverage check says (#1443's HELOC and a future
  // card publish coverage 'unknown'); a ✓ only when coverage is published as true. Never a word for coverage (owner,
  // 2026-11-20), never "covered" or "unpaid" inferred, and nothing (never $0) when the amount is not published.
  // Coverage is read only from the published check: true prints "covered ✓", false "not yet", 'unknown' prints no coverage
  // wording at all (an unknown must not read as covered or as short).
  const coverage = line => (line.minimumCovered && (line.minimumCovered.value === true || line.minimumCovered.value === false)
    ? line.minimumCovered.value : null);
  const covered = line => coverage(line) === true;
  function minimumText(line) {
    const min = amountOf(line.minimum);
    const cv = coverage(line);
    return min == null ? '' : `Minimum ${money(min)}${cv === true ? ' covered ✓' : cv === false ? ' not yet' : ''}`;
  }
  // The minimum's own trust; the coverage check's trust only when its wording is printed.
  const minimumEst = (view, line) => est(view, trustOf(line.minimum), coverage(line) !== null ? line.minimumCovered.trust : null);
  const paidOfSpent = line => (amountOf(line.paid) != null && amountOf(line.spent) != null
    ? `${money(amountOf(line.paid))} of ${money(amountOf(line.spent))}` : '');
  // The row's second line, in the design's words from the published paid and spent only: "Paid back $P of $S", or
  // "Paid $P · nothing spent" when spent is published as nothing.
  function subText(line) {
    const p = amountOf(line.paid), s = amountOf(line.spent);
    if (p == null || s == null) return '';
    if (s === 0) return p === 0 ? 'Nothing spent yet' : `Paid ${money(p)} · nothing spent`;
    return `Paid back ${money(p)} of ${money(s)}`;
  }
  // The card's last balance snapshot (#1447's line.balance, a stock, never a movement): printed only where the line's
  // paid and spent are not both published, with its own trust (soft when estimated). Nothing when unpublished, never $0.
  const balanceShown = line => line.id !== 'heloc' && !paidOfSpent(line) && amountOf(line.balance) != null;
  // Its screen-reader name says what the bare number measures (Atlas on #1454): "Last balance $X", or "Last balance,
  // estimated, $X" when soft. The visible text stays the number alone; role="img" makes the name the one announcement.
  const balanceAttrs = (line, soft) => `role="img" aria-label="Last balance${soft ? ', estimated,' : ''} ${esc(money(amountOf(line.balance)))}"`;

  function lineHtml(line, view) {
    const heloc = line.id === 'heloc';
    const status = heloc ? null : statusOf(line);
    const sub = heloc ? '' : subText(line);
    const min = minimumText(line);
    const ok = !heloc && line.status === 'paid-back';
    const okEst = ok ? paidBackEst(line, view) : '';
    // A status is read from the line's paid and spent (and toGo when it prints an amount): soft when any is estimated.
    const figs = est(view, trustOf(line.paid), trustOf(line.spent));
    const stat = est(view, trustOf(line.paid), trustOf(line.spent), status && status.cls === 'is-togo' ? trustOf(line.toGo) : null);
    const minEst = minimumEst(view, line);
    return `<li><button class="stack-credit-line" type="button" data-stack-sheet="card:${esc(line.id)}">`
      + `<span class="stack-credit-tick${ok ? ` is-on${okEst}" ${paidBackName(okEst)}` : '"'}>${TICK}</span>`
      + `<span class="stack-credit-name"><span class="stack-credit-top"><b>${esc(line.label)}</b></span>`
      + (sub ? `<small class="stack-credit-sub-line${figs}">${esc(sub)}</small>` : '')
      + (balanceShown(line) ? `<small class="stack-credit-bal stack-n${est(view, trustOf(line.balance))}" data-stack-credit-balance ${balanceAttrs(line, est(view, trustOf(line.balance)))}>${esc(money(amountOf(line.balance)))}</small>` : '')
      + (heloc ? '' : bar(amountOf(line.paid), amountOf(line.spent), 'stack-credit-minibar' + figs))
      + (min ? `<small class="stack-credit-min${minEst}">${esc(min)}</small>` : '') + '</span>'
      // The status sits on the right, centred on the row, as in the design.
      + `<span class="stack-credit-status stack-n ${status ? status.cls : ''}${status && status.text ? stat : ''}">${status ? esc(status.text) : ''}</span>`
      + `${CHEV}</button></li>`;
  }

  let open = false;
  function cardHtml(reading) {
    const t = reading.totals;
    // Only a complete total prints (owner, 2026-11-20: no explanatory text, so a partial total cannot name what it leaves
    // out; it prints nothing rather than look whole, until LEDGER A's snapshot totals). The per-card lines still show.
    const shown = num(t.paid) && num(t.spent) && t.completeness === 'complete';
    const totalEst = est(reading.view, t.trust);
    return `<section class="stack-credit${open ? ' is-open' : ''}" data-stack-credit>`
      + `<button class="stack-credit-head" type="button" data-stack-credit-toggle aria-expanded="${open}">`
      + '<span class="stack-credit-hd"><span class="stack-credit-title">Credit</span>'
      + '<span class="stack-credit-sub">paid back / spent</span>'
      // A withheld total prints a soft dash and an empty track, never a blank, a $0 or a guessed fill.
      + (shown ? `<span class="stack-credit-figure stack-n${totalEst}" data-stack-credit-total>${esc(money(t.paid))}<i> / ${esc(money(t.spent))}</i></span>`
        : '<span class="stack-credit-figure stack-n stack-est" data-stack-credit-total data-unpublished>\u2014</span>')
      + '</span><span class="stack-credit-go">' + CHEV + '</span></button>'
      + (shown ? bar(t.paid, t.spent, 'stack-credit-bar' + totalEst) : '<span class="stack-credit-bar" aria-hidden="true"><i style="width:0%"></i></span>')
      + `<div class="stack-credit-exp"${open ? '' : ' inert'}><div><ul class="stack-credit-list">`
      + reading.lines.map(line => lineHtml(line, reading.view)).join('') + '</ul></div></div></section>';
  }

  // The sheet's view of one line (stack-sheet.js asks for it with its own helpers).
  function sheetHtml(line, h, view) {
    const heloc = line.id === 'heloc';
    const figs = est(view, trustOf(line.paid), trustOf(line.spent));
    const minEst = minimumEst(view, line);
    const status = heloc ? null : statusOf(line);
    const paid = amountOf(line.paid), spent = amountOf(line.spent), min = amountOf(line.minimum);
    const tx = Array.isArray(line.transactions) ? line.transactions : [];
    return h.head('Credit', line.label || '')
      + (paid != null && spent != null ? `<div class="stack-sheet-big stack-n${figs}">${h.esc(h.money(paid))}<i> of ${h.esc(h.money(spent))}</i></div>`
        : balanceShown(line) ? `<div class="stack-sheet-big stack-n${est(view, trustOf(line.balance))}" data-stack-credit-balance ${balanceAttrs(line, est(view, trustOf(line.balance)))}>${h.esc(h.money(amountOf(line.balance)))}</div>` : '')
      // The status pill under the figure, as in the design: "Paid back" (dark) or the coral "$X to go".
      + (!heloc && line.status === 'paid-back'
        ? `<span class="stack-credit-pill is-ok${paidBackEst(line, view)}">Paid back</span>` : '')
      + (status && status.cls === 'is-togo' ? `<span class="stack-credit-pill is-togo stack-n${est(view, trustOf(line.toGo))}">${h.esc(status.text)}</span>` : '')
      + (heloc ? '' : bar(paid, spent, 'stack-sheet-bar' + figs))
      + '<dl>' + (heloc ? '' : h.row('Spent on it this pay period', h.money(spent), est(view, trustOf(line.spent)))
        + h.row('Paid onto it', h.money(paid), est(view, trustOf(line.paid))))
      + (min != null ? (coverage(line) === null ? h.row('Minimum', h.money(min), minEst)
        // The amount sits in the label, so its own treatment goes on the label; the coverage word carries the check's.
        : h.row('Minimum ' + h.money(min), covered(line) ? 'Covered ✓' : 'Not yet', est(view, line.minimumCovered.trust),
          est(view, trustOf(line.minimum)))) : '')
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
