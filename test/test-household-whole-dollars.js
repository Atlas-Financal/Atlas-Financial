'use strict';
// Household tile whole-dollar face (follow-on to #577; Option B,
// approved after Systems BLOCK 5484530088 rejected the half-away /
// token-reparse head): the face renders each published amount in
// whole dollars, rounded UP once (magnitude ceiling) from its own
// TYPED value — the canonical amount plan.js stamps as a data
// attribute under the same finite-value and trust predicates that
// print the amount. No figure is parsed back out of a printed money
// token. A missing, empty, malformed or non-finite stamp is rejected
// (the side is unknown and its published word stands), never coerced
// to zero. The printed source keeps exact cents: ring geometry, the
// accessible name and the sheet evidence are untouched. These pins
// are the renderer's contract; the browser suites
// (browser-budget-other-ring / -unknown-ring) prove the face uses it
// end to end, and browser-budget-household-total proves the sheet
// keeps exact cents.
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
const { stampedAmount, wholeDollarAmount, wholeDollarAmountDown, pairSideText, replacePrintedAmount } =
  require('../public/budget-blend.js');

for (const [name, fn] of Object.entries({ stampedAmount, wholeDollarAmount, wholeDollarAmountDown, pairSideText, replacePrintedAmount })) {
  assert.equal(typeof fn, 'function', `blend exports ${name} for this suite`);
}

// --- stampedAmount: the fail-closed stamp reader ----------------------
// Only a plain numeric serialization is a value. Everything else —
// missing, empty, malformed, non-finite — is rejected as unknown.
assert.equal(stampedAmount('247.63'), 247.63, 'a canonical amount reads as its number');
assert.equal(stampedAmount('-0.49'), -0.49, 'a negative canonical amount keeps its sign');
assert.equal(stampedAmount('450'), 450, 'an exact-dollar amount reads whole');
assert.equal(stampedAmount('0'), 0, 'a stamped zero is a known zero');
assert.equal(stampedAmount(null), null, 'a missing attribute is unknown, not zero');
assert.equal(stampedAmount(undefined), null, 'an absent attribute is unknown, not zero');
assert.equal(stampedAmount(''), null, 'an empty attribute is unknown, not zero');
assert.equal(stampedAmount('   '), null, 'a blank attribute is unknown, not zero');
assert.equal(stampedAmount('abc'), null, 'a malformed attribute is rejected');
assert.equal(stampedAmount('NaN'), null, 'NaN is rejected');
assert.equal(stampedAmount('Infinity'), null, 'Infinity is rejected');
assert.equal(stampedAmount('-Infinity'), null, '-Infinity is rejected');
assert.equal(stampedAmount('1,234.56'), null, 'a comma-grouped string is not a canonical amount');
assert.equal(stampedAmount('$5.00'), null, 'a printed token is not a canonical amount');
assert.equal(stampedAmount('0x10'), null, 'a hex string is not a canonical amount');
assert.equal(stampedAmount('12.34.56'), null, 'a double-dotted string is rejected');

// --- wholeDollarAmount: magnitude ceiling, sign retained -------------
// Atlas's governing example: any nonzero cents display the next
// dollar up — the face never understates a published amount.
assert.equal(wholeDollarAmount(0.49), '$1', 'positive sub-dollar rounds up to $1');
assert.equal(wholeDollarAmount(562.01), '$563', 'Atlas example: 562.01 displays 563');
assert.equal(wholeDollarAmount(562.50), '$563', 'a half dollar rounds up, not to nearest');
assert.equal(wholeDollarAmount(837.50), '$838', 'published household total rounds up');
assert.equal(wholeDollarAmount(137.26), '$138', '26 cents round up (half-away gave $137)');
assert.equal(wholeDollarAmount(110.37), '$111', '37 cents round up (half-away gave $110)');
assert.equal(wholeDollarAmount(260.37), '$261', 'the third ceiling distinguisher');
assert.equal(wholeDollarAmount(618.73), '$619');
assert.equal(wholeDollarAmount(247.63), '$248', 'the base total actual, from its own value');
// Exact dollars and zero are unchanged in value; the string drops .00.
assert.equal(wholeDollarAmount(450), '$450', 'an exact dollar is unchanged');
assert.equal(wholeDollarAmount(925), '$925');
assert.equal(wholeDollarAmount(0), '$0', 'a known zero renders exactly $0');
// Grouping matches money2 at four figures and above.
assert.equal(wholeDollarAmount(1093.73), '$1,094');
assert.equal(wholeDollarAmount(1509.19), '$1,510', 'ceiling regroups past the thousand');
assert.equal(wholeDollarAmount(12345.67), '$12,346');
// Negatives and refunds: magnitude ceilings, sign retained, and a
// negative zero can never render — any negative cent amount is at
// least one dollar in magnitude.
assert.equal(wholeDollarAmount(-0.49), '−$1', 'a negative sub-dollar rounds up in magnitude, never −$0');
assert.equal(wholeDollarAmount(-0.01), '−$1', 'one negative cent is −$1, never −$0');
assert.equal(wholeDollarAmount(-562.50), '−$563', 'a negative half rounds up in magnitude');
assert.equal(wholeDollarAmount(-187.34), '−$188', 'a negative magnitude ceilings like a positive one');
assert.equal(wholeDollarAmount(-0), '$0', 'negative zero input renders a clean $0');
// Non-values render nothing (callers fail closed before this).
assert.equal(wholeDollarAmount(NaN), null, 'NaN has no rendering');
assert.equal(wholeDollarAmount(Infinity), null, 'Infinity has no rendering');
assert.equal(wholeDollarAmount('247.63'), null, 'a string is not a typed value');

// --- pairSideText: one face pair side ---------------------------------
assert.equal(pairSideText(247.63, '$247.63'), '$248', 'a stamped side renders whole dollars');
assert.equal(pairSideText(137.26, '≈ $137.26'), '≈ $138', 'the estimated qualifier is preserved explicitly');
assert.equal(pairSideText(0, '$0.00'), '$0', 'a stamped zero renders $0 beside its print');
assert.equal(pairSideText(-0.49, '−$0.49'), '−$1', 'a stamped refund renders −$1');
// Unknown sides: the published word passes through verbatim; nothing
// becomes $0 and no cents reach the face.
assert.equal(pairSideText(null, 'Unavailable'), 'Unavailable', 'an unstamped actual stays Unavailable');
assert.equal(pairSideText(null, 'Unknown'), 'Unknown', 'an unstamped total side stays Unknown');
assert.equal(pairSideText(stampedAmount('abc'), '$137.26'), 'Unavailable',
  'a malformed stamp fails closed to the unknown word, not the printed cents and not $0');
assert.equal(pairSideText(stampedAmount(''), '$137.26'), 'Unavailable',
  'an empty stamp fails closed the same way');
assert.equal(pairSideText(null, 'Not yet assigned to a budget category'),
  'Not yet assigned to a budget category', 'a status word with no amount passes through verbatim');

// --- replacePrintedAmount: the totals text-node rewrite ---------------
// The pattern only locates the printed token's span; the figure comes
// from the stamped value.
assert.equal(replacePrintedAmount('$247.63', 247.63), '$248', 'the total actual rewrites from its stamp');
assert.equal(replacePrintedAmount(' $247.63', 247.63), ' $248', 'surrounding text is preserved');
assert.equal(replacePrintedAmount('$925.00', 925), '$925', 'the total planned rewrites from its stamp');
assert.equal(replacePrintedAmount('Unknown', null), 'Unknown', 'no valid stamp: the word stands untouched');
assert.equal(replacePrintedAmount('$247.63', null), '$247.63',
  'no valid stamp: nothing is rewritten, nothing coerced to zero');
assert.equal(replacePrintedAmount('$247.63', stampedAmount('abc')), '$247.63',
  'a malformed stamp rewrites nothing');

// --- Independent total: never a sum of rounded categories -------------
// The displayed category actuals ($111 + $138) sum to $249, while the
// published total ($247.63) renders $248 from its own stamped value.
// A summing implementation cannot satisfy both pins.
const groceries = pairSideText(110.37, '$110.37');
const other = pairSideText(137.26, '$137.26');
const total = replacePrintedAmount('$247.63', stampedAmount('247.63'));
assert.equal(groceries, '$111');
assert.equal(other, '$138');
assert.equal(total, '$248', 'the total rounds from the publication alone');
assert.notEqual(111 + 138, 248, 'the displayed categories deliberately do not sum to the displayed total');

// --- plan.js stamps: same predicates as the prints, inert text --------
// budgetProgressValueHtml (loaded above) stamps the outer ratio span
// only, and its printed strings stay byte-identical cents.
const progressHtml = (pair) => vm.runInContext(`budgetProgressValueHtml(${JSON.stringify(pair)}, 'household')`, context);
const knownPair = {
  actual: { amount: 247.63, completeness: 'complete', trust: 'calculated' },
  planned: { amount: 925, completeness: 'complete', trust: 'calculated' },
};
const knownHtml = progressHtml(knownPair);
assert.match(knownHtml, /<span data-budget-ratio="household" data-budget-actual-amount="247\.63" data-budget-planned-amount="925">/,
  'known sides stamp their canonical amounts on the outer span');
assert.match(knownHtml, /data-budget-ratio-actual>\$247\.63</, 'the printed actual keeps exact cents');
assert.match(knownHtml, /data-budget-ratio-plan>\$925\.00</, 'the printed planned keeps exact cents');
const unknownHtml = progressHtml({ actual: { amount: null, completeness: 'unknown', trust: 'unknown' }, planned: null });
assert.ok(!unknownHtml.includes('data-budget-actual-amount') && !unknownHtml.includes('data-budget-planned-amount'),
  'unknown sides omit their stamps entirely');
assert.match(unknownHtml, /Actual and plan unknown/, 'the unknown print is unchanged');
const negativePlannedHtml = progressHtml({
  actual: { amount: 10.5, completeness: 'complete', trust: 'calculated' },
  planned: { amount: -5, completeness: 'complete', trust: 'calculated' },
});
assert.match(negativePlannedHtml, /data-budget-actual-amount="10\.5"/, 'a known actual stamps');
assert.ok(!negativePlannedHtml.includes('data-budget-planned-amount'),
  'a negative planned omits its stamp, exactly where the print shows Unknown');
assert.match(negativePlannedHtml, /data-budget-ratio-plan><span class="budget-v3-unknown">Unknown/,
  'the strict inner-span pin shape is preserved');
const partialHtml = progressHtml({
  actual: { amount: 0.49, completeness: 'partial', trust: 'estimated' },
  planned: { amount: 85, completeness: 'complete', trust: 'calculated' },
});
assert.match(partialHtml, /data-budget-actual-amount="0\.49"/,
  'a partial estimated actual stamps under the same predicate that prints it');

// --- "left" rounds DOWN, spent rounds UP: the parts never exceed the plan ---
// Headroom is the cautious side when rounded down; an overspend stays on the
// ceiling. Fractional spend $114.70 of $400: $115 spent and $285 left.
assert.equal(wholeDollarAmount(114.70), '$115', 'spent 114.70 rounds up to $115');
assert.equal(wholeDollarAmountDown(400 - 114.70), '$285', 'left 285.30 rounds down to $285, never $286');
assert.equal(wholeDollarAmountDown(285.99), '$285', 'a nearly-whole remainder still rounds down');
assert.equal(wholeDollarAmountDown(0.40), '$0', 'forty cents left shows $0 left, not $1');
assert.equal(wholeDollarAmountDown(0), '$0', 'a known zero stays $0');
assert.equal(wholeDollarAmountDown(450), '$450', 'an exact dollar is unchanged');
assert.equal(wholeDollarAmountDown(1509.19), '$1,509', 'grouping survives the floor');
assert.equal(wholeDollarAmountDown(NaN), null, 'a non-finite value is not a figure');
assert.equal(replacePrintedAmount('$285.30', 285.3, true), '$285', 'the left side prints the floor');
assert.equal(replacePrintedAmount('$285.30', 285.3), '$286', 'the default (over, spent, planned) is still the ceiling');
assert.equal(replacePrintedAmount('$220.01', 220.01, false), '$221', 'over still rounds up');
// Property: for every whole-dollar plan and every cent of spend, the printed
// spent (ceiling) plus the printed left (floor) is exactly the plan, never more.
for (const plan of [1, 100, 400, 925, 1500]) {
  for (let cents = 0; cents <= plan * 100; cents += 7) {
    const spent = cents / 100, left = Math.round((plan - spent) * 100) / 100;
    const shownSpent = Number(wholeDollarAmount(spent).replace(/[$,]/g, ''));
    const shownLeft = Number(wholeDollarAmountDown(left).replace(/[$,]/g, ''));
    assert.ok(shownSpent + shownLeft <= plan, `spent ${spent} + left ${left}: ${shownSpent} + ${shownLeft} must not exceed ${plan}`);
  }
}

console.log('test-household-whole-dollars: all assertions passed');
