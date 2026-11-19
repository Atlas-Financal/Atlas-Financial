'use strict';
/* One home for the linked-bill note's check names (BACKLOG "After 1.0", from
 * the #1267 pre-review).
 *
 * A posted row linked to one bill whose rule rejects it carries
 * linkedBillMisfit.check, which the Budget page prints as "Linked to <bill>
 * but doesn't fit (<check>)". Three places name the checks: the observer
 * emits them (scripts/provider-observe.js linkedBillMisfitIds and its
 * linkedBillFirstFailedCheck order), Forecast passes only the ones in
 * LINKED_BILL_MISFIT_CHECKS, and the page prints only the ones it accepts.
 * A name on one side and not another was silently dropped: the note simply
 * disappeared. Forecast now owns the list and the page reads it; this test
 * keeps all three equal.
 *
 * Failure it detects: a check the observer emits that Forecast or the page
 * drops, a name Forecast or the page accepts that the observer never emits,
 * or a page that keeps its own copy. Release decision: any failure blocks.
 *
 * Invented rows only; no household data.
 *   node test/test-linked-bill-misfit-check-parity.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

// 1. The observer's emitted names, read from its source: the ordered gates of
// linkedBillFirstFailedCheck and every literal `check: '...'` in
// linkedBillMisfitIds.
const observerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'provider-observe.js'), 'utf8');
const body = name => {
  const start = observerSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in provider-observe.js`);
  const next = observerSrc.indexOf('\nfunction ', start + 1);
  return observerSrc.slice(start, next < 0 ? undefined : next);
};
const firstFailed = body('linkedBillFirstFailedCheck');
const orderMatch = /const order = \[([^\]]*)\]/.exec(firstFailed);
check(orderMatch, 'linkedBillFirstFailedCheck names its gates in one order list');
const gateNames = [...orderMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
// Every gate the helper can return is in that list (it returns `failed`,
// assigned only from string literals).
const assigned = [...firstFailed.matchAll(/failed = '([^']+)'/g)].map(m => m[1]);
check(assigned.length > 0 && assigned.every(name => gateNames.includes(name)),
  'every gate linkedBillFirstFailedCheck assigns is in its order list');
const literalChecks = [...body('linkedBillMisfitIds').matchAll(/check: '([^']+)'/g)].map(m => m[1]);
check(literalChecks.length > 0, 'linkedBillMisfitIds emits literal checks besides the first failed gate');
const observerNames = [...new Set([...gateNames, ...literalChecks])].sort();

// 2. Forecast's list, the one home.
const F = require('../public/forecast.js');
check(Array.isArray(F.LINKED_BILL_MISFIT_CHECKS) && Object.isFrozen(F.LINKED_BILL_MISFIT_CHECKS),
  'Forecast exports LINKED_BILL_MISFIT_CHECKS, frozen');
const forecastNames = [...F.LINKED_BILL_MISFIT_CHECKS].sort();
assert.deepEqual(forecastNames, observerNames,
  `Forecast's checks equal the observer's emitted checks (Forecast ${JSON.stringify(forecastNames)}, observer ${JSON.stringify(observerNames)})`);
checks++;

// 3. The page: no copy of its own, and it prints a note for exactly Forecast's
// names. It is loaded in the page's own script order in a sandbox and its
// row renderer (householdBudgetMetric) is driven with invented rows.
const planSrc = fs.readFileSync(path.join(ROOT, 'public', 'plan.js'), 'utf8');
// The note's own code may compare against 'links disagree' and 'category'
// (they change the wording); no other check name may appear there as a
// literal, which is what a private copy of the list would need.
const noteAt = planSrc.indexOf('const misfit = tx.linkedBillMisfit;');
check(noteAt > 0, 'plan.js renders the linked-bill note');
const noteCode = planSrc.slice(noteAt, planSrc.indexOf('const linkedMisfit = ', noteAt));
for (const name of observerNames.filter(n => n !== 'links disagree' && n !== 'category')) {
  check(!noteCode.includes(`'${name}'`), `plan.js keeps no literal '${name}' in the linked-bill note code`);
}
check(/Forecast\.LINKED_BILL_MISFIT_CHECKS\.includes\(misfit\.check\)/.test(planSrc), 'plan.js reads Forecast.LINKED_BILL_MISFIT_CHECKS');

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
// No-op timers: only the row renderer is exercised, nothing is scheduled.
sb.window = sb; sb.globalThis = sb; Object.assign(sb, { AbortController, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} });
vm.createContext(sb);
for (const f of ['app.js', 'display-name.js', 'forecast-card-period.js', 'forecast.js', 'forecast-chequing.js', 'balance-history.js',
  'bill-detail.js', 'savings-inventory.js', 'budget-surface.js', 'budget-card-movements.js', 'plan.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), sb, { filename: 'public/' + f });
}
const metric = vm.runInContext('householdBudgetMetric', sb);
const row = misfit => ({ id: 'tx-1', date: '2026-10-12', amount: 63.21, displayedPayee: 'Invented power co',
  budgetRow: 'other-spending', linkedBillMisfit: misfit });
const noteOf = misfit => {
  const html = metric('Spent', 63.21, { recon: [row(misfit)] });
  const m = /<span class="household-budget-tx-note" data-tx-linked-misfit="[^"]*">([^<]*)<\/span>/.exec(html);
  return m ? m[1] : null;
};
// Expected wording per check, written out here (not read from the page).
const expected = {
  account: "Linked to Invented water but doesn't fit (account)",
  currency: "Linked to Invented water but doesn't fit (currency)",
  direction: "Linked to Invented water but doesn't fit (direction)",
  date: "Linked to Invented water but doesn't fit (date)",
  amount: "Linked to Invented water but doesn't fit (amount)",
  'links disagree': "Linked to Invented water and Invented power but doesn't fit (links disagree)",
  category: "Linked to Invented water but doesn't fit (category &ldquo;Invented utilities&rdquo;)",
};
for (const name of observerNames) {
  const misfit = { id: 'water', label: 'Invented water', check: name,
    ...(name === 'links disagree' ? { otherId: 'power', otherLabel: 'Invented power' } : {}),
    ...(name === 'category' ? { categoryName: 'Invented utilities' } : {}) };
  const note = noteOf(misfit);
  check(note === expected[name], `the page prints the linked-bill note for '${name}' (${JSON.stringify(note)})`);
}
check(noteOf({ id: 'water', label: 'Invented water', check: 'not-a-check' }) === null,
  'the page prints no note for a name outside Forecast\'s list');

console.log(`linked-bill misfit check parity: ${checks} checks passed (${observerNames.length} names: ${observerNames.join(', ')})`);
process.exit(0);
