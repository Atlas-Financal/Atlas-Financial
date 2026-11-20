/* Stack Wallet page shell (B1, lead dispatch 2026-11-19; design: the Stack Wallet artifact, invented data).
 *
 * The default Budget page (B7, switch-over; lead dispatch 2026-11-19). ?view=classic keeps the previous page as a
 * fallback until C1 retires it: with it, this file defines window.StackBlocks (so the block files can register) and does
 * nothing else: no stylesheet, no element, no render hook, no listener. ?view=stack is an alias of the default.
 * Fail-safe: if the shell itself throws while drawing, it removes itself and the previous page shows (never a blank
 * page). A failing block only empties its own container.
 *
 * Otherwise it owns:
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
// B7 fail-safe, start-up: a throw anywhere in the shell's set-up is caught here, so the previous page shows (never
// blank) and no uncaught error escapes; the class and stylesheets are applied only after set-up (applyChrome).
(function () {
// B7 fail-safe: one durable fail state for the whole shell. Every failure path (start-up, after the App hook, while
// drawing) sets it, and a registered render never draws again once it is set.
let failed = false;
try {
(function () {
  'use strict';
  const ORDER = ['waterfall', 'cards', 'credit', 'sheet'];
  const renderers = new Map();
  const WHOLE = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0, maximumFractionDigits: 0, roundingMode: 'halfExpand', signDisplay: 'never' });
  const CENTS = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2, maximumFractionDigits: 2, roundingMode: 'halfExpand', signDisplay: 'never' });
  const ZERO = WHOLE.format(0), ZERO_CENTS = CENTS.format(0);
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
    // The one way the Stack page prints a published amount (design: whole dollars). Display only: the published value
    // is rounded to the dollar for printing (half away from zero, so $2.50 prints $3 and −$2.50 prints −$3) and is
    // never used again; no sum, status or decision reads the printed text. A true minus sign; with signed, a plus on a
    // positive amount. An amount that prints as $0 carries no sign. '' for anything that is not a published number.
    // With cents, as before: cents when the published amount has them ($12.50, but $150), only for a transaction line in
    // a sheet, the ledger's own entry, which the household matches against the bank (the design shows no transaction
    // list).
    money(value, { signed = false, cents = false } = {}) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      const fmt = cents && !Number.isInteger(value) ? CENTS : WHOLE;
      const text = fmt.format(value);
      if (text === (fmt === CENTS ? ZERO_CENTS : ZERO)) return text;
      return (value < 0 ? '\u2212' : signed ? '+' : '') + text;
    },
    // A credit line's name (owner decision, Dale, 2026-11-20; Grok Bot, rule 17: the ledger is the one home for
    // names): the name its Lunch Money account shows (debt.ledgerName, which the live overlay attaches by provider
    // account id, never by name), else the block's own label. A label only: nothing is matched or derived from it.
    cardName(data, debtId, fallback) {
      const debts = data && Array.isArray(data.debts) ? data.debts : [];
      const debt = debtId == null ? null : debts.find(d => d && d.id === debtId);
      const name = debt && typeof debt.ledgerName === 'string' ? debt.ledgerName.trim() : '';
      return name || fallback;
    },
    // A household budget row's published trust, per printed amount, as Forecast publishes it (the reading the current
    // Budget page documents in plan.js householdBudgetRowHtml): the row's trust (or confidence) marks the row; its plan
    // is estimated when plannedTrust is absent or 'estimated' (an Other spending row's plan only when it is dated); its
    // Spent when plannedTrust is 'calculated' (a possible duplicate) or spentTrust is 'estimated'; Left / Over follow
    // the row. An amount whose own trust field says 'estimated' is always estimated (only ever more cautious than the
    // page's reading). Returns trust words for estClass, never a figure.
    budgetTrust(row) {
      const r = row && typeof row === 'object' ? row : {};
      const rowEst = r.trust === 'estimated' || r.confidence === 'estimated';
      const other = r.otherSpending === true || r.needsConfirmation === true;
      const datedPlan = typeof r.targetEffectiveFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.targetEffectiveFrom)
        && typeof r.planned === 'number' && Number.isFinite(r.planned);
      const word = yes => (yes ? 'estimated' : null);
      return {
        planned: word(r.plannedTrust === 'estimated' || (rowEst && (!other || datedPlan) && r.plannedTrust == null)),
        spent: word(r.spentTrust === 'estimated' || (rowEst && r.plannedTrust === 'calculated')),
        remaining: word(rowEst),
      };
    },
  };
  // The selected period's range (the header and the sheets' kicker read the same label).
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
  StackBlocks.rangeLabel = rangeLabel; // the sheets' kicker reads the same range
  const state = { ready: false, data: null, periods: null, recommendation: null, selectedPeriodKey: null };
  if (typeof window !== 'undefined') window.StackBlocks = StackBlocks;

  // Every view but ?view=classic is the Stack page (B7); a missing location (a test harness) is the classic page.
  const on = typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') !== 'classic';
  if (!on || typeof document === 'undefined') return;

  const root = document.documentElement;
  // B7 fail-safe, start-up: the class and the stylesheets are applied only after every formatter and helper below is
  // set up (applyChrome, just before the App hook), so a throw during set-up leaves the previous page showing.

  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // A chip's surplus, signed, in the page's one money format.
  const money = n => StackBlocks.money(n, { signed: true });
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

  // The quiet "Last updated" line: the same evidence and rule as the current Budget footer and glance (OD-3, OD-025;
  // plan.js glanceUpdatedNote): the overlay's last successful sync instant; for a retained refresh with no sync instant,
  // that refresh's own complete-observation instant (retainedRefresh.observedAt), never a failed attempt's time.
  // Formatted by app.js formatCompleteRefreshTime. Dates only: no banner (owner, 2026-11-20).
  const instant = value => (typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value))
    && typeof Forecast !== 'undefined' && Forecast.financialDate(value) ? value : null);
  function updatedInstant(d) {
    const overlay = d && d.liveOverlay;
    const syncAt = overlay && overlay.applied === true && overlay.currentPeriodActuals
      ? instant(overlay.currentPeriodActuals.lastSuccessfulSyncAt) : null;
    if (syncAt) return syncAt;
    return overlay && overlay.retainedRefresh ? instant(overlay.retainedRefresh.observedAt) : null;
  }
  // The same instant, said simply (owner, Dale, 2026-11-20: "as of Nov 20 3am"): the date and the hour in the
  // household's time zone, the same zone as app.js formatCompleteRefreshTime, with minutes only when they are not on the
  // hour. Nothing when no instant is published.
  const AS_OF_ZONE = 'America/Vancouver';
  const asOfDay = new Intl.DateTimeFormat('en-CA', { timeZone: AS_OF_ZONE, month: 'short', day: 'numeric' });
  const asOfHour = new Intl.DateTimeFormat('en-CA', { timeZone: AS_OF_ZONE, hour: 'numeric' });
  const asOfTime = new Intl.DateTimeFormat('en-CA', { timeZone: AS_OF_ZONE, hour: 'numeric', minute: '2-digit' });
  const asOfMinute = new Intl.DateTimeFormat('en-CA', { timeZone: AS_OF_ZONE, minute: 'numeric' });
  function lastUpdated(d) {
    const at = updatedInstant(d);
    if (!at) return '';
    const when = new Date(at);
    const onTheHour = Number(asOfMinute.format(when)) === 0;
    return 'as of ' + asOfDay.format(when) + ', ' + (onTheHour ? asOfHour : asOfTime).format(when);
  }

  function timelineHtml() {
    const list = views();
    const chips = list.map(view => {
      const key = keyOf(view), amount = surplusOf(view), neg = amount != null && amount < 0;
      const surplus = view.stackSummary && view.stackSummary.surplus;
      const current = view.role === 'active';
      // Owner direction (Dale, 2026-11-20 walk): no dashed or dotted outline on a future period; every chip has the
      // design's plain fill. A period with no published surplus shows a dash (F8) in the soft treatment (lead,
      // 2026-11-20), never $0 and never a blank.
      const value = amount == null
        ? '<span class="stack-chip-value stack-est" data-stack-chip-amount role="img" aria-label="not available">\u2014</span>'
        : `<span class="stack-chip-value${neg ? ' is-neg' : ''}${StackBlocks.estClass(surplus && surplus.trust, view)}" data-stack-chip-amount>${esc(money(amount))}</span>`;
      return `<button class="stack-chip${neg ? ' is-neg' : ''}${current ? ' is-now' : ''}" type="button"`
        + ` data-stack-period="${esc(key)}" aria-pressed="${key === state.selectedPeriodKey}"`
        + `${current ? ' aria-current="date"' : ''}>`
        + `<span class="stack-chip-date">${esc(dayLabel(view.start))}</span>`
        + value
        + '</button>';
    }).join('');
    return '<div class="stack-tl-head"><button class="stack-now" type="button" data-stack-now>Now</button></div>'
      + `<div class="stack-chips" data-stack-chips>${chips}</div>`;
  }

  // The design's period chip (owner, Dale, 2026-11-20: "Follow the design"): "This pay period" on the current period,
  // "Last pay period" on the one before it, "Past" on earlier ones. A future period shows no chip (owner: no
  // "Projected" word). The order is Forecast's own list of periods; nothing is inferred from dates here.
  function periodChip(view) {
    const list = views(), i = list.indexOf(view), now = list.findIndex(v => v.role === 'active');
    if (view.role === 'active') return 'This pay period';
    if (now < 0 || i < 0 || i > now || view.timelineRole === 'future' || view.evidenceState === 'projected') return '';
    return i === now - 1 ? 'Last pay period' : 'Past';
  }
  function periodHeadHtml() {
    const view = views().find(v => keyOf(v) === state.selectedPeriodKey);
    if (!view) return '';
    const chip = periodChip(view);
    return `<h2 class="stack-period-range">${esc(rangeLabel(view))}</h2>`
      + (chip ? `<span class="stack-period-chip" data-stack-period-now>${esc(chip)}</span>` : '');
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
    // The top (owner, Dale, 2026-11-20: "declutter the top"): the title, and on its row a small "as of" time with a
    // refresh icon. The site's own header bar is hidden on the Stack page (stack.css).
    el.innerHTML = '<header class="stack-top"><h1>Budget</h1><p class="stack-asof"><span class="stack-updated" data-stack-updated></span>'
      + '<button type="button" class="stack-refresh" data-stack-refresh aria-label="Refresh">'
      + '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M19 9a7 7 0 1 0 0 6M19 4v5h-5"'
      + ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></p></header>'
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
      // Refresh: the page's one refresh control (app.js, single-flight, the same load as before), pressed on the
      // household's behalf; the Stack page adds no refresh of its own.
      if (event.target.closest('[data-stack-refresh]')) {
        const manual = document.querySelector('[data-manual-refresh]');
        if (manual && !manual.disabled) manual.click();
        return;
      }
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

  // Where the chip row sits (owner, Dale, 2026-11-20: the current period was off-screen). Until the household scrolls
  // the row themselves, every render centres the selected chip, so periods that arrive later (older history, a
  // refresh) cannot push it out of view; so do a tap on a chip and "Now". Once they have scrolled, a re-render keeps
  // the same chip at the same place, never the same raw offset (an offset shows other periods once the list grows).
  // Layout positions, not figures. Measured from the rendered boxes, so it holds before and after the fonts and
  // stylesheets arrive; each of those re-centres too while the row is still the page's to place.
  let centre = true, userScrolled = false;
  function chipRow() { return document.querySelector('#stack-root [data-stack-chips]'); }
  function centreNow() {
    const row = chipRow();
    const chip = row && row.querySelector('[aria-pressed="true"]');
    if (!row || !chip) return;
    const r = row.getBoundingClientRect(), c = chip.getBoundingClientRect();
    if (!r.width) return;
    row.scrollLeft += (c.left + c.width / 2) - (r.left + r.width / 2);
  }
  function settleCentre() {
    centreNow();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(centreNow);
  }
  function autoCentre() { if (!userScrolled) settleCentre(); }
  // The first chip whose box starts inside the row, and where it starts: the anchor a re-render keeps in place.
  function anchorOf(row) {
    if (!row) return null;
    const left = row.getBoundingClientRect().left;
    const chip = [...row.querySelectorAll('[data-stack-period]')].find(c => c.getBoundingClientRect().right > left);
    return chip ? { key: chip.getAttribute('data-stack-period'), at: chip.getBoundingClientRect().left - left } : null;
  }
  function placeRow(row, anchor) {
    if (!row) return;
    if (!row.dataset.stackWatched) {
      row.dataset.stackWatched = '1';
      for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
        row.addEventListener(type, () => { userScrolled = true; }, { passive: true });
      }
    }
    if (centre || !userScrolled) { centre = false; settleCentre(); return; }
    const chip = anchor && row.querySelector(`[data-stack-period="${CSS.escape(anchor.key)}"]`);
    if (chip) row.scrollLeft += (chip.getBoundingClientRect().left - row.getBoundingClientRect().left) - anchor.at;
  }

  // B7 fail-safe: a throw in the shell's own drawing hands the page back to the previous page, never a blank one.
  function fallBack(error) {
    failed = true;
    root.classList.remove('stack-view');
    const el = document.getElementById('stack-root');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    if (typeof console !== 'undefined') console.error('stack page failed; showing the classic page', error);
  }
  function renderAll() {
    if (failed) return;
    try { drawAll(); } catch (error) { fallBack(error); }
  }
  function drawAll() {
    const el = mount();
    el.querySelector('[data-stack-updated]').textContent = lastUpdated(state.data);
    const timeline = el.querySelector('[data-stack-block="timeline"]');
    const anchor = anchorOf(timeline.querySelector('[data-stack-chips]'));
    timeline.innerHTML = timelineHtml();
    placeRow(timeline.querySelector('[data-stack-chips]'), anchor);
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
    if (failed) return;
    try { prepare(d, periods); } catch (error) { fallBack(error); return; }
    renderAll();
  }
  function prepare(d, periods) {
    // A retained (dated) refresh must always show its freshness: when no date can be printed, the previous page, which
    // says so, stays (Atlas, #1439).
    if (d && d.liveOverlay && d.liveOverlay.retainedRefresh && !updatedInstant(d)) throw new Error('retained refresh without a printable date');
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
  }

  function applyChrome() {
    root.classList.add('stack-view');
    // The shell's stylesheet (tokens, pile, header, timeline), then one stylesheet per block, each owned by its block.
    for (const href of ['/budget-stack-fonts.css', '/stack.css', ...ORDER.map(name => `/stack-${name}.css`)]) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      if (href === '/stack.css' || href === '/budget-stack-fonts.css') link.addEventListener('load', autoCentre);
      // A Stack stylesheet that fails to load would leave both pages showing together: hand back to the previous page
      // (reviewer, #1439). The font stylesheet is exempt: without it the page still reads, in the fallback fonts.
      if (href !== '/budget-stack-fonts.css') {
        link.addEventListener('error', () => fallBack(new Error('stack stylesheet failed to load: ' + href)));
      }
      document.head.appendChild(link);
    }
  }
  try { applyChrome(); } catch (error) { fallBack(error); return; }
  // Web fonts widen the chips when they arrive (and a cold iOS Safari load lays out late): re-centre then too, while the
  // row is still the page's to place.
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') document.fonts.ready.then(autoCentre);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('load', autoCentre);

  // A block script that fails to load would leave the Stack page without its waterfall, cards, Credit or sheets:
  // once the document has parsed (every block script has run or failed), any block that never registered hands back
  // to the previous page (reviewer, #1439). Checked only when the shell runs during parsing, as it does from
  // index.html; a harness that loads it otherwise draws what registered.
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => {
      const missing = ORDER.filter(name => !renderers.has(name));
      if (missing.length) fallBack(new Error('stack block script failed to load: ' + missing.join(', ')));
    }, { once: true });
  }

  if (typeof App !== 'undefined' && App.register) {
    App.register(render);
    // App.boot starts in plan.js, before this file loads, and App.register does not replay a render that already
    // happened: when the data has already arrived, draw now from what App holds.
    if (App.data) render(App.data, App.periods, App.history);
  }
})();
} catch (error) {
  failed = true;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.classList.remove('stack-view');
    const el = document.getElementById('stack-root');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  if (typeof console !== 'undefined') console.error('stack page failed to start; showing the classic page', error);
}
})();
