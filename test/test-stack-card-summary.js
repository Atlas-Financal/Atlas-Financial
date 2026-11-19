'use strict';
/* Stack Wallet A6 (lead dispatch, ATLAS LEAD 11, 2026-11-19): per card, in one pay period, how much was paid onto the
 * card against how much was spent on it. Forecast.stackCardSummary reads one Forecast.cardPeriodMovements publication.
 * Posted rows only (the card ledger is posted-only). Paid is the posted credits whose native identity is a payment,
 * 'calculated' when the card ledger reconciled every one, else 'estimated'. Spent is charges and interest less native
 * refunds. Net is paid less spent. State: ahead / behind / even / no-activity. A figure that cannot be stated is null
 * with its reasons, never 0. Pending rows are listed and move nothing. HELOC is excluded.
 *
 * Path: the invented card week (test/fixtures/card-posted-period-movement-data.js) -> Forecast.cardPeriodMovements (the
 * page's own call, with the applied overlay) -> Forecast.stackCardSummary.
 *
 * Invented week, 2026-08-14..08-20 (as of 08-20). By hand, posted rows only:
 *   Travel:   charges 172.40 + 63.75, interest 6.25, refund -35.00, payment -100.00 (source not reconciled), and a
 *             pending 28.60 charge. spent = 172.40 + 63.75 + 6.25 - 35.00 = 207.40; paid = 100.00 (estimated);
 *             net = 100.00 - 207.40 = -107.40, behind.
 *   Cash Back: charge 114.20, payment -250.00 (not reconciled). spent 114.20; paid 250.00 (estimated); net +135.80, ahead.
 *   Emerald:  no rows, with positive sync evidence: 0 / 0 / 0, calculated, no-activity.
 *   Triangle, Amazon Mastercard: manual cards with no positive sync evidence: null, unavailable, never 0.
 *
 * `node test/test-stack-card-summary.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/card-posted-period-movement-data');
const { copy } = fx;

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay });
const summary = x => F.stackCardSummary(publish(x));
const card = (x, id) => summary(x).find(c => c.id === id);
const fig = f => [f.amount, f.trust];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('1. Hand-derived figures on the invented week');
{
  const x = fx.fixture();
  const cards = summary(x);
  ok(same(cards.map(c => c.id), ['travelvisa', 'cashback', 'tdcc', 'triangle', 'mbna']), 'the five cards, HELOC excluded');
  const t = card(x, 'travelvisa');
  ok(same([fig(t.paid), fig(t.spent), fig(t.net), t.state], [[100, 'estimated'], [207.4, 'calculated'], [-107.4, 'estimated'], 'behind']),
    'Travel: paid 100.00 (estimated), spent 207.40, net -107.40, behind', JSON.stringify([t.paid, t.spent, t.net, t.state]));
  ok(same(t.paid.reasons, ['card-payment-unconfirmed']), 'Travel: the paid figure says why it is estimated');
  const c = card(x, 'cashback');
  ok(same([fig(c.paid), fig(c.spent), fig(c.net), c.state], [[250, 'estimated'], [114.2, 'calculated'], [135.8, 'estimated'], 'ahead']),
    'Cash Back: paid 250.00, spent 114.20, net +135.80, ahead');
  const e = card(x, 'tdcc');
  ok(same([fig(e.paid), fig(e.spent), fig(e.net), e.state], [[0, 'calculated'], [0, 'calculated'], [0, 'calculated'], 'no-activity']),
    'Emerald: a proven empty week is 0 / 0 / 0, no-activity');
  for (const id of ['triangle', 'mbna']) {
    const m = card(x, id);
    ok([m.paid, m.spent, m.net].every(f => f.amount === null && f.trust === 'unavailable'
      && f.reasons.includes('account-transaction-evidence-unavailable')) && m.state === null && m.stateReasons.length > 0,
    id + ': no positive sync evidence: null with a reason, never 0, and no state');
  }
}

console.log('2. Independent identity: net is the opposite of the posted liability movement');
{
  const x = fx.fixture(), pub = publish(x);
  for (const c of F.stackCardSummary(pub)) {
    const movement = pub.cards.find(row => row.id === c.id).postedMovement;
    if (c.net.amount === null) ok(movement.amount === null, c.id + ': net withheld exactly when the movement is');
    else ok(Math.round(c.net.amount * 100) === -Math.round(movement.amount * 100), c.id + ': net = -(posted movement)',
      JSON.stringify([c.net.amount, movement.amount]));
  }
}

console.log('3. Pending rows are listed and move nothing');
{
  const x = fx.fixture(), t = card(x, 'travelvisa');
  const pend = t.transactions.filter(r => r.pending);
  ok(pend.length === 1 && pend[0].amount === 28.6 && pend[0].payment === false, 'the pending 28.60 charge is listed, marked pending');
  ok(t.transactions.filter(r => r.payment).length === 1 && t.transactions.find(r => r.payment).amount === -100,
    'the payment row is marked');
  ok(t.transactions.every(r => typeof r.date === 'string' && typeof r.name === 'string' && 'amount' in r), 'rows carry date, name, amount');
  const y = copy(x); y.packet.transactions.find(r => r.pending).amount = 999;
  const t2 = card(y, 'travelvisa');
  ok(same([t2.paid, t2.spent, t2.net, t2.state], [t.paid, t.spent, t.net, t.state]), 'changing the pending amount moves no figure');
}

console.log('4. Evidence gaps are null with reasons, per card');
{
  const x = fx.fixture(); x.packet.syncEvidence[0].syncEvidence = 'failed';
  const t = card(x, 'travelvisa');
  ok([t.paid, t.spent, t.net].every(f => f.amount === null && f.trust === 'unavailable') && t.state === null,
    'a failed Travel sync withholds every Travel figure');
  ok(card(x, 'cashback').net.amount === 135.8, 'another card is still stated');
  const future = fx.fixture(); future.window = F.spendingCycle(future.plan, '2026-08-28');
  ok(summary(future).every(c => c.net.amount === null && c.net.reasons.includes('future-not-observed')),
    'a future period is not observed: every figure null with future-not-observed');
  ok(F.stackCardSummary(null) === null && F.stackCardSummary({ source: 'other', cards: [] }) === null,
    'anything but a card-period publication publishes nothing');
}

console.log('5. Ledger rules on a hand-built publication (trust, unconfirmed credits, refunds)');
{
  const ready = { trust: 'calculated', completeness: 'complete', reasons: [] };
  const pub = rows => ({ source: 'Forecast.cardPeriodMovements', currency: 'CAD',
    cards: [{ id: 'travelvisa', label: 'Travel', postedMovement: ready, posted: rows, pending: [] }] });
  const row = (amount, kind, extra = {}) => ({ id: String(amount) + kind, date: '2026-08-18', payee: 'Invented', amount, kind, pending: false, ...extra });
  const one = rows => F.stackCardSummary(pub(rows))[0];
  const reconciled = one([row(80, 'charge'), row(-80, 'payment', { paymentAllocation: { status: 'reconciled' } })]);
  ok(same([fig(reconciled.paid), fig(reconciled.net), reconciled.state], [[80, 'calculated'], [0, 'calculated'], 'even']),
    'a reconciled 80 payment against an 80 charge: paid 80 calculated, net 0, even');
  const unlabelled = one([row(80, 'charge'), row(-30, 'credit-unconfirmed')]);
  ok(unlabelled.paid.amount === null && unlabelled.spent.amount === null && unlabelled.state === null
    && unlabelled.paid.reasons.includes('card-credit-purpose-unconfirmed'),
  'a credit not confirmed as payment or refund: paid and spent null, card-credit-purpose-unconfirmed');
  const unknown = one([row(-50, 'payment', { paymentAllocation: { status: 'reconciled' } }), row(20, 'movement-unconfirmed')]);
  ok(unknown.paid.amount === 50 && unknown.spent.amount === null && unknown.net.amount === null
    && unknown.spent.reasons.includes('card-movement-unconfirmed'), 'an unconfirmed movement: spent and net null, paid still 50');
  const refund = one([row(40, 'charge'), row(-60, 'refund')]);
  ok(refund.spent.amount === -20 && refund.paid.amount === 0 && refund.net.amount === 20 && refund.state === 'ahead',
    'a 60 refund against a 40 charge: spent -20, paid 0, net +20 (refunds are not payments)');
  const badAmount = one([row(null, 'charge')]);
  ok(badAmount.spent.amount === null && badAmount.paid.amount === null, 'an unreadable amount withholds, never 0');
}

console.log('6. recommend is unchanged: it carries no stack summary');
{
  const data = fx.served();
  const advice = F.recommend(data.plan, data.meta.asOf, F.budgetRecommendInputs(data, {}));
  ok(!JSON.stringify(advice).includes('stackCard') && !JSON.stringify(advice).includes('stackSummary'),
    'recommend publishes no stack fields (the page calls stackCardSummary beside cardPeriodMovements)');
}

console.log(`\nAll stack card summary checks passed (${checks}).`);
