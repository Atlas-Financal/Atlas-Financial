'use strict';
/* G1 v3 (Atlas desk disposition 6550418629, adopted by Muse 6550491885):
 * observe the Savings selector's ACTUAL calls by executing the real page
 * entries. Instead of a hand-written call roster, each page's own script list
 * (public/index.html, public/plan-spend.html) is loaded in a Node vm. The
 * registered entries (renderPlan, renderPlanSpend) run on the served input
 * and over the page's own state variables, so each call uses the advice,
 * options and context the page itself builds. The page's Forecast global is
 * wrapped BEFORE any page script loads, so consumers that cache references
 * still go through the observer.
 *
 * The observer preserves receiver, arguments, return identity and thrown
 * exceptions. It records, in call order: the route (the calling page
 * function, from the stack), the context's own keys and the identity of each
 * value (which entry's advice, which pay-period view, the entry's plan, null
 * versus absent), and the returned value itself for typed encoding.
 *
 * Environment assumptions: a recording DOM stub (no layout, no events fired
 * unless a state below sets them), a fixed clock at the input's asOf, no
 * storage, no network. This is not a production browser and not a security
 * sandbox; it runs the same PR code the collector already runs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CAPTURE_VERSION = 'atlas-savings-page-capture/v2';
// The pages' script lists, read from their HTML so an added or removed
// script changes what runs (and the source guard pins the HTML bytes).
// Every <script tag must be the one supported form, an empty element with a
// single attribute src="/name.js" (a root-absolute file in public/, no query,
// no fragment, double quotes). Anything else (a query string, a relative or
// single-quoted path, extra attributes, an inline body, a module or any
// unrecognised form) fails closed: the capture refuses to run rather than
// silently omit a script the browser would load (Atlas 6552087494 item 1).
const PAGE_HTML = { budget: 'public/index.html', planSpend: 'public/plan-spend.html' };
const ENTRY = { budget: 'renderPlan', planSpend: 'renderPlanSpend' };
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SUPPORTED_SRC = /^ src="\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js)"$/;

function pageScripts(page, root = ROOT) {
  const file = PAGE_HTML[page];
  if (!file) throw new Error('page capture: unknown page ' + page);
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  // A script element inside an HTML comment is not loaded by the browser, and
  // an inline event-handler attribute runs code no script list names: both
  // fail closed (pre-review 6553590628 S-3).
  for (const comment of html.match(/<!--[\s\S]*?-->/g) || []) {
    if (/<script\b/i.test(comment)) throw new Error('page capture: unsupported script element inside a comment in ' + file);
  }
  if (/<[a-zA-Z][^>]*\son[a-z]+\s*=/i.test(html)) throw new Error('page capture: unsupported inline event handler in ' + file);
  const tags = (html.match(/<script\b/gi) || []).length;
  const out = [];
  let m, consumed = 0;
  SCRIPT_ELEMENT.lastIndex = 0;
  while ((m = SCRIPT_ELEMENT.exec(html))) {
    consumed++;
    const src = SUPPORTED_SRC.exec(m[1]);
    if (!src || m[2] !== '') throw new Error('page capture: unsupported script element in ' + file + ': <script' + m[1].slice(0, 80) + '>');
    out.push('public/' + src[1]);
  }
  if (consumed !== tags) throw new Error('page capture: unsupported or unterminated <script in ' + file);
  if (!out.length) throw new Error('page capture: no scripts in ' + file);
  if (new Set(out).size !== out.length) throw new Error('page capture: duplicate script in ' + file);
  return out;
}

function makeDom(defer = () => {}, runtimeLoad = () => {}) {
  const writes = [];
  const elements = new Map();
  const element = id => {
    const store = { innerHTML: '', textContent: '', dataset: {}, style: {} };
    return new Proxy(function stub() {}, {
      get(target, key) {
        if (key === 'innerHTML' || key === 'textContent' || key === 'outerHTML') return store[key] || '';
        if (key === 'id') return id;
        if (key === 'dataset' || key === 'style') return store[key];
        if (key === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
        if (key === 'children' || key === 'childNodes') return [];
        if (key === Symbol.toPrimitive) return () => '';
        if (key === 'getBoundingClientRect') return () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 });
        if (key === 'querySelector' || key === 'closest' || key === 'getAttribute') return () => null;
        if (key === 'querySelectorAll' || key === 'getElementsByClassName' || key === 'getElementsByTagName') return () => [];
        if (key === 'insertAdjacentHTML') return (where, html) => { store.innerHTML += String(html); };
        if (key === 'addEventListener') return type => { defer('listener:' + type); };
        if (typeof key === 'string' && /^removeEventListener$|^(?:appendChild|replaceChildren|setAttribute|removeAttribute|focus|blur|scrollIntoView|append|prepend|remove|showModal|close|dispatchEvent|contains)$/.test(key)) {
          return () => false;
        }
        return store[key];
      },
      set(target, key, value) {
        if (typeof key === 'string' && /^on[a-z]+$/.test(key) && typeof value === 'function') defer('handler:' + key);
        store[key] = value;
        if (key === 'innerHTML' || key === 'textContent') writes.push([id, key]);
        return true;
      },
    });
  };
  const byId = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const document = {
    getElementById: byId, querySelector: () => null, querySelectorAll: () => [],
    createElement: tag => {
      // A script the page would add at runtime is a script the capture would
      // not load: fail closed inside the page.
      if (String(tag).toLowerCase() === 'script') { runtimeLoad('script element'); throw new Error('page capture: dynamic script creation is unsupported'); }
      return element('#created');
    },
    createElementNS: (ns, tag) => {
      if (String(tag).toLowerCase() === 'script') { runtimeLoad('script element'); throw new Error('page capture: dynamic script creation is unsupported'); }
      return element('#created-ns');
    },
    createTextNode: () => element('#text'), createDocumentFragment: () => element('#fragment'),
    addEventListener: type => { defer('document-listener:' + type); }, removeEventListener() {}, body: element('#body'), documentElement: element('#html'),
    head: element('#head'), readyState: 'complete', visibilityState: 'visible', hidden: false, cookie: '',
  };
  // The final text each element holds, for the behavioral tests' page view.
  const html = () => {
    const out = {};
    for (const [id, el] of elements) { const t = el.innerHTML || el.textContent; if (t) out[id] = t; }
    return out;
  };
  return { document, elements, writes, html };
}

// Identity labels: the context's own keys and what each value IS, never a
// digest of an object we did not encode ourselves.
function describeContext(context, ids) {
  if (context === undefined) return 'context:undefined';
  if (context === null || typeof context !== 'object') return 'context:' + typeof context;
  const parts = [];
  for (const key of Object.keys(context)) {
    const v = context[key];
    let label;
    if (v === null) label = 'null';
    else if (v === undefined) label = 'undefined';
    else if (key === 'advice') label = ids.advice.get(v) || 'other-advice';
    else if (key === 'plan') label = v === ids.plan() ? 'entry-plan' : 'other-plan';
    else if (key === 'period') label = ids.views.get(v) || 'other-period';
    else if (key === 'periodId' || key === 'asOf') label = typeof v === 'string' ? JSON.stringify(v) : typeof v;
    else label = typeof v;
    parts.push(key + '=' + label);
  }
  return parts.join(',') || 'context:{}';
}
function describeSource(source, ids) {
  if (source === null) return 'null';
  if (source === undefined) return 'undefined';
  for (const [advice, label] of ids.advice) if (advice.savingsFunding === source) return label + '.savingsFunding';
  for (const [advice, label] of ids.advice) if (advice.savingsInventory === source) return label + '.savingsInventory';
  if (ids.results.has(source)) return 'result#' + ids.results.get(source);
  return typeof source === 'object' ? 'other-object' : typeof source;
}
// The consumer route: the first page function outside forecast.js and this
// module (the function that called the selector), then the page function
// that called it. A shared helper (budgetDailySavingsFor, the inventory's
// html) is therefore routed by its consumer, not only by itself.
const pageFrames = stack => {
  const out = [];
  for (const line of String(stack).split('\n').slice(1)) {
    if (/figures-page-capture\.js/.test(line) || /public\/forecast\.js/.test(line)) continue;
    const m = /at (?:new )?(?:(?:Object|Proxy)\.)?([\w$.<>]+)? ?\(?(public\/[\w.-]+\.js):\d+:\d+/.exec(line)
      || /at (public\/[\w.-]+\.js):\d+:\d+/.exec(line);
    if (m) out.push(m[2] ? m[2] + '#' + (m[1] || '<anonymous>') : m[1] + '#<top>');
  }
  return out;
};
const routeOf = stack => {
  const frames = pageFrames(stack);
  if (!frames.length) return '<unknown>';
  return frames.length > 1 ? frames[0] + '<' + frames[1] : frames[0];
};

// Compiled page scripts, reused across contexts (each run still evaluates
// the file afresh in its own realm). Keyed by path and exact text.
const COMPILED = new Map();
let RUNTIME_LOADS = null; // the running page's runtime-load record
function compiled(root, file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  // A module imported at runtime is code the capture would not load, and the
  // page could catch its rejection: any dynamic import() in a page script
  // fails closed before the script runs (pre-review 6553590628 S-3).
  if (/\bimport\s*\(/.test(text)) throw new Error('page capture: dynamic import is unsupported in ' + file);
  const key = path.join(root, file) + '\0' + text;
  if (!COMPILED.has(key)) {
    if (COMPILED.size > 256) COMPILED.clear();
    COMPILED.set(key, new vm.Script(text, { filename: file }));
  }
  return COMPILED.get(key);
}

// Test perturbations of Forecast exports, as factories real => replacement,
// applied to the page realm's own Forecast. Empty in production.
const PERTURBATIONS = new Map();
function withPerturbations(map, fn) {
  const saved = new Map(PERTURBATIONS);
  for (const [name, factory] of Object.entries(map || {})) PERTURBATIONS.set(name, factory);
  try { return fn(); } finally { PERTURBATIONS.clear(); for (const [k, v] of saved) PERTURBATIONS.set(k, v); }
}

// The observer wrapper preserves the receiver, the arguments (the same array
// elements, passed through apply), the return value's identity and any
// thrown exception. Exported so neutrality is tested directly.
function observed(fn, before, after) {
  return function (...args) {
    const token = before(args);
    let result;
    try { result = fn.apply(this, args); }
    catch (error) { after(token, undefined, error); throw error; }
    after(token, result, null);
    return result;
  };
}
// The page's Forecast global: an object of the page realm whose prototype is
// the real Forecast, with the selector and recommend observed. With
// options.instrument === false the real Forecast is returned untouched (the
// uninstrumented same-realm comparison run).
function instrumentForecast(real, observer, context, options) {
  if (options.instrument === false && !PERTURBATIONS.size) return real;
  const wrapped = vm.runInContext('Object.create', context)(real);
  for (const [name, factory] of PERTURBATIONS) {
    if (typeof real[name] !== 'function') throw new Error('page capture: perturbation of unknown export ' + name);
    wrapped[name] = factory(real[name]);
  }
  if (options.instrument === false) return wrapped;
  const recommend = wrapped.recommend, select = wrapped.savingsFundingPublication;
  wrapped.recommend = observed(recommend, () => null, (token, advice) => { if (advice) observer.advice(advice); });
  wrapped.savingsFundingPublication = observed(select,
    args => observer.before(routeOf(new Error().stack), args),
    (token, result, error) => observer.after(token, result, error));
  return wrapped;
}

// Callbacks a module registers that this capture never invokes (event
// listeners, timers, animation frames, observers). A module that registers
// one runs code the declared states may not reach; the source guard applies
// its whole-module fallback to such a module unless its handlers are modelled
// by the state matrix (Atlas 6552087494 item 5).
const HANDLER_EVENTS = ['click', 'dblclick', 'input', 'change', 'submit', 'keydown', 'keyup', 'keypress', 'scroll', 'resize', 'load',
  'error', 'pointerdown', 'pointermove', 'pointerup', 'pointerleave', 'mousemove', 'mouseleave', 'mouseenter', 'mousedown', 'mouseup',
  'focus', 'blur', 'visibilitychange', 'popstate', 'hashchange', 'pageshow', 'pagehide', 'storage', 'message', 'beforeunload',
  'toggle', 'touchstart', 'touchmove', 'touchend', 'wheel', 'animationend', 'transitionend'];
const firstPageFile = stack => {
  for (const line of String(stack).split('\n').slice(1)) {
    const m = /(public\/[\w.-]+\.js):\d+:\d+/.exec(line);
    if (m) return m[1];
  }
  return '<unknown>';
};
function loadPage(page, observer, served, root = ROOT, onContext = () => {}, options = {}) {
  const asOf = served.data.meta.asOf;
  const deferred = new Map();
  const defer = kind => {
    const file = firstPageFile(new Error().stack);
    if (!deferred.has(file)) deferred.set(file, new Set());
    deferred.get(file).add(kind);
  };
  const runtimeLoads = [];
  RUNTIME_LOADS = runtimeLoads;
  const { document, writes, html } = makeDom(defer, kind => runtimeLoads.push(kind));
  for (const ev of HANDLER_EVENTS) {
    Object.defineProperty(document, 'on' + ev, { configurable: true, get: () => null, set: fn => { if (typeof fn === 'function') defer('document-handler:on' + ev); } });
  }
  const fixed = Date.parse(asOf + 'T12:00:00Z');
  const page$ = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: () => { defer('timeout'); return 0; }, clearTimeout() {},
    setInterval: () => { defer('interval'); return 0; }, clearInterval() {},
    requestAnimationFrame: () => { defer('animation-frame'); return 0; }, cancelAnimationFrame() {},
    URL, URLSearchParams,
    document,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { pathname: page === 'budget' ? '/' : '/plan-spend', search: '', hash: '', href: 'http://capture.invalid/' },
    history: { replaceState() {}, pushState() {} }, navigator: { userAgent: 'figures-page-capture' },
    // The page's own boot fetches its inputs. The served bodies are the input
    // under capture; anything else (balance history comes from private
    // snapshot files) answers unavailable, as the server does without them.
    __serve: url => {
      const pathname = String(url).split('?')[0];
      if (pathname === '/data.json') return { status: 200, body: JSON.stringify(served.data) };
      if (pathname === '/periods.json' && served.periods) return { status: 200, body: JSON.stringify(served.periods) };
      return { status: pathname === '/balance-history.json' ? 500 : 404, body: '{"error":"unavailable"}' };
    },
    matchMedia: () => ({ matches: false, addEventListener() { defer('media-listener'); }, removeEventListener() {}, addListener() { defer('media-listener'); } }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { observe() { defer('resize-observer'); } disconnect() {} },
    IntersectionObserver: class { observe() { defer('intersection-observer'); } disconnect() {} },
    MutationObserver: class { observe() { defer('mutation-observer'); } disconnect() {} },
    AbortController: class { constructor() { this.signal = { aborted: false, addEventListener() {} }; } abort() {} },
    performance: { now: () => 0 },
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    HTMLElement: class {}, Element: class {}, Node: class {},
    addEventListener: type => { defer('window-listener:' + type); }, removeEventListener() {}, dispatchEvent() {}, scrollTo() {},
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
  };
  // Microtasks drain after each evaluation, so the page's promise-based boot
  // completes inside the run that triggers it.
  for (const ev of HANDLER_EVENTS) {
    Object.defineProperty(page$, 'on' + ev, { configurable: true, get: () => null, set: fn => { if (typeof fn === 'function') defer('window-handler:on' + ev); } });
  }
  const context = vm.createContext(page$, { microtaskMode: 'afterEvaluate' });
  context.window = context; context.self = context; context.globalThis = context;
  // The page realm's own Date and Intl, with the clock fixed at the input's
  // asOf (pre-review 6553590628 NOTE: no main-realm intrinsics).
  vm.runInContext('(() => { const D = Date; const fixed = ' + JSON.stringify(fixed) + ';'
    + ' class FixedDate extends D { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }'
    + ' globalThis.Date = FixedDate; })();', context);
  onContext(context);
  vm.runInContext(`globalThis.queueMicrotask = fn => Promise.resolve().then(fn);
    globalThis.fetch = url => { const r = __serve(url);
      const response = { ok: r.status >= 200 && r.status < 300, status: r.status, url: String(url),
        headers: { get: name => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: () => Promise.resolve(JSON.parse(r.body)), text: () => Promise.resolve(r.body) };
      response.clone = () => response;
      return Promise.resolve(response); };`, context);
  const errors = [];
  for (const file of pageScripts(page, root)) {
    try { compiled(root, file).runInContext(context); }
    catch (error) { errors.push(file + ': ' + (error && error.message)); }
    // The page's own Forecast, evaluated in the page realm exactly as the
    // browser does (so page-parsed objects meet the engine's own
    // intrinsics), is observed before any later script can cache it.
    if (file === 'public/forecast.js') {
      if (context.Forecast && typeof context.Forecast === 'object') context.Forecast = instrumentForecast(context.Forecast, observer, context, options);
      else errors.push(file + ': did not publish Forecast');
    }
  }
  return { context, errors, writes, html, deferred, runtimeLoads };
}

// The state matrix each entry is executed over, using the page's own state
// variables (plan.js script scope). Each state is set exactly as the page's
// handlers set it, then the registered entry renders again.
function budgetStates(advice) {
  const views = Array.isArray(advice && advice.payPeriodViews) ? advice.payPeriodViews : [];
  const states = [{ id: 'default', set: {} }];
  for (const view of views) for (const lens of ['today', 'payday']) {
    states.push({ id: 'period:' + view.id + '/lens:' + lens, set: { planPayPeriodId: view.id, budgetFundingLens: lens } });
  }
  states.push({ id: 'granularity:month', set: { budgetGranularity: 'month' } });
  states.push({ id: 'drilldown', set: { budgetGranularity: 'pay-period', budgetPayPeriodAnchorMonth: '@asOfMonth' } });
  return states;
}
const BUDGET_DEFAULTS = { planPayPeriodId: null, budgetFundingLens: 'today', budgetGranularity: 'pay-period',
  budgetPayPeriodAnchorMonth: null, budgetSelectedMonth: null, budgetDrilldownPayPeriod: null };

function capturePages(data, periods, root = ROOT, options = {}) {
  const observations = [];
  const runs = [];
  let stateList = null;
  const deferred = new Map();
  for (const page of ['budget', 'planSpend']) {
    // The entry's plan is the page's own App.data.plan (the page parses its
    // own copy of the served input).
    let pageContext = null;
    // The entry's plan through a compiled accessor: calling it is a plain
    // function call, so no page microtasks drain inside an observed call.
    let planOf = () => undefined;
    const ids = { advice: new Map(), views: new Map(), results: new Map(), plan: () => planOf() };
    let state = 'load', seq = 0;
    const pending = new Map();
    const observer = {
      advice(advice) {
        if (!advice || typeof advice !== 'object' || ids.advice.has(advice)) return;
        ids.advice.set(advice, page + '-advice#' + (ids.advice.size + 1));
        for (const view of Array.isArray(advice.payPeriodViews) ? advice.payPeriodViews : []) {
          if (view && typeof view === 'object' && !ids.views.has(view)) ids.views.set(view, 'view:' + view.id);
        }
      },
      before(route, args) {
        const token = { page, state, seq: seq++, route, source: describeSource(args[0], ids),
          context: describeContext(args[1], ids), arity: args.length };
        pending.set(token, true);
        return token;
      },
      after(token, result, error) {
        pending.delete(token);
        if (result && typeof result === 'object') ids.results.set(result, ids.results.has(result) ? ids.results.get(result) : token.seq);
        observations.push({ ...token, result, error: error ? String(error && error.message) : null });
      },
    };
    // The registered entry runs through the page's own boot (App.boot inside
    // plan.js / plan-spend.js), with once-hooks (wireControls) first.
    state = 'default';
    const served = { data: JSON.parse(JSON.stringify(data)), periods: periods || null };
    const before0 = observations.length;
    const { context, errors, html, deferred: pageDeferred, runtimeLoads } = loadPage(page, observer, served, root, c => {
      pageContext = c;
      planOf = vm.runInContext('() => (typeof App !== "undefined" && App.data ? App.data.plan : undefined)', c);
    }, options);
    for (const [file, kinds] of pageDeferred) { if (!deferred.has(file)) deferred.set(file, new Set()); for (const k of kinds) deferred.get(file).add(k); }
    const run = { page, loadErrors: errors, states: [] };
    runs.push(run);
    const booted = vm.runInContext('typeof App !== "undefined" && App.data != null', context);
    run.states.push({ id: 'default', calls: observations.length - before0, error: booted ? null : 'page did not boot',
      unfinished: pending.size, ...(options.recordHtml ? { html: html() } : {}) });
    const rerender = id => {
      state = id;
      const before = observations.length;
      let error = null;
      try { vm.runInContext('App.rerender()', context); } catch (e) {
        const frame = (String(e && e.stack).split('\n').find(line => /public\//.test(line)) || '').trim();
        error = String(e && e.message) + (frame ? ' @ ' + frame.replace(/^at /, '') : '');
      }
      run.states.push({ id, calls: observations.length - before, error, unfinished: pending.size,
        ...(options.recordHtml ? { html: html() } : {}) });
    };
    if (page === 'budget') {
      // The uninstrumented comparison run reuses the instrumented run's
      // state list (it observes no advice of its own).
      const list = options.states || budgetStates([...ids.advice.keys()][0]);
      stateList = list;
      for (const s of list.slice(1)) {
        const set = { ...BUDGET_DEFAULTS, ...s.set };
        if (set.budgetPayPeriodAnchorMonth === '@asOfMonth') set.budgetPayPeriodAnchorMonth = data.meta.asOf.slice(0, 7);
        vm.runInContext(Object.entries(set).map(([k, v]) => k + '=' + JSON.stringify(v) + ';').join(''), context);
        rerender(s.id);
      }
      vm.runInContext(Object.entries(BUDGET_DEFAULTS).map(([k, v]) => k + '=' + JSON.stringify(v) + ';').join(''), context);
    }
    for (const load of runtimeLoads) run.loadErrors.push('runtime load: ' + load);
    RUNTIME_LOADS = null;
  }
  return { version: CAPTURE_VERSION, observations, runs, stateList, deferred };
}

module.exports = { capturePages, pageScripts, budgetStates, withPerturbations, perturbed: () => PERTURBATIONS.size > 0, observed, CAPTURE_VERSION, PAGE_HTML, ENTRY };
