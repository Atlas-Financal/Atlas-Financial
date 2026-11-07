'use strict';
// H3: an identity-matched Bills debit that is still pending is a payment in
// flight, not a settled one. Through the real observation -> Forecast ->
// Budget page path it prints "Payment pending" (never PAID), stays out of
// the paid disclosure and the confirmed bill actual, is not reserved as due
// again, and becomes PAID once the same debit posts.
// Entirely invented finances and identities; no data.json, no credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');

// Biweekly payroll anchored 2030-02-01; today is payday 2030-02-15. One
// invented monthly bill of 7.00 is due today and paid by a debit from the
// identified payee into chequing-a.
const START = '2030-02-01', TODAY = '2030-02-15', NEXT_START = TODAY, BILL = 7, ID = 'invented-cloud';
const clone = value => JSON.parse(JSON.stringify(value));
function input({ pending = true, debit = true } = {}) {
  const day = TODAY;
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const cash = ids.map((id, i) => ({ id, label: 'Invented cash ' + i, value: [1000, 500, 100][i], evidenceDate: day, confidence: 'confirmed' }));
  const tx = (id, account, date, amount, payee, more = {}) => ({ id, account_id: account, date, amount, currency: 'cad',
    payee, original_name: payee.toUpperCase(), is_pending: false, updated_at: day + 'T17:58:00Z', ...more });
  return { periods: [], data: { meta: { asOf: day }, accounts: [], debts: [], revolvingExtra: [], plan: {
      opening: { asOf: '2030-01-31', representedEvents: [] }, startingCash: { breakdown: cash },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      income: [{ id: 'payroll', label: 'Invented income', frequency: 'biweekly', anchor: START, amount: 200, confidence: 'confirmed' }],
      bills: [{ id: ID, label: 'Invented cloud', frequency: 'monthly', day: 15, amount: BILL, confidence: 'confirmed', payingAccount: 'chequing-a' }],
      commitments: [], obligations: [], groups: [], funding: { options: [] },
      budget: { categories: [{ id: 'groceries', label: 'Invented groceries', plannedPayday: 40, class: 'essential', confidence: 'confirmed', from: ['Groceries'] }] } } },
    accountMap: { provider: 'lunchmoney', schema: 'atlas-provider-account-map/v1', scope: 'owner-observed', mappings: ids.map((id, i) =>
      ({ providerAccountId: 'invented-account-' + i, atlasRole: 'household-cash', canonical: { id, collection: 'cash' } })) },
    identity: { rules: [{ eventId: 'payroll', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' },
      { eventId: ID, payeePattern: 'Invented Cloud Co', atlasAccountId: 'chequing-a', direction: 'debit' }], billPaymentPayees: [] },
    payload: { provider: 'lunchmoney', fetchedAt: day + 'T18:00:00Z',
      accounts: cash.map((row, i) => ({ id: 'invented-account-' + i, name: 'Invented provider cash ' + i, currency: 'cad',
        balance: row.value, balance_as_of: day + 'T17:59:00Z', updated_at: day + 'T17:59:00Z' })),
      categories: [{ id: 'invented-groceries', name: 'Groceries' }, { id: 'invented-income', name: 'Income', is_income: true }], tags: [],
      transactions: [tx('invented-pay-1', 'invented-account-0', START, '-200.00', 'Invented employer', { category_id: 'invented-income' }),
        ...(debit ? [tx('invented-cloud-1', 'invented-account-0', TODAY, '7.00', 'Invented Cloud Co', { is_pending: pending })] : [])],
      transactionWindow: { startDate: START, endDate: day, complete: true, hasMore: false, truncated: false },
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false } } };
}
function run(source) {
  const refreshed = Live.fromObservation(clone(source));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const advice = Forecast.recommend(refreshed.data.plan, TODAY, options);
  const view = advice.payPeriodViews.find(p => p.start === TODAY);
  const entry = (options.currentPeriodActuals.representedActuals || []).find(r => r.id === ID && r.date === TODAY);
  return { view, entry, row: view.bills.find(r => r.id === ID && r.date === TODAY) };
}

// The active Budget page scripts, loaded as test-budget-surface.js does.
function page() {
  const root = path.join(__dirname, '..');
  const stub = () => ({ innerHTML: '', textContent: '', hidden: false, value: '',
    style: { setProperty() {}, getPropertyValue() { return ''; } }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, insertAdjacentHTML() {}, closest() { return null; }, children: [] });
  const els = new Map();
  const context = vm.createContext({ Forecast, console, addEventListener() {}, setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { if (!els.has(id)) els.set(id, stub()); return els.get(id); },
      documentElement: { dataset: {}, style: {} }, createElement: stub, createElementNS: stub, body: stub() },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = Object.assign(context, { matchMedia() { return { matches: false, addEventListener() {} }; } });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {}; App.once = () => {}; App.register = () => {};', context);
  for (const f of ['forecast-chequing.js', 'balance-history.js', 'bill-detail.js', 'savings-inventory.js',
    'budget-surface.js', 'plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'public', f), 'utf8'), context);
  }
  return {
    bills(view) {
      context.__view = view;
      return vm.runInContext(`budgetBillsSectionHtml(__view, { asOf: '${NEXT_START}' })`, context);
    },
    mustLeave(action) {
      context.__action = action;
      return vm.runInContext('mustLeaveHtml(null, __action)', context);
    },
    line(row) {
      context.__row = row;
      return vm.runInContext("Object.defineProperty(App, 'data', { get: () => ({ plan: {} }), configurable: true }); periodBillLine(__row)", context);
    },
  };
}
const PAGE = page();
const rowHtml = html => (html.match(new RegExp('<button[^>]*data-budget-bill-open="' + ID + '"[\\s\\S]*?</button>')) || [''])[0];

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  PASS  ' + name); };

console.log('\n=== a pending identity-matched debit is a payment in flight, not PAID ===');
check('the observer flags the entry pending', () => {
  const { entry } = run(input());
  assert.ok(entry && entry.transactionId, 'control: the observer matched the pending debit');
  assert.equal(entry.pending, true);
  assert.equal(run(input({ pending: false })).entry.pending, undefined, 'a posted debit carries no pending flag');
});
check('Forecast prints it pending: not PAID, not due again, not in the paid disclosure', () => {
  const { row, view } = run(input());
  assert.equal(row.status, 'pending');
  assert.equal(row.settlement, 'pending');
  assert.notEqual(row.status, 'PAID');
  assert.equal(row.actual, null, 'no settled actual');
  assert.equal(row.remaining, 0, 'the payment is in flight; it is not reserved again');
  assert.equal(view.paidBills, 0, 'nothing is disclosed as confirmed settled');
  assert.equal(view.remainingBills, 0);
  assert.notEqual(view.budgetProgress.bills.actual.completeness, 'complete');
});
check('the Budget page prints Payment pending; the bill line and detail never say PAID', () => {
  const { row, view } = run(input());
  const html = rowHtml(PAGE.bills(view));
  assert.match(html, />Payment pending</);
  assert.doesNotMatch(html, />Paid</);
  const line = PAGE.line(row);
  assert.match(line, /data-bill-status="pending"/);
  assert.doesNotMatch(line, /marked PAID/);
});

console.log('\n=== the waterfall is unchanged; posting flips it to PAID ===');
check('pending and posted debits give the same bill load, Balance After Deductions and planned close', () => {
  const pending = run(input()).view, posted = run(input({ pending: false })).view;
  for (const key of ['periodBillLoad', 'totalBillsThisPeriod', 'balanceAfterDeductions', 'plannedPeriodClose', 'remainingBills']) {
    assert.equal(pending[key], posted[key], key);
  }
  assert.equal(posted.paidBills, BILL, 'the posted debit is disclosed as paid: 7.00');
  assert.equal(posted.periodBillLoad, BILL, 'the 7.00 bill is deducted once either way');
});
check('once the same debit posts it is PAID 7.00 on the page', () => {
  const { row, view } = run(input({ pending: false }));
  assert.equal(row.status, 'PAID');
  assert.equal(row.actual, BILL);
  assert.match(rowHtml(PAGE.bills(view)), />Paid</);
});
check('with no debit at all the bill is still owed today: upcoming, 7.00 remaining, not PAID', () => {
  const { row, view } = run(input({ debit: false }));
  assert.notEqual(row.status, 'PAID');
  assert.equal(row.settlement, 'upcoming', 'no payment was matched');
  assert.equal(row.remaining, BILL);
  assert.equal(view.remainingBills, BILL, 'only an unmatched bill is still left to pay');
});

console.log('\n=== the operating action and Talk: pending is neither asked for again nor paid ===');
const Assistant = require('../scripts/assistant-packet');
const Talk = require('../scripts/talk-presentation');
function operating(source) {
  const refreshed = Live.fromObservation(clone(source));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const advice = Forecast.recommend(refreshed.data.plan, TODAY, options);
  const packet = Assistant.buildPacket({ data: refreshed.data, periods: [], now: TODAY + 'T18:30:00.000Z', env: {} });
  const ask = kind => Talk.presentPaydayRemainingBills({ status: 'resolved-reference', referentKey: 'payday-remaining-bills', ask: kind }, packet).answer;
  const action = advice.currentPeriodAction;
  return { action, packet, ask,
    bill: (action.bills || []).find(r => r.id === ID && r.date === TODAY),
    due: (action.thisPaydayDue || []).find(r => r.id === ID && r.date === TODAY) };
}
check('pending: the action lists it as a payment pending, Talk does not call it still due, the must-leave line says payment pending', () => {
  const { bill, due, action, ask, packet } = operating(input());
  assert.equal(bill.settlement, 'pending');
  assert.equal(bill.remaining, BILL, 'the 7.00 stays reserved until the debit posts (no pay action: not upcoming)');
  assert.ok(!(action.todayActions || []).some(a => a.id === ID), 'no pay-today action for a payment in flight');
  assert.equal(bill.actual, null, 'not paid');
  assert.equal(due.settlement, 'pending');
  assert.equal(Math.abs(due.movement), BILL, 'the 7.00 still leaves this payday cash (kept until it posts)');
  const row = packet.forecast.currentPeriodAction.bills.find(r => r.id === ID);
  assert.equal(row.settlement, 'pending', 'the assistant packet carries the pending state');
  const remaining = ask('remaining');
  assert.doesNotMatch(remaining, /Invented cloud is still due/);
  assert.match(remaining, /Invented cloud has a payment pending for its 2030-02-15 bill \(planned \$7\.00\)\. It has not posted yet\. That is not still due\./);
  assert.doesNotMatch(ask('covered'), /Invented cloud/, 'a pending payment is not listed as already covered');
  const html = PAGE.mustLeave(action);
  assert.match(html, /Invented cloud[^<]*payment pending/);
  assert.doesNotMatch(html, /Invented cloud[^<]*still due/);
});
check('the week glance prints the pending bill as pending, not still due', () => {
  const refreshed = Live.fromObservation(clone(input()));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const advice = Forecast.recommend(refreshed.data.plan, TODAY, options);
  const rows = (advice.weekViews || []).flatMap(v => (v && v.glance && v.glance.bills) || (v && v.bills) || []);
  const row = rows.find(r => r && r.id === ID && r.date === TODAY);
  assert.ok(row, 'control: the current week lists the bill');
  assert.equal(row.status, 'pending');
  assert.equal(row.settlement, 'pending');
  assert.notEqual(row.status, 'PAID');
});
check('posted: covered and not still due; dropped: still due 7.00 everywhere', () => {
  const posted = operating(input({ pending: false }));
  assert.equal(posted.bill.settlement, 'represented');
  assert.doesNotMatch(posted.ask('remaining'), /Invented cloud/);
  assert.match(posted.ask('covered'), /Invented cloud is represented 2030-02-15 for \$7\.00/);
  const dropped = operating(input({ debit: false }));
  assert.equal(dropped.bill.settlement, 'upcoming');
  assert.equal(dropped.bill.remaining, BILL);
  assert.match(dropped.ask('remaining'), /Invented cloud is still due 2030-02-15 for \$7\.00\./);
  assert.ok(dropped.action.todayActions.some(a => a.id === ID && a.kind === 'pay'), 'control: an unmatched bill due today is a pay action');
  assert.match(PAGE.mustLeave(dropped.action), /Invented cloud[^<]*still due/);
});

console.log('\n=== deductions do not depend on the display state: snapshot and cutover openings ===');
// Cutover twin: today, the opening and the bill due date move to 2030-02-16
// (payday stays 2030-02-15), so the live path opens on posted cash with no
// payday snapshot. Income 200.00, household hold 40.00, bill 7.00.
function cutover({ pending = true } = {}) {
  const s = input({ pending });
  const D = '2030-02-16';
  s.data.meta.asOf = D; s.data.plan.opening.asOf = D;
  for (const c of s.data.plan.startingCash.breakdown) c.evidenceDate = D;
  s.data.plan.bills[0].day = 16;
  s.payload.fetchedAt = D + 'T18:00:00Z';
  for (const a of s.payload.accounts) { a.balance_as_of = D + 'T17:59:00Z'; a.updated_at = D + 'T17:59:00Z'; }
  s.payload.transactionWindow.endDate = D;
  for (const t of s.payload.transactions) { t.updated_at = D + 'T17:58:00Z'; if (t.id === 'invented-cloud-1') t.date = D; }
  const refreshed = Live.fromObservation(clone(s));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const advice = Forecast.recommend(refreshed.data.plan, D, options);
  const view = advice.payPeriodViews.find(p => p.start <= D && p.end >= D);
  return { view, row: view.bills.find(r => r.id === ID) };
}
check('cutover opening: pending and posted twins deduct the same; only the paid disclosure differs', () => {
  const p = cutover(), q = cutover({ pending: false });
  assert.equal(p.view.openingSource, 'cutover-opening', 'control: no payday snapshot, posted-cash opening');
  assert.equal(p.row.status, 'pending');
  assert.equal(q.row.status, 'PAID');
  for (const key of ['opening', 'periodBillLoad', 'balanceAfterDeductions', 'remainingBills', 'totalBillsThisPeriod']) {
    assert.equal(p.view[key], q.view[key], key);
  }
  // Independent arithmetic: the same-day debit is already counted in the
  // cutover opening, so the period deducts no assigned bill: 200 - 0 - 40.
  assert.equal(p.view.periodBillLoad, 0);
  assert.equal(p.view.balanceAfterDeductions, 200 - 0 - 40);
  assert.equal(p.view.paidBills, 0);
  assert.equal(q.view.paidBills, BILL);
});
check('snapshot opening: the bill is deducted once either way: 200 - 7 - 40', () => {
  const p = run(input()).view, q = run(input({ pending: false })).view;
  assert.equal(p.periodBillLoad, BILL);
  assert.equal(q.periodBillLoad, BILL);
  assert.equal(p.balanceAfterDeductions, 200 - 7 - 40);
  assert.equal(q.balanceAfterDeductions, 200 - 7 - 40);
});

console.log(`\nAll ${passed} pending bill payment proofs passed.`);
