'use strict';
/* A withheld cash walk is not a verdict. `node test/test-sim-unavailable-guard.js`
 *
 * When Forecast withholds the cash walk (simulate / recommend stamp the shown
 * sim `status: 'unavailable'` and null its low, ending and daily balances, e.g.
 * a sent card minimum whose cash inclusion is unconfirmed), planStatus, mission
 * and nextMove return their existing unavailable shapes with the sim's reason
 * instead of classifying the nulls (`below(null, 500)` is true, so the band read
 * "Tight — $0 on Invalid Date"). The Plan page renders those shapes: the reason,
 * never "." or an empty next-move card, and the page does not throw.
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const REASON = 'Card payment sent; cash inclusion or issuer minimum satisfaction is unconfirmed. Additional cash is unknown.';
const day = (date, balance) => ({ date, balance });
const sim = o => ({ min: day('2026-08-10', 1200), buffer: 500, ending: 4200, end: '2026-11-07', daily: [day('2026-08-10', 1200)], ...o });
const withheld = s => ({ ...s, status: 'unavailable', reason: REASON, min: day(null, null), ending: null,
  daily: s.daily.map(p => ({ ...p, balance: null })) });
const advice = o => ({ weekly: 1250, effectiveFrom: '2026-08-14', gap: null, funding: null, sim: sim(), ...o });
const unavailable = { id: 'unavailable', status: 'unavailable', reason: REASON };

// 1. Forecast: the withheld walk returns each function's unavailable shape.
const low = sim({ min: day('2026-09-01', 300) });            // a real below-buffer low
assert.equal(F.planStatus(advice({ sim: low }), {}).id, 'belowBuffer', 'a numeric low still classifies');
const held = advice({ sim: withheld(low) });
assert.deepEqual(F.planStatus(held, {}), unavailable, 'planStatus: withheld walk is unavailable, not Tight');
assert.deepEqual(F.planStatus(advice(), { sim: withheld(sim()) }), unavailable, 'the shown sim (opts.sim) decides');
assert.deepEqual(F.mission(held, {}, {}), { status: 'unavailable', reason: REASON, parts: [] }, 'mission: unavailable shape');
assert.deepEqual(F.nextMove(data.plan, held, {}), unavailable, 'nextMove: unavailable shape');
// Normal walks are untouched: the same advice without the stamp keeps its verdicts.
assert.equal(F.planStatus(advice(), {}).id, 'onPlan');
assert.notEqual(F.mission(advice({ sim: low }), {}, {}).status, 'unavailable');
assert.notEqual(F.nextMove(data.plan, advice({ sim: low }), {})?.id, 'unavailable');
// The infeasible path on a published walk is unchanged.
const infeasible = { kind: 'card-coverage', date: '2026-10-08', shortfall: null, label: 'Confirm the card-coverage opening.' };
assert.deepEqual(F.planStatus(advice({ mode: 'infeasible', infeasible }), {}),
  { id: 'infeasible', kind: 'card-coverage', date: '2026-10-08', shortfall: null, label: 'Confirm the card-coverage opening.', buffer: 500 });
assert.equal(F.mission(advice({ mode: 'infeasible', infeasible }), {}, {}).parts[0].id, 'infeasible');

// 2. The booted Plan page renders the unavailable mission and next move.
const els = new Map();
const makeEl = id => {
  const el = { id, textContent: '', value: '', checked: false, hidden: false, className: '', style: {}, children: [], attributes: {}, dataset: {},
    addEventListener() {}, setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; }, append(...c) { c.forEach(x => this.appendChild(x)); }, remove() {},
    insertAdjacentHTML(_, html) { this.innerHTML = String(html); }, querySelectorAll: () => [], querySelector: () => null };
  let html = '';
  Object.defineProperty(el, 'innerHTML', { get: () => html, set(v) { html = String(v); } });
  return el;
};
const get = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
const periods = JSON.parse(read('public/periods.json'));
const sandbox = { document: { getElementById: get, createElement: () => makeEl('created'), createElementNS: () => makeEl('svg'),
  querySelector: () => null, querySelectorAll: () => [], documentElement: makeEl('html'), body: { scrollHeight: 0 } },
  addEventListener() {}, matchMedia: () => ({ addEventListener() {} }), getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame() {}, innerWidth: 1200, innerHeight: 800, scrollY: 0, console, AbortController, setTimeout, clearTimeout,
  fetch: url => Promise.resolve({ status: 200, ok: true, json: () => (String(url).includes('periods') ? periods : data) }) };
sandbox.window = sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['public/app.js', 'public/display-name.js', 'public/forecast-card-period.js', 'public/forecast.js', 'public/budget-surface.js', 'public/plan.js']) vm.runInContext(read(file), sandbox, { filename: file });
const Fp = sandbox.Forecast, recommend = Fp.recommend;
const paint = transform => { Fp.recommend = (...a) => transform(recommend(...a)); try { sandbox.renderPlan(data, periods); } finally { Fp.recommend = recommend; } };
setTimeout(() => {
  paint(r => r);
  const normalMission = get('plan-mission').textContent, normalMove = get('nextmove-card').innerHTML;
  assert.ok(normalMission.length > 1 && normalMission !== '.', 'normal mission sentence renders');
  assert.match(normalMove, /class="nm-head"/, 'normal next-move card renders its action');
  // The withheld walk (card-minimum) and the income-uncertainty withholding share one render path.
  for (const [what, transform, reason] of [
    ['withheld cash walk', r => ({ ...r, sim: withheld(r.sim) }), REASON],
    ['income uncertainty', r => ({ ...r, incomeReconciliation: { status: 'unavailable', reason: 'Income is unconfirmed.' } }), 'Income is unconfirmed.']]) {
    paint(transform);
    assert.equal(get('plan-mission').textContent, reason, what + ': mission prints the reason, not "."');
    assert.equal(get('nextmove-card').innerHTML, `<p class="operating-lead" data-operating-plan="unavailable">${reason}</p>`, what + ': next move prints the reason');
    assert.match(get('status-band').innerHTML, new RegExp('^<b>Current plan unavailable.</b> ' + reason.replace(/[.]/g, '\\.') + '$'), what + ': band unavailable');
  }
  paint(r => r);
  assert.equal(get('plan-mission').textContent, normalMission, 'normal mission restored after an unavailable paint');
  assert.equal(get('nextmove-card').innerHTML, normalMove, 'normal next move restored');
  console.log('sim-unavailable guard: planStatus/mission/nextMove unavailable on a withheld walk; normal + infeasible unchanged; page renders reasons (walk + income)');
}, 0);
