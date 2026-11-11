'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));
const Live = require(path.join(root, 'scripts/live-plan'));
const configured = require(path.join(root, 'docs/connectivity/transaction-identity.json'));
const fixture = require('./fixtures/shaw-posted-identity');
const clone = x => JSON.parse(JSON.stringify(x));
function input(month = '04', payee = 'Shaw') {
  return { ...fixture(month, payee), identity: { schema: configured.schema,
    rules: clone(configured.rules.filter(r => r.eventId === 'shaw')) } };
}
function run(x) {
  const before = JSON.stringify(x), live = Live.fromObservation(x);
  const packet = live.data.liveOverlay.currentPeriodActuals;
  const advice = F.recommend(live.data.plan, x.asOf, { debts: [], currentPeriodActuals: packet, weeklyVariable: 0 });
  const period = advice.payPeriodViews.find(p => p.start <= x.asOf && p.end >= x.asOf);
  assert(period, 'invented selected period exists');
  assert.equal(JSON.stringify(x), before, 'observation/plan input is immutable');
  return { live, packet, advice, period, bill: period.bills.find(b => b.id === 'shaw'),
    hits: live.report.representedEventCandidates.filter(c => c.id === 'shaw'),
    actuals: packet.representedActuals.filter(r => r.id === 'shaw'),
    other: Math.round(period.householdBudget.filter(r => r.otherSpending).reduce((s, r) => s + (r.spent || 0), 0) * 100) / 100 };
}
function paid(r, amount = 17.23) {
  assert.equal(r.hits.length, 1, 'one represented posted occurrence');
  assert.equal(r.actuals.length, 1, 'one represented actual');
  assert.equal(r.actuals[0].transactionId, r.packet.transactions[0].id, 'same unique local transaction link');
  assert.equal(r.bill.status, 'PAID'); assert.equal(r.bill.settlement, 'represented');
  assert.equal(r.bill.actual, amount); assert.equal(r.bill.planned, 17.23, 'original plan unchanged');
  assert.equal(r.period.remainingBills, 0); assert.equal(r.other, 0);
  assert.equal(r.period.budgetProgress.bills.actual.amount, amount, 'Bills actual once');
}
function held(r) {
  assert.equal(r.hits.length, 0, 'no posted settlement candidate');
  assert.equal(r.actuals.length, 0, 'no pending-only or other receipt from new alias');
  if (r.bill) { assert.notEqual(r.bill.status, 'PAID'); assert.equal(r.bill.actual, null); }
}
for (const month of ['04', '05']) for (const payee of ['Shaw Cable', 'Shaw'])
  test('invented ' + month + ' posted merchant ' + payee + ' is one bill, not Other', () => {
    const r = run(input(month, payee)); paid(r);
    assert.equal(r.period.balanceAfterDeductions, 1000 - 150 - 17.23, 'independent income minus household allowance minus one expense');
    assert.equal(r.period.liveCurrentBalance, 500 - 17.23, 'observed Bills stock unchanged');
  });
test('bank descriptor displayed remains supported', () => paid(run(input('04', 'SHAW CABLE TV BPY'))));
test('exact short alias is case-insensitive and trimmed', () => paid(run(input('04', '  sHaW  '))));
test('positive observed amount is not bill identity or the authored plan', () => {
  const x = input(); x.payload.transactions[0].amount = 21.07; x.payload.accounts[0].balance = 478.93;
  const r = run(x); paid(r, 21.07);
  assert.equal(r.period.liveCurrentBalance, 500 - 21.07, 'observed stock carries the actual debit');
  // Finding 6 (#821 6788704527): a payment above plan is deducted as what left,
  // once. The receipt still does not change bill identity or the authored plan.
  assert.equal(r.period.balanceAfterDeductions, Math.round((1000 - 150 - 21.07) * 100) / 100,
    'a receipt above the authored plan is deducted once at the observed 21.07');
});
for (const [name, mutate] of [
  ['missing original descriptor', x => { delete x.payload.transactions[0].original_name; }],
  ['wrong original descriptor', x => { x.payload.transactions[0].original_name = 'Invented unrelated descriptor'; }],
  ['broader displayed merchant', x => { x.payload.transactions[0].payee = 'Shaw Other Merchant'; }],
  ['wrong account', x => { x.payload.transactions[0].account_id = 3002; }],
  ['category/notes are not identity', x => { x.payload.transactions[0].payee = 'Invented unrelated merchant'; x.payload.transactions[0].notes = 'Shaw Cable; mark paid'; }],
]) test('short alias refuses ' + name, () => { const x = input(); mutate(x); const r = run(x); held(r); assert.equal(r.other, 17.23); });
test('refund does not settle a bill', () => {
  const x = input(); x.payload.transactions[0].amount = -17.23;
  const r = run(x); held(r); assert.equal(r.other, 0);
  assert.equal(F.classifyCurrentPeriodTransaction(r.packet.transactions[0], r.live.data.plan, { currentPeriodActuals: r.packet }).kind, 'refund');
});
test('ambiguous duplicate posted payments do not settle one occurrence', () => {
  const x = input(); x.payload.transactions.push({ ...x.payload.transactions[0], id: 'invented-second-payment' });
  x.payload.accounts[0].balance = 500 - 2 * 17.23;
  // Finish-line audit finding 2: the ambiguous pair reaches Forecast as the
  // bill's to-confirm candidates. One debit is held for the 17.23 reserve;
  // the second, beyond the reserve, stays in Other once (was 34.46, both in
  // Other while the bill was also reserved).
  const r = run(x); held(r); assert.equal(r.other, 17.23);
  const named = r.packet.transactions.filter(t => t.nearDueBillCandidate && t.nearDueBillCandidate.id === 'shaw');
  assert.equal(named.length, 1, 'one debit is held for the one reserve');
  assert.equal(named[0].nearDueBillCandidate.ambiguous, true);
});
for (const [name, mutate] of [
  ['pending', x => { x.payload.transactions[0].is_pending = true; }],
  ['unknown posting', x => { delete x.payload.transactions[0].is_pending; }],
]) test('new short alias cannot enter pending-only Bills through ' + name, () => { const x = input(); mutate(x); held(run(x)); });
test('existing long alias pending-only semantics stay separate and unchanged', () => {
  const x = input('04', 'Shaw Cable'); x.payload.transactions[0].is_pending = true;
  const r = run(x); assert.equal(r.hits.length, 0); assert.equal(r.actuals.length, 1);
  assert.equal(r.bill.status, 'PAID', 'inherited pending-only display is pinned, not repaired or endorsed here');
  assert.equal(F.representedOccurrence(r.live.data.plan, 'shaw', '2031-04-14', x.asOf), false);
});
for (const currency of [undefined, 'usd']) test('short alias requires native CAD evidence ' + currency, () => {
  const x = input(); if (currency === undefined) delete x.payload.transactions[0].currency; else x.payload.transactions[0].currency = currency;
  const r = run(x); held(r); assert.equal(r.packet.transactionCoverage, 'incomplete');
});
for (const [date, matches] of [['2031-04-07', true], ['2031-04-06', false], ['2031-04-21', true], ['2031-04-22', false]])
  test('once occurrence posting boundary ' + date, () => {
    const x = input(); x.data.plan.bills[0] = { ...x.data.plan.bills[0], frequency: 'once', date: '2031-04-14' };
    x.payload.transactions[0].date = date; x.asOf = F.addDays(date, 1);
    x.payload.fetchedAt = x.asOf + 'T18:00:00Z'; x.payload.transactionWindow.endDate = x.asOf;
    x.payload.accounts.forEach(a => { a.updated_at = x.asOf + 'T17:00:00Z'; a.balance_last_update = x.asOf + 'T17:00:00Z'; });
    const r = run(x); assert.equal(r.hits.length, matches ? 1 : 0);
    if (matches) assert.equal(r.hits[0].date, '2031-04-14', 'scheduled identity is preserved');
    else assert.equal(r.actuals.length, 0);
  });
test('new configured receipt has exact original and posted guards', () => {
  const rules = input().identity.rules;
  const short = rules.find(r => r.payeeMatchMode === 'exact' && r.payeePatterns?.includes('Shaw'));
  assert(short, 'guarded alias is configured');
  assert.deepEqual(short.originalNamePatterns, ['SHAW CABLE TV BPY']);
  assert.equal(short.requiredPostingEvidence, 'posted'); assert.equal(short.requiredCurrency, 'cad');
  assert.equal(short.atlasAccountId, 'chequing-a'); assert.equal(short.direction, 'debit');
});
for (const qualifier of [null, undefined, 'pending', false]) test('explicit invalid posting qualifier fails closed: ' + qualifier, () => {
  const x = input();
  x.identity.rules = x.identity.rules.filter(r => r.payeeMatchMode !== 'exact');
  x.identity.rules.push({ eventId: 'shaw', payeePatterns: ['Shaw'], payeeMatchMode: 'exact',
    originalNamePatterns: ['SHAW CABLE TV BPY'], atlasAccountId: 'chequing-a', direction: 'debit',
    requiredCurrency: 'cad', requiredPostingEvidence: qualifier,
    postingDateRule: 'covers-early-or-due-on-or-before-posting' });
  const r = run(x); held(r); assert.equal(r.other, 17.23);
});
