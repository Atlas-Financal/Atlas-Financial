'use strict';
// #821 goal 2 (acceptance 2.6 / 2.7): an owner-confirmed item completed from
// Savings shows Paid = its established linked Savings spending (blueprint
// #787 6620986508, "Rules for P and U": P = N + C - X; a full confirmation
// with no owner amount contributes no number and no overlap, so P = N).
// U stays 0, overspend over the stated cost is a disclosure, and the pool is
// the observed balance read once. Every other evidence class keeps Paid
// Unknown, exactly as before.
//
// Every account, amount, date and identity is invented. Expected values are
// hand-written literals from those rules; nothing here computes an expected
// value with the code under test. The path is production's: an invented raw
// Lunch Money payload through scripts/live-plan.js fromObservation, then
// Forecast.recommend and Forecast.savingsFundingPublication as plan.js calls
// them.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');
const F = require('../public/forecast');

const TRIP_LINK = { categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
  effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' };
const GIFT_LINK = { categoryId: 106, goalRef: { kind: 'commitment', id: 'gift' }, occurrenceDate: '2026-12-10',
  effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' };

// A 600 trip (Nov 20, owner-confirmed Oct 12) and a 600 gift (Dec 10).
function world(savings, purchases, { links = [TRIP_LINK], settled = true } = {}) {
  const w = H.baseWorld();
  w.accounts.find(a => a.id === 'savings').value = savings;
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true,
      ...(settled ? { settledOn: '2026-10-12' } : {}) },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true },
  ];
  w.savingsPool = {};
  w.links = links;
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...purchases.map(p => H.lm({ date: '2026-10-12', category: 'Trip', payee: 'Invented airline', ...p }))];
  return w;
}
function engine(w, extra = {}) {
  const { data, error } = H.dataOf(w);
  assert.equal(error, null, 'the invented observation is served');
  const o = data.liveOverlay;
  const opts = { debts: data.debts, currentPeriodActuals: o.currentPeriodActuals, operatingPlan: o.operatingPlan,
    observedCash: o.observedCash, ...extra };
  const advice = F.recommend(data.plan, w.asOf, opts);
  const pub = F.savingsFundingPublication(advice.savingsFunding, { asOf: w.asOf, advice });
  const row = id => pub.rows.find(r => r.key === 'commitment:' + id);
  const fact = f => f && f.status === 'known' ? f.amount : f ? f.status : undefined;
  const trip = row('trip'), cost = trip?.commitmentCost;
  return { trip, gift: row('gift'), paid: fact(cost?.paid), unpaid: fact(cost?.unpaidCost),
    observed: fact(cost?.observedLinked), owner: cost?.ownerConfirmation?.status,
    stock: advice.savingsFunding.stock?.reportedStock?.amount ?? null };
}

// ---------------------------------------------------------------- positives
for (const [actual, left] of [[500, 500], [700, 300]]) {
  const r = engine(world(left, [{ amount: actual, account: 'savings' }]));
  assert.deepEqual([r.trip?.paymentStatus, r.trip?.paymentSource, r.owner], ['paid', 'owner-confirmed', 'full'],
    actual + ': the trip is an owner-confirmed Paid row');
  assert.deepEqual([r.paid, r.unpaid, r.observed], [actual, 0, actual],
    actual + ': Paid is the linked Savings debit, U is 0');
  assert.deepEqual([r.trip.saved, r.trip.needed, r.trip.stillToFund], [0, 0, 0], actual + ': the trip draws nothing more');
  // The pool is the observed balance, read once: no second debit for the
  // purchase and no credit for the 100 under (500) or over (700) the cost.
  assert.equal(r.stock, left, actual + ': Savings stock is the observed ' + left);
  assert.deepEqual([r.gift.saved, r.gift.stillToFund], [left, 600 - left], actual + ': the gift gets exactly ' + left);
}

// ---------------------------------------------- negatives: Paid stays Unknown
const unknown = (why, w, extra) => {
  const r = engine(w, extra);
  assert.equal(r.trip?.paymentSource, 'owner-confirmed', why + ': positive control, the owner-confirmed row is listed');
  assert.equal(r.unpaid, 0, why + ': a full confirmation still closes the item (U = 0)');
  assert.equal(r.paid, 'unavailable', why + ': Paid stays Unknown');
};
unknown('unlinked Savings debit', world(500, [{ amount: 500, account: 'savings' }], { links: [] }));
unknown('linked debit later reversed in full', world(1000, [{ amount: 500, account: 'savings' }, { amount: -500, account: 'savings' }]));
unknown('linked debit partly refunded', world(600, [{ amount: 500, account: 'savings' }, { amount: -100, account: 'savings' }]));
unknown('pending linked Savings debit', world(500, [{ amount: 500, account: 'savings', pending: true }]));
unknown('chequing-only linked debit', world(1000, [{ amount: 500, account: 'chequing-b' }]));
unknown('Savings and chequing debits together', world(700, [{ amount: 300, account: 'savings' }, { amount: 200, account: 'chequing-b' }]));
unknown('ambiguous link (one category names two occurrences)', world(500, [{ amount: 500, account: 'savings' }], { links: [TRIP_LINK, GIFT_LINK] }));
{
  const w = world(500, [{ amount: 500, account: 'savings' }]);
  w.coverage = { complete: false, hasMore: true };
  unknown('incomplete transaction history', w);
}
// An owner-stated amount beside the transaction with no evidenced overlap.
unknown('owner amount with unknown overlap', world(500, [{ amount: 500, account: 'savings' }]),
  { savingsConfirmations: [{ occurrenceKey: 'trip@2026-11-20', status: 'full', cents: 50000, confirmedOn: '2026-10-12' }] });

// A not-confirmed part payment is unchanged: no owner row, linked P = 500.
{
  const r = engine(world(500, [{ amount: 500, account: 'savings' }], { settled: false }));
  assert.equal(r.trip?.paymentSource, undefined, 'unconfirmed: no owner-confirmed row');
  assert.equal(r.trip?.commitmentCost?.confirmedLinkedPaid?.amount, 500, 'unconfirmed: linked Paid 500 as before');
  assert.equal(r.unpaid, 100, 'unconfirmed: U = 100');
}

// ------------------------------------------------- the page a household reads
(async () => {
  try {
    const read = async w => H.withBudget(w, async p => H.goal(await H.snap(p), 'Invented trip'));
    const five = await read(world(500, [{ amount: 500, account: 'savings' }]));
    assert.match(five, /Paid \$500\.00 owner-confirmed · Confirmed Oct 12 · Paid is linked Savings spending · Payment date Unknown/,
      '500: Paid is labelled as linked Savings spending; the payment date stays Unknown');
    assert.doesNotMatch(five, /Actual amount and date Unknown|over the|Observed linked spending/,
      '500: no Unknown-amount contradiction beside a known Paid, and no overspend note');
    const seven = await read(world(300, [{ amount: 700, account: 'savings' }]));
    assert.match(seven, /Paid \$700\.00 owner-confirmed .*\$100\.00 over the \$600\.00 planned cost \(disclosure, not another charge\)/,
      '700: the 100 over cost is a disclosure');
    assert.match(seven, /Still to fund ≈ estimated \$0\.00/, '700: nothing more to fund');
    const chq = await read(world(1000, [{ amount: 500, account: 'chequing-b' }]));
    assert.match(chq, /Paid — owner-confirmed · Confirmed Oct 12 · Actual amount and date Unknown · Observed linked spending \$500\.00/,
      'chequing-only: the incumbent Unknown face is unchanged');
    console.log('savings owner-confirmed Paid: engine and page checks passed');
  } finally {
    await H.closeBrowser();
  }
})().catch(e => { console.error(e); process.exit(1); });
