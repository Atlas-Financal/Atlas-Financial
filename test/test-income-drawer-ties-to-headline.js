'use strict';
// Every figure the Budget page's Income drawer prints is what the Income
// headline (Forecast period.available) counted for that row, so the printed
// lines tie to the headline; a received row with no qualifying receipt
// evidence prints Unavailable, never a planned fallback. Invented data only; every expected figure is written by hand.
//   (i)   unreceived row, amount 3000 / planned 2800: headline counts 3000,
//         the line must print 3,000 (main printed 2,800).
//   (ii)  received row with unverified settlement, actual 4100: headline
//         counts 4100. Whether the line prints 4,100 (no new wording) or
//         main's "Unavailable" is one named switch,
//         PRINT_UNQUALIFIED_RECEIPT_ACTUAL (shipped false = Unavailable);
//         both settings are tested.
//   (iii) To confirm row of 500: headline counts 0, the line must print
//         one "To confirm $500.00" (main printed +$500.00 as if counted), and
//         state its status once.
//   (iv)  plain received row, actual 2000: unchanged.
//   (v)   received row with no actual, plan 1000: the headline counts 1000,
//         but a received line never prints a planned fallback: Unavailable.
// Lines printing Unavailable are the only gap between drawer and headline.
// Every row shape Forecast holds To confirm prints "To confirm $X" with its
// known amount, including a held receipt with planned 0 (amount on amount).
// The shapes are repeated as Other income items. Mutation checks re-run the
// tie with the main-era drawer selector, and with the received guard removed,
// and require each to fail.
// Integration: every period Forecast publishes for an invented plan ties too.
// `node test/test-income-drawer-ties-to-headline.js`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/other-period-target');

const ROOT = path.join(__dirname, '..');
const script = name => fs.readFileSync(path.join(ROOT, 'public', name + '.js'), 'utf8');
function pageContext(planSource) {
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
  vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface']) vm.runInContext(script(name), context);
  vm.runInContext(planSource, context);
  return period => { context.p = period; return vm.runInContext('calendarIncomeHtml(p)', context); };
}

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const cents = text => {
  const m = String(text).match(/([+−-])?\$([\d,]+\.\d\d)/);
  if (!m) return null;
  const v = Math.round(Number(m[2].replace(/,/g, '')) * 100);
  return m[1] === '−' || m[1] === '-' ? -v : v;
};
const strip = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The printed drawer lines: each named line and Other income item, plus the
// Other income face when it has no item list.
function drawerLines(html) {
  const lines = [];
  const re = /data-income-line-amount>((?:\s*<span[^>]*>[^<]*<\/span>\s*)*[^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(html))) lines.push(strip(m[1]));
  if (!/other-income-txs/.test(html)) {
    const face = html.match(/data-other-income-amount="([^"]*)"/);
    if (face) lines.push(face[1]);
  }
  return lines;
}
// A "To confirm $X" line is the drawer's not-counted form: it counts 0.
const counted = line => (/^To confirm\b/.test(line) ? 0 : (cents(line) || 0));
const drawerSum = html => drawerLines(html).reduce((s, l) => s + counted(l), 0);

const named = [
  { id: 'inv-bonus', label: 'Invented bonus', date: '2026-10-09', status: 'planned', amount: 3000, planned: 2800, actual: null },
  { id: 'inv-contract', label: 'Invented contract', date: '2026-10-10', status: 'received', settlement: 'unverified', actual: 4100, planned: 4000, amount: 4000 },
  { id: 'inv-refund', label: 'Invented refund', date: '2026-10-11', status: 'unresolved', notReliedUpon: true,
    settlement: 'not-relied-upon', toConfirm: true, actual: null, planned: 500, amount: 500 },
  { id: 'inv-pay', label: 'Invented pay', date: '2026-10-12', status: 'received', actual: 2000, planned: 2000, amount: 2000 },
  // (v) received with no actual: the headline counts its 1,000 plan, but a
  // received line never prints a planned fallback.
  { id: 'inv-noactual', label: 'Invented stipend', date: '2026-10-13', status: 'received', actual: null, planned: 1000, amount: 1000 },
];
const otherItems = [
  { id: 'o-plan', label: 'Invented gift', date: '2026-10-09', status: 'planned', amount: 30, planned: 28, actual: null, otherIncome: true },
  { id: 'o-unv', label: 'Invented sale', date: '2026-10-10', status: 'received', settlement: 'unverified', actual: 41, planned: 40, amount: 40, otherIncome: true },
  { id: 'o-conf', label: 'Invented credit', date: '2026-10-11', status: 'unresolved', notReliedUpon: true, settlement: 'not-relied-upon',
    toConfirm: true, actual: null, planned: 5, amount: 5, movement: 5, otherIncome: true },
  { id: 'o-recv', label: 'Invented rebate', date: '2026-10-12', status: 'received', actual: 20, planned: 20, amount: 20, otherIncome: true },
];
// Hand-written headline: 3000 + 4100 + 0 + 2000 + 1000 named; 30 + 41 + 0 + 20 other.
const NAMED_HEADLINE = 1010000;
const OTHER_HEADLINE = 9100;
// Hand-written counted cents of the received rows the drawer may print as
// Unavailable: (ii) 4,100 named and the 41 sale (behind the switch),
// and (v) 1,000 (always Unavailable).
const UNQUALIFIED_ACTUAL = { named: 410000, other: 4100 };
const NO_ACTUAL = 100000;
const period = (rows, items) => ({
  income: [...rows, ...items].map(r => ({ ...r })),
  otherIncome: { amount: items.length ? OTHER_HEADLINE / 100 : 0, items: items.map(r => ({ ...r })) },
  available: (NAMED_HEADLINE + (items.length ? OTHER_HEADLINE : 0)) / 100,
});

// Forecast's selector counts what the hand-written headline says.
ok([...named, ...otherItems].reduce((s, r) => s + Math.round(F.calendarIncomeContribution(r) * 100), 0)
  === NAMED_HEADLINE + OTHER_HEADLINE, 'Forecast counts 10,100 named + 91 other for the invented rows');

// printsActual: the unqualified-receipt switch's setting under test.
function assertTies(incomeHtml, tag, printsActual) {
  const html = incomeHtml(period(named, []));
  const lines = drawerLines(html);
  ok(cents(lines[0]) === 300000, `${tag}: (i) unreceived line prints the counted 3,000, not the 2,800 plan (${lines[0]})`);
  ok(lines[1] === (printsActual ? '+$4,100.00' : 'Unavailable'),
    `${tag}: (ii) unverified received line follows the switch (${lines[1]})`);
  ok(lines[2] === 'To confirm $500.00', `${tag}: (iii) To confirm line prints one "To confirm $500.00" (${lines[2]})`);
  {
    const refund = (html.match(/<div class="operating-line" data-period-income="inv-refund"[\s\S]*?<\/div>/) || [''])[0];
    const text = strip(refund);
    ok((text.match(/to confirm/gi) || []).length === 1 && !/not relied upon|not counted|not verified|≈/i.test(text),
      `${tag}: (iii) the refund row states its status once (${text})`);
  }
  ok(lines[3] === '+$2,000.00', `${tag}: (iv) plain received line prints 2,000 (${lines[3]})`);
  ok(lines[4] === 'Unavailable', `${tag}: (v) received line with no actual prints Unavailable, never its plan (${lines[4]})`);
  // Every printed figure ties; the only gap is the Unavailable received lines.
  const namedGap = NO_ACTUAL + (printsActual ? 0 : UNQUALIFIED_ACTUAL.named);
  ok(drawerSum(html) === NAMED_HEADLINE - namedGap, `${tag}: named lines sum to the headline less the Unavailable received lines`);
  const withOther = incomeHtml(period(named, otherItems));
  const all = drawerLines(withOther);
  ok(cents(all[5]) === 3000 && all[6] === (printsActual ? '$41.00' : 'Unavailable') && all[7] === 'To confirm $5.00' && cents(all[8]) === 2000,
    `${tag}: Other income items print what the total counted (${all.slice(5).join(' | ')})`);
  const otherGap = printsActual ? 0 : UNQUALIFIED_ACTUAL.other;
  ok(drawerSum(withOther) === NAMED_HEADLINE + OTHER_HEADLINE - namedGap - otherGap,
    `${tag}: every printed drawer figure sums to the headline less the Unavailable received lines`);
  ok(cents((withOther.match(/data-payday-balance-amount>([^<]*)</) || [])[1]) === NAMED_HEADLINE + OTHER_HEADLINE,
    `${tag}: the closing total prints the headline`);
}

const DECISION = 'const PRINT_UNQUALIFIED_RECEIPT_ACTUAL = false;';
const planSource = script('plan');
assert.ok(planSource.includes(DECISION), 'the unqualified-receipt switch exists and ships at main behaviour');
checks++;
const head = pageContext(planSource);
assertTies(head, 'head', false);
// The other answer is a one-line change and still ties.
assertTies(pageContext(planSource.replace(DECISION, 'const PRINT_UNQUALIFIED_RECEIPT_ACTUAL = true;')), 'decision=true', true);

// No tag becomes more certain: status attributes are unchanged, and no new
// wording or estimate mark appears.
{
  const html = head(period(named, otherItems));
  ok(/data-period-income="inv-refund" data-income-status="not-relied-upon"/.test(html), 'To confirm row keeps not-relied-upon');
  ok(/data-period-income="inv-contract" data-income-status="received"/.test(html), 'unverified receipt keeps its received status attribute');
  ok(/data-other-income-item="o-conf" data-income-status="to-confirm"/.test(html), 'To confirm item keeps to-confirm');
  const conf = strip((html.match(/<li class="other-income-tx" data-other-income-item="o-conf"[\s\S]*?<\/li>/) || [''])[0]);
  ok((conf.match(/to confirm/gi) || []).length === 1, `To confirm item states its status once (${conf})`);
  ok(!/not verified|not counted|≈/.test(html), 'no new not-verified, not-counted or ≈ wording anywhere in the drawer');
}

// Every row shape Forecast holds To confirm prints "To confirm $X" with its
// known amount, counted 0. Shapes copied from the two places Forecast sets
// toConfirm (public/forecast.js): an expectation held beside an unlinked
// receipt (keeps its plan), and an unlinked receipt held as a possible
// scheduled payment (planned 0, the receipt on amount, movement set).
{
  const heldShapes = [
    ['expectation held beside an unlinked receipt (named)', { id: 'h-exp', label: 'Invented held pay', date: '2026-10-14', status: 'unresolved',
      settlement: 'not-relied-upon', notReliedUpon: true, toConfirm: true, actual: null, remaining: 0, planned: 640, amount: 640 }, '$640.00'],
    ['expectation held beside an unlinked receipt (Other)', { id: 'h-exp-o', label: 'Invented held refund', date: '2026-10-14', status: 'unresolved',
      settlement: 'not-relied-upon', notReliedUpon: true, toConfirm: true, actual: null, remaining: 0, planned: 64, amount: 64, otherIncome: true }, '$64.00'],
    ['receipt held as a possible scheduled payment (Other)', { id: 'h-rcpt', label: 'Invented deposit', date: '2026-10-15', status: 'unresolved',
      settlement: 'not-relied-upon', notReliedUpon: true, toConfirm: true, actual: null, remaining: 0, planned: 0, amount: 75, movement: 75,
      confidence: 'estimated', otherIncome: true }, '$75.00'],
    ['receipt held as a possible scheduled payment (named)', { id: 'h-rcpt-n', label: 'Invented transfer in', date: '2026-10-15', status: 'unresolved',
      settlement: 'not-relied-upon', notReliedUpon: true, toConfirm: true, actual: null, remaining: 0, planned: 0, amount: 75, movement: 75,
      confidence: 'estimated' }, '$75.00'],
  ];
  for (const [name, row, expected] of heldShapes) {
    ok(Math.round(F.calendarIncomeContribution(row) * 100) === 0, `${name}: the headline counts 0`);
    const isOther = row.otherIncome === true;
    const html = head({ income: [row], otherIncome: { amount: 0, items: isOther ? [row] : [] }, available: 0 });
    const lines = drawerLines(html).filter(l => /^To confirm/.test(l));
    ok(lines.length === 1 && lines[0] === 'To confirm ' + expected,
      `${name}: prints one "To confirm ${expected}" (${lines.join(' | ') || 'none'})`);
  }
}

// Mutation: the earlier plan-first face (planned ?? amount) must drop the
// held receipt's amount.
{
  const from = "[row.planned, row.amount]\n      .find(v => typeof v === 'number' && Number.isFinite(v) && v !== 0)";
  assert.ok(planSource.includes(from), 'held-face mutation target exists');
  const mut = pageContext(planSource.replace(from, '(row.planned ?? row.amount) || null'));
  const row = { id: 'h-rcpt', label: 'Invented deposit', date: '2026-10-15', status: 'unresolved', settlement: 'not-relied-upon',
    notReliedUpon: true, toConfirm: true, actual: null, remaining: 0, planned: 0, amount: 75, movement: 75, confidence: 'estimated', otherIncome: true };
  const line = drawerLines(mut({ income: [row], otherIncome: { amount: 0, items: [row] }, available: 0 })).find(l => /^To confirm/.test(l));
  assert.notEqual(line, 'To confirm $75.00', 'mutation must fail: plan-first held face drops the receipt amount');
  checks++;
}

// #1085: a null, unobserved Other income still prints Unavailable.
{
  const html = head({ income: [named[3]], otherIncome: { amount: null, items: [], unavailable: true }, available: 2000 });
  ok(/data-other-income-amount="Unavailable"/.test(html) && /data-other-income-unobserved/.test(html),
    'null unobserved Other income still prints Unavailable');
}

// Mutation checks: each must break an assertion above.
for (const [name, from, to] of [
  ['main-era glanceMoney selector', 'return Forecast.calendarIncomeContribution(row);\n  };', "return glanceMoney(row, 'in');\n  };"],
  ['received row falls back to plan', "    if (row.status === 'received') {", '    if (false) {'],
]) {
  const mutated = planSource.replace(from, to);
  assert.notEqual(mutated, planSource, `mutation applied: ${name}`);
  let failed = false;
  try { assertTies(pageContext(mutated), 'mutant', false); } catch (_) { failed = true; }
  assert.ok(failed, `mutation must fail: ${name}`);
  checks++;
}

// Integration: every period Forecast publishes for an invented plan ties.
{
  const f = fx.build(618.73);
  const views = F.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet }).payPeriodViews;
  let tied = 0;
  for (const v of views) {
    if (v.available == null || v.operatingPlanUnavailable) continue;
    const html = head(v);
    const sum = drawerSum(html);
    // An Other income face reading Unavailable is unknown, not a figure.
    if (drawerLines(html).some(l => l === 'Unavailable' || l === '-')) continue;
    assert.equal(sum, Math.round(v.available * 100), `${v.start}: drawer lines sum to period.available`);
    tied++;
  }
  ok(tied > 0, `Forecast-published periods tie (${tied})`);
}

console.log(`income drawer ties to headline: ${checks} checks passed`);
