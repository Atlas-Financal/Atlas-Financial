/* Stack Wallet page shell (B1, lead dispatch 2026-11-19; design: the Stack Wallet artifact, invented data).
 *
 * Behind ?view=stack only. Without the flag this file defines window.StackBlocks (so the block files can register)
 * and does nothing else: no stylesheet, no element, no render hook, no listener. The current page is unchanged.
 *
 * With the flag it owns:
 *   - flag routing: <html class="stack-view">, the Stack stylesheets, and #stack-root in place of the current page;
 *   - the one Forecast call for the page, made with the same input builder the current page uses
 *     (Forecast.budgetRecommendInputs, default knobs, the same ATLAS-080 settlement outcome);
 *   - period-selection state (selectedPeriodKey), shared by every block;
 *   - the block registry: window.StackBlocks.register(name, renderFn), renderFn(container, ctx),
 *     ctx = { data, plan, recommendation, selectedPeriodKey, Forecast };
 *   - the title, the quiet "Last updated" line, and the timeline chips.
 *
 * L-001: this file prints what Forecast publishes and does no arithmetic on money. A chip prints its period's
 * published stackSummary.surplus amount, or nothing when Forecast has not published one (F8: never $0).
 */
(function () {
  'use strict';
  const ORDER = ['waterfall', 'cards', 'credit', 'sheet'];
  const renderers = new Map();
  const StackBlocks = {
    register(name, renderFn) {
      if (typeof name !== 'string' || typeof renderFn !== 'function') return;
      renderers.set(name, renderFn);
      if (state.ready) renderAll();
    },
    names: () => [...renderers.keys()],
    // The one drawing ratio the blocks share (lead ruling, 2026-11-19): a bar's fill, 0 to 1, from two published
    // figures. Drawing only: never printed, never used for a status, colour or decision. null (no bar) unless both
    // figures are published numbers and the whole is above zero.
    barWidth(part, whole) {
      if (typeof part !== 'number' || typeof whole !== 'number' || !Number.isFinite(part) || !Number.isFinite(whole)
        || whole <= 0) return null;
      return Math.min(1, Math.max(0, part / whole));
    },
    // B5, the one visual trust treatment (lead ruling, 2026-11-19; owner: no text labels, no dotted underlines): a
    // figure whose published trust is 'estimated', or any figure of a pay period Forecast publishes as projected
    // (evidenceState 'projected'), carries the class stack-est. Nothing else does: calculated and verified never, and
    // an unknown or unavailable figure prints nothing. Read from the published trust, never inferred.
    isEstimated(trust, view) {
      return trust === 'estimated' || !!(view && typeof view === 'object' && view.evidenceState === 'projected');
    },
    estClass(trust, view) { return StackBlocks.isEstimated(trust, view) ? ' stack-est' : ''; },
  };
  const state = { ready: false, data: null, periods: null, recommendation: null, selectedPeriodKey: null };
  if (typeof window !== 'undefined') window.StackBlocks = StackBlocks;

  const on = typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'stack';
  if (!on || typeof document === 'undefined') return;

  const root = document.documentElement;
  root.classList.add('stack-view');
  // The shell's stylesheet (tokens, pile, header, timeline), then one stylesheet per block, each owned by its block.
  for (const href of ['/budget-stack-fonts.css', '/stack.css', ...ORDER.map(name => `/stack-${name}.css`)]) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    if (href === '/stack.css') link.addEventListener('load', () => centreNow());
    document.head.appendChild(link);
  }

  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Presentation of a published amount: sign, dollars, cents only when the published figure has them. No arithmetic.
  const signed = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol',
    signDisplay: 'always', maximumFractionDigits: 0 });
  const signedCents = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol',
    signDisplay: 'always', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = n => (Number.isInteger(n) ? signed : signedCents).format(n).replace('-', '−');
  const shortDate = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const dayLabel = iso => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? shortDate.format(new Date(iso + 'T12:00:00Z')) : '');

  const views = () => (state.recommendation && Array.isArray(state.recommendation.payPeriodViews)
    ? state.recommendation.payPeriodViews.filter(v => v && typeof v.start === 'string') : []);
  const keyOf = view => view.start;
  const surplusOf = view => {
    const s = view && view.stackSummary && view.stackSummary.surplus;
    return s && typeof s.amount === 'number' && Number.isFinite(s.amount) ? s.amount : null;
  };

  // The quiet "Last updated" line: the same evidence and rule as the current Budget footer (OD-3, OD-025):
  // the overlay's last successful sync instant, formatted by app.js formatCompleteRefreshTime. No banner.
  function lastUpdated(d) {
    const overlay = d && d.liveOverlay;
    const syncAt = overlay && overlay.applied === true && overlay.currentPeriodActuals
      ? overlay.currentPeriodActuals.lastSuccessfulSyncAt : null;
    const known = typeof syncAt === 'string' && syncAt.includes('T') && typeof Forecast !== 'undefined'
      && Forecast.financialDate(syncAt) && typeof formatCompleteRefreshTime === 'function';
    return known ? 'Last updated ' + formatCompleteRefreshTime(syncAt) : '';
  }

  function timelineHtml() {
    const list = views();
    const chips = list.map(view => {
      const key = keyOf(view), amount = surplusOf(view), neg = amount != null && amount < 0;
      const surplus = view.stackSummary && view.stackSummary.surplus;
      const current = view.role === 'active';
      // Owner decision (Dale, 2026-11-19): no text labels. A projected period, as Forecast publishes it
      // (evidenceState 'projected'), is drawn with a dashed outline; it is never inferred from dates here.
      const projected = view.evidenceState === 'projected';
      return `<button class="stack-chip${neg ? ' is-neg' : ''}${current ? ' is-now' : ''}${projected ? ' is-projected' : ''}" type="button"`
        + ` data-stack-period="${esc(key)}" aria-pressed="${key === state.selectedPeriodKey}"`
        + `${current ? ' aria-current="date"' : ''}>`
        + `<span class="stack-chip-date">${esc(dayLabel(view.start))}</span>`
        + `<span class="stack-chip-value${neg ? ' is-neg' : ''}${StackBlocks.estClass(surplus && surplus.trust, view)}" data-stack-chip-amount>${amount == null ? '' : esc(money(amount))}</span>`
        + '</button>';
    }).join('');
    return '<div class="stack-tl-head"><button class="stack-now" type="button" data-stack-now>Now</button></div>'
      + `<div class="stack-chips" data-stack-chips>${chips}</div>`;
  }

  // The selected period's range, plus a marker when it is the current period. No text labels (owner decision, Dale,
  // 2026-11-19): a projected period is told apart by its chip's dashed outline, not by a word.
  const rangeDate = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  function rangeLabel(view) {
    const ok = iso => typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso);
    if (!ok(view.start)) return '';
    const a = new Date(`${view.start}T12:00:00Z`);
    if (!ok(view.end)) return rangeDate.format(a);
    const b = new Date(`${view.end}T12:00:00Z`);
    return rangeDate.format(a) + ' \u2013 ' + (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()
      ? String(b.getUTCDate()) : rangeDate.format(b));
  }
  function periodHeadHtml() {
    const view = views().find(v => keyOf(v) === state.selectedPeriodKey);
    if (!view) return '';
    const current = view.role === 'active';
    return `<h2 class="stack-period-range">${esc(rangeLabel(view))}</h2>`
      + (current ? '<span class="stack-period-now" data-stack-period-now role="img" aria-label="Current pay period"></span>' : '');
  }

  function context() {
    return { data: state.data, plan: state.data && state.data.plan, recommendation: state.recommendation,
      selectedPeriodKey: state.selectedPeriodKey, Forecast: typeof Forecast !== 'undefined' ? Forecast : null };
  }

  function mount() {
    let el = document.getElementById('stack-root');
    if (el) return el;
    el = document.createElement('main');
    el.id = 'stack-root';
    el.className = 'stack-root';
    el.innerHTML = '<header class="stack-top"><h1>Budget</h1><p class="stack-updated" data-stack-updated></p></header>'
      + '<div class="stack-pile" data-stack-pile><section class="stack-block stack-tl" data-stack-block="timeline"'
      + ' aria-label="Pay periods"></section>'
      // The waterfall sits under the shell's period header (range and when-label) in one white block; the block
      // renders only its own content into the div. Cards and credit render into their own sections.
      + '<section class="stack-block stack-wf-block"><header class="stack-period-head" data-stack-period-head></header>'
      + '<div data-stack-block="waterfall"></div></section>'
      + '<section class="stack-block stack-bare" data-stack-block="cards"></section>'
      + '<section class="stack-block stack-bare" data-stack-block="credit"></section></div>'
      // The sheet is an overlay, outside the pile.
      + '<div class="stack-overlay" data-stack-block="sheet"></div>';
    (document.querySelector('.wrap') || document.body).appendChild(el);
    el.addEventListener('click', event => {
      const chip = event.target.closest('[data-stack-period]');
      const now = event.target.closest('[data-stack-now]');
      const active = views().find(v => v.role === 'active');
      const key = chip ? chip.getAttribute('data-stack-period') : now && active ? keyOf(active) : null;
      if (!key) return;
      centre = true;
      if (key !== state.selectedPeriodKey) state.selectedPeriodKey = key;
      renderAll();
      const pressed = el.querySelector(`[data-stack-period="${CSS.escape(key)}"]`);
      if (pressed) pressed.focus({ preventScroll: true });
    });
    return el;
  }

  // Keep the chip row where it was across renders; centre the selected chip the first time and after a tap.
  // Layout positions, not figures: the chip's offset in the row. Re-run once the stylesheets have loaded, since a
  // render before then measures an unstyled row.
  let centre = true;
  function centreNow() {
    const row = document.querySelector('#stack-root [data-stack-chips]');
    const chip = row && row.querySelector('[aria-pressed="true"]');
    if (row && chip) row.scrollLeft = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2;
  }
  function centerSelected(row, scrollLeft) {
    if (!row) return;
    if (scrollLeft != null) row.scrollLeft = scrollLeft;
    if (!centre) return;
    centre = false;
    centreNow();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(centreNow);
  }

  function renderAll() {
    const el = mount();
    el.querySelector('[data-stack-updated]').textContent = lastUpdated(state.data);
    const timeline = el.querySelector('[data-stack-block="timeline"]');
    const previous = timeline.querySelector('[data-stack-chips]');
    const scrollLeft = previous ? previous.scrollLeft : null;
    timeline.innerHTML = timelineHtml();
    centerSelected(timeline.querySelector('[data-stack-chips]'), scrollLeft);
    el.querySelector('[data-stack-period-head]').innerHTML = periodHeadHtml();
    const ctx = context();
    for (const name of ORDER) {
      const container = el.querySelector(`[data-stack-block="${name}"]`);
      const renderFn = renderers.get(name);
      if (!container || !renderFn) continue;
      try { renderFn(container, ctx); } catch (error) {
        container.innerHTML = '';
        if (typeof console !== 'undefined') console.error('stack block ' + name + ' failed', error);
      }
    }
  }

  function render(d, periods) {
    state.data = d;
    state.periods = periods;
    // The same settlement gate the current page applies first (plan.js planSettlementOutcome, ATLAS-080):
    // an unavailable outcome publishes nothing, so the shell renders its title and no figure.
    const settlement = typeof planSettlementOutcome === 'function' ? planSettlementOutcome(d) : { kind: 'none' };
    state.recommendation = settlement.kind === 'unavailable' || !d || !d.plan || typeof Forecast === 'undefined' ? null
      : Forecast.recommend(d.plan, d.meta && d.meta.asOf, Forecast.budgetRecommendInputs(d, {
        periods, settlementEvidence: settlement.kind === 'qualified' ? settlement.evidence : null,
      }));
    const list = views();
    if (!list.some(v => keyOf(v) === state.selectedPeriodKey)) {
      const active = list.find(v => v.role === 'active');
      state.selectedPeriodKey = active ? keyOf(active) : list.length ? keyOf(list[0]) : null;
    }
    state.ready = true;
    renderAll();
  }

  if (typeof App !== 'undefined' && App.register) {
    App.register(render);
    // App.boot starts in plan.js, before this file loads, and App.register does not replay a render that already
    // happened: when the data has already arrived, draw now from what App holds.
    if (App.data) render(App.data, App.periods, App.history);
  }
})();
