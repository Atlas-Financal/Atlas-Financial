'use strict';

const assert = require('node:assert/strict');
const H = require('./acceptance/harness');
const Live = require('../scripts/live-plan');
const Memory = require('../scripts/server-observation-memory');
const Forecast = require('../public/forecast');

// One invented pay period. The Oct 9 payroll expectation is 1,400. The
// candidate credit is 1,325, so only an actual receipt can change it to
// 1,325. Oct 12 water is due for 37.50. A posted debit covers all 37.50 and
// leaves 37.50 - 37.50 = 0 due. All other posting states prove 0 was paid.
const world = H.baseWorld();
world.bills = [{ id: 'invented-water', label: 'Invented water', payee: 'Invented Water Co',
  amount: 37.5, frequency: 'monthly', day: 12, firstDue: '2026-10-12', payingAccount: 'chequing-a' }];
H.productionOpening(world);
const input = { data: H.canonicalOf(world, H.planOf(world)), accountMap: H.accountMapOf(world), identity: H.identityOf(world) };

function payloadFor(posting) {
  world.transactions = [
    H.lm({ id: 'invented-pay', date: '2026-10-09', amount: -1325, account: 'chequing-a',
      payee: 'Invented employer', category: 'Payroll' }),
    H.lm({ id: 'invented-water-debit', date: '2026-10-12', amount: 37.5, account: 'chequing-a',
      payee: 'Invented Water Co', category: 'Utilities' }),
  ];
  for (const tx of world.transactions) {
    if (posting === undefined) delete tx.is_pending;
    else tx.is_pending = posting;
  }
  const { plaid_accounts, ...payload } = H.rawPayload(world);
  return { ...payload, provider: 'lunchmoney', accounts: plaid_accounts,
    transactionWindow: { ...payload.transactionWindow, truncated: false },
    pendingCoverage: { ...payload.pendingCoverage, truncated: false } };
}

function check(payload, posted, label, pending = false) {
  const refreshed = Live.fromObservation({ ...input, payload });
  const packet = refreshed.data.liveOverlay.currentPeriodActuals;
  const view = Forecast.recommend(refreshed.data.plan, world.asOf, { currentPeriodActuals: packet })
    .payPeriodViews.find(period => period.start === '2026-10-09');
  const bill = view.bills.find(row => row.id === 'invented-water');
  const pay = view.income.find(row => row.id === 'payroll');
  const receipts = (packet.representedActuals || []).filter(row => row.pending !== true)
    .map(row => [row.id, row.actual]);
  assert.deepEqual(receipts, posted ? [['payroll', -1325], ['invented-water', 37.5]] : [], label);
  if (posted) {
    assert.equal(bill.status, 'PAID', label);
    assert.equal(bill.remaining, 0, label);
    assert.equal(pay.actual, -1325, label);
  } else {
    assert.notEqual(bill.status, 'PAID', label);
    assert.equal(bill.remaining, 37.5, label);
    assert.equal(pay.actual, null, label);
    if (pending) assert.equal(bill.status, 'pending', label);
  }
}

for (const [name, posting] of [
  ['absent', undefined], ['null', null], ['string false', 'false'], ['number zero', 0],
  ['pending', true], ['posted', false],
]) {
  const payload = payloadFor(posting);
  const posted = posting === false;
  const pending = posting === true;
  check(payload, posted, name + ' live', pending);
  const serialized = H.clone(payload);
  check(serialized, posted, name + ' raw replay', pending);
  if (typeof posting === 'boolean') {
    check(Memory.sourceInputs(serialized), posted, name + ' retained source replay', pending);
  } else {
    assert.throws(() => Memory.sourceInputs(serialized), /observation-input-invalid/,
      name + ' cannot become a retained posting flag');
  }
}

// A same-id pending row and an unknown second row cannot lend each other
// posting proof. The inherited identity path needs a positively posted survivor.
const transition = payloadFor(undefined);
transition.transactions.push({ ...transition.transactions[1], is_pending: true });
Object.assign(transition.transactions[1], { payee: 'Invented generic processor', original_name: 'INVENTED PROCESSOR' });
check(transition, false, 'pending-to-unknown same-id pair');

const contradictory = payloadFor(false);
for (const tx of contradictory.transactions) tx.contradictoryEvidence = true;
check(contradictory, false, 'contradictory posted evidence live');
check(Memory.sourceInputs(H.clone(contradictory)), false, 'contradictory posted evidence replay');
console.log('Positive bill and payroll posting evidence checks passed.');
