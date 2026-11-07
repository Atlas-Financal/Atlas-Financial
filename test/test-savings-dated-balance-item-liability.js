'use strict';
// Savings audit (lead dispatch): a dated Savings balance plus a linked item
// payment from Savings on or after that date. The item's U already counts the
// payment; the dated balance B does not yet show it. Blueprint #787
// 6620986508 §2: F = B - E, so that payment is E (a liability), deducted once.
// Card variant: an item card charge paid by a Savings->card payment on or
// after the balance date is the same money leaving Savings.
//
// Every account, amount, date and identity is invented. Expected values are
// hand-written literals from F = B - E and need-date allocation; nothing here
// computes an expected value with the code under test. The path is
// production's: an invented raw Lunch Money payload through
// scripts/live-plan.js fromObservation, then Forecast.recommend and
// Forecast.savingsFundingPublication as plan.js calls them, and the rendered
// Budget page for the two headline cases.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');
const F = require('../public/forecast');

const TRIP_LINK = { categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
  effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' };

// A 600 trip (Nov 20, linked to the Trip category) and a 600 gift (Dec 10).
function world(savings, balanceDate, purchases, { card = false, aggregate = true } = {}) {
  const w = H.baseWorld();
  const sav = w.accounts.find(a => a.id === 'savings');
  sav.value = savings;
  if (balanceDate) sav.balanceDate = balanceDate;
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true },
  ];
  w.savingsPool = {};
  w.links = [TRIP_LINK];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...purchases.map(p => H.lm({ category: 'Trip', payee: 'Invented airline', ...p }))];
  if (card) {
    w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
    w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
      pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
    if (aggregate) w.planPatch = plan => { plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
      opening: { asOf: '2026-10-09', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } }; };
  }
  return w;
}
const cardCharge = (amount, date = '2026-10-11') => ({ date, amount, account: 'travelvisa', providerAccountId: 9004 });
const savingsCardPayment = (amount, date) => [
  { date, amount, account: 'savings', payee: 'Invented card payment', category: 'Transfer', raw: { category_name: 'Credit Card Payment' } },
  { date, amount: -amount, account: 'travelvisa', providerAccountId: 9004, payee: 'PAYMENT - THANK YOU', category: 'Transfer',
    raw: { category_name: 'Credit Card Payment' } }];

function engine(w) {
  const { data, error } = H.dataOf(w);
  assert.equal(error, null, 'the invented observation is served');
  const o = data.liveOverlay;
  const opts = { debts: data.debts, currentPeriodActuals: o.currentPeriodActuals, operatingPlan: o.operatingPlan,
    observedCash: o.observedCash };
  const advice = F.recommend(data.plan, w.asOf, opts);
  const pub = F.savingsFundingPublication(advice.savingsFunding, { asOf: w.asOf, advice });
  const row = id => pub.rows.find(r => r.key === 'commitment:' + id);
  const trip = row('trip'), gift = row('gift');
  return { trip: [trip?.saved, trip?.needed], gift: [gift?.saved, gift?.stillToFund],
    stock: advice.savingsFunding.stock?.reportedStock?.amount ?? null,
    allocation: advice.savingsFunding.goalAllocation?.status };
}
const expect = (why, w, { trip, gift, stock }) => {
  const r = engine(w);
  assert.equal(r.allocation, 'ready', why + ': positive control, the goal allocation is published');
  assert.deepEqual(r.trip, trip, why + ': trip [saved, needed]');
  assert.deepEqual(r.gift, gift, why + ': gift [saved, still to fund]');
  if (stock !== undefined) assert.equal(r.stock, stock, why + ': the reported Savings balance stays visible unchanged');
};

// --------------------------------------------- direct Savings purchase (E)
// B 1,000 dated Oct 10; a linked 500 trip purchase from Savings on Oct 12.
// U trip = 100. F = 1,000 - 500 = 500 -> trip 100, gift 400, gap 200.
expect('dated balance, later linked purchase', world(1000, '2026-10-10', [{ date: '2026-10-12', amount: 500, account: 'savings' }]),
  { trip: [100, 100], gift: [400, 200], stock: 1000 });
// Same-day inclusion cannot be shown: treated as not yet included.
expect('balance dated the purchase day', world(1000, '2026-10-12', [{ date: '2026-10-12', amount: 500, account: 'savings' }]),
  { trip: [100, 100], gift: [400, 200], stock: 1000 });
// Controls: a balance that already shows the purchase is not reduced again.
expect('current balance already net of the purchase', world(500, null, [{ date: '2026-10-12', amount: 500, account: 'savings' }]),
  { trip: [100, 100], gift: [400, 200], stock: 500 });
expect('balance dated after the purchase', world(500, '2026-10-13', [{ date: '2026-10-12', amount: 500, account: 'savings' }]),
  { trip: [100, 100], gift: [400, 200], stock: 500 });
expect('dated balance, no purchase', world(1000, '2026-10-10', []), { trip: [600, 600], gift: [400, 200], stock: 1000 });
// Overspend: 700 left Savings; U trip = 0; F = 300 -> gift 300, gap 300.
expect('dated balance, later 700 purchase', world(1000, '2026-10-10', [{ date: '2026-10-12', amount: 700, account: 'savings' }]),
  { trip: [0, 0], gift: [300, 300], stock: 1000 });
// A later linked refund offsets the later charge: net 0 left Savings, U = 600.
expect('later charge fully refunded later', world(1000, '2026-10-10', [{ date: '2026-10-12', amount: 500, account: 'savings' },
  { date: '2026-10-13', amount: -500, account: 'savings' }]), { trip: [600, 600], gift: [400, 200], stock: 1000 });
// An unlinked Savings debit is not an item payment: no E term (owner policy:
// the dated reported stock is used as reported).
{
  const w = world(1000, '2026-10-10', [{ date: '2026-10-12', amount: 500, account: 'savings', category: 'Groceries' }]);
  const r = engine(w);
  assert.deepEqual([r.trip, r.gift], [[600, 600], [400, 200]], 'unlinked later Savings debit: shares as reported');
}

// --------------------------------------- card charge paid from Savings (E)
expect('card charge, Savings payment after the balance date',
  world(1000, '2026-10-10', [cardCharge(500), ...savingsCardPayment(500, '2026-10-12')], { card: true }),
  { trip: [100, 100], gift: [400, 200], stock: 1000 });
expect('card charge, Savings payment on the balance date',
  world(1000, '2026-10-12', [cardCharge(500), ...savingsCardPayment(500, '2026-10-12')], { card: true }),
  { trip: [100, 100], gift: [400, 200], stock: 1000 });
expect('card charge, Savings payment before the balance date',
  world(500, '2026-10-13', [cardCharge(500), ...savingsCardPayment(500, '2026-10-12')], { card: true }),
  { trip: [100, 100], gift: [400, 200], stock: 500 });
// A linked refund into Savings after the date offsets a later Savings card
// payment for the same item: net 0 left Savings, U = 600.
expect('card charge paid from Savings, then refunded into Savings',
  world(1000, '2026-10-10', [cardCharge(500), ...savingsCardPayment(500, '2026-10-12'),
    { date: '2026-10-13', amount: -500, account: 'savings' }], { card: true }),
  { trip: [600, 600], gift: [400, 200], stock: 1000 });
// Without the aggregate card ledger nothing attributes the payment: the
// allocation is withheld, never published as a full gift.
{
  const r = engine(world(1000, '2026-10-10', [cardCharge(500), ...savingsCardPayment(500, '2026-10-12')], { card: true, aggregate: false }));
  assert.equal(r.allocation, 'unavailable', 'unattributed card payment: allocation withheld');
  assert.notEqual(r.gift[0], 600, 'unattributed card payment: the gift is never shown fully saved');
}

// ------------------------------------------------- the page a household reads
(async () => {
  try {
    const read = async w => H.withBudget(w, async p => {
      const s = await H.snap(p);
      return { trip: H.goal(s, 'Invented trip'), gift: H.goal(s, 'Invented gift'), savings: s.savings };
    });
    for (const [why, w] of [
      ['direct', world(1000, '2026-10-10', [{ date: '2026-10-12', amount: 500, account: 'savings' }])],
      ['card', world(1000, '2026-10-10', [cardCharge(500), ...savingsCardPayment(500, '2026-10-12')], { card: true })]]) {
      const s = await read(w);
      assert.match(s.savings, /Reported combined savings: \$1,000\.00/, why + ': the dated report stays visible');
      assert.match(s.trip, /\$100\.00\s*Saved.*Paid \$500\.00/, why + ': trip saved 100, paid 500');
      assert.match(s.gift, /\$400\.00\s*Saved/, why + ': gift saved 400');
      assert.match(s.gift, /Still to fund ≈ estimated \$200\.00/, why + ': gift still to fund 200');
    }
    console.log('savings dated balance item liability: engine and page checks passed');
  } finally {
    await H.closeBrowser();
  }
})().catch(e => { console.error(e); process.exit(1); });
