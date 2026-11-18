'use strict';
/* A savings-linked purchase is counted once when the period's actuals are
 * ready, and when actuals coverage is lost (or one category is withheld) the
 * figures that would need it are withheld rather than published without it.
 * BACKLOG #1323 follow-up, verified 2026-11-18.
 *
 * Why this holds (public/forecast.js):
 *  - the savings-item term is deducted only when spentReady; under lost
 *    coverage it is 0, and the linked charge sits in no category, so neither
 *    the hold nor the item term carries it;
 *  - a linked charge needs a Savings pool, and a pool with an allocation
 *    policy puts the next opening on the S1 seed (current Bills stock less
 *    the remaining household requirement). That seed needs complete
 *    transaction coverage for the stock AND a known spent on every category,
 *    so under lost coverage it is null and the close and next opening are
 *    withheld, never a figure missing the charge.
 * An unlinked category purchase IS counted by the lost-coverage hold
 * (max(plan, known posted)); this test pins that too, so no comment can again
 * claim the two are treated alike.
 *
 * Mutant (recorded on the PR): making the S1 seed non-null under lost coverage
 * (drop the transactionCoverage gate on the stock and the spent-known gate on
 * the remaining budget) publishes a next opening of 80 and fails section 2.
 *
 * Invented data only. `node test/test-savings-item-lost-coverage.js`
 */
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');
const closingInput = require('./fixtures/savings-future-closing-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};

// 1. Harness world: pay 1,400 on Oct 9, Groceries 300 + Restaurants 100
// (hold 400), a 62.40 grocery purchase, a Savings pool, a trip linked by the
// Trip category (106), as of Oct 14. Hand arithmetic for the active close:
// 2,500 opening + 1,400 - 400 hold = 3,500; a linked 200 adds an item term of
// 200 (3,300); an unlinked 200 Restaurants raises that hold to 300 (3,400).
function run(extra, mode) {
  const w = H.baseWorld();
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true }];
  w.savingsPool = { value: 1000 };
  w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
    effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ date: '2026-10-11', amount: 62.4, category: 'Groceries', account: 'chequing-a', payee: 'Invented grocer' }), ...extra];
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  if (mode !== 'ready') {
    packet.transactionCoverage = 'incomplete';
    if (mode === 'one category withheld') {
      packet.coverageExceptCategories = true;
      packet.droppedCategoryRows = [{ date: '2026-10-11', categoryId: 'groceries' }];
    }
  }
  const views = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet }).payPeriodViews;
  const active = views.find(v => v.start === '2026-10-09'), next = views.find(v => v.start === '2026-10-23');
  const linkedRow = packet.transactions.find(t => Number(t.amount) === 200);
  return { active, next, hold: active.budgetHold,
    item: (active.predictedEndingBalanceTerms || {}).savingsItemSpending || 0,
    kind: linkedRow ? F.classifyCurrentPeriodTransaction(linkedRow, data.plan, { packet }).kind : null };
}
const linked = () => H.lm({ date: '2026-10-12', amount: 200, category: 106, account: 'chequing-a', payee: 'Invented outfitter' });
const unlinked = () => H.lm({ date: '2026-10-12', amount: 200, category: 'Restaurants', account: 'chequing-a', payee: 'Invented diner' });

console.log('1. A linked charge: counted once when ready, withheld (never omitted) when coverage is lost');
{
  const control = run([], 'ready'), r = run([linked()], 'ready');
  ok(r.kind === 'savings-item', 'the linked purchase classifies as a savings item', r.kind);
  ok(control.active.plannedPeriodClose === 3500 && r.active.plannedPeriodClose === 3300 && r.item === 200 && r.hold === 400,
    'ready: hold 400, item term 200, close 3,500 - 200 = 3,300', JSON.stringify({ close: r.active.plannedPeriodClose, item: r.item, hold: r.hold }));
  for (const mode of ['coverage lost', 'one category withheld']) {
    const l = run([linked()], mode), u = run([unlinked()], mode);
    ok(l.item === 0 && l.hold === 400, `${mode}: the linked charge is in neither the hold nor the item term`, JSON.stringify({ item: l.item, hold: l.hold }));
    ok(l.active.plannedPeriodClose == null && l.active.balanceAfterDeductions == null,
      `${mode}: the close and Balance After Deductions are withheld, not published without the charge`,
      JSON.stringify({ close: l.active.plannedPeriodClose, bad: l.active.balanceAfterDeductions }));
    ok(!l.next || l.next.opening == null, `${mode}: the next period's opening is withheld`, String(l.next && l.next.opening));
    ok(u.hold === 500, `${mode}: an unlinked 200 purchase IS counted by the hold (max(100, 200) + 300 = 500)`, String(u.hold));
  }
}

// 2. The S1 seed: the incumbent future-closing fixture carries a known next
// opening (80) when actuals are ready; with transaction coverage lost the seed
// is null, so the opening and the active close are withheld.
console.log('\n2. The S1 seed is withheld under lost coverage');
{
  const seed = lost => {
    const x = closingInput();
    if (lost) x.opts.currentPeriodActuals.transactionCoverage = 'incomplete';
    const views = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] }).payPeriodViews
      .filter(v => v.role !== 'lookback');
    return { close: views[0].plannedPeriodClose, opening: views[1].opening, source: views[1].openingSource };
  };
  const ready = seed(false), lost = seed(true);
  ok(ready.opening === 80 && ready.source === 'carry-forward' && ready.close === 80,
    'ready: the next opening is carried (80)', JSON.stringify(ready));
  ok(lost.opening == null && lost.close == null, 'coverage lost: the next opening and the close are withheld', JSON.stringify(lost));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll savings-item lost-coverage checks passed.');
