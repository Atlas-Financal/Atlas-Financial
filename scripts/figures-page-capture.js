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
const CAPTURE_VERSION = 'atlas-savings-page-capture/v1';
// The pages' script lists, read from their HTML so an added or removed
// script changes what runs (and the source guard pins the HTML).
const PAGE_HTML = { budget: 'public/index.html', planSpend: 'public/plan-spend.html' };
const ENTRY = { budget: 'renderPlan', planSpend: 'renderPlanSpend' };

function pageScripts(page, root = ROOT) {
  const html = fs.readFileSync(path.join(root, PAGE_HTML[page]), 'utf8');
  const out = [];
  const re = /<script\b[^>]*\bsrc="\/([A-Za-z0-9_.-]+\.js)"/g;
  let m;
  while ((m = re.exec(html))) out.push('public/' + m[1]);
  if (!out.length) throw new Error('page capture: no scripts in ' + PAGE_HTML[page]);
  return out;
}

function makeDom() {
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
        if (typeof key === 'string' && /^(?:add|remove)EventListener$|^(?:appendChild|replaceChildren|setAttribute|removeAttribute|focus|blur|scrollIntoView|append|prepend|remove|showModal|close|dispatchEvent|contains)$/.test(key)) {
          return () => false;
        }
        return store[key];
      },
      set(target, key, value) {
        store[key] = value;
        if (key === 'innerHTML' || key === 'textContent') writes.push([id, key]);
        return true;
      },
    });
  };
  const byId = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const document = {
    getElementById: byId, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => element('#created'), createElementNS: () => element('#created-ns'),
    createTextNode: () => element('#text'), createDocumentFragment: () => element('#fragment'),
    addEventListener() {}, removeEventListener() {}, body: element('#body'), documentElement: element('#html'),
    head: element('#head'), readyState: 'complete', visibilityState: 'visible', hidden: false, cookie: '',
  };
  return { document, elements, writes };
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
    else if (key === 'plan') label = v === ids.plan ? 'entry-plan' : 'other-plan';
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
const routeOf = stack => {
  // The first frame outside forecast.js and this module is the calling page function.
  for (const line of String(stack).split('\n').slice(1)) {
    if (/figures-page-capture\.js/.test(line) || /public\/forecast\.js/.test(line)) continue;
    const m = /at (?:(?:Object|Proxy)\.)?([\w$.<>]+)? ?\(?(public\/[\w.-]+\.js):\d+:\d+/.exec(line)
      || /at (public\/[\w.-]+\.js):\d+:\d+/.exec(line);
    if (m) return m[2] ? m[2] + '#' + (m[1] || '<anonymous>') : m[1] + '#<top>';
  }
  return '<unknown>';
};

function loadPage(page, F, observer, asOf, root = ROOT) {
  const { document, writes } = makeDom();
  const fixed = Date.parse(asOf + 'T12:00:00Z');
  class FixedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(fixed); }
    static now() { return fixed; }
  }
  const page$ = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, queueMicrotask() {},
    Promise, URL, URLSearchParams, Intl, Date: FixedDate, Math, JSON,
    document,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { pathname: page === 'budget' ? '/' : '/plan-spend', search: '', hash: '', href: 'http://capture.invalid/' },
    history: { replaceState() {}, pushState() {} }, navigator: { userAgent: 'figures-page-capture' },
    fetch: () => new Promise(() => {}),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController: class { constructor() { this.signal = { aborted: false, addEventListener() {} }; } abort() {} },
    performance: { now: () => 0 },
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    HTMLElement: class {}, Element: class {}, Node: class {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, scrollTo() {},
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
  };
  // The page's Forecast global: every export of the real module, with the
  // selector and recommend observed. Installed before any page script runs.
  const wrapped = Object.create(F);
  const realSelect = F.savingsFundingPublication;
  const realRecommend = F.recommend;
  wrapped.recommend = function recommend(...args) {
    const advice = realRecommend.apply(F, args);
    observer.advice(advice);
    return advice;
  };
  wrapped.savingsFundingPublication = function savingsFundingPublication(...args) {
    const route = routeOf(new Error().stack);
    const token = observer.before(route, args);
    let result;
    try { result = realSelect.apply(F, args); }
    catch (error) { observer.after(token, undefined, error); throw error; }
    observer.after(token, result, null);
    return result;
  };
  const context = vm.createContext(page$);
  context.window = context; context.self = context; context.globalThis = context;
  const errors = [];
  for (const file of pageScripts(page, root)) {
    if (file === 'public/forecast.js') { context.Forecast = wrapped; continue; }
    try { vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }); }
    catch (error) { errors.push(file + ': ' + (error && error.message)); }
  }
  return { context, errors, writes };
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

function capturePages(F, data, periods, root = ROOT) {
  const observations = [];
  const runs = [];
  for (const page of ['budget', 'planSpend']) {
    const ids = { advice: new Map(), views: new Map(), plan: null, results: new Map() };
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
    const { context, errors } = loadPage(page, F, observer, data.meta.asOf, root);
    const run = { page, loadErrors: errors, states: [] };
    runs.push(run);
    const entry = vm.runInContext(ENTRY[page], context);
    const render = id => {
      state = id;
      const d = JSON.parse(JSON.stringify(data));
      ids.plan = d.plan;
      const before = observations.length;
      let error = null;
      try { entry(d, periods, null); } catch (e) {
        const frame = (String(e && e.stack).split('\n').find(line => /public\//.test(line)) || '').trim();
        error = String(e && e.message) + (frame ? ' @ ' + frame.replace(/^at /, '') : '');
      }
      run.states.push({ id, calls: observations.length - before, error, unfinished: pending.size });
    };
    if (page === 'budget') {
      render('default');
      const advice = [...ids.advice.keys()][0];
      for (const s of budgetStates(advice).slice(1)) {
        const set = { ...BUDGET_DEFAULTS, ...s.set };
        if (set.budgetPayPeriodAnchorMonth === '@asOfMonth') set.budgetPayPeriodAnchorMonth = data.meta.asOf.slice(0, 7);
        vm.runInContext(Object.entries(set).map(([k, v]) => k + '=' + JSON.stringify(v) + ';').join(''), context);
        render(s.id);
      }
      vm.runInContext(Object.entries(BUDGET_DEFAULTS).map(([k, v]) => k + '=' + JSON.stringify(v) + ';').join(''), context);
    } else {
      render('default');
    }
  }
  return { version: CAPTURE_VERSION, observations, runs };
}

module.exports = { capturePages, pageScripts, budgetStates, CAPTURE_VERSION, PAGE_HTML, ENTRY };
