'use strict';
/* G1 reassessment A (Atlas desk ruling 6549108431 §1A; Muse 6549169779, 6549605820):
 * the bounded source contract over the Savings selector's page consumers.
 *
 * This is a CHANGE DETECTOR over a reviewed inventory, not a semantic proof
 * over arbitrary JavaScript. It computes, from the page source:
 *   - routes: every function in public/ (Forecast excluded) that calls
 *     Forecast.savingsFundingPublication or reads a packet through
 *     periodViews[].packet;
 *   - route callers: every function that calls a route function;
 *   - the consumer closure: every function reachable by call from the
 *     reviewed roots (the Saving-for card and sheet, SavingsInventory, and the
 *     S7-S10 surfaces), resolved within public/plan.js, savings-inventory.js,
 *     plan-spend.js and app.js;
 *   - a SHA-256 pin of each such function's source text;
 *   - forbidden constructs inside pinned functions (eval, Function, with,
 *     Proxy, Reflect, arguments, defineProperty, __proto__, dynamic global
 *     access), which this bounded model does not support.
 * test/test-savings-consumer-contract.js compares the result with the
 * reviewed manifest; any difference fails until the inventory is reviewed.
 * Updating a pin without reviewing the inventory does not discharge it.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- a dependency-free scanner: masks comments, strings, template text and
// regex literals so brace matching and identifier scans see code only. It
// throws on anything it cannot classify, so an unsupported file fails closed.
function mask(src, literal = null) {
  const out = src.split('');
  const n = src.length;
  const templates = [];
  let i = 0, depth = 0, prev = '';
  const blank = (a, b, isLiteral = true) => {
    for (let k = a; k < b; k++) { if (out[k] !== '\n') out[k] = ' '; if (literal && isLiteral) literal[k] = 1; }
  };
  const regexAllowed = () => /^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(prev)
    || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)$/.test(prev);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end, false); i = end; continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new Error('scanner: unterminated comment at ' + i);
      blank(i, e + 2, false); i = e + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') throw new Error('scanner: newline in string at ' + i); j++; }
      if (j >= n) throw new Error('scanner: unterminated string at ' + i);
      blank(i + 1, j); i = j + 1; prev = 'x'; continue;
    }
    if (c === '`' || (c === '}' && templates.length && templates[templates.length - 1] === depth)) {
      if (c === '}') templates.pop();
      let j = i + 1;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') break;
        j++;
      }
      if (j >= n) throw new Error('scanner: unterminated template at ' + i);
      blank(i + 1, j);
      if (src[j] === '`') { i = j + 1; prev = 'x'; continue; }
      templates.push(depth); i = j + 2; prev = '{'; continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') throw new Error('scanner: newline in regex at ' + i);
        if (ch === '[') cls = true; else if (ch === ']') cls = false; else if (ch === '/' && !cls) break;
        j++;
      }
      blank(i + 1, j); j++;
      while (/[a-z]/i.test(src[j] || '')) j++;
      i = j; prev = 'x'; continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
        prev = src.slice(i, j); i = j; continue;
      }
      prev = c;
    }
    i++;
  }
  if (templates.length || depth !== 0) throw new Error('scanner: unbalanced braces or template');
  return out.join('');
}

function matchClose(m, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const want = [];
  for (let i = open; i < m.length; i++) {
    const c = m[i];
    if (pairs[c]) want.push(pairs[c]);
    else if (c === '}' || c === ')' || c === ']') {
      if (want.pop() !== c) throw new Error('scanner: unbalanced at ' + i);
      if (!want.length) return i;
    }
  }
  throw new Error('scanner: unclosed from ' + open);
}

// Function declarations at any depth, and `const|let NAME =` bindings at any
// depth whose value is a function, an arrow, or an immediately-invoked
// factory (app.js money2 / fmtDate).
function definitions(src) {
  const m = mask(src);
  const defs = [];
  const fn = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let x;
  while ((x = fn.exec(m))) {
    const paren = m.indexOf('(', x.index);
    const brace = m.indexOf('{', matchClose(m, paren));
    defs.push({ name: x[1], start: x.index, end: matchClose(m, brace) + 1 });
  }
  const bind = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?=(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function\b|\(\s*(?:[A-Za-z_$][\w$]*|\([^)]*\))\s*=>)/g;
  while ((x = bind.exec(m))) {
    let i = x.index + x[0].length, depth = 0;
    for (; i < m.length; i++) {
      const c = m[i];
      if ('{(['.includes(c)) depth++;
      else if ('})]'.includes(c)) { depth--; if (depth < 0) break; }
      else if ((c === ';' || c === ',') && depth === 0) { if (c === ';') i++; break; }
      else if (c === '\n' && depth === 0 && /^\s*(?:const|let|var|function|\/\/|$)/.test(m.slice(i + 1, i + 40))) break;
    }
    defs.push({ name: x[1], start: x.index, end: i });
  }
  return { masked: m, defs };
}

const CONSUMER_FILES = ['public/plan.js', 'public/savings-inventory.js', 'public/plan-spend.js', 'public/app.js'];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'function', 'return', 'catch', 'typeof', 'with']);
const FORBIDDEN = [
  ['eval', /\beval\s*\(/], ['Function constructor', /\bnew\s+Function\b|(?<![\w$.])Function\s*\(/],
  ['with statement', /\bwith\s*\(/], ['Proxy', /\bProxy\b/], ['Reflect', /\bReflect\./],
  ['arguments', /(?<![\w$.])arguments\b/], ['defineProperty', /\bdefineProperty\b/], ['__proto__', /__proto__/],
  ['dynamic global access', /\b(?:globalThis|window|self)\s*\[/],
];
const sha = text => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

// sources: { 'public/plan.js': text, ... } for every file in public/ except
// forecast.js (route census) — the consumer files must be among them.
function computeContract(sources, roots) {
  const parsed = {};
  for (const [file, text] of Object.entries(sources)) parsed[file] = { text, ...definitions(text) };
  const all = [];
  for (const file of CONSUMER_FILES) {
    if (!parsed[file]) throw new Error('consumer file missing: ' + file);
    for (const d of parsed[file].defs) all.push({ ...d, file });
  }
  // Stable identity: file#name#k (k = ordinal among same-named defs in the file).
  const ordinal = new Map();
  for (const d of all.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start)) {
    const key = d.file + '#' + d.name;
    const k = (ordinal.get(key) || 0) + 1; ordinal.set(key, k);
    d.id = key + '#' + k;
    d.body = parsed[d.file].masked.slice(d.start, d.end);
    d.source = parsed[d.file].text.slice(d.start, d.end);
  }
  const byName = new Map();
  for (const d of all) { if (!byName.has(d.name)) byName.set(d.name, []); byName.get(d.name).push(d); }
  const enclosing = (file, at) => all.filter(d => d.file === file && d.start <= at && at < d.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || null;
  const resolve = (from, name) => {
    const candidates = byName.get(name) || [];
    const inner = candidates.filter(c => c.file === from.file && c.start > from.start && c.end <= from.end);
    if (inner.length) return inner;
    const same = candidates.filter(c => c.file === from.file && !all.some(o => o !== c && o.start < c.start && c.end <= o.end && o.file === c.file));
    if (same.length) return same;
    return candidates.filter(c => !all.some(o => o !== c && o.file === c.file && o.start < c.start && c.end <= o.end));
  };
  // Routes and raw packet reads, across every scanned file.
  const routes = new Set(), raw = new Set();
  for (const [file, p] of Object.entries(parsed)) {
    for (const [set, re] of [[routes, /savingsFundingPublication\s*\(/g], [raw, /periodViews[\s\S]{0,120}?\.packet\b/g]]) {
      let x;
      while ((x = re.exec(p.masked))) {
        const d = CONSUMER_FILES.includes(file) ? enclosing(file, x.index) : null;
        set.add(d ? d.id : file + '#<outside a modelled function>');
      }
    }
  }
  const routeFns = [...routes, ...raw].map(id => all.find(d => d.id === id)).filter(Boolean);
  const callers = new Set();
  for (const r of routeFns) {
    const re = new RegExp('(?<![\\w$])' + r.name.replace(/\$/g, '\\$') + '\\s*\\(', 'g');
    for (const d of all) {
      if (d === r) continue;
      let x;
      while ((x = re.exec(d.body))) {
        if (resolve(d, r.name).includes(r)) {
          const at = d.start + x.index;
          const e = enclosing(d.file, at);
          if (e && e !== r) callers.add(e.id);
        }
      }
    }
  }
  // Callee closure from the reviewed roots and every route function. Route
  // callers are pinned themselves but not closed over: closing over them
  // (renderPlan, budgetSurfaceHtml) would pin most of the page and trip on
  // unrelated work. A caller that starts handing packet data to a new helper
  // changes its own pin, which sends the inventory back for review.
  const start = [...roots.map(r => {
    const [file, name] = r.split(':');
    const found = all.filter(d => d.file === file && d.name === name);
    if (!found.length) throw new Error('root not found: ' + r);
    return found;
  }).flat(), ...routeFns];
  const seen = new Map();
  const queue = [...start];
  const unresolved = new Set();
  while (queue.length) {
    const d = queue.shift();
    if (seen.has(d.id)) continue;
    seen.set(d.id, d);
    const re = /(?<![\w$])(?:SavingsInventory\.)?([A-Za-z_$][\w$]*)\s*\(/g;
    let x;
    while ((x = re.exec(d.body))) {
      const name = x[1];
      if (KEYWORDS.has(name)) continue;
      const before = d.body.slice(Math.max(0, x.index - 1), x.index);
      if (before === '.' && !d.body.slice(Math.max(0, x.index - 17), x.index).endsWith('SavingsInventory.')) continue;
      const targets = resolve(d, name).filter(t => t !== d);
      if (!targets.length && !byName.has(name)) unresolved.add(name);
      for (const t of targets) if (!(t.start > d.start && t.end <= d.end && t.file === d.file && seen.has(t.id))) queue.push(t);
    }
  }
  for (const id of callers) if (!seen.has(id)) seen.set(id, all.find(d => d.id === id));
  const consumers = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)).map(d => {
    const forbidden = FORBIDDEN.filter(([, re]) => re.test(d.body)).map(([label]) => label);
    return { id: d.id, sha256: sha(d.source), ...(forbidden.length ? { forbidden } : {}) };
  });
  return {
    routes: [...routes].sort(), rawPacketRoutes: [...raw].sort(), routeCallers: [...callers].sort(),
    consumers, unresolvedCalls: [...unresolved].sort(),
  };
}

// The route census excludes forecast.js (the selector's own definition is not
// a page route); the source guard includes it.
function loadSources(root, { includeForecast = false } = {}) {
  const out = {};
  for (const f of fs.readdirSync(path.join(root, 'public'))) {
    if (f.endsWith('.js') && (includeForecast || f !== 'forecast.js')) out['public/' + f] = fs.readFileSync(path.join(root, 'public', f), 'utf8');
  }
  return out;
}

module.exports = { mask, definitions, computeContract, loadSources, CONSUMER_FILES, FORBIDDEN };

/* ---- G1 v3 source guard (Atlas 6550418629 and 6552087494; Muse 6550491885,
 * 6550973450 and 6552134028) -----------------------------------------------
 * The operative rule (6550973450): public/forecast.js gets the selector-region
 * pin PLUS function-level pins over its execution-reached set; every other
 * module gets function-level pins over its reached set; a whole-module pin
 * where reach cannot be established. Reach is observed with V8 precise
 * coverage of the real-entry capture, so an alias, computed access or new
 * helper that executes is reached, whatever its spelling.
 *
 * - Each reached function is attributed to its innermost named definition.
 *   A module wrapper (a top-level immediately-invoked function, named or
 *   anonymous, and a factory passed to it) is module scope, not a
 *   definition, so protection does not depend on wrapper syntax.
 * - The residual pin is the module with every outermost function definition
 *   removed: wrapper glue, module-scope data (the export table, constant
 *   tables) and top-level statements. Whitespace is normalised outside
 *   string, template and regex literals only, and line breaks are kept.
 * - Module-scope data that pinned code names is also pinned on its own.
 * - Whole-module fallback: a module that cannot be parsed, whose functions
 *   never execute under the declared states, or that registers
 *   callbacks the capture never invokes (listeners, timers, animation frames,
 *   observers) and whose handlers the declared state matrix does not model.
 *   STATE_MODELLED names the modules whose handlers are modelled, and why;
 *   every module's registration kinds are recorded, so a new kind changes
 *   the guard.
 * - Unexecuted branches and helpers inside function-level modules remain the
 *   declared unexecuted-path limit (6550973450), covered by exact-head review.
 * Also pinned: the selector region, each page's script list and HTML bytes,
 * and the capture, collector, validator, poster and guard machinery. A pin
 * change is a review obligation, not proof of numerical movement.
 */
const STATE_MODELLED = {
  'public/plan.js': 'Budget controls (pay-period picker and wheel, funding lens, granularity, month and drilldown) set the plan.js state variables the declared state matrix sets and re-render; the other listeners open, close or move already-rendered sheets, evidence and tooltips.',
  'public/app.js': 'boot, fetch timeouts, the release check and the theme/phone media listeners re-render with the same served input; chart tooltips print values the render already computed.',
};
const MACHINERY = ['scripts/figures-page-capture.js', 'scripts/figures-snapshot.js', 'scripts/figures-comment.js',
  '.github/workflows/figures-review.yml', 'test/lib/savings-consumer-contract.js'];

async function observeReach(inputs, root) {
  const Capture = require(path.join(root, 'scripts', 'figures-page-capture.js'));
  const inspector = require('inspector');
  const session = new inspector.Session();
  session.connect();
  const post = (method, params) => new Promise((resolve, reject) =>
    session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result))));
  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  try {
    const deferred = new Map();
    for (const input of inputs) {
      const capture = Capture.capturePages(input.data, input.periods, root);
      for (const [file, kinds] of capture.deferred) {
        if (!deferred.has(file)) deferred.set(file, new Set());
        for (const k of kinds) deferred.get(file).add(k);
      }
    }
    const { result } = await post('Profiler.takePreciseCoverage');
    const reached = new Map();
    for (const script of result) {
      // Page scripts run in the vm under their repository-relative filename.
      const m = /^(public\/[\w.-]+\.js)$/.exec(script.url);
      if (!m) continue;
      const list = reached.get(m[1]) || [];
      for (const fn of script.functions) {
        if (fn.ranges[0].count > 0) list.push([fn.ranges[0].startOffset, fn.ranges[0].endOffset]);
      }
      reached.set(m[1], list);
    }
    return { reached, deferred };
  } finally {
    await post('Profiler.stopPreciseCoverage');
    session.disconnect();
  }
}

// The full guard for a tree: reach over the inputs, every reached module's
// pins, the selector region, the pages and the machinery.
async function computeGuard(root, inputs) {
  const Capture = require(path.join(root, 'scripts', 'figures-page-capture.js'));
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  const reach = await observeReach(inputs, root);
  return sourceGuard(reach, loadSources(root, { includeForecast: true }), {
    selectorRegion: selectorRegion(read('public/forecast.js')),
    pages: Object.fromEntries(Object.keys(Capture.PAGE_HTML).map(p =>
      [p, { scripts: Capture.pageScripts(p, root), html: sha(read(Capture.PAGE_HTML[p])) }])),
    machinery: Object.fromEntries(MACHINERY.map(f => [f, sha(read(f))])),
  });
}

// `const|let|var NAME = …;` statements of any initializer (wording tables,
// factories, object literals holding arrows), as definitions.
function statementDefs(masked) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if ('{(['.includes(c)) { depth++; continue; }
    if ('})]'.includes(c)) { depth--; continue; }
    if (!/[clv]/.test(c) || /[\w$]/.test(masked[i - 1] || '')) continue;
    const m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(masked.slice(i, i + 120));
    if (!m) continue;
    let j = i + m[0].length, d = 0;
    for (; j < masked.length; j++) {
      const ch = masked[j];
      if ('{(['.includes(ch)) d++;
      else if ('})]'.includes(ch)) d--;
      else if (ch === ';' && d === 0) { j++; break; }
    }
    out.push({ name: m[1], start: i, end: j });
    i = j - 1;
  }
  return out;
}

// Module wrappers: a top-level `(function NAME?(…) {…})(…)` or
// `(function …{…}(…))`, and any function expression passed directly as an
// argument to that call (the UMD factory). Returns their spans.
function moduleWrappers(m) {
  const out = [];
  const ws = k => { while (k < m.length && /\s/.test(m[k])) k++; return k; };
  const fnAt = k => m.startsWith('function', k) && !/[\w$]/.test(m[k + 8] || '');
  const fnEnd = k => { const paren = m.indexOf('(', k); return matchClose(m, m.indexOf('{', matchClose(m, paren))) + 1; };
  let depth = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === '(' && depth === 0) {
      const j = ws(i + 1);
      if (fnAt(j)) {
        const end = fnEnd(j);
        let k = ws(end), call = -1;
        if (m[k] === '(') call = k;
        else if (m[k] === ')') { k = ws(k + 1); if (m[k] === '(') call = k; }
        if (call >= 0) {
          out.push({ start: j, end });
          const close = matchClose(m, call);
          let d = 0;
          for (let a = call + 1; a < close; a++) {
            const ch = m[a];
            if ('{(['.includes(ch)) d++;
            else if ('})]'.includes(ch)) d--;
            else if (d === 0 && fnAt(a) && !/[\w$.]/.test(m[a - 1] || '')) { const e = fnEnd(a); out.push({ start: a, end: e }); a = e - 1; }
          }
        }
      }
    }
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
  }
  return out;
}

// Whitespace outside literals is normalised (a run with a line break becomes
// one line break, any other run one space); literal text is kept exactly.
function normaliseCode(text, literal) {
  let out = '', run = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!literal[i] && /\s/.test(c)) { run = run === '\n' || c === '\n' ? '\n' : ' '; continue; }
    if (run !== null) { out += run; run = null; }
    out += c;
  }
  return out.replace(/\n(?:[ ]?\n)+/g, '\n').trim();
}

function sourceGuard(reach, sources, extra) {
  const { reached, deferred = new Map() } = reach;
  const modules = {};
  for (const [file, ranges] of [...reached].sort((a, b) => a[0].localeCompare(b[0]))) {
    const text = sources[file];
    if (text === undefined) throw new Error('reached file not loaded: ' + file);
    const kinds = [...(deferred.get(file) || [])].sort();
    let parsed, literal = new Uint8Array(text.length);
    try { parsed = definitions(text); mask(text, literal); } catch (error) { parsed = null; }
    if (!parsed) {
      modules[file] = { mode: 'module', reason: 'scanner could not parse the module', deferred: kinds, sha256: sha(text) };
      continue;
    }
    if (kinds.length && !STATE_MODELLED[file]) {
      modules[file] = { mode: 'module', reason: 'registers callbacks the capture never invokes, not modelled by the state matrix',
        deferred: kinds, sha256: sha(text) };
      continue;
    }
    const wrappers = moduleWrappers(parsed.masked);
    const isWrapper = d => wrappers.some(w => w.start === d.start && w.end === d.end);
    const inWrapperOnly = st => !defs.some(d => d.start < st.start && st.end <= d.end);
    const defs = parsed.defs.filter(d => !isWrapper(d));
    // Module-scope data statements: not inside any function definition (the
    // body of a module wrapper is module scope), and not a function binding.
    const fnStarts = new Set(defs.map(d => d.start));
    const data = statementDefs(parsed.masked).filter(st => !fnStarts.has(st.start) && inWrapperOnly(st))
      .map(st => ({ ...st, data: true }));
    const all = [...defs, ...data].sort((a, b) => a.start - b.start || b.end - a.end);
    const ordinal = new Map();
    const named = all.map(d => {
      const k = (ordinal.get(d.name) || 0) + 1; ordinal.set(d.name, k);
      return { ...d, id: file + '#' + d.name + '#' + k };
    });
    const pins = new Map();
    for (const [start, end] of ranges) {
      const owner = named.filter(d => d.start <= start && end <= d.end + 1)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      if (owner) pins.set(owner.id, sha(text.slice(owner.start, owner.end)));
      // Reach outside every definition (the script body, a module wrapper's
      // own code) is covered by the residual pin below.
    }
    // A module whose functions the declared executions never call (it is
    // driven from the DOM or another module's unexecuted path, as a canvas
    // widget is) has no established reach: whole-module fallback.
    if (!pins.size && defs.length) {
      modules[file] = { mode: 'module', reason: 'no function executes under the declared states: reach not established',
        ...(kinds.length ? { deferred: kinds } : {}), sha256: sha(text) };
      continue;
    }
    // Data a pinned function refers to by name (a constant table, a lookup)
    // is pinned on its own too: coverage sees functions, not the values they read.
    const pinnedText = named.filter(d => pins.has(d.id)).map(d => parsed.masked.slice(d.start, d.end)).join('\n');
    for (const d of named) {
      if (!d.data || pins.has(d.id)) continue;
      if (new RegExp('(?<![\\w$])' + d.name.replace(/\$/g, '\\$') + '(?![\\w$])').test(pinnedText)) {
        pins.set(d.id, sha(text.slice(d.start, d.end)));
      }
    }
    // The residual: every outermost function definition removed; data and
    // glue kept. An added, removed or edited unreached function changes only
    // normalised whitespace here.
    const fns = named.filter(d => !d.data);
    const outer = fns.filter(d => !fns.some(o => o !== d && o.start <= d.start && d.end <= o.end && (o.end - o.start) > (d.end - d.start)));
    let residualText = '', residualLiteral = [], at = 0;
    const keep = (a, b) => { residualText += text.slice(a, b); for (let k = a; k < b; k++) residualLiteral.push(literal[k]); };
    for (const d of outer) { if (d.start < at) continue; keep(at, d.start); residualText += '\n'; residualLiteral.push(0); at = d.end; }
    keep(at, text.length);
    modules[file] = { mode: 'functions', residual: sha(normaliseCode(residualText, residualLiteral)),
      ...(kinds.length ? { deferred: kinds, modelled: STATE_MODELLED[file] } : {}),
      pins: [...pins].sort((a, b) => a[0].localeCompare(b[0])).map(([id, sha256]) => ({ id, sha256 })) };
  }
  return { modules, ...extra };
}

// The selector region: savingsFundingPublication and every forecast.js
// function it calls, closed under calls within the module.
function selectorRegion(forecastSource) {
  const { masked, defs } = definitions(forecastSource);
  const byName = new Map();
  for (const d of defs) { if (!byName.has(d.name)) byName.set(d.name, []); byName.get(d.name).push(d); }
  const root = (byName.get('savingsFundingPublication') || [])[0];
  if (!root) throw new Error('selector not found in forecast.js');
  const seen = new Map(), queue = [root];
  while (queue.length) {
    const d = queue.shift();
    const key = d.name + '@' + d.start;
    if (seen.has(key)) continue;
    seen.set(key, d);
    const body = masked.slice(d.start, d.end);
    const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
    let x;
    while ((x = re.exec(body))) for (const t of byName.get(x[1]) || []) if (t !== d) queue.push(t);
  }
  const ordinalOf = d => defs.filter(o => o.name === d.name && o.start <= d.start).length;
  return [...seen.values()].sort((a, b) => a.start - b.start)
    .map(d => ({ id: 'public/forecast.js#' + d.name + '#' + ordinalOf(d), sha256: sha(forecastSource.slice(d.start, d.end)) }));
}

module.exports.observeReach = observeReach;
module.exports.computeGuard = computeGuard;
module.exports.moduleWrappers = moduleWrappers;
module.exports.normaliseCode = normaliseCode;
module.exports.STATE_MODELLED = STATE_MODELLED;
module.exports.MACHINERY = MACHINERY;
module.exports.sourceGuard = sourceGuard;
module.exports.selectorRegion = selectorRegion;
module.exports.sha = sha;
module.exports.statementDefs = statementDefs;
