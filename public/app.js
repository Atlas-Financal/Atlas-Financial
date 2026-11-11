'use strict';
/* Shared core for every page — helpers, charts, theme, navigation, data boot.
   Page-specific rendering lives in plan.js, modellers.js, deepdive.js and
   records.js. All figures come from /data.json so updating the picture is a
   data edit. */

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (n, a = {}) => { const e = document.createElementNS(SVGNS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const $ = id => document.getElementById(id);

// An unknown amount or rate prints "Unknown", never $0, $NaN, NaN% or a
// crash: null, undefined, '', a non-numeric string, a boolean, an object and
// a non-finite number are all unknown. A finite number (or numeric string)
// formats as before. Each helper stays one self-contained line because the
// page tests lift these lines out of this file verbatim.
const money = n => ((typeof n === 'number' || (typeof n === 'string' && n.trim() !== '')) && Number.isFinite(Number(n))) ? (Number(n) < 0 ? '−$' : '$') + Math.round(Math.abs(Number(n))).toLocaleString('en-CA') : 'Unknown';
const money2 = (formatter => n => ((typeof n === 'number' || (typeof n === 'string' && n.trim() !== '')) && Number.isFinite(Number(n))) ? (Number(n) < 0 ? '−$' : '$') + formatter.format(Math.abs(Number(n))) : 'Unknown')(new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = n => ((typeof n === 'number' || (typeof n === 'string' && n.trim() !== '')) && Number.isFinite(Number(n))) ? Number(n).toFixed(2) + '%' : 'Unknown';
// The one HTML escape for page renderers. Every data-derived string that
// reaches innerHTML goes through it, in text and in double-quoted attribute
// values alike: labels, payees, category names, notes, plan prose and ids.
// Lunch Money names and bank descriptions are outside text, so a quote or an
// angle bracket must display as that character and never become markup.
// One line on purpose: node suites lift app.js helpers line by line.
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Reuse locale formatters during live scrubbing. These format the same input;
// they retain no date, money, publication or trust result between renders.
// Each helper is self-contained for the incumbent standalone renderers too.
const fmtDate = (formatter => iso => { const date = new Date(iso + 'T00:00:00'); return Number.isNaN(date.getTime()) ? 'Invalid Date' : formatter.format(date); })(new Intl.DateTimeFormat('en-CA', { day: 'numeric', month: 'short' }));
const fmtDateLong = (formatter => iso => { const date = new Date(iso + 'T00:00:00'); return Number.isNaN(date.getTime()) ? 'Invalid Date' : formatter.format(date); })(new Intl.DateTimeFormat('en-CA', { day: 'numeric', month: 'long' }));
// With the year: for a due date or horizon that may sit in the next calendar year.
const fmtDateFull = (formatter => iso => { const date = new Date(iso + 'T00:00:00'); return Number.isNaN(date.getTime()) ? 'Invalid Date' : formatter.format(date); })(new Intl.DateTimeFormat('en-CA', { day: 'numeric', month: 'long', year: 'numeric' }));

// Household YYYY-MM-DD only. A UTC timestamp prefix is not a household date
// (ACCOUNT_FACTS / Forecast.financialDate). Never invent one from fetch time.
function chipIsoDate(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Overlay spending evidence date from the actuals packet. Prefer coverage
// through the posted window, else the packet observation household date.
// Never fetchedAt, and never overlay observedAsOf (that is the balance /
// opening observation date, not spending coverage).
function liveSpendingEvidenceDate(overlay) {
  if (!overlay || typeof overlay !== 'object') return null;
  const actuals = overlay.currentPeriodActuals;
  return chipIsoDate(actuals && actuals.coverageThrough)
    || chipIsoDate(actuals && actuals.observationAsOf);
}

// Presentation of the original complete observation instant, never fetch/serve time.
function formatCompleteRefreshTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value))
    : 'date/time unavailable';
}

// Shared #asof chip. Distinguishes Forecast as-of, periods.json historical
// spending, and live overlay spending evidence. Presentation of published
// dates only — not a spending calculator.
function formatSiteAsOfChip(data, periods) {
  const asOf = data && data.meta && chipIsoDate(data.meta.asOf);
  let text = 'As at ' + (asOf ? fmtDateLong(asOf) : '');
  const historyAsOf = periods && chipIsoDate(periods.asOf);
  if (historyAsOf && historyAsOf !== asOf) {
    text += ' · historical spending through ' + fmtDateLong(historyAsOf);
  }
  // scripts/periods.js counts posted rows it could not read; their spending
  // is missing from the history, so it is never shown as complete.
  const malformed = periods && periods.source && Number(periods.source.malformedTransactions);
  if (malformed > 0) {
    text += ' · historical spending incomplete (' + malformed
      + (malformed === 1 ? ' transaction' : ' transactions') + ' could not be read)';
  }
  const overlay = data && data.liveOverlay;
  if (overlay?.retainedRefresh) {
    return text + ' · latest complete refresh ' + formatCompleteRefreshTime(overlay.retainedRefresh.observedAt) + ' · dated plan, not current balances';
  }
  if (overlay && overlay.applied) {
    const liveSpend = liveSpendingEvidenceDate(overlay);
    const observed = chipIsoDate(overlay.observedAsOf);
    if (liveSpend) {
      text += ' · live spending through ' + fmtDateLong(liveSpend);
    } else if (observed && observed !== asOf) {
      text += ' · live balances observed ' + fmtDateLong(observed);
    } else {
      text += ' · live Lunch Money overlay';
    }
  } else if (overlay && overlay.applied === false) {
    const opening = chipIsoDate(overlay.historicalOpeningAsOf) || asOf;
    text += opening
      ? ' · live overlay not applied · using the ' + fmtDateLong(opening) + ' opening'
      : ' · live overlay not applied';
  }
  return text;
}

// Response metadata describes the source check, not financial completeness.
// Render coverage from the incumbent refresh-trust publication independently;
// never turn a fetched timestamp or a qualified check into a financial verdict.
function formatObservationCheck(check, trust) {
  let source = 'Provider check details unavailable.';
  if (['provider', 'memory'].includes(check?.source) && check.checkedAt
      && Number.isFinite(Date.parse(check.checkedAt))) {
    const checked = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver',
      dateStyle: 'medium', timeStyle: 'short' }).format(new Date(check.checkedAt)) + ' PT';
    source = check.qualified
      ? (check.source === 'memory' ? 'Using last successful check: ' : 'Provider checked: ') + checked + '.'
      : 'Provider observation received: ' + checked + '. Source check not fully qualified.';
  }
  const labels = { current: 'Financial coverage: current.', 'partially-current': 'Financial coverage: partial.',
    'attention-needed': 'Financial coverage: needs attention.' };
  // Name only unavailable claims already identified by refresh-trust. This is
  // not an inventory of every page figure, and source-check success cannot
  // supply missing financial detail. Never render arbitrary diagnostic prose.
  const unavailable = [];
  if (trust?.remainingClaim === 'unavailable') unavailable.push('remaining spending');
  if (Array.isArray(trust?.coverageLimits) && trust.coverageLimits.some(
    limit => limit?.id === 'card-purchase-coverage-unconfirmed')) {
    unavailable.push('cash reserved for card purchases');
  }
  const coverage = trust?.exactFiguresAvailable === false
    ? (unavailable.length ? 'Unavailable figures: ' + unavailable.join('; ') + '.'
      : 'Financial figures unavailable; details not provided.')
    : Object.hasOwn(labels, trust?.displayState) ? labels[trust.displayState]
      : 'Financial coverage details unavailable.';
  if (trust?.retainedRefresh) {
    const attempt = trust.retainedRefresh.attempt;
    source = attempt?.checkedAt ? 'Current refresh incomplete.' : 'Current refresh unavailable.';
    source += ' Showing the latest complete refresh from ' + formatCompleteRefreshTime(trust.retainedRefresh.observedAt) + '. Not current balances.';
  }
  return source + ' ' + coverage;
}

/* ------------------------------------------------------------------ tooltip */
const tip = $('tip');
function showTip(e, html) {
  if (!tip) return;
  tip.innerHTML = html; tip.style.opacity = 1;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY - r.height - 10;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (x < 8) x = 8;
  if (y < 8) y = e.clientY + 18;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
const hideTip = () => { if (tip) tip.style.opacity = 0; };
addEventListener('scroll', hideTip, { passive: true });

/* ------------------------------------------------------------- breakpoint */
// App re-renders when the viewport crosses the phone breakpoint. The shared
// chart helpers that drew for it went with the Deep Dive page (#822).
const PHONE_MQ = '(max-width:640px)';

/* ------------------------------------------------------------------ maths */
// Nothing financial is decided here any more, and nothing new should be.
//
// This file is loaded by every page, which made it the most expensive place in
// the repository to hide a calculation: a figure computed here reaches the
// household from four pages at once and no node suite can reach it from any of
// them. Two lived here. `amortisedPayment` decided the May 2027 renewal and now
// lives inside `Forecast.renewal`; `payoff` and its `monthlyRate` decided the
// payoff modeller — which debt clears, when, and at what cost — and now live in
// `Forecast.payoffDebts` / `Forecast.payoffModel`, where the rate convention is
// chosen per debt instead of assumed for all of them.
//
// The last formatter that lived here (`fmtMonths`) went with the Modellers
// page (#822). Nothing is left below this note.

/* ------------------------------------------------------------------ theme */
// Three states: auto (follow the OS), dark, light. Charts read their colours
// from CSS variables at render time, so a theme change means a re-render.
const THEME_KEY = 'hfd-theme';

// Only operation/generation correlation and bounded phase cross a restart. The HttpOnly
// signed cookie remains inaccessible here. A preview token is memory only.
// GATE-1 exception, opted-in compositions only: the prepared response's
// recovery secret crosses the restart WITH its marker, bound to the exact
// generation, so a later login in this browser can present it to the
// server's final recovery decision. It is never put in a URL, a log or an
// export; the server retains only its digest.
const SettlementSave = (() => {
  const KEY = 'atlas-settlement-pending-v1';
  const OP = /^operation-[a-f0-9]{32}$/;
  const GENERATION = /^generation-[a-f0-9]{32}$/;
  const HASH = /^[a-f0-9]{64}$/;
  const bootContexts = new WeakMap();
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const canLock = () => typeof globalThis.navigator?.locks?.request === 'function';
  function mutateMarker(action) {
    // localStorage has no compare-and-swap. Every writer/remover must use the
    // same origin-wide lock, including boot cleanup in a different tab.
    if (!canLock()) return Promise.reject(new Error('settlement-persistence'));
    return navigator.locks.request(KEY, { mode: 'exclusive' }, action);
  }
  function parsePending(raw) {
    if (raw === null) return null;
    if (typeof raw !== 'string' || raw.length > 256) throw new Error('settlement-reconciliation');
    const value = JSON.parse(raw);
    if (!record(value) || Object.keys(value).length
        !== 2 + (Object.hasOwn(value, 'generation') ? 1 : 0) + (Object.hasOwn(value, 'recoverySecret') ? 1 : 0)
      || !OP.test(value.operationId)
      || Object.hasOwn(value, 'generation') && !GENERATION.test(value.generation)
      // The recovery secret is only meaningful bound to its exact
      // generation; a secret without one, or a malformed one, is no marker.
      || Object.hasOwn(value, 'recoverySecret')
        && !(Object.hasOwn(value, 'generation') && HASH.test(value.recoverySecret))
      || !['preview', 'dispatched'].includes(value.phase)) throw new Error('settlement-reconciliation');
    return value;
  }
  const pending = () => parsePending(localStorage.getItem(KEY));
  async function attestPreactivation(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 20000);
    try {
      const response = await fetch('/settlement/capability', { credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', headers: { 'X-Atlas-Settlement': 'same-origin' }, signal: controller.signal });
      if (controller.signal.aborted || response.status !== 200 || response.redirected !== false
        || new URL(response.url).origin !== location.origin) throw new Error('settlement-reconciliation');
      const value = await response.json();
      if (controller.signal.aborted || !record(value) || Object.keys(value).length !== 2 || value.status !== 'inactive'
        || value.bootClassification !== 'preactivation-only') throw new Error('settlement-reconciliation');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function persist(operationId, phase, generation, recoverySecret) {
    return mutateMarker(() => {
      const previous = pending();
      if (!GENERATION.test(generation)) throw new Error('settlement-reconciliation');
      if (recoverySecret !== undefined && !HASH.test(recoverySecret)) throw new Error('settlement-reconciliation');
      // A prepared response cannot replace any existing operation or roll a
      // dispatched marker back to preview. Only its own live preview advances.
      if (phase === 'preview' ? previous !== null
        : phase !== 'dispatched' || previous?.operationId !== operationId || previous.generation !== generation || previous.phase !== 'preview')
        throw new Error('settlement-reconciliation');
      // The secret, when the composition issued one, is written with the
      // marker in BOTH phases and covered by the same read-back verify:
      // a marker that did not durably retain it prevents dispatch.
      const raw = JSON.stringify({ operationId, phase, generation,
        ...(recoverySecret ? { recoverySecret } : {}) });
      localStorage.setItem(KEY, raw);
      if (localStorage.getItem(KEY) !== raw) throw new Error('settlement-persistence');
    });
  }
  async function acknowledgeNoEffect(outcome, operationId, generation, previewToken) {
    // Correlation is not authority. Only the controller's postauthorized exact
    // generation proof can reach cleanup; no reason-string interpretation.
    if (!record(outcome) || Object.keys(outcome).length !== 4 || outcome.status !== 'not-applied'
      || outcome.operationId !== operationId || outcome.generation !== generation
      || outcome.previewToken !== previewToken || !GENERATION.test(generation)) return false;
    return mutateMarker(() => {
      const current = pending();
      // Legacy two-field dispatched markers are receipt-recovery-only.
      if (current?.operationId !== operationId || current.generation !== generation
        || current.phase !== 'dispatched') return false;
      localStorage.removeItem(KEY);
      if (localStorage.getItem(KEY) !== null) throw new Error('settlement-persistence');
      return true;
    });
  }
  async function post(path, body, signal) {
    const timeout = new AbortController();
    const abort = () => timeout.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 20000);
    try {
      const response = await fetch('/settlement/' + path, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Atlas-Settlement': 'same-origin' },
        body: JSON.stringify(body), signal: timeout.signal });
      if (!response.ok) throw new Error('settlement-reconciliation');
      const value = await response.json();
      if (!record(value) || typeof value.status !== 'string') throw new Error('settlement-reconciliation');
      return value;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function completeData(data) {
    return record(data) && record(data.plan) && record(data.meta)
      && record(data.plan.defaults) && record(data.plan.startingCash)
      && ['income', 'bills', 'obligations', 'commitments'].every(k => Array.isArray(data.plan[k]))
      && Array.isArray(data.debts);
  }
  async function initialData(ordinary, signal, attempt) {
    let raw;
    // Only the actual storage access may use the preactivation exception.
    // Readable malformed/dispatched markers and later reconciliation failures
    // never fall back through this branch.
    try { raw = localStorage.getItem(KEY); }
    catch {
      try { await attestPreactivation(signal); }
      catch { throw new Error('settlement-reconciliation'); }
      return ordinary();
    }
    let marker;
    try { marker = parsePending(raw); } catch { throw new Error('settlement-reconciliation'); }
    // The optimistic read may already be stale. Inspect and abandon only the
    // CURRENT preview under the same lock that guards confirm dispatch.
    if (marker?.phase === 'preview') {
      const operationId = marker.operationId;
      const generation = marker.generation;
      marker = await mutateMarker(() => {
        const current = pending();
        if (current?.operationId !== operationId || current.generation !== generation || current.phase !== 'preview') return current;
        localStorage.removeItem(KEY);
        return null;
      });
    }
    if (!marker) return ordinary();
    if (marker.phase !== 'dispatched') throw new Error('settlement-reconciliation');
    const outcome = await post('outcome', { operationId: marker.operationId,
      ...(marker.generation ? { generation: marker.generation } : {}),
      ...(marker.recoverySecret ? { recoverySecret: marker.recoverySecret } : {}) }, signal);
    if (record(outcome) && Object.keys(outcome).length === 3 && outcome.status === 'not-applied'
      && outcome.operationId === marker.operationId && outcome.generation === marker.generation
      && GENERATION.test(marker.generation)) {
      const data = await ordinary();
      // Observation headers and base-only/unavailable packets cannot release
      // reconciliation. This is the single ordinary acquisition/attachment.
      if (!completeData(data) || data.settlementEvidenceStatus?.status !== 'qualified'
        || !record(data.settlementEvidence))
        throw new Error('settlement-reconciliation');
      bootContexts.set(attempt, { marker, data, status: 'not-applied' });
      return data;
    }
    if (outcome.status !== 'committed' || outcome.operationId !== marker.operationId)
      throw new Error('settlement-reconciliation');
    const view = await post('publication', { operationId: marker.operationId,
      ...(marker.recoverySecret
        ? { generation: marker.generation, recoverySecret: marker.recoverySecret } : {}) }, signal);
    if (view.status !== 'committed' || !['included', 'unavailable'].includes(view.publication)
      || !record(view.data) || !record(view.data.plan) || !record(view.data.meta)
      || !record(view.data.plan.defaults) || !record(view.data.plan.startingCash)
      || !['income', 'bills', 'obligations', 'commitments'].every(k => Array.isArray(view.data.plan[k]))
      || !Array.isArray(view.data.debts)
      || view.data.settlementEvidenceStatus?.status !== (view.publication === 'included' ? 'qualified' : 'unavailable')
      || view.publication === 'included' && !record(view.data.settlementEvidence)
      || view.publication === 'unavailable' && Object.hasOwn(view.data, 'settlementEvidence')) {
      throw new Error('settlement-reconciliation');
    }
    bootContexts.set(attempt, { marker, data: view.data, status: view.publication });
    return view.data;
  }
  async function publishInitial(attempt, data, publish) {
    const context = bootContexts.get(attempt);
    const install = () => {
      if (!attempt.current() || attempt.signal.aborted) throw new Error('settlement-reconciliation');
      publish();
    };
    if (context?.status !== 'not-applied') { install(); return; }
    return mutateMarker(() => {
      const current = pending();
      if (!attempt.current() || attempt.signal.aborted || data !== context.data
        || current?.phase !== 'dispatched' || current.operationId !== context.marker.operationId
        || current.generation !== context.marker.generation) throw new Error('settlement-reconciliation');
      // Removal/readback and synchronous publication share exclusion, not a
      // transaction. A storage error never permits publication or rollback.
      localStorage.removeItem(KEY);
      if (localStorage.getItem(KEY) !== null) throw new Error('settlement-persistence');
      install();
    });
  }
  async function initialized(attempt) {
    const bootPublication = bootContexts.get(attempt);
    // Called only AFTER DATA installation, once-hooks and render complete.
    if (bootPublication?.status === 'included') {
      const operationId = bootPublication.marker.operationId;
      const generation = bootPublication.marker.generation;
      await mutateMarker(() => {
        const marker = pending();
        if (marker?.operationId === operationId && marker.generation === generation && marker.phase === 'dispatched') localStorage.removeItem(KEY);
      });
    }
    if (bootPublication?.status === 'unavailable') {
      const message = document.createElement('p');
      message.setAttribute('data-settlement-recovery', '');
      message.textContent = 'Saved; view unavailable. ';
      const retry = document.createElement('button'); retry.type = 'button';
      retry.textContent = 'Check saved view'; retry.onclick = () => location.reload();
      message.append(retry); document.querySelector('.wrap')?.prepend(message);
    }
  }
  function mount(source) {
    if (!source || source.querySelector('[data-settlement-assignment]')) return;
    const panel = document.createElement('section');
    panel.setAttribute('data-settlement-assignment', '');
    source.append(panel);
    const text = value => { panel.textContent = value; };
    const button = (label, action) => {
      const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
      node.onclick = action; panel.append(node); return node;
    };
    const recover = () => {
      text('Assignment outcome needs reconciliation. No new confirmation is available. ');
      button('Check saved view', () => location.reload());
    };
    fetch('/settlement/capability', { credentials: 'same-origin', cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(capability => {
        if (capability?.status !== 'active') return;
        if (!canLock()) { text('Assignment controls unavailable.'); return; }
        if (pending()) { recover(); return; }
        button('Assign a recorded payment', async event => {
          event.currentTarget.disabled = true;
          try {
            if (pending()) { recover(); return; }
            const catalogue = await post('selections', {});
            if (catalogue.status !== 'available' || !Array.isArray(catalogue.transactions)
              || !Array.isArray(catalogue.commitments)) throw new Error('catalogue');
            text('Choose a recorded payment and planned cost. Eligibility is checked at preview and confirmation.');
            const select = (label, rows) => {
              const field = document.createElement('label'); field.textContent = label;
              const node = document.createElement('select'); node.setAttribute('aria-label', label);
              for (const row of rows) {
                const option = document.createElement('option'); option.value = row.handle;
                option.textContent = row.label; node.append(option);
              }
              field.append(node); panel.append(field); return node;
            };
            const payment = select('Recorded payment', catalogue.transactions);
            const goal = select('Planned cost', catalogue.commitments);
            const label = document.createElement('label'); label.textContent = 'Amount to assign (CAD)';
            const amount = document.createElement('input'); amount.type = 'text'; amount.inputMode = 'decimal';
            amount.setAttribute('aria-label', 'Amount to assign (CAD)'); label.append(amount); panel.append(label);
            const message = document.createElement('p'); message.setAttribute('role', 'status'); panel.append(message);
            button('Preview assignment', async event => {
              if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(amount.value)) {
                message.textContent = 'Enter a positive CAD amount with at most two decimal places.'; return;
              }
              const [whole, fraction = ''] = amount.value.split('.');
              const assignedCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
              if (!Number.isSafeInteger(assignedCents) || assignedCents <= 0) return;
              event.currentTarget.disabled = true;
              const operationId = 'operation-' + [...crypto.getRandomValues(new Uint8Array(16))]
                .map(x => x.toString(16).padStart(2, '0')).join('');
              try {
                if (pending()) { recover(); return; }
                const preview = await post('prepare', { operationId,
                  selection: { transaction: payment.value, commitment: goal.value }, assignedCents });
                if (preview.status !== 'prepared' || preview.operationId !== operationId
                  || !/^[a-f0-9]{64}$/.test(preview.previewToken) || preview.assignedCents !== assignedCents
                  || !GENERATION.test(preview.generation)
                  || Object.hasOwn(preview, 'recoverySecret') && !HASH.test(preview.recoverySecret)
                  || preview.currency !== 'cad' || !Number.isSafeInteger(preview.expiresAt)
                  || typeof preview.date !== 'string' || !record(preview.labels)) throw new Error('preview');
                await persist(operationId, 'preview', preview.generation, preview.recoverySecret);
                text('Assign ' + money2(preview.assignedCents / 100) + ' ' + preview.currency.toUpperCase()
                  + ' from ' + preview.labels.payment + ' (' + preview.date + ') to ' + preview.labels.goal
                  + '. Preview expires ' + new Date(preview.expiresAt).toISOString() + '. ');
                button('Confirm assignment', async event => {
                  event.currentTarget.disabled = true;
                  // Failure to persist or verify the marker PREVENTS dispatch.
                  try { await persist(operationId, 'dispatched', preview.generation, preview.recoverySecret); }
                  catch { text('Confirmation was not sent: pending state could not be saved. Reload to continue.'); return; }
                  try {
                    const outcome = await post('confirm', { operationId, previewToken: preview.previewToken,
                      generation: preview.generation, confirmed: true });
                    if (outcome.status === 'committed' && outcome.operationId === operationId) { location.reload(); return; }
                    if (await acknowledgeNoEffect(outcome, operationId, preview.generation, preview.previewToken)) {
                      text('Not saved. No assignment was recorded. Reload to continue. ');
                      button('Reload current view', () => location.reload()); return;
                    }
                  } catch { /* A possibly dispatched request is unresolved. */ }
                  recover();
                });
              } catch { text('Preview unavailable. No confirmation was sent. Reload to start again.'); }
            });
          } catch { text('Recorded payment selections unavailable. Reload to try again.'); }
        });
        button('Withdraw an assignment', async event => {
          event.currentTarget.disabled = true;
          try {
            if (pending()) { recover(); return; }
            const catalogue = await post('assignments', {});
            if (catalogue.status !== 'available' || !Array.isArray(catalogue.assignments)) throw new Error('catalogue');
            if (!catalogue.assignments.length) { text('No active assignments are available to withdraw.'); return; }
            text('Choose the whole assignment to withdraw. Recorded reversals remain; this does not move money.');
            const label = document.createElement('label'); label.textContent = 'Existing assignment';
            const select = document.createElement('select'); select.setAttribute('aria-label', 'Existing assignment');
            for (const row of catalogue.assignments) {
              if (typeof row.label !== 'string' || typeof row.date !== 'string' || row.currency !== 'cad'
                || !Number.isSafeInteger(row.assignedCents) || row.assignedCents <= 0
                || !/^assignment-[a-f0-9]{32}$/.test(row.handle)) throw new Error('catalogue');
              const option = document.createElement('option'); option.value = row.handle;
              option.textContent = row.label + ' · ' + money2(row.assignedCents / 100) + ' CAD · ' + row.date;
              select.append(option);
            }
            label.append(select); panel.append(label);
            button('Preview withdrawal', async event => {
              event.currentTarget.disabled = true;
              const operationId = 'operation-' + [...crypto.getRandomValues(new Uint8Array(16))]
                .map(x => x.toString(16).padStart(2, '0')).join('');
              try {
                if (pending()) { recover(); return; }
                const preview = await post('prepare-withdrawal', { operationId, assignmentHandle: select.value });
                if (preview.status !== 'prepared' || preview.operationId !== operationId
                  || !/^[a-f0-9]{64}$/.test(preview.previewToken) || preview.currency !== 'cad'
                  || !GENERATION.test(preview.generation)
                  || Object.hasOwn(preview, 'recoverySecret') && !HASH.test(preview.recoverySecret)
                  || !Number.isSafeInteger(preview.assignedCents) || preview.assignedCents <= 0
                  || !Number.isSafeInteger(preview.expiresAt) || typeof preview.date !== 'string'
                  || typeof preview.labels?.goal !== 'string') throw new Error('preview');
                await persist(operationId, 'preview', preview.generation, preview.recoverySecret);
                text('Withdraw the whole assignment of ' + money2(preview.assignedCents / 100)
                  + ' CAD to ' + preview.labels.goal + ' (' + preview.date + '). This does not move money;'
                  + ' recorded reversals remain. A new assignment requires a separate confirmation. Preview expires '
                  + new Date(preview.expiresAt).toISOString() + '. ');
                button('Confirm withdrawal', async event => {
                  event.currentTarget.disabled = true;
                  try { await persist(operationId, 'dispatched', preview.generation, preview.recoverySecret); }
                  catch { text('Confirmation was not sent: pending state could not be saved. Reload to continue.'); return; }
                  try {
                    const outcome = await post('confirm', { operationId, previewToken: preview.previewToken,
                      generation: preview.generation, confirmed: true });
                    if (outcome.status === 'committed' && outcome.operationId === operationId) { location.reload(); return; }
                    if (await acknowledgeNoEffect(outcome, operationId, preview.generation, preview.previewToken)) {
                      text('Not saved. No withdrawal was recorded. Reload to continue. ');
                      button('Reload current view', () => location.reload()); return;
                    }
                  } catch { /* Possibly dispatched withdrawal remains unresolved. */ }
                  recover();
                });
              } catch { text('Withdrawal preview unavailable. No confirmation was sent. Reload to start again.'); }
            });
          } catch { text('Assignments unavailable. Reload to try again.'); }
        });
      }).catch(() => text('Assignment controls unavailable.'));
  }
  return { initialData, publishInitial, initialized, mount };
})();

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const btn = $('theme-btn');
  if (btn) btn.textContent = 'Theme: ' + (mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'Auto');
}

/* ------------------------------------------------------------------ tables */
// A table with three or more columns cannot be read on a phone through a
// sideways scroll. Give every body cell its column heading as `data-label`
// and mark the table `stackable`; styles.css turns each row into a short
// labelled block below 640px and ignores the attribute above it. Presentation
// only: no cell text changes. Two-column tables already fit and are left alone.
function labelStackableTables(root = document) {
  for (const table of root.querySelectorAll('.scroll table')) {
    if (table.classList.contains('wk-table') || table.classList.contains('cal')) continue;
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (heads.length < 3) continue;
    table.classList.add('stackable');
    for (const tr of table.querySelectorAll('tbody tr')) {
      let col = 0;
      for (const td of tr.children) {
        if (!td.hasAttribute('data-label') && heads[col]) td.setAttribute('data-label', heads[col]);
        col += Math.max(1, Number(td.getAttribute('colspan')) || 1);
      }
    }
  }
}

function watchStackableTables() {
  if (!document.body || typeof document.querySelectorAll !== 'function') return;
  labelStackableTables();
  if (typeof MutationObserver === 'undefined') return;
  const defer = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : fn => setTimeout(fn, 16);
  let queued = false;
  const run = () => { queued = false; labelStackableTables(); };
  new MutationObserver(() => {
    if (!queued) { queued = true; defer(run); }
  }).observe(document.body, { childList: true, subtree: true });
}

// A resumed Budget document can keep earlier scripts even with no-store HTTP
// responses. Compare its response-bound build label with the incumbent HTML;
// never replace that label with the probe's identity or refresh financial data.
function watchBudgetRelease() {
  const buildFrom = doc => {
    const text = doc.querySelector('.running-build')?.textContent;
    return /^Running (?:commit |PR #[1-9]\d* \u00b7 )([0-9a-f]{7})$/i.exec(typeof text === 'string' ? text.trim() : '')?.[1].toLowerCase();
  };
  const loadedBuild = buildFrom(document);
  if (!loadedBuild) return; // Only Budget has a response-bound build identity.
  let inFlight = false, lastCheck = -Infinity, hidden = document.visibilityState === 'hidden';
  let notice = null;
  async function checkRelease() {
    if (document.visibilityState === 'hidden' || inFlight || Date.now() - lastCheck < 15000) return;
    inFlight = true;
    lastCheck = Date.now();
    const controller = new AbortController();
    // Render's free instance may need about a minute to wake. Keep the open
    // document usable while waiting; a missed deadline is still non-destructive.
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      // HTML only: no /data.json request and no provider observation. A login
      // redirect, timeout, offline/error or unknown identity leaves this page.
      const response = await fetch('/index.html', { credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return;
      const currentBuild = buildFrom(new DOMParser().parseFromString(await response.text(), 'text/html'));
      if (!currentBuild) return;
      if (currentBuild === loadedBuild) { notice?.remove(); notice = null; return; }
      if (notice) return;
      notice = document.createElement('aside');
      notice.className = 'app-release-notice';
      notice.setAttribute('data-app-release', '');
      notice.setAttribute('aria-label', 'Atlas update');
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      message.textContent = 'An Atlas update is available. Finish any unsaved work before reloading.';
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.textContent = 'Reload Atlas';
      reload.addEventListener('click', () => {
        if (confirm('Reload Atlas now? Unsaved input and pending work on this page will be cleared. Cancel to finish it first.')) location.reload();
      });
      notice.append(message, reload);
      document.body.append(notice); // Does not remount views, close sheets or move focus.
    } catch { /* An unavailable release check does not change app/data/auth state. */ }
    finally { clearTimeout(timeout); inFlight = false; }
  }
  addEventListener('pageshow', event => { if (event.persisted) checkRelease(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hidden = true;
    else if (hidden) { hidden = false; checkRelease(); }
  });
}

/* ------------------------------------------------------------------ boot */
// Pages register render callbacks; the core fetches the data, applies the
// theme, and re-runs the callbacks whenever the theme changes.
const App = (() => {
  let DATA = null, PERIODS = null, HISTORY = null, publicationFailed = false;
  const hooks = [];   // re-run on every render (data arrival, theme change)
  const onceHooks = []; // run once when data arrives (control wiring)

  // An explicit local save of successful boot responses, never a new read or
  // a financial publication. Keep the detached JSON private to this boot.
  function privateComparisonSave(mount, writingChanged) {
    let generation = 0, snapshot = null, saving = false, writing = false;
    const supported = globalThis.isSecureContext === true
      && typeof globalThis.showSaveFilePicker === 'function';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Save private comparison inputs';
    button.setAttribute('data-private-comparison-save', '');
    const status = document.createElement('p');
    status.setAttribute('data-private-comparison-status', '');
    status.setAttribute('role', 'status');
    mount.append(button, status);
    const unavailable = () => supported
      ? 'Private inputs are incomplete. Saving is unavailable.'
      : 'Private saving is unavailable in this browser. A secure browser with a file save picker is required.';
    const updateButton = () => { button.disabled = !supported || !snapshot || saving; };
    function reset() {
      generation++;
      snapshot = null;
      status.textContent = unavailable();
      updateButton();
    }
    function capture(data, periods, history, observation, responses) {
      const object = value => value && typeof value === 'object' && !Array.isArray(value);
      if (!object(data) || !object(data.plan) || !object(periods) || !object(history)
          || !['data', 'periods', 'history'].every(key => responses[key]?.status === 200)) return;
      try {
        const label = document.querySelector('.running-build')?.textContent?.trim();
        snapshot = {
          generation, loadedAt: new Date().toISOString(),
          inputs: JSON.stringify({ data, periods, history }),
          provenance: JSON.stringify({
            // The HTML exposes a short page identity, not the data-serving SHA.
            pageBuildLabel: /^Running (?:commit |PR #[1-9]\d* \u00b7 )[0-9a-f]{7}$/i.test(label || '') ? label : null,
            dataServingRevision: null,
            observation,
            responses,
          }),
        };
        status.textContent = supported
          ? 'Contains private financial data. Choose your approved private folder when saving.' : unavailable();
      } catch { snapshot = null; status.textContent = unavailable(); }
      updateButton();
    }
    button.addEventListener('click', async () => {
      if (!supported || !snapshot || saving) return;
      const selected = snapshot;
      saving = true;
      updateButton();
      let stream = null, picked = false;
      try {
        // Call the picker directly in the owner gesture. No automatic download
        // fallback, stored handle, cookie, header bag, or upload transport.
        const handle = await globalThis.showSaveFilePicker({
          suggestedName: 'atlas-private-comparison-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
          types: [{ description: 'Private Atlas comparison inputs', accept: { 'application/json': ['.json'] } }],
        });
        picked = true;
        if (snapshot !== selected || generation !== selected.generation) {
          status.textContent = 'Inputs changed while choosing a file. Save the newly loaded inputs instead.';
          return;
        }
        // A refresh may invalidate a pending picker. Once writing starts, a
        // new load waits until closure so no stale generation can be committed.
        writing = true;
        writingChanged(true);
        const body = JSON.stringify({
          schema: 'atlas-private-comparison-inputs/v1',
          exportedAt: new Date().toISOString(), loadedAt: selected.loadedAt,
          provenance: JSON.parse(selected.provenance), inputs: JSON.parse(selected.inputs),
        }) + '\n';
        stream = await handle.createWritable();
        await stream.write(body);
        await stream.close();
        stream = null;
        status.textContent = 'Private comparison inputs saved.';
      } catch (error) {
        if (stream) { try { await stream.abort(); } catch { /* No completed save is claimed. */ } }
        status.textContent = !picked && error?.name === 'AbortError'
          ? 'Private save cancelled.'
          : 'Private inputs could not be saved. No completed save was confirmed.';
      } finally {
        writing = false;
        saving = false;
        writingChanged(false);
        updateButton();
      }
    });
    reset();
    return { reset, capture, isWriting: () => writing };
  }

  function rerender() {
    if (!DATA || publicationFailed) return;
    for (const fn of hooks) fn(DATA, PERIODS, HISTORY);
  }

  function setupTheme() {
    let mode = null;
    try { mode = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
    if (mode !== 'light' && mode !== 'dark') mode = 'auto';
    applyTheme(mode);
    const btn = $('theme-btn');
    if (btn) btn.addEventListener('click', () => {
      mode = mode === 'auto' ? 'dark' : mode === 'dark' ? 'light' : 'auto';
      try { localStorage.setItem(THEME_KEY, mode); } catch { /* storage unavailable */ }
      applyTheme(mode);
      rerender();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerender);
    matchMedia(PHONE_MQ).addEventListener('change', rerender);
  }

  // Scrollspy for in-page anchors, only where a nav asks for it.
  function setupSpy() {
    const nav = document.querySelector('.subnav[data-spy]');
    if (!nav) return;
    const links = [...nav.querySelectorAll('a[href^="#"]')];
    const sections = links.map(a => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
    if (!sections.length) return;
    let ticking = false;
    function update() {
      ticking = false;
      const probe = scrollY + 150;
      let current = sections[0];
      for (const s of sections) if (s.offsetTop <= probe) current = s;
      if (scrollY + innerHeight >= document.body.scrollHeight - 4) current = sections[sections.length - 1];
      for (const a of links) {
        if (a.getAttribute('href') === '#' + current.id) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      }
    }
    addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  function boot(opts = {}) {
    setupTheme();
    setupSpy();
    watchStackableTables();
    // The static boot treatment (index.html only) covers the pre-script
    // interval; from here the boot notice below owns the loading interval,
    // so the static layer never doubles or outlives it.
    const staticBoot = document.querySelector('.boot-static');
    if (staticBoot) staticBoot.remove();
    const wrap = document.querySelector('.wrap');
    const notice = document.createElement('div');
    notice.className = 'note-box';
    notice.setAttribute('role', 'status');
    // The stylesheet's hook for the full-screen boot overlay. An
    // attribute, not a class: load() rewrites className on every
    // attempt, and .note-box is shared with in-content plan.js boxes
    // that must never become overlays.
    notice.setAttribute('data-boot-notice', '');
    if (wrap) wrap.prepend(notice);
    // While the boot overlay owns the page, the shell behind it is
    // inert and aria-hidden, so keyboard and assistive interaction
    // cannot reach the covered controls; the notice itself — Cancel
    // while loading, Retry on the crit surface — is never in the list
    // and stays operable. The covered set is every top-level body
    // subtree — the header, plus page furniture that lives outside
    // .wrap (Talk's composer form is one) — with .wrap itself
    // descended one level because the notice lives inside it. Each
    // element's prior inert / aria-hidden state is captured here and
    // restored exactly by restoreShell(), which runs on the
    // successful resolution (the notice's only removal path).
    // Failure and cancel keep the inert shell until a retry succeeds.
    // A later Manual Refresh captures the restored shell again.
    // On index.html the same isolation is baked into the static
    // markup for the pre-script interval (inert + aria-hidden +
    // data-boot-inert on the header and each .wrap child). A
    // data-boot-inert element's baked state is boot's own, not the
    // element's: its captured prior state is the natural one (not
    // inert, no aria-hidden), so the restoration below returns the
    // shell to full interactivity on arrival — the baked marker is
    // consumed here and never restored.
    const shellState = [];
    let restoreShell = () => {};
    function isolateShell() {
      if (shellState.length) return;
      const shell = [];
      const covered = new Set();
      const cover = el => { if (el && !covered.has(el)) { covered.add(el); shell.push(el); } };
      cover(document.querySelector('.site-head'));
      // Index-based traversal rather than for..of over the children
      // collections: a live HTMLCollection is iterable, but a host
      // that exposes children as a merely array-like (or absent)
      // collection must not break boot — the covered set is the
      // same either way.
      const bodyChildren = document.body ? document.body.children : null;
      for (let i = 0; bodyChildren && i < bodyChildren.length; i++) {
        const el = bodyChildren[i];
        if (!el || !el.tagName || el.tagName === 'SCRIPT') continue;
        if (el === wrap) {
          const wrapChildren = el.children;
          for (let j = 0; wrapChildren && j < wrapChildren.length; j++) {
            if (wrapChildren[j] !== notice) cover(wrapChildren[j]);
          }
        } else cover(el);
      }
      const priorFocus = document.activeElement;
      for (const el of shell) {
        if (el.hasAttribute('data-boot-inert')) {
          shellState.push({ el, inert: false, ariaHidden: null });
          el.removeAttribute('data-boot-inert');
        } else {
          shellState.push({ el, inert: !!el.inert, ariaHidden: el.getAttribute('aria-hidden') });
        }
        el.inert = true;
        el.setAttribute('aria-hidden', 'true');
      }
      restoreShell = () => {
        for (const s of shellState) {
          s.el.inert = s.inert;
          if (s.ariaHidden === null) s.el.removeAttribute('aria-hidden');
          else s.el.setAttribute('aria-hidden', s.ariaHidden);
          // A baked-isolation wrapper (index.html's data-boot-wrap
          // divs, which carry the pre-script isolation for elements
          // whose own opening tags are pinned bare by static
          // contracts elsewhere in the repo) is boot's scaffolding,
          // not page structure: once restored like the others, it is
          // replaced by its contents, so the wrapped element returns
          // to its natural parentage exactly as if it had carried
          // the baked state itself.
          if (s.el.hasAttribute && s.el.hasAttribute('data-boot-wrap') && s.el.parentNode) {
            const parent = s.el.parentNode;
            while (s.el.firstChild) parent.insertBefore(s.el.firstChild, s.el);
            parent.removeChild(s.el);
          }
        }
        shellState.length = 0;
        if (priorFocus && priorFocus !== document.body && priorFocus.isConnected
          && typeof priorFocus.focus === 'function') {
          try { priorFocus.focus({ preventScroll: true }); } catch { /* focus target gone */ }
        }
      };
    }
    isolateShell();
    // Branded boot treatment: the brand mark — the same four-block
    // SVG as index.html's static layer, filled by the shared
    // .boot-mark-* classes in styles.css and animated there — over
    // the ATLAS wordmark. Purely decorative: the whole span is
    // aria-hidden and pointer-events disabled, so the notice stays
    // the single role="status" announcer and the text contract in
    // load() is untouched. The markup is one innerHTML string because
    // SVG elements cannot be built with createElement in an HTML
    // document; the string mirrors the static layer's markup in
    // index.html.
    const buildBootTreatment = () => {
      const treatment = document.createElement('span');
      treatment.className = 'boot-treatment';
      treatment.setAttribute('aria-hidden', 'true');
      treatment.setAttribute('data-boot-treatment', '');
      treatment.innerHTML = '<svg class="boot-blocks-mark boot-treatment-mark" viewBox="0 0 32 32" aria-hidden="true">'
        + '<rect width="32" height="32" rx="10" class="boot-mark-bg"/>'
        + '<rect x="7" y="7" width="8" height="11" rx="2.6" class="boot-mark-a"/>'
        + '<rect x="17" y="7" width="8" height="6" rx="2.6" class="boot-mark-b"/>'
        + '<rect x="7" y="20" width="8" height="5" rx="2.5" class="boot-mark-b"/>'
        + '<rect x="17" y="15" width="8" height="10" rx="2.6" class="boot-mark-c"/></svg>'
        + '<span class="boot-wordmark">ATLAS</span>';
      return treatment;
    };
    let loading = false, activeLoad = null;
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Manual Refresh';
    refresh.setAttribute('data-manual-refresh', '');
    const checkStatus = document.createElement('span');
    checkStatus.className = 'muted';
    checkStatus.setAttribute('data-observation-check', '');
    checkStatus.setAttribute('role', 'status');
    const controls = document.createElement('div');
    controls.className = 'observation-controls';
    controls.append(checkStatus, refresh);
    const toolbar = document.querySelector('[data-atlas-toolbar]');
    if (toolbar) {
      // Re-home the incumbent button, including its single-flight refresh
      // handler. Source status stays in the native review sheet, not a banner.
      refresh.className = 'atlas-toolbar-refresh';
      refresh.setAttribute('aria-label', 'Manual Refresh');
      refresh.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 9a7 7 0 1 0 0 6M19 4v5h-5"/></svg>';
      toolbar.insertBefore(refresh, toolbar.querySelector('[data-transaction-review-open]'));
    }
    const reviewCheckMount = document.querySelector('[data-review-source-check]');
    const checkMount = reviewCheckMount || document.querySelector('.site-head-inner') || document.querySelector('.site-head') || $('asof')?.parentNode;
    if (checkMount) {
      checkMount.classList?.add('has-observation-controls');
      checkMount.append(controls);
    }
    const privateSave = reviewCheckMount
      ? privateComparisonSave(reviewCheckMount, busy => { refresh.disabled = busy || loading; }) : null;
    refresh.addEventListener('click', () => load(true));
    function load(forceRefresh = false) {
      if (publicationFailed) { location.reload(); return; }
      if (loading || privateSave?.isWriting()) return;
      loading = true;
      privateSave?.reset();
      if (wrap && !notice.isConnected) wrap.prepend(notice);
      isolateShell();
      refresh.disabled = true;
      const controller = new AbortController();
      let publicationStarted = false;
      const attempt = { signal: controller.signal,
        current: () => activeLoad === attempt && !cancelled && DATA === null && !publicationStarted };
      activeLoad = attempt;
      let check = null;
      let exportCheck = null;
      const responses = { data: null, periods: null, history: null };
      let cancelled = false;
      const timer = setTimeout(() => controller.abort(), 180000);
      notice.className = 'note-box is-loading';
      notice.textContent = forceRefresh
        ? 'Checking Lunch Money... This can take a couple of minutes. '
        : 'Loading current data... This can take a couple of minutes. ';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => { cancelled = true; controller.abort(); });
      notice.append(cancel);
      // The treatment is rebuilt on every attempt because the
      // textContent reset above wipes the notice's children; success
      // removes it with the notice.
      notice.append(buildBootTreatment());
      const wants = [SettlementSave.initialData(() => fetch(forceRefresh ? '/data.json?refresh=force' : '/data.json', { credentials: 'same-origin', signal: controller.signal })
        .then(async r => {
          if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
          if (!r.ok) throw new Error('data unavailable');
          check = { source: r.headers?.get('X-Atlas-Observation-Source'),
            qualified: r.headers?.get('X-Atlas-Observation-Qualified') === 'true',
            checkedAt: r.headers?.get('X-Atlas-Observation-Checked-At') };
          const qualified = r.headers?.get('X-Atlas-Observation-Qualified');
          exportCheck = {
            source: ['provider', 'memory'].includes(check.source) ? check.source : null,
            qualified: qualified === 'true' ? true : qualified === 'false' ? false : null,
            checkedAt: typeof check.checkedAt === 'string' && Number.isFinite(Date.parse(check.checkedAt)) ? check.checkedAt : null,
          };
          const json = await r.json();
          responses.data = { path: '/data.json', status: r.status };
          return json;
        }), controller.signal, attempt)];
      wants.push(opts.periods
        ? fetch('/periods.json', { credentials: 'same-origin', signal: controller.signal })
          .then(async r => {
            if (!r.ok) return null;
            const json = await r.json();
            responses.periods = { path: '/periods.json', status: r.status };
            return json;
          })
          .catch(() => null)
        : Promise.resolve(null));
      wants.push(opts.history
        ? fetch('/balance-history.json', { credentials: 'same-origin', signal: controller.signal })
          .then(async r => {
            if (!r.ok) return null;
            const json = await r.json();
            responses.history = { path: '/balance-history.json', status: r.status };
            return json;
          })
          .catch(() => null)
        : Promise.resolve(null));
      Promise.all(wants).then(async ([d, p, h]) => {
        if (controller.signal.aborted) throw new Error('load cancelled');
        // Existing once-wired views capture their initial inputs. A successful
        // forced check rebuilds every view; the next boot replays its evidence.
        if (forceRefresh) { location.reload(); return; }
        await SettlementSave.publishInitial(attempt, d, () => {
          publicationStarted = true;
          privateSave?.capture(d, p, h, exportCheck, responses);
          DATA = d; PERIODS = p || null; HISTORY = h || null;
          const asof = $('asof');
          if (asof) asof.textContent = formatSiteAsOfChip(d, PERIODS);
          for (const fn of onceHooks) fn(DATA, PERIODS, HISTORY);
          rerender();
        });
        await SettlementSave.initialized(attempt);
        checkStatus.textContent = formatObservationCheck(check, d.refreshTrust);
        refresh.disabled = false;
        restoreShell();
        notice.remove();
      }).catch(err => {
        if (publicationStarted) publicationFailed = true;
        privateSave?.reset();
        if (err.message === 'auth') return;
        controller.abort();
        notice.className = 'note-box crit';
        notice.textContent = publicationFailed
          ? 'Page initialization failed. Figures remain unavailable. Reload the page to continue. '
          : err.message === 'settlement-reconciliation'
          ? 'Assignment outcome needs reconciliation. Figures remain unavailable. '
          : cancelled
          ? 'Loading cancelled. Figures remain unavailable. '
          : forceRefresh ? 'Provider refresh failed. Figures remain unavailable. '
            : 'Current data could not be loaded. Figures remain unavailable. ';
        checkStatus.textContent = cancelled ? 'Provider refresh cancelled'
          : forceRefresh ? 'Provider refresh failed' : 'Provider check unavailable';
        // The textContent reset wiped the loading copy of the
        // treatment; the terminated surface keeps the same branding
        // as a fresh, static copy — the mark's animation is keyed to
        // .is-loading and disabled under .crit, so nothing moves and
        // nothing announces loading (the span stays aria-hidden
        // decoration; the crit text above remains the message).
        notice.append(buildBootTreatment());
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = publicationFailed ? 'Reload page' : 'Retry';
        retry.addEventListener('click', () => publicationFailed ? location.reload() : load(forceRefresh));
        notice.append(retry);
      }).finally(() => { loading = false; refresh.disabled = publicationFailed; clearTimeout(timer); });
    }
    load();
    watchBudgetRelease();
  }

  return {
    register: fn => hooks.push(fn),
    once: fn => onceHooks.push(fn),
    rerender,
    boot,
    get data() { return DATA; },
    get periods() { return PERIODS; },
    get history() { return HISTORY; },
  };
})();
