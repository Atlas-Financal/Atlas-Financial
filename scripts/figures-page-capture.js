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

const { mask } = require('./js-scan');

const ROOT = path.join(__dirname, '..');
// v3 (adopted design 6554987596 + 6555018088 + 6555036724; Muse 6556013994):
// per-advice exact-context anchors, global result#k indexes, the enumerated
// loading and handler forms below, and test-mode descriptor originals.
const CAPTURE_VERSION = 'atlas-savings-page-capture/v4';
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

// Every attribute of every start tag, with quoted values skipped, so a
// handler attribute is found in any tag spelling (<img src="x"onerror=,
// <img/onerror=, a quoted ">" before it). Comments are skipped; raw-text
// elements (script, style, textarea, title) are skipped to their end tag.
// The end of an HTML comment that opens at i, following the HTML parsing
// rules (adopted table r4 §5): <!--> and <!---> are complete empty
// comments, and a comment also ends at --!>.
function commentEnd(html, i, file) {
  if (html.startsWith('<!-->', i)) return i + 5;
  if (html.startsWith('<!--->', i)) return i + 6;
  const a = html.indexOf('-->', i + 4), b = html.indexOf('--!>', i + 4);
  if (a < 0 && b < 0) throw new Error('page capture: unterminated comment in ' + file);
  return a < 0 ? b + 4 : b < 0 ? a + 3 : Math.min(a + 3, b + 4);
}
function htmlComments(html, file) {
  const out = [];
  for (let i = html.indexOf('<!--'); i >= 0; i = html.indexOf('<!--', i)) {
    const e = commentEnd(html, i, file);
    out.push(html.slice(i, e));
    i = e;
  }
  return out;
}
function tagAttributes(html, file) {
  const out = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    if (html.startsWith('<!--', i)) { i = commentEnd(html, i, file); continue; }
    if (html[i] !== '<' || !/[A-Za-z]/.test(html[i + 1] || '')) { i++; continue; }
    let j = i + 1;
    while (j < n && /[A-Za-z0-9-]/.test(html[j])) j++;
    const tag = html.slice(i + 1, j).toLowerCase();
    const names = [];
    for (;;) {
      while (j < n && /[\s/]/.test(html[j])) j++;
      if (j >= n) throw new Error('page capture: unterminated tag in ' + file);
      if (html[j] === '>') { j++; break; }
      const a = j;
      while (j < n && !/[\s/>=]/.test(html[j])) j++;
      names.push(html.slice(a, j).toLowerCase());
      while (j < n && /\s/.test(html[j])) j++;
      if (html[j] !== '=') continue;
      j++;
      while (j < n && /\s/.test(html[j])) j++;
      if (html[j] === '"' || html[j] === "'") {
        const e = html.indexOf(html[j], j + 1);
        if (e < 0) throw new Error('page capture: unterminated attribute value in ' + file);
        j = e + 1;
      } else {
        while (j < n && !/[\s>]/.test(html[j])) j++;
      }
    }
    out.push({ tag, names });
    if (['script', 'style', 'textarea', 'title'].includes(tag)) {
      const close = new RegExp('</' + tag + '\\s*>', 'i');
      const m = close.exec(html.slice(j));
      if (!m) throw new Error('page capture: unterminated <' + tag + '> in ' + file);
      j += m.index;
    }
    i = j;
  }
  return out;
}

function pageScripts(page, root = ROOT) {
  const file = PAGE_HTML[page];
  if (!file) throw new Error('page capture: unknown page ' + page);
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  // A script element inside an HTML comment or a <template> is not loaded as
  // a script list entry, and an inline event-handler attribute (any name
  // starting with on, in any tag spelling) runs code no script list names:
  // all fail closed (pre-review 6553590628 S-3; design 6554987596 §8).
  for (const comment of htmlComments(html, file)) {
    if (/<script\b/i.test(comment)) throw new Error('page capture: unsupported script element inside a comment in ' + file);
  }
  for (const template of html.match(/<template\b[\s\S]*?<\/template\s*>/gi) || []) {
    if (/<script\b/i.test(template)) throw new Error('page capture: unsupported script element inside a template in ' + file);
  }
  if (/<template\b/i.test(html.replace(/<template\b[\s\S]*?<\/template\s*>/gi, ''))) throw new Error('page capture: unterminated template in ' + file);
  for (const { tag, names } of tagAttributes(html, file)) {
    if (names.some(name => name.startsWith('on'))) throw new Error('page capture: unsupported inline event handler on <' + tag + '> in ' + file);
  }
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
        // A handler set through an attribute is a deferred registration too.
        if (key === 'setAttribute') return (name, value) => { if (/^on/i.test(String(name))) defer('attribute-handler:' + String(name).toLowerCase()); return undefined; };
        if (typeof key === 'string' && /^removeEventListener$|^(?:appendChild|replaceChildren|removeAttribute|focus|blur|scrollIntoView|append|prepend|remove|showModal|close|dispatchEvent|contains)$/.test(key)) {
          return () => false;
        }
        return store[key];
      },
      set(target, key, value) {
        if (typeof key === 'string' && /^on/i.test(key) && typeof value === 'function') defer('handler:' + key);
        store[key] = value;
        if (key === 'innerHTML' || key === 'textContent') writes.push([id, key]);
        return true;
      },
    });
  };
  const byId = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  // A script, iframe or frame the page would add at runtime is code the
  // capture would not load. Each records a runtime load (a load error, so
  // the capture reads INCOMPLETE even when the page catches the throw).
  const LOADING_TAGS = ['script', 'iframe', 'frame'];
  const create = (tag, label) => {
    const name = String(tag).toLowerCase();
    if (LOADING_TAGS.includes(name)) { runtimeLoad(name + ' element'); throw new Error('page capture: dynamic ' + name + ' creation is unsupported'); }
    return element(label);
  };
  const write = kind => () => { runtimeLoad(kind); throw new Error('page capture: ' + kind + ' is unsupported'); };
  const target = {
    getElementById: byId, querySelector: () => null, querySelectorAll: () => [],
    createElement: tag => create(tag, '#created'),
    createElementNS: (ns, tag) => create(tag, '#created-ns'),
    write: write('document.write'), writeln: write('document.writeln'),
    createTextNode: () => element('#text'), createDocumentFragment: () => element('#fragment'),
    addEventListener: type => { defer('document-listener:' + type); }, removeEventListener() {}, body: element('#body'), documentElement: element('#html'),
    head: element('#head'), readyState: 'complete', visibilityState: 'visible', hidden: false, cookie: '',
  };
  // The document records ANY on* function assignment, whatever the name.
  const document = new Proxy(target, {
    set(t, key, value) {
      if (typeof key === 'string' && /^on/i.test(key) && typeof value === 'function') defer('document-handler:' + key);
      t[key] = value;
      return true;
    },
  });
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
// Code the capture would not load or could not attribute, scanned on the
// comment- and literal-masked text (scripts/js-scan.js, so a comment between
// import and its parenthesis cannot hide it): dynamic import(, eval, Function
// constructors and string-argument timers. This masked scan runs in union
// with the raw-text scan below, which refuses inert mentions too. Any of them
// fails closed before the script runs (pre-review 6553590628 S-3; design
// 6554987596 §8; table r4.1 §3).
const UNSUPPORTED_CODE = [
  [/\bimport\s*\(/, 'dynamic import'], [/\beval\b/, 'eval'], [/\bFunction\s*\(/, 'Function constructor'], [/\bnew\s+Function\b/, 'Function constructor'],
  [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'string-argument timer'],
];
// The non-destructive raw-text scan (adopted r4.1 §3): the same forms on the
// page script's raw, unmodified text, without js-scan.mask, in union with the
// masked scan. Inert mentions in strings, comments or regex literals are
// therefore refused too (a disclosed, accepted cost).
const RAW_UNSUPPORTED = [
  [/\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\(/, 'dynamic import'], [/\beval\b/, 'eval'],
  [/\bFunction\s*\(/, 'Function constructor'], [/\bnew\s+Function\b/, 'Function constructor'],
  [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'string-argument timer'],
];
// Every \uHHHH and \u{H+} replaced by its code point; null when any \u is not
// one of those two forms or names a code point above U+10FFFF.
function decodeUnicodeEscapes(text) {
  if (/\\u(?![0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/.test(text)) return null;
  let invalid = false;
  const out = text.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (m, braced, four) => {
    const code = parseInt(braced || four, 16);
    if (!(code <= 0x10ffff)) { invalid = true; return m; }
    return String.fromCodePoint(code);
  });
  return invalid ? null : out;
}
function compiled(root, file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const key = path.join(root, file) + '\0' + text;
  if (!COMPILED.has(key)) {
    // Scanned once per exact text (a refused text is never cached). The raw
    // scan runs first and on its own path; a masking-scanner throw refuses.
    for (const [pattern, what] of RAW_UNSUPPORTED) {
      if (pattern.test(text)) throw new Error('page capture: ' + what + ' is unsupported (raw text) in ' + file);
    }
    // The same forms after decoding Unicode escapes (Astra MEDIUM 4; adopted
    // addendum 6560714968 §5): an escaped identifier such as eval is
    // eval to the engine. An escape that cannot be decoded fails closed.
    const decoded = decodeUnicodeEscapes(text);
    if (decoded === null) throw new Error('page capture: an invalid unicode escape is unsupported in ' + file);
    for (const [pattern, what] of RAW_UNSUPPORTED) {
      if (pattern.test(decoded)) throw new Error('page capture: ' + what + ' is unsupported (decoded escapes) in ' + file);
    }
    const masked = mask(text);
    for (const [pattern, what] of UNSUPPORTED_CODE) {
      if (pattern.test(masked)) throw new Error('page capture: ' + what + ' is unsupported in ' + file);
    }
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
  // The page's own selector (perturbed when a test perturbs it), never the
  // observed wrapper: the per-advice anchors call it directly.
  observer.selector = select;
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
// Elements and the document record any on* assignment. The window (the vm
// global, which cannot be a Proxy) records the names below: the
// GlobalEventHandlers, WindowEventHandlers and DocumentEventHandlers names
// of the HTML standard plus the pointer, touch, animation and transition
// handlers. A window handler name outside this finite list is not recorded;
// that is a declared limit, covered by the source pins and review (design
// 6555018088 §5).
const WINDOW_HANDLER_EVENTS = Object.freeze([
  // GlobalEventHandlers
  'abort', 'auxclick', 'beforeinput', 'beforematch', 'beforetoggle', 'blur', 'cancel', 'canplay', 'canplaythrough', 'change',
  'click', 'close', 'command', 'contextlost', 'contextmenu', 'contextrestored', 'copy', 'cuechange', 'cut', 'dblclick', 'drag',
  'dragend', 'dragenter', 'dragleave', 'dragover', 'dragstart', 'drop', 'durationchange', 'emptied', 'ended', 'error', 'focus',
  'formdata', 'input', 'invalid', 'keydown', 'keypress', 'keyup', 'load', 'loadeddata', 'loadedmetadata', 'loadstart',
  'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'mouseout', 'mouseover', 'mouseup', 'paste', 'pause', 'play',
  'playing', 'progress', 'ratechange', 'reset', 'resize', 'scroll', 'scrollend', 'securitypolicyviolation', 'seeked',
  'seeking', 'select', 'slotchange', 'stalled', 'submit', 'suspend', 'timeupdate', 'toggle', 'volumechange', 'waiting',
  'webkitanimationend', 'webkitanimationiteration', 'webkitanimationstart', 'webkittransitionend', 'wheel',
  'animationstart', 'animationend', 'animationiteration', 'animationcancel',
  'transitionstart', 'transitionend', 'transitionrun', 'transitioncancel',
  'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
  'gotpointercapture', 'lostpointercapture', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'selectstart',
  'selectionchange',
  // WindowEventHandlers
  'afterprint', 'beforeprint', 'beforeunload', 'hashchange', 'languagechange', 'message', 'messageerror', 'offline',
  'online', 'pagehide', 'pagereveal', 'pageshow', 'pageswap', 'popstate', 'rejectionhandled', 'storage',
  'unhandledrejection', 'unload',
  // DocumentEventHandlers
  'readystatechange', 'visibilitychange',
]);
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
  const runtimeLoad = kind => runtimeLoads.push(kind);
  const { document, writes, html } = makeDom(defer, runtimeLoad);
  const fixed = Date.parse(asOf + 'T12:00:00Z');
  // A string timer argument is code evaluated later: a load error.
  const timer = kind => fn => { if (typeof fn === 'string') runtimeLoad('string-argument ' + kind); defer(kind); return 0; };
  const refuse = kind => function () { runtimeLoad(kind); throw new Error('page capture: ' + kind + ' is unsupported'); };
  const page$ = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: timer('timeout'), clearTimeout() {},
    setInterval: timer('interval'), clearInterval() {},
    Worker: refuse('Worker'), SharedWorker: refuse('SharedWorker'), importScripts: refuse('importScripts'),
    requestAnimationFrame: () => { defer('animation-frame'); return 0; }, cancelAnimationFrame() {},
    URL, URLSearchParams,
    document,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { pathname: page === 'budget' ? '/' : '/plan-spend', search: '', hash: '', href: 'http://capture.invalid/' },
    history: { replaceState() {}, pushState() {} },
    navigator: { userAgent: 'figures-page-capture', serviceWorker: { register: refuse('service worker registration') } },
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
  for (const ev of WINDOW_HANDLER_EVENTS) {
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

// Test mode only (options.originals): a lossless descriptor snapshot of each
// result, taken at observation time, so a later mutation of a shared object is
// never the comparison (design 6555018088 §4). Every own property, string and
// symbol keyed, with its enumerability and kind; data values are snapshotted
// recursively and accessors are recorded, never invoked. The prototype class
// is plain, null, array or foreign:<constructor name>.
function intrinsic(proto, name) {
  if (!proto || typeof proto !== 'object') return false;
  const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  const fn = ctor && ctor.value;
  if (typeof fn !== 'function' || fn.name !== name || fn.prototype !== proto) return false;
  if (!/\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(fn))) return false;
  const parent = Object.getPrototypeOf(proto);
  return name === 'Object' ? parent === null : intrinsic(parent, 'Object');
}
function describeValue(value) {
  const symbols = new Map();
  const ancestors = new Set();
  const walk = (v, depth) => {
    if (v === null) return { t: 'null' };
    switch (typeof v) {
      case 'undefined': return { t: 'undefined' };
      case 'boolean': return { t: 'boolean', v };
      case 'number': return { t: 'number', v: Object.is(v, -0) ? '-0' : Number.isFinite(v) ? v : String(v) };
      case 'string': return { t: 'string', v };
      case 'object': break;
      default: return { t: typeof v };
    }
    if (require('util').types.isProxy(v)) return { t: 'proxy' };
    if (ancestors.has(v)) return { t: 'cycle' };
    if (depth > 64) return { t: 'deep' };
    const proto = Object.getPrototypeOf(v);
    const cls = proto === null ? 'null' : Array.isArray(v) && intrinsic(proto, 'Array') ? 'array'
      : !Array.isArray(v) && intrinsic(proto, 'Object') ? 'plain'
      : 'foreign:' + String((Object.getOwnPropertyDescriptor(proto, 'constructor') || {}).value?.name || '?');
    ancestors.add(v);
    const props = Reflect.ownKeys(v).map(k => {
      const d = Object.getOwnPropertyDescriptor(v, k);
      let key = k;
      if (typeof k === 'symbol') {
        if (!symbols.has(k)) symbols.set(k, symbols.size);
        key = { symbol: k.description === undefined ? null : k.description, index: symbols.get(k) };
      }
      return 'value' in d ? { key, enumerable: d.enumerable, kind: 'data', value: walk(d.value, depth + 1) }
        : { key, enumerable: d.enumerable, kind: 'accessor' };
    });
    ancestors.delete(v);
    return { t: 'object', cls, props };
  };
  return walk(value, 0);
}

// The per-advice anchors (design 6554987596 §1, 6555018088 §2, 6555036724):
// supplementary calls to the page's own selector, never observed, after the
// state's render, each mirroring exactly the source and the own context
// properties (in order) of the page routes it predicts. Budget: top
// {asOf, advice}; topNull {asOf, advice, periodId: null}; topPlan
// {asOf, advice, plan} (public/plan.js:8161); and per pay-period view byId
// {asOf, advice, periodId: view.id}, byView {asOf, period: view} and
// rawPacket (the raw read of public/plan.js:4483-4486) {asOf, period: view}.
// Plan spend: topPlan {advice, plan, asOf} (public/plan-spend.js:357, 274).
// Values are recorded raw here; scripts/figures-snapshot.js digests them.
const verdictOf = call => {
  try {
    const r = call();
    return r === null ? 'null' : r && typeof r === 'object' ? 'object' : 'error';
  } catch (error) { return 'error'; }
};
function adviceAnchors(page, advice, select, asOf, plan) {
  const has = advice && typeof advice === 'object' && advice.savingsFunding !== undefined;
  const funding = advice && advice.savingsFunding;
  const fundingLabel = !has ? 'absent' : funding && (funding.status === 'ready' || funding.status === 'unavailable') ? funding.status : 'other';
  const list = advice && Array.isArray(advice.payPeriodViews) ? advice.payPeriodViews : [];
  const current = list.find(view => view && view.timelineRole === 'current');
  const call = (source, context) => verdictOf(() => select(source, context));
  const out = { funding: fundingLabel, current: current ? current.id : null, views: [] };
  if (page === 'budget') {
    out.top = call(funding, { asOf, advice });
    out.topNull = call(funding, { asOf, advice, periodId: null });
    out.topPlan = call(funding, { asOf, advice, plan });
  } else {
    out.top = 'n/a'; out.topNull = 'n/a';
    out.topPlan = call(funding, { advice, plan, asOf });
  }
  for (const view of list) {
    const row = { id: view && view.id, role: view && view.timelineRole, start: view && view.start, end: view && view.end };
    if (page === 'budget') {
      row.byId = call(funding, { asOf, advice, periodId: view && view.id });
      row.byView = call(funding, { asOf, period: view });
      const packet = out.top === 'object' && funding && Array.isArray(funding.periodViews)
        ? (funding.periodViews.find(entry => entry && entry.id === (view && view.id)) || {}).packet : undefined;
      row.rawPacket = packet ? call(packet, { asOf, period: view }) : 'none';
    } else {
      row.byId = 'n/a'; row.byView = 'n/a'; row.rawPacket = 'n/a';
    }
    out.views.push(row);
  }
  return out;
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
  const advices = [];
  const gates = [];
  let stateList = null;
  const deferred = new Map();
  for (const page of ['budget', 'planSpend']) {
    // The entry's plan is the page's own App.data.plan (the page parses its
    // own copy of the served input).
    let pageContext = null;
    // The entry's plan through a compiled accessor: calling it is a plain
    // function call, so no page microtasks drain inside an observed call.
    let planOf = () => undefined, asOfOf = () => undefined;
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
        // result#k names the GLOBAL index of the LATEST prior observation in
        // the same state that returned this object (adopted table r4 R-pass;
        // the source label is taken in before(), before this return is
        // recorded). The map is reset at each state boundary.
        if (result && typeof result === 'object') ids.results.set(result, observations.length);
        const o = { ...token, result, error: error ? String(error && error.message) : null };
        if (options.originals && result && typeof result === 'object') o.original = describeValue(result);
        observations.push(o);
      },
    };
    // After each state's render: the anchors of every advice that state's
    // observations used (an advice reused by a later state is not
    // re-anchored; the validators refuse the reuse).
    const anchored = new Set();
    // Same-execution gate facts (adopted table r4.1 §1-§2; Atlas 6558692784):
    // the page's own budgetTrajectoryFor and budgetMonthPlanSpendSchedule
    // returns in THIS state, by calling page function, and the page's own
    // gate helpers applied to them. Pass-through observers, never altering a
    // receiver, argument, return or exception.
    let stateGates = { traj: new Map(), monthSchedule: [] };
    const yn = v => (v ? 'y' : 'n');
    const realmFn = name => (pageContext ? vm.runInContext('typeof ' + name + ' === "function" ? ' + name + ' : null', pageContext) : null);
    const realmValue = name => (pageContext ? vm.runInContext('typeof ' + name + ' === "undefined" ? undefined : ' + name, pageContext) : undefined);
    const gateState = (id, from) => {
      if (page !== 'budget' || options.instrument === false || options.gates === false) return;
      const slice = observations.slice(from);
      let advice = null;
      for (const o of slice) {
        const m = /(?:budget|planSpend)-advice#\d+/.exec(o.source + ',' + o.context);
        if (m) { for (const [a, label] of ids.advice) if (label === m[0]) advice = a; if (advice) break; }
      }
      const isDate = realmFn('isValidIsoCalendarDate') || (() => false);
      const g = { page, state: id };
      // Calendar inventory (pj:4489-4494): the page's eight-fact inline
      // predicate, on this state's advice, with savingsContext.asOf =
      // defaultView.asOf || alloc.asOf || '' (pj:5154; alloc is page-local,
      // so a missing defaultView.asOf reads unknown).
      const inv = advice && advice.savingsInventory;
      const ctxAsOf = advice && advice.defaultView && advice.defaultView.asOf ? advice.defaultView.asOf : null;
      g.calendar = !advice ? '-' : [inv && inv.source === 'Forecast.savingsInventory', inv && inv.status === 'ready', inv && inv.nonAdditive === true,
        inv && inv.currency === 'CAD', inv && Array.isArray(inv.goals), inv && Array.isArray(inv.pools)].map(yn).join('')
        + (ctxAsOf === null ? 'uu' : yn(isDate(ctxAsOf)) + yn(inv && inv.asOf === ctxAsOf));
      // Step 6's own equality (pj:4484-4486): this state's R-C result asOf.
      const rc = slice.find(o => o.route === 'public/plan.js#budgetDailySavingsFor<public/plan.js#budgetPayPeriodContentHtml');
      g.dailyAsOf = !rc ? '-' : rc.result === null ? 'null' : ctxAsOf === null ? 'u' : yn(rc.result && rc.result.asOf === ctxAsOf);
      // Goals/evidence (pj:5484 with 7430/7567): presence, not readiness.
      g.inventory = !advice ? '-' : yn(!!inv && realmValue('SavingsInventory') !== undefined);
      // S10 (pj:3185-3187, 3191-3192, 3279-3291, 3327, 3336-3345, 3630-3634,
      // 3726-3728, 3830-3846): the trajectory this state's own call returned.
      g.month = '-'; g.monthPayday = '-'; g.monthId = '-'; g.drilldown = '-';
      if (id === 'granularity:month') {
        const t = stateGates.traj.get('public/plan.js#budgetMonthSurfaceHtml');
        g.month = !t ? 'none' : yn(t.ret && t.ret.status === 'ready' && Array.isArray(t.ret.months) && t.ret.months.length > 0);
        const e = stateGates.monthSchedule.find(x => x.caller === 'public/plan.js#budgetMonthSurfaceHtml');
        if (e) {
          const src = e.args[0] || {};
          const asOf = src.asOf || (src.meta && src.meta.asOf);
          const r = e.ret;
          const pd = r && Array.isArray(r.paydays) && r.paydays[0] ? r.paydays[0].payday : undefined;
          g.monthPayday = yn(r && r.asOf === asOf && isDate(pd) && pd >= asOf);
          const obs = observations[e.after - 1];
          const fromSelector = obs && obs.route === 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetMonthSurfaceHtml';
          g.monthId = !fromSelector ? 'other' : obs.result && obs.result.schedule && obs.result.schedule === r ? 'pub'
            : (!obs.result || !obs.result.schedule) && r && r.status === 'unavailable' && r.source === 'Forecast.planSpendPaydayFunding'
              && Array.isArray(r.paydays) && r.paydays.length === 0 ? 'fallback' : 'other';
        }
      }
      if (id === 'drilldown') {
        const t = stateGates.traj.get('public/plan.js#budgetPayPeriodDrilldownHtml');
        if (!t) g.drilldown = 'none';
        else {
          const ready = !!(t.ret && t.ret.status === 'ready');
          const periodsOf = realmFn('budgetDrilldownPeriods'), label = realmFn('budgetDrilldownPeriodLabel');
          const list = ready && periodsOf && label ? Array.from(periodsOf(t.ret, realmValue('budgetPayPeriodAnchorMonth')) || []).filter(p => label(p)) : [];
          const want = realmValue('budgetDrilldownPayPeriod');
          const sel = list.find(p => p && (p.payday || p.id) === want) || list[0];
          g.drilldown = [ready, list.length > 0, !!(sel && label(sel)), !!(sel && (sel.payday || sel.id))].map(yn).join('');
        }
      }
      gates.push(g);
    };
    const gateRecord = (name, args, ret) => {
      const caller = pageFrames(new Error().stack)[0] || '<unknown>';
      if (name === 'budgetTrajectoryFor') stateGates.traj.set(caller, { ret });
      else if (name === 'budgetMonthPlanSpendSchedule') stateGates.monthSchedule.push({ caller, args, ret, after: observations.length });
    };
    const anchorState = (id, from) => {
      if (options.anchors === false || !observer.selector) return;
      const labels = new Set();
      for (const o of observations.slice(from)) {
        for (const m of (o.source + ',' + o.context).matchAll(/(?:budget|planSpend)-advice#\d+/g)) labels.add(m[0]);
      }
      for (const [advice, label] of ids.advice) {
        if (!labels.has(label) || anchored.has(label)) continue;
        anchored.add(label);
        advices.push({ label, page, state: id, ...adviceAnchors(page, advice, observer.selector, asOfOf(), planOf()) });
      }
    };
    // The registered entry runs through the page's own boot (App.boot inside
    // plan.js / plan-spend.js), with once-hooks (wireControls) first.
    state = 'default';
    const served = { data: JSON.parse(JSON.stringify(data)), periods: periods || null };
    const before0 = observations.length;
    const { context, errors, html, deferred: pageDeferred, runtimeLoads } = loadPage(page, observer, served, root, c => {
      pageContext = c;
      planOf = vm.runInContext('() => (typeof App !== "undefined" && App.data ? App.data.plan : undefined)', c);
      asOfOf = vm.runInContext('() => (typeof App !== "undefined" && App.data && App.data.meta ? App.data.meta.asOf : undefined)', c);
    }, options);
    // The gate observers wrap two page functions after load (the default
    // state renders during load; month and drilldown states rerender later).
    if (page === 'budget' && options.instrument !== false && options.gates !== false) {
      vm.runInContext(`(record) => { for (const name of ['budgetTrajectoryFor', 'budgetMonthPlanSpendSchedule']) {
        const real = globalThis[name]; if (typeof real !== 'function') continue;
        globalThis[name] = function (...a) { const r = real.apply(this, a); record(name, a, r); return r; }; } }`, context)(gateRecord);
    }
    for (const [file, kinds] of pageDeferred) { if (!deferred.has(file)) deferred.set(file, new Set()); for (const k of kinds) deferred.get(file).add(k); }
    const run = { page, loadErrors: errors, states: [] };
    runs.push(run);
    const booted = vm.runInContext('typeof App !== "undefined" && App.data != null', context);
    run.states.push({ id: 'default', calls: observations.length - before0, error: booted ? null : 'page did not boot',
      unfinished: pending.size, ...(options.recordHtml ? { html: html() } : {}) });
    anchorState('default', before0);
    gateState('default', before0);
    const rerender = id => {
      state = id;
      ids.results.clear();
      stateGates = { traj: new Map(), monthSchedule: [] };
      const before = observations.length;
      let error = null;
      try { vm.runInContext('App.rerender()', context); } catch (e) {
        const frame = (String(e && e.stack).split('\n').find(line => /public\//.test(line)) || '').trim();
        error = String(e && e.message) + (frame ? ' @ ' + frame.replace(/^at /, '') : '');
      }
      run.states.push({ id, calls: observations.length - before, error, unfinished: pending.size,
        ...(options.recordHtml ? { html: html() } : {}) });
      anchorState(id, before);
      gateState(id, before);
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
  }
  return { version: CAPTURE_VERSION, observations, runs, stateList, deferred, advices, gates };
}

module.exports = { capturePages, pageScripts, budgetStates, withPerturbations, perturbed: () => PERTURBATIONS.size > 0, observed,
  describeValue, adviceAnchors, WINDOW_HANDLER_EVENTS, CAPTURE_VERSION, PAGE_HTML, ENTRY };
