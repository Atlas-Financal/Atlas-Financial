'use strict';
/* The card repayment target (Dale, 2026-11-23, OD-028; dispatched by ATLAS LEAD 12): each Stack credit line's figure after
 * the slash is what the household needs to repay onto the card this pay period:
 *
 *   target = max(statement minimum, the period's new charges) + the amount that brings an over-limit card under its limit.
 *
 * New charges are the card's published Spent (#1557: pending counted, a replaced pending once; fees and interest are
 * charges). The over-limit amount is Forecast.utilisation's overLimitBy, a figure as of today, so it is added in the
 * current period only. Spent withheld: the minimum plus over-limit, a lower bound tagged estimated with its reason. A
 * withheld minimum withholds the target. The HELOC keeps its own rule (its target is its minimum).
 *
 * Every expected figure is worked by hand from the invented card week (test/fixtures/card-posted-period-movement-data):
 *   Travel     Spent 236.00 estimated (posted 172.40 + 63.75 + 6.25 - 35.00 = 207.40, plus the pending 28.60); balance
 *              927.40, limit 5000.
 *   Cash Back  Spent 114.20 calculated; balance 2264.20.
 *   Emerald    Spent 0.00 calculated (no activity); balance 1100.00.
 *   Triangle   Spent withheld (a manual card Forecast cannot see); balance 1980.00.
 * Invented data only. `node test/test-stack-card-repayment-target.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/card-posted-period-movement-data');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay });
const MINIMUMS = [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'tdcc', amount: 40 }, { debtId: 'triangle', amount: 30 },
  { debtId: 'heloc', amount: 50 }];
const bills = (rows = MINIMUMS) => ({ cardMinimums: rows, trust: 'calculated' });
const linesOf = (x, b = bills(), facilities = { debts: x.debts, extra: null, plan: x.plan }) =>
  F.stackCreditLines(publish(x), b, facilities).lines;
const lineOf = (x, id, ...rest) => linesOf(x, ...rest).find(l => l.id === id);
const withLimit = (x, id, limit) => { x.debts.find(d => d.id === id).limit = limit; return x; };

console.log('1. New charges above the minimum: the target is the new charges');
{
  const t = lineOf(fx.fixture(), 'travelvisa');
  ok(cents(t.target.amount) === 23600 && t.target.trust === 'estimated' && cents(t.target.newCharges) === 23600
    && cents(t.target.minimum) === 2500 && t.target.overLimitBy === 0,
    'Travel: max(25.00, 236.00) + 0 = 236.00, estimated (its Spent includes a pending charge)', JSON.stringify(t.target));
  ok(cents(t.minimum.amount) === 2500, 'the minimum itself is unchanged (25.00)');
}

console.log('2. An over-limit card: the amount over the limit is added');
{
  // Travel's limit lowered to 800.00: by hand, used 927.40 - 800.00 = 127.40 over; target 236.00 + 127.40 = 363.40.
  const t = lineOf(withLimit(fx.fixture(), 'travelvisa', 800), 'travelvisa');
  ok(cents(t.target.amount) === 36340 && cents(t.target.overLimitBy) === 12740 && t.target.trust === 'estimated',
    'Travel over its 800.00 limit: 236.00 + 127.40 = 363.40', JSON.stringify(t.target));
  const u = F.utilisation(withLimit(fx.fixture(), 'travelvisa', 800).debts, null, fx.fixture().plan).rows.find(r => r.id === 'travelvisa');
  ok(cents(u.overLimitBy) === cents(t.target.overLimitBy), 'the over-limit part is Forecast.utilisation\'s own overLimitBy, read not recomputed');
}

console.log('3. A no-spend card: the target is the minimum (plus any over-limit)');
{
  const e = lineOf(fx.fixture(), 'tdcc');
  ok(cents(e.target.amount) === 4000 && e.target.trust === 'calculated' && cents(e.target.newCharges) === 0,
    'Emerald, nothing spent: max(40.00, 0.00) + 0 = 40.00, calculated', JSON.stringify(e.target));
  // Emerald's limit lowered to 1000.00: 1100.00 - 1000.00 = 100.00 over; target 40.00 + 100.00 = 140.00.
  const over = lineOf(withLimit(fx.fixture(), 'tdcc', 1000), 'tdcc');
  ok(cents(over.target.amount) === 14000 && cents(over.target.overLimitBy) === 10000 && over.target.trust === 'calculated',
    'Emerald over a 1000.00 limit with nothing spent: 40.00 + 100.00 = 140.00', JSON.stringify(over.target));
}

console.log('4. Spent withheld: the minimum plus over-limit, a lower bound tagged estimated');
{
  const tri = lineOf(fx.fixture(), 'triangle');
  ok(tri.spent.amount === null && cents(tri.target.amount) === 3000 && tri.target.trust === 'estimated'
    && tri.target.reasons.includes('new-charges-unavailable') && tri.target.newCharges === null,
    'Triangle (Spent withheld): 30.00, estimated with new-charges-unavailable, never presented as calculated', JSON.stringify(tri.target));
  // Triangle's limit lowered to 1900.00: 1980.00 - 1900.00 = 80.00 over; target 30.00 + 80.00 = 110.00, still estimated.
  const over = lineOf(withLimit(fx.fixture(), 'triangle', 1900), 'triangle');
  ok(cents(over.target.amount) === 11000 && over.target.trust === 'estimated', 'Triangle over a 1900.00 limit: 30.00 + 80.00 = 110.00, estimated', JSON.stringify(over.target));
}

console.log('5. The HELOC keeps its own rule: its target is its minimum');
{
  const h = lineOf(withLimit(fx.fixture(), 'travelvisa', 800), 'heloc');
  ok(cents(h.target.amount) === 5000 && h.target.trust === h.minimum.trust && h.target.overLimitBy === null && h.target.newCharges === null,
    'HELOC: target 50.00, its minimum, with the minimum\'s trust; no new charges or over-limit part', JSON.stringify(h.target));
  const none = lineOf(fx.fixture(), 'heloc', bills(MINIMUMS.filter(r => r.debtId !== 'heloc')));
  ok(none.target.amount === 0 && none.target.trust === 'calculated',
    'HELOC with no minimum due this period: a published 0 (nothing to repay), never withheld', JSON.stringify(none.target));
}

console.log('6. No minimum due: the target is the new charges; a withheld minimum withholds the target');
{
  const c = lineOf(fx.fixture(), 'cashback');
  ok(c.minimum.amount === null && cents(c.target.amount) === 11420 && c.target.trust === 'calculated',
    'Cash Back, no minimum due this period, spent 114.20: target 114.20', JSON.stringify(c.target));
  const quiet = lineOf(fx.fixture(), 'tdcc', bills([]));
  ok(quiet.target.amount === 0 && quiet.target.trust === 'calculated', 'no minimum and nothing spent: a published 0 (nothing to repay)', JSON.stringify(quiet.target));
  const off = lineOf(fx.fixture(), 'travelvisa', null);
  ok(off.target.amount === null && off.target.trust === 'unavailable' && off.target.reasons[0] === 'minimum-unavailable',
    'the bills split withheld: the target is withheld, never a guess', JSON.stringify(off.target));
}

console.log('7. The over-limit part is today\'s: current period only; unknown when it cannot be read');
{
  const future = withLimit(fx.fixture(), 'travelvisa', 800); future.window = F.spendingCycle(future.plan, '2026-08-28');
  const fl = lineOf(future, 'travelvisa');
  ok(cents(fl.target.amount) === 2500 && fl.target.overLimitBy === 0 && fl.target.trust === 'estimated' && fl.target.reasons.includes('new-charges-unavailable'),
    'an upcoming period: the minimum 25.00 only (no charges yet, today\'s over-limit not carried), estimated', JSON.stringify(fl.target));
  const noFacilities = F.stackCreditLines(publish(fx.fixture()), bills()).lines.find(l => l.id === 'tdcc');
  ok(cents(noFacilities.target.amount) === 4000 && noFacilities.target.trust === 'estimated' && noFacilities.target.reasons.includes('over-limit-unavailable')
    && noFacilities.target.overLimitBy === null,
    'called without the card facilities: the over-limit part is unknown, so the target is a lower bound, estimated', JSON.stringify(noFacilities.target));
}

console.log('8. The minimum tick still means only "minimum covered" (posted-only); the head is unchanged');
{
  // Travel's posted payment 100.00 covers its 25.00 minimum, though the target (236.00) is not paid.
  const x = fx.fixture();
  const r = F.stackCreditLines(publish(x), bills(), { debts: x.debts, extra: null, plan: x.plan });
  const t = r.lines.find(l => l.id === 'travelvisa');
  ok(t.minimumCovered.value === true && cents(t.paidToward.amount) === 10000, 'the minimum is covered by the posted 100.00 payment');
  ok(cents(r.totals.minimumsDue.amount) === 2500 + 4000 + 3000 + 5000, 'the head\'s minimums due is still the sum of minimums (145.00), not the targets');
}

console.log('9. Every card, minimum due or not: $0 only with no minimum, no new charges and not over the limit (lead scope, 2026-11-23)');
{
  // Emerald with no minimum this period (its row dropped from the bills split). By hand: balance 1100.00.
  const noMin = bills(MINIMUMS.filter(r => r.debtId !== 'tdcc'));
  const charge = amount => ({ id: 'tdcc-new', coverageRef: 'invented-tdcc-new', atlasAccountId: 'tdcc', account: 'tdcc',
    accountRole: 'revolving-credit', date: '2026-08-19', amount, currency: 'cad', displayedPayee: 'Example market',
    categoryLabel: 'Groceries', pending: false, savingsPostingEvidence: 'posted' });
  const over = lineOf(withLimit(fx.fixture(), 'tdcc', 1000), 'tdcc', noMin);
  ok(over.minimum.amount === null && cents(over.target.amount) === 10000 && cents(over.target.overLimitBy) === 10000,
    'no minimum, no new charges, over a 1000.00 limit by 100.00: the target is 100.00, not $0', JSON.stringify(over.target));
  const under = lineOf(fx.fixture(), 'tdcc', noMin);
  ok(under.target.amount === 0, 'the same card under its limit: 0 (no minimum, no new charges, not over)', JSON.stringify(under.target));
  // A 50.00 new charge: Spent 50.00 and the balance 1100.00 stays the card's published balance (the fixture's), so the
  // over-limit part is still 1100.00 - 1000.00 = 100.00. Target 50.00 + 100.00 = 150.00.
  const withCharge = withLimit(fx.fixture(), 'tdcc', 1000); withCharge.packet.transactions.push(charge(50));
  const n = lineOf(withCharge, 'tdcc', noMin);
  ok(cents(n.spent.amount) === 5000 && cents(n.target.amount) === 15000, 'the same card with 50.00 of new charges: 50.00 + 100.00 = 150.00', JSON.stringify(n.target));
  // Amazon Mastercard: a manual card (Spent withheld), no minimum this period, over its limit, and its balance a stale
  // estimate (dated before its statement cycle). By hand: 760.00 - 700.00 = 60.00 over; target 60.00, estimated.
  const stale = withLimit(fx.fixture(), 'mbna', 700);
  Object.assign(stale.debts.find(d => d.id === 'mbna'), { statementCloseDay: 5, balanceAsOf: '2026-07-07' });
  const m = lineOf(stale, 'mbna', bills(MINIMUMS));
  ok(cents(m.target.amount) === 6000 && m.target.trust === 'estimated' && m.target.reasons.includes('over-limit-balance-estimated')
    && m.target.reasons.includes('new-charges-unavailable'),
    'Amazon Mastercard (no minimum, Spent withheld, stale balance, over by 60.00): 60.00, kept estimated, never confirmed', JSON.stringify(m.target));
}

console.log(`\nPASS Stack card repayment target (${checks})`);
