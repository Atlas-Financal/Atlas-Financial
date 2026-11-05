'use strict';
// Invented cents reconcile identity, actuals, cash holds and published bill rows.
// Raw production observer: no fixture adapter supplies missing currency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const O = require('../scripts/provider-observe');
const F = require('../public/forecast');
const fx = require('./fixtures/utility-currency');
const identity = JSON.parse(fs.readFileSync(path.join(__dirname,
  '../docs/connectivity/transaction-identity.json'), 'utf8'));
// These invented final invoices differ from the estimated allowance. Qualify
// that fixture contract explicitly; raw native-unit admission stays unchanged.
for (const rule of identity.rules) {
  if (fx.cases.some(sample => sample.id === rule.eventId)) rule.settlesWhen = 'variable-amount';
}
const cents = x => Math.round(Number(x) * 100);
function observe(sample, rows) {
  const input = fx.build(sample, rows);
  return { input, report: O.observe({ provider: 'lunchmoney', identity, ...input }) };
}
const hits = (r, id) => (r.representedEventCandidates || []).filter(x => x.id === id);
const actuals = (r, id) => (r.currentPeriodActuals.representedActuals || []).filter(x => x.id === id);
function hold({ input, report }, sample) {
  const representedEvents = hits(report, sample.id).map(({ id, date }) => ({ id, date }));
  return F.expandEvents(input.data.plan, sample.due.slice(0, 7) + '-01', sample.asOf,
    { representedEvents }).filter(e => e.id === sample.id)
    .reduce((sum, e) => sum + cents(-e.amount), 0);
}
function action({ input, report }, sample) {
  const plan = fx.clone(input.data.plan);
  plan.opening.priorAsOf = plan.opening.asOf;
  plan.opening.asOf = sample.asOf;
  return F.recommend(plan, sample.asOf, { debts: [],
    currentPeriodActuals: report.currentPeriodActuals,
    representedEvents: hits(report, sample.id).map(({ id, date }) => ({ id, date }))
  }).currentPeriodAction;
}
function unsettled(result, sample, label, noActual = true) {
  assert.equal(hits(result.report, sample.id).length, 0, label + ': no posted settlement');
  if (noActual) assert.equal(actuals(result.report, sample.id).length, 0, label + ': no CAD actual');
  assert.equal(hold(result, sample), fx.PLANNED, label + ': independent scheduled cash hold');
}
function currencyRejected(result, sample, label) {
  unsettled(result, sample, label);
  const packet = result.report.currentPeriodActuals;
  assert.equal(packet.currencyUnconfirmed.length, 1, label + ': unit diagnostic survives');
  assert.equal(packet.transactionCoverage, 'incomplete', label + ': coverage fails closed');
  assert.equal(packet.transactions.length, 0, label + ': no imported CAD spending');
  const published = action(result, sample);
  const bill = published.bills.find(x => x.id === sample.id && x.date === sample.due);
  assert.ok(bill, label + ': live Forecast consumer retains occurrence');
  assert.equal(bill.settlement, 'unverified');
  assert.equal(bill.actual, null);
  assert.equal(cents(bill.remaining), fx.PLANNED);
  assert.equal(published.coverage.status, 'incomplete');
  assert.equal(published.remainingClaim, 'unavailable');
}
for (const sample of fx.cases) {
  const cad = observe(sample, [fx.transaction(sample)]);
  assert.equal(hits(cad.report, sample.id).length, 1, sample.id + ': positive identity control');
  assert.equal(actuals(cad.report, sample.id).length, 1);
  assert.equal(cents(actuals(cad.report, sample.id)[0].actual), fx.OBSERVED);
  assert.equal(actuals(cad.report, sample.id)[0].date, sample.due);
  assert.equal(hold(cad, sample), 0);
  const published = action(cad, sample);
  const bill = published.bills.find(x => x.id === sample.id && x.date === sample.due);
  assert.equal(bill.settlement, 'represented');
  assert.equal(cents(bill.planned), fx.PLANNED);
  assert.equal(cents(bill.actual), fx.OBSERVED);
  assert.equal(bill.remaining, 0);
  assert.equal(cents(published.excluded.bills), fx.OBSERVED, 'bill counted once outside category spending');
  assert.equal(published.unclassified.posted, 0);
  for (const [label, units] of [
    ['USD', { currency: 'usd' }], ['foreign FX metadata', { currency: 'usd', to_base: 1.37 }],
    ['missing', {}], ['null', { currency: null }], ['blank', { currency: '' }]
  ]) {
    const row = fx.transaction(sample, units);
    if (label === 'missing') delete row.currency;
    currencyRejected(observe(sample, [row]), sample, sample.id + ' ' + label);
  }
  assert.equal(hits(observe(sample, [fx.transaction(sample, { currency: ' CAD ' })]).report,
    sample.id).length, 1, 'normalized native units retain admission');
  const pending = observe(sample, [fx.transaction(sample, { is_pending: true })]);
  unsettled(pending, sample, 'native pending', false);
  assert.equal(cents(actuals(pending.report, sample.id)[0].actual), fx.OBSERVED,
    'incumbent native pending budget reservation survives');
  assert.equal(pending.report.currentPeriodActuals.transactions[0].pending, true);
  currencyRejected(observe(sample, [fx.transaction(sample,
    { is_pending: true, currency: 'usd' })]), sample, 'foreign pending');
  const missingPending = fx.transaction(sample, { is_pending: true });
  delete missingPending.currency;
  currencyRejected(observe(sample, [missingPending]), sample, 'missing-unit pending');
  for (const [label, extra] of [
    ['wrong account', { account_id: 9102 }], ['wrong payee', { payee: 'Invented unrelated shop' }],
    ['refund', { amount: -fx.OBSERVED / 100 }]
  ]) unsettled(observe(sample, [fx.transaction(sample, extra)]), sample, label);
  const duplicate = observe(sample, [fx.transaction(sample), fx.transaction(sample)]);
  assert.equal(hits(duplicate.report, sample.id).length, 1, 'repeated provider ID settles once');
  assert.equal(actuals(duplicate.report, sample.id).length, 1);
  assert.equal(cents(actuals(duplicate.report, sample.id)[0].actual), fx.OBSERVED);
  assert.equal(hold(duplicate, sample), 0);
  unsettled(observe(sample, [fx.transaction(sample), fx.transaction(sample, { id: 8102 })]),
    sample, 'two distinct compatible debits remain ambiguous');
  const mixed = observe(sample, [fx.transaction(sample), fx.transaction(sample,
    { id: 8102, currency: 'usd' })]);
  assert.equal(hits(mixed.report, sample.id).length, 1, 'sole native evidence survives foreign neighbor');
  assert.equal(cents(actuals(mixed.report, sample.id)[0].actual), fx.OBSERVED);
  assert.equal(mixed.report.currentPeriodActuals.currencyUnconfirmed.length, 1);
  assert.equal(action(mixed, sample).remainingClaim, 'unavailable');
  // Directed provider replacement proves movement identity, never FX conversion.
  const replacement = currency => [
    fx.transaction(sample, { is_pending: true,
      plaid_metadata: { transaction_id: 'invented-pending' } }),
    fx.transaction(sample, { id: 8102, date: sample.asOf, amount: 61.27, currency,
      plaid_metadata: { transaction_id: 'invented-posted', pending_transaction_id: 'invented-pending' } })
  ];
  const nativeReplacement = observe(sample, replacement('cad'));
  assert.equal(hits(nativeReplacement.report, sample.id).length, 1);
  assert.equal(actuals(nativeReplacement.report, sample.id).length, 1);
  assert.equal(cents(actuals(nativeReplacement.report, sample.id)[0].actual), 6127);
  assert.equal(cents(action(nativeReplacement, sample).excluded.bills), 6127);
  currencyRejected(observe(sample, replacement('usd')), sample, 'foreign posted replacement');
  console.log('PASS ' + sample.id + ': native, unknown/foreign, pending, replacement, account, refund and duplicate controls');
}
console.log('PASS utility units: invented CAD 18361-cent hold, 5983/6127-cent observations; no amount equality or FX conversion');
