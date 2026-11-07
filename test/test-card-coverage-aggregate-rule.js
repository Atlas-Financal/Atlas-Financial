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

// Owner amendment (lead, #787, amends 6641053911): per card and period the
// required inflow is the minimum due in the period plus net new purchases.
// Payments apply to (1) the minimum occurrence, (2) purchases, (3) existing
// debt. The card ledger publishes "minimum covered by payment X"; every Bills
// consumer reads that fact from one holder (Astra A4), so a covered minimum is
// deducted once, by the posted payment itself.

// 0. Minimum first.
{
  const none = run(world([['card', 80, null, 'purchase']]));
  ready(none, 80, 'no payment');
  assert.deepEqual(none.coverage.minimumCoverage.map(m => [m.obligationId, m.due, m.covered, m.status]),
    [['travel', 25, 0, 'to-confirm']]);
  const short = run(world([['card', 80, null, 'purchase'], ['bills', 20, null, 'cash'], ['card', -20, null, 'credit']]));
  ready(short, 80, 'payment below the minimum covers no purchase');
  assert.deepEqual(short.coverage.minimumCoverage.map(m => [m.covered, m.status]), [[20, 'partial']]);
  assert.equal(short.coverage.payments[0].minimumPayment, 20);
  assert.equal(short.coverage.payments[0].backfill, 0);
  const exact = run(world([['card', 80, null, 'purchase'], ['bills', 25, null, 'cash'], ['card', -25, null, 'credit']]));
  ready(exact, 80, 'payment equal to the minimum covers no purchase');
  assert.deepEqual(exact.coverage.minimumCoverage.map(m => [m.covered, m.status, m.paymentIds]),
    [[25, 'covered-by-payment', ['coverage-payment-1']]], 'the minimum is covered by payment 1');
  const over = run(world([['card', 80, null, 'purchase'], ['bills', 50, null, 'cash'], ['card', -50, null, 'credit']]));
  ready(over, 55, 'the rest after the minimum covers purchases');
  assert.deepEqual([over.coverage.payments[0].minimumPayment, over.coverage.payments[0].backfill,
    over.coverage.payments[0].cardPayment], [25, 25, 0]);
  // Two payments: the first pays the minimum, the second only purchases.
  const two = run(world([['card', 80, null, 'purchase'], ['bills', 10, '2026-09-18', 'cash'], ['card', -10, '2026-09-18', 'credit'],
    ['bills', 40, null, 'cash'], ['card', -40, null, 'credit']]));
  ready(two, 55, 'minimum fills across payments in date order');
  assert.deepEqual(two.coverage.payments.map(p => [p.minimumPayment, p.backfill]), [[10, 0], [15, 25]]);
}
// 1. Payments equal to minimum plus purchases: everything covered.
{
  const s = run(world([['card', 80, null, 'purchase'], ['bills', 105, null, 'cash'], ['card', -105, null, 'credit']]));
  ready(s, 0, 'equal payment');
  assert.equal(s.coverage.payments.length, 1);
  assert.deepEqual([s.coverage.payments[0].minimumPayment, s.coverage.payments[0].backfill, s.coverage.payments[0].cardPayment], [25, 80, 0]);
  assert.equal(s.coverage.payments[0].satisfiesMinimum, false, 'the ledger never sets the bill row itself');
  assert.equal(s.period.householdBudget[0].spent, 80, 'the purchase counts once in its category');
  assert.equal(s.period.liveCurrentBalance, 395, 'observed Bills stock, no replay');
  assert.equal(s.observed.data.debts[0].balance, 375, 'observed card debt stock, no replay');
  available(s, 395 - 0 - 70 - 0, 'equal payment: the covered minimum is not deducted again (A4; main 300)');
}
// 2. Payments above: the excess pays existing card debt.
{
  const s = run(world([['card', 80, null, 'purchase'], ['bills', 125, null, 'cash'], ['card', -125, null, 'credit']]));
  ready(s, 0, 'payment above');
  assert.deepEqual([s.coverage.payments[0].minimumPayment, s.coverage.payments[0].backfill, s.coverage.payments[0].cardPayment], [25, 80, 20]);
  assert.equal(s.coverage.payments[0].otherPurpose, 'prior-debt');
  available(s, 375 - 0 - 70, 'payment above: excess is debt repayment, not available cash; covered minimum once (A4; main 280)');
}
// 3. Payments below: the shortfall stays protected and carries forward.
{
  const s = run(world([['card', 80, null, 'purchase'], ['bills', 55, null, 'cash'], ['card', -55, null, 'credit']]));
  ready(s, 50, 'payment below');
  available(s, 445 - 0 - 70 - 50, 'payment below: its first 25 covered the minimum (A4; main 300)');
  assert.equal(s.coverage.active.length, 1);
  assert.equal(s.coverage.active[0].remaining, 50);
  const p = s.coverage.periods.find(row => row.start === '2026-09-18');
  assert.deepEqual([p.minimumDue, p.minimumCovered, p.purchases, p.payments, p.uncoveredCarried], [25, 25, 80, 55, 50]);
  const base = [['card', 80, '2026-09-20', 'purchase'], ['bills', 55, '2026-09-20', 'cash'], ['card', -55, '2026-09-20', 'credit']];
  const carry = run(world(base, { asOf: '2026-10-04', minimumDate: '2026-09-20' }));
  ready(carry, 50, 'shortfall carries into the next period');
  assert.equal(carry.coverage.earlierPeriods.remaining, 50, 'published as an earlier-period carry');
  const later = run(world([...base, ['bills', 50, '2026-10-03', 'cash'], ['card', -50, '2026-10-03', 'credit']],
    { asOf: '2026-10-04', minimumDate: '2026-09-20' }));
  ready(later, 0, 'later payment covers the carry');
  assert.equal(later.coverage.payments[1].backfill, 50);
}
// 4. A refund reduces the period's purchases.
{
  ready(run(world([['card', 80, null, 'purchase'], ['card', -12, null, 'refund']])), 68, 'refund');
  const paid = run(world([['card', 80, null, 'purchase'], ['card', -12, null, 'refund'],
    ['bills', 93, null, 'cash'], ['card', -93, null, 'credit']]));
  ready(paid, 0, 'minimum plus purchases net of the refund covers them');
  assert.equal(paid.coverage.payments[0].cardPayment, 0);
}
// 5. A pending purchase stays pending: reserved, and a payment cannot cover it until it posts.
{
  const s = run(world([['card', 80, null, 'purchase', { is_pending: true }], ['bills', 105, null, 'cash'],
    ['card', -105, null, 'credit']]));
  ready(s, 80, 'pending purchase stays reserved');
  assert.deepEqual([s.coverage.payments[0].minimumPayment, s.coverage.payments[0].backfill, s.coverage.payments[0].cardPayment], [25, 0, 80]);
  const pendingPay = run(world([['card', 80, null, 'purchase'], ['bills', 105, null, 'cash', { is_pending: true }],
    ['card', -105, null, 'credit', { is_pending: true }]]));
  ready(pendingPay, 80, 'pending payment counts only once posted');
  assert.equal(pendingPay.coverage.minimumCoverage[0].status, 'to-confirm');
}
// 6. Unknown direction or account withholds; nothing is inferred from amount alone.
{
  withheld(run(world([['card', 80, null, 'purchase'], ['card', -80, null, 'credit']])),
    'coverage-payment-source-unconfirmed', 'card credit with no household cash leg');
  withheld(run(world([['card', 80, null, 'purchase'], ['bills', 80, null, 'cash']])),
    'coverage-payment-destination-unconfirmed', 'cash payment with no card leg');
  // Atlas partial review on #849: the same for a Savings payment debit.
  withheld(run(world([['card', 80, null, 'purchase'], ['savings', 80, null, 'cash']], { savingsOpening: 1000 })),
    'coverage-payment-destination-unconfirmed', 'Savings payment with no card leg');
  withheld(run(world([['card', 80, null, 'purchase'], ['bills', 80, null, 'cash'], ['card', -79.99, null, 'credit']])),
    'coverage-payment-source-unconfirmed', 'unequal cents never pair');
  withheld(run(world([['card', 80, null, 'purchase'], ['bills', 80, '2026-09-18', 'cash'], ['bills', 80, '2026-09-19', 'cash'],
    ['card', -80, null, 'credit']])), 'coverage-payment-pair-ambiguous', 'two candidate cash legs');
  withheld(run(world([['card', 80, null, 'purchase'], ['card', -5, null, 'refund', { category_name: 'Transfer', payee: 'Invented' }]])),
    null, 'an unexplained card credit is not a refund');
}
// 6a. Owner rule (Dale, via the lead): money onto the card counts whatever
// household account it comes from. A Savings→card payment is a coverage
// inflow. Conservation: Savings is down 105, card debt is down 105, Bills cash
// is untouched, and the Bills protection is released once. Bills period end
// = 500 - 0 (the minimum row consumes minimumCoverage[]: covered, Astra A4)
// - (150 - 80 funded from Savings) = 430; 430 - 105 paid from Savings = 325.
// Was 405 on main (the interim double deduction); +25 is the A4 outcome.
{
  const s = run(world([['card', 80, null, 'purchase'], ['savings', 105, null, 'cash'], ['card', -105, null, 'credit']],
    { savingsOpening: 1000 }));
  ready(s, 0, 'Savings-funded payment covers the minimum and the period purchases');
  assert.deepEqual([s.coverage.payments[0].minimumPayment, s.coverage.payments[0].backfill, s.coverage.payments[0].cardPayment], [25, 80, 0]);
  assert.equal(s.period.liveCurrentBalance, 500, 'Bills cash is untouched');
  assert.equal(s.observed.data.debts[0].balance, 375, 'card debt is down 105');
  const savings = s.observed.data.plan.startingCash.breakdown.find(row => row.id === 'savings');
  assert.equal(savings.value, 895, 'Savings is observed down 105');
  const bills = s.period.billsAccountPeriodBalance;
  assert.equal(bills.status, 'ready', JSON.stringify(bills.issues));
  assert.equal(bills.household.remaining, 70, 'the 80 purchase no longer needs Bills cash');
  assert.equal(bills.amount, 430);
  assert.equal(bills.amount - 105, 325, 'conserved: released once');
  // A4: the from-today walk no longer deducts the covered minimum (was 405).
  available(s, 500 - 0 - 70 - 0, 'one published available figure');
  // Short: 50 from Savings covers the 25 minimum and 25 of purchases.
  ready(run(world([['card', 80, null, 'purchase'], ['savings', 50, null, 'cash'], ['card', -50, null, 'credit']],
    { savingsOpening: 1000 })), 55, 'Savings-funded shortfall stays protected');
}
// 6b. Codex P1 on #849: a card payment from Weekly after a Bills-to-Weekly
// transfer would release household protection already counted as Weekly
// funding (Bills period end 270 vs available now 200). Until that route is
// reconciled against the household hold, a Weekly-funded payment withholds.
withheld(run(world([['card', 80, null, 'purchase'],
  ['bills', 205, null, 'cash', { payee: 'AB123 TFR-TO 0000', original_name: 'AB123 TFR-TO 0000', category_name: 'Transfer' }],
  ['weekly', -205, null, 'cash', { payee: 'AB123 TFR-FR 0000', original_name: 'AB123 TFR-FR 0000', category_name: 'Transfer' }],
  ['weekly', 205, null, 'cash'], ['card', -205, null, 'credit']])),
'coverage-weekly-funded-payment-unmodeled', 'a Weekly-funded card payment withholds');
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
  assert.equal(s.coverage.payments[0].cardPayment, 15, 'first card excess (after its minimum) pays its own debt');
  const both = run(world([['card', 80, null, 'purchase'], ['card2', 40, null, 'purchase'],
    ['bills', 105, '2026-09-19', 'cash'], ['card', -105, '2026-09-19', 'credit'],
    ['bills', 40, null, 'cash'], ['card2', -40, null, 'credit']], { twoCards: true }));
  ready(both, 0, 'each card covered by its own payment');
  withheld(run(world([['card', 80, null, 'purchase'], ['card2', 80, null, 'purchase'],
    ['bills', 80, null, 'cash'], ['card', -80, null, 'credit'], ['card2', -80, null, 'credit']], { twoCards: true })),
  'coverage-payment-pair-ambiguous', 'one cash leg cannot pay two cards');
}
// 9. Period boundary: excess in one period never pre-pays the next period.
{
  const s = run(world([['card', 20, '2026-09-25', 'purchase'], ['bills', 100, '2026-09-25', 'cash'],
    ['card', -100, '2026-09-25', 'credit'], ['card', 50, '2026-10-03', 'purchase']], { asOf: '2026-10-04', minimumDate: '2026-09-25' }));
  ready(s, 50, 'next-period purchase is not pre-paid');
  const p1 = s.coverage.periods.find(row => row.start === '2026-09-18');
  const p2 = s.coverage.periods.find(row => row.start === '2026-10-02');
  assert.deepEqual([p1.minimumCovered, p1.purchases, p1.payments, p1.uncoveredCarried], [25, 20, 100, 0]);
  assert.deepEqual([p2.minimumDue, p2.purchases, p2.payments, p2.uncoveredCarried], [0, 50, 0, 50]);
  // Within one period, timing is aggregate: an earlier payment covers a later purchase.
  ready(run(world([['bills', 50, '2026-10-02', 'cash'], ['card', -50, '2026-10-02', 'credit'],
    ['card', 50, '2026-10-03', 'purchase']], { asOf: '2026-10-04', minimumDate: '2026-09-25' })), 0, 'aggregate within the period');
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
// 10b. A represented scheduled payment. A represented card minimum is owned by
// the minimum-first step (never carved twice); another represented scheduled
// occurrence on the same cash leg settles first and covers no purchase.
{
  const represent = (id, actual) => packet => {
    const cash = packet.transactions.find(tx => tx.atlasAccountId === 'chequing-a');
    packet.representedActuals.push({ id, date: '2026-09-20', actual, transactionId: cash.id });
  };
  const min = run(world([['card', 80, null, 'purchase'], ['bills', 105, null, 'cash'], ['card', -105, null, 'credit']]), represent('travel', 25));
  ready(min, 0, 'represented minimum is the minimum, once');
  assert.equal(min.coverage.payments[0].minimumPayment, 25);
  assert.equal(min.coverage.payments[0].scheduledPayment, undefined);
  const other = run(world([['card', 80, null, 'purchase'], ['bills', 105, null, 'cash'], ['card', -105, null, 'credit']]), represent('card-paid-bill', 10));
  ready(other, 10, 'a represented card-paid bill settles first: 105 - 10 - 25 = 70 of 80');
  assert.equal(other.coverage.payments[0].scheduledPayment, 10);
  withheld(run(world([['card', 80, null, 'purchase'], ['bills', 20, null, 'cash'], ['card', -20, null, 'credit']]), represent('travel', 25)),
    'coverage-payment-scheduled-overlap-unresolved', 'a represented amount above the pair is unresolved');
}
// 11. Conservation through Forecast's published Bills path. Each snapshot's
// observed Bills cash and card debt follow from the rows; the Bills period end
// (cash - 25 minimum - remaining household hold - uncovered reserve) plus any
// excess repaid toward existing debt (and, until #841, the covered minimum)
// equals the no-activity value 500 - 25 - 150
// = 325 in every state, so no purchase is deducted twice against the hold.
{
  const snapshots = [
    ['none', [], 500, 400, 0, 0],
    ['purchase', [['card', 80, null, 'purchase']], 500, 480, 80, 0],
    ['partial', [['card', 80, null, 'purchase'], ['bills', 55, null, 'cash'], ['card', -55, null, 'credit']], 445, 425, 50, 0],
    ['full', [['card', 80, null, 'purchase'], ['bills', 105, null, 'cash'], ['card', -105, null, 'credit']], 395, 375, 0, 0],
    ['above', [['card', 80, null, 'purchase'], ['bills', 125, null, 'cash'], ['card', -125, null, 'credit']], 375, 355, 0, 20],
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
    // Astra A4: the Bills row consumes minimumCoverage[], so a covered
    // minimum is no longer deducted a second time (main pinned
    // bills + excess + minimumCovered = 325, the interim double deduction).
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
  const s = run(world([['card', 80, null, 'purchase'], ['bills', 105, null, 'cash'], ['card', -105, null, 'credit']]));
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
// 14. Pay-down-only manual cards (owner fact, Dale 2026-11-04): no feed, no
// new purchases; the required inflow is the minimum only. A posted household
// debit with that card's payment identity pays the minimum, then debt.
{
  const mbna = (rows, extra = {}) => world(rows, { card: 'mbna', payDownOnly: ['mbna', 'triangle'], ...extra });
  const pay = (amount, payee = 'MBNA M/C') => ['bills', amount, null, 'cash', { payee, category_name: 'DEBT&PAYMENTS' }];
  const paid = run(mbna([pay(25)]));
  ready(paid, 0, 'pay-down card, minimum paid');
  assert.deepEqual(paid.coverage.minimumCoverage.map(m => [m.obligationId, m.due, m.covered, m.status, m.paymentIds]),
    [['mbna-minimum', 25, 25, 'covered-by-payment', ['coverage-payment-1']]]);
  assert.equal(paid.coverage.purchases.length, 0, 'zero new purchases');
  const more = run(mbna([pay(60)]));
  ready(more, 0, 'pay-down card, excess to debt');
  assert.deepEqual([more.coverage.payments[0].minimumPayment, more.coverage.payments[0].backfill,
    more.coverage.payments[0].cardPayment, more.coverage.payments[0].otherPurpose], [25, 0, 35, 'prior-debt']);
  const unpaid = run(mbna([]));
  ready(unpaid, 0, 'pay-down card, minimum unpaid: nothing to protect beyond the minimum row');
  assert.deepEqual(unpaid.coverage.minimumCoverage.map(m => [m.covered, m.status]), [[0, 'to-confirm']]);
  const part = run(mbna([pay(10)]));
  assert.deepEqual(part.coverage.minimumCoverage.map(m => [m.covered, m.status]), [[10, 'partial']]);
  // Triangle's CAN TIRE MC identity names the triangle card, never MBNA.
  const triangle = run(world([pay(25, 'CAN TIRE MC')], { card: 'triangle', payDownOnly: ['mbna', 'triangle'] }));
  ready(triangle, 0, 'triangle pay-down');
  assert.equal(triangle.coverage.minimumCoverage[0].status, 'covered-by-payment');
  // A generic TFR-TO C/C cannot be tied to the pay-down card: unconfirmed.
  withheld(run(mbna([['bills', 25, null, 'cash']])), 'coverage-payment-destination-unconfirmed', 'generic C/C transfer');
  // Activity on a no-feed card contradicts the owner fact and withholds.
  withheld(run(mbna([['card', 30, null, 'purchase']])), 'coverage-pay-down-card-activity-unexpected', 'unexpected purchase');
  // A stale manual balance keeps its own date and is refused as current; a
  // higher stale balance is never counted as a household purchase.
  const stale = run(mbna([], { edit: x => {
    const card = x.payload.accounts[3];
    card.balance = 450;
    card.balance_as_of = card.balance_last_update = card.updated_at = '2026-08-01T00:00:00Z';
  } }));
  const refused = stale.observed.data.liveOverlay.refused.find(r => r.locator === 'debts:mbna');
  assert.equal(refused.reason, 'stale-not-current', 'the stale manual balance is not presented as current');
  assert.equal(refused.evidenceDate, '2026-07-31', 'it keeps its own household-dated as-of');
  assert.equal(stale.observed.data.debts[0].balance, 400, 'the stale balance does not overwrite the plan balance');
  ready(stale, 0, 'an unexplained balance increase is never a purchase');
  assert.equal(stale.coverage.purchases.length, 0);
}
// 15. Atlas executable review on #849 (2015b0b): with the production Savings
// shape (a configured purpose-reserve pool mapped household-reserve), an
// identified Savings payment to a pay-down-only card must keep its card
// identity and pay the minimum, exactly like a Bills payment.
{
  const reserve = { reserveSavings: true, savingsOpening: 1000, payDownOnly: ['mbna', 'triangle'] };
  for (const [card, payee] of [['mbna', 'MBNA PAYMENT'], ['triangle', 'CAN TIRE MC']]) {
    for (const account of ['bills', 'savings']) {
      const s = run(world([[account, 25, null, 'cash', { payee, category_name: 'DEBT&PAYMENTS' }]], { ...reserve, card }));
      const leg = s.packet.transactions.find(tx => tx.amount === 25);
      assert.equal(leg.cardPaymentDestination, card, `${card} from ${account}: the observer keeps the card identity`);
      ready(s, 0, `${card} pay-down payment from ${account}`);
      assert.deepEqual(s.coverage.minimumCoverage.map(m => [m.covered, m.status]), [[25, 'covered-by-payment']],
        `${card} from ${account}: the minimum is covered`);
    }
  }
  // Guards stay: a generic C/C from Savings names no card; an unpaired Savings
  // payment leg has an unknown destination.
  const generic = run(world([['savings', 25, null, 'cash', { payee: 'TFR-TO C/C' }]], { ...reserve, card: 'mbna' }));
  assert.equal(generic.coverage.status, 'unavailable', 'generic C/C from reserve Savings');
  assert(generic.coverage.issues.some(i => i.code === 'coverage-payment-destination-unconfirmed'));
  const feed = { reserveSavings: true, savingsOpening: 1000 };
  const unpaired = run(world([['card', 80, null, 'purchase'], ['savings', 80, null, 'cash']], feed));
  assert.equal(unpaired.coverage.status, 'unavailable');
  assert(unpaired.coverage.issues.some(i => i.code === 'coverage-payment-destination-unconfirmed'));
  // A paired reserve-Savings payment to a feed card is a coverage inflow. The
  // Savings walk's own qualification of that outflow is the NEXT PR (#843
  // finding 11); only the card ledger and the Bills period end are pinned.
  const paired = run(world([['card', 80, null, 'purchase'], ['savings', 105, null, 'cash'], ['card', -105, null, 'credit']], feed));
  assert.equal(paired.coverage.status, 'ready', JSON.stringify(paired.coverage.issues));
  assert.equal(paired.coverage.reservedCash, 0);
  assert.equal(paired.period.billsAccountPeriodBalance.amount, 430, 'Bills protection released once; covered minimum not deducted (A4; was 405)');
}
console.log('card coverage aggregate rule: ok');
