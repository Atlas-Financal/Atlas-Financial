'use strict';
// #821 finding 11, the trust marker (Grok Bot ruling, Plan #6 thread,
// 2026-11-11): "If any bill inside a total was only trusted-paid, the total
// should read 'estimated', not 'calculated'. It must not change any figure."
// A bill settled only by an owner schedule-trust rule keeps that basis on
// representedEvents, so the payday shell's bills load ("Bills & required
// minimums") and everything taken after it ("Truly unassigned", extra debt,
// optional plans) read estimated. Every amount is unchanged.
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
const cloudDebit = (date, amount, account = 'invented-account-0') =>
  ['invented-cloud-debit', account, date, amount, 'Invented Cloud Co'];

function input({ day = NEXT_START, rules = [PAYROLL_RULE, trust(STREAM.id), trust(CLOUD.id)], extra = [], moreBills = [] } = {}) {
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
        ...moreBills,
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
const isDebit = t => t.amount === 7 || t.amount === '7.00';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  PASS  ' + name); };
const stripMarker = data => {
  const out = clone(data);
  for (const list of [out.plan.opening && out.plan.opening.representedEvents, out.liveOverlay && out.liveOverlay.representedEvents]) {
    for (const row of list || []) delete row.settlementBasis;
  }
  return out;
};
// Every number in an advice packet, by path. Trust words are not numbers.
function numbers(node, at = '', out = new Map()) {
  if (typeof node === 'number') out.set(at, node);
  else if (Array.isArray(node)) node.forEach((item, i) => numbers(item, at + '[' + i + ']', out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) numbers(v, at + '.' + k, out);
  return out;
}
const advise = data => {
  const options = Operating.recommendOpts(data, {});
  options.periods = [];
  return Forecast.recommend(data.plan, NEXT_START, options);
};
const SHELL_AFTER_BILLS = ['obligations', 'remainder', 'extraDebt', 'optional'];

console.log('\n=== the trust basis rides on representedEvents ===');
check('trusted entries carry settlementBasis on the opening and the live overlay; a seen payment does not', () => {
  const trusted = observed(input());
  for (const list of [trusted.refreshed.data.plan.opening.representedEvents, trusted.refreshed.data.liveOverlay.representedEvents]) {
    for (const want of [STREAM, CLOUD]) {
      const row = list.find(r => r.id === want.id && r.date === want.date);
      assert.ok(row, 'control: the occurrence is represented');
      assert.equal(row.settlementBasis, BASIS, want.id + ' is marked trusted, not seen');
    }
  }
  const seen = observed(input({ rules: [PAYROLL_RULE, trust(STREAM.id),
    { eventId: CLOUD.id, payeePattern: 'Invented Cloud Co', atlasAccountId: 'chequing-a', direction: 'debit' }],
  extra: [cloudDebit(CLOUD.date, '7.00')] }));
  const row = seen.refreshed.data.plan.opening.representedEvents.find(r => r.id === CLOUD.id && r.date === CLOUD.date);
  assert.ok(row, 'control: the seen occurrence is represented');
  assert.equal(Object.hasOwn(row, 'settlementBasis'), false, 'a seen payment never carries the trust marker');
});

console.log('\n=== a total holding a trust-settled bill reads estimated ===');
check('the bills load and everything after it are estimated with a trusted bill, calculated without one', () => {
  const trusted = observed(input());
  const control = observed(input({ rules: [PAYROLL_RULE] }));
  for (const key of SHELL_AFTER_BILLS) {
    assert.equal(trusted.shell[key], 'estimated', key + ' holds a trust-settled bill');
    assert.equal(control.shell[key], 'calculated', 'control: ' + key + ' without a trust rule');
  }
  assert.equal(trusted.shell.available, 'calculated', 'observed cash is not a trust assumption');
  assert.equal(trusted.shell.household, control.shell.household, 'the household hold settles no bill');
});
check('a fully seen period stays calculated: only a trusted-only key weakens the totals', () => {
  const seen = observed(input({ rules: [PAYROLL_RULE,
    { eventId: STREAM.id, payeePattern: 'Invented Stream Co', atlasAccountId: 'chequing-a', direction: 'debit' },
    { eventId: CLOUD.id, payeePattern: 'Invented Cloud Co', atlasAccountId: 'chequing-a', direction: 'debit' }],
  extra: [['invented-stream-debit', 'invented-account-0', STREAM.date, '30.00', 'Invented Stream Co'], cloudDebit(CLOUD.date, '7.00')] }));
  for (const key of SHELL_AFTER_BILLS) assert.equal(seen.shell[key], 'calculated', key + ': every bill was seen');
});

console.log('\n=== it must not change any figure ===');
check('every number in the advice is identical with and without the trust marker', () => {
  const data = observed(input()).refreshed.data;
  const marked = numbers(advise(clone(data)));
  const unmarked = numbers(advise(stripMarker(data)));
  assert.ok(marked.size > 100, 'control: the comparison covers the published numbers (' + marked.size + ')');
  assert.deepEqual([...marked.keys()].sort(), [...unmarked.keys()].sort(), 'the same figures are published');
  for (const [at, value] of marked) assert.equal(value, unmarked.get(at), at + ' moved');
  const markedShell = advise(clone(data)).paydayShellTrust, unmarkedShell = advise(stripMarker(data)).paydayShellTrust;
  assert.equal(markedShell.obligations, 'estimated');
  assert.equal(unmarkedShell.obligations, 'calculated', 'control: without the marker the tag is the incumbent calculated');
});

console.log('\n=== merge: seen evidence supersedes a carried trust marker ===');
check('an opening that carried the occurrence as trusted drops the marker once the debit is seen', () => {
  const src = input({ rules: [PAYROLL_RULE, trust(STREAM.id),
    { eventId: CLOUD.id, payeePattern: 'Invented Cloud Co', atlasAccountId: 'chequing-a', direction: 'debit' }],
  extra: [cloudDebit(CLOUD.date, '7.00')] });
  src.data.plan.opening.representedEvents = [{ id: CLOUD.id, date: CLOUD.date, effectiveAsOf: CLOUD.date, settlementBasis: BASIS }];
  const row = Live.fromObservation(clone(src)).data.plan.opening.representedEvents.find(r => r.id === CLOUD.id && r.date === CLOUD.date);
  assert.ok(row);
  assert.equal(Object.hasOwn(row, 'settlementBasis'), false);
});

console.log(`\nAll ${passed} trusted-total-estimated proofs passed.`);
