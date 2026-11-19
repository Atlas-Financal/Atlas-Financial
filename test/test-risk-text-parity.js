'use strict';
/* The Budget page's "what could break the plan" list (renderPlan, when
 * diagnostics are visible) maps each Forecast.planPhases(...).risks[].id
 * through two tables in public/plan.js: RISK_WHAT and RISK_CHANGE. Forecast
 * decides which risks appear; the page only words them. A risk id Forecast
 * emits with no entry in either table throws a TypeError inside renderPlan
 * ("RISK_WHAT[r.id] is not a function"), and an entry nothing emits is dead
 * text. Nothing pinned the three lists together. This test does.
 *
 * Failure it detects: a Forecast risk id missing from RISK_WHAT or
 * RISK_CHANGE, a page entry with no Forecast producer, or an entry that
 * cannot word an invented risk. Release decision: any failure blocks.
 *
 * Source only (no change to either file); invented risk rows only.
 *   node test/test-risk-text-parity.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

// 1. Forecast's risk ids, read from planPhases' source: every quoted string
// on the `id:` line of each risks.push({...}) in that function.
const fcSrc = fs.readFileSync(path.join(ROOT, 'public', 'forecast.js'), 'utf8');
const start = fcSrc.indexOf('function planPhases(');
check(start >= 0, 'Forecast has planPhases');
const end = fcSrc.indexOf('\n  function ', start + 1);
const phasesSrc = fcSrc.slice(start, end);
const pushes = phasesSrc.split('risks.push({').slice(1);
check(pushes.length >= 1, 'planPhases pushes risks');
const forecastIds = new Set();
for (const block of pushes) {
  const idLine = /\n\s*id: ([^\n]*)/.exec(block);
  check(idLine, 'each pushed risk names its id');
  const ids = [...idLine[1].matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map(m => m[1]);
  check(ids.length >= 1, `the id expression "${idLine[1].trim()}" names its ids as literals`);
  ids.forEach(id => forecastIds.add(id));
}

// 2. The page's two tables, read from plan.js.
const planSrc = fs.readFileSync(path.join(ROOT, 'public', 'plan.js'), 'utf8');
const keysOf = name => {
  const m = new RegExp(`^const ${name} = \\{([\\s\\S]*?)\\n\\};`, 'm').exec(planSrc);
  assert.ok(m, `plan.js has ${name}`);
  return new Set([...m[1].matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*): /gm)].map(x => x[1]));
};
const what = keysOf('RISK_WHAT');
const change = keysOf('RISK_CHANGE');
check(/RISK_WHAT\[r\.id\]\(r\)/.test(planSrc) && /RISK_CHANGE\[r\.id\]\(r\)/.test(planSrc),
  'renderPlan words each Forecast risk through RISK_WHAT[r.id] and RISK_CHANGE[r.id]');

for (const id of forecastIds) {
  check(what.has(id), `RISK_WHAT has an entry for Forecast's risk id '${id}'`);
  check(change.has(id), `RISK_CHANGE has an entry for Forecast's risk id '${id}'`);
}
for (const key of what) check(forecastIds.has(key), `RISK_WHAT entry '${key}' has a Forecast producer`);
for (const key of change) check(forecastIds.has(key), `RISK_CHANGE entry '${key}' has a Forecast producer`);

// 3. Behaviour: each entry words an invented risk without throwing. The
// page is loaded in its own script order in a sandbox.
const mk = id => {
  const el = { id, textContent: '', style: {}, attributes: {}, children: [], addEventListener() {}, setAttribute() {},
    removeAttribute() {}, appendChild(c) { return c; }, append() {}, remove() {}, insertAdjacentHTML() {}, querySelectorAll: () => [] };
  let h = ''; Object.defineProperty(el, 'innerHTML', { get: () => h, set(v) { h = String(v); } });
  return el;
};
const sb = {
  document: { getElementById: mk, createElement: () => mk('c'), createElementNS: () => mk('s'), querySelector: () => null,
    querySelectorAll: () => [], documentElement: mk('html'), body: { scrollHeight: 0 } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {}, matchMedia: () => ({ addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }), requestAnimationFrame() {}, innerWidth: 1200, innerHeight: 800, scrollY: 0,
  console: { log() {}, warn() {}, error() {}, info() {} }, fetch: () => new Promise(() => {}),
};
sb.window = sb; sb.globalThis = sb;
Object.assign(sb, { AbortController, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} });
vm.createContext(sb);
for (const f of ['app.js', 'display-name.js', 'forecast-card-period.js', 'forecast.js', 'forecast-chequing.js', 'balance-history.js',
  'bill-detail.js', 'savings-inventory.js', 'budget-surface.js', 'budget-card-movements.js', 'plan.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), sb, { filename: 'public/' + f });
}
const RISK_WHAT = vm.runInContext('RISK_WHAT', sb);
const RISK_CHANGE = vm.runInContext('RISK_CHANGE', sb);
// One invented risk carrying every field any entry reads.
const invented = { amount: 1234, count: 2, total: 456, date: '2026-12-15', drawn: 300, label: 'Invented card',
  onOrBefore: true, planned: 75, neededBy: '2026-12-01', windowImpact: 900, labels: ['Invented commitment'],
  monthlyInterest: 42, alternative: null };
for (const id of forecastIds) {
  for (const [name, table] of [['RISK_WHAT', RISK_WHAT], ['RISK_CHANGE', RISK_CHANGE]]) {
    let text = null;
    try { text = table[id]({ id, ...invented }); } catch (err) { text = err; }
    check(typeof text === 'string' && text.trim().length > 0, `${name}['${id}'] words an invented risk`);
  }
}

console.log(`risk text parity: ${checks} checks passed (${forecastIds.size} risk ids: ${[...forecastIds].join(', ')})`);
process.exit(0);
