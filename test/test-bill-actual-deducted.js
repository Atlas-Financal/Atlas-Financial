'use strict';
// Finding 6 (#821 finish-line audit 6788704527): once a paid bill's observed
// actual is known, the payday plan deducts what actually left, once, and the
// page's bill totals agree. An actual below the plan keeps the plan (a
// cheaper bill and a partial payment look the same, #962 6.4/6.17). Unknown
// stays withheld. Invented household only (test/fixtures/budget-surface-data.js):
// a hydro bill planned at 120, paid on Aug 18 through the real observer,
// overlay and Forecast, and printed through the real Budget page VM harness.
//
// Independent proof: every expected figure is hand arithmetic from the
// invented inputs (planned bills 1400 + 120 + 60 + 85; the paid amount), or
// a comparison with the run where hydro is still unpaid, a path that never
// reads an observed actual. No figure is checked against itself.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Fixture = require('./fixtures/budget-surface-data');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast');

let checks = 0;
const eq = (actual, expected, label) => { assert.deepStrictEqual(actual, expected, label); checks++; };
const quiet = fn => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };
const cents = n => Math.round(n * 100);

const rendererFile = path.join(__dirname, 'test-atlas-077-malformed-amounts.js');
const marker = 'const budgetPage = createBudgetPage();';
const harness = fs.readFileSync(rendererFile, 'utf8');
eq(harness.includes(marker), true, 'Budget VM harness marker present');
const renderer = new Module(rendererFile, module); renderer.filename = rendererFile;
renderer.paths = Module._nodeModulePaths(__dirname);
renderer._compile(harness.split(marker)[0] + '\nmodule.exports = { createBudgetPage, strip };', rendererFile);
const page = renderer.exports.createBudgetPage();

const PLANNED = { mortgage: 1400, hydro: 120, 'card-minimum': 60, internet: 85 };
function run({ paid = null, hydroAmount, pending = false } = {}) {
  const identity = structuredClone(Fixture.identity);
  identity.rules.push({ eventId: 'hydro', payeePattern: 'Synthetic hydro', atlasAccountId: 'chequing-a', direction: 'debit' });
  const payload = Fixture.payload();
  if (paid != null) payload.transactions.push({ id: 92100, account_id: 1001, date: '2026-08-18', amount: paid,
    currency: 'cad', payee: 'Synthetic hydro', category_id: 16, is_pending: pending, status: pending ? 'pending' : 'cleared' });
  const canonical = Fixture.canonical();
  if (hydroAmount !== undefined) canonical.plan.bills.find(b => b.id === 'hydro').amount = hydroAmount;
  const data = quiet(() => Live.fromObservation({ data: canonical, payload, accountMap: Fixture.map, identity }).data);
  const view = F.recommend(data.plan, data.meta.asOf, { debts: data.debts, extraFacilities: data.revolvingExtra,
    currentPeriodActuals: data.liveOverlay.currentPeriodActuals, operatingPlan: data.liveOverlay.operatingPlan }).defaultView;
  const period = view.calendarPeriods[0];
  const hydro = period.bills.find(b => b.id === 'hydro');
  const text = quiet(() => renderer.exports.strip(page.render(data)));
  return { data, view, period, hydro, text };
}

const unpaid = run();
eq([unpaid.hydro.status === 'PAID', unpaid.hydro.planned], [false, 120], 'reference: hydro planned 120 and not yet paid');
eq(cents(unpaid.period.periodBillLoad), cents(1400 + 120 + 60 + 85), 'reference load is the hand sum of planned bills');

// 1. Overpaid: the plan deducts what actually left, once.
const over = run({ paid: 150 });
eq([over.hydro.status, over.hydro.actual], ['PAID', 150], 'overpaid: hydro observed paid at 150');
eq(cents(over.period.periodBillLoad), cents(1400 + 150 + 60 + 85), 'overpaid: the bill load deducts the observed 150, not the planned 120');
eq(cents(unpaid.period.balanceAfterDeductions - over.period.balanceAfterDeductions), cents(150 - 120),
  'overpaid: Balance After Deductions falls by exactly the 30 excess (deducted once, never twice)');
eq(cents(unpaid.period.plannedPeriodClose - over.period.plannedPeriodClose), cents(150 - 120),
  'overpaid: the cash close from the period opening deducts the same 30 once');

// 2. Exact: nothing moves against the unpaid reference.
const exact = run({ paid: 120 });
eq([exact.hydro.status, exact.hydro.actual], ['PAID', 120], 'exact: hydro observed paid at 120');
eq(cents(exact.period.balanceAfterDeductions), cents(unpaid.period.balanceAfterDeductions), 'exact: Balance After Deductions unchanged');
eq(cents(exact.period.periodBillLoad), cents(unpaid.period.periodBillLoad), 'exact: bill load unchanged');

// 3. Underpaid: the plan keeps the planned amount (cautious; #962 6.4/6.17).
const under = run({ paid: 90 });
eq([under.hydro.status, under.hydro.actual], ['PAID', 90], 'underpaid: hydro observed paid at 90');
eq(cents(under.period.balanceAfterDeductions), cents(unpaid.period.balanceAfterDeductions),
  'underpaid: Balance After Deductions is not raised on evidence that may be a partial payment');
eq(cents(under.period.periodBillLoad), cents(unpaid.period.periodBillLoad), 'underpaid: bill load keeps the planned 120');

// 4. The page's totals agree with the deduction (the finding's two-totals symptom).
for (const [label, r] of [['overpaid', over], ['exact', exact], ['unpaid', unpaid]]) {
  eq(cents(r.period.totalBillsThisPeriod), cents(r.period.periodBillLoad), label + ': Total bills equals the amount deducted');
  eq(cents(r.period.paidBills + r.period.remainingBills), cents(r.period.periodBillLoad), label + ': Paid + Remaining equals the amount deducted');
}
eq(cents(over.period.paidBills), cents(1400 + 150), 'overpaid: Paid discloses the observed 150 with the mortgage');
const money = (text, label) => (text.match(new RegExp(label + '[^$]{0,40}(\\$[\\d,]+\\.\\d\\d)')) || [])[1] || null;
for (const [label, r, total] of [['overpaid', over, '$1,695.00'], ['unpaid', unpaid, '$1,665.00']]) {
  eq(money(r.text, 'Total bills this period'), total, label + ': the Budget page prints Total bills this period ' + total);
  eq(money(r.text, 'The plan deducts'), total, label + ': the page\'s "The plan deducts" agrees with Total bills');
}
eq(over.text.includes('$1,602.01'), true, 'overpaid: the page prints Balance After Deductions 1,632.01 − 30');
eq(unpaid.text.includes('$1,632.01'), true, 'unpaid: the page prints the reference Balance After Deductions');

// 5. Unknown stays withheld, never replaced by an observed actual or a zero.
const unknown = run({ paid: 150, hydroAmount: null });
eq(unknown.period.periodBillLoad == null && unknown.period.balanceAfterDeductions == null, true,
  'unknown planned amount: the bill load and Balance After Deductions stay withheld');

// 6. Trust tags do not move toward certainty with the observed actual.
eq([over.period.periodBillLoadTrust, over.period.balanceAfterDeductionsTrust],
  [unpaid.period.periodBillLoadTrust, unpaid.period.balanceAfterDeductionsTrust], 'trust tags unchanged by the observed actual');

// 6b. Current period, pending debit above plan (lead repair ask on #1063):
//     pending never counts as paid. The published row calls the 150 an
//     unconfirmed actual, so the deduction keeps the plan of 120 and Balance
//     After Deductions equals the unpaid reference.
const pend = run({ paid: 150, pending: true });
eq([pend.hydro.status, pend.hydro.displayAmountBasis], ['PAID', 'unconfirmed-actual'],
  'current pending 150: the published row marks the amount unconfirmed, not posted');
eq(cents(pend.period.periodBillLoad), cents(unpaid.period.periodBillLoad),
  'current pending 150: the bill load keeps the planned 120 (pending never counts as paid)');
eq(cents(pend.period.balanceAfterDeductions), cents(unpaid.period.balanceAfterDeductions),
  'current pending 150: Balance After Deductions equals the unpaid reference');
eq(cents(pend.period.plannedPeriodClose), cents(unpaid.period.plannedPeriodClose),
  'current pending 150: the cash close equals the unpaid reference');
eq(over.hydro.displayAmountBasis, 'posted-actual', 'control: the posted 150 is the evidence the row calls posted');
// Known and not changed here (reported to the lead): the paid disclosure
// still prints the pending 150 (tagged estimated), so Total bills shows 1,695
// against a deduction of 1,665, as on main. Pinned so a change is conscious.
eq(cents(pend.period.totalBillsThisPeriod), cents(1400 + 150 + 60 + 85),
  'current pending 150 (known, disclosure unchanged): Total bills still prints the pending amount');

// 7. Completed period: only qualified settlement evidence changes the deduction
//    (Codex review on #1063). Invented closed cycle 2030-02-01..14 with one
//    monthly bill of 30 due 02-05, the same shape test-historical-bill-
//    settlement-evidence.js uses. A pending payment is rejected by historical
//    qualification, so the bill stays planned and deducts its plan; a posted
//    payment above plan is proven and deducts what left.
{
  const Operating = require('../scripts/operating-answer');
  const START = '2030-02-01', NEXT = '2030-02-15', DUE = '2030-02-05', BILL_ID = 'invented-stream';
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const closed = ({ paid = null, pending = false } = {}) => {
    const cash = ids.map((id, i) => ({ id, label: 'Invented cash ' + i, value: [1000, 500, 100][i], evidenceDate: NEXT, confidence: 'confirmed' }));
    const tx = (id, account, date, amount, payee, more = {}) => ({ id, account_id: account, date, amount, currency: 'cad',
      payee, original_name: payee.toUpperCase(), is_pending: false, updated_at: NEXT + 'T17:58:00Z', ...more });
    const source = {
      periods: [],
      data: { meta: { asOf: NEXT }, accounts: [], debts: [], revolvingExtra: [], plan: {
        opening: { asOf: '2030-01-31', representedEvents: [] }, startingCash: { breakdown: cash },
        defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
        income: [{ id: 'payroll', label: 'Invented income', frequency: 'biweekly', anchor: START, amount: 200, confidence: 'confirmed' }],
        bills: [{ id: BILL_ID, label: 'Invented stream', frequency: 'monthly', day: 5, amount: 30, confidence: 'confirmed', payingAccount: 'chequing-a' }],
        commitments: [], obligations: [], groups: [], funding: { options: [] },
        budget: { categories: [['groceries', 40], ['other-spend', 20]].map(([id, plannedPayday]) =>
          ({ id, label: 'Invented ' + id, plannedPayday, class: 'essential', confidence: 'confirmed', from: id === 'groceries' ? ['Groceries'] : [] })) },
      } },
      accountMap: { provider: 'lunchmoney', schema: 'atlas-provider-account-map/v1', scope: 'owner-observed', mappings: ids.map((id, i) =>
        ({ providerAccountId: 'invented-account-' + i, atlasRole: 'household-cash', canonical: { id, collection: 'cash' } })) },
      identity: { rules: [
        { eventId: 'payroll', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' },
        { eventId: BILL_ID, payeePattern: 'Invented Stream Co', atlasAccountId: 'chequing-a', direction: 'debit' }], billPaymentPayees: [] },
      payload: { provider: 'lunchmoney', fetchedAt: NEXT + 'T18:00:00Z',
        accounts: cash.map((row, i) => ({ id: 'invented-account-' + i, name: 'Invented provider cash ' + i, currency: 'cad',
          balance: row.value, balance_as_of: NEXT + 'T17:59:00Z', updated_at: NEXT + 'T17:59:00Z' })),
        categories: [{ id: 'invented-groceries', name: 'Groceries' }, { id: 'invented-income', name: 'Income', is_income: true }],
        tags: [],
        transactions: [
          tx('invented-pay-1', 'invented-account-0', START, '-200.00', 'Invented employer', { category_id: 'invented-income' }),
          ...(paid == null ? [] : [tx('invented-stream-1', 'invented-account-0', DUE, paid.toFixed(2), 'Invented Stream Co', { is_pending: pending })])],
        transactionWindow: { startDate: START, endDate: NEXT, complete: true, hasMore: false, truncated: false },
        pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
      },
    };
    const refreshed = quiet(() => Live.fromObservation(JSON.parse(JSON.stringify(source))));
    const options = Operating.recommendOpts(refreshed.data, {}); options.periods = [];
    const view = F.recommend(refreshed.data.plan, NEXT, options).payPeriodViews.find(v => v.start === START);
    return { view, row: view.bills.find(r => r.id === BILL_ID && r.date === DUE) };
  };
  const none = closed();
  eq(cents(none.view.periodBillLoad), cents(30), 'closed reference: the unpaid bill deducts its plan of 30');
  const pending = closed({ paid: 50, pending: true });
  eq([pending.row.status, pending.row.actual], ['planned', null], 'closed pending 50: historical qualification rejects the payment');
  eq(cents(pending.view.periodBillLoad), cents(30), 'closed pending 50: rejected evidence never changes the deduction (stays 30)');
  eq(cents(pending.view.balanceAfterDeductions ?? NaN) || null, cents(none.view.balanceAfterDeductions ?? NaN) || null,
    'closed pending 50: Balance After Deductions equals the unpaid reference');
  const posted = closed({ paid: 50 });
  eq([posted.row.status, posted.row.actual], ['PAID', 50], 'closed posted 50: the payment is proven');
  eq(cents(posted.view.periodBillLoad), cents(50), 'closed posted 50: the deduction is what left (50)');
  eq(cents(posted.view.totalBillsThisPeriod), cents(posted.view.periodBillLoad), 'closed posted 50: Total bills equals the deduction');
}

console.log('PASS bill actual deducted (finding 6): ' + checks + ' checks');
