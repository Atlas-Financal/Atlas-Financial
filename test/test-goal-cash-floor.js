'use strict';
/* One cash floor for goal verdicts and the Unallocated ledger.
 *
 * Invented case, hand-computed here and not by the engine:
 *   opening Bills cash        500
 *   target buffer             100
 *   uncovered card purchase   300  (cash must stay held to pay the card)
 *   protected floor           100 + 300 = 400
 *   commitment, next day      200  -> balance 500 - 200 = 300
 *   day margin                300 - 400 = -100  (a FUNDING GAP of 100)
 *   unallocated at the end    300 - 400 - 0 reserves = -100
 *
 * Before the fix the dated commitment was tested against the bare 100
 * buffer: ON TRACK, funded, remaining 0, margin 200, while the joint
 * funding margin was -100; and Unallocated printed 200.
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const fixture = require('./fixtures/card-purchase-coverage-data');

const OPENING = 500, BUFFER = 100, PURCHASE = 300, COMMITMENT = 200;
const FLOOR = BUFFER + PURCHASE;
const DAY_BALANCE = OPENING - COMMITMENT;
const MARGIN = DAY_BALANCE - FLOOR;

function invented(mutate) {
  const x = fixture();
  x.payload.transactions[0].amount = PURCHASE;
  x.payload.accounts[3].balance = 400 + PURCHASE;
  x.data.plan.defaults.targetBuffer = BUFFER;
  x.data.plan.obligations = [];
  x.data.plan.income = [];
  x.data.plan.commitments = [{ id: 'plan-a', label: 'Invented plan', date: '2026-09-21',
    amount: COMMITMENT, confidence: 'confirmed' }];
  if (mutate) mutate(x);
  const r = Live.fromObservation(x);
  const opts = { debts: r.data.debts, currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals };
  return { x, plan: r.data.plan, opts, sim: F.simulate(r.data.plan, x.asOf, opts),
    plans: F.majorPlans(r.data.plan, x.asOf, opts) };
}
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// Uncovered purchase: the dated commitment fails against the full floor.
{
  const { sim, plans, plan } = invented();
  eq(sim.cardPurchaseCoverage.status, 'ready', 'coverage is known');
  eq(sim.daily.find(d => d.date === '2026-09-21').balance, DAY_BALANCE, 'walk reaches the hand-computed day');
  const row = plans.find(p => p.id === 'plan-a');
  eq(row.verdict, 'FUNDING GAP', 'cash held for the card cannot fund the goal');
  eq(row.funded, false);
  eq(Math.round(row.margin * 100), MARGIN * 100);
  eq(Math.round(row.remaining * 100), -MARGIN * 100);
  eq(Math.round(row.fundingMargin * 100), MARGIN * 100, 'row margin and joint margin agree');
  const free = F.unallocatedCash(sim, { reserveMonthly: 0 }, plan);
  eq(free.buffer, BUFFER);
  eq(Math.round(free.cardPurchaseCash * 100), PURCHASE * 100);
  eq(Math.round(free.amount * 100), (DAY_BALANCE - FLOOR) * 100, 'unallocated subtracts the card cash');
  eq(free.id, 'none'); eq(free.negative, true);
}

// No card purchase: floor is the buffer and the goal is funded with 100 spare.
{
  const { sim, plans, plan } = invented(x => {
    x.payload.transactions = []; x.payload.accounts[3].balance = 400;
  });
  const row = plans.find(p => p.id === 'plan-a');
  eq(row.verdict, 'ON TRACK');
  eq(Math.round(row.margin * 100), (DAY_BALANCE - BUFFER) * 100);
  const free = F.unallocatedCash(sim, { reserveMonthly: 0 }, plan);
  eq(Math.round(free.cardPurchaseCash * 100), 0);
  eq(Math.round(free.amount * 100), (DAY_BALANCE - BUFFER) * 100);
  eq(free.id, 'leftover');
}

// Unknown coverage: the protected card cash is unknown, so Unallocated is withheld.
{
  const { sim, plan } = invented(x => { x.payload.transactions[0].currency = 'usd'; });
  eq(sim.cardPurchaseCoverage.status, 'unavailable');
  const free = F.unallocatedCash(sim, { reserveMonthly: 0 }, plan);
  eq(free.amount, null, 'unknown card cash is never treated as zero');
  eq(free.id, 'cardCoverageUnavailable');
}

// A partial sim with no coverage fields keeps the legacy buffer arithmetic.
{
  const free = F.unallocatedCash({ ending: 1000, buffer: 100 }, { reserveMonthly: 0 }, { windowDays: 28 });
  eq(free.amount, 900); eq(free.cardPurchaseCash, 0);
}

// Every printed verdict has copy on the page.
{
  const src = require('fs').readFileSync(require.resolve('../public/plan.js'), 'utf8');
  const block = src.match(/^const UNALLOCATED_NOTE = \{[\s\S]*?^\};$/m)[0];
  for (const id of ['unavailable', 'cardCoverageUnavailable', 'none', 'leftover']) {
    assert.match(block, new RegExp('\\b' + id + ':'), 'UNALLOCATED_NOTE.' + id); checks++;
  }
}
console.log(`  PASS  one cash floor for goal verdicts and Unallocated (${checks} checks)`);
