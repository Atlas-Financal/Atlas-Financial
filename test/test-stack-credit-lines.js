'use strict';
/* Stack Wallet A6b (lead dispatch, ATLAS LEAD 11, 2026-11-19): the Credit lines. Per card and pay period,
 * Forecast.stackCreditLines(publication, bills) adds to stackCardSummary's paid / spent:
 *   - minimum: the card's row of the period's published bills split (stackSummary.bills.cardMinimums), derived and
 *     never recomputed, so the card and the waterfall's Credit line cannot disagree. No row is null with
 *     'no-minimum-due-in-period'; an unavailable split is null with 'bills-split-unavailable'.
 *   - status: 'upcoming' for a future period; else 'paid-back' when paid >= spent; else 'to-go' with toGo = spent -
 *     paid, computed here. Null with reasons when paid or spent is null.
 *   - minimumCovered: true when paid >= minimum, false when paid < minimum, 'unknown' when either is null.
 * Owner rule: "simple, has more money been put on the card than came off it"; no per-transaction matching. Trust is
 * the weakest input. HELOC is a credit line with its minimum only.
 *
 * Path: the invented card week (test/fixtures/card-posted-period-movement-data.js) -> Forecast.cardPeriodMovements ->
 * Forecast.stackCreditLines, with an invented bills split. By hand (posted rows only):
 *   Travel: paid 100.00, spent 207.40 -> to-go 107.40. Minimum 25 -> covered (100 >= 25).
 *   Cash Back: paid 250.00, spent 114.20 -> paid-back, toGo 0. Minimum 300 -> not covered (250 < 300).
 *   Emerald: 0 / 0 -> paid-back. No minimum row -> minimum null, covered unknown.
 *   Triangle, Amazon Mastercard: paid / spent unavailable -> status null, covered unknown.
 *   HELOC: minimum 50 from the split; paid / spent not published -> status null, covered unknown.
 *
 * `node test/test-stack-credit-lines.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/card-posted-period-movement-data');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay });
const split = { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'cashback', amount: 300 },
  { debtId: 'heloc', amount: 50 }], trust: 'calculated' };
const lines = (x, bills = split) => F.stackCreditLines(publish(x), bills);
const line = (x, id, bills) => lines(x, bills).find(c => c.id === id);

console.log('1. Hand-derived status, to go and minimum covered');
{
  const x = fx.fixture();
  ok(same(lines(x).map(c => c.id), ['travelvisa', 'cashback', 'tdcc', 'triangle', 'mbna', 'heloc']), 'the six credit lines, HELOC included');
  const t = line(x, 'travelvisa');
  ok(t.status === 'to-go' && t.toGo.amount === 107.4 && t.toGo.trust === 'estimated',
    'Travel: to-go 207.40 - 100.00 = 107.40, estimated (its payment source is not reconciled)', JSON.stringify(t.toGo));
  ok(same([t.minimum.amount, t.minimum.trust], [25, 'calculated']) && t.minimumCovered.value === true,
    'Travel: minimum 25 from the split, covered (100 >= 25)');
  const c = line(x, 'cashback');
  ok(c.status === 'paid-back' && c.toGo.amount === 0, 'Cash Back: paid 250.00 >= spent 114.20, paid-back, nothing to go');
  ok(c.minimum.amount === 300 && c.minimumCovered.value === false, 'Cash Back: minimum 300 not covered (250 < 300)');
  const e = line(x, 'tdcc');
  ok(e.status === 'paid-back' && e.minimum.amount === null && same(e.minimum.reasons, ['no-minimum-due-in-period'])
    && e.minimumCovered.value === 'unknown', 'Emerald: nothing spent, paid-back; no minimum due: null, covered unknown');
  for (const id of ['triangle', 'mbna']) {
    const m = line(x, id);
    ok(m.status === null && m.statusReasons.includes('account-transaction-evidence-unavailable') && m.toGo.amount === null
      && m.minimumCovered.value === 'unknown', id + ': paid / spent unavailable, so status and toGo null, covered unknown');
  }
  const h = line(x, 'heloc');
  ok(h.minimum.amount === 50 && h.paid.amount === null && h.paid.reasons.includes('heloc-movement-not-published')
    && h.status === null && h.minimumCovered.value === 'unknown', 'HELOC: minimum 50 only; paid / spent not published');
}

console.log('2. The minimum is the split\'s row, never recomputed');
{
  const x = fx.fixture();
  const twice = line(x, 'travelvisa', { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'travelvisa', amount: 10 }], trust: 'estimated' });
  ok(twice.minimum.amount === 35 && twice.minimum.trust === 'estimated', 'two rows for one card are summed (35), with the split\'s trust');
  ok(line(x, 'travelvisa', null).minimum.reasons[0] === 'bills-split-unavailable'
    && line(x, 'travelvisa', { cardMinimums: null, trust: 'unavailable' }).minimum.amount === null,
  'an unavailable split: minimum null with bills-split-unavailable, never 0');
  const bad = line(x, 'travelvisa', { cardMinimums: [{ debtId: 'travelvisa', amount: 'x' }], trust: 'calculated' });
  ok(bad.minimum.amount === null && bad.minimumCovered.value === 'unknown', 'an unreadable minimum row: null, covered unknown');
  const exact = line(x, 'travelvisa', { cardMinimums: [{ debtId: 'travelvisa', amount: 100 }], trust: 'calculated' });
  ok(exact.minimumCovered.value === true, 'paid exactly the minimum (100 >= 100) covers it');
}

console.log('3. A future period is upcoming');
{
  const x = fx.fixture(); x.window = F.spendingCycle(x.plan, '2026-08-28');
  const all = lines(x);
  ok(all.every(c => c.status === 'upcoming' && c.toGo.amount === null && c.toGo.reasons.includes('future-period')),
    'every line is upcoming, with no to-go amount');
  ok(line(x, 'travelvisa').minimum.amount === 25 && line(x, 'travelvisa').minimumCovered.value === 'unknown',
    'a future minimum is shown; whether it is covered is unknown');
}

console.log('4. A6 is unchanged');
{
  const x = fx.fixture();
  const a6 = F.stackCardSummary(publish(x));
  ok(!a6.some(c => c.id === 'heloc') && a6.every(c => !('minimum' in c) && !('status' in c)),
    'stackCardSummary still publishes the five cards without the A6b fields');
  const t = line(x, 'travelvisa'), base = a6.find(c => c.id === 'travelvisa');
  ok(same([t.paid, t.spent, t.net, t.state, t.transactions], [base.paid, base.spent, base.net, base.state, base.transactions]),
    'stackCreditLines carries A6\'s figures as published');
  ok(F.stackCreditLines(null, split) === null, 'anything but a card-period publication publishes nothing');
}

console.log(`\nAll stack credit line checks passed (${checks}).`);
