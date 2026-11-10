'use strict';
// S1 acceptance (owner direction 2026-10-14 via Atlas, superseding PR #616
// where they conflict): on each Dale payday the sweep is the prior period's
// FULL positive available Bills remainder — inherited positive cash
// included, the new paycheck and other chequing accounts excluded — and
// the Future Budget opening consumes exactly the same published sweep the
// Savings closing projection credits. One Forecast-owned figure,
// `paydaySweep`, is published on each waterfall period and consumed by
// both sides. Negative Bills cash remains visible; nothing is held back
// and Savings is never drawn to cover a Bills deficit. All ledgers and
// literal expected values are independently invented and hand-derived
// from the fixtures; several cases below fail on the pre-S1 base (the
// net-surplus sweep credited less than the Budget remainder carried).
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const F = require(path.join(process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..'), 'public/forecast'));
const input = require('./fixtures/savings-future-closing-data');
const deficitModel = require('./fixtures/savings-deficit-coverage-data');
const ownerModel = require('./fixtures/savings-owner-closing-data');
const allocFx = require('./fixtures/savings-daily-allocation-contract');
const copy = x => JSON.parse(JSON.stringify(x));
function advice(x) {
  const before = JSON.stringify(x), result = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  assert.equal(JSON.stringify(x), before, 'no input, settlement or source mutation');
  return result;
}
function closing(a, start) {
  const view = a.savingsFunding.periodViews.find(p => p.start === start);
  assert.ok(view, 'selected native period exists');
  const p = F.savingsFundingPublication(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id });
  assert.ok(p.forecastClosing, 'Forecast owns the selected-period closing projection');
  return p.forecastClosing;
}
function viewAt(a, start) {
  const v = (a.payPeriodViews || []).find(p => p.start === start);
  assert.ok(v, 'Budget timeline period exists for ' + start);
  return v;
}

test('surplus-only: with no inherited cash the sweep is exactly the period net', () => {
  // Opening 0, receipt 100, later bill 200. Remainder = 0 + 100 = 100.
  const a = advice(deficitModel(100, 200, 500, 0));
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 100);
  assert.equal(viewAt(a, '2026-10-30').opening, 0, 'the sweep leaves Bills; nothing was inherited to leave behind');
  const second = closing(a, '2026-10-30');
  assert.equal(second.contribution, 100); assert.equal(second.stock, 600);
});

test('inherited positive cash sweeps in full with a positive period net', () => {
  // Opening 20, receipt 400: remainder 420 (the pre-S1 net-surplus sweep
  // credited only 400 and left the 20 counted in both publications).
  const a = advice(deficitModel(400));
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 420);
  assert.equal(viewAt(a, '2026-10-30').opening, 0);
  const second = closing(a, '2026-10-30');
  assert.equal(second.contribution, 420); assert.equal(second.stock, 920);
});

test('inherited positive cash sweeps in full with a zero period net', () => {
  // Opening 150, no receipts and no bills: the period net is 0, yet the
  // full 150 of inherited cash is the available remainder and sweeps.
  const x = deficitModel(0, 1, 500, 150);
  x.plan.bills[0].noPaymentRequiredOn = ['2026-11-03'];
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 150);
  assert.equal(viewAt(a, '2026-10-30').opening, 0);
  const second = closing(a, '2026-10-30');
  assert.equal(second.contribution, 150); assert.equal(second.stock, 650);
  assert.equal(closing(a, '2026-11-13').stock, 650, 'nothing further sweeps from an empty remainder');
});

test('inherited positive cash sweeps with a negative period net', () => {
  // Opening 150, receipt 100, bill 200 inside the same period: the period
  // net is -100, but the available remainder is +50 and sweeps in full.
  // (The net-surplus measure swept 0 here.)
  const x = deficitModel(100, 200, 500, 150); x.plan.bills[0].date = '2026-10-20';
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 50);
  assert.equal(viewAt(a, '2026-10-30').opening, 0);
  const second = closing(a, '2026-10-30');
  assert.equal(second.contribution, 50); assert.equal(second.stock, 550);
});

test('negative prior remainder sweeps nothing, stays visible, and Savings is not drawn', () => {
  // Period 2 runs 0 opening (after the sweep) - 200 bill = -200 remainder.
  const a = advice(deficitModel());
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, 0, 'a negative remainder publishes a zero sweep, not a draw');
  assert.equal(viewAt(a, '2026-11-13').opening, -200, 'the negative remainder carries into the next Budget opening in full');
  const second = closing(a, '2026-10-30'), third = closing(a, '2026-11-13');
  assert.equal(second.operatingCash, -200, 'the signed Bills position is published on the close');
  assert.equal(second.projectedDeficitCoverage, 0); assert.equal(third.projectedDeficitCoverage, 0);
  assert.equal(third.contribution, 0, 'no sweep lands on 2026-11-13');
  assert.equal(third.stock, 620, 'Savings is unchanged by the Bills deficit — no automatic draw');
});

test('other chequing accounts are excluded from the sweep and unchanged by it', () => {
  // Unreconciled shape: the second chequing row (chequing-b) is raised
  // to 777 WITHOUT reconciling the recorded payday opening (80). The
  // starting-cash evidence then contradicts itself about the opening's
  // account split, so the Bills-only basis cannot be established: the
  // Budget chain goes unknown and the closes withhold, rather than
  // sweeping pooled cash or inventing a split. The other account
  // itself is never mutated. (The reconciled shape is pinned by the
  // next test.)
  const base = advice(input());
  const x = input(); x.plan.startingCash.breakdown[1].value = 777;
  const other = advice(x);
  assert.equal(viewAt(base, '2026-10-16').paydaySweep, 1080, 'the control sweep is the Bills remainder only');
  assert.equal(viewAt(other, '2026-10-16').opening, null,
    'the Bills share of the pooled opening cannot be established from contradictory evidence');
  assert.equal(viewAt(other, '2026-10-16').paydaySweep, null, 'no sweep is published on an unestablished basis');
  assert.equal(closing(other, '2026-10-30').status, 'unavailable', 'the closes withhold on the same evidence');
  assert.equal(x.plan.startingCash.breakdown[1].value, 777, 'the other account is not mutated');
});

test('reconciled other-chequing cash never enters the sweep (Bills-only basis)', () => {
  // Systems Review 2026-10-15, PR #620 blocker 2: chequing-b holds 777
  // and the household payday snapshot opening is raised by the same 777
  // (80 → 857), keeping the historical opening and current cash
  // reconciled. The starting-cash breakdown establishes the split, so
  // the sweep basis is Bills-only: every published figure equals the
  // control (chequing-b 0) exactly — none of the excluded account's
  // cash is credited to Savings. (Pre-repair this shape swept 1857 and
  // credited 1857, stock 1976: the pooled opening fed the sweep.)
  const control = advice(input());
  const x = input();
  x.plan.startingCash.breakdown[1].value = 777;
  x.plan.opening.paydaySnapshot.opening += 777;
  const a = advice(x);
  for (const start of ['2026-10-16', '2026-10-30', '2026-11-13']) {
    assert.equal(viewAt(a, start).opening, viewAt(control, start).opening, 'Budget opening unchanged at ' + start);
    assert.equal(viewAt(a, start).paydaySweep, viewAt(control, start).paydaySweep, 'sweep unchanged at ' + start);
  }
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1080, 'the sweep is the Bills remainder only');
  assert.equal(closing(a, '2026-10-30').contribution, 1080, 'Savings credits the Bills remainder only');
  assert.equal(closing(a, '2026-10-30').stock, 1199, 'identical to the control — none of the 777 is credited');
});

test('the new paycheck is excluded from its own payday sweep', () => {
  const a = advice(input());
  // The sweep published on the 2026-10-30 period is that period's own
  // remainder (its 1000 receipt alone): not the 1080 arriving that day
  // from the prior period, and not any later receipt.
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, 1000);
  assert.equal(viewAt(a, '2026-10-30').opening, 0,
    'the prior sweep has already left Bills before this period\u2019s paycheck lands');
  // What lands ON 2026-10-30 in Savings is the prior period's remainder.
  assert.equal(closing(a, '2026-10-30').contribution, 1080);
});

test('missing evidence stays unknown: no close publishes an invented sweep', () => {
  // Systems Review 2026-10-15, PR #620 blocker 3: a bill whose amount is
  // unavailable lands inside the 2026-10-16 period. Its load is unknown
  // — not zero — so that period's published sweep goes unknown and the
  // next Budget opening goes unknown with it, while Savings withholds
  // as before. (Pre-repair the period published periodBillLoad 0 and
  // paydaySweep 1080 and the next opening was a known 0.)
  const unknownBill = input();
  unknownBill.plan.bills = [{ id: 'unknown', frequency: 'once', date: '2026-10-20', amount: null }];
  const ua = advice(unknownBill);
  const p = closing(ua, '2026-10-30');
  assert.equal(p.status, 'unavailable'); assert.equal(p.stock, null);
  assert.equal(viewAt(ua, '2026-10-16').periodBillLoad, null, 'the bill load is unknown, not a fabricated zero');
  assert.equal(viewAt(ua, '2026-10-16').paydaySweep, null, 'the sweep goes unknown when the bill load is unknown');
  assert.equal(viewAt(ua, '2026-10-30').opening, null, 'the next opening goes unknown with it — never a known zero');
  // Genuine-zero control: with no bills at all the same period's load
  // is a known zero and its sweep stays known.
  const known = advice(input());
  assert.equal(viewAt(known, '2026-10-16').periodBillLoad, 0, 'a genuinely empty load is a known zero');
  assert.equal(viewAt(known, '2026-10-16').paydaySweep, 1080, 'the genuine-zero sweep stays known');
  const noReceipts = input(); delete noReceipts.opts.currentPeriodActuals;
  const q = closing(advice(noReceipts), '2026-10-30');
  assert.equal(q.status, 'unavailable'); assert.equal(q.stock, null);
});

test('repeated evaluation and navigation replay are immutable', () => {
  const x = input(), before = JSON.stringify(x);
  const a = advice(x);
  const starts = ['2026-10-16', '2026-10-30', '2026-11-13', '2026-11-27'];
  const firstPass = starts.map(s => copy(closing(a, s)));
  const shuffled = ['2026-11-13', '2026-10-16', '2026-11-27', '2026-10-30'].map(s => copy(closing(a, s)));
  assert.deepEqual(shuffled, [firstPass[2], firstPass[0], firstPass[3], firstPass[1]],
    'close values do not depend on navigation order or repetition');
  const a2 = advice(copy(x));
  assert.deepEqual(starts.map(s => copy(closing(a2, s))), firstPass, 'a fresh evaluation reproduces every close');
  assert.deepEqual(starts.map(s => viewAt(a2, s).paydaySweep), starts.map(s => viewAt(a, s).paydaySweep),
    'the published sweeps are identical across evaluations');
  assert.equal(JSON.stringify(x), before, 'evaluation never mutates the plan or its history');
});

test('goals and the sweep are each counted once', () => {
  // Anchor goals: the 1500 goal due 2026-12-18 is debited exactly once,
  // at its own close; cumulative contributions are the two landed
  // remainders (1080 + 1000), each credited once.
  const a = advice(input());
  const last = closing(a, '2026-12-11');
  assert.equal(last.projectedContributions, 2080);
  assert.equal(last.projectedDraws, 1500);
  assert.equal(last.stock, 699);
  assert.equal(11900 + 208000 - 150000, 69900, 'opening stock + two sweeps - the one goal cost');
  // Annual-goal shape: the goal bill sits inside the first period's
  // Budget bill load, and the Savings ledger debits it as a goal cost.
  // S1 repair (Systems Review 2026-10-15, PR #620 blocker 1): Budget
  // restores the deducted goal bill inside its own published remainder,
  // so the published sweeps are 480 and 400 and Savings credits exactly
  // those figures — the cost is paid once across both ledgers, the
  // paired Bills operating position closes at 0, and no residual
  // persists. Independent dated ledger: Bills 80 + Savings 300 +
  // receipts 400 + 400 − goal costs 500 + 400 = 280, ending Bills 0 /
  // Savings 280. (Pre-repair pins — contributions 860, stock 260,
  // operating 20 — encoded the defect: Budget clamped its remainder to
  // 380 on the broken chain and the 20 residual was unexplained.)
  const y = ownerModel(); y.plan.commitments.shift();
  y.plan.bills = [{ id: 'a', label: 'Invented annual goal', frequency: 'yearly', month: 10, day: 21,
    firstDue: '2026-10-21', amount: 500, confidence: 'confirmed', jointCash: false }];
  const ya = advice(y);
  const third = closing(ya, '2026-11-13');
  assert.equal(third.projectedDraws, 900, 'the annual goal (500) and commitment b (400) are each debited once');
  assert.equal(third.projectedContributions, 880, 'the two credited sweeps (480 + 400), each once');
  assert.equal(third.stock, 280);
  assert.equal(third.operatingCash, 0, 'the paired Bills operating position is fully explained — no residual');
  assert.equal(30000 + 48000 + 40000 - 50000 - 40000, 28000);
  assert.equal(viewAt(ya, '2026-10-16').paydaySweep, 480, 'Budget publishes the overlap-restored sweep');
  assert.equal(viewAt(ya, '2026-10-30').paydaySweep, 400);
  assert.equal(viewAt(ya, '2026-10-30').opening, 0, 'the next Budget opening consumes the same 480 sweep');
});

test('the current-period credit and the first future sweep are the same money, counted once', () => {
  // Systems Review 2026-10-15, PR #620 blocker 1b — the current-tail
  // shape from the future-closing suite: a reconciled 200 receipt
  // landed in the Bills account during the current period. The closing
  // projection credits that 200 at the first payday (the current
  // period's boundary credit); the first future period therefore opens
  // on the remainder net of the credit (280 − 200 = 80) and publishes
  // the sweep Savings will credit at the next payday (80 + 1000 =
  // 1080) — the published sweep and the accepted credit are the same
  // number, and the 200 is counted once across the two boundaries.
  // (Pre-repair the period opened on the full 280, published a 1280
  // sweep, and Savings accepted only 1080 of it.)
  const x = input();
  x.plan.income.push({ id: 'current-gift', label: 'Invented operating receipt', frequency: 'once',
    date: '2026-10-04', amount: 200, confidence: 'confirmed' });
  x.plan.startingCash.breakdown[0].value += 200;
  x.opts.currentPeriodActuals.representedActuals.push({ id: 'current-gift', date: '2026-10-04', actual: 200, transactionId: 'gift-receipt' });
  x.opts.currentPeriodActuals.transactions.push({ id: 'gift-receipt', date: '2026-10-04', amount: -200,
    currency: 'CAD', pending: false, isIncome: true, incomeId: 'current-gift', savingsPostingEvidence: 'posted',
    atlasAccountId: 'chequing-a', accountRole: 'household-cash', displayedPayee: 'Invented operating receipt' });
  const a = advice(x);
  assert.equal(closing(a, '2026-10-16').contribution, 200, 'the current-period credit lands at the first payday');
  assert.equal(viewAt(a, '2026-10-16').opening, 80, 'the first future opening is the current remainder net of that credit');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1080, 'the published sweep is the remainder that will actually move');
  assert.equal(closing(a, '2026-10-30').contribution, 1080, 'Savings credits exactly the published sweep');
  assert.equal(closing(a, '2026-10-30').stock, 1399);
  assert.equal(11900 + 20000 + 108000, 139900, 'opening stock + the credit + the sweep, each counted once');
  assert.equal(closing(a, '2026-11-13').stock, 2399, 'the whole household position lands in Savings by the last close');
  assert.equal(closing(a, '2026-11-13').operatingCash, 0, 'no unexplained residual remains in Bills');
});

test('a negative native surplus still establishes the boundary deduction (ledger-paid current annual goal)', () => {
  // Systems Review 5532745420 (PR #620, round 2): the owner-closing
  // fixture with its commitments removed, Savings at 1000, and a single
  // yearly bill of 500 due 2026-10-10 inside the CURRENT period. The
  // bill carries no explicit goalRef: the Savings ledger identifies and
  // pays the 500 goal itself, and Budget deducts it inside the current
  // period's bill load, so the period's native surplus is -500 — a
  // valid signed figure, not unavailable evidence. The closing
  // projection converts that surplus signed and publishes READY; the
  // boundary computation must do the same, so the deduction is
  // established (credit 0: -500 surplus + 500 restored overlap) and the
  // first future period seeds from the goal-restored remainder (80).
  // Hand-derived ledger: Bills opens 80; the goal is paid once by the
  // ledger; the two 400 receipts are the future periods' remainders
  // (80 + 400 = 480, then 400), each sweeping in full; Savings ends
  // 1000 - 500 + 480 + 400 = 1380 with Bills at 0.
  // Pre-repair (head 29a07b72): the boundary computation converted the
  // surplus unsigned, read -500 as unavailable and dropped the
  // deduction, so Budget seeded -420 (80 - 500 unrestored), published
  // sweeps of 0 and 380, and the Nov 13 close signed stock 880 /
  // operatingCash 500 while Savings stayed READY — the two
  // publications disagreed and the merge card's claim that a failed
  // deduction gate only occurs while Savings withholds was false.
  const x = ownerModel();
  x.plan.commitments = [];
  x.plan.savingsPoolObservation.accounts[0].value = 1000;
  x.plan.startingCash.breakdown[2].value = 1000;
  x.plan.bills = [{ id: 'a', label: 'Invented current annual goal', frequency: 'yearly', month: 10, day: 10,
    firstDue: '2026-10-10', amount: 500, confidence: 'confirmed', jointCash: false }];
  const a = advice(x);
  assert.equal(a.savingsFunding.period.nativePeriodSurplus, -500,
    'the current period native surplus is the signed -500, published not dropped');
  assert.equal(viewAt(a, '2026-10-02').periodBillLoad, 500,
    'Budget deducts the goal bill inside the current period load');
  assert.equal(viewAt(a, '2026-10-16').opening, 80,
    'the first future opening seeds from the goal-restored remainder, not the unrestored -420');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 480, 'the first future sweep is the full remainder (80 + 400)');
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, 400);
  const second = closing(a, '2026-10-30');
  assert.equal(second.contribution, 480, 'Savings credits exactly the published 480 sweep');
  assert.equal(second.stock, 980, '1000 opening stock - the 500 goal paid once + the 480 sweep');
  const third = closing(a, '2026-11-13');
  assert.equal(third.status, 'ready');
  assert.equal(third.projectedContributions, 880, 'the two credited sweeps (480 + 400), each once');
  assert.equal(third.projectedDraws, 500, 'the goal cost is debited exactly once');
  assert.equal(third.stock, 1380);
  assert.equal(third.operatingCash, 0, 'the paired Bills operating position is fully explained — no residual');
  assert.equal(100000 - 50000 + 48000 + 40000, 138000);
});

test('control: the same annual goal with an explicit yearly-bill goalRef agrees unchanged', () => {
  // Passing control for the round-2 counterexample above (Systems
  // Review 5532745420): identical fixture, except the Savings pool
  // carries the explicit yearly-bill goalRef for the bill. The goal is
  // then carried as a Savings-funded provision rather than a Budget
  // bill load (current periodBillLoad 0), and the publications have
  // always agreed: opening 80, sweeps 480 and 400, Nov 13 close stock
  // 1380 / Bills 0. This shape passed before the round-2 repair and
  // must keep passing.
  const x = ownerModel();
  x.plan.commitments = [];
  x.plan.savingsPoolObservation.accounts[0].value = 1000;
  x.plan.startingCash.breakdown[2].value = 1000;
  x.plan.bills = [{ id: 'a', label: 'Invented current annual goal', frequency: 'yearly', month: 10, day: 10,
    firstDue: '2026-10-10', amount: 500, confidence: 'confirmed', jointCash: false }];
  x.plan.savingsEarmarks.pools[1].goalRefs = [{ kind: 'yearly-bill', id: 'a' }];
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-02').periodBillLoad, 0,
    'with the explicit goalRef the goal is a Savings-funded provision, not a Budget load');
  assert.equal(viewAt(a, '2026-10-16').opening, 80);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 480);
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, 400);
  const third = closing(a, '2026-11-13');
  assert.equal(third.status, 'ready');
  assert.equal(third.stock, 1380);
  assert.equal(third.projectedDraws, 500, 'the goal cost is debited exactly once');
  assert.equal(third.operatingCash, 0, 'the paired Bills operating position is fully explained');
  assert.equal(100000 - 50000 + 48000 + 40000, 138000);
});

test('Budget and Savings agree across multiple future periods', () => {
  // For every future seam in these fixtures (no goal bills inside the
  // Budget bill load, no household hold): the Savings contribution that
  // lands on a payday equals the sweep the Budget waterfall published on
  // the prior period, and the next Budget opening equals that period's
  // remainder minus the same sweep (a negative remainder carries whole).
  let seams = 0;
  for (const x of [input(), deficitModel(), deficitModel(400)]) {
    const a = advice(x);
    const views = (a.payPeriodViews || [])
      .filter(v => ['next', 'future'].includes(v.timelineRole) && v.start <= '2026-11-27');
    for (let i = 0; i + 1 < views.length; i++) {
      const period = views[i], next = views[i + 1];
      assert.notEqual(period.paydaySweep, null, 'sweep published for ' + period.start);
      const remainder = period.opening + period.incomeAdded - period.periodBillLoad - (period.budgetHold || 0);
      assert.equal(period.paydaySweep, Math.max(0, remainder), 'published sweep is the full positive remainder at ' + period.start);
      assert.equal(next.opening, remainder - period.paydaySweep, 'Budget opening consumes the same sweep at ' + period.start);
      const close = closing(a, next.start);
      if (close.status === 'ready') {
        assert.equal(close.contribution, period.paydaySweep,
          'Savings credits exactly the published sweep at ' + next.start);
        seams++;
      }
    }
  }
  assert.ok(seams >= 8, 'agreement checked across at least eight payday seams, got ' + seams);
});

test('an unqualified current transfer is withheld from the sweep, never swept as if it never left Bills', () => {
  // Supplemental (review 5532991155, N1). A posted 50 transfer out of
  // Bills on 2026-10-05 (balances moved consistently: Bills 80 -> 30,
  // Savings 119 -> 169) whose short reference T1 establishes no unique
  // transfer identity. Savings correctly withholds; Budget must not
  // publish the pre-transfer carry as a known sweep — physical Bills
  // are 30, so the sweep is 1030 from a qualified basis or unknown,
  // NEVER 1080.
  const x = input(); allocFx.transfer(x, 50, 'T1', 'savings', '2026-10-05');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'unavailable', 'Savings withholds: T1 establishes no unique transfer identity');
  assert.equal(viewAt(a, '2026-10-02').opening, 80, 'the recorded current opening stands');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'first future opening withholds rather than carrying the pre-transfer 80');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'no known sweep — never 1080');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, null);
});

test('control: a qualified current transfer (AA101) nets out of the sweep exactly once', () => {
  // Same shape with a reference that establishes unique transfer
  // identity: funding is ready, the transferred 50 is deducted at the
  // boundary, and the sweep equals what Savings credits.
  const x = input(); allocFx.transfer(x, 50, 'AA101', 'savings', '2026-10-05');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'ready');
  assert.equal(viewAt(a, '2026-10-16').opening, 30, 'physical Bills after the transfer');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1030);
  const close = closing(a, '2026-10-30');
  assert.equal(close.contribution, 1030, 'Savings credits exactly the published sweep');
  assert.equal(close.stock, 1199);
});

test('missing Bills cash and a missing snapshot establish no zero: the sweep and post-sweep openings withhold', () => {
  // Supplemental (review 5532991155, N2). The recorded Bills row and
  // the payday snapshot opening are both missing (null). No finite
  // Bills stock or valid snapshot establishes a zero, so the known 0
  // opening and the 1000/1000 sweeps the defective head published are
  // fabricated; the whole dependent chain withholds and no later
  // period re-enters through the pooled walk.
  const x = input();
  x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = null;
  x.plan.opening.paydaySnapshot.opening = null;
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-02').opening, null, 'missing cash is unknown, not a known $0');
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never the fabricated 1000');
  assert.equal(viewAt(a, '2026-10-30').opening, null, 'the chain stays lost — no pooled-walk re-entry');
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, null);
});

test('control: a genuinely recorded zero Bills stock and zero snapshot publish the same figures as known', () => {
  // The identical published figures are valid when the zero is real
  // evidence: both values numeric 0.
  const x = input();
  x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = 0;
  x.plan.opening.paydaySnapshot.opening = 0;
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-02').opening, 0);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1000);
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, 1000);
  const close = closing(a, '2026-10-30');
  assert.equal(close.status, 'ready');
  assert.equal(close.stock, 1119);
});

test('incomplete coverage with a current transfer withholds the dependent sweep (the known transfer is never omitted)', () => {
  // Supplemental (review 5532991155, N3 companion). The AA101 control
  // plus incomplete transaction coverage: funding becomes unavailable
  // and the transfer's inclusion can no longer be established, so the
  // dependent opening/sweep withhold instead of dropping the known 50
  // (defective head: opening 80, sweep 1080).
  const x = input(); allocFx.transfer(x, 50, 'AA101', 'savings', '2026-10-05');
  x.opts.currentPeriodActuals.transactionCoverage = { complete: false };
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'never the pre-transfer 80');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('incomplete coverage preserves the current opening but withholds the future sweep', () => {
  // Owner simplification, 2026-10-15: An unchanged snapshot is not a complete, fresh reconciliation of current Bills.
  const x = input();
  x.opts.currentPeriodActuals.transactionCoverage = { complete: false };
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'unavailable', 'Savings withholds its own figures');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
});

test('a bank reconstruction preserves its opening but does not establish a Bills-only sweep', () => {
  // Owner simplification, 2026-10-15: The pooled #618 opening remains 85. The simplified sweep contract requires current Bills evidence.
  const x = input();
  x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = null;
  x.plan.opening.paydaySnapshot.opening = null;
  x.plan.opening.asOf = '2026-09-30';
  x.plan.opening.cashReconstructionAnchor = {
    source: 'bank-statement', asOf: '2026-09-30', includedThrough: 'end-of-household-day',
    timezone: 'America/Vancouver', currency: 'CAD', ownerApproved: true,
    approvalRef: 'invented-owner-approval-only',
    accounts: [{ id: 'chequing-a', value: 60, statementRef: 'invented-bank-a' },
      { id: 'chequing-b', value: 20, statementRef: 'invented-bank-b' }],
  };
  x.opts.paydayGapCash = {
    complete: true, coverageStart: '2026-09-30', coverageThrough: '2026-10-02',
    movements: [{ id: 'invented-gap-credit', date: '2026-10-01', amount: 5, currency: 'CAD',
      atlasAccountId: 'chequing-a', accountRole: 'household-cash' }],
  };
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-02').opening, 85, 'EOD 60 + 20 plus the proven later credit 5');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
});

// ---- Repair round 3 (review 5535404477): the remaining N2
// qualification paths and the reserve-only over-withholding
// regression. Atlas's extended set: 4 pass / 4 fail on head 1592e9b6;
// the four failures are pinned here with their paired controls.

test('an absent Bills row establishes no zero: the sweep and post-sweep openings withhold', () => {
  // Review 5535404477, P1-a. The chequing-a row is REMOVED from the
  // breakdown (not merely nulled) and the snapshot opening is null.
  // Absence is unknown, exactly like a valueless row: no Bills
  // evidence establishes a $0, so the fabricated known 0 opening and
  // 1000/1000 sweeps the prior head published must withhold. The
  // present-row shapes are the controls already pinned above (the
  // literal-null row withholds; a genuinely recorded $0 publishes).
  const x = input();
  x.plan.startingCash.breakdown = x.plan.startingCash.breakdown
    .filter(r => r.id !== 'chequing-a');
  x.plan.opening.paydaySnapshot.opening = null;
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'unavailable', 'funding withholds');
  assert.equal(viewAt(a, '2026-10-02').opening, null, 'absent cash is unknown, not a known $0');
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never the fabricated 1000');
  assert.equal(viewAt(a, '2026-10-30').opening, null, 'the chain stays lost — no pooled-walk re-entry');
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, null);
});

test('an absent Bills row withholds even when plan.accounts lists both chequing IDs', () => {
  // Review 5535404477, P1-a variant: Atlas reproduced the fabricated
  // zero with AND without plan.accounts explicitly listing the two
  // chequing IDs. Listing the account does not establish its cash.
  const x = input();
  x.plan.startingCash.breakdown = x.plan.startingCash.breakdown
    .filter(r => r.id !== 'chequing-a');
  x.plan.opening.paydaySnapshot.opening = null;
  x.plan.accounts = [{ id: 'chequing-a' }, { id: 'chequing-b' }];
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-02').opening, null);
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null);
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

function eodFixture(gapMode) {
  // The committed reconstruction control's shape: Bills row null,
  // snapshot null, Sep 30 bank EOD anchor 60 + 20, and a later Bills
  // credit of 5 in the gap. gapMode: 'complete' | 'incomplete' | 'absent'.
  const x = input();
  x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = null;
  x.plan.opening.paydaySnapshot.opening = null;
  x.plan.opening.asOf = '2026-09-30';
  x.plan.opening.cashReconstructionAnchor = {
    source: 'bank-statement', asOf: '2026-09-30', includedThrough: 'end-of-household-day',
    timezone: 'America/Vancouver', currency: 'CAD', ownerApproved: true,
    approvalRef: 'invented-owner-approval-only',
    accounts: [{ id: 'chequing-a', value: 60, statementRef: 'invented-bank-a' },
      { id: 'chequing-b', value: 20, statementRef: 'invented-bank-b' }],
  };
  if (gapMode !== 'absent') {
    x.opts.paydayGapCash = {
      complete: gapMode === 'complete', coverageStart: '2026-09-30', coverageThrough: '2026-10-02',
      movements: [{ id: 'invented-gap-credit', date: '2026-10-01', amount: 5, currency: 'CAD',
        atlasAccountId: 'chequing-a', accountRole: 'household-cash' }],
    };
  }
  return x;
}

test('an EOD anchor with incomplete gap coverage establishes no opening: no pooled-walk re-entry', () => {
  // Review 5535404477, P1-b. Only paydayGapCash.complete flips to
  // false on the reconstruction control. A valid anchor alone does
  // not prove the gap after it, so the reconstruction is not
  // qualified: the active opening is unknown AND the chain stays
  // lost — the prior head let Oct 16 re-enter as 0/known with a
  // fabricated 1000 sweep.
  const a = advice(eodFixture('incomplete'));
  assert.equal(viewAt(a, '2026-10-02').opening, null, 'the anchor alone does not establish the opening');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'no re-entry through the pooled walk');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never the fabricated 1000');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, null);
});

test('an EOD anchor with absent gap coverage establishes no opening: no pooled-walk re-entry', () => {
  // Review 5535404477, P1-b variant: paydayGapCash removed entirely.
  const a = advice(eodFixture('absent'));
  assert.equal(viewAt(a, '2026-10-02').opening, null);
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'no re-entry through the pooled walk');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never the fabricated 1000');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('a complete EOD reconstruction is still an opening, not Bills sweep evidence', () => {
  // Owner simplification, 2026-10-15: The #618 authority is unchanged; reconstructed pooled cash is no longer a sweep exemption.
  const a = advice(eodFixture('complete'));
  assert.equal(viewAt(a, '2026-10-02').opening, 85, 'EOD 60 + 20 plus the proven later credit 5');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
});

function reserveTransfer(x, amount, reference) {
  // Move `amount` between the two reserve accounts (savings ->
  // savings-dont-touch) on 2026-10-05, balances moved consistently in
  // the observation and the mirrored starting-cash rows, with posted
  // reserve-only legs. Bills is untouched: no leg involves chequing-a.
  const obs = x.plan.savingsPoolObservation.accounts;
  obs.find(r => r.accountId === 'savings').value -= amount;
  obs.find(r => r.accountId === 'savings-dont-touch').value += amount;
  x.plan.startingCash.breakdown.find(r => r.id === 'savings').value -= amount;
  x.plan.startingCash.heldElsewhere.find(r => r.id === 'savings-dont-touch').value += amount;
  x.opts.currentPeriodActuals.transactions.push(
    { id: reference + '-out', date: '2026-10-05', amount, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted',
      atlasAccountId: 'savings', accountRole: 'household-reserve', kindHint: 'transfer',
      originalMerchant: reference + ' TFR-TO Invented reserve', excludeFromTotals: true },
    { id: reference + '-in', date: '2026-10-05', amount: -amount, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted',
      atlasAccountId: 'savings-dont-touch', accountRole: 'household-reserve', kindHint: 'transfer',
      originalMerchant: reference + ' TFR-FR Invented reserve', excludeFromTotals: true });
  return x;
}

test('an unqualified reserve-only transfer does not remove the independent Bills projection', () => {
  // Review 5535404477, P2 (regression from the N1 repair). A 10 move
  // entirely between reserve accounts with the unqualified reference
  // T1: Savings correctly withholds its ambiguous reserve evidence,
  // but no Bills leg exists, so the independently valid Bills
  // figures stand — the prior head nulled the entire future Budget
  // chain (opening null, sweep null).
  const x = reserveTransfer(input(), 10, 'T1');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'unavailable', 'Savings withholds its own ambiguous reserve evidence');
  assert.equal(viewAt(a, '2026-10-02').opening, 80, 'the recorded Bills opening stands');
  assert.equal(viewAt(a, '2026-10-16').opening, 80, 'independent Bills projection preserved');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1080);
  assert.equal(viewAt(a, '2026-10-30').opening, 0);
});

test('control: a qualified reserve-only transfer (AA101) preserves the Bills projection', () => {
  // Same reserve-only move with a qualified reference: funding is
  // ready and the Bills figures are identical.
  const x = reserveTransfer(input(), 10, 'AA101');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'ready');
  assert.equal(viewAt(a, '2026-10-16').opening, 80);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1080);
  const close = closing(a, '2026-10-30');
  assert.equal(close.stock, 1199);
});

test('control: an unqualified transfer WITH a Bills leg still withholds the dependent sweep', () => {
  // The scoping repair must not reopen N1: the same T1 reference on a
  // transfer out of Bills (a Bills leg in the movement) still
  // withholds the dependent opening and sweep.
  const x = input(); allocFx.transfer(x, 50, 'T1', 'savings', '2026-10-05');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'a Bills-leg movement still withholds');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

// ---------------------------------------------------------------------
// Round 4 (Systems Review 5536953733 on head e8140eb6): two residuals
// of the round-3 repairs. P1-a: the movement-risk scoping consulted
// householdCashLocationId, which takes the FIRST nonempty location
// alias, so a leg with conflicting aliases was treated as established
// on its preferred alias. P1-b: the no-breakdown-rows exemption
// accepted an unavailable dated scalar, which startingCashAmount
// coerces to $0. Paired controls: the round-3 reserve-only tests
// above (unqualified T1 and qualified AA101, both preserving
// 80/1080) and the scalar controls below.
// ---------------------------------------------------------------------

function conflictTransfer(mutate) {
  const x = input(); allocFx.transfer(x, 50, 'T1', 'savings', '2026-10-05');
  const out = x.opts.currentPeriodActuals.transactions.find(tx => tx.id === 'T1-out');
  mutate(out);
  return x;
}

test('conflicting location aliases on a Bills transfer leg withhold the dependent sweep', () => {
  // Review 5536953733, P1-a. The outbound leg's atlasAccountId says
  // 'savings' while its accountId says 'chequing-a'. The funding
  // evidence builder rejects the conflict as unqualified, but the
  // movement-risk scoping read only the preferred alias, treated the
  // leg as an established reserve movement, and published 80/1080 —
  // offering the missing 50 again. Contradictory aliases establish
  // nothing: correct is 1030 or unknown, never 1080.
  const a = advice(conflictTransfer(tx => {
    tx.atlasAccountId = 'savings'; tx.accountId = 'chequing-a'; tx.accountRole = 'household-cash';
  }));
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'conflicting aliases establish no location');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('control: the reversed alias conflict also withholds', () => {
  // atlasAccountId names Bills while accountId names Savings: the
  // pair is contradictory in either order.
  const a = advice(conflictTransfer(tx => {
    tx.atlasAccountId = 'chequing-a'; tx.accountId = 'savings'; tx.accountRole = 'household-cash';
  }));
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
});

test('control: a Bills transfer leg with no account ID at all still withholds', () => {
  // No aliases at all: the location cannot be established, and the
  // household-cash role does not prove the leg stayed off Bills.
  const a = advice(conflictTransfer(tx => {
    tx.atlasAccountId = ''; tx.accountId = ''; tx.account = ''; tx.accountRole = 'household-cash';
  }));
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
});

function scalarFixture(amount, present) {
  // No per-account breakdown rows and no snapshot value: the dated
  // scalar opening is the only claimed basis.
  const x = input();
  x.plan.startingCash.breakdown = [];
  x.plan.opening.paydaySnapshot.opening = null;
  if (present) x.plan.startingCash.amount = amount; else delete x.plan.startingCash.amount;
  return x;
}

test('an unavailable scalar opening (null) establishes no zero: the chain withholds', () => {
  // Review 5536953733, P1-b. startingCashAmount coerces the null
  // scalar to $0; the no-row exemption then published active/future
  // 0/known and swept 1000/1000 on a basis that was never recorded.
  const a = advice(scalarFixture(null, true));
  assert.equal(viewAt(a, '2026-10-02').opening, null, 'an unavailable scalar is not a known zero');
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never the fabricated 1000');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, null);
});

test('an absent scalar opening establishes no zero: the chain withholds', () => {
  // Review 5536953733, P1-b variant: the amount field removed
  // entirely — the same coercion, the same fabricated zero.
  const a = advice(scalarFixture(undefined, false));
  assert.equal(viewAt(a, '2026-10-02').opening, null, 'an absent scalar is not a known zero');
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never the fabricated 1000');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('a scalar opening of 80 is preserved but has no qualified Bills sweep', () => {
  // Owner simplification, 2026-10-15: A dated scalar supplies the incumbent opening, not a current account-specific Bills observation.
  const a = advice(scalarFixture(80, true));
  assert.equal(viewAt(a, '2026-10-02').opening, 80);
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
});

test('a scalar zero is preserved but does not establish zero Bills', () => {
  // Owner simplification, 2026-10-15: A recorded pooled zero is valid for its opening display; it cannot establish the Bills account split.
  const a = advice(scalarFixture(0, true));
  assert.equal(viewAt(a, '2026-10-02').opening, 0);
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
});

// ---------------------------------------------------------------------
// Round 5 (Systems Review 5537773130 on head aaf49c1b): the
// missing-Bills-leg case. The earlier rounds withheld when a Bills
// leg was PRESENT but unqualified; when the outbound Bills leg is
// ABSENT from the packet and only the Savings credit remains, the
// per-leg scoping exempted the credit's established reserve
// location — but a credit cannot prove its absent counterpart
// stayed off Bills, and the un-netted snapshot carry offered cash
// that physically left Bills. The repair fires the movement risk
// for an UNPAIRED reserve credit exactly when Bills stock is
// unreconciled against that carry; no transfer source is inferred.
// ---------------------------------------------------------------------

function missingLegTransfer(reference, extra) {
  const x = input(); allocFx.transfer(x, 50, reference, 'savings', '2026-10-05');
  x.opts.currentPeriodActuals.transactions =
    x.opts.currentPeriodActuals.transactions.filter(tx => tx.id !== reference + '-out');
  if (extra) extra(x);
  return x;
}

test('a missing Bills leg (T1) leaves the remainder unproven: the dependent sweep withholds', () => {
  // Review 5537773130. Balances moved (Bills 80 -> 30, Savings
  // 119 -> 169, snapshot stays 80) but only the Savings credit leg
  // is in evidence. Funding withholds the deduction; Budget must
  // not publish the un-netted carry: physical Bills 30 + the 1000
  // receipt supports qualified 1030 or unknown — never 1080.
  const a = advice(missingLegTransfer('T1'));
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'the missing Bills leg leaves the remainder unproven');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('a missing Bills leg (AA101) leaves the remainder unproven: the dependent sweep withholds', () => {
  // The qualified reference cannot substitute for the missing leg:
  // the same withholding with AA101.
  const a = advice(missingLegTransfer('AA101'));
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('a missing Bills leg with incomplete transaction coverage still withholds', () => {
  const a = advice(missingLegTransfer('AA101', x => {
    x.opts.currentPeriodActuals.transactionCoverage = { complete: false };
  }));
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
});

test('a missing Bills leg with a dropped-row provenance flag still withholds', () => {
  const a = advice(missingLegTransfer('AA101', x => {
    x.opts.currentPeriodActuals.savingsMovementUnconfirmed =
      [{ accountId: 'chequing-a', reason: 'transaction-amount-or-date-unconfirmed' }];
  }));
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
});

test('control: the full AA101 pair still publishes opening 30 / sweep 1030', () => {
  // Paired control: both legs present and qualified — the credit is
  // paired, the deduction is established, nothing withholds.
  const x = input(); allocFx.transfer(x, 50, 'AA101', 'savings', '2026-10-05');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'ready');
  assert.equal(viewAt(a, '2026-10-16').opening, 30);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1030);
});

test('control: the full T1 pair still withholds', () => {
  // Paired control: both legs present, unqualified reference — the
  // original N1 withholding stands.
  const x = input(); allocFx.transfer(x, 50, 'T1', 'savings', '2026-10-05');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(viewAt(a, '2026-10-16').opening, null);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null);
});

test('control: an unmatched reserve-only credit with Bills unchanged preserves 80/1080', () => {
  // A reserve -> reserve move (10) whose outbound reserve leg is
  // dropped leaves an unmatched reserve credit, but Bills stock is
  // unchanged (80 recorded == 80 snapshot): the carry is reconciled
  // and stands; Savings withholds only its own figures.
  const x = input();
  const obs = x.plan.savingsPoolObservation.accounts;
  obs.find(r => r.accountId === 'savings').value -= 10;
  obs.find(r => r.accountId === 'savings-dont-touch').value += 10;
  x.plan.startingCash.breakdown.find(r => r.id === 'savings').value -= 10;
  x.plan.startingCash.heldElsewhere.find(r => r.id === 'savings-dont-touch').value += 10;
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'RSV-out', date: '2026-10-05', amount: 10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'RSV1 TFR-TO Invented reserve', excludeFromTotals: true },
    { id: 'RSV-in', date: '2026-10-05', amount: -10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings-dont-touch', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'RSV1 TFR-FR Invented reserve', excludeFromTotals: true });
  x.opts.currentPeriodActuals.transactions =
    x.opts.currentPeriodActuals.transactions.filter(tx => tx.id !== 'RSV-out');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'unavailable', 'Savings withholds its own ambiguous evidence');
  assert.equal(viewAt(a, '2026-10-16').opening, 80, 'reconciled Bills stock preserves the projection');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1080);
});

test('control: an independently reconciled Bills stock of 30 preserves 1030 while Savings withholds', () => {
  // The missing-leg shape, but the Bills opening/stock pair is
  // independently reconciled at 30 (snapshot records 30, current
  // stock is 30): the carry stands on the reconciled figure, so
  // Budget publishes the physically supported 1030 even though
  // Savings still withholds its ambiguous movement evidence.
  const a = advice(missingLegTransfer('AA101', x => {
    x.plan.opening.paydaySnapshot.opening = 30;
  }));
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(viewAt(a, '2026-10-16').opening, 30);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1030);
});

// ---------------------------------------------------------------------
// Round 6 (Systems Review 5538517077 on head 265e5df1) and the
// Atlas-approved qualification design v2 (Slack thread
// 1792008359.469249, design approval ts 1792094470.590939). Atlas
// verified the 45 committed cases and raised P1-A (a missing Bills
// leg beside an UNKNOWN Bills stock — null or absent row — published
// the dependent chain) and P1-B (a reverse Savings -> Bills movement
// whose Bills credit leg is absent published 80/1080 while the
// qualified pair also published 80/1080, stranding the 10 in Bills).
// The repair replaces the boolean stock-vs-snapshot comparison with
// the tri-state boundary-basis qualification of design v2: one shared
// basis object (value, source, effective cutoff) resolved once in
// recommend; expected stock E[S] = B_bills + F, where F sums EVERY
// evidenced Bills-located flow in the basis interval (the funding
// cycle bridge's accounting, Bills-scoped) and is UNDEFINED — not
// zero — when interval coverage is incomplete. An unaccounted leg is
// exempted only in state known/reconciled, symmetrically for credits
// and debits; a qualified inbound (reserve -> Bills) movement is
// added to the waterfall seed exactly once, and only when it is not
// already embedded in the basis (payday-morning / cutover-opening
// bases embed every in-window movement by construction).
// ---------------------------------------------------------------------

function missingLegAA101(extra) {
  const x = input(); allocFx.transfer(x, 50, 'AA101', 'savings', '2026-10-05');
  x.opts.currentPeriodActuals.transactions =
    x.opts.currentPeriodActuals.transactions.filter(tx => tx.id !== 'AA101-out');
  if (extra) extra(x);
  return x;
}

test('P1-A: a missing Bills leg with a null Bills stock withholds the dependent chain', () => {
  // Review 5538517077, P1-A (A1). The missing-leg shape with the
  // Bills row's value nulled: stock is unknown, an unknown stock is
  // never reconciled, so the dependent chain withholds. The recorded
  // current opening (snapshot 80) may remain displayed.
  const a = advice(missingLegAA101(x => {
    x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = null;
  }));
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(viewAt(a, '2026-10-02').opening, 80, 'the recorded current opening stands');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'unknown stock is never reconciled');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('P1-A: a missing Bills leg with an absent Bills row withholds the dependent chain', () => {
  // Review 5538517077, P1-A (A2). The Bills row is removed outright:
  // absence is unknown exactly like a valueless row.
  const a = advice(missingLegAA101(x => {
    x.plan.startingCash.breakdown =
      x.plan.startingCash.breakdown.filter(r => r.id !== 'chequing-a');
  }));
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'absent stock is never reconciled');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never 1080');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('P1-A: current Bills30 without a boundary basis withholds the sweep', () => {
  // Owner simplification, 2026-10-15: Midperiod stock alone cannot establish the simplified payday-boundary contract.
  const a = advice(missingLegAA101(x => { delete x.plan.opening.paydaySnapshot; }));
  assert.equal(a.savingsFunding.status, 'unavailable', 'Savings withholds its own figures');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
});

test('P1-A: current Bills30 with a null boundary basis withholds the sweep', () => {
  // Owner simplification, 2026-10-15: A null snapshot cannot establish reconciliation even when current Bills has a number.
  const a = advice(missingLegAA101(x => { x.plan.opening.paydaySnapshot.opening = null; }));
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
});

function reversePairAA202(x, { applyBalances = true, billsLeg = true } = {}) {
  // Qualified Savings -> Bills movement of 10 on 2026-10-05 (AA202).
  if (applyBalances) {
    x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value += 10;
    x.plan.startingCash.breakdown.find(r => r.id === 'savings').value -= 10;
    x.plan.savingsPoolObservation.accounts.find(r => r.accountId === 'savings').value -= 10;
  }
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'AA202-out', date: '2026-10-05', amount: 10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'AA202 TFR-TO Invented operating', excludeFromTotals: true });
  if (billsLeg) x.opts.currentPeriodActuals.transactions.push(
    { id: 'AA202-in', date: '2026-10-05', amount: -10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      kindHint: 'transfer', originalMerchant: 'AA202 TFR-FR Invented reserve', excludeFromTotals: true });
  return x;
}

test('P1-B: an absent Bills credit leg withholds (the arithmetic difference does not prove source)', () => {
  // Review 5538517077, P1-B (B1), settled by Atlas (design Q1): only
  // the reserve debit leg is in evidence and Bills stock is 90 —
  // exactly 10 above the snapshot. That arithmetic match does not
  // prove the debit's counterpart landed in Bills, so the dependent
  // chain withholds rather than publishing a qualified 1090.
  const a = advice(reversePairAA202(input(), { billsLeg: false }));
  assert.equal(viewAt(a, '2026-10-02').opening, 80, 'the recorded current opening stands');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'an arithmetic difference does not prove transfer source');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'never a fabricated 1090, never the stranded 1080');
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('P1-B: the full qualified reverse pair (AA202) counts the inbound 10 exactly once', () => {
  // Review 5538517077, P1-B (B2). Both legs posted and qualified;
  // balances moved (Bills 80 -> 90, Savings 119 -> 109). The inbound
  // movement is not embedded in the snapshot basis (payday-morning
  // pre-flow cutoff), so it reaches the seed once: opening 90,
  // sweeps 1090 then 1000, and Savings closes 2199 with no residual
  // operating cash — the 10 is published, not stranded in Bills.
  const a = advice(reversePairAA202(input()));
  assert.equal(a.savingsFunding.status, 'ready');
  assert.equal(viewAt(a, '2026-10-16').opening, 90);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1090);
  assert.equal(viewAt(a, '2026-10-30').paydaySweep, 1000);
  const last = closing(a, '2026-11-13');
  assert.equal(last.stock, 2199, 'opening stock 109 + sweeps 1090 + 1000');
  assert.equal(last.operatingCash, 0, 'no residual is stranded in Bills');
  assert.equal(10900 + 109000 + 100000, 219900);
});

test('P1-B control: an unpaired reserve debit with Bills unchanged preserves 80/1080', () => {
  // Review 5538517077, P1-B control (B3). The same unpaired reserve
  // debit, but balances were NOT applied and Bills stock is still
  // the snapshot 80: the identity reconciles (E[S] = 80 = S), so the
  // leg is exempt — symmetrically for debits as for credits — and
  // only Savings' own figures withhold.
  const a = advice(reversePairAA202(input(), { applyBalances: false, billsLeg: false }));
  assert.equal(a.savingsFunding.status, 'unavailable', 'Savings withholds its own figures');
  assert.equal(viewAt(a, '2026-10-16').opening, 80);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1080);
});

function rsvUnpairedCredit(x) {
  // Reserve -> reserve 10 with the outbound reserve leg dropped: an
  // unmatched reserve credit remains; Bills is untouched by the move.
  const obs = x.plan.savingsPoolObservation.accounts;
  obs.find(r => r.accountId === 'savings').value -= 10;
  obs.find(r => r.accountId === 'savings-dont-touch').value += 10;
  x.plan.startingCash.breakdown.find(r => r.id === 'savings').value -= 10;
  x.plan.startingCash.heldElsewhere.find(r => r.id === 'savings-dont-touch').value += 10;
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'RSV-out', date: '2026-10-05', amount: 10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'RSV1 TFR-TO Invented reserve', excludeFromTotals: true },
    { id: 'RSV-in', date: '2026-10-05', amount: -10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings-dont-touch', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'RSV1 TFR-FR Invented reserve', excludeFromTotals: true });
  x.opts.currentPeriodActuals.transactions =
    x.opts.currentPeriodActuals.transactions.filter(tx => tx.id !== 'RSV-out');
  return x;
}
function ordinarySpend(x, amount) {
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'food-2', date: '2026-10-04', amount, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a',
      accountRole: 'household-cash', categoryId: 'groceries', categoryLabel: 'Groceries',
      displayedPayee: 'Invented grocer food-2' });
  x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value -= amount;
  return x;
}
function ordinaryInflow(x, amount) { // packet sign: amount < 0 is cash in
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'misc-in-1', date: '2026-10-04', amount: -amount, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a',
      accountRole: 'household-cash', displayedPayee: 'Invented one-off inflow misc-in-1' });
  x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value += amount;
  return x;
}

test('N-ORD-1: ordinary spending between observations qualifies the basis (publish the no-leg control figures)', () => {
  // Design v2 §6.8 N-ORD-1 (probe a1/a1c). Ledger: snapshot B = 80 at
  // the 2026-10-02 payday-morning cutoff; in the interval a posted
  // Bills grocery spend of 20 (packet +20) and one unpaired reserve
  // credit (no Bills leg). F = -20 over ALL evidenced Bills flows, so
  // E[S] = 80 - 20 = 60 = S: reconciled — the spend explains the
  // stock difference and the unpaired credit is exempt. The walk
  // models the grocery spend, so publication is the no-leg control's
  // 60 / 1060 exactly. The old boolean (S != snapshot) false-held.
  const control = advice(ordinarySpend(input(), 20));
  const a = advice(ordinarySpend(rsvUnpairedCredit(input()), 20));
  assert.equal(a.savingsFunding.status, 'unavailable', 'Savings withholds its own figures');
  assert.equal(viewAt(a, '2026-10-16').opening, 60);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1060);
  assert.equal(viewAt(a, '2026-10-16').opening, viewAt(control, '2026-10-16').opening);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, viewAt(control, '2026-10-16').paydaySweep);
  assert.equal(viewAt(a, '2026-10-30').opening, 0);
});

test('N-ORD-2: all qualified Bills inflow reaches the shared sweep', () => {
  // Bills80 + observed inflow30 = Bills110. The next receipt1000 makes
  // the sweep1110. The former 80/1080 expectation omitted real Bills cash.
  const control = advice(ordinaryInflow(input(), 30));
  const a = advice(ordinaryInflow(rsvUnpairedCredit(input()), 30));
  assert.equal(viewAt(control, '2026-10-16').opening, 110);
  assert.equal(viewAt(control, '2026-10-16').paydaySweep, 1110);
  assert.equal(viewAt(a, '2026-10-16').opening, 110);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1110);
  assert.equal(viewAt(a, '2026-10-30').opening, 0);
});

test('N-ORD-3: the same explained difference withholds when interval coverage is incomplete or short of the observation', () => {
  // Design v2 §6.8 N-ORD-3 (probe a3). F is DEFINED only on complete
  // evidence over the full basis-to-observation interval; equality
  // under incomplete evidence is coincidence-grade, not
  // reconciliation. Two shapes: the explicit incomplete claim, and a
  // complete claim whose coverage window ends before asOf.
  const incomplete = advice((() => {
    const x = ordinarySpend(rsvUnpairedCredit(input()), 20);
    x.opts.currentPeriodActuals.transactionCoverage = { complete: false };
    return x;
  })());
  assert.equal(viewAt(incomplete, '2026-10-16').opening, null, 'F undefined under an incomplete claim');
  assert.equal(viewAt(incomplete, '2026-10-16').paydaySweep, null);
  const shortWindow = advice((() => {
    const x = ordinarySpend(rsvUnpairedCredit(input()), 20);
    x.opts.currentPeriodActuals.coverageThrough = '2026-10-05';
    x.opts.currentPeriodActuals.savingsFetchCoverage.endDate = '2026-10-05';
    return x;
  })());
  assert.equal(viewAt(shortWindow, '2026-10-16').opening, null,
    'coverage ending 2026-10-05 does not establish the full interval to asOf 2026-10-07');
  assert.equal(viewAt(shortWindow, '2026-10-16').paydaySweep, null);
});

test('N-EMB-1: a midperiod inbound needs a boundary basis before publication', () => {
  // Owner simplification, 2026-10-15: No snapshot or direct payday observation: withhold instead of inferring an earlier boundary.
  const b = advice((() => { const x = reversePairAA202(input(), {}); delete x.plan.opening.paydaySnapshot; return x; })());
  assert.equal(viewAt(b, '2026-10-02').opening, 90, 'the current-stock basis already contains the +10');
  assert.equal(viewAt(b, '2026-10-16').opening, null, 'no qualified boundary basis');
  assert.equal(viewAt(b, '2026-10-16').paydaySweep, null);
  assert.equal(viewAt(b, '2026-10-30').opening, null);
});

test('N-EMB-2: gap reconstruction does not authorize a Bills-only sweep', () => {
  // Owner simplification, 2026-10-15: The pooled reconstruction stays valid as an opening; the simplified contract withholds its dependent sweep.
  const recon = extraGap => {
    const x = input();
    x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = null;
    x.plan.opening.paydaySnapshot.opening = null;
    x.plan.opening.asOf = '2026-09-30';
    x.plan.opening.cashReconstructionAnchor = {
      source: 'bank-statement', asOf: '2026-09-30', includedThrough: 'end-of-household-day',
      timezone: 'America/Vancouver', currency: 'CAD', ownerApproved: true,
      approvalRef: 'invented-owner-approval-only',
      accounts: [{ id: 'chequing-a', value: 60, statementRef: 'invented-bank-a' },
        { id: 'chequing-b', value: 20, statementRef: 'invented-bank-b' }],
    };
    x.opts.paydayGapCash = {
      complete: true, coverageStart: '2026-09-30', coverageThrough: '2026-10-02',
      movements: [{ id: 'invented-gap-credit', date: '2026-10-01', amount: 5, currency: 'CAD',
        atlasAccountId: 'chequing-a', accountRole: 'household-cash' }].concat(extraGap || []),
    };
    return x;
  };
  const control = advice(recon());
  assert.equal(viewAt(control, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(control, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
  const a = advice(recon([{ id: 'invented-gap-inbound', date: '2026-10-01', amount: 50,
    currency: 'CAD', atlasAccountId: 'chequing-a', accountRole: 'household-cash' }]));
  assert.equal(viewAt(a, '2026-10-02').opening, 135, 'the +50 is inside the reconstructed basis');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
});

test('N-CUT-1: future-dated posted evidence cannot qualify the current observation', () => {
  // Owner simplification, 2026-10-15: A packet claiming a future transfer is already posted conflicts with its current observation cutoff.
  const x = input();
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'AA404-out', date: '2026-10-16', amount: 50, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      kindHint: 'transfer', originalMerchant: 'AA404 TFR-TO Invented reserve', excludeFromTotals: true },
    { id: 'AA404-in', date: '2026-10-16', amount: -50, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'AA404 TFR-FR Invented operating', excludeFromTotals: true });
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
  assert.equal(viewAt(a, '2026-10-30').opening, null, 'dependent opening stays unknown');
});

test('N-CUT-2: a qualified pair dated the boundary date is inside the interval (pre-flow morning cutoff)', () => {
  // Design v2 §6.8 N-CUT-2 (probe f2). Contents, not labels: the
  // snapshot basis is the payday MORNING before any boundary-date
  // flow (the boundary paycheck itself is excluded from it), so a
  // movement dated 2026-10-02 is AFTER the cutoff and inside the
  // interval: balances applied (Bills 80 -> 30), the pair is a term
  // of F and of the boundary deduction, and publication is the
  // physical 30 / 1030 with funding ready.
  const x = input(); allocFx.transfer(x, 50, 'AA405', 'savings', '2026-10-02');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'ready');
  assert.equal(viewAt(a, '2026-10-16').opening, 30, 'the boundary-date 50 has physically left Bills');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1030);
});

test('N-CUT-3: a qualified chequing-b -> Bills pair counts its Bills-side effect and never the other balance', () => {
  // Design v2 §6.8 N-CUT-3 (probe q3; Atlas Q3). Contents: pooled
  // snapshot 130 = Bills 80 + chequing-b 50 at the cutoff; the pair
  // moves 10 chequing-b -> Bills inside the interval, so the rows
  // read Bills 90 / chequing-b 40 and the legs net to zero in F
  // (E[S] pooled = 130 = 90 + 40, reconciled). The seed split
  // re-bases to the Bills row: opening 90, sweep 90 + 1000 = 1090.
  // Chequing-b's remaining 40 is never imported (the sweep is not
  // 1130) and the +10 is never added twice (the opening is not 100).
  const x = input();
  x.plan.opening.paydaySnapshot.opening = 130;
  x.plan.startingCash.breakdown.find(r => r.id === 'chequing-b').value = 40;
  x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = 90;
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'BB201-out', date: '2026-10-05', amount: 10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-b', accountRole: 'household-cash',
      kindHint: 'transfer', originalMerchant: 'BB201 TFR-TO Invented Bills', excludeFromTotals: true },
    { id: 'BB201-in', date: '2026-10-05', amount: -10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      kindHint: 'transfer', originalMerchant: 'BB201 TFR-FR Invented other chequing', excludeFromTotals: true });
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'ready');
  assert.equal(viewAt(a, '2026-10-16').opening, 90);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1090, 'the Bills-side effect counts; the other account balance does not');
});

test('N-OFF-1: offsetting unmatched reserve credits under complete evidence publish (the stock witnesses zero net effect)', () => {
  // Design v2 §6.8 N-OFF-1 (probe c1). Two unpaired reserve credits
  // in opposite directions (net zero), balances applied and netting
  // to zero everywhere, coverage complete: F = 0 and S = 80 = B, so
  // the reconciled stock itself witnesses that neither leg moved
  // Bills. Both legs are exempt; publication stands at 80 / 1080
  // while Savings withholds its own figures.
  const reverseCredit = x => {
    x.opts.currentPeriodActuals.transactions.push(
      { id: 'OFF-out', date: '2026-10-05', amount: 10, pending: false, currency: 'CAD',
        savingsPostingEvidence: 'posted', atlasAccountId: 'savings-dont-touch', accountRole: 'household-reserve',
        kindHint: 'transfer', originalMerchant: 'OFF1 TFR-TO Invented reserve', excludeFromTotals: true },
      { id: 'OFF-in', date: '2026-10-05', amount: -10, pending: false, currency: 'CAD',
        savingsPostingEvidence: 'posted', atlasAccountId: 'savings', accountRole: 'household-reserve',
        kindHint: 'transfer', originalMerchant: 'OFF1 TFR-FR Invented reserve', excludeFromTotals: true });
    x.opts.currentPeriodActuals.transactions =
      x.opts.currentPeriodActuals.transactions.filter(tx => tx.id !== 'OFF-out');
    return x;
  };
  const a = advice(reverseCredit(rsvUnpairedCredit(input())));
  assert.equal(a.savingsFunding.status, 'unavailable', 'Savings withholds its own figures');
  assert.equal(viewAt(a, '2026-10-16').opening, 80);
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 1080);
});

test('N-OFF-2: offsetting unmatched reserve credits with incomplete coverage withhold', () => {
  // Design v2 §6.8 N-OFF-2 (probe c2) — the discriminating control:
  // identical to N-OFF-1 except transactionCoverage is incomplete.
  // The boolean equality S == B is coincidence-grade under incomplete
  // evidence: F is undefined, the state is unknown, and the chain
  // withholds. (The prior head published 80/1080 here.)
  const x = rsvUnpairedCredit(input());
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'OFF-out', date: '2026-10-05', amount: 10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings-dont-touch', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'OFF1 TFR-TO Invented reserve', excludeFromTotals: true },
    { id: 'OFF-in', date: '2026-10-05', amount: -10, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'OFF1 TFR-FR Invented reserve', excludeFromTotals: true });
  x.opts.currentPeriodActuals.transactions =
    x.opts.currentPeriodActuals.transactions.filter(tx => tx.id !== 'OFF-out');
  x.opts.currentPeriodActuals.transactionCoverage = { complete: false };
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'no reconciliation without complete interval evidence');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null);
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('N-DUP-1: a duplicated reference (four legs) pairs nothing and withholds', () => {
  // Design v2 §6.8 N-DUP-1 (probe d1). The same physical transfer
  // evidenced twice under ONE reference: the group carries four legs,
  // the pair index qualifies nothing, and every leg is unaccounted.
  // Physical stock is 30; the chain withholds.
  const x = input(); allocFx.transfer(x, 50, 'AA101', 'savings', '2026-10-05');
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'AA101-out2', date: '2026-10-05', amount: 50, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      kindHint: 'transfer', originalMerchant: 'AA101 TFR-TO Invented reserve', excludeFromTotals: true },
    { id: 'AA101-in2', date: '2026-10-05', amount: -50, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'AA101 TFR-FR Invented operating', excludeFromTotals: true });
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'nothing pairs; the legs are unaccounted');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null);
});

test('N-DUP-2: one physical transfer under two references fails the identity and withholds', () => {
  // Design v2 §6.8 N-DUP-2 (probe d2). Both references pair, so both
  // are "accounted" movements — but F sums evidenced LEGS: E[S] =
  // 80 - 50 - 50 = -20 against a physical stock of 30. The identity
  // fails (known/mismatched) and the chain withholds even though
  // every movement is paired; no double-counted figure is ever
  // published and the duplication is never corrected by inference.
  const x = input(); allocFx.transfer(x, 50, 'AA101', 'savings', '2026-10-05');
  x.opts.currentPeriodActuals.transactions.push(
    { id: 'AA102-out', date: '2026-10-05', amount: 50, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      kindHint: 'transfer', originalMerchant: 'AA102 TFR-TO Invented reserve', excludeFromTotals: true },
    { id: 'AA102-in', date: '2026-10-05', amount: -50, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'AA102 TFR-FR Invented operating', excludeFromTotals: true });
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'E[S] = -20 != 30: a double-counted figure is never published');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null);
  assert.equal(viewAt(a, '2026-10-30').opening, null);
});

test('N-NEG-1: a known negative remainder reconciles exactly and publishes signed', () => {
  // Design v2 §6.8 N-NEG-1 (probe e1). A qualified 100 transfer out
  // of Bills leaves S = -20; F = -100, so E[S] = 80 - 100 = -20 = S
  // exactly: a signed negative stock is a figure, not a failure of
  // knowledge. The first future opening publishes -20 signed, its
  // sweep is -20 + 1000 = 980 (the deficit absorbs part of the next
  // receipt), and Savings is never drawn to cover it.
  const x = input(); allocFx.transfer(x, 100, 'AA101', 'savings', '2026-10-05');
  const a = advice(x);
  assert.equal(a.savingsFunding.status, 'ready');
  assert.equal(viewAt(a, '2026-10-16').opening, -20, 'the signed negative remainder publishes');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, 980);
  const close = closing(a, '2026-10-30');
  assert.equal(close.contribution, 980, 'Savings credits exactly the published sweep');
  assert.equal(close.stock, 1199, 'stock 219 (after the qualified 100 landed) + the 980 sweep');
  assert.equal(closing(a, '2026-10-16').operatingCash, 980,
    'the signed -20 deficit absorbs part of the next 1000 receipt in the open — visible, never drawn from Savings');
  assert.equal(closing(a, '2026-11-13').stock, 2199);
  assert.equal(closing(a, '2026-11-13').operatingCash, 0, 'the household position fully lands; no draw occurred');
});

test('N-NEG-2: an unexplained negative stock withholds (known/mismatched)', () => {
  // Design v2 §6.8 N-NEG-2 (probe e2). The same -20 stock with the
  // Bills leg missing: F = 0, E[S] = 80 != -20 — the deficit is real
  // but unexplained, so the dependent chain withholds.
  const a = advice(missingLegTransfer('AA101', x => {
    // rebuild at 100: balances Bills 80 -> -20, only the credit leg kept
    x.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = -20;
    x.plan.startingCash.breakdown.find(r => r.id === 'savings').value = 219;
    x.plan.savingsPoolObservation.accounts.find(r => r.accountId === 'savings').value = 219;
    const credit = x.opts.currentPeriodActuals.transactions
      .find(tx => tx.id === 'AA101-in');
    credit.amount = -100;
  }));
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'an unexplained negative stock is mismatched, not reconciled');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null);
});

test('embedded outbound: midperiod stock without a boundary withholds; it never deducts twice', () => {
  // Owner simplification, 2026-10-15: The 30 current display remains. A future amount needs a direct payday basis or full reconciliation.
  const x = input(); allocFx.transfer(x, 50, 'AA101', 'savings', '2026-10-05');
  delete x.plan.opening.paydaySnapshot;
  const a = advice(x);
  assert.equal(viewAt(a, '2026-10-02').opening, 30, 'the current-stock basis already contains the outbound 50');
  assert.equal(viewAt(a, '2026-10-16').opening, null, 'dependent opening stays unknown');
  assert.equal(viewAt(a, '2026-10-16').paydaySweep, null, 'dependent paydaySweep stays unknown');
  assert.equal(viewAt(a, '2026-10-30').opening, null, 'dependent opening stays unknown');
});

// Split-parent qualification in the S1 Bills-stock loop (PR #653 extension,
// Atlas ruling 2026-10-18): the loop that reconciles the payday-snapshot
// basis against current cash must exclude a qualified split parent exactly
// like the savingsDailyFunding bridge and postedAccountMovements do —
// counting parent plus children misses the closure by the parent amount
// and withholds every future opening, sweep and closing. The skip sits
// AFTER the loop's strict validation, duplicate, pending and
// unpaired-transfer checks, so a defective parent still poisons the stock.
const s1Row = (id, amount, extra = {}) => ({ id, date: '2026-10-04', amount, currency: 'CAD',
  pending: false, savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a',
  accountRole: 'household-cash', displayedPayee: 'Invented split', ...extra });
function s1Shape(rows, cashA = 60) {
  const x = input();
  x.plan.startingCash.breakdown[0].value = cashA;
  x.opts.currentPeriodActuals.transactions.push(...rows);
  return x;
}
function downstream(a) {
  const starts = ['2026-10-16', '2026-10-30', '2026-11-13', '2026-11-27', '2026-12-11'];
  const views = starts.map(start => {
    const v = (a.payPeriodViews || []).find(p => p.start === start);
    return { start, opening: v?.opening ?? null, sweep: v?.paydaySweep ?? null };
  });
  const closings = starts.map(start => {
    const view = a.savingsFunding.periodViews.find(p => p.start === start);
    const pub = F.savingsFundingPublication(a.savingsFunding,
      { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id });
    const c = pub.forecastClosing;
    return { start, status: c?.status ?? 'ready', stock: c?.stock ?? null, contribution: c?.contribution ?? null };
  });
  return { views, closings };
}
const childOnlyRows = () => [s1Row('sp-1a', 12, { parentId: 'sp-1' }), s1Row('sp-1b', 8, { parentId: 'sp-1' })];
const splitRows = () => [s1Row('sp-1', 20, { isGroup: true }), ...childOnlyRows()];
function assertWithheld(a, why) {
  const d = downstream(a);
  assert.equal(d.views[0].opening, null, why + ': future opening withheld');
  assert.equal(d.views[0].sweep, null, why + ': future sweep withheld');
  assert.ok(d.closings.every(c => c.status === 'unavailable'), why + ': every closing unavailable');
}

test('S1 split: parent+children downstream equals child-only (openings, sweeps, closings)', () => {
  const child = downstream(advice(s1Shape(childOnlyRows())));
  assert.deepEqual(child.views[0], { start: '2026-10-16', opening: 60, sweep: 1060 },
    'child-only control: the conserved 20 spend reconciles the S1 closure');
  assert.deepEqual(child.closings.map(c => c.stock), [119, 1179, 2179, 2179, 679],
    'child-only control: closings ready at the hand-derived stocks');
  assert.deepEqual(downstream(advice(s1Shape(splitRows()))), child,
    'a qualified split parent is excluded from the S1 flow: parent+children publishes exactly the child-only downstream');
});

test('S1 split: parent-only still counts the parent once', () => {
  const child = downstream(advice(s1Shape(childOnlyRows())));
  assert.deepEqual(downstream(advice(s1Shape([s1Row('sp-1', 20)]))), child,
    'a split parent with no children in the packet is an ordinary movement');
});

test('S1 split: contradictory duplicate parent still withholds', () => {
  const rows = [...splitRows(), s1Row('sp-1', 21, { isGroup: true })];
  assertWithheld(advice(s1Shape(rows)), 'contradictory duplicate parent rows');
});

test('S1 split: pending parent still withholds (pending check stays ahead of the skip)', () => {
  const rows = [s1Row('sp-1', 20, { isGroup: true, pending: true }), ...childOnlyRows()];
  assertWithheld(advice(s1Shape(rows)), 'pending split parent');
});

test('S1 split: unpaired transfer parent still withholds (pairing check stays ahead of the skip)', () => {
  const rows = [s1Row('sp-1', 20, { isGroup: true, kindHint: 'transfer',
    originalMerchant: 'SP TFR-TO Invented', excludeFromTotals: true }), ...childOnlyRows()];
  assertWithheld(advice(s1Shape(rows)), 'unpaired transfer parent');
});

test('S1 split: outside-window children still exclude the parent (packet-scoped rule)', () => {
  // Children dated before the window start, parent inside it: the
  // incumbent packet-scoped qualification excludes the parent, so the S1
  // closure cannot reconcile on the parent alone and withholds — the same
  // changed behaviour the bridge pin records, not a parity case.
  const rows = [s1Row('sp-1', 20, { isGroup: true }),
    s1Row('sp-1a', 12, { parentId: 'sp-1', date: '2026-10-01' }),
    s1Row('sp-1b', 8, { parentId: 'sp-1', date: '2026-10-01' })];
  assertWithheld(advice(s1Shape(rows)), 'outside-window children');
});

test('S1 split: genuine cash mismatch still withholds', () => {
  assertWithheld(advice(s1Shape(childOnlyRows(), 55)),
    'cash 55 against a reconciled flow of 60');
});
