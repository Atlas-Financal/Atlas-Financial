'use strict';
/* Stack page, waterfall block (B2; behind ?view=stack).
 *
 * The selected pay period's waterfall, copied from Forecast's publication:
 *
 *     Dale's income + Amanda's income + Other income = Total income
 *     − Bills − Budget − Mortgage − Credit
 *     = Surplus after deductions (or Deficit after deductions)
 *
 * Every amount is read from one named published value and printed as is
 * (L-001): no sum, difference or allocation of money happens here. The Total
 * is stackSummary.income.total, the Surplus is stackSummary.surplus.amount and
 * the Credit line is stackSummary.surplus.terms.credit, never added up on the
 * page. A value Forecast did not publish prints nothing for its row (F8),
 * never $0, so a saved close's withheld lines read blank.
 *
 * Sources, per row (see LINE_SOURCES):
 *   income lines   stackSummary.income.{dale,amanda,other,total}.amount
 *   Bills          stackSummary.bills.other
 *   Budget         budgetHold (the Household budget hold the surplus deducts)
 *   Mortgage       stackSummary.bills.mortgage
 *   Credit         creditBreakdown.stillToPayBack / stackSummary.surplus.terms.credit (OD-057), opening in place to one
 *                  row per card: stackSummary.creditBreakdown.rows[i].amount (its
 *                  Still to pay back, OD-033; no "Already counted above" row, Dale, 7121410691) (desk ruling
 *                  (E)), on completed and saved periods too (their Credit term stays
 *                  the minimums); where Forecast publishes no breakdown (no card
 *                  lines), stackSummary.bills.cardMinimums[i].amount
 *   Savings items  stackSummary.surplus.terms.savingsItemSpending, its own row only when Forecast published that
 *                  term and it is not zero (Surplus subtracts it, so the rows must show it); Surplus's own trust
 *   Surplus        stackSummary.surplus.amount
 *
 * Registered with the Stack shell as StackBlocks.register('waterfall', render),
 * render(container, ctx) with ctx = { data, plan, recommendation,
 * selectedPeriodKey, Forecast }. Pure apart from writing container.innerHTML
 * and one click listener for the Credit toggle. Its styles are its own file,
 * public/stack-waterfall.css (linked by the shell). */
(function init(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.StackBlocks && typeof root.StackBlocks.register === 'function') root.StackBlocks.register('waterfall', api.render);
  if (root) root.StackWaterfall = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi() {
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isAmount = v => typeof v === 'number' && Number.isFinite(v);
  // Display only: the page's one money format (StackBlocks.money, whole dollars). Formatting, not arithmetic.
  const money = v => globalThis.StackBlocks.money(v);
  const signed = v => globalThis.StackBlocks.money(v, { signed: true });

  // The one place each printed row names its published source.
  const LINE_SOURCES = Object.freeze({
    dale: 'stackSummary.income.dale.amount',
    amanda: 'stackSummary.income.amanda.amount',
    other: 'stackSummary.income.other.amount',
    total: 'stackSummary.income.total.amount',
    bills: 'stackSummary.bills.other',
    budget: 'budgetHold',
    mortgage: 'stackSummary.bills.mortgage',
    credit: 'stackSummary.surplus.terms.credit',
    savingsItem: 'stackSummary.surplus.terms.savingsItemSpending',
    surplus: 'stackSummary.surplus.amount',
  });
  // B5: the published trust of each row's figure, for the shell's one trust treatment (StackBlocks.estClass).
  const TRUST_SOURCES = Object.freeze({
    dale: 'stackSummary.income.dale.trust',
    amanda: 'stackSummary.income.amanda.trust',
    other: 'stackSummary.income.other.trust',
    total: 'stackSummary.income.total.trust',
    bills: 'stackSummary.bills.trust',
    budget: 'budgetHoldTrust',
    mortgage: 'stackSummary.bills.trust',
    credit: 'stackSummary.bills.trust',
    savingsItem: 'stackSummary.surplus.trust',
    surplus: 'stackSummary.surplus.trust',
  });
  const est = (view, path) => {
    const blocks = typeof globalThis !== 'undefined' ? globalThis.StackBlocks : null;
    return blocks && typeof blocks.estClass === 'function' ? blocks.estClass(readPath(view, path), view) : '';
  };
  const readPath = (view, path) => {
    let node = view;
    for (const key of path.split('.')) node = node && typeof node === 'object' ? node[key] : undefined;
    return node;
  };

  // The selected period: selectedPeriodKey is the period's start date
  // ('YYYY-MM-DD', lead ruling), matched on view.start only; with no key, the
  // active period, as the shell defaults.
  function selectedView(ctx) {
    const views = ctx && ctx.recommendation && Array.isArray(ctx.recommendation.payPeriodViews)
      ? ctx.recommendation.payPeriodViews.filter(v => v && typeof v === 'object') : [];
    const key = ctx ? ctx.selectedPeriodKey : null;
    if (key != null && key !== '') return views.find(v => v.start === key) || null;
    return views.find(v => v.role === 'active') || views.find(v => v.timelineRole === 'current') || null;
  }
  // The Lunch Money name first (StackBlocks.cardName), else the plan's debt label, else the id.
  const cardLabel = (ctx, debtId) => {
    const debt = ctx && ctx.data && Array.isArray(ctx.data.debts) ? ctx.data.debts.find(d => d && d.id === debtId) : null;
    const own = debt && typeof debt.label === 'string' && debt.label.trim() ? debt.label.trim() : String(debtId);
    const blocks = typeof globalThis !== 'undefined' ? globalThis.StackBlocks : null;
    return blocks && typeof blocks.cardName === 'function' ? blocks.cardName(ctx && ctx.data, debtId, own) : own;
  };

  // The Credit line's trust is its breakdown's where Forecast publishes one (the targets), else the bills split's.
  const trustSource = (view, key) => key === 'credit' && view.stackSummary && view.stackSummary.creditBreakdown
    ? 'stackSummary.creditBreakdown.trust' : TRUST_SOURCES[key];
  // One amount cell: the published value, or nothing (F8).
  function amountCell(view, key, { sign = false } = {}) {
    // A fixed internal path from the table above (the keys are literals in this file; a key not in it prints no source).
    const source = LINE_SOURCES[key];
    const value = readPath(view, source);
    return isAmount(value)
      ? `<span class="n${est(view, trustSource(view, key))}" data-source="${source}">${escape(sign ? signed(value) : money(value))}</span>`
      : `<span class="n" data-source="${source}" data-unpublished="true"></span>`;
  }
  // The design's marks before a label: a letter tile for each income line, a colour swatch for each deduction that
  // has its own card. Decoration only (aria-hidden); the label text is unchanged.
  const MARKS = Object.freeze({
    dale: '<span class="wf-av" aria-hidden="true">D</span>',
    amanda: '<span class="wf-av" aria-hidden="true">A</span>',
    other: '<span class="wf-av" aria-hidden="true">$</span>',
    bills: '<span class="wf-av wf-sw" style="--wf-k:var(--stack-bills)" aria-hidden="true"></span>',
    budget: '<span class="wf-av wf-sw" style="--wf-k:var(--stack-budget)" aria-hidden="true"></span>',
    mortgage: '<span class="wf-av wf-sw" style="--wf-k:var(--stack-mort)" aria-hidden="true"></span>',
    credit: '<span class="wf-av wf-sw" style="--wf-k:var(--stack-cards)" aria-hidden="true"></span>',
  });
  // A mark is one of the constant strings above, chosen by a fixed internal row name; '' for any other name.
  const mark = name => MARKS[name] || '';
  const line = (op, label, cell, cls = '', row = '') =>
    `<li class="wf-line ${cls}" data-row="${row}"><span class="op" aria-hidden="true">${op}</span><span class="lab">${mark(row)}${escape(label)}</span>${cell}</li>`;

  // An unpublished amount the row still names: a dash, never $0, read by a screen reader as "not available".
  const DASH = '<span class="wf-dash" role="img" aria-label="not available">\u2014</span>';

  // A paid minimum's check (owner, Dale, 2026-11-20: "once that minimum is paid I want a check mark"). Read only
  // from Forecast's published coverage for that card, the Credit block's one reading (StackCredit.line, joined by
  // debt id, never by name): a check exactly when minimumCovered.value is true, drawn soft when its trust is
  // estimated. None for false or 'unknown', none in a projected or future period, none when no coverage is published
  // (the HELOC's cash minimum included), never guessed.
  const CHECK_TRUST = new Set(['calculated', 'verified', 'estimated']);
  function creditLine(ctx, debtId) {
    const credit = typeof globalThis !== 'undefined' ? globalThis.StackCredit : null;
    return credit && typeof credit.line === 'function' && debtId != null ? credit.line(ctx, debtId) : null;
  }
  function minimumCheck(view, line) {
    const blocks = typeof globalThis !== 'undefined' ? globalThis.StackBlocks : null;
    // A projected period is read through the shell's one rule (isEstimated with no trust word: projected only).
    const projected = !blocks || typeof blocks.isEstimated !== 'function' || blocks.isEstimated(null, view);
    if (!view || view.timelineRole === 'future' || projected) return '';
    const covered = line && line.minimumCovered;
    // Only a coverage Forecast vouches for (lead ruling, 2026-11-20, on REVIEWER 2's 7047727410): calculated or verified
    // draws a plain check, estimated a soft one; an unavailable, unknown or missing trust draws none.
    if (!covered || covered.value !== true || !CHECK_TRUST.has(covered.trust)) return '';
    const soft = typeof blocks.estClass === 'function' ? blocks.estClass(covered.trust, view) : '';
    // The estimate is named too, as the Credit card's paidBackName does: a soft check is never an unqualified claim.
    return `<span class="wf-check${soft}" role="img" aria-label="Minimum paid${soft ? ', estimated' : ''}">\u2713</span>`;
  }

  // A card's minimum due date (Dale, 2026-11-21): the date of the one minimum occurrence Forecast counted for that card in this
  // period, read from the rows it marked (stackBillPart 'cardMinimum', stackBillDebtId). Exactly one dated row, else nothing:
  // a card with several occurrences, or an undated or malformed one, shows no date rather than a guess.
  const dueFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  function dueLabel(view, debtId) {
    const rows = (Array.isArray(view.bills) ? view.bills : []).filter(r => r && r.stackBillPart === 'cardMinimum' && String(r.stackBillDebtId) === String(debtId));
    const iso = rows.length === 1 ? rows[0].date : null;
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    // A real calendar day only: month 13 or Feb 30 shows nothing (never a throw that would blank the waterfall, never a
    // rolled-over date). The round trip catches what a shape check cannot.
    const when = new Date(iso + 'T12:00:00Z');
    if (Number.isNaN(when.getTime()) || when.toISOString().slice(0, 10) !== iso) return '';
    try { return dueFormat.format(when); } catch (error) { return ''; }
  }

  // The minimums due in the selected pay period, exactly Forecast's cardMinimums: a card with no minimum due in the
  // period has no row (owner, Dale, 2026-11-20).
  function creditRows(ctx, view) {
    const breakdown = view.stackSummary ? view.stackSummary.creditBreakdown : null;
    if (breakdown && Array.isArray(breakdown.rows)) return targetRows(ctx, view, breakdown);
    const cards = view.stackSummary && view.stackSummary.bills ? view.stackSummary.bills.cardMinimums : null;
    if (!Array.isArray(cards)) return '';
    return cards.map((card, i) => {
      const source = `stackSummary.bills.cardMinimums.${i}.amount`;
      const cell = card && isAmount(card.amount)
        ? `<span class="n${est(view, 'stackSummary.bills.trust')}" data-source="${source}">${escape(money(card.amount))}</span>`
        : `<span class="n" data-source="${source}" data-unpublished="true"></span>${DASH}`;
      const due = card ? dueLabel(view, card.debtId) : '';
      return `<li class="wf-card" data-row="card" data-debt-id="${escape(card && card.debtId)}"><span class="wf-name"><b>${escape(cardLabel(ctx, card && card.debtId))}</b>${due ? `<span class="wf-due">${escape(due)}</span>` : ''}</span>`
        + `<span class="wf-amt">${cell}${minimumCheck(view, creditLine(ctx, card && card.debtId))}</span></li>`;
    }).join('');
  }

  // OD-033 (display only; desk ruling (1), Plan #6): under one plain caption, each card at its Still to pay back. The Credit
  // line stays (E)'s deduction; the rows are what is still owed on each card and do not add up to it (lead, 2026-11-24: the
  // caption says so in plain words). No "Already counted above" row (Dale, 2026-11-24, #1617 7121410691). Every figure is
  // Forecast's. When charges are withheld, name the unknown remainder and label any minimum check separately.
  const STILL_CAPTION = 'Still to pay back on each card';
  function targetRows(ctx, view, breakdown) {
    const cell = (amount, source, trustPath) => isAmount(amount)
      ? `<span class="n${est(view, trustPath)}" data-source="${source}">${escape(money(amount))}</span>`
      : `<span class="n" data-source="${source}" data-unpublished="true"></span>${DASH}`;
    const cards = breakdown.rows.map((row, i) => {
      const due = row ? dueLabel(view, row.debtId) : '';
      const line = creditLine(ctx, row && row.debtId);
      const check = minimumCheck(view, line);
      const source = `stackSummary.creditBreakdown.rows.${i}.amount`;
      const chargesUnavailable = row?.amount === null && line?.stillToPayBack?.reasons?.includes('new-charges-unavailable');
      const figure = chargesUnavailable
        ? `<span class="n" data-source="${source}" data-unpublished="true"></span><small>Not yet known${check ? `<br>${check} <span aria-hidden="true">Minimum paid</span>` : ''}</small>`
        : cell(row && row.amount, source, `stackSummary.creditBreakdown.rows.${i}.trust`) + check;
      return `<li class="wf-card" data-row="card" data-debt-id="${escape(row && row.debtId)}"><span class="wf-name"><b>${escape(cardLabel(ctx, row && row.debtId))}</b>${due ? `<span class="wf-due">${escape(due)}</span>` : ''}</span>`
        + `<span class="wf-amt">${figure}</span></li>`;
    }).join('');
    const caption = cards ? `<li class="wf-card wf-caption" data-row="still-caption"><span class="wf-name">${escape(STILL_CAPTION)}</span></li>` : '';
    return caption + cards;
  }

  // The Credit line (OD-057, Dale, 2026-11-25: "Just give me the amount needing to pay payback/the total amount."): the
  // total still to pay back over the Credit deduction, both Forecast's (creditBreakdown.stillToPayBack, the sum of the rows
  // the dropdown lists, and surplus.terms.credit, the term the Surplus takes). The deduction keeps its own cell on the
  // right, so the Surplus sum still reads. A withheld total is a dash; with no breakdown the line is the deduction alone.
  const STILL_SOURCE = 'stackSummary.creditBreakdown.stillToPayBack.amount';
  function creditFigure(view) {
    const breakdown = view.stackSummary ? view.stackSummary.creditBreakdown : null;
    if (!breakdown || !breakdown.stillToPayBack || typeof breakdown.stillToPayBack !== 'object') return amountCell(view, 'credit');
    const still = readPath(view, STILL_SOURCE);
    const stillCell = isAmount(still)
      ? `<span class="n${est(view, 'stackSummary.creditBreakdown.stillToPayBack.trust')}" data-source="${STILL_SOURCE}">${escape(money(still))}</span>`
      : `<span class="n" data-source="${STILL_SOURCE}" data-unpublished="true"></span>${DASH}`;
    // A withheld deduction (the Surplus unavailable) is a dash after the slash, never a dangling slash.
    const deduction = isAmount(readPath(view, LINE_SOURCES.credit)) ? '' : DASH;
    return `<span class="wf-of">${stillCell}<i aria-hidden="true"> / </i>${amountCell(view, 'credit')}${deduction}</span>`;
  }

  // The waterfall's Mortgage line opens the mortgage sheet (owner, Dale, 2026-11-20: no Mortgage card; the line stays
  // as in the approved design and keeps the payment reachable). Its key is the selected period's mortgage row, as
  // Forecast publishes it in view.bills (debtId or id 'mortgage', with a paid state that is not 'carried'): the same
  // row, read the same way, as the card row it replaces. No row, no tap: the line stays plain.
  function mortgageSheetKey(view) {
    const row = (Array.isArray(view.bills) ? view.bills : []).find(r => r && (r.debtId === 'mortgage' || r.id === 'mortgage')
      && r.paidState && r.paidState !== 'carried');
    return row && row.id != null && row.date != null ? `mortgage:${row.id}@${row.date}` : null;
  }

  function html(ctx, state) {
    const view = selectedView(ctx);
    if (!view) return '<section class="stack-waterfall" data-block="waterfall" data-unpublished="true"></section>';
    const surplus = view.stackSummary && view.stackSummary.surplus;
    const amount = surplus && isAmount(surplus.amount) ? surplus.amount : null;
    // A label chosen by the published sign; no figure is derived from it.
    const deficit = amount !== null && amount < 0;
    const word = deficit ? 'Deficit after deductions' : 'Surplus after deductions';
    const open = state.creditOpen === true;
    const cards = creditRows(ctx, view);
    const credit = `<li class="wf-line wf-credit ${open ? 'open' : ''}" data-row="credit">
      <button type="button" class="wf-toggle" data-wf-toggle="credit" aria-expanded="${open}"${cards ? '' : ' disabled'}>
        <span class="op" aria-hidden="true">−</span><span class="lab">${mark('credit')}Credit</span>${creditFigure(view)}</button>
      <ul class="wf-cards"${open ? '' : ' hidden'}>${cards}</ul></li>`;
    const sheetKey = mortgageSheetKey(view);
    const mortgage = sheetKey
      ? `<li class="wf-line wf-tap" data-row="mortgage"><button type="button" class="wf-toggle" data-stack-sheet="${escape(sheetKey)}">
        <span class="op" aria-hidden="true">−</span><span class="lab">${mark('mortgage')}Mortgage</span>${amountCell(view, 'mortgage')}</button></li>`
      : line('−', 'Mortgage', amountCell(view, 'mortgage'), '', 'mortgage');
    // A withheld surplus shows its name and a dash, no sentence (owner, 2026-11-20: no explanatory text on the page).
    const dash = amount === null ? DASH : '';
    // Surplus subtracts linked savings-item spending, so the rows show it: its own line, the published term as is, only when
    // Forecast published it and it is not zero. A zero or absent term adds nothing, so the markup is exactly what it was.
    const itemTerm = readPath(view, LINE_SOURCES.savingsItem);
    const savingsItem = isAmount(itemTerm) && itemTerm !== 0
      ? `\n    ${line('−', 'Savings items', amountCell(view, 'savingsItem'), '', 'savings-item')}` : '';
    return `<section class="stack-waterfall" data-block="waterfall" data-period="${escape(view.start || '')}"${surplus && surplus.projected ? ' data-projected="true"' : ''}>
  <ul class="wf-math">
    ${line('', 'Dale’s income', amountCell(view, 'dale'), '', 'dale')}
    ${line('+', 'Amanda’s income', amountCell(view, 'amanda'), '', 'amanda')}
    ${line('+', 'Other income', amountCell(view, 'other'), '', 'other')}
    ${line('=', 'Total income', amountCell(view, 'total'), 'tot', 'total')}
    ${line('−', 'Bills', amountCell(view, 'bills'), '', 'bills')}
    ${line('−', 'Budget', amountCell(view, 'budget'), '', 'budget')}
    ${mortgage}
    ${credit}${savingsItem}
  </ul>
  <div class="wf-slab${deficit ? ' neg' : ''}" data-row="surplus"><div class="sl"><span aria-hidden="true">=</span> ${word}</div>${amountCell(view, 'surplus', { sign: true })}${dash}</div>
</section>`;
  }

  // The shell's block entry point.
  function render(container, ctx) {
    if (!container) return;
    const state = container.__stackWaterfall || (container.__stackWaterfall = { creditOpen: false });
    container.innerHTML = html(ctx, state);
    if (!state.listening && typeof container.addEventListener === 'function') {
      state.listening = true;
      container.addEventListener('click', event => {
        const toggle = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-wf-toggle="credit"]') : null;
        if (!toggle || toggle.disabled) return;
        state.creditOpen = !state.creditOpen;
        render(container, state.ctx);
      });
    }
    state.ctx = ctx;
  }

  return { render, html, selectedView, mortgageSheetKey, LINE_SOURCES };
});
