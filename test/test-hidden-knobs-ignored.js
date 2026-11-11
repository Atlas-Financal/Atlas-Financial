'use strict';
/* Hidden worksheet knobs never move the published page.
 * `node test/test-hidden-knobs-ignored.js`
 *
 * Finish-line audit finding 9 (#821 6788704527). public/plan.js used to restore
 * scenario, targetBuffer, extraDebtMonthly, weeklyVariable, incomeOverrides
 * and disabled from localStorage key `hfd-plan-knobs-v1`, with no type check,
 * and feed them to every engine call through simOpts. The controls that set
 * them sit inside #road-ahead, which the page keeps hidden, so a browser that
 * held an old key printed different figures from every other browser and
 * nothing on the page could show or reset it.
 *
 * This suite boots the real page (app.js, forecast.js, budget-surface.js,
 * plan.js, in index.html order) on the served data.json against a stub DOM,
 * once with clean storage and once per stale payload, and requires every
 * rendered mount to be identical. It also requires the key to be gone after
 * load and the page never to write it. On main (before this change) the
 * stale boots print different figures, so the suite fails there.
 *
 * Nothing rendered is printed: a difference is reported by mount id only.
 * PLAN_JS=<path> boots another copy of plan.js (used for the mutation run).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const data = require('../data.json');
const KEY = 'hfd-plan-knobs-v1';

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log('  ok    ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
};

function bootPage(stored) {
  const els = new Map();
  const makeEl = id => {
    const el = {
      id, textContent: '', value: '', placeholder: '', checked: false, hidden: false,
      className: '', style: {}, children: [], listeners: {}, attributes: {},
      addEventListener(kind, fn) { (this.listeners[kind] = this.listeners[kind] || []).push(fn); },
      setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      append(...children) { for (const child of children) this.appendChild(child); },
      remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } },
      insertAdjacentHTML(_, html) { this.innerHTML = String(html); },
      querySelectorAll: () => [],
    };
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => html, set(v) { html = String(v); el.children = []; },
    });
    return el;
  };
  const get = id => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const store = new Map();
  if (stored !== undefined) store.set(KEY, stored);
  const writes = [];
  const doc = {
    getElementById: get,
    createElement: () => makeEl('created'),
    createElementNS: () => makeEl('svg'),
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: makeEl('html'),
    body: { scrollHeight: 0 },
  };
  const periods = JSON.parse(read('public/periods.json'));
  const sandbox = {
    document: doc,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { writes.push(k); store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
    },
    addEventListener() {},
    matchMedia: () => ({ addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame() {},
    innerWidth: 1200, innerHeight: 800, scrollY: 0,
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: url => Promise.resolve({ status: 200, ok: true,
      json: () => (String(url).includes('periods') ? periods : data) }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, { AbortController, setTimeout, clearTimeout });
  vm.createContext(sandbox);
  const planFile = process.env.PLAN_JS ? path.resolve(process.env.PLAN_JS) : path.join(ROOT, 'public/plan.js');
  for (const file of ['public/app.js', 'public/forecast.js', 'public/budget-surface.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  vm.runInContext(fs.readFileSync(planFile, 'utf8'), sandbox, { filename: 'public/plan.js' });
  return { els, store, writes };
}

// Every mount's published state, by id. Values and checkbox state cover the
// hidden inputs too, so a stale knob cannot hide in a control's prefill.
const snapshot = page => {
  const out = {};
  for (const [id, el] of page.els) {
    out[id] = JSON.stringify([el.innerHTML, el.textContent, String(el.value), el.checked, el.hidden, el.attributes]);
  }
  return out;
};

const settle = () => new Promise(r => setTimeout(r, 0));
const plan = data.plan;
// The served plan may hold no adjustable commitment or estimated stream; then
// an invented id stands in, and those two cases prove only that the key is
// cleared and that nothing breaks (the figure cases above carry the rest).
const orInvented = (ids, id) => (ids.length ? ids : [id]);
const adjustable = orInvented((plan.commitments || []).filter(c => c.adjustable).map(c => c.id), 'invented-commitment');
const streams = orInvented((plan.income || []).filter(s => s.scenarioMonthly).map(s => s.id), 'invented-stream');
const other = ['conservative', 'expected', 'optimistic'].find(s => s !== plan.defaults.scenario);

// Stale payloads an older build could have written, plus malformed and
// tampered ones. Each must leave the page exactly as a clean boot prints it.
const STALE = [
  ['the weekly cap the browser suites seed (40)', { weeklyVariable: 40 }],
  ['a zero weekly cap', { weeklyVariable: 0 }],
  ['a large target buffer', { targetBuffer: 99999 }],
  ['an extra debt payment', { extraDebtMonthly: 2500 }],
  ['another income scenario', { scenario: other }],
  ['per-stream income overrides', { incomeOverrides: Object.fromEntries(streams.map(id => [id, 1])) }],
  ['every adjustable commitment toggled off', { disabled: adjustable }],
  ['all six knobs at once', { scenario: other, targetBuffer: 12345, extraDebtMonthly: 300,
    weeklyVariable: 75, incomeOverrides: Object.fromEntries(streams.map(id => [id, 2])), disabled: adjustable }],
  ['wrong types (strings, arrays, objects)', { scenario: 42, targetBuffer: '7000', extraDebtMonthly: [], weeklyVariable: '40',
    incomeOverrides: 'x', disabled: 'all' }],
  ['a tampered payload with its own debts', { debts: [{ id: 'invented', balance: 1 }], weeklyVariable: 40 }],
];
const RAW = [
  ['unparseable JSON', '{not json'],
  ['a JSON null', 'null'],
  ['a JSON array', '[1,2,3]'],
];

(async () => {
  console.log('=== a clean boot ===');
  const clean = bootPage(undefined);
  await settle();
  const base = snapshot(clean);
  const mounts = Object.keys(base).filter(id => JSON.parse(base[id])[0].length > 0);
  ok(mounts.length >= 5, 'the clean boot renders the page (' + mounts.length + ' non-empty mounts)');
  ok(mounts.includes('operating-surface-body'), 'the Budget operating surface is among them');
  ok(clean.writes.length === 0, 'a clean boot writes nothing to localStorage');

  console.log('\n=== a boot over each stale key prints the clean page ===');
  const cases = STALE.map(([what, payload]) => [what, JSON.stringify(payload)]).concat(RAW);
  for (const [what, stored] of cases) {
    const page = bootPage(stored);
    await settle();
    const now = snapshot(page);
    const ids = new Set([...Object.keys(base), ...Object.keys(now)]);
    const differ = [...ids].filter(id => base[id] !== now[id]).sort();
    ok(differ.length === 0, 'same published page — ' + what, differ.length ? 'differs at: ' + differ.slice(0, 8).join(', ') : '');
    ok(!page.store.has(KEY), 'the stale key is cleared on load — ' + what);
    ok(!page.writes.includes(KEY), 'and the page never writes it back — ' + what);
  }

  console.log('\n=== source contract ===');
  const src = fs.readFileSync(process.env.PLAN_JS ? path.resolve(process.env.PLAN_JS) : path.join(ROOT, 'public/plan.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/localStorage\.getItem\(\s*KNOB_KEY/.test(code) && !/localStorage\.setItem\(\s*KNOB_KEY/.test(code),
    'plan.js neither reads nor writes the knob key');
  ok(/localStorage\.removeItem\(\s*KNOB_KEY\s*\)/.test(code), 'plan.js clears the knob key');
  ok(!/\bsaveKnobs\b/.test(code), 'no knob persistence function remains');

  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('All hidden-knob checks passed.');
})().catch(err => { console.error(err); process.exit(1); });
