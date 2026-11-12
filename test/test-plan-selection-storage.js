'use strict';
/* Plan period selection persistence helpers (public/plan.js): the selection
 * is stored per tab in sessionStorage as only { look, periodId }, restored at
 * load, cleared when back on the current period, and every storage access is
 * guarded so a throwing store leaves the current period selected. The page
 * path (reload, unknown id fallback) is proved in browser-plan-selection-reload.js.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label) => { if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };
const src = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8'));
const block = /^const PLAN_SELECTION_KEY[\s\S]*?^\{\n  const restored[\s\S]*?^\}$/m.exec(src);
if (!block) throw new Error('missing plan selection block');

function load(storage) {
  const ctx = { sessionStorage: storage, planLook: 'this-period', planPayPeriodId: null };
  vm.createContext(ctx);
  // planLook / planPayPeriodId are module `let`s in the page; expose them as
  // context globals so the extracted block reads and writes the same names.
  vm.runInContext(block[0].replace(/^const PLAN_SELECTION_KEY/m, 'var PLAN_SELECTION_KEY'), ctx);
  return ctx;
}
const memory = initial => {
  const m = new Map(Object.entries(initial || {}));
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};
const KEY = 'atlas.planSelection.v1';

let st = memory();
let page = load(st);
ok(page.planLook === 'this-period' && page.planPayPeriodId === null, 'nothing stored: current period');
page.planPayPeriodId = 'future-1'; page.planLook = 'this-period'; vm.runInContext('writePlanSelection()', page);
ok(JSON.stringify(JSON.parse(st.m.get(KEY))) === JSON.stringify({ look: 'this-period', periodId: 'future-1' }),
  'writes only look and period id');
page = load(st);
ok(page.planPayPeriodId === 'future-1', 'reload restores a future selection');
page.planPayPeriodId = 'past-1'; vm.runInContext('writePlanSelection()', page);
ok(load(st).planPayPeriodId === 'past-1', 'reload restores a past selection');
page.planPayPeriodId = null; vm.runInContext('writePlanSelection()', page);
ok(!st.m.has(KEY), 'back on the current period clears the stored value');

st = memory({ [KEY]: '{not json' });
ok(load(st).planPayPeriodId === null, 'corrupt value ignored');
st = memory({ [KEY]: JSON.stringify({ look: { a: 1 }, periodId: 5 }) });
page = load(st);
ok(page.planLook === 'this-period' && page.planPayPeriodId === null, 'wrong-typed fields ignored');

const boom = () => { throw new Error('blocked'); };
const throwing = { getItem: boom, setItem: boom, removeItem: boom };
page = load(throwing);
ok(page.planLook === 'this-period' && page.planPayPeriodId === null, 'throwing read renders current period');
page.planPayPeriodId = 'x';
let threw = false;
try { vm.runInContext('writePlanSelection()', page); } catch { threw = true; }
ok(!threw, 'throwing write is swallowed');
const absent = load(undefined);
ok(absent.planPayPeriodId === null, 'missing sessionStorage renders current period');

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nplan selection storage: all pass');
