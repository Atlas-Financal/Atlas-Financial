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
  for (const tx of r.packet.transactions.filter(x => x.id !== r.packet.transactions[0].id)) {
    const cls = F.classifyCurrentPeriodTransaction(tx, r.plan, { packet: r.packet, currentPeriodActuals: r.packet });
    ok(cls.kind === 'held-outflow' && cls.householdSpending === false && cls.needsConfirmation === true,
      `${tx.categoryLabel} row is held, never household spending`, `${cls.kind}/${cls.reason}`);
  }
}

console.log('\n=== period history projection: fails closed on a held term (owner stop pending) ===');
{
  const reseal = candidate => {
    const body = { schema: candidate.schema, capturedAt: candidate.capturedAt, content: candidate.content };
    return { ...body, captureId: History.contract.digest(body) };
  };
  const plain = capture(input({ bills: [{ id: 'hydro', label: 'Invented hydro', amount: 50, frequency: 'monthly', day: 5, confidence: 'confirmed' }] }));
  let projected = null, error = null;
  try { projected = Pg.project(plain); } catch (e) { error = e; }
  ok(projected && projected.schema === Pg.PROJECTION_SCHEMA, 'a period with no held term projects exactly as before', error && error.code);
  const forged = JSON.parse(JSON.stringify(plain));
  const terms = forged.content.publication.predictedEndingBalanceTerms;
  ok(terms && typeof terms === 'object', 'the fixture publishes BAD terms to forge');
  if (terms) {
    terms.heldOutflowSpending = 40;
    let code = null;
    try { Pg.project(reseal(forged)); } catch (e) { code = e.code; }
    ok(code === 'history-projection-invalid', 'a non-zero held term is refused, never silently dropped', String(code));
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
      return { slot: slot ? slot.textContent.replace(/\s+/g, ' ').trim() : null,
        extras: document.querySelectorAll('[data-blend-extra-term]').length,
        note: note ? note.textContent.replace(/\s+/g, ' ').trim() : null };
    }));
    const none = await face([]);
    ok(none.extras === 0 && none.slot === null && none.note === null, 'control: no extra face slot and no To confirm note', JSON.stringify(none));
    const held = await face([mortgage(), incomeDebit()]);
    ok(held.extras === 1 && /To confirm\s*\$450\.00/.test(held.slot || ''), 'held: one face slot, To confirm $450.00, copied from the term', JSON.stringify(held));
    ok(/To confirm \$450\.00 2 payments · not counted as spending/.test(held.note || ''), 'held: the browse note lists 2 payments, not spending', held.note);
    await H.closeBrowser();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll held-outflow checks passed');
  process.exit(failures ? 1 : 0);
})();
