'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe');
const fixture = require('./fixtures/forecast-bill-classification');
const canonicalBefore = fs.readFileSync(require.resolve('../data.json'));
function run(x = fixture()) {
  const before = JSON.stringify(x);
  const overlay = Live.fromObservation(x);
  assert.equal(JSON.stringify(x), before, 'observation and Forecast do not mutate inputs');
  const packet = overlay.report.currentPeriodActuals;
  const advice = F.recommend(overlay.data.plan, x.asOf, { debts: overlay.data.debts, currentPeriodActuals: packet });
  const period = advice.payPeriodViews.find(p => p.start === '2026-09-18');
  const other = period.householdBudget.find(b => b.otherSpending);
  return { ...overlay, packet, advice, period, other };
}
const bill = (r, id) => r.advice.defaultView.bills.find(b => b.id === id);
const classify = tx => F.classifyCurrentPeriodTransaction(tx, fixture().data.plan);
test('Telephone and Telecom have identical bill treatment through sanitized Forecast actuals', () => {
  const x = fixture();
  x.payload.transactions[0].category_name = 'Telecom';
  const telecom = run(x), telephone = run();
  assert.equal(telephone.other.spent, telecom.other.spent);
  for (const label of ['Telephone', 'telephone', ' TELEPHONE ', 'Telecom']) {
    assert.deepEqual(classify({ categoryLabel: label, amount: 19, account: 'chequing-a' }),
      classify({ categoryLabel: 'Telecom', amount: 19, account: 'chequing-a' }));
  }
  assert.equal(telephone.packet.transactions[0].displayedPayee, undefined,
    'bill merchant text is removed by the incumbent sanitizer');
  for (const label of ['Telephone accessories', 'Telecommunications shop', 'Shopping']) {
    assert.equal(classify({ categoryLabel: label, amount: 19 }).householdSpending, true);
  }
});
test('HELOC issuer interest is excluded; only the Bills payment settles the cash obligation', () => {
  const r = run();
  const interest = r.packet.transactions.find(t => t.atlasAccountId === 'heloc' && t.amount === 83);
  assert.equal(classify(interest).kind, 'interest');
  assert.equal(interest.helocFinanceChargeIdentity, true);
  assert.equal(interest.cardFinanceChargeIdentity, false, 'HELOC is not promoted to a revolving card');
  assert.equal(interest.displayedPayee, undefined);
  assert.equal(interest.originalMerchant, undefined);
  const hit = r.report.representedEventCandidates.filter(c => c.id === 'heloc');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].observedAmount, 91);
  assert.equal(hit[0].atlasAccountId, 'chequing-a');
  assert.equal(bill(r, 'heloc').actual, 91);
  assert.equal(bill(r, 'heloc').remaining, 0);
  assert.equal(r.other.recon.some(t => t.id === interest.id), false);
  const noPayment = fixture();
  noPayment.payload.transactions = noPayment.payload.transactions.filter(t => ![91003, 91004].includes(t.id));
  const unpaid = run(noPayment);
  assert.equal(unpaid.report.representedEventCandidates.some(c => c.id === 'heloc'), false);
  assert.notEqual(bill(unpaid, 'heloc').status, 'PAID', 'the line-side charge alone is not payment');
  assert.equal(bill(unpaid, 'heloc').remaining, 85);
});
test('finance-charge exclusion is limited to the mapped HELOC and preserves income/refund precedence', () => {
  for (const account of ['chequing-a', 'chequing-b', 'invented-loan']) {
    assert.notEqual(classify({ account, amount: 83, payee: 'INTEREST' }).kind, 'interest');
  }
  for (const payee of ['Invented Interest Books', 'INTERESTED MERCHANT', 'ANNUAL FEE', 'Invented purchase']) {
    assert.notEqual(classify({ account: 'heloc', amount: 83, payee }).kind, 'interest');
  }
  assert.equal(classify({ account: 'heloc', amount: -83, payee: 'INTEREST' }).kind, 'refund');
  assert.equal(classify({ account: 'heloc', amount: -83, payee: 'INTEREST', isIncome: true }).kind, 'income');
  assert.equal(classify({ account: 'heloc', amount: 83, payee: 'INTEREST', accountRole: 'household-external' }).kind, 'external');
  assert.equal(classify({ account: 'travelvisa', amount: 83, payee: 'INTEREST' }).reason, 'revolving-finance-charge');
});
test('renamed Google One without recurring identity settles the nearest month-end occurrence two days early', () => {
  for (const original of ['SERVICE _V', 'Invented preserved bank descriptor', undefined]) for (const recurring of [null, undefined]) {
    const x = fixture(); const tx = x.payload.transactions[4];
    if (original === undefined) delete tx.original_name;
    else tx.original_name = original;
    if (recurring === undefined) delete tx.recurring_id;
    const r = run(x);
    const hits = r.report.representedEventCandidates.filter(c => c.id === 'google-storage-100gb');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].date, '2026-09-30', 'never settles the preceding month');
    assert.equal(bill(r, 'google-storage-100gb').status, 'PAID');
    assert.equal(bill(r, 'google-storage-100gb').actual, 4);
    assert.equal(bill(r, 'google-storage-100gb').remaining, 0);
  }
  const old = fixture();
  Object.assign(old.payload.transactions[4], { payee: 'Google', original_name: 'SERVICE _V', date: '2026-09-29' });
  assert.equal(bill(run(old), 'google-storage-100gb').status, 'PAID', 'incumbent descriptor match is preserved');
});
test('Google identity retains descriptor, account, product, direction, currency and ambiguity guards', () => {
  for (const mutate of [
    t => { t.payee = 'Invented unrelated merchant'; },
    t => { t.payee = 'Google Play'; },
    t => { t.payee = 'YouTube Google'; },
    t => { t.original_name = 'Google Play'; },
    t => { t.payee = 'Bill - Google One extras'; },
    t => { t.payee = 'Google'; delete t.original_name; },
    t => { t.account_id = 3001; },
    t => { t.amount = -4; },
    t => { t.currency = 'usd'; },
    t => { t.is_pending = true; t.date = '2026-09-30'; },
    t => { t.date = '2026-09-27'; },
  ]) {
    const x = fixture(); mutate(x.payload.transactions[4]);
    const r = run(x);
    assert.equal(r.report.representedEventCandidates.some(c => c.id === 'google-storage-100gb' && c.date === '2026-09-30'), false);
    assert.notEqual(bill(r, 'google-storage-100gb').status, 'PAID');
  }
  for (const mutate of [
    x => x.payload.transactions.push({ ...x.payload.transactions[4], id: 91007 }),
    x => { x.payload.transactionWindow.complete = false; x.payload.transactionWindow.truncated = true; },
  ]) {
    const x = fixture(); mutate(x); const r = run(x);
    assert.notEqual(bill(r, 'google-storage-100gb').status, 'PAID');
  }
});
test('renamed storage identity selects one occurrence across neighboring monthly cycles', () => {
  for (const [postedOn, occurrence] of [
    ['2026-09-28', '2026-09-30'], ['2026-09-30', '2026-09-30'],
    ['2026-10-01', '2026-09-30'], ['2026-11-28', '2026-11-30'],
  ]) {
    const x = fixture();
    x.asOf = postedOn > x.asOf ? postedOn : x.asOf;
    x.payload.transactionWindow.endDate = x.asOf;
    x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
    x.payload.accounts.forEach(a => { a.updated_at = x.asOf + 'T17:00:00Z'; });
    Object.assign(x.payload.transactions[4], { date: postedOn, original_name: 'SERVICE _V' });
    const report = O.observe({ provider: 'lunchmoney', payload: x.payload,
      accountMap: x.accountMap, data: x.data, identity: x.identity });
    const hits = report.representedEventCandidates.filter(c => c.id === 'google-storage-100gb');
    assert.equal(hits.length, 1, 'legacy and renamed rules cannot consume the same transaction twice');
    assert.equal(hits[0].date, occurrence);
  }
});
test('independent cash/debt ledger and Other membership close once across all three fixes and replay', () => {
  const r = run();
  assert.equal(r.other.spent, 7, 'only the invented unrelated purchase belongs to Other');
  assert.equal(r.other.recon.length, 1);
  // Independent stock ledger: 500 - 19 - 91 + 200 - 4 - 7 = 579 cash.
  // Line principal: 1000 + 83 issuer interest - 91 payment = 992 debt.
  const stocks = r.data.plan.startingCash.breakdown;
  assert.equal(stocks.find(a => a.id === 'chequing-a').value, 390);
  assert.equal(stocks.find(a => a.id === 'chequing-b').value, 189);
  assert.equal(stocks.reduce((sum, a) => sum + a.value, 0), 579);
  assert.equal(r.data.debts.find(d => d.id === 'heloc').balance, 992);
  assert.equal(r.period.periodBillLoad, 108, 'planned phone 19 + line minimum 85 + storage 4, each once');
  assert.equal(bill(r, 'heloc').planned, 85, 'actual payment does not rewrite the scheduled minimum');
  assert.ok(O.currentPeriodActualsLooksSanitized(r.packet));
  assert.deepEqual(run().packet, r.packet, 'repeated observation does not double count');
  assert.deepEqual(fs.readFileSync(require.resolve('../data.json')), canonicalBefore);
});
