'use strict';
// Finding 11 (#821 finish-line audit): an occurrence settled only by an owner
// schedule-trust rule ("Trusted on due date (not seen)") is counted once.
//   (a) It is marked on representedEvents, so it is never read as bank
//       evidence; a trust rule with optional match fields links a later
//       real debit to the bill instead of leaving it as ordinary spending.
//   (b) Wherever it settles a figure, that figure is estimated, never
//       calculated.
//   (c) With match fields, the bill stays in the load until its debit is
//       seen (exact scheduled amount, paying account, due date to two days
//       after); only a closed window with no match falls back to trust.
// A trust rule without match fields keeps its incumbent settlement.
// Entirely invented finances and identities; no data.json, no credentials.
const assert = require('node:assert/strict');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');

// Biweekly payroll anchored 2030-02-01; the current cycle starts 02-15.
// Invented monthly bills: stream 30.00 due 02-05, cloud 7.00 due 02-15.
const START = '2030-02-01', NEXT_START = '2030-02-15';
const STREAM = { id: 'invented-stream', date: '2030-02-05', amount: 30 };
const CLOUD = { id: 'invented-cloud', date: '2030-02-15', amount: 7 };
const BASIS = 'schedule-trust-on-due';
const clone = value => JSON.parse(JSON.stringify(value));
const PAYROLL_RULE = { eventId: 'payroll', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' };
const trust = id => ({ eventId: id, settlesWhen: BASIS });
const matched = (id, pattern) => ({ eventId: id, settlesWhen: BASIS, payeePattern: pattern,
  atlasAccountId: 'chequing-a', direction: 'debit' });
const MATCHED = [PAYROLL_RULE, matched(STREAM.id, 'Invented Stream Co'), matched(CLOUD.id, 'Invented Cloud Co')];
const cloudDebit = (date, amount, account = 'invented-account-0') =>
  ['invented-cloud-debit', account, date, amount, 'Invented Cloud Co'];

function input({ day = NEXT_START, rules = [PAYROLL_RULE, trust(STREAM.id), trust(CLOUD.id)], extra = [] } = {}) {
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

function observed(source, day = NEXT_START) {
  const refreshed = Live.fromObservation(clone(source));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const advice = Forecast.recommend(refreshed.data.plan, day, options);
  const current = advice.payPeriodViews.find(p => p.start <= day && day <= p.end);
  const row = want => advice.payPeriodViews.flatMap(p => p.bills).find(r => r.id === want.id && r.date === want.date);
  const actuals = options.currentPeriodActuals;
  const spending = (actuals.transactions || []).filter(t =>
    Forecast.classifyCurrentPeriodTransaction(t, refreshed.data.plan, options)?.householdSpending === true);
  return { refreshed, options, advice, current, row, spending,
    alloc: advice.paydayAllocation, shell: advice.paydayShellTrust,
    entry: want => (actuals.representedActuals || []).find(r => r.id === want.id && r.date === want.date),
    represented: list => list.find(r => r.id === CLOUD.id && r.date === CLOUD.date) };
}
// The independent load: every bill still owed in this fixture, from its
// literal scheduled amount above (never read back from Forecast).
const loadOf = (...bills) => bills.reduce((sum, bill) => sum + bill.amount, 0);
const isDebit = t => t.amount === 7 || t.amount === '7.00';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  PASS  ' + name); };

console.log('\n=== (a) the trusted occurrence is marked on representedEvents ===');
check('trusted entries carry settlementBasis on the opening and the live overlay; a seen payment does not', () => {
  const trusted = observed(input());
  for (const list of [trusted.refreshed.data.plan.opening.representedEvents, trusted.refreshed.data.liveOverlay.representedEvents]) {
    for (const want of [STREAM, CLOUD]) {
      const row = list.find(r => r.id === want.id && r.date === want.date);
      assert.ok(row, 'control: the occurrence is represented');
      assert.equal(row.settlementBasis, BASIS, want.id + ' is marked trusted, not seen');
    }
  }
  const seen = observed(input({ rules: MATCHED, extra: [cloudDebit(CLOUD.date, '7.00')] }));
  const row = seen.represented(seen.refreshed.data.plan.opening.representedEvents);
  assert.ok(row, 'control: the seen occurrence is represented');
  assert.equal(Object.hasOwn(row, 'settlementBasis'), false, 'a seen payment never carries the trust marker');
});

console.log('\n=== incumbent rule (no match fields): settlement unchanged, now estimated ===');
check('the trusted bill still settles; the bills load and the remainder are estimated, not calculated', () => {
  const trusted = observed(input());
  const control = observed(input({ rules: [PAYROLL_RULE] }));
  assert.equal(trusted.row(CLOUD).status, 'PAID');
  assert.equal(trusted.row(CLOUD).settlementBasis, BASIS);
  assert.equal(trusted.row(CLOUD).confidence, 'estimated', 'the trusted row is estimated');
  assert.equal(control.alloc.obligations.allocated, loadOf(STREAM, CLOUD), 'control: both bills owed without the rule');
  assert.equal(trusted.alloc.obligations.allocated, 0, 'incumbent trust settlement is unchanged');
  for (const key of ['obligations', 'remainder', 'extraDebt', 'optional']) {
    assert.equal(trusted.shell[key], 'estimated', key + ' rests on a trust assumption');
    assert.equal(control.shell[key], 'calculated', 'control: ' + key + ' stays calculated without trust');
  }
  assert.equal(trusted.shell.available, 'calculated', 'observed cash is not a trust assumption');
});

console.log('\n=== (c) with match fields the bill stays in the load until its debit is seen ===');
check('due today, no debit: the cloud bill is still due and its scheduled amount stays in the load', () => {
  const waiting = observed(input({ rules: MATCHED }));
  assert.notEqual(waiting.row(CLOUD).status, 'PAID');
  assert.equal(waiting.entry(CLOUD), undefined, 'nothing settles it while its window is open');
  assert.equal(waiting.alloc.obligations.allocated, loadOf(CLOUD), 'the 7.00 bill is reserved; the closed-window stream is trusted');
  assert.equal(waiting.row(STREAM).settlementBasis, BASIS, 'a closed window with no match falls back to trust');
});
check('a debit up to two days late is still waited for, and then matched', () => {
  const waiting = observed(input({ day: '2030-02-17', rules: MATCHED }), '2030-02-17');
  assert.notEqual(waiting.row(CLOUD).status, 'PAID', 'day +2, no debit: still waiting');
  const late = observed(input({ day: '2030-02-17', rules: MATCHED, extra: [cloudDebit('2030-02-17', '7.00')] }), '2030-02-17');
  assert.equal(late.row(CLOUD).status, 'PAID');
  assert.equal(late.entry(CLOUD).transactionId != null, true, 'settled by the seen transaction');
  assert.equal(late.spending.some(isDebit), false);
  const after = observed(input({ day: '2030-02-18', rules: MATCHED }), '2030-02-18');
  assert.equal(after.row(CLOUD).settlementBasis, BASIS, 'day +3 with no debit: the trust settles it');
});

console.log('\n=== (a) a real debit is matched to the bill, not counted again ===');
check('the exact debit on the paying account settles the bill as seen and is not ordinary spending', () => {
  const before = observed(input({ extra: [cloudDebit(CLOUD.date, '7.00')] }));
  assert.equal(before.row(CLOUD).settlementBasis, BASIS, 'control: incumbent rule cannot link the debit');
  assert.equal(before.spending.some(isDebit), true, 'control: the incumbent counts the same 7.00 again as spending');
  const seen = observed(input({ rules: MATCHED, extra: [cloudDebit(CLOUD.date, '7.00')] }));
  assert.equal(seen.row(CLOUD).status, 'PAID');
  assert.equal(Object.hasOwn(seen.row(CLOUD), 'settlementBasis'), false, 'seen, not trusted');
  assert.ok(seen.entry(CLOUD).transactionId, 'the representedActual names the debit');
  assert.equal(seen.spending.some(isDebit), false, 'the debit is the bill, counted once');
});
check('a wrong amount, a wrong account or a debit three days late never settles the bill', () => {
  for (const [label, extra, day] of [
    ['wrong amount', cloudDebit(CLOUD.date, '9.00'), NEXT_START],
    ['wrong account', cloudDebit(CLOUD.date, '7.00', 'invented-account-1'), NEXT_START],
    ['three days late', cloudDebit('2030-02-18', '7.00'), '2030-02-18']]) {
    const miss = observed(input({ day, rules: MATCHED, extra: [extra] }), day);
    assert.equal(miss.entry(CLOUD)?.transactionId, undefined, label + ': no transaction settles it');
    if (day === NEXT_START) {
      assert.notEqual(miss.row(CLOUD).status, 'PAID', label + ': still due');
      assert.equal(miss.alloc.obligations.allocated, loadOf(CLOUD), label + ': still reserved');
    }
  }
});

check('a trust rule with a payee but not the full match fields keeps its incumbent identity path', () => {
  // Incumbent: a payee on a trust rule links a payee debit as seen.
  const partial = observed(input({ rules: [PAYROLL_RULE, trust(STREAM.id),
    { eventId: CLOUD.id, settlesWhen: BASIS, payeePattern: 'Invented Cloud Co' }],
  extra: [cloudDebit(CLOUD.date, '7.00')] }));
  assert.equal(partial.row(CLOUD).status, 'PAID');
  assert.ok(partial.entry(CLOUD).transactionId, 'settled by the payee debit, as on main');
  assert.equal(partial.spending.some(isDebit), false);
});

console.log('\n=== merge: seen evidence supersedes a carried trust marker ===');
check('an opening that carried the occurrence as trusted drops the marker once the debit is seen', () => {
  const src = input({ rules: MATCHED, extra: [cloudDebit(CLOUD.date, '7.00')] });
  src.data.plan.opening.representedEvents = [{ id: CLOUD.id, date: CLOUD.date, effectiveAsOf: CLOUD.date, settlementBasis: BASIS }];
  const row = observed(src).represented(Live.fromObservation(clone(src)).data.plan.opening.representedEvents);
  assert.ok(row);
  assert.equal(Object.hasOwn(row, 'settlementBasis'), false);
});

console.log('\n=== (b) a trusted settlement never makes any trust word more certain ===');
// Rank every published trust word: calculated/confirmed > estimated > any
// other value (unknown, unavailable, '', null). The control settles the same
// bill as SEEN (a payee rule and a posted debit on its due date), which is
// how main published a trusted occurrence: no marker, the bill's own tag.
const RANK = value => value === 'calculated' || value === 'confirmed' ? 2 : value === 'estimated' ? 1 : 0;
const TRUST_KEY = /(^trust$|Trust$|^confidence$|Confidence$)/;
function trustWords(advice) {
  const out = new Map();
  const walk = (node, at) => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, at + '[' + (item && item.id ? item.id + '@' + (item.date || item.start || '') : i) + ']')); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (TRUST_KEY.test(key) && (value === null || typeof value === 'string')) out.set(at + '.' + key, value);
      else if (value && typeof value === 'object') walk(value, at + '.' + key);
    }
  };
  walk({ payPeriodViews: advice.payPeriodViews, paydayAllocation: advice.paydayAllocation,
    paydayShellTrust: advice.paydayShellTrust }, '');
  return out;
}
for (const [label, edit] of [
  ['unknown-amount (never trusted: no scheduled amount)', bill => { delete bill.amount; }],
  ['unavailable', bill => { bill.confidence = 'unavailable'; }],
  ['unknown', bill => { bill.confidence = 'unknown'; }],
  ['blank', bill => { bill.confidence = ''; }],
]) {
  check(label + ' trusted bill: its row keeps its own tag and no trust word is more certain than the seen control', () => {
    const withBill = src => { src.data.plan.bills.filter(b => b.id === CLOUD.id).forEach(edit); return src; };
    const trusted = observed(withBill(input({ rules: [PAYROLL_RULE, trust(STREAM.id), trust(CLOUD.id)] })));
    const seen = observed(withBill(input({ rules: [PAYROLL_RULE, trust(STREAM.id),
      { eventId: CLOUD.id, payeePattern: 'Invented Cloud Co', atlasAccountId: 'chequing-a', direction: 'debit' }],
    extra: [cloudDebit(CLOUD.date, '7.00')] })));
    const own = trusted.refreshed.data.plan.bills.find(b => b.id === CLOUD.id).confidence;
    const row = trusted.row(CLOUD);
    if (row) assert.equal(row.confidence ?? null, own ?? null, 'a less certain tag is never replaced');
    const head = trustWords(trusted.advice), control = trustWords(seen.advice);
    let compared = 0;
    for (const [at, word] of head) {
      if (!control.has(at)) continue;
      compared++;
      assert.ok(RANK(word) <= RANK(control.get(at)),
        at + ': trusted "' + word + '" is more certain than seen "' + control.get(at) + '"');
    }
    assert.ok(compared > 10, 'control: the walk compared the published trust words (' + compared + ')');
  });
}

console.log(`\nAll ${passed} trusted-not-seen proofs passed.`);
