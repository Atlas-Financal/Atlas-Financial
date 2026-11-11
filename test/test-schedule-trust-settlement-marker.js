'use strict';
// An owner "schedule-trust-on-due" rule settles a bill on its due date at
// the scheduled amount without seeing a bank transaction. Wherever such a
// row prints PAID — the current period, completed-period history, the week
// glance, the bill detail sheet and the captured closing (file and hosted
// projection) — it carries a visible "trusted on due date (not seen)"
// marker. A payment the observer actually saw never carries it, and the
// rule's settling behaviour is unchanged.
// Entirely invented finances and identities; no data.json, no credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const History = require('../scripts/private-period-history');
const Postgres = require('../scripts/private-period-history-postgres');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');

// Biweekly payroll anchored 2030-02-01: cycle 02-01..02-14 closes on 02-15.
// Two invented monthly bills: 'invented-stream' 30.00 due 02-05 (closed
// cycle) and 'invented-cloud' 7.00 due 02-15 (today, current cycle).
const START = '2030-02-01', NEXT_START = '2030-02-15';
const STREAM = { id: 'invented-stream', date: '2030-02-05', amount: 30 };
const CLOUD = { id: 'invented-cloud', date: '2030-02-15', amount: 7 };
const BASIS = 'schedule-trust-on-due';
const MARK = 'Trusted on due date (not seen)';
const clone = value => JSON.parse(JSON.stringify(value));
const PAYROLL_RULE = { eventId: 'payroll', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' };
const trust = id => ({ eventId: id, settlesWhen: BASIS });
const payee = (id, pattern) => ({ eventId: id, payeePattern: pattern, atlasAccountId: 'chequing-a', direction: 'debit' });

function input({ rules = [PAYROLL_RULE, trust(STREAM.id), trust(CLOUD.id)], extra = [] } = {}) {
  const day = NEXT_START;
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const cash = ids.map((id, i) => ({ id, label: 'Invented cash ' + i, value: [1000, 500, 100][i], evidenceDate: day, confidence: 'confirmed' }));
  const tx = (id, account, date, amount, name, more = {}) => ({ id, account_id: account, date, amount, currency: 'cad',
    payee: name, original_name: name.toUpperCase(), is_pending: false, updated_at: day + 'T17:58:00Z', ...more });
  return {
    periods: [],
    data: { meta: { asOf: day }, accounts: [], debts: [], revolvingExtra: [], plan: {
      opening: { asOf: '2030-01-31', representedEvents: [] }, startingCash: { breakdown: cash },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      income: [{ id: 'payroll', label: 'Invented income', frequency: 'biweekly', anchor: START, amount: 200, confidence: 'confirmed' }],
      bills: [
        { id: STREAM.id, label: 'Invented stream', frequency: 'monthly', day: 5, amount: STREAM.amount, confidence: 'confirmed', payingAccount: 'chequing-a' },
        { id: CLOUD.id, label: 'Invented cloud', frequency: 'monthly', day: 15, amount: CLOUD.amount, confidence: 'confirmed', payingAccount: 'chequing-a' },
      ],
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
        ...extra.map(args => tx(...args))],
      transactionWindow: { startDate: START, endDate: day, complete: true, hasMore: false, truncated: false },
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
    },
  };
}

function observed(source) {
  const refreshed = Live.fromObservation(clone(source));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const advice = Forecast.recommend(refreshed.data.plan, NEXT_START, options);
  const view = start => advice.payPeriodViews.find(p => p.start === start);
  const bill = (start, want) => view(start).bills.find(r => r.id === want.id && r.date === want.date);
  const entry = want => (options.currentPeriodActuals.representedActuals || []).find(r => r.id === want.id && r.date === want.date);
  return { advice, options, view, bill, entry };
}
const capture = source => History.captureClosing(clone(source), { now: () => new Date(NEXT_START + 'T18:01:00Z') });

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
    line(row) {
      context.__row = row;
      return vm.runInContext("Object.defineProperty(App, 'data', { get: () => ({ plan: {} }), configurable: true }); periodBillLine(__row)", context);
    },
  };
}
const PAGE = page();
const rowHtml = (html, id) => (html.match(new RegExp('<button[^>]*data-budget-bill-open="' + id + '"[\\s\\S]*?</button>')) || [''])[0];

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  PASS  ' + name); };

console.log('\n=== the observer names the basis on the trusted entry, and only there ===');
check('schedule-trust entries carry settlementBasis and no transaction; a seen payment carries neither marker nor trust', () => {
  const trusted = observed(input());
  for (const want of [STREAM, CLOUD]) {
    const e = trusted.entry(want);
    assert.ok(e, 'control: the rule emitted ' + want.id);
    assert.equal(e.settlementBasis, BASIS);
    assert.equal(e.transactionId, undefined);
    assert.equal(e.actual, want.amount, 'the rule still settles at the scheduled amount');
  }
  const seen = observed(input({ rules: [PAYROLL_RULE, payee(STREAM.id, 'Invented Stream Co'), trust(CLOUD.id)],
    extra: [['invented-stream-1', 'invented-account-0', STREAM.date, '30.00', 'Invented Stream Co']] }));
  const e = seen.entry(STREAM);
  assert.ok(e && e.transactionId, 'control: the posted payment is linked');
  assert.equal(e.settlementBasis, undefined);
});

console.log('\n=== current period: PAID stays PAID, with the marker on every print ===');
check('current-period bill: PAID with settlementBasis; Budget prints Paid · Trusted on due date (not seen)', () => {
  const { view, bill } = observed(input());
  const row = bill(NEXT_START, CLOUD);
  assert.equal(row.status, 'PAID', 'the owner-configured settling behaviour is unchanged');
  assert.equal(row.settlementBasis, BASIS);
  const html = rowHtml(PAGE.bills(view(NEXT_START)), CLOUD.id);
  assert.match(html, />Paid · Trusted on due date \(not seen\)</);
  assert.doesNotMatch(html, /verified|confirmed payment/i);
});
check('the period line and bill detail sheet print the marker and say no bank transaction was seen', () => {
  const { bill } = observed(input());
  const html = PAGE.line(bill(NEXT_START, CLOUD));
  assert.match(html, /PAID · trusted on due date \(not seen\)/);
  assert.match(html, /data-bill-status="PAID"/, 'the closed status attribute is unchanged');
  assert.match(html, /Settlement basis<\/dt><dd>Trusted on due date \(not seen\)/);
  assert.match(html, /No bank transaction was seen, so this is not a confirmed payment\./);
});
check('the week glance prints the trusted bill PAID with the marker', () => {
  const { advice } = observed(input());
  const rows = (advice.weekViews || []).flatMap(v => (v && v.glance && v.glance.bills) || (v && v.bills) || []);
  const row = rows.find(r => r && r.id === CLOUD.id && r.date === CLOUD.date);
  assert.ok(row, 'control: the current week prints the trusted bill');
  assert.equal(row.status, 'PAID');
  assert.equal(row.settlementBasis, BASIS);
});

console.log('\n=== period history: the marker rides on the completed row and the captured closing ===');
check('completed-period row and its Budget print carry the marker when it prints PAID', () => {
  const { view, bill } = observed(input());
  const row = bill(START, STREAM);
  assert.equal(row.status, 'PAID', 'the owner-configured rule still settles the completed occurrence');
  assert.equal(row.settlementBasis, BASIS);
  assert.match(rowHtml(PAGE.bills(view(START)), STREAM.id), />Paid · Trusted on due date \(not seen\)</);
});
check('the captured closing row records the marker, in the file record and the hosted projection', () => {
  const candidate = capture(input());
  const captured = candidate.content.publication.bills.find(r => r.id === STREAM.id && r.date === STREAM.date);
  assert.ok(captured, 'control: the closing publishes the bill');
  const projected = Postgres.project(candidate).content.publication.bills.find(r => r.id === STREAM.id && r.date === STREAM.date);
  assert.equal(captured.status, 'PAID');
  assert.equal(captured.settlementBasis, BASIS);
  assert.equal(projected.settlementBasis, BASIS);
});

console.log('\n=== the assistant packet carries the basis; the Bills page keeps the marker ===');
check('the assistant packet row carries settlementBasis', () => {
  const Assistant = require('../scripts/assistant-packet');
  const refreshed = Live.fromObservation(clone(input()));
  const packet = Assistant.buildPacket({ data: refreshed.data, periods: [], now: NEXT_START + 'T18:30:00.000Z', env: {} });
  const row = (packet.forecast.currentPeriodAction.bills || []).find(r => r.id === CLOUD.id && r.date === CLOUD.date);
  assert.ok(row, 'control: the packet lists the trusted bill');
  assert.equal(row.settlement, 'represented');
  assert.equal(row.settlementBasis, BASIS);
});
check('the Bills page label drops only the repeated status word, never the marker', () => {
  const Polish = require('../public/budget-polish');
  assert.equal(Polish.cleanBillLabel('Invented cloud · Feb 15 · PAID · trusted on due date (not seen)', 'PAID'),
    'Invented cloud · Feb 15 · trusted on due date (not seen)');
  assert.equal(Polish.cleanBillLabel('Invented cloud · Feb 15 · PAID', 'PAID'), 'Invented cloud · Feb 15');
});

console.log('\n=== scope: a seen payment never carries the marker; a row that is not PAID drops it ===');
check('a seen, linked payment prints Paid without the marker', () => {
  const { view, bill } = observed(input({ rules: [PAYROLL_RULE, payee(STREAM.id, 'Invented Stream Co'), payee(CLOUD.id, 'Invented Cloud Co')],
    extra: [['invented-stream-1', 'invented-account-0', STREAM.date, '30.00', 'Invented Stream Co'],
      ['invented-cloud-1', 'invented-account-0', CLOUD.date, '7.00', 'Invented Cloud Co']] }));
  for (const [start, want] of [[START, STREAM], [NEXT_START, CLOUD]]) {
    const row = bill(start, want);
    assert.equal(row.status, 'PAID');
    assert.equal(row.settlementBasis, undefined);
    const html = rowHtml(PAGE.bills(view(start)), want.id);
    assert.match(html, />Paid</);
    assert.doesNotMatch(html, /Trusted on due date/);
  }
});
check('a forged basis on an unrelated field shape is ignored: only the exact value marks a row', () => {
  const refreshed = Live.fromObservation(clone(input()));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  for (const e of options.currentPeriodActuals.representedActuals) if (e.id === CLOUD.id) e.settlementBasis = 'seen';
  const advice = Forecast.recommend(refreshed.data.plan, NEXT_START, options);
  const row = advice.payPeriodViews.find(p => p.start === NEXT_START).bills.find(r => r.id === CLOUD.id);
  assert.equal(row.settlementBasis, undefined);
});

console.log(`\nAll ${passed} schedule-trust marker proofs passed.`);
