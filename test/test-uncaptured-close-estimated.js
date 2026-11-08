'use strict';
// #818 acceptance 5.7, owner decision on #866 (Dale, 2026-11-07): a completed
// pay period whose close was not captured shows Balance After Deductions as
// "≈ estimated" (reconstructed, not saved) only when every term is known,
// including a fully settled period Forecast qualifies as calculated (#868).
// Any unknown piece is Unavailable. A captured close keeps its native trust.
// Presentation only: the Payday shell, the Today card and the Forecast
// publication are byte-identical to the base (main before this change), and capture never loads page code.
// Invented household only (other-period-target fixture).
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/other-period-target');

const ROOT = path.join(__dirname, '..');
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
function page(planSource) {
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
  const script = name => fs.readFileSync(path.join(ROOT, 'public', name + '.js'), 'utf8');
  vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface']) vm.runInContext(script(name), context);
  vm.runInContext(planSource, context);
  return (expr, vars) => { Object.assign(context, vars); return vm.runInContext(expr, context); };
}
const planSource = fs.readFileSync(path.join(ROOT, 'public/plan.js'), 'utf8');
const call = page(planSource);

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };

// The rule is written once and copied into the two renderers that suites load
// on their own. The copies must be identical, character for character.
const copies = planSource.match(/\/\/ historicalBadState:begin[\s\S]*?\/\/ historicalBadState:end/g) || [];
ok(copies.length === 2 && copies[0] === copies[1], 'the two historicalBadState copies are identical');

const f = fx.build(618.73);
const advice = F.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet });
const views = advice.payPeriodViews;
const current = views.find(v => v.timelineRole === 'current');
assert.ok(current, 'fixture has a current period');
const pastIndex = views.indexOf(current) > 0 ? 0 : views.indexOf(current) + 1;
const base = views[pastIndex];
assert.ok(base.predictedEndingBalanceTerms && Number.isFinite(base.predictedEndingBalanceTerms.balanceAfterDeductions),
  'fixture row publishes closing terms');
const amount = call('money2(x)', { x: base.predictedEndingBalanceTerms.balanceAfterDeductions });

// A fully settled period: Forecast qualifies all three components, which
// main shows as calculated.
const settled = { source: 'Forecast.budgetPeriodProgress', start: base.start, end: base.end,
  coverage: { remainingClaim: 'precise' },
  income: { actual: { amount: 1400, trust: 'calculated', completeness: 'complete', evidence: [] } },
  bills: { actual: { amount: 0, trust: 'calculated', completeness: 'complete', evidence: [] } },
  household: { actual: { amount: 100, trust: 'calculated', completeness: 'complete' } } };
const terms = { incomeTrust: 'calculated', periodBillLoadTrust: 'calculated', budgetHoldTrust: 'calculated', balanceAfterDeductionsTrust: 'calculated' };
const spentRows = (base.householdBudget || []).map(row => row && !row.informational ? { ...row, spent: Number.isFinite(row.spent) ? row.spent : 0 } : row);
const qualified = { ...base, ...terms, timelineRole: 'past', lookback: true, budgetProgress: settled, householdBudget: spentRows };
// Household evidenced and settlement evidenced, but bills not complete:
// main withholds this one.
const evidenced = { ...settled, bills: { actual: { amount: 0, trust: 'calculated', completeness: 'partial', evidence: [] } } };
const gated = { ...qualified, budgetProgress: evidenced };
const captured = row => ({ ...row, capturedClose: { source: 'period-history', kind: 'closing', capturedAt: base.end + 'T19:00:00.000Z',
  asOf: base.end, closingState: 'provisional', planBasis: 'see-baseline-revision', planChangedSinceEarlierCapture: null, earlierCapturedAt: null } });

const render = (row, compact) => call('calendarWaterfallHtml(p,null,null,plan,c)', { p: row, plan: f.plan, c: compact });
const timeline = row => call('badTimelineHtml({ payPeriodViews: [p] }, true, null)', { p: row });
const termTrust = html => (html.match(/data-bad-term="balanceAfterDeductions" data-bad-term-trust="([a-z]+)"/) || [])[1];
const resultTrusts = html => [...html.matchAll(/data-budget-result-trust="([a-z]+)"/g)].map(m => m[1]);
const amountHooks = html => [...html.matchAll(/data-budget-result-amount>([^<]*)</g)].map(m => m[1]);

function expectEstimated(row, label) {
  for (const compact of [true, false]) {
    const html = render(row, compact), where = label + ' (' + (compact ? 'compact' : 'full') + ')';
    ok(/data-bad-historical-reconstructed/.test(html) && !/data-bad-historical-withheld/.test(html), where + ': says reconstructed, not saved');
    ok(resultTrusts(html).length > 0 && resultTrusts(html).every(t => t === 'estimated'), where + ': every result hook is estimated');
    ok(termTrust(html) === 'estimated', where + ': the BAD term row is estimated');
    ok(amountHooks(html).length > 0 && amountHooks(html).every(a => a === amount), where + ': prints Forecast\'s own term, ' + amount);
    ok(/≈/.test(html), where + ': carries the ≈ mark');
  }
  const t = timeline(row);
  ok(/data-bad-term-trust="estimated"/.test(t) && t.includes('<span data-bad-term-amount>' + amount + '</span>')
    && /data-bad-terms-face="balance-after-deductions"/.test(t), label + ': the hidden timeline agrees');
}
function expectUnavailable(row, label) {
  for (const compact of [true, false]) {
    const html = render(row, compact), where = label + ' (' + (compact ? 'compact' : 'full') + ')';
    ok(!/data-bad-historical-reconstructed/.test(html) && /data-bad-historical-withheld/.test(html), where + ': withheld');
    ok(resultTrusts(html).length > 0 && resultTrusts(html).every(t => t === 'unavailable')
      && amountHooks(html).every(a => a === ''), where + ': result is Unavailable with empty amount hooks');
    ok(termTrust(html) === 'unavailable', where + ': the BAD term row is Unavailable');
  }
  const t = timeline(row);
  ok(/data-bad-term-trust="unavailable"/.test(t) && t.includes('<span data-bad-term-amount></span>'), label + ': the hidden timeline is Unavailable');
}

// 1. Uncaptured and fully settled: estimated, never calculated.
expectEstimated(qualified, 'uncaptured, fully settled');
// 2. Uncaptured, household and settlement evidenced: estimated.
expectEstimated(gated, 'uncaptured, evidence-gated');
// 3. Uncaptured with any unknown piece: Unavailable.
const billRow = patch => ({ id: 'invented-bill', date: base.start, actual: null, ...patch });
for (const [label, row] of [
  ['an unknown income term', { ...qualified, incomeTrust: 'unknown' }],
  ['an untrusted bill term', { ...qualified, periodBillLoadTrust: 'untrusted' }],
  ['an unavailable household term', { ...qualified, budgetHoldTrust: 'unavailable' }],
  ['a non-closing terms identity', { ...qualified, predictedEndingBalanceTerms: { ...base.predictedEndingBalanceTerms, closes: false } }],
  ['a missing BAD term', { ...qualified, predictedEndingBalanceTerms: { ...base.predictedEndingBalanceTerms, balanceAfterDeductions: null } }],
  ['unevidenced household spending', { ...gated, budgetProgress: { ...evidenced, household: { actual: { amount: null, trust: 'unavailable', completeness: 'unavailable' } } } }],
  ['partial household spending', { ...gated, budgetProgress: { ...evidenced, household: { actual: { amount: 100, trust: 'calculated', completeness: 'partial' } } } }],
  ['an unavailable coverage window', { ...gated, budgetProgress: { ...evidenced, coverage: { remainingClaim: 'unavailable' } } }],
  ['no period evidence', { ...qualified, budgetProgress: null }],
  ['evidence for another period', { ...qualified, budgetProgress: { ...settled, start: '1999-01-01' } }],
  ['a category with no evidenced spending', { ...gated, householdBudget: spentRows.map((r, i) => i === 0 ? { ...r, spent: null } : r) }],
  ['income not received for the period', { ...gated, budgetProgress: { ...evidenced, income: { actual: { amount: 1200, trust: 'calculated', completeness: 'partial', evidence: [] } } } }],
  ['a bill neither settled nor known unpaid', { ...gated, bills: [billRow({ status: 'still due', settlement: 'unverified' })] }],
  ['a bill with a contested settlement', { ...gated, bills: [billRow({ status: 'planned', settlement: 'not-relied-upon' })] }],
  ['a bill whose date is unknown', { ...gated, bills: [billRow({ status: 'planned', settlement: 'unverified', needsDate: true })] }],
  ['a known-unpaid bill under posted-only coverage', { ...gated, bills: [billRow({ status: 'planned', settlement: 'unverified' })], budgetProgress: { ...evidenced, coverage: { remainingClaim: 'posted-only' } } }],
  // Atlas 6714227624: an unpaid bill is outside Forecast's past-period
  // assigned bills, so the close would read higher by a bill still owed.
  ['a bill known unpaid under precise coverage', { ...gated, bills: [billRow({ status: 'planned', settlement: 'unverified' })] }],
  ['one bill paid and one bill unpaid', { ...gated, bills: [billRow({ status: 'PAID', settlement: 'represented', actual: 50 }), billRow({ id: 'invented-bill-2', status: 'planned', settlement: 'unverified' })] }],
]) expectUnavailable(row, 'uncaptured, ' + label);
// A settled bill keeps the estimate.
expectEstimated({ ...gated, bills: [billRow({ status: 'PAID', settlement: 'represented', actual: 50 })] }, 'uncaptured, a bill paid on the row');
expectEstimated({ ...gated, bills: [billRow({ status: 'still due', settlement: 'unverified' })],
  budgetProgress: { ...evidenced, bills: { actual: { amount: 50, trust: 'calculated', completeness: 'partial', evidence: [{ id: 'invented-bill', date: base.start, actual: 50 }] } } } },
  'uncaptured, a bill settled by a period-evidence entry');

// 3b. Atlas 6714227624, end to end through the acceptance harness's real
// provider-observe → live-plan → Forecast path, then this page's renderer.
// Invented: Sep 25 – Oct 8, payroll 1,400, internet 60 due Sep 28, groceries 70.
// Paid: ≈ estimated 1,400 − 60 − 70 = 1,270. The same world without the
// Sep 28 debit must not print the higher 1,330: it is Unavailable.
{
  const H = require('./acceptance/harness');
  const world = paid => {
    const w = H.baseWorld();
    w.bills = [{ id: 'net', label: 'Invented internet', amount: 60, frequency: 'monthly', day: 28, confidence: 'confirmed', payee: 'Invented net co' }];
    w.transactions = [
      H.lm({ id: 900001, date: '2026-09-25', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
      ...(paid ? [H.lm({ id: 900002, date: '2026-09-28', amount: 60, category: 'Internet', account: 'chequing-a', payee: 'Invented net co' })] : []),
      H.lm({ id: 900003, date: '2026-10-03', amount: 70, category: 'Groceries', payee: 'Invented grocer C' }),
      H.lm({ id: 900004, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ];
    return w;
  };
  const closedRow = paid => {
    if (typeof H.resetCaptures === 'function') H.resetCaptures();
    const { data: d } = H.dataOf(world(paid));
    const a = F.recommend(d.plan, d.meta.asOf, { debts: d.debts || [],
      currentPeriodActuals: d.liveOverlay && d.liveOverlay.currentPeriodActuals });
    return a.payPeriodViews.find(v => v.start === '2026-09-25');
  };
  const paidRow = closedRow(true), unpaidRow = closedRow(false);
  ok(paidRow && paidRow.timelineRole === 'past' && unpaidRow && unpaidRow.timelineRole === 'past', 'harness: Sep 25 – Oct 8 is a completed period');
  for (const compact of [true, false]) {
    const html = call('calendarWaterfallHtml(p,null,null,plan,c)', { p: paidRow, plan: f.plan, c: compact });
    ok(resultTrusts(html).every(t => t === 'estimated') && amountHooks(html).every(a => a === '$1,270.00'),
      'harness, bill paid: ≈ estimated $1,270.00 (' + (compact ? 'compact' : 'full') + ')');
    const unpaid = call('calendarWaterfallHtml(p,null,null,plan,c)', { p: unpaidRow, plan: f.plan, c: compact });
    ok(resultTrusts(unpaid).every(t => t === 'unavailable') && amountHooks(unpaid).every(a => a === '')
      && !unpaid.includes('$1,330.00'), 'harness, bill unpaid: Unavailable, never the higher $1,330.00 (' + (compact ? 'compact' : 'full') + ')');
  }
  ok(/data-bad-term-trust="unavailable"/.test(timeline(unpaidRow)) && !timeline(unpaidRow).includes('1,330'), 'harness, bill unpaid: the hidden timeline is Unavailable');
}

// 4. Captured closes keep their native trust and are never relabelled.
for (const compact of [true, false]) {
  const html = render(captured(qualified), compact), where = 'captured, fully qualified (' + (compact ? 'compact' : 'full') + ')';
  ok(!/data-bad-historical-(reconstructed|withheld)/.test(html), where + ': neither reconstructed nor withheld');
  ok(resultTrusts(html).every(t => t === 'calculated') && termTrust(html) === 'calculated', where + ': keeps native calculated trust');
}
ok(/data-bad-term-trust="calculated"/.test(timeline(captured(qualified))), 'captured, fully qualified: the hidden timeline keeps calculated');
expectUnavailable(captured(gated), 'captured, not qualified (no reconstruction for a captured close)');

// 5. Current and future periods are untouched: identical HTML to the base
// this change was built on. BASE is a pinned ancestor of this change (main
// before it), so the reference never moves and needs no remote-tracking ref.
const BASE = 'b4c55f1a38ddbe0e2716802ab0f926a11059928b';
const mainSource = cp.execFileSync('git', ['show', BASE + ':public/plan.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const mainCall = page(mainSource);
for (const row of views.filter(v => v && v.timelineRole !== 'past' && v.lookback !== true)) {
  for (const compact of [true, false]) {
    const expr = 'calendarWaterfallHtml(p,null,null,plan,c)', vars = { p: row, plan: f.plan, c: compact };
    ok(call(expr, vars) === mainCall(expr, vars), row.timelineRole + ' period ' + row.start + ' renders as on main (' + (compact ? 'compact' : 'full') + ')');
  }
}
const items = html => (html.match(/<li [\s\S]*?<\/li>/g) || []).filter(li => !/data-bad-timeline-role="past"/.test(li));
const mineItems = items(call('badTimelineHtml(a, true, null)', { a: advice }));
ok(mineItems.length > 0 && JSON.stringify(mineItems) === JSON.stringify(items(mainCall('badTimelineHtml(a, true, null)', { a: advice }))),
  'every current and future timeline row is identical to main');

// 6. Decision surfaces: byte-identical to main, and never a reconstruction.
const adviceWith = row => ({ ...advice, payPeriodViews: views.map((v, i) => i === pastIndex ? row : v) });
for (const a of [adviceWith(qualified), adviceWith(gated), adviceWith({ ...qualified, incomeTrust: 'unknown' })]) {
  const sealed = JSON.stringify(a);
  for (const [name, expr] of [
    ['payday instruction shell', 'currentPaydayShellHtml({ advice: a, plan, planPayPeriodId: id })'],
    ['Today cash card', 'budgetTodayCashCardHtml({ advice: a, plan, planPayPeriodId: id })'],
  ]) {
    for (const id of [current.id, base.id]) {
      const vars = { a, plan: f.plan, id };
      const mine = call(expr, vars), theirs = mainCall(expr, vars);
      ok(typeof mine === 'string' && mine === theirs, name + ' is byte-identical to main (' + id + ')');
      ok(!mine.includes('data-bad-historical-reconstructed'), name + ' never prints the reconstruction (' + id + ')');
    }
  }
  ok(JSON.stringify(a) === sealed, 'rendering never rewrites the Forecast publication');
}

// 7. The archive's capture and projection never load page code, so the
// estimated label cannot reach a captured record or the reality check.
const loaded = () => Object.keys(require.cache).map(file => path.relative(ROOT, file).split(path.sep).join('/'));
require('../scripts/private-period-history');
require('../scripts/private-period-history-postgres');
ok(!loaded().some(file => /^public\/(plan|budget-blend|budget-surface|app)\.js$/.test(file)), 'capture and projection load no page renderer');
const { input, capture } = require('./fixtures/private-period-history-input');
const Pg = require('../scripts/private-period-history-postgres');
const record = capture(input({ day: '2030-02-15', kind: 'closing' }));
const projected = Pg.project(record);
ok(projected.content.publication.balanceAfterDeductionsTrust === record.content.publication.balanceAfterDeductionsTrust,
  'a captured close keeps Forecast\'s native trust');
ok(!JSON.stringify(projected).includes('reconstructed'), 'no reconstruction label is captured');

console.log('PASS uncaptured close is estimated only when every term is known: ' + checks + ' checks');
