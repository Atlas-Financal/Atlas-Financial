'use strict';
// A completed pay period's bill is PAID only when a posted transaction in
// the same observation packet backs the settlement entry. An entry with no
// transaction, a missing, duplicated, shared or pending transaction, or a
// competing entry leaves the occurrence planned ("To confirm") and the
// period's bill actual partial, through the real observation -> Forecast ->
// captured closing -> rendered Budget path.
// Entirely invented finances and identities; no data.json, no credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const History = require('../scripts/private-period-history');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');

// Biweekly payroll anchored 2030-02-01: cycle 02-01..02-14 closes on 02-15.
// One invented monthly bill of 30.00 is due 02-05 inside that cycle. The
// canonical opening is dated 2030-01-31 so the observer's reach-back covers
// the whole closed cycle.
const START = '2030-02-01', NEXT_START = '2030-02-15', BILL_DATE = '2030-02-05';
const BILL = 30, BILL_ID = 'invented-stream';
const clone = value => JSON.parse(JSON.stringify(value));
const PAYROLL_RULE = { eventId: 'payroll', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' };
const PAYEE_RULE = { eventId: BILL_ID, payeePattern: 'Invented Stream Co', atlasAccountId: 'chequing-a', direction: 'debit' };
const TRUST_RULE = { eventId: BILL_ID, settlesWhen: 'schedule-trust-on-due' };

function input({ rules = [PAYROLL_RULE, PAYEE_RULE], billTx = true, billPending = false, extra = [], representedEvents = [] } = {}) {
  const day = NEXT_START;
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const cash = ids.map((id, i) => ({ id, label: 'Invented cash ' + i, value: [1000, 500, 100][i], evidenceDate: day, confidence: 'confirmed' }));
  const tx = (id, account, date, amount, payee, more = {}) => ({ id, account_id: account, date, amount, currency: 'cad',
    payee, original_name: payee.toUpperCase(), is_pending: false, updated_at: day + 'T17:58:00Z', ...more });
  return {
    periods: [],
    data: { meta: { asOf: day }, accounts: [], debts: [], revolvingExtra: [], plan: {
      opening: { asOf: '2030-01-31', representedEvents }, startingCash: { breakdown: cash },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      income: [{ id: 'payroll', label: 'Invented income', frequency: 'biweekly', anchor: START, amount: 200, confidence: 'confirmed' }],
      bills: [{ id: BILL_ID, label: 'Invented stream', frequency: 'monthly', day: 5, amount: BILL,
        confidence: 'confirmed', payingAccount: 'chequing-a' }],
      commitments: [], obligations: [], groups: [], funding: { options: [] },
      budget: { categories: [['groceries', 40], ['other-spend', 20]].map(([id, plannedPayday]) =>
        ({ id, label: 'Invented ' + id, plannedPayday, class: 'essential', confidence: 'confirmed', from: id === 'groceries' ? ['Groceries'] : [] })) },
    } },
    accountMap: { provider: 'lunchmoney', schema: 'atlas-provider-account-map/v1', scope: 'owner-observed', mappings: ids.map((id, i) =>
      ({ providerAccountId: 'invented-account-' + i, atlasRole: 'household-cash', canonical: { id, collection: 'cash' } })) },
    identity: { rules, billPaymentPayees: [] },
    payload: { provider: 'lunchmoney', fetchedAt: day + 'T18:00:00Z',
      accounts: cash.map((row, i) => ({ id: 'invented-account-' + i, name: 'Invented provider cash ' + i,
        currency: 'cad', balance: row.value, balance_as_of: day + 'T17:59:00Z', updated_at: day + 'T17:59:00Z' })),
      categories: [{ id: 'invented-groceries', name: 'Groceries' }, { id: 'invented-income', name: 'Income', is_income: true }],
      tags: [],
      transactions: [
        tx('invented-pay-1', 'invented-account-0', START, '-200.00', 'Invented employer', { category_id: 'invented-income' }),
        tx('invented-market-1', 'invented-account-1', '2030-02-07', '12.34', 'Invented Market', { category_id: 'invented-groceries' }),
        ...(billTx ? [tx('invented-stream-1', 'invented-account-0', BILL_DATE, '30.00', 'Invented Stream Co', { is_pending: billPending })] : []),
        ...extra.map(args => tx(...args))],
      transactionWindow: { startDate: START, endDate: day, complete: true, hasMore: false, truncated: false },
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
    },
  };
}

const capture = source => History.captureClosing(clone(source), { now: () => new Date(NEXT_START + 'T18:01:00Z') });
function closedView(source, mutate) {
  const refreshed = Live.fromObservation(clone(source));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const packet = options.currentPeriodActuals;
  const entry = (packet.representedActuals || []).find(r => r.id === BILL_ID && r.date === BILL_DATE);
  if (mutate) mutate(packet, entry);
  const advice = Forecast.recommend(refreshed.data.plan, NEXT_START, options);
  const view = advice.payPeriodViews.find(p => p.start === START);
  return { advice, packet, view, row: view.bills.find(r => r.id === BILL_ID && r.date === BILL_DATE) };
}

// The active Budget page scripts, loaded as test-budget-surface.js does,
// to print the completed period's Bills section from the real view.
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
    income(view) {
      context.__view = view;
      return vm.runInContext('calendarIncomeHtml(__view)', context);
    },
    bills(view) {
      context.__view = view;
      return vm.runInContext(`budgetBillsSectionHtml(__view, { asOf: '${NEXT_START}' })`, context);
    },
  };
}
const PAGE = page();
const billRowHtml = html => (html.match(new RegExp('<button[^>]*data-budget-bill-open="' + BILL_ID + '"[\\s\\S]*?</button>')) || [''])[0];
const bucketOf = html => {
  const at = html.indexOf('data-budget-bill-open="' + BILL_ID + '"');
  const head = html.slice(0, at);
  const m = head.match(/data-budget-bill-bucket="([a-z]+)"(?![\s\S]*data-budget-bill-bucket=)/);
  return m ? m[1] : null;
};

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  PASS  ' + name); };

console.log('\n=== control: a posted, identity-matched payment settles the completed bill ===');
check('posted payee match: PAID 30.00, bills actual complete, closing complete-at-capture, page prints Paid', () => {
  const { row, view, packet } = closedView(input());
  const entry = packet.representedActuals.find(r => r.id === BILL_ID && r.date === BILL_DATE);
  assert.ok(entry && entry.transactionId, 'control: the observer linked the posted payment');
  assert.equal(row.status, 'PAID');
  assert.equal(row.actual, BILL);
  assert.equal(row.settlementEvidence, undefined);
  assert.equal(view.budgetProgress.bills.actual.amount, BILL);
  assert.equal(view.budgetProgress.bills.actual.completeness, 'complete');
  const html = PAGE.bills(view);
  assert.equal(bucketOf(html), 'paid');
  assert.match(billRowHtml(html), />Paid</);
  const candidate = capture(input());
  const captured = candidate.content.publication.bills.find(r => r.id === BILL_ID && r.date === BILL_DATE);
  assert.equal(captured.status, 'PAID');
  assert.equal(candidate.content.publication.budgetProgress.bills.actual.completeness, 'complete');
  assert.equal(candidate.content.closingState, 'complete-at-capture');
});

console.log('\n=== owner schedule-trust provenance: PAID stays, the basis is recorded ===');
check('schedule-trust-on-due with no bank transaction: PAID 30.00 with settlementBasis, recorded on the captured row', () => {
  const source = input({ rules: [PAYROLL_RULE, TRUST_RULE], billTx: false });
  const { row, view, packet } = closedView(source);
  const entry = packet.representedActuals.find(r => r.id === BILL_ID && r.date === BILL_DATE);
  assert.ok(entry, 'control: the observer emitted the trusted occurrence');
  assert.equal(entry.transactionId, undefined, 'control: no transaction backs it');
  assert.equal(entry.settlementBasis, 'schedule-trust-on-due');
  assert.equal(row.status, 'PAID', 'the owner-configured rule still settles it');
  assert.equal(row.actual, BILL);
  assert.equal(row.settlementBasis, 'schedule-trust-on-due');
  assert.equal(row.settlementEvidence, undefined);
  assert.equal(view.budgetProgress.bills.actual.completeness, 'complete');
  const candidate = capture(source);
  const captured = candidate.content.publication.bills.find(r => r.id === BILL_ID && r.date === BILL_DATE);
  assert.equal(captured.status, 'PAID');
  assert.equal(captured.settlementBasis, 'schedule-trust-on-due', 'the captured closing row says why it is PAID');
});

console.log('\n=== H2: an entry with neither posted backing nor provenance is not PAID ===');
check('an entry with no transaction and no basis: planned, To confirm, bills actual partial, nothing disclosed paid', () => {
  const { row, view } = closedView(input({ billTx: false }), packet => {
    packet.representedActuals.push({ id: BILL_ID, date: BILL_DATE, actual: BILL, postedOn: BILL_DATE });
  });
  assert.equal(row.status, 'planned');
  assert.equal(row.settlement, 'unverified');
  assert.equal(row.actual, null, 'no observed amount is kept');
  assert.equal(row.remaining, BILL, 'the planned 30.00 is what remains unconfirmed');
  assert.equal(Math.abs(row.movement), BILL);
  assert.equal(row.settlementEvidence, 'not-established');
  assert.equal(view.budgetProgress.bills.actual.amount, null, 'the only bill has no confirmed amount');
  assert.equal(view.budgetProgress.bills.actual.completeness, 'partial');
  assert.equal(view.paidBills, 0, 'nothing is disclosed as paid');
  const html = PAGE.bills(view);
  assert.equal(bucketOf(html), 'check');
  assert.match(billRowHtml(html), />To confirm</);
  assert.doesNotMatch(billRowHtml(html), />Paid</);
});
console.log('\n=== the Forecast seam: every way the named evidence can be absent or contested ===');
const notPaid = (name, mutate) => check(name, () => {
  const { row, view } = closedView(input(), (packet, entry) => {
    assert.ok(entry && entry.transactionId, 'control: the observer linked the posted payment');
    mutate(packet, entry);
  });
  assert.notEqual(row.status, 'PAID');
  assert.equal(row.actual, null);
  assert.equal(row.settlement, 'unverified');
  assert.equal(row.settlementEvidence, 'not-established');
  assert.notEqual(view.budgetProgress.bills.actual.completeness, 'complete');
  assert.match(billRowHtml(PAGE.bills(view)), />To confirm</);
});
const txOf = (packet, entry) => packet.transactions.find(t => String(t.id) === String(entry.transactionId));
notPaid('the entry names no transaction', (packet, entry) => { delete entry.transactionId; });
notPaid('the named transaction is missing from the packet', (packet, entry) => {
  packet.transactions = packet.transactions.filter(t => String(t.id) !== String(entry.transactionId));
});
notPaid('the named transaction is pending (a pending-only settlement)', (packet, entry) => { txOf(packet, entry).pending = true; });
notPaid('the named transaction appears twice in the packet', (packet, entry) => { packet.transactions.push({ ...txOf(packet, entry) }); });
notPaid('a second entry names the same occurrence', (packet, entry) => { packet.representedActuals.push({ ...entry }); });
notPaid('another occurrence claims the same transaction', (packet, entry) => {
  packet.representedActuals.push({ id: 'invented-other', date: '2030-02-09', actual: BILL, postedOn: '2030-02-09',
    transactionId: entry.transactionId });
});
notPaid('another occurrence claims the same transaction only through transactionIds', (packet, entry) => {
  packet.representedActuals.push({ id: 'invented-other', date: '2030-02-09', actual: BILL, postedOn: '2030-02-09',
    transactionId: 'tx-invented-other', transactionIds: ['tx-invented-other', entry.transactionId] });
});
notPaid('transactionIds is malformed', (packet, entry) => { entry.transactionIds = 'not-an-array'; });
notPaid('transactionIds does not include transactionId', (packet, entry) => { entry.transactionIds = ['tx-invented-elsewhere']; });
notPaid('a multi-leg entry whose second leg is missing', (packet, entry) => {
  entry.transactionIds = [entry.transactionId, 'tx-invented-second-leg'];
});
notPaid('a multi-leg entry whose second leg is pending', (packet, entry) => {
  packet.transactions.push({ ...txOf(packet, entry), id: 'tx-invented-second-leg', pending: true });
  entry.transactionIds = [entry.transactionId, 'tx-invented-second-leg'];
});
notPaid('a basis-marked entry that also claims a transaction is not owner provenance', (packet, entry) => {
  entry.settlementBasis = 'schedule-trust-on-due';
  packet.transactions = packet.transactions.filter(t => String(t.id) !== String(entry.transactionId));
});
notPaid('an entry with any other basis value is not owner provenance', (packet, entry) => {
  delete entry.transactionId; entry.settlementBasis = 'seen';
});
notPaid('a basis-marked entry competing with a second entry for the occurrence', (packet, entry) => {
  delete entry.transactionId; entry.settlementBasis = 'schedule-trust-on-due';
  packet.representedActuals.push({ ...entry });
});
check('a multi-leg entry with every leg posted and claimed once stays PAID', () => {
  const { row, view } = closedView(input(), (packet, entry) => {
    packet.transactions.push({ ...txOf(packet, entry), id: 'tx-invented-second-leg' });
    entry.transactionIds = [entry.transactionId, 'tx-invented-second-leg'];
  });
  assert.equal(row.status, 'PAID');
  assert.equal(row.actual, BILL);
  assert.equal(view.budgetProgress.bills.actual.completeness, 'complete');
});

console.log('\n=== audit #26: pending evidence is never settled history ===');
const GIFT = ['invented-gift-1', 'invented-account-0', '2030-02-10', '-25.00', 'Invented Gift Giver', { category_id: 'invented-income' }];
const giftRow = view => (view.income || []).find(r => r && r.otherIncome === true && r.date === '2030-02-10');
check('control: a posted 25.00 Other Income receipt in the closed period is Received', () => {
  const { view } = closedView(input({ extra: [GIFT] }));
  const row = giftRow(view);
  assert.ok(row, 'control: the receipt is published as Other Income');
  assert.equal(row.status, 'received');
  assert.equal(row.alreadyInCash, true);
  assert.match(PAGE.income(view), /other-income-tx-received">Received</);
});
check('a pending 25.00 Other Income receipt stays expected after the period closes', () => {
  const pending = [...GIFT.slice(0, 5), { ...GIFT[5], is_pending: true }];
  const { view } = closedView(input({ extra: [pending] }));
  const row = giftRow(view);
  assert.ok(row, 'control: the pending receipt is published as Other Income');
  assert.notEqual(row.status, 'received');
  assert.equal(row.alreadyInCash, false);
  assert.equal(row.remaining, 25, 'the 25.00 has not arrived');
  assert.notEqual(view.budgetProgress.income.actual.completeness, 'complete');
  const html = PAGE.income(view);
  assert.match(html, /other-income-tx-pending">Expected</);
  assert.doesNotMatch(html, /other-income-tx-received">Received</);
});
check('a pending 30.00 bill debit matched by the observer is not PAID after the period closes', () => {
  const { view, row, packet } = closedView(input({ billPending: true }));
  const entry = packet.representedActuals.find(r => r.id === BILL_ID && r.date === BILL_DATE);
  const tx = entry && packet.transactions.find(t => String(t.id) === String(entry.transactionId));
  assert.ok(tx && tx.pending === true, 'control: the observer matched a pending debit');
  assert.notEqual(row.status, 'PAID');
  assert.equal(row.actual, null);
  assert.notEqual(view.budgetProgress.bills.actual.completeness, 'complete');
  assert.match(billRowHtml(PAGE.bills(view)), />To confirm</);
});

console.log('\n=== scope: the current period and the non-packet records are unchanged ===');
check('the current period carries no historical settlement gate', () => {
  const { advice } = closedView(input({ rules: [PAYROLL_RULE, TRUST_RULE], billTx: false }));
  for (const v of advice.payPeriodViews.filter(p => p.start >= NEXT_START)) {
    for (const r of v.bills || []) assert.equal(r.settlementEvidence, undefined, v.start + ' ' + r.id);
  }
});

console.log(`\nAll ${passed} completed-period bill settlement proofs passed.`);
