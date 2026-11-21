'use strict';
// The real Budget page renderer for tests: public/app.js and public/plan.js
// loaded whole in a sandbox, composed exactly as the live surface composes
// them (budgetSurfaceParts: the unavailable surface, or the Today card plus
// the compact pay-period content). Replaces suite-local copies of plan.js
// functions and the retired operatingSurfaceHtml composer. Invented data only.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const element = () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {},
  removeAttribute() {}, appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: { setProperty() {} }, dataset: {}, hidden: false, innerHTML: '', textContent: '' });

function loadBudgetPage({ Forecast = require(path.join(ROOT, 'public', 'forecast.js')), state = null, globals = {} } = {}) {
  const context = vm.createContext(Object.assign({
    Forecast, console, setTimeout, clearTimeout,
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      getElementById() { return null; }, createElement: element, body: element(),
      documentElement: { dataset: {}, style: { setProperty() {} } } },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; },
      requestAnimationFrame() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { pathname: '/', search: '', hash: '' }, history: { replaceState() {} },
    navigator: { userAgent: 'node' },
  }, globals));
  for (const file of ['app.js', 'plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'), context, { filename: file });
    if (file === 'app.js') vm.runInContext('App.boot = () => {};', context);
  }
  if (state) { context.__state = state; vm.runInContext('Object.assign(state, __state)', context); }
  const get = name => vm.runInContext(name, context);
  return {
    context, get,
    // The live Budget composition (budgetSurfaceHtml's parts), minus the
    // header, detail sheet and interactive sections that need a browser.
    surfaceHtml(ctx) {
      const parts = get('budgetSurfaceParts')();
      return parts.planUnavailable(ctx) ? parts.unavailableHtml(ctx) : parts.todayHtml(ctx) + parts.periodHtml(ctx);
    },
  };
}
// Source text of the live Budget composer: budgetSurfaceParts (the one
// unavailable branch and the part wiring), the Today card and the selected
// pay-period content. Static "the page is a renderer" checks read this.
// Returns [text] like RegExp#exec, or null when any part is missing.
const LIVE_COMPOSER = ['budgetSurfaceParts', 'budgetTodayCashCardHtml', 'budgetPayPeriodContentHtml'];
function liveBudgetComposerSource(planSrc) {
  const bodies = LIVE_COMPOSER.map(name => new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}').exec(planSrc));
  return bodies.every(Boolean) ? [bodies.map(body => body[0]).join('\n')] : null;
}

// ---------------------------------------------------------------------------
// The Stack page (public/stack-shell.js and its blocks: the default route since B7), booted for tests the way
// loadBudgetPage boots the classic page. The classic boot stays until S7 (C1), so a suite can use either.
//
// The real scripts run in a sandbox against a small recording DOM: every element looked up by a selector is one stable
// object, so what a block draws into its container can be read back. Nothing here computes a figure: the page's own
// Forecast call, the shell's own selection and each block's own drawing produce everything returned.
//
//   const page = await loadStackPage({ data, periods });
//   page.status()            'rendered', or why not (a shell that fell back is a failure, never a pass)
//   page.blockHtml('waterfall'|'cards'|'credit'|'sheet')   what that block drew for the selected pay period
//   page.periodKeys()        every pay period the page offers, in order; page.selectedKey() the selected one
//   page.selectPeriod(key)   the household pressing a period chip; the blocks redraw for it
//   page.context()           what the shell hands every block ({ data, plan, recommendation, selectedPeriodKey, Forecast })
//   page.errors              anything the page sent to console.error
const STACK_SCRIPTS = ['app.js', 'display-name.js', 'forecast-card-period.js', 'forecast.js', 'forecast-chequing.js',
  'balance-history.js', 'bill-detail.js', 'savings-inventory.js', 'budget-surface.js', 'plan.js',
  'stack-shell.js', 'stack-waterfall.js', 'stack-cards.js', 'stack-credit.js', 'stack-sheet.js'];

function recordingDocument() {
  const byId = new Map();
  const make = (id = '') => {
    const cache = new Map();
    const listeners = {};
    const el = {
      id, className: '', textContent: '', value: '', hidden: false, disabled: false, children: [], style: {}, dataset: {},
      attributes: {}, parentNode: null, offsetWidth: 0, clientWidth: 0, scrollWidth: 0, scrollLeft: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      listeners,
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener() {}, setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }, removeAttribute() {},
      appendChild(child) { child.parentNode = el; this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; return child; },
      append() {}, remove() {}, insertAdjacentHTML() {}, focus() {}, scrollTo() {}, scrollIntoView() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
      closest: () => null, matches: () => false,
      // One stable stub per selector, so what a block draws into it can be read back.
      querySelector(selector) { if (!cache.has(selector)) cache.set(selector, make()); return cache.get(selector); },
      querySelectorAll: () => [],
    };
    let html = '';
    Object.defineProperty(el, 'innerHTML', { get: () => html, set(v) { html = String(v); } });
    return el;
  };
  const getById = id => { if (!byId.has(id)) byId.set(id, make(id)); return byId.get(id); };
  const created = [];
  const documentElement = make('html');
  const doc = {
    getElementById: id => (id === 'stack-root' ? doc.__root || null : getById(id)),
    createElement(tag) { const el = make(); el.tagName = String(tag).toUpperCase(); created.push(el); return el; },
    createElementNS: () => make(),
    querySelector: () => null, querySelectorAll: () => [],
    documentElement, body: make('body'), head: make('head'),
    addEventListener() {}, fonts: undefined, readyState: 'complete',
  };
  // The shell mounts <main id="stack-root"> under .wrap or the body: keep the element it appends.
  const bodyAppend = doc.body.appendChild.bind(doc.body);
  doc.body.appendChild = child => { if (child.id === 'stack-root') doc.__root = child; return bodyAppend(child); };
  return doc;
}

async function loadStackPage({ data, periods = null, history = null, globals = {}, Forecast = null } = {}) {
  if (!data) throw new Error('loadStackPage needs the served document (data)');
  const errors = [];
  const document = recordingDocument();
  const sandbox = Object.assign({
    document, console: { log() {}, warn() {}, error: (...a) => errors.push(a), info() {} },
    setTimeout, clearTimeout, AbortController, URLSearchParams, Date, Math, JSON,
    CSS: { escape: s => String(s) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname: '/', search: '', hash: '', href: 'http://stack-page.test/', reload() {} },
    history: { replaceState() {} }, navigator: { userAgent: 'node' },
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }), requestAnimationFrame() {},
    innerWidth: 1200, innerHeight: 800, scrollY: 0,
    fetch: url => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(
      String(url).includes('periods') ? periods : String(url).includes('balance-history') ? history : JSON.parse(JSON.stringify(data))) }),
  }, globals);
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of STACK_SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'), sandbox, { filename: file });
    if (file === 'forecast.js' && Forecast) sandbox.Forecast = Forecast;
  }
  // App.boot started in plan.js and fetches through the stub; let the page publish.
  await new Promise(resolve => setTimeout(resolve, 60));
  const root = () => document.__root || null;
  const block = name => (root() ? root().querySelector(`[data-stack-block="${name}"]`) : null);
  const context = () => (sandbox.StackBlocks && sandbox.StackBlocks.context ? sandbox.StackBlocks.context() : null);
  const keyOf = v => `${v.start}`;
  // The status is the only thing that says the page is usable. Each of its three lines is exercised by its own
  // scenario in test/test-stack-page-harness.js, and that test removes each line from this file in turn and
  // shows a scenario then fails: a harness that cannot tell a fall-back from a render would go green on nothing.
  const status = () => {
    if (errors.length) return 'fell-back';
    if (!root()) return 'not-mounted';
    const ctx = context();
    if (!ctx || !ctx.recommendation) return 'no-recommendation';
    return 'rendered';
  };
  // Nothing is read back from a page that is not rendered: after a fall-back on a later draw (the shell removes its
  // root and hands back the classic page) the last block HTML is stale, so every read says nothing rather than that.
  const live = () => status() === 'rendered';
  const page = {
    sandbox, errors, document,
    status,
    blockHtml: name => (live() && block(name) ? block(name).innerHTML : ''),
    context: () => (live() ? context() : null),
    selectedKey: () => { const ctx = live() ? context() : null; return ctx ? ctx.selectedPeriodKey : null; },
    periodKeys() {
      const ctx = live() ? context() : null;
      const views = ctx && ctx.recommendation && Array.isArray(ctx.recommendation.payPeriodViews) ? ctx.recommendation.payPeriodViews : [];
      return views.filter(v => v && typeof v.start === 'string').map(keyOf);
    },
    // The household pressing a pay period chip: the shell's own delegated click handler, with the chip in the event.
    // Returns the selected key, or null when the page was not rendered before the press or fell back during it.
    selectPeriod(key) {
      if (!live()) return null;
      const handlers = (root() && root().listeners.click) || [];
      const chip = { getAttribute: name => (name === 'data-stack-period' ? key : null) };
      const event = { target: { closest: sel => (sel === '[data-stack-period]' ? chip : null) }, preventDefault() {} };
      // An error out of the handler is an uncaught page error, as in a browser: it counts like any other.
      for (const fn of handlers) { try { fn(event); } catch (error) { errors.push([error]); } }
      return page.selectedKey();   // null once the press made the page fall back (selectedKey reads nothing then)
    },
  };
  return page;
}

module.exports = { loadBudgetPage, loadStackPage, liveBudgetComposerSource, LIVE_COMPOSER, STACK_SCRIPTS };
