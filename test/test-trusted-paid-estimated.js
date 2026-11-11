'use strict';
// #821 finish-line audit finding 11, as cut down by the Grok Bot ruling:
// a bill occurrence PAID only by an owner schedule-trust rule ("Trusted on
// due date (not seen)") reads estimated, never calculated. Only a confirmed
// tag weakens to estimated; an absent, blank, unknown or unavailable tag is
// left exactly as supplied, so no figure aggregated from the row becomes
// more certain. A payment the observer actually saw keeps its own tag.
// Settlement itself is unchanged. Entirely invented finances and identities;
// no data.json, no credentials.
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

console.log('\n=== a trusted PAID row reads estimated; a seen one keeps its tag ===');
check('the trusted bill still settles PAID, now estimated; the same bill seen stays confirmed', () => {
  const trusted = observed(input());
  const seen = observed(input({ rules: [PAYROLL_RULE, trust(STREAM.id),
    { eventId: CLOUD.id, payeePattern: 'Invented Cloud Co', atlasAccountId: 'chequing-a', direction: 'debit' }],
  extra: [cloudDebit(CLOUD.date, '7.00')] }));
  for (const want of [STREAM, CLOUD]) {
    assert.equal(trusted.row(want).status, 'PAID', want.id + ': settlement unchanged');
    assert.equal(trusted.row(want).settlementBasis, BASIS);
    assert.equal(trusted.row(want).confidence, 'estimated', want.id + ': confirmed weakens to estimated');
  }
  assert.equal(seen.row(CLOUD).status, 'PAID');
  assert.equal(Object.hasOwn(seen.row(CLOUD), 'settlementBasis'), false, 'control: seen, not trusted');
  assert.equal(seen.row(CLOUD).confidence, 'confirmed', 'a seen payment keeps its own tag');
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


console.log(`\nAll ${passed} trusted-paid-estimated proofs passed.`);
