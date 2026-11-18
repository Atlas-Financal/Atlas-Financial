'use strict';
/* Rank 18 (lead ruling under OD-021): a loan/mortgage payment or reversed
 * income is never household consumption. A Mortgage-labelled debit, or a
 * debit in an income category, that no other owner claims (represented bill,
 * obligation, debt or card payment, transfer) is held To confirm: out of
 * every spending category, Other spending and budget progress, and deducted
 * exactly once from Balance After Deductions and from the planned close as
 * its own named term (the savings-item pattern). Never both, never neither.
 *
 * Invented world only (test/acceptance/harness.js): biweekly salary 1,400
 * received Oct 9, plan Groceries 300 + Eating out 100 (budget hold 400),
 * opening 2,500 on chequing, as-of Oct 14, no bills. Every expected figure
 * is hand arithmetic on those inputs:
 *   control:          BAD 1,400 - 0 - 400 = 1,000; close 2,500 + 1,400 - 0 - 400 = 3,500
 *   400 mortgage:     BAD 1,000 - 400 = 600;       close 3,500 - 400 = 3,100
 *   50 income debit:  BAD 1,000 - 50 = 950;        close 3,500 - 50 = 3,450
 *   both:             BAD 1,000 - 450 = 550;       close 3,500 - 450 = 3,050
 * In every case the budget hold stays 400, Other spending 0 and household
 * budget progress actual 0: the held money is not consumption.
 *
 * Also: a pending held debit still leaves cash (deducted the same), and the
 * private period-history projection fails closed on a non-zero held term
 * (owner stop pending Dale: the field is not in its allowlist yet), while a
 * period with no held term projects exactly as before.
 *
 * `node test/test-held-outflow-not-consumption.js`
 */
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');
const Pg = require('../scripts/private-period-history-postgres');
const History = require('../scripts/private-period-history');
const { input, capture } = require('./fixtures/private-period-history-input');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;

const MORTGAGE = 116;
function world(extra) {
  const w = H.baseWorld();
  w.categories.push({ id: MORTGAGE, name: 'Mortgage' });
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...extra];
  return w;
}
const mortgage = (o = {}) => H.lm({ date: '2026-10-12', amount: 400, category: MORTGAGE, account: 'chequing-a', payee: 'Invented lender', ...o });
const incomeDebit = () => H.lm({ date: '2026-10-13', amount: 50, category: 'Payroll', account: 'chequing-a', payee: 'Invented clawback' });

function run(extra) {
  const w = world(extra);
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  const v = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet })
    .payPeriodViews.find(r => r.start === '2026-10-09');
  return {
    v, plan: data.plan, packet,
    other: (v.householdBudget.find(r => r.id === 'other-spending') || {}).spent || 0,
    progress: v.budgetProgress && v.budgetProgress.household && v.budgetProgress.household.actual
      ? v.budgetProgress.household.actual.amount : null,
  };
}

const control = run([]);
console.log('\n=== control: no held debit ===');
ok(near(control.v.balanceAfterDeductions, 1000), 'BAD 1,400 - 400 = 1,000', String(control.v.balanceAfterDeductions));
ok(near(control.v.plannedPeriodClose, 3500), 'close 2,500 + 1,400 - 400 = 3,500', String(control.v.plannedPeriodClose));
ok(!control.v.heldOutflowsToConfirm && !Object.hasOwn(control.v.predictedEndingBalanceTerms || {}, 'heldOutflowSpending')
  && !Object.hasOwn(control.v.plannedPeriodCloseTerms || {}, 'heldOutflowSpending'), 'nothing held, no held term published');

for (const [name, extra, held, bad, close] of [
  ['a 400 Mortgage-labelled debit, no planned mortgage', [mortgage()], 400, 600, 3100],
  ['the same debit still pending', [mortgage({ pending: true })], 400, 600, 3100],
  ['a 50 debit in an income category (a reversal)', [incomeDebit()], 50, 950, 3450],
  ['both together', [mortgage(), incomeDebit()], 450, 550, 3050],
]) {
  console.log(`\n=== ${name} ===`);
  const r = run(extra);
  const t = r.v.predictedEndingBalanceTerms || {}, c = r.v.plannedPeriodCloseTerms || {};
  ok(near(r.v.balanceAfterDeductions, bad), `BAD ${bad}: deducted once`, String(r.v.balanceAfterDeductions));
  ok(near(t.heldOutflowSpending, held) && t.closes === true, `BAD terms name the held ${held} and close`, JSON.stringify(t));
  ok(near(r.v.plannedPeriodClose, close) && near(c.heldOutflowSpending, held)
    && /-and-held-outflow-spending$/.test(c.identity || ''), `close ${close}: the held ${held} is its own close term`, JSON.stringify(c));
  ok(near(r.v.budgetHold, 400) && near(t.householdBudgetHold, 400), 'the budget hold stays 400: not consumption', String(r.v.budgetHold));
  ok(r.other === 0, 'Other spending is 0', String(r.other));
  ok(r.progress === 0, 'household budget progress actual is 0', String(r.progress));
  const list = r.v.heldOutflowsToConfirm;
  ok(list && near(list.total, held) && list.recon.length === extra.length, `To confirm lists ${extra.length} row(s), total ${held}`,
    JSON.stringify(list && { total: list.total, n: list.recon.length }));
  // One fact: the listed rows (calendarHouseholdBudget) and the deducted term
  // (heldOutflowCycleSpend) are separate walks; they must agree to the cent.
  const listed = list ? Math.round(list.recon.reduce((sum, row) => sum + Number(row.amount) * 100, 0)) : null;
  ok(listed === Math.round(held * 100) && Math.round((t.heldOutflowSpending || 0) * 100) === listed,
    'the listed rows sum to exactly the deducted term', `${listed} vs ${t.heldOutflowSpending}`);
  for (const tx of r.packet.transactions.filter(x => x.id !== r.packet.transactions[0].id)) {
    const cls = F.classifyCurrentPeriodTransaction(tx, r.plan, { packet: r.packet, currentPeriodActuals: r.packet });
    ok(cls.kind === 'held-outflow' && cls.householdSpending === false && cls.needsConfirmation === true,
      `${tx.categoryLabel} row is held, never household spending`, `${cls.kind}/${cls.reason}`);
  }
}

console.log('\n=== a completed period: the listed rows and the deducted term still agree ===');
{
  // As-of Oct 24, Oct 9-22 is a completed (lookback) period. A posted 400
  // and a pending 50 Mortgage debit are both held: listed 400 + 50 = 450 and
  // its term 450, to the cent.
  const w = H.baseWorld('2026-10-24');
  w.categories.push({ id: MORTGAGE, name: 'Mortgage' });
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    mortgage(), mortgage({ date: '2026-10-13', amount: 50, pending: true })];
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  const v = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet })
    .payPeriodViews.find(r => r.start === '2026-10-09');
  const list = v.heldOutflowsToConfirm, t = v.predictedEndingBalanceTerms || {};
  const listed = list ? Math.round(list.recon.reduce((sum, row) => sum + Number(row.amount) * 100, 0)) : null;
  ok(listed === 45000 && near(list.total, 450) && near(t.heldOutflowSpending, 450) && t.closes === true,
    'completed period: rows 400 + 50 = 450 = the published total = the deducted term', JSON.stringify({ listed, total: list && list.total, term: t.heldOutflowSpending }));
}

console.log('\n=== lost coverage: the held row is still deducted once (#1323 review) ===');
{
  // The reviewer's invented world: when the period's actuals are not fully
  // covered, the household hold counts the known posted rows, so on main a
  // held row's twin (Other spending) was carried out of cash. The held term
  // must do the same, or the next period opens 400 too high.
  //   no debit:      next period opens 2,500 + 1,400 - 400 (hold) + ... = 3,000
  //   400 held debit: 3,000 - 400 = 2,600 (as main), hold stays 400.
  const nextOpening = (mode, extra) => {
    const w = world([H.lm({ date: '2026-10-11', amount: 62.4, category: 'Groceries', account: 'chequing-a', payee: 'Invented grocer' }), ...extra]);
    const { data, packet, error } = H.dataOf(w);
    if (error) throw error;
    packet.transactionCoverage = 'incomplete';
    if (mode === 'one category withheld') {
      packet.coverageExceptCategories = true;
      packet.droppedCategoryRows = [{ date: '2026-10-11', categoryId: 'groceries' }];
    }
    const views = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet }).payPeriodViews;
    const active = views.find(r => r.start === '2026-10-09'), next = views.find(r => r.start === '2026-10-23');
    return { opening: next && next.opening, hold: active.budgetHold, held: active.heldOutflowsToConfirm };
  };
  for (const mode of ['coverage lost', 'one category withheld']) {
    const control = nextOpening(mode, []), held = nextOpening(mode, [mortgage()]);
    ok(near(control.opening, 3000), `${mode}, control: next period opens at 3,000`, String(control.opening));
    ok(near(held.opening, 2600), `${mode}: the held 400 is carried out of cash once, next period opens at 2,600 (not 3,000)`, String(held.opening));
    ok(near(held.hold, 400) && held.held && near(held.held.total, 400),
      `${mode}: the hold stays 400 and To confirm deducts the 400`, JSON.stringify({ hold: held.hold, held: held.held && held.held.total }));
  }
}

console.log('\n=== period history projection: a held term is persisted, never dropped (owner decision 2026-11-18) ===');
{
  const reseal = candidate => {
    const body = { schema: candidate.schema, capturedAt: candidate.capturedAt, content: candidate.content };
    return { ...body, captureId: History.contract.digest(body) };
  };
  const plain = capture(input({ bills: [{ id: 'hydro', label: 'Invented hydro', amount: 50, frequency: 'monthly', day: 5, confidence: 'confirmed' }] }));
  let projected = null, error = null;
  try { projected = Pg.project(plain); } catch (e) { error = e; }
  ok(projected && projected.schema === Pg.PROJECTION_SCHEMA, 'a period with no held term projects exactly as before', error && error.code);
  ok(projected && !Object.hasOwn(projected.content.publication.predictedEndingBalanceTerms || {}, 'heldOutflowSpending'),
    'no held term is invented where none was published');
  const forged = JSON.parse(JSON.stringify(plain));
  const terms = forged.content.publication.predictedEndingBalanceTerms;
  ok(terms && typeof terms === 'object', 'the fixture publishes BAD terms to forge');
  if (terms) {
    terms.heldOutflowSpending = 40;
    let kept = null, code = null;
    try { kept = Pg.project(reseal(forged)); } catch (e) { code = e.code; }
    ok(kept && kept.content.publication.predictedEndingBalanceTerms.heldOutflowSpending === 40,
      'a non-zero held term is persisted as published, never silently dropped', String(code));
  }
}

function hasBrowser() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}
(async () => {
  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('\n  SKIP  page cases: Playwright Chromium is not available here');
  } else {
    console.log('\n=== page: the face shows To confirm only when a held term is published ===');
    const face = async extra => H.withBudget(world(extra), async p => p.page.evaluate(() => {
      const slot = document.querySelector('[data-blend-extra-term="heldOutflowSpending"]');
      const note = document.querySelector('[data-budget-held-outflows-browse]');
      const split = [...document.querySelectorAll('.blend-split > i')].map(i => ({ cls: i.className,
        term: i.getAttribute('data-blend-split-term'), w: parseFloat(i.style.getPropertyValue('--w')) }));
      return { slot: slot ? slot.textContent.replace(/\s+/g, ' ').trim() : null, split,
        extras: document.querySelectorAll('[data-blend-extra-term]').length,
        note: note ? note.textContent.replace(/\s+/g, ' ').trim() : null };
    }));
    const none = await face([]);
    ok(none.extras === 0 && none.slot === null && none.note === null, 'control: no extra face slot and no To confirm note', JSON.stringify(none));
    const held = await face([mortgage(), incomeDebit()]);
    ok(held.extras === 1 && /To confirm\s*\$450\.00/.test(held.slot || ''), 'held: one face slot, To confirm $450.00, copied from the term', JSON.stringify(held));
    ok(/To confirm \$450\.00 2 payments · not counted as spending/.test(held.note || ''), 'held: the browse note lists 2 payments, not spending', held.note);
    // Split bar: hand arithmetic on the invented world. Income 1,400; bills 0;
    // household 400 (the hold); To confirm 450; BAD 1,400 - 0 - 400 - 450 = 550.
    // Shares of 1,400: household 28.57%, To confirm 32.14%, BAD 39.29%.
    const share = (list, cls) => (list.find(seg => seg.cls === cls) || {}).w;
    ok(none.split.every(seg => seg.cls !== 's-extra') && none.split.length === 3,
      'control: the split bar has only bills, household and BAD', JSON.stringify(none.split));
    const extra = held.split.filter(seg => seg.cls === 's-extra');
    ok(extra.length === 1 && extra[0].term === 'heldOutflowSpending' && Math.abs(extra[0].w - 32.14) < 0.01,
      'held: the split bar carries To confirm as its own segment at 450 / 1,400 = 32.14%', JSON.stringify(held.split));
    ok(Math.abs(share(held.split, 's-house') - 28.57) < 0.01 && Math.abs(share(held.split, 's-bad') - 39.29) < 0.01,
      'held: household 28.57% and BAD 39.29%, so the shares match the printed terms', JSON.stringify(held.split));
    ok(held.split.map(seg => seg.cls).join(',') === 's-bills,s-house,s-extra,s-bad', 'held: the segment sits between household and BAD');
    await H.closeBrowser();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll held-outflow checks passed');
  process.exit(failures ? 1 : 0);
})();
