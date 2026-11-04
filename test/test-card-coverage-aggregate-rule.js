'use strict';
// Owner rule (Dale 2026-11-04, #787 6641053911): card purchase coverage is
// aggregate per card per pay period. Invented numbers only. Each expected
// figure below is written from the rule by hand, not read back from Forecast.
// World (test/fixtures/card-coverage-aggregate-world.js): payday anchor
// 2026-09-18, Bills 500, card debt 400, groceries allowance 150, a 25 card
// minimum due on the as-of.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');
const ready = (state, reserve, why) => {
  assert.equal(state.coverage.status, 'ready', why + ': ' + JSON.stringify(state.coverage.issues));
  assert.equal(state.coverage.reservedCash, reserve, why + ': reserve');
};
const withheld = (state, code, why) => {
  assert.equal(state.coverage.status, 'unavailable', why);
  assert.equal(state.coverage.reservedCash, null, why);
  if (code) assert(state.coverage.issues.some(i => i.code === code), why + ': ' + JSON.stringify(state.coverage.issues));
  assert.equal(state.period.fromTodayFunding.availableNow, null, why + ': no usable cash claim');
};
// Available now = Bills cash - 25 minimum - remaining groceries - uncovered reserve.
const available = (state, value, why) => assert.equal(state.period.fromTodayFunding.availableNow, value, why);

// 1. Payments equal to purchases: everything covered.
{
  const s = run(world([['card', 80, null, 'purchase'], ['bills', 80, null, 'cash'], ['card', -80, null, 'credit']]));
  ready(s, 0, 'equal payment');
  assert.equal(s.coverage.payments.length, 1);
  assert.equal(s.coverage.payments[0].backfill, 80);
  assert.equal(s.coverage.payments[0].cardPayment, 0);
  assert.equal(s.coverage.payments[0].satisfiesMinimum, false, 'coverage never settles the minimum');
  assert.equal(s.period.householdBudget[0].spent, 80, 'the purchase counts once in its category');
  assert.equal(s.period.liveCurrentBalance, 420, 'observed Bills stock, no replay');
  assert.equal(s.observed.data.debts[0].balance, 400, 'observed card debt stock, no replay');
  available(s, 420 - 25 - 70 - 0, 'equal payment');
}
// 2. Payments above purchases: the excess pays existing card debt.
{
  const s = run(world([['card', 80, null, 'purchase'], ['bills', 100, null, 'cash'], ['card', -100, null, 'credit']]));
  ready(s, 0, 'payment above');
  assert.equal(s.coverage.payments[0].backfill, 80);
  assert.equal(s.coverage.payments[0].cardPayment, 20);
  assert.equal(s.coverage.payments[0].otherPurpose, 'prior-debt');
  assert.equal(s.observed.data.debts[0].balance, 380);
  available(s, 400 - 25 - 70, 'payment above: excess is debt repayment, not available cash');
}
// 3. Payments below purchases: the shortfall stays protected and carries forward.
{
  const s = run(world([['card', 80, null, 'purchase'], ['bills', 30, null, 'cash'], ['card', -30, null, 'credit']]));
  ready(s, 50, 'payment below');
  available(s, 470 - 25 - 70 - 50, 'payment below');
  assert.equal(s.coverage.active.length, 1);
  assert.equal(s.coverage.active[0].remaining, 50);
  const p = s.coverage.periods.find(row => row.start === '2026-09-18');
  assert.deepEqual([p.purchases, p.payments, p.uncoveredCarried], [80, 30, 50]);
  // Next period: no new payment yet, the 50 still carries.
  const carry = run(world([['card', 80, '2026-09-20', 'purchase'], ['bills', 30, '2026-09-20', 'cash'],
    ['card', -30, '2026-09-20', 'credit']], { asOf: '2026-10-04' }));
  ready(carry, 50, 'shortfall carries into the next period');
  assert.equal(carry.coverage.earlierPeriods.remaining, 50, 'published as an earlier-period carry');
  // A later payment covers the carried shortfall.
  const later = run(world([['card', 80, '2026-09-20', 'purchase'], ['bills', 30, '2026-09-20', 'cash'],
    ['card', -30, '2026-09-20', 'credit'], ['bills', 50, '2026-10-03', 'cash'], ['card', -50, '2026-10-03', 'credit']],
  { asOf: '2026-10-04' }));
  ready(later, 0, 'later payment covers the carry');
  assert.equal(later.coverage.payments[1].backfill, 50);
}
// 4. A refund reduces the period's purchases.
{
  const s = run(world([['card', 80, null, 'purchase'], ['card', -12, null, 'refund']]));
  ready(s, 68, 'refund');
  const paid = run(world([['card', 80, null, 'purchase'], ['card', -12, null, 'refund'],
    ['bills', 68, null, 'cash'], ['card', -68, null, 'credit']]));
  ready(paid, 0, 'payment equal to purchases net of the refund covers them');
  assert.equal(paid.coverage.payments[0].cardPayment, 0);
}
// 5. A pending purchase stays pending: reserved, and a payment cannot cover it until it posts.
{
  const s = run(world([['card', 80, null, 'purchase', { is_pending: true }], ['bills', 80, null, 'cash'],
    ['card', -80, null, 'credit']]));
  ready(s, 80, 'pending purchase stays reserved');
  assert.equal(s.coverage.payments[0].backfill, 0);
  assert.equal(s.coverage.payments[0].cardPayment, 80);
  // A pending payment leg is not counted yet, and does not withhold.
  const pendingPay = run(world([['card', 80, null, 'purchase'], ['bills', 80, null, 'cash', { is_pending: true }],
    ['card', -80, null, 'credit', { is_pending: true }]]));
  ready(pendingPay, 80, 'pending payment counts only once posted');
}
// 6. Unknown direction or account withholds; nothing is inferred from amount alone.
{
  withheld(run(world([['card', 80, null, 'purchase'], ['card', -80, null, 'credit']])),
    'coverage-payment-source-unconfirmed', 'card credit with no household cash leg');
  withheld(run(world([['card', 80, null, 'purchase'], ['bills', 80, null, 'cash']])),
    'coverage-payment-destination-unconfirmed', 'cash payment with no card leg');
  withheld(run(world([['card', 80, null, 'purchase'], ['bills', 80, null, 'cash'], ['card', -79.99, null, 'credit']])),
    'coverage-payment-source-unconfirmed', 'unequal cents never pair');
  withheld(run(world([['card', 80, null, 'purchase'], ['bills', 80, '2026-09-18', 'cash'], ['bills', 80, '2026-09-19', 'cash'],
    ['card', -80, null, 'credit']])), 'coverage-payment-pair-ambiguous', 'two candidate cash legs');
  withheld(run(world([['card', 80, null, 'purchase'], ['savings', 80, null, 'cash'], ['card', -80, null, 'credit']])),
    'coverage-savings-funded-payment-unmodeled', 'a Savings-funded payment is the separate extension');
  withheld(run(world([['card', 80, null, 'purchase'], ['card', -5, null, 'refund', { category_name: 'Transfer', payee: 'Invented' }]])),
    null, 'an unexplained card credit is not a refund');
}
// 7. A foreign-currency row withholds.
{
  withheld(run(world([['card', 80, null, 'purchase', { currency: 'usd', to_base: 1.4 }]])), null, 'foreign purchase');
  withheld(run(world([['card', 80, null, 'purchase'], ['bills', 80, null, 'cash'], ['card', -80, null, 'credit', { currency: 'usd' }]])),
    null, 'foreign payment');
}
// 8. Two cards: coverage is per card; excess on one card never covers the other.
{
  const s = run(world([['card', 80, null, 'purchase'], ['card2', 40, null, 'purchase'],
    ['bills', 120, null, 'cash'], ['card', -120, null, 'credit']], { twoCards: true }));
  ready(s, 40, 'second card stays uncovered');
  assert.equal(s.coverage.payments[0].cardPayment, 40, 'first card excess pays its own debt');
  const both = run(world([['card', 80, null, 'purchase'], ['card2', 40, null, 'purchase'],
    ['bills', 80, '2026-09-19', 'cash'], ['card', -80, '2026-09-19', 'credit'],
    ['bills', 40, null, 'cash'], ['card2', -40, null, 'credit']], { twoCards: true }));
  ready(both, 0, 'each card covered by its own payment');
  withheld(run(world([['card', 80, null, 'purchase'], ['card2', 80, null, 'purchase'],
    ['bills', 80, null, 'cash'], ['card', -80, null, 'credit'], ['card2', -80, null, 'credit']], { twoCards: true })),
  'coverage-payment-pair-ambiguous', 'one cash leg cannot pay two cards');
}
// 9. Period boundary: excess in one period never pre-pays the next period.
{
  const s = run(world([['card', 20, '2026-09-25', 'purchase'], ['bills', 100, '2026-09-25', 'cash'],
    ['card', -100, '2026-09-25', 'credit'], ['card', 50, '2026-10-03', 'purchase']], { asOf: '2026-10-04' }));
  ready(s, 50, 'next-period purchase is not pre-paid');
  const p1 = s.coverage.periods.find(row => row.start === '2026-09-18');
  const p2 = s.coverage.periods.find(row => row.start === '2026-10-02');
  assert.deepEqual([p1.purchases, p1.payments, p1.uncoveredCarried], [20, 100, 0]);
  assert.deepEqual([p2.purchases, p2.payments, p2.uncoveredCarried], [50, 0, 50]);
  // Within one period, timing is aggregate: an earlier payment covers a later purchase.
  ready(run(world([['bills', 50, '2026-10-02', 'cash'], ['card', -50, '2026-10-02', 'credit'],
    ['card', 50, '2026-10-03', 'purchase']], { asOf: '2026-10-04' })), 0, 'aggregate within the period');
}
// 10. The opening: earlier card activity is existing debt, and an opening that
// is still ahead of the as-of protects nothing yet.
{
  ready(run(world([['card', 80, '2026-09-17', 'purchase'], ['card', 30, null, 'purchase']],
    { windowStart: '2026-09-15' })), 30, 'pre-opening purchase is existing debt');
  const ahead = world([['card', 80, null, 'purchase']]);
  ahead.data.plan.cardPurchaseCoverage.opening.asOf = '2026-10-02';
  ready(run(ahead), 0, 'opening ahead of the as-of: all card activity is existing debt');
  const offPayday = world([['card', 80, null, 'purchase']]);
  offPayday.data.plan.cardPurchaseCoverage.opening.asOf = '2026-09-19';
  withheld(run(offPayday), 'coverage-opening-not-pay-period-start', 'the opening must be a payday');
  const unconfirmed = world([['card', 80, null, 'purchase']]);
  unconfirmed.data.plan.cardPurchaseCoverage.opening.confirmed = false;
  withheld(run(unconfirmed), 'coverage-opening-unconfirmed', 'an unconfirmed opening withholds');
  const mixed = world([['card', 80, null, 'purchase']]);
  mixed.data.plan.cardPurchaseCoverage.payments = [{ id: 'x', confirmed: true }];
  withheld(run(mixed), 'coverage-records-invalid', 'intent records are not combined with the aggregate rule');
}
// 10b. A cash leg that represents the scheduled 25 minimum settles it first:
// only the rest of the pair covers purchases, never both.
{
  const represent = actual => packet => {
    const cash = packet.transactions.find(tx => tx.atlasAccountId === 'chequing-a');
    packet.representedActuals.push({ id: 'travel', date: '2026-09-20', actual, transactionId: cash.id });
  };
  const s = run(world([['card', 80, null, 'purchase'], ['bills', 105, null, 'cash'], ['card', -105, null, 'credit']]), represent(25));
  ready(s, 0, 'minimum carved out of the pair');
  assert.equal(s.coverage.payments[0].scheduledPayment, 25);
  assert.equal(s.coverage.payments[0].backfill, 80);
  assert.equal(s.coverage.payments[0].cardPayment, 0);
  const short = run(world([['card', 80, null, 'purchase'], ['bills', 75, null, 'cash'], ['card', -75, null, 'credit']]), represent(25));
  ready(short, 30, 'only 50 of a 75 pair covers purchases');
  withheld(run(world([['card', 80, null, 'purchase'], ['bills', 20, null, 'cash'], ['card', -20, null, 'credit']]), represent(25)),
    'coverage-payment-scheduled-overlap-unresolved', 'a represented amount above the pair is unresolved');
}
// 11. Conservation through Forecast's published Bills path. Each snapshot's
// observed Bills cash and card debt follow from the rows; the Bills period end
// (cash - 25 minimum - remaining household hold - uncovered reserve) plus any
// excess repaid toward existing debt equals the no-activity value 500 - 25 - 150
// = 325 in every state, so no purchase is deducted twice against the hold.
{
  const snapshots = [
    ['none', [], 500, 400, 0, 0],
    ['purchase', [['card', 80, null, 'purchase']], 500, 480, 80, 0],
    ['partial', [['card', 80, null, 'purchase'], ['bills', 30, null, 'cash'], ['card', -30, null, 'credit']], 470, 450, 50, 0],
    ['full', [['card', 80, null, 'purchase'], ['bills', 80, null, 'cash'], ['card', -80, null, 'credit']], 420, 400, 0, 0],
    ['above', [['card', 80, null, 'purchase'], ['bills', 100, null, 'cash'], ['card', -100, null, 'credit']], 400, 380, 0, 20],
    ['refund', [['card', 80, null, 'purchase'], ['card', -12, null, 'refund']], 500, 468, 68, 0],
  ];
  for (const [name, rows, cash, debt, reserve, excess] of snapshots) {
    const s = run(world(rows));
    ready(s, reserve, 'conservation ' + name);
    assert.equal(s.period.liveCurrentBalance, cash, name + ': Bills cash');
    assert.equal(s.observed.data.debts[0].balance, debt, name + ': card debt');
    const bills = s.period.billsAccountPeriodBalance;
    assert.equal(bills.status, 'ready', name + ': ' + JSON.stringify(bills.issues));
    // The refund lowers the card's uncovered reserve to 68, inside the
    // incumbent gross 150 hold (refund netting of the hold is not this outcome).
    assert.equal(bills.amount + excess, 325, name + ': Bills period end conserves');
    // Pre-existing and identical under explicit refund records on main: the
    // from-today figure nets a card refund against the category, the Bills
    // period end does not (recorded as a finding in the PR, not changed here).
    if (name !== 'refund') assert.equal(s.period.fromTodayFunding.availableNow, bills.amount, name + ': one published available figure');
    assert.equal(s.period.predictedEndingBalance, s.period.balanceAfterDeductions, name + ': income-led ending published');
  }
}
// 12. The operating plan becomes available on an invented live packet that
// satisfies the rule: predicted ending balance, payday allocation and
// spendable cash all publish.
{
  const Assistant = require('../scripts/assistant-packet');
  const s = run(world([['card', 80, null, 'purchase'], ['bills', 80, null, 'cash'], ['card', -80, null, 'credit']]));
  assert.notEqual(s.period.predictedEndingBalance, null, 'predicted ending balance publishes');
  assert.notEqual(s.advice.paydayAllocation.available, null, 'payday allocation publishes');
  const packet = Assistant.buildPacket({ data: s.observed.data, periods: null, questionsMarkdown: '' });
  assert.notEqual(packet.forecast.status, 'unavailable', 'assistant forecast available');
  assert.notEqual(packet.current.spendableHouseholdCash.value, null, 'spendable household cash publishes');
  // The same packet with an unpaired card credit withholds all three.
  const held = run(world([['card', 80, null, 'purchase'], ['card', -80, null, 'credit']]));
  const heldPacket = Assistant.buildPacket({ data: held.observed.data, periods: null, questionsMarkdown: '' });
  assert.equal(heldPacket.forecast.status, 'unavailable');
  assert.equal(heldPacket.current.spendableHouseholdCash.value, null);
}
// 13. A static (unobserved) plan with the canonical empty-opening policy stays
// on the incumbent path: the standing rule alone is not card evidence.
{
  const F = require('../public/forecast');
  const data = JSON.parse(JSON.stringify(require('../data.json')));
  assert.equal(data.plan.cardPurchaseCoverage.rule, 'aggregate-per-card-per-pay-period');
  assert.deepEqual(data.plan.cardPurchaseCoverage.opening.purchases, [], 'canonical opening carries no amounts');
  const withRule = F.recommend(data.plan, '2026-11-04', { debts: data.debts });
  delete data.plan.cardPurchaseCoverage;
  const without = F.recommend(data.plan, '2026-11-04', { debts: data.debts });
  assert.equal(withRule.cardPurchaseCoverage, undefined);
  assert.equal(JSON.stringify(withRule), JSON.stringify(without), 'static publication unchanged by the policy');
}
console.log('card coverage aggregate rule: ok');
