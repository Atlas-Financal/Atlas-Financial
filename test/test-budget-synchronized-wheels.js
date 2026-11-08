'use strict';
/* Run the production selector and its actual event handlers on synthetic
 * published rows. Real waterfall/trust printing is also exercised by the
 * registered Budget payroll and historical suites. No live household cents. */
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { sourceText } = require('./test-source-text');
const source = sourceText(fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8'));
const css = sourceText(fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8'));
const context = vm.createContext({ escapeHtml: require('./app-escape-html'),
  fmtDate: value => value,
  liveCurrentBalanceHtml: () => '<div data-live-current-balance>cash</div>',
  calendarWaterfallHtml: row => `<article data-proof-row="${row.id}">${JSON.stringify(row)}</article>`,
  periodBillLine: () => '',
});
vm.runInContext(source, context);
// Retain the production timeline composer and wiring; isolate unrelated views.
vm.runInContext(`
  calendarWaterfallHtml = row => '<article data-proof-row="' + row.id + '">' + JSON.stringify(row) + '</article>';
  liveCurrentBalanceHtml = () => '<div data-live-current-balance>cash</div>';
  budgetSurfaceHtml = ctx => payPeriodTimelineHtml(ctx.advice, ctx.planPayPeriodId, null, null, '', null);
  selectedPlanView = advice => advice.defaultView;
`, context);
const row = (id, start, end, role) => Object.freeze({
  id, start, end, rangeLabel: `${start} – ${end}`, timelineRole: role,
  incomeTotal: 1800, periodBillLoad: 300, householdBudgetTotal: 200,
  predictedEndingBalance: 1300,
});
const rows = Object.freeze([
  row('past', '2026-09-11', '2026-09-24', 'past'),
  row('current', '2026-09-25', '2026-10-08', 'current'),
  row('next', '2026-10-09', '2026-10-22', 'next'),
  row('nov-first', '2026-10-23', '2026-11-05', 'future'),
  row('nov-second', '2026-11-06', '2026-11-19', 'future'),
  row('dec', '2026-11-20', '2026-12-03', 'future'),
  row('jan', '2026-12-18', '2027-01-01', 'future'),
]);
const advice = { payPeriodViews: rows, defaultView: { asOf: '2026-09-26' } };
const original = JSON.stringify(advice);
const f = context;
let checks = 0;
function check(label, run) { run(); checks++; console.log('  PASS  ' + label); }
check('initial row is Forecast current, centered in its close month October', () => {
  const s = f.payPeriodSelection(advice, null);
  assert.equal(s.period, rows[1]);
  assert.equal(f.payPeriodCloseMonth(s.period), '2026-10');
  const html = f.payPeriodNavigatorHtml(s);
  assert.match(html, /data-selected-close-month="2026-10"/);
  assert.match(html, /--wheel-slot:36%;--wheel-offset:-4%/);
  assert.match(html, /--wheel-slot:40%;--wheel-offset:-10%/);
});
check('the three dispatched ranges map independently to October, October, November', () => {
  assert.deepEqual(rows.slice(1, 4).map(f.payPeriodCloseMonth), ['2026-10', '2026-10', '2026-11']);
});
check('months come only from published row ends, distinguish years, and retain first row ids', () => {
  const months = f.payPeriodMonths(f.payPeriodSelection(advice, null));
  assert.equal(months.length, 5);
  assert.equal(months[2].id, 'nov-first');
  assert.equal(months[4].key, '2027-01');
  assert.equal(months[4].name, 'January 2027');
});
check('the selected visible month states its Forecast close year across the long horizon', () => {
  for (const [id, month, year] of [['current', 'October', '2026'], ['jan', 'January', '2027']]) {
    const html = f.payPeriodNavigatorHtml(f.payPeriodSelection(advice, id));
    assert.match(html, new RegExp(`aria-current="true"\\s+aria-label="${month} ${year}">${month}<span class="budget-wheel-year">${year}</span>`));
  }
  const repeatedMonth = { payPeriodViews: [rows[1], row('next-year', '2027-09-24', '2027-10-07', 'future')] };
  const html = f.payPeriodNavigatorHtml(f.payPeriodSelection(repeatedMonth, 'next-year'));
  assert.match(html, /data-selected-close-month="2027-10"/);
  assert.match(html, /aria-current="true"\s+aria-label="October 2027">October<span class="budget-wheel-year">2027<\/span>/);
  assert.match(css, /\[aria-current="true"\] \.budget-wheel-year \{ visibility:visible;/);
});
check('entering November selects its first row; selecting October again keeps its second row', () => {
  assert.equal(f.payPeriodWheelSelection(advice, 'next', 'month', 2).period, rows[3]);
  assert.equal(f.payPeriodWheelSelection(advice, 'next', 'month', 1).period, rows[2]);
});
check('both wheels reject bounds, noninteger input, and never wrap', () => {
  for (const kind of ['month', 'period']) {
    for (const index of [-1, 99, 1.1, NaN]) {
      assert.equal(f.payPeriodWheelSelection(advice, 'current', kind, index).period, rows[1]);
    }
  }
});

// Minimal event targets model remounts and pointer capture. Handlers are the
// unmodified wirePlanLookPicker function, not a test reimplementation.
class Track {
  constructor(offset, slot) {
    this.values = { '--wheel-offset': offset, '--wheel-slot': slot };
    this.style = {
      getPropertyValue: key => this.values[key] || '',
      setProperty: (key, value) => { this.values[key] = value; },
    };
    this.classes = new Set();
    this.classList = {
      add: x => this.classes.add(x),
      remove: x => this.classes.delete(x),
      contains: x => this.classes.has(x),
    };
  }
}
class Wheel {
  constructor(kind, offset, slot, width) {
    this.kind = kind; this.handlers = {}; this.track = new Track(offset, slot); this.clientWidth = width;
    this.capture = null;
  }
  getAttribute() { return this.kind; }
  querySelector() { return this.track; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  fire(name, extra = {}) {
    const e = Object.assign({ target: this, isPrimary: true, button: 0, pointerId: 1, clientX: 200, clientY: 20, preventDefault() { this.prevented = true; } }, extra);
    this.handlers[name](e);
    return e;
  }
}
const mount = {
  html: '', wheels: [], focused: null,
  set innerHTML(html) {
    this.html = html;
    const offsets = [...html.matchAll(/--wheel-offset:([^";]+)%/g)].map(m => m[1] + '%');
    const slots = [...html.matchAll(/--wheel-slot:([^";]+)%/g)].map(m => m[1] + '%');
    const width = this.wheelWidth > 0 ? this.wheelWidth : 360;
    this.wheels = [new Wheel('month', offsets[0], slots[0], width), new Wheel('period', offsets[1], slots[1], width)];
  },
  get innerHTML() { return this.html; },
  querySelector(selector) {
    if (selector === '[data-pay-period-swipe]') return this;
    if (/aria-current/.test(selector)) return { focus: () => { this.focused = selector; } };
    return null;
  },
  querySelectorAll(selector) { return selector === '[data-budget-wheel]' ? this.wheels : []; },
};
function load(id) {
  context.id = id;
  vm.runInContext('planPayPeriodId = id;', context);
  mount.innerHTML = f.payPeriodTimelineHtml(advice, id, null, null, '', null);
  f.wirePlanLookPicker(mount, { advice, planLook: 'this-period', planPayPeriodId: id });
}
function selected() { return /data-selected-pay-period="([^"]+)"/.exec(mount.html)[1]; }
function swipe(kind, dx, dy = 0, cancel = false, ms = 0) {
  const wheel = mount.wheels[kind === 'month' ? 0 : 1];
  wheel.fire('pointerdown', { timeStamp: 1000 });
  wheel.fire('pointermove', { clientX: 200 + dx, clientY: 20 + dy, timeStamp: 1000 + ms });
  wheel.fire(cancel ? 'pointercancel' : 'pointerup', { clientX: 200 + dx, clientY: 20 + dy, timeStamp: 1000 + ms });
  return wheel;
}
function tap(kind, index) {
  const button = { getAttribute: () => String(index) };
  mount.wheels[kind === 'month' ? 0 : 1].fire('click', { detail: 1, target: { closest: () => button } });
}
check('one normal period swipe advances exactly one Forecast row', () => {
  load('current');
  const before = mount.html.match(/data-proof-row="current">([^<]+)/)[1];
  swipe('period', -100); assert.equal(selected(), 'next');
  swipe('period', -100); assert.equal(selected(), 'nov-first');
  assert.match(mount.html, /data-selected-close-month="2026-11"/);
  assert.match(mount.html, /aria-current="true"\s+aria-label="November 2026"/);
  assert.equal(mount.wheels[0].track.classes.has('is-moving'), true);
  assert.equal(mount.wheels[1].track.classes.has('is-moving'), true);
  swipe('period', 100); swipe('period', 100);
  assert.equal(selected(), 'current');
  assert.equal(mount.html.match(/data-proof-row="current">([^<]+)/)[1], before);
});
check('touch capture handoff from a child button keeps the drag; loss on the wheel cancels', () => {
  load('current');
  const wheel = mount.wheels[1];
  wheel.fire('pointerdown');
  wheel.fire('pointermove', { clientX: 180 });
  // Browsers implicitly capture touch on the hit button. Its loss bubbles
  // when the wheel explicitly captures the horizontal gesture.
  wheel.fire('lostpointercapture', { target: { tagName: 'BUTTON' } });
  wheel.fire('pointermove', { clientX: 100 });
  wheel.fire('pointerup', { clientX: 100 });
  assert.equal(selected(), 'next');
  load('current');
  const cancelled = mount.wheels[1];
  cancelled.fire('pointerdown');
  cancelled.fire('pointermove', { clientX: 180 });
  cancelled.fire('lostpointercapture');
  cancelled.fire('pointerup', { clientX: 100 });
  assert.equal(selected(), 'current');
});
check('a drag across two period centers snaps to that row and does not flick further', () => {
  load('current');
  swipe('period', -317, 0, false, 30);
  assert.equal(selected(), 'nov-first');
  assert.match(mount.html, /--wheel-offset:-90%/);
});
check('a short flick moves exactly one row; the same distance without speed does not', () => {
  load('current');
  swipe('period', -28, 0, false, 400); assert.equal(selected(), 'current');
  swipe('period', -28, 0, false, 40); assert.equal(selected(), 'next');
});
check('period tap and swipe select the same exact row and body; keyboard focus follows selection', () => {
  load('next'); swipe('period', -100); const html = mount.html;
  load('next'); tap('period', 3); assert.equal(mount.html, html);
  assert.match(mount.focused, /period/);
  assert.match(mount.html, /data-proof-row="nov-first"/);
});
check('the river uses native selection without focusing the hidden wheel', () => {
  load('current'); mount.focused = null;
  const event = mount.wheels[1].fire('budget-period-select', { detail: { index: 2 } });
  assert.equal(event.prevented, true); assert.equal(selected(), 'next');
  assert.equal(mount.focused, null);
  for (const index of [-1, 99, 1.5, '2']) {
    assert.equal(mount.wheels[1].fire('budget-period-select', { detail: { index } }).prevented, undefined);
    assert.equal(selected(), 'next');
  }
  assert.equal(mount.wheels[0].fire('budget-period-select', { detail: { index: 1 } }).prevented, undefined);
  assert.equal(selected(), 'next');
});
check('month tap and swipe select the first November row and synchronize the period center', () => {
  load('next'); swipe('month', -100); const html = mount.html;
  load('next'); tap('month', 2); assert.equal(mount.html, html);
  assert.equal(selected(), 'nov-first');
  assert.match(mount.html, /--wheel-offset:-90%/);
});
check('vertical, subthreshold, cancelled, and nonprimary gestures do not select', () => {
  load('current'); swipe('period', 100, 180); assert.equal(selected(), 'current');
  swipe('period', -43); assert.equal(selected(), 'current');
  swipe('period', -100, 0, true); assert.equal(selected(), 'current');
  const wheel = mount.wheels[1];
  wheel.fire('pointerdown', { isPrimary: false }); wheel.fire('pointerup', { clientX: 0 });
  assert.equal(selected(), 'current');
});
check('keyboard moves one period or month and ignores other keys', () => {
  load('next'); mount.wheels[0].fire('keydown', { key: 'ArrowRight' }); assert.equal(selected(), 'nov-first');
  mount.wheels[1].fire('keydown', { key: 'ArrowRight' }); assert.equal(selected(), 'nov-second');
  mount.wheels[1].fire('keydown', { key: 'ArrowLeft' }); assert.equal(selected(), 'nov-first');
  mount.wheels[1].fire('keydown', { key: 'ArrowUp' }); assert.equal(selected(), 'nov-first');
});
check('actual swipe handlers keep both bounds and suppress post-drag clicks', () => {
  load('past'); const wheel = swipe('period', 100); assert.equal(selected(), 'past');
  wheel.fire('click', { detail: 1, target: { closest: () => ({ getAttribute: () => '1' }) } });
  assert.equal(selected(), 'past');
  load('jan'); swipe('period', -100); assert.equal(selected(), 'jan');
  swipe('month', -100); assert.equal(selected(), 'jan');
});
check('current-only balance and authoritative as-of survive both wheel paths; rows remain immutable', () => {
  load('current'); assert.match(mount.html, /data-live-current-balance/);
  tap('month', 2); assert.doesNotMatch(mount.html, /data-live-current-balance/);
  assert.match(mount.html, /data-household-as-of="2026-09-26"/);
  load('past'); assert.doesNotMatch(mount.html, /data-live-current-balance/);
  assert.equal(JSON.stringify(advice), original);
});
check('wheel inputs use named buttons, selected semantics, reduced motion, and no independent month state', () => {
  assert.match(mount.html, /type="button"/);
  assert.match(mount.html, /tabindex="0" aria-current="true"/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*?\.budget-wheel-track \{ animation:none !important; transition:none;/);
  assert.match(css, /#000 3%, #000 97%/);
  assert.doesNotMatch(css, /#000 8%, #000 92%/);
  assert.match(css, /\.budget-wheel-item\[aria-current="true"\] \{ color:var\(--text-primary\); font-weight:750; opacity:1; \}/);
  assert.match(css, /touch-action:pan-y pinch-zoom/);
  assert.doesNotMatch(source, /let selectedMonth|let planMonth|data-pay-period-step/);
  // AMANDA SLICE 3: the Budget Month view legitimately reprints
  // Forecast.baselineTrajectory months[]. The wheel code must not depend
  // on Road Ahead results — check the source without Slice 3 blocks.
  const sourceWithoutSlice3 = source
    .replace(/\/\* AMANDA SLICE 3 — Month <-> Pay Period consolidated planning view\.[\s\S]*?let budgetTrajectoryCacheKey = null;/, '')
    .replace(/\/\* ------------------------------------------------- AMANDA SLICE 3 ---[\s\S]*?function paydayInstructionShellHtml/, 'function paydayInstructionShellHtml')
    .replace(/\/\* AMANDA SLICE 3 — wire the Month <-> Pay Period toggle[\s\S]*?function wireBudgetGranularity/, 'function wireBudgetGranularity')
    .replace(/\/\/ AMANDA SLICE 3: Month <-> Pay Period granularity toggle[\s\S]*?const granularityToggle/, 'const granularityToggle');
  assert.doesNotMatch(sourceWithoutSlice3, /baselineTrajectory|roadAhead|stage1|stage2|stage3/);
  assert.doesNotMatch(f.payPeriodNavigatorHtml.toString(), /incomeTotal|periodBillLoad|householdBudgetTotal|predictedEndingBalance|Forecast\./);
  assert.doesNotMatch(css, /pay-period-nav-button/);
});
check('a resize after wiring snaps to the Forecast row for the current slot, not the wired width', () => {
  const periodSlot = wheel => wheel.track.style.getPropertyValue('--wheel-slot');
  const half = (width, percent) => width * percent / 100 / 2;
  mount.wheelWidth = 390;
  load('current');
  const period = mount.wheels[1];
  const month = mount.wheels[0];
  assert.equal(periodSlot(period), '40%');
  assert.equal(periodSlot(month), '36%');
  assert.match(mount.html, /data-budget-wheel="period"[\s\S]*style="--wheel-slot:40%/);
  const periodPercent = parseFloat(periodSlot(period));
  const monthPercent = parseFloat(periodSlot(month));
  // 70px crosses half of a 320px period slot (128px) and not a 390px slot (156px).
  assert.ok(70 > half(320, periodPercent) && 70 < half(390, periodPercent));
  period.clientWidth = 320;
  month.clientWidth = 320;
  swipe('period', -70);
  assert.equal(selected(), 'next');
  assert.match(mount.html, /data-proof-row="next"/);

  mount.wheelWidth = 320;
  load('current');
  mount.wheels[1].clientWidth = 390;
  swipe('period', -70);
  assert.equal(selected(), 'current');
  swipe('period', -90);
  assert.equal(selected(), 'next');

  // 64px crosses half of a resized 320px month slot and not the wired 390px slot.
  mount.wheelWidth = 390;
  load('current');
  assert.ok(64 > half(320, monthPercent) && 64 < half(390, monthPercent));
  mount.wheels[0].clientWidth = 320;
  swipe('month', -64);
  assert.equal(selected(), 'nov-first');
  assert.match(mount.html, /data-selected-close-month="2026-11"/);

  // One gesture keeps the width captured at pointerdown if the viewport moves mid-drag.
  mount.wheelWidth = 390;
  load('current');
  const wheel = mount.wheels[1];
  wheel.clientWidth = 320;
  wheel.fire('pointerdown', { timeStamp: 1000 });
  wheel.clientWidth = 900;
  wheel.fire('pointermove', { clientX: 130, clientY: 20, timeStamp: 1000 });
  wheel.fire('pointerup', { clientX: 130, clientY: 20, timeStamp: 1000 });
  assert.equal(selected(), 'next');
  mount.wheelWidth = 0;
});
console.log(`\nALL ${checks} SYNCHRONIZED WHEEL CHECKS PASSED`);
