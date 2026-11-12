'use strict';
// The Budget river reads ol[data-bad-timeline]. Past rows stay only when
// data-bad-timeline-coverage is precise or posted-only. Current and future
// rows stay. The gate does not read terms, trust, or amounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const script = name => fs.readFileSync(path.join(root, 'public', name + '.js'), 'utf8');
const stub = () => ({
  innerHTML: '', value: '', dataset: {}, style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  appendChild() {}, replaceChildren() {},
});
const context = vm.createContext({
  Forecast: {}, console, setTimeout, clearTimeout, addEventListener() {},
  document: {
    getElementById: stub, querySelectorAll() { return []; }, addEventListener() {},
    documentElement: { dataset: {}, style: {} },
  },
  localStorage: { getItem() { return null; }, setItem() {} },
  location: { pathname: '/', search: '' },
});
context.window = context;
context.matchMedia = () => ({ matches: false, addEventListener() {} });
vm.runInContext(script('app'), context);
vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
  vm.runInContext(script(name), context);
}

global.document = {
  readyState: 'complete',
  getElementById() { return null; },
  addEventListener() {},
  querySelector() { return null; },
  documentElement: { getAttribute() { return null; }, setAttribute() {}, removeAttribute() {} },
};
global.matchMedia = () => ({ matches: false });
const { keepPastTimelineNode, readBadTimeline, knownTimelineRuns, chooseBadTimeline,
  RiverSpring, riverKeyTarget, riverFlingTarget, badTermNegative } = require('../public/budget-blend.js');

function period(role, start, end, claim, extra) {
  const row = {
    id: start,
    timelineRole: role,
    start,
    end,
    predictedEndingBalanceTerms: {
      identity: 'balance-after-deductions',
      closes: true,
      balanceAfterDeductions: extra && extra.amount != null ? extra.amount : 10,
    },
    balanceAfterDeductionsTrust: extra && extra.trust ? extra.trust : 'estimated',
  };
  if (arguments.length >= 4 && claim !== undefined) {
    row.budgetProgress = { coverage: { remainingClaim: claim } };
  }
  return row;
}

function printed(rows) {
  context.rows = rows;
  return vm.runInContext('badTimelineHtml({payPeriodViews:rows}, false, null)', context);
}

function items(html) {
  const list = html.match(/<ol data-bad-timeline[\s\S]*?<\/ol>/);
  assert.ok(list, 'one timeline list');
  return [...list[0].matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)].map(match => {
    const attrs = {};
    for (const attr of match[1].matchAll(/([^\s=]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
    return {
      tagName: 'LI',
      attrs,
      body: match[2],
      querySelector(selector) {
        if (selector !== '[data-bad-term-amount]') return null;
        const amount = this.body.match(/<span data-bad-term-amount>([\s\S]*?)<\/span>/);
        return amount ? { textContent: amount[1] } : null;
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
    };
  });
}

const blend = fs.readFileSync(path.join(root, 'public', 'budget-blend.js'), 'utf8');
const gateSource = blend.match(/function keepPastTimelineNode\(li\) \{[\s\S]*?\n  \}/)[0];
assert.match(gateSource, /data-bad-timeline-start/);
assert.match(gateSource, /data-bad-timeline-end/);
assert.doesNotMatch(gateSource, /data-bad-timeline-coverage|data-bad-timeline-role/);
assert.doesNotMatch(gateSource, /trust|amount|data-sign|data-bad-term|\b(?:6|26|33)\b/);
assert.match(blend, /keepPastTimelineNode\(node\)/);

// One past row for each coverage value the printer can emit, plus the
// claims it omits. Amounts and trust differ so they cannot be the reason.
const matrixRows = [
  period('past', '2026-01-02', '2026-01-15', 'precise', { amount: 9999.99, trust: 'unavailable' }),
  period('past', '2026-01-16', '2026-01-29', 'posted-only', { amount: -50 }),
  period('past', '2026-01-30', '2026-02-12', 'unavailable', { amount: -1020.09 }),
  period('past', '2026-02-13', '2026-02-26', undefined, { amount: 4000 }),
  period('past', '2026-02-27', '2026-03-12', '', { amount: 4000 }),
  period('past', '2026-03-13', '2026-03-26', null, { amount: 4000 }),
  period('past', '2026-03-27', '2026-04-09', 'full', { amount: 4000 }),
  period('past', '2026-04-10', '2026-04-23', 'Precise', { amount: 1 }),
  period('past', '2026-04-24', '2026-05-07', ' precise', { amount: 1 }),
  period('current', '2026-05-08', '2026-05-21', 'unavailable', { amount: -1 }),
  period('future', '2026-05-22', '2026-06-04', 'unavailable', { amount: 2 }),
  period('current', '2026-06-05', '2026-06-18'),
  period('future', '2026-06-19', '2026-07-02', 'full', { amount: -9 }),
  period('next', '2026-07-03', '2026-07-16', 'unavailable'),
];
const matrix = items(printed(matrixRows));
assert.equal(matrix.length, matrixRows.length, 'printer keeps every row');
const coverageOf = start => {
  const row = matrix.find(item => item.getAttribute('data-bad-timeline-start') === start);
  assert.ok(row, start);
  return row.getAttribute('data-bad-timeline-coverage');
};
assert.equal(coverageOf('2026-01-02'), 'precise');
assert.equal(coverageOf('2026-01-16'), 'posted-only');
assert.equal(coverageOf('2026-01-30'), 'unavailable');
assert.equal(coverageOf('2026-03-27'), 'full');
assert.equal(coverageOf('2026-04-10'), 'Precise');
for (const start of ['2026-02-13', '2026-02-27', '2026-03-13', '2026-06-05']) {
  assert.equal(coverageOf(start), null, start + ' omits coverage');
}
const keptMatrix = matrix.filter(keepPastTimelineNode).map(item => item.getAttribute('data-bad-timeline-start'));
assert.deepEqual(keptMatrix, matrixRows.map(row => row.start), 'every published date remains independently selectable');
assert.equal(matrix.find(item => item.getAttribute('data-bad-timeline-start') === '2026-07-03').getAttribute('data-bad-timeline-role'), 'future');
assert.match(matrix.find(item => item.getAttribute('data-bad-timeline-start') === '2026-01-02').body, /Unavailable<span data-bad-term-amount><\/span>/);
assert.equal(matrix.find(item => item.getAttribute('data-bad-timeline-start') === '2026-01-30').getAttribute('data-sign'), null,
  'withheld historical BAD has no signed claim');

// Oct 8 pay-period calendar. Coverage is the Engine print: Jul 3, Jul 17
// and Jul 31 are unavailable; Aug 14, Aug 28 and Sep 11 are precise.
// Current and future coverage stays unavailable.
const oct8Spec = [
  ['past', '2026-07-03', '2026-07-16', 'unavailable'],
  ['past', '2026-07-17', '2026-07-30', 'unavailable'],
  ['past', '2026-07-31', '2026-08-13', 'unavailable'],
  ['past', '2026-08-14', '2026-08-27', 'precise'],
  ['past', '2026-08-28', '2026-09-10', 'precise'],
  ['past', '2026-09-11', '2026-09-24', 'precise'],
  ['current', '2026-09-25', '2026-10-08', 'unavailable'],
  ['next', '2026-10-09', '2026-10-22', 'unavailable'],
  ['future', '2026-10-23', '2026-11-05', 'unavailable'],
  ['future', '2026-11-06', '2026-11-19', 'unavailable'],
  ['future', '2026-11-20', '2026-12-03', 'unavailable'],
  ['future', '2026-12-04', '2026-12-17', 'unavailable'],
  ['future', '2026-12-18', '2026-12-31', 'unavailable'],
  ['future', '2027-01-01', '2027-01-14', 'unavailable'],
  ['future', '2027-01-15', '2027-01-28', 'unavailable'],
  ['future', '2027-01-29', '2027-02-11', 'unavailable'],
  ['future', '2027-02-12', '2027-02-25', 'unavailable'],
  ['future', '2027-02-26', '2027-03-11', 'unavailable'],
  ['future', '2027-03-12', '2027-03-25', 'unavailable'],
  ['future', '2027-03-26', '2027-04-08', 'unavailable'],
  ['future', '2027-04-09', '2027-04-22', 'unavailable'],
  ['future', '2027-04-23', '2027-05-06', 'unavailable'],
  ['future', '2027-05-07', '2027-05-20', 'unavailable'],
  ['future', '2027-05-21', '2027-06-03', 'unavailable'],
  ['future', '2027-06-04', '2027-06-17', 'unavailable'],
  ['future', '2027-06-18', '2027-07-01', 'unavailable'],
  ['future', '2027-07-02', '2027-07-15', 'unavailable'],
  ['future', '2027-07-16', '2027-07-29', 'unavailable'],
  ['future', '2027-07-30', '2027-08-12', 'unavailable'],
  ['future', '2027-08-13', '2027-08-26', 'unavailable'],
  ['future', '2027-08-27', '2027-09-09', 'unavailable'],
  ['future', '2027-09-10', '2027-09-23', 'unavailable'],
  ['future', '2027-09-24', '2027-10-07', 'unavailable'],
];
assert.equal(oct8Spec.length, 33);
const oct8 = items(printed(oct8Spec.map(row => period(row[0], row[1], row[2], row[3]))));
assert.equal(oct8.length, 33, 'Oct 8 print keeps all 33 rows');
const keptOct8 = oct8.filter(keepPastTimelineNode);
assert.deepEqual(keptOct8.map(item => item.getAttribute('data-bad-timeline-start')), oct8Spec.map(row => row[1]));
assert.deepEqual(keptOct8.map(item => item.getAttribute('data-bad-timeline-role')), [
  ...Array(6).fill('past'), 'current',
  ...Array(26).fill('future'),
]);
assert.deepEqual(
  oct8.filter(item => !keepPastTimelineNode(item)).map(item => item.getAttribute('data-bad-timeline-start')),
  [],
);

// Independent display contract: missing publications break a line, even
// when an omitted past row makes the two known labels visually adjacent.
const gapRows = [
  period('past', '2026-05-08', '2026-05-21', 'precise', { amount: 100 }),
  period('past', '2026-05-22', '2026-06-04', 'unavailable', { amount: 900 }),
  period('past', '2026-06-05', '2026-06-18', 'posted-only', { amount: 50 }),
  period('current', '2026-06-19', '2026-07-02', 'unavailable', { amount: 9000, trust: 'unavailable' }),
  period('future', '2026-07-03', '2026-07-16', undefined, { amount: 0, trust: 'calculated' }),
  period('future', '2026-07-17', '2026-07-30', undefined, { amount: -20 }),
  period('future', '2026-07-31', '2026-08-13', undefined, { amount: 55 }),
  period('future', '2026-08-14', '2026-08-27', undefined, { amount: 40 }),
];
const gapItems = items(printed(gapRows));
// The native producer separately qualifies historical completeness. Exercise
// the adapter on an already-published qualified historical amount; it must
// preserve that amount rather than overriding the native trust by date role.
gapItems[0].body = '<span data-bad-term-amount>$100.00</span>';
gapItems[0].attrs['data-bad-term-trust'] = 'calculated';
gapItems[2].body = '<span data-bad-term-amount>$50.00</span>';
gapItems[2].attrs['data-bad-term-trust'] = 'estimated';
gapItems[6].body = '<span data-bad-term-amount> </span>';
const gapModel = readBadTimeline({ querySelector() { return { children: gapItems }; } });
assert.deepEqual(gapModel.nodes.map(node => node.sourceIndex), [0, 1, 2, 3, 4, 5, 6, 7],
  'adapter retains every original publication position');
assert.deepEqual(gapModel.nodes.map(node => node.magnitude), [100, null, 50, null, 0, -20, null, 40],
  'past Household coverage, unavailable and empty spans have no BAD geometry; printed future zero is known');
assert.deepEqual(gapModel.nodes.slice(0, 3).map(node => [node.label, node.unavailable]),
  [['$100.00', false], ['Unavailable', true], ['$50.00', false]],
  'the adapter preserves qualified historical amounts and unavailable gaps');
assert.deepEqual(knownTimelineRuns(gapModel.nodes), [[0], [2], [4, 5], [7]],
  'only the adjacent published zero and negative value can share a line');
assert.deepEqual(knownTimelineRuns([
  { sourceIndex: 0, magnitude: 100 }, { sourceIndex: 2, magnitude: 50 },
  { sourceIndex: 3, magnitude: 0 },
]), [[0], [1, 2]], 'a removed source row cannot become an interpolated segment');
assert.deepEqual(knownTimelineRuns([
  { sourceIndex: 0, magnitude: null }, { sourceIndex: 1, magnitude: NaN },
  { sourceIndex: 2, magnitude: Infinity },
]), [], 'an entirely unknown timeline has no line');
for (const [label, magnitude] of [
  ['$20.00', 20], ['-$20.00', -20], ['\u2212$20.00', -20], ['$1,020.09', 1020.09],
  ['', null], [' ', null], ['Unavailable', null], ['estimated $20.00', null],
  ['$1,00.00', null], ['20.00', null], ['$20', null], ['$20.00 extra', null],
]) {
  const item = { ...gapItems[4], body: '<span data-bad-term-amount>' + label + '</span>' };
  const model = readBadTimeline({ querySelector() { return { children: [item] }; } });
  assert.equal(model.nodes[0].magnitude, magnitude, 'strict displayed currency geometry for ' + JSON.stringify(label));
}

// Native movement uses every published period, including a past row hidden
// from this strip. Navigate through the real native selection function and
// require the clicked start, not the adjacent visible label, to be selected.
const savedQuery = global.document.querySelector;
let currentStart = '2026-07-03';
let stepCount = 0;
let wheelCount = 0;
let useWheel = false;
context.gapRows = gapRows;
global.document.querySelector = selector => {
  if (selector === '[data-budget-window-progress]') return { getAttribute() { return currentStart; } };
  const wheel = /^\[data-budget-wheel="period"\] \[data-wheel-index="(\d+)"\]$/.exec(selector);
  if (useWheel && wheel) return {
    getAttribute() { return null; },
    click() {
      context.requestedStart = currentStart;
      context.requestedIndex = Number(wheel[1]);
      currentStart = vm.runInContext('payPeriodWheelSelection({payPeriodViews:gapRows}, requestedStart, "period", requestedIndex).period.start', context);
      wheelCount++;
    },
  };
  const step = /^\[data-budget-window-step="(-?1)"\]$/.exec(selector);
  if (!step) return null;
  return {
    getAttribute() { return 'false'; },
    click() {
      context.requestedStart = currentStart;
      context.requestedStep = Number(step[1]);
      currentStart = vm.runInContext('payPeriodMoveSelection({payPeriodViews:gapRows}, requestedStart, requestedStep).period.start', context);
      stepCount++;
    },
  };
};
try {
  chooseBadTimeline(0, gapModel);
  assert.equal(currentStart, '2026-05-08', 'backward click reaches the exact target across a filtered past gap');
  assert.equal(stepCount, 4, 'native navigation still traverses all four source periods');
  stepCount = 0;
  chooseBadTimeline(7, gapModel);
  assert.equal(currentStart, '2026-08-14', 'forward click reaches the exact target across filtered and unavailable rows');
  assert.equal(stepCount, 7);
  useWheel = true;
  chooseBadTimeline(0, gapModel);
  assert.equal(currentStart, '2026-05-08', 'native wheel reaches the exact retained date despite filtered source rows');
  assert.equal(wheelCount, 1, 'one release selects one native period without intermediate remounts');
  assert.equal(stepCount, 7, 'native wheel does not also invoke step controls');
} finally {
  global.document.querySelector = savedQuery;
}

// Prototype navigation limits are positions only, independent of amounts.
assert.equal(riverKeyTarget('Home', 4, 9), 0);
assert.equal(riverKeyTarget('End', 4, 9), 8);
assert.equal(riverKeyTarget('PageUp', 1, 9), 7);
assert.equal(riverKeyTarget('PageDown', 7, 9), 1);
assert.equal(riverKeyTarget('ArrowLeft', 0, 9), 0);
assert.equal(riverKeyTarget('ArrowRight', 8, 9), 8);
assert.equal(riverKeyTarget('ArrowRight', -1, 9), null, 'no fabricated selection when native period is absent');
assert.equal(riverKeyTarget('Enter', 4, 9), null, 'unrelated keys keep their native behavior');
assert.equal(riverFlingTarget(3, 1, 56, 9, true, false), 1);
assert.equal(riverFlingTarget(3, 1, 56, 9, false, false), 6);
assert.equal(riverFlingTarget(3, 100, 56, 9, true, false), 0);
assert.equal(riverFlingTarget(3, -100, 56, 9, true, false), 7, 'fling is bounded to four positions');
assert.equal(riverFlingTarget(3, -100, 56, 9, true, true), 3, 'reduced motion removes fling momentum');
const spring = new RiverSpring(0);
spring.target = 6;
const positions = [];
for (let frame = 0; frame < 300 && !spring.settled; frame++) positions.push(spring.step(1 / 60));
assert.ok(positions.length > 1 && positions.every(Number.isFinite), 'bounded spring progresses through finite display positions');
assert.equal(spring.x, 6);
assert.equal(spring.settled, true, 'animation reaches a stopped state rather than retaining a perpetual RAF');
spring.target = 2;
spring.set(spring.target);
assert.deepEqual([spring.x, spring.v, spring.target], [2, 0, 2], 'instant/reduced-motion positioning leaves no velocity');

// The hero BAD face's negative mark consumes exactly one typed carrier:
// the selected period's own timeline row data-sign. The printer stamps it
// only for a known term < 0, so zero, positive and unavailable rows — and
// any other period's row — must never mark the face. A decoy signed
// element elsewhere in the document (the Q07 step value keys its sign
// off the after-funding figure, a different number) is never consulted:
// the lookup asks for the timeline list and nothing else.
const carrierSource = blend.match(/function badTermNegative\(block\) \{[\s\S]*?\n  \}/)[0];
assert.match(carrierSource, /data-bad-terms-period/);
assert.match(carrierSource, /data-bad-timeline-period/);
assert.match(carrierSource, /data-sign/);
assert.doesNotMatch(carrierSource, /budget-step-value|data-budget-result|textContent|parseFloat|Number\(/);
const carrierRows = items(printed([
  period('current', '2026-08-01', '2026-08-14', 'full', { amount: -50 }),
  period('future', '2026-08-15', '2026-08-28', 'full', { amount: 0 }),
  period('future', '2026-08-29', '2026-09-11', 'full', { amount: 25 }),
  period('past', '2026-07-18', '2026-07-31', 'unavailable', { amount: -1020.09, trust: 'unavailable' }),
]));
const blockFor = id => ({ getAttribute: name => (name === 'data-bad-terms-period' ? id : null) });
const savedCarrierQuery = global.document.querySelector;
try {
  const asked = [];
  global.document.querySelector = selector => {
    asked.push(selector);
    if (selector === 'ol[data-bad-timeline]') return { children: carrierRows };
    return { tagName: 'SPAN', getAttribute: name => (name === 'data-sign' ? 'negative' : null) };
  };
  assert.equal(badTermNegative(blockFor('2026-08-01')), true, 'known negative term marks the face');
  assert.equal(badTermNegative(blockFor('2026-08-15')), false, 'a trusted zero carries no sign and never marks');
  assert.equal(badTermNegative(blockFor('2026-08-29')), false, 'a positive term never marks');
  assert.equal(badTermNegative(blockFor('2026-07-18')), false, 'an unavailable term carries no sign and never marks');
  assert.equal(badTermNegative(blockFor('2026-12-25')), false, 'no matching period row: fail closed');
  assert.equal(badTermNegative(blockFor(null)), false, 'no period on the block: fail closed');
  assert.equal(badTermNegative(null), false, 'no block: fail closed');
  assert.ok(asked.length > 0 && asked.every(selector => selector === 'ol[data-bad-timeline]'),
    'the carrier lookup consults the timeline list only, never the Q07/result sign');
  global.document.querySelector = () => null;
  assert.equal(badTermNegative(blockFor('2026-08-01')), false, 'no timeline list: fail closed');
} finally {
  global.document.querySelector = savedCarrierQuery;
}

console.log('bad timeline river: past dates retain no unqualified BAD; missing/source gaps break geometry; signed currency and zero stay faithful; exact native navigation, bounded spring/fling and keyboard controls pass');
