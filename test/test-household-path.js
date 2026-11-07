'use strict';
// Coverage gap on main 24e1a1d: #470-473 test these features individually,
// but do not follow one independent household ledger through paid evidence,
// category details, successful savings and later holds on the real server.
// Reuse their fixture and authenticated server/renderer; no new infrastructure.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const Detail = require('../public/bill-detail');
const { fixture, variant, ledger } = require('./fixtures/household-path-data');
const { withServer, renderer } = require('./test-savings-evidence-integration');

function assertHousehold(served, result, e) {
  const { row, proposal: p } = result, packet = served.liveOverlay.currentPeriodActuals;
  assert.equal(served.liveOverlay.applied, true);
  assert.equal(served.meta.asOf, e.date);
  assert.ok(O.currentPeriodActualsLooksSanitized(packet));
  assert.equal(served.plan.opening.paydaySnapshot.opening, 300 + 100, 'independent pre-pay opening');
  assert.equal(served.plan.opening.representedEvents.filter(r => r.id === 'payroll').length, 1);
  assert.equal(served.debts[0].balance, e.card);
  assert.equal(served.debts[0].pending, e.pending);
  const stocks = served.plan.startingCash.breakdown;
  assert.equal(stocks.find(a => a.id === 'chequing-a').value, e.a);
  assert.equal(stocks.find(a => a.id === 'chequing-b').value, e.b);
  assert.equal(row.start, '2026-08-14'); assert.equal(row.end, '2026-08-27');
  assert.equal(row.incomeTotal, e.periodIncome, 'received payroll once, no opening/refund/transfer income');
  assert.equal(row.otherIncome.amount, 0);
  assert.equal(row.periodBillLoad, 120, 'full period bill load includes the paid bill');
  assert.equal(row.paidBills, e.billPaid ? 120 : 0);
  assert.equal(row.remainingBills, e.operatingBills);
  assert.equal(row.afterBills, e.afterBills);
  assert.equal(row.budgetHold, e.budgetHold);
  assert.equal(row.afterHouseholdBudget, e.periodResult);
  const bill = row.bills.find(b => b.id === 'shaw');
  assert.equal(bill.date, '2026-08-16');
  assert.equal(bill.status, e.billPaid ? 'PAID' : 'still due');
  const detail = Detail.evidence(bill, served);
  assert.deepEqual(detail.payments, e.billPaid ? [
    { date: '2026-08-16', amount: 120, account: 'chequing-a', pending: false },
  ] : [], 'bill evidence carries the same one debit as the cash ledger');
  for (const [id, planned, spent] of [['groceries', 300, e.groceries], ['restaurants', 100, e.dining]]) {
    const category = row.householdBudget.find(c => c.id === id);
    assert.equal(category.planned, planned);
    assert.equal(category.spent, spent);
    assert.equal(category.remaining, planned - spent);
    const displayed = category.recon.filter(t => !(t.pending && t.pendingPostedDuplicate));
    assert.equal(displayed.reduce((sum, t) => sum + t.amount, 0), spent,
      'independent supplied purchase total agrees with summary and drill-down for ' + id);
  }
  const other = row.householdBudget.find(c => c.otherSpending);
  assert.equal(other?.spent || 0, e.other, 'bill, refund and transfer never enter Other Spend');
  if (other) { assert.equal(other.planned, null); assert.equal(other.remaining, null); }
  assert.equal(p.contribution, e.contribution);
  assert.equal(p.actualSaved, null, 'an earmark does not establish actual savings');
  if (e.hold) {
    assert.equal(p.status, 'unavailable');
    assert.deepEqual(p.evidenceFailures.map(f => f.code), ['card-purchase-coverage-unconfirmed', e.hold]);
    assert.equal(packet.transactions.filter(t => t.pendingPostedDuplicate).length, 2,
      'both unresolved identities survive; no invented match');
    assert.doesNotMatch(result.todayHtml, /\$|data-from-today-cost/);
  } else {
    assert.equal(p.status, 'ready');
    assert.equal(p.currentCash, e.cash);
    assert.equal(p.operatingBills, e.operatingBills);
    assert.equal(p.remainingHousehold, e.remainingHousehold);
    assert.equal(p.requiredOperatingCash, e.operatingBills + e.remainingHousehold + 50 + e.uncoveredCard);
    assert.equal(p.availableNow, e.availableNow);
    assert.equal(p.cashAfterProposal, e.cash - 420);
    assert.equal(p.futureIncomeThisPeriod, 0);
    assert.equal(p.items[0].cumulativeProposed, 420);
    assert.equal(p.items[0].remainingGap, 480);
    const next = p.periods.find(r => r.payday === '2026-08-28');
    assert.equal(next.contribution, 1000 - 120 - 300 - 100);
    assert.equal(next.items[0].cumulativeProposed, 900);
    assert.equal(next.items[0].remainingGap, 0);
    assert.deepEqual(next.payments.map(r => [r.date, r.amount, r.protectedConsumed]), [['2026-09-10', 900, 900]]);
    assert.equal(next.protectedAfterPayments, 0, 'the cost consumes its earmark exactly once');
    assert.ok(p.cashAfterProposal >= p.requiredOperatingCash, 'existing cash floor is protected');
  }
}

function assertVariant(result, mode) {
  const p = result.proposal;
  if (mode === 'floor') {
    assert.equal(p.status, 'funding-gap');
    assert.equal(p.currentCash, 1155);
    assert.equal(p.requiredOperatingCash, 1000 + 235 + 50 + 75);
    assert.equal(p.operatingShortfall, 205);
    assert.equal(p.availableNow, 0); assert.equal(p.contribution, 0);
    assert.equal(p.items[0].remainingGap, 900);
    assert.equal(p.gap.shortBy, 205);
    assert.ok(p.periods.slice(1).every(r => r.status === 'unavailable' && r.contribution === null));
    assert.match(result.todayHtml, /\$205\.00 short|\$205\.00.*short/);
  } else {
    assert.equal(p.status, 'unavailable'); assert.equal(p.contribution, null);
    assert.ok(p.evidenceFailures.some(r => r.code === (mode === 'missing' ? 'cash-observation-account' : 'actuals-stale')));
    assert.doesNotMatch(result.todayHtml, /\$|data-from-today-cost/);
    assert.match(result.todayHtml, mode === 'missing' ? /Synthetic Weekly/ : /Coverage supplied: 2026-08-13 through 2026-08-20/);
  }
}

// G3a once-only invariant (lead condition, PR #856). The $20 Groceries refund
// (row 91008) posts between the settlement and refund-transfer steps. Hand
// expectations: cash rises by exactly 20 (the refund once; the 50 transfer
// nets to zero), Groceries spent falls by exactly 20, so the household's
// remaining budget rises by 20 and available-now moves by 20 - 20 = 0. Main
// published available-now +20 for this step (the refund as free cash with
// no budget effect); a refund counted twice anywhere (cash twice, or also as
// income / Other / transfer) would read +20 or +40 here, never 0.
function assertRefundOnce(steps) {
  const before = steps.get('settlement'), after = steps.get('refund-transfer');
  assert.ok(before && after, 'both steps observed');
  assert.equal(after.currentCash - before.currentCash, 20, 'the refund enters cash exactly once');
  assert.equal(after.groceries - before.groceries, -20, 'the refund nets Groceries once');
  assert.equal(after.remainingHousehold - before.remainingHousehold, 20, 'the refund returns its 20 to the budget once');
  assert.equal(after.availableNow - before.availableNow, 0,
    'available now moves by +20 cash - 20 budget = 0 (main: +20; a double count would be +20 or +40)');
  assert.equal(after.incomeTotal, before.incomeTotal, 'the refund is not income');
  assert.equal(after.other, before.other, 'the refund is not Other');
}

async function main() {
  const render = renderer();
  const steps = new Map();
  await withServer(fixture(), async server => {
    for (const e of ledger) {
      for (const reordered of [false, true]) {
        const input = fixture(e.key);
        if (reordered) {
          input.payload.transactions.reverse(); input.payload.accounts.reverse();
          input.payload.categories.reverse(); input.map.mappings.reverse();
        }
        const before = JSON.stringify(input);
        server.write(input);
        for (let refresh = 0; refresh < 2; refresh++) {
          const served = await server.get();
          const result = render(served);
          assertHousehold(served, result, e);
          const groceries = result.row.householdBudget.find(c => c.id === 'groceries');
          steps.set(e.key, { currentCash: result.proposal.currentCash, availableNow: result.proposal.availableNow,
            remainingHousehold: result.proposal.remainingHousehold, groceries: groceries.spent,
            incomeTotal: result.row.incomeTotal, other: (result.row.householdBudget.find(c => c.otherSpending) || {}).spent || 0 });
        }
        assert.equal(JSON.stringify(input), before, 'observation inputs are immutable');
      }
      console.log('PASS household ' + e.key + ': ' + e.sees);
    }
    assertRefundOnce(steps);
    console.log('PASS household refund once: the $20 Groceries refund adds $20 cash and $20 budget room once; available now is unchanged.');
    for (const mode of ['missing', 'stale', 'floor']) {
      server.write(variant(mode)); assertVariant(render(await server.get()), mode);
      console.log('PASS household ' + mode + ': savings fail closed with the specific evidence or $205 operating shortfall.');
    }
  });
  // A new authenticated process, not a renderer reset or a retained packet.
  await withServer(fixture('resolved'), async server => {
    const served = await server.get();
    assertHousehold(served, render(served), ledger.find(r => r.key === 'resolved'));
    const trajectory = F.baselineTrajectory(served.plan, served.debts, served.meta.asOf, {
      ...served.plan.defaults, currentPeriodActuals: served.liveOverlay.currentPeriodActuals,
      periods: fixture('resolved').periods,
    });
    const first = trajectory.payPeriods[0];
    assert.equal(first.start, '2026-08-21'); assert.equal(first.end, '2026-08-27');
    assert.equal(first.income.amount, 0, 'remaining Forecast window has no income after received payday');
    assert.equal(trajectory.payPeriods[1].income.amount, 1000, 'next full Forecast period contains one payday');
    console.log('PASS household restart: same ledger; Forecast Aug 21-27 income $0 and Budget Aug 14-27 income $1,000 use their own windows.');
  });
}
module.exports = { assertHousehold, assertVariant };
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
