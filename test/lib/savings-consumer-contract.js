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
function mask(src) {
  const out = src.split('');
  const n = src.length;
  const templates = [];
  let i = 0, depth = 0, prev = '';
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const regexAllowed = () => /^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(prev)
    || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)$/.test(prev);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new Error('scanner: unterminated comment at ' + i);
      blank(i, e + 2); i = e + 2; continue;
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

function loadSources(root) {
  const out = {};
  for (const f of fs.readdirSync(path.join(root, 'public'))) {
    if (f.endsWith('.js') && f !== 'forecast.js') out['public/' + f] = fs.readFileSync(path.join(root, 'public', f), 'utf8');
  }
  return out;
}

module.exports = { mask, definitions, computeContract, loadSources, CONSUMER_FILES, FORBIDDEN };

/* ---- G1 v3 source guard (Atlas 6550418629; Muse 6550491885) -------------
 * Function-level pins over the set the REAL-ENTRY execution capture reaches,
 * observed with V8 precise coverage (so an alias, computed access or new
 * helper that executes is reached, whatever its spelling). Each reached
 * function is attributed to its innermost named definition; reach that
 * cannot be attributed to a named definition pins the whole module. In
 * public/forecast.js only the selector region (savingsFundingPublication and
 * the functions it calls) is pinned: the engine computation it selects from
 * is what the observed-output evidence detects. Also pinned: each page's
 * script list and the capture/guard machinery. A pin change is a review
 * obligation, not proof of numerical movement.
 */
async function observeReach(F, inputs, capturePages, root) {
  const inspector = require('inspector');
  const session = new inspector.Session();
  session.connect();
  const post = (method, params) => new Promise((resolve, reject) =>
    session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result))));
  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  try {
    for (const input of inputs) capturePages(F, input.data, input.periods, root);
    const { result } = await post('Profiler.takePreciseCoverage');
    const reached = new Map();
    for (const script of result) {
      const m = /(?:^|\/)(public\/[\w.-]+\.js)$/.exec(script.url);
      if (!m || m[1] === 'public/forecast.js') continue;
      const list = reached.get(m[1]) || [];
      for (const fn of script.functions) {
        if (fn.ranges[0].count > 0) list.push([fn.ranges[0].startOffset, fn.ranges[0].endOffset]);
      }
      reached.set(m[1], list);
    }
    return reached;
  } finally {
    await post('Profiler.stopPreciseCoverage');
    session.disconnect();
  }
}

// Top-level `const|let|var NAME = …;` statements of any initializer (wording
// tables, factories, object literals holding arrows), as definitions.
function statementDefs(masked) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if ('{(['.includes(c)) { depth++; continue; }
    if ('})]'.includes(c)) { depth--; continue; }
    if (depth !== 0 || !/[clv]/.test(c) || /[\w$]/.test(masked[i - 1] || '')) continue;
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

function sourceGuard(reached, sources, extra) {
  const modules = {};
  for (const [file, ranges] of [...reached].sort((a, b) => a[0].localeCompare(b[0]))) {
    const text = sources[file];
    if (text === undefined) throw new Error('reached file not loaded: ' + file);
    let parsed;
    try { parsed = definitions(text); } catch (error) { parsed = null; }
    if (!parsed) {
      modules[file] = { mode: 'module', reason: 'scanner could not parse the module', sha256: sha(text) };
      continue;
    }
    const all = [...parsed.defs, ...statementDefs(parsed.masked)].sort((a, b) => a.start - b.start || b.end - a.end);
    const ordinal = new Map();
    const named = all.map(d => {
      const k = (ordinal.get(d.name) || 0) + 1; ordinal.set(d.name, k);
      return { ...d, id: file + '#' + d.name + '#' + k };
    });
    const pins = new Map();
    for (const [start, end] of ranges) {
      if (start === 0 && end >= text.length - 1) continue; // the script body: covered by the residual pin
      const owner = named.filter(d => d.start <= start && end <= d.end + 1)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      if (owner) pins.set(owner.id, sha(text.slice(owner.start, owner.end)));
      // Reach outside every named definition (a module wrapper's own body)
      // is covered by the residual pin below.
    }
    // The residual: the module with every outermost named definition removed
    // and whitespace collapsed. It pins wrapper glue, exports and top-level
    // statements; a change inside an unreached function, or an added or
    // removed unrelated definition, does not trip it.
    const outer = named.filter(d => !named.some(o => o !== d && o.start <= d.start && d.end <= o.end && (o.end - o.start) > (d.end - d.start)));
    let residual = '', at = 0;
    for (const d of outer) { if (d.start < at) continue; residual += text.slice(at, d.start) + '\n'; at = d.end; }
    residual += text.slice(at);
    // Adding or removing an unrelated definition changes only whitespace here.
    residual = residual.replace(/\s+/g, ' ').trim();
    modules[file] = { mode: 'functions', residual: sha(residual),
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
module.exports.sourceGuard = sourceGuard;
module.exports.selectorRegion = selectorRegion;
module.exports.sha = sha;
module.exports.statementDefs = statementDefs;
