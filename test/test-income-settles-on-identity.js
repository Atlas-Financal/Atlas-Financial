'use strict';
/* C3 (acceptance 1.9): an unrelated receipt never settles an expected
 * one-off income, and the expectation and an unlinked receipt are never
 * both counted in the Payday balance.
 *
 * Rules (lead ruling on #857):
 *   1. an identity-rule link on representedActuals settles the expectation;
 *   2. else exactly one posted unlinked Other Income receipt on the same
 *      date for the same amount to the cent settles it (as on main);
 *   3. any other unlinked receipt in its window leaves the expectation
 *      listed at its planned amount, To confirm and not counted;
 *   4. with no unlinked receipt in its window it is counted as planned.
 *
 * Invented figures only. Expectations are hand-derived: payroll 1,000 is
 * the only other income in the Aug 28 - Sep 10 window; the Payday balance
 * is that window's income identity. Expected rebate 200 on Sep 3; as-of
 * Sep 9.
 *
 * `node test/test-income-settles-on-identity.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

// The real Budget income renderer, loaded the way test-other-income.js does.
function loadIncomeHtml() {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const { sourceText } = require('./test-source-text');
  const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  const grab = (src, re, label) => { const m = re.exec(src); if (!m) throw new Error('missing ' + label); return m[0]; };
  const appSrc = read('public/app.js'), planSrc = read('public/plan.js');
  const fn = name => grab(planSrc, new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}$', 'm'), name);
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'), grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'), grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    ...['liveOperatingPlanUnavailable', 'liveOperatingPlanNote', 'paydayGlanceCashNote', 'providerBalanceDate',
      'glanceUpdatedNote', 'glanceSignedMoney', 'glanceMoney', 'glanceLineLabel', 'calendarIncomeHtml'].map(fn),
  ].join('\n');
  return vm.runInNewContext(`${source}\ncalendarIncomeHtml;`, { Forecast: F });
}

const AS_OF = '2026-09-09';
const DATE = '2026-09-03';
const PAYROLL = 1000, REBATE = 200;
const plan = (withRebate = true, rebate = REBATE) => ({
  defaults: { targetBuffer: 0 },
  startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented bills account', value: 2000, class: 'spendable' }] },
  opening: { asOf: AS_OF, representedEvents: [] },
  income: [{ id: 'payroll', frequency: 'biweekly', anchor: '2026-08-14', amount: PAYROLL, confidence: 'confirmed' }]
    .concat(withRebate ? [{ id: 'rebate', label: 'Invented rebate', frequency: 'once', date: DATE, amount: rebate,
      incomeClass: 'other', confidence: 'confirmed' }] : []),
  bills: [], obligations: [], commitments: [], budget: { categories: [] },
});
const tx = (id, date, amount, extra = {}) => Object.assign({ id, date, amount: -amount, isIncome: true,
  categoryLabel: 'other income', displayedPayee: 'Invented payer', accountRole: 'household-cash' }, extra);
const link = (txId, amount) => ({ id: 'rebate', date: DATE, actual: -amount, postedOn: DATE, transactionId: txId });
const packet = (transactions, representedActuals = []) => ({
  schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
  coverageStart: '2026-07-31', coverageThrough: AS_OF, transactionCoverage: 'complete', pendingCoverage: 'complete',
  representedActuals, transactions,
});
const view = (p, pkt) => {
  const advice = F.recommend(p, AS_OF, { targetBuffer: 0, debts: [], currentPeriodActuals: pkt });
  const v = (advice.payPeriodViews || []).find(x => x.start <= DATE && x.end >= DATE);
  const rows = (v && v.income) || [];
  return { v, rows, rebate: rows.find(r => r && r.id === 'rebate') || null,
    receipts: rows.filter(r => r && String(r.id).startsWith('other-income:')) };
};
const held = r => r && r.status !== 'received' && r.actual == null && r.toConfirm === true
  && r.notReliedUpon === true && r.planned === REBATE;

console.log('\n=== control ===');
{
  const base = view(plan(false), packet([]));
  ok(base.v.available === PAYROLL, 'no rebate, no receipt: Payday balance is payroll only', String(base.v.available));
  const none = view(plan(), packet([]));
  ok(none.rebate && none.rebate.status === 'arriving' && !none.rebate.toConfirm
      && none.v.available === PAYROLL + REBATE,
    'rule 4: with no receipt in its window the rebate is counted as planned', String(none.v.available));
}

console.log('\n=== 1. the 1.9 world: an unrelated 50 in the window ===');
{
  const r = view(plan(), packet([tx('gift', '2026-09-01', 50)]));
  ok(held(r.rebate), 'the rebate stays listed at 200, To confirm, not received',
    r.rebate && `${r.rebate.status}/${r.rebate.planned}/${r.rebate.toConfirm}`);
  ok(r.receipts.length === 1 && r.receipts[0].actual === 50, 'the gift counts once as its own row');
  ok(r.v.available === PAYROLL + 50, 'Payday balance excludes the 200 while the gift sits in the window',
    String(r.v.available));
  ok(r.v.otherIncome && r.v.otherIncome.amount === 50, 'Other Income total is the gift only',
    JSON.stringify(r.v.otherIncome && r.v.otherIncome.amount));
}

console.log('\n=== 2. near-miss amount: expected 200, receipt 190, same date ===');
{
  const r = view(plan(), packet([tx('r', DATE, 190)]));
  ok(held(r.rebate), 'the 190 does not settle the 200');
  ok(r.v.available === PAYROLL + 190, 'never double counted: Payday balance is payroll + 190',
    String(r.v.available));
}

console.log('\n=== 3. two exact candidates fall to rule 3 ===');
{
  const r = view(plan(), packet([tx('a', DATE, 200), tx('b', DATE, 200)]));
  ok(held(r.rebate), 'neither exact candidate settles the rebate');
  ok(r.receipts.length === 2 && r.v.available === PAYROLL + 400,
    'each receipt counts once and the rebate is not added', String(r.v.available));
}

console.log('\n=== 4. a pending exact match does not settle ===');
{
  const r = view(plan(), packet([tx('p', DATE, 200, { pending: true })]));
  ok(held(r.rebate), 'the pending 200 does not settle the rebate');
  ok(r.v.available === PAYROLL + REBATE, 'the 200 is counted once, from the pending receipt',
    String(r.v.available));
}

console.log('\n=== 5. one posted exact unlinked match settles, as on main ===');
{
  const r = view(plan(), packet([tx('x', DATE, 200)]));
  ok(r.rebate && r.rebate.status === 'received' && r.rebate.actual === 200 && r.receipts.length === 0,
    'the exact receipt settles the rebate and is not a second row');
  ok(r.v.available === PAYROLL + REBATE, 'counted once', String(r.v.available));
}

console.log('\n=== 6. an identity-rule link wins ===');
{
  const full = view(plan(), packet([tx('r', DATE, 200)], [link('r', 200)]));
  ok(full.rebate && full.rebate.status === 'received' && full.rebate.actual === 200
      && full.rebate.reconciledFrom === 'identity-qualified-receipt' && full.v.available === PAYROLL + REBATE,
    'a linked 200 settles the rebate once', String(full.v.available));
  const part = view(plan(), packet([tx('r', DATE, 120)], [link('r', 120)]));
  ok(part.rebate && part.rebate.status === 'received' && part.rebate.actual === 120 && part.rebate.planned === 200
      && part.receipts.length === 0 && part.v.available === PAYROLL + 120,
    'a linked partial 120 settles at its observed actual (existing rule)', String(part.v.available));
  const other = view(plan(), packet([tx('r', '2026-09-01', 190)], [link('r', 190)]));
  ok(other.rebate && other.rebate.status === 'received' && other.rebate.actual === 190,
    'a link settles even when the amount and date differ');
}

console.log('\n=== 7. invariant: never both the expectation and an unlinked receipt ===');
for (const [label, txs] of [
  ['gift 50', [tx('g', '2026-09-01', 50)]], ['near 190', [tx('g', DATE, 190)]],
  ['near 210', [tx('g', DATE, 210)]], ['other date 200', [tx('g', '2026-09-02', 200)]],
  ['two exact', [tx('a', DATE, 200), tx('b', DATE, 200)]], ['pending exact', [tx('p', DATE, 200, { pending: true })]],
]) {
  const r = view(plan(), packet(txs));
  const receiptSum = txs.reduce((s, t) => s - t.amount, 0);
  ok(r.v.available === PAYROLL + receiptSum, `${label}: Payday balance is payroll + receipts, no expectation`,
    `${r.v.available} vs ${PAYROLL + receiptSum}`);
}

console.log('\n=== 8. the forward walk excludes a held expectation exactly as the Payday balance does ===');
{
  // One settle/hold decision: for each rule-3 shape, the world that holds
  // the expectation publishes the same Payday balance, advice.sim ending,
  // lowest balance and simulated income as the same world with that
  // expectation removed, and the same fixed-spend walk (weekly 100).
  const walkWorld = (asOf, date, amount, payroll, withRebate, txs) => {
    const p = {
      defaults: { targetBuffer: 0 },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented bills account', value: 2000, class: 'spendable' }] },
      opening: { asOf, representedEvents: [] },
      income: [{ id: 'payroll', frequency: 'biweekly', anchor: '2026-08-14', amount: payroll, confidence: 'confirmed' }]
        .concat(withRebate ? [{ id: 'rebate', label: 'Invented rebate', frequency: 'once', date, amount,
          incomeClass: 'other', confidence: 'confirmed' }] : []),
      bills: [], obligations: [], commitments: [], budget: { categories: [] },
    };
    const pkt = { ...packet(txs), observationAsOf: asOf, coverageThrough: asOf };
    const a = F.recommend(p, asOf, { targetBuffer: 0, debts: [], currentPeriodActuals: pkt });
    const v = a.payPeriodViews.find(x => x.start <= date && x.end >= date);
    const fixed = F.simulate(p, asOf, Object.assign({}, a.simOptions, { weeklyVariable: 100 }));
    const r = v && (v.income || []).find(row => row && row.id === 'rebate');
    return { held: !!(r && r.toConfirm), figures: { payday: v && v.available, ending: a.sim.ending,
      lowest: a.sim.min && a.sim.min.balance, income: a.sim.totals && a.sim.totals.income,
      fixedEnding: fixed.ending, fixedLowest: fixed.min && fixed.min.balance } };
  };
  const cases = [
    ['1.9 shape: future 200 beside a 50 gift', '2026-09-02', '2026-09-05', 200, 1000, [tx('g', '2026-09-01', 50)]],
    ['reviewer case: future 340 beside an unrelated 65', '2026-09-02', '2026-09-08', 340, 1375, [tx('g', '2026-09-01', 65)]],
    ['near-miss: future 200 beside a 190 receipt', '2026-09-02', '2026-09-08', 200, 1000, [tx('g', '2026-09-02', 190)]],
    ['pending: future 200 beside a pending 200', '2026-09-02', '2026-09-08', 200, 1000, [tx('p', '2026-09-02', 200, { pending: true })]],
    ['two exact candidates (dated occurrence)', '2026-09-09', DATE, 200, 1000, [tx('a', DATE, 200), tx('b', DATE, 200)]],
    ['pending exact (dated occurrence)', '2026-09-09', DATE, 200, 1000, [tx('p', DATE, 200, { pending: true })]],
  ];
  for (const [label, asOf, date, amount, payroll, txs] of cases) {
    const held = walkWorld(asOf, date, amount, payroll, true, txs);
    const without = walkWorld(asOf, date, amount, payroll, false, txs);
    ok(held.held, `${label}: the expectation is held To confirm`);
    ok(JSON.stringify(held.figures) === JSON.stringify(without.figures),
      `${label}: Payday balance and advice.sim ending/lowest/income equal the world without it`,
      `${JSON.stringify(held.figures)} vs ${JSON.stringify(without.figures)}`);
  }
  // Control (rule 4): with no receipt the walk still relies on the expectation.
  const relied = walkWorld('2026-09-02', '2026-09-05', 200, 1000, true, []);
  const absent = walkWorld('2026-09-02', '2026-09-05', 200, 1000, false, []);
  ok(!relied.held && relied.figures.income === absent.figures.income + 200,
    'rule 4 control: an expectation with no receipt in its window stays in the walk',
    `${relied.figures.income} vs ${absent.figures.income}`);
}

console.log('\n=== 9. a partial identity-linked receipt: row, summary and Total agree ===');
for (const [planned, received] of [[200, 120], [340, 217]]) {
  const r = view(plan(true, planned), packet([tx('r', DATE, received)], [link('r', received)]));
  const money = n => '$' + n.toFixed(2);
  ok(r.v.otherIncome && r.v.otherIncome.amount === received,
    `${planned}/${received}: Other Income total is the receipt, not the plan`,
    JSON.stringify(r.v.otherIncome && r.v.otherIncome.amount));
  ok(r.rebate && r.rebate.planned === planned, `${planned}/${received}: the original plan is kept on the row`);
  ok(r.v.available === PAYROLL + received, `${planned}/${received}: Payday balance is payroll + receipt`,
    String(r.v.available));
  const html = loadIncomeHtml()(r.v);
  const pick = re => (html.match(re) || [])[1];
  const summary = pick(/data-other-income-amount>([^<]*)</);
  const total = pick(/data-other-income-total>([^<]*)</);
  const line = pick(/data-other-income-item="rebate"[\s\S]*?data-income-line-amount>([^<]*)</);
  ok(summary === money(received) && total === money(received) && line === money(received),
    `${planned}/${received}: the rendered row, summary and Total all read ${money(received)}`,
    `${line} / ${summary} / ${total}`);
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
