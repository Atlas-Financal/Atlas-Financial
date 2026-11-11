'use strict';
// Every line in the Budget page's Income drawer prints what the Income
// headline (Forecast period.available) counted for it, so the lines tie to
// the headline. Invented data only; every expected figure is written by hand.
//   (i)   unreceived row, amount 3000 / planned 2800: headline counts 3000,
//         the line must print 3,000 (main printed 2,800).
//   (ii)  received row with unverified settlement, actual 4100: headline
//         counts 4100, the line must print 4,100 marked "not verified"
//         (main printed "Unavailable").
//   (iii) To confirm row of 500: headline counts 0, the line must print
//         "To confirm" with no figure (main printed +$500.00).
//   (iv)  plain received row, actual 2000: unchanged.
// The same four shapes are repeated as Other income items. A mutation check
// re-runs the tie with the main-era drawer selector and requires it to fail.
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
const drawerSum = html => drawerLines(html).reduce((s, l) => s + (cents(l) || 0), 0);

const named = [
  { id: 'inv-bonus', label: 'Invented bonus', date: '2026-10-09', status: 'planned', amount: 3000, planned: 2800, actual: null },
  { id: 'inv-contract', label: 'Invented contract', date: '2026-10-10', status: 'received', settlement: 'unverified', actual: 4100, planned: 4000, amount: 4000 },
  { id: 'inv-refund', label: 'Invented refund', date: '2026-10-11', status: 'unresolved', notReliedUpon: true,
    settlement: 'not-relied-upon', toConfirm: true, actual: null, planned: 500, amount: 500 },
  { id: 'inv-pay', label: 'Invented pay', date: '2026-10-12', status: 'received', actual: 2000, planned: 2000, amount: 2000 },
];
const otherItems = [
  { id: 'o-plan', label: 'Invented gift', date: '2026-10-09', status: 'planned', amount: 30, planned: 28, actual: null, otherIncome: true },
  { id: 'o-unv', label: 'Invented sale', date: '2026-10-10', status: 'received', settlement: 'unverified', actual: 41, planned: 40, amount: 40, otherIncome: true },
  { id: 'o-conf', label: 'Invented credit', date: '2026-10-11', status: 'unresolved', notReliedUpon: true, settlement: 'not-relied-upon',
    toConfirm: true, actual: null, planned: 5, amount: 5, movement: 5, otherIncome: true },
  { id: 'o-recv', label: 'Invented rebate', date: '2026-10-12', status: 'received', actual: 20, planned: 20, amount: 20, otherIncome: true },
];
// Hand-written headline: 3000 + 4100 + 0 + 2000 named; 30 + 41 + 0 + 20 other.
const NAMED_HEADLINE = 910000;
const OTHER_HEADLINE = 9100;
const period = (rows, items) => ({
  income: [...rows, ...items].map(r => ({ ...r })),
  otherIncome: { amount: items.length ? OTHER_HEADLINE / 100 : 0, items: items.map(r => ({ ...r })) },
  available: (NAMED_HEADLINE + (items.length ? OTHER_HEADLINE : 0)) / 100,
});

// Forecast's selector counts what the hand-written headline says.
ok([...named, ...otherItems].reduce((s, r) => s + Math.round(F.calendarIncomeContribution(r) * 100), 0)
  === NAMED_HEADLINE + OTHER_HEADLINE, 'Forecast counts 9,100 named + 91 other for the invented rows');

function assertTies(incomeHtml, tag) {
  const lines = drawerLines(incomeHtml(period(named, [])));
  ok(cents(lines[0]) === 300000, `${tag}: (i) unreceived line prints the counted 3,000, not the 2,800 plan (${lines[0]})`);
  ok(cents(lines[1]) === 410000 && /not verified/.test(lines[1]),
    `${tag}: (ii) unverified received line prints the counted 4,100 marked not verified (${lines[1]})`);
  ok(lines[2] === 'To confirm', `${tag}: (iii) To confirm line prints no figure (${lines[2]})`);
  ok(/data-period-income="inv-refund"[\s\S]*?Expected \$500\.00 · not counted[\s\S]*?data-income-line-amount>To confirm</.test(incomeHtml(period(named, []))),
    `${tag}: (iii) the held expectation stays visible beside the name, labelled not counted`);
  ok(cents(lines[3]) === 200000 && !/not verified/.test(lines[3]), `${tag}: (iv) plain received line prints 2,000 (${lines[3]})`);
  ok(drawerSum(incomeHtml(period(named, []))) === NAMED_HEADLINE, `${tag}: named lines sum to the headline`);
  const withOther = incomeHtml(period(named, otherItems));
  const all = drawerLines(withOther);
  ok(cents(all[4]) === 3000 && cents(all[5]) === 4100 && /not verified/.test(all[5]) && all[6] === 'To confirm' && cents(all[7]) === 2000,
    `${tag}: Other income items print what the total counted (${all.slice(4).join(' | ')})`);
  ok(drawerSum(withOther) === NAMED_HEADLINE + OTHER_HEADLINE, `${tag}: every drawer line sums to the headline`);
  ok(cents((withOther.match(/data-payday-balance-amount>([^<]*)</) || [])[1]) === NAMED_HEADLINE + OTHER_HEADLINE,
    `${tag}: the closing total prints the headline`);
}

const planSource = script('plan');
const head = pageContext(planSource);
assertTies(head, 'head');

// No tag becomes more certain: the not-relied-upon refund keeps its status
// attribute, and the unverified receipt is never printed as a plain amount.
{
  const html = head(period(named, otherItems));
  ok(/data-period-income="inv-refund" data-income-status="not-relied-upon"/.test(html), 'To confirm row keeps not-relied-upon');
  ok(/data-period-income="inv-contract" data-income-status="received"/.test(html), 'unverified receipt keeps its received status attribute');
  ok(/data-other-income-item="o-conf" data-income-status="to-confirm"/.test(html), 'To confirm item keeps to-confirm');
}

// #1085: a null, unobserved Other income still prints Unavailable.
{
  const html = head({ income: [named[3]], otherIncome: { amount: null, items: [], unavailable: true }, available: 2000 });
  ok(/data-other-income-amount="Unavailable"/.test(html) && /data-other-income-unobserved/.test(html),
    'null unobserved Other income still prints Unavailable');
}

// Mutation check: the main-era drawer selector (glanceMoney / row.amount)
// must break the tie.
{
  const mutated = planSource
    .replace('return Forecast.calendarIncomeContribution(row);\n  };', "return glanceMoney(row, 'in');\n  };");
  assert.notEqual(mutated, planSource, 'mutation applied');
  const mut = pageContext(mutated);
  let failed = false;
  try { assertTies(mut, 'mutant'); } catch (_) { failed = true; }
  assert.ok(failed, 'mutation: printing glanceMoney instead of the counted amount must fail the tie');
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
