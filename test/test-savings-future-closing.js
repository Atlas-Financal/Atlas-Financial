'use strict';
// All ledgers and literal expected cents are independently invented.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const F = require(path.join(process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..'), 'public/forecast'));
const input = require('./fixtures/savings-future-closing-data');
const ownerModel = require('./fixtures/savings-owner-closing-data');
const deficitModel = require('./fixtures/savings-deficit-coverage-data');
const LmGroups = require('./lm-groups-fixture.js');
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
function values(p) { assert.equal(p.status, 'ready', p.reason); return p.items.map(i => Math.round(i.forecastSaved * 100)); }
// Owner direction 2026-10-14 supersedes the PR #610 carry-first semantics
// pinned here before: the prior period's surplus now sweeps in full on the
// NEXT payday (it is still Bills cash at its own period's close), and a
// routine Bills deficit is published, never covered from projected Savings.
// S1 supersession (2026-10-14, via Atlas) for the whole file: the sweep is
// each period's FULL positive available Bills remainder — inherited opening
// cash included — not the period net surplus alone, and the Budget opening
// consumes the same sweep. Superseded net-surplus / unchanged-opening pins
// are re-derived per test below; each moved figure names its old value.
test('payday sweep: prior surplus400 is still Bills at its own close, then sweeps in full', () => {
  // S1: the sweep is the full remainder 420 (20 inherited + 400 surplus,
  // was 400), so Savings lands at 920 (was 900) and Bills at -200
  // (was -180).
  const a = advice(deficitModel(400)), first = closing(a, '2026-10-16'), second = closing(a, '2026-10-30');
  assert.equal(first.stock, 500); assert.equal(first.contribution, 0); assert.equal(first.operatingCash, 420);
  assert.equal(second.stock, 920); assert.equal(second.contribution, 420); assert.equal(second.operatingCash, -200);
  assert.equal(second.projectedDeficitCoverage ?? 0, 0);
  assert.equal(50000 + 42000, 92000, 'opening Savings plus the full swept remainder; the deficit is not charged to Savings');
});
test('payday sweep: surplus100 sweeps in full and the routine deficit200 stays visible, uncovered', () => {
  // S1: the sweep is the full remainder 120 (20 inherited + 100 surplus,
  // was 100), so Savings lands at 620 (was 600) and Bills at -200
  // (was -180). The dated gap is the first floor breach, which the full
  // sweep moves to the payday itself: Bills sits at 0, 20 under the
  // floor (gap was 2026-11-03 at -180 / shortBy 200).
  const a = advice(deficitModel()), first = closing(a, '2026-10-16'), second = closing(a, '2026-10-30');
  assert.equal(first.stock, 500); assert.equal(first.contribution, 0); assert.equal(first.operatingCash, 120);
  assert.equal(second.status, 'ready', second.reason); assert.equal(second.stock, 620); assert.equal(second.operatingCash, -200);
  assert.equal(second.projectedDeficitCoverage, 0); assert.equal(second.projectedDraws, 0);
  assert.equal(second.gap.date, '2026-10-30'); assert.equal(second.gap.signedOperatingCash, 0);
  assert.equal(second.gap.shortBy, 20); assert.equal(second.gap.cashFloor, 20);
  assert.equal(second.items.reduce((sum,i) => sum + i.forecastSaved, 0) + second.unallocated, 620);
  assert.equal(second.actualSaved, null); assert.equal(second.moneyMovementPermission, 'not-granted');
  assert.equal(50000 + 12000, 62000, 'Savings keeps the swept remainder; Bills shows the deficit');
});
test('ample Bills carry sweeps in full on payday; the later deficit publishes uncovered', () => {
  // S1 supersedes the carry-covers premise: the ample carry (1000 opening
  // + 100 receipt = 1100 remainder) no longer stays in Bills to absorb the
  // 200 bill — it sweeps in full, Savings lands at 1600 (was 600), and the
  // bill leaves Bills at -200 (was +800), published uncovered. Savings is
  // still never charged for the deficit.
  const p = closing(advice(deficitModel(100, 200, 500, 1000)), '2026-10-30');
  assert.equal(p.stock, 1600); assert.equal(p.operatingCash, -200); assert.equal(p.projectedDeficitCoverage ?? 0, 0);
  assert.equal(p.gap.date, '2026-10-30'); assert.equal(p.gap.signedOperatingCash, 0); assert.equal(p.gap.shortBy, 20);
  assert.equal(p.cashBasis, 'opening-savings-plus-eligible-surplus-minus-goal-costs',
    'the closing basis no longer subtracts uncovered deficits: Savings never pays them');
});
test('a thin Savings stock is not charged for a Bills deficit: the close stays ready and signed', () => {
  // Supersedes the carry-first pin (stock 50 withheld at -50 after coverage):
  // Savings never pays the routine deficit.
  // S1: the pot is 50 + swept remainder 120 (20 inherited + 100 surplus,
  // was 50 + 100 = 150); Bills closes at -200 (was -180) and the first
  // floor breach dates to the payday (gap was 2026-11-03 / shortBy 200).
  const p = closing(advice(deficitModel(100, 200, 50)), '2026-10-30');
  assert.equal(p.status, 'ready', p.reason); assert.equal(p.stock, 170);
  assert.equal(p.operatingCash, -200); assert.equal(p.projectedDeficitCoverage, 0);
  assert.equal(p.gap.date, '2026-10-30'); assert.equal(p.gap.shortBy, 20);
  assert.equal(5000 + 12000, 17000);
});
test('a later receipt never retrospectively covers an earlier deficit; the shortfall stays on the close', () => {
  // S1: stock 170 (was 150) on the 120 full-remainder sweep; Bills closes
  // at +100 (was +120) after the later 300 receipt; the first floor breach
  // still precedes it, now dated to the payday sweep (was 2026-11-03 at
  // -180 / shortBy 200) — the later receipt never moves the breach.
  const x = deficitModel(100, 200, 50); x.plan.income[2].amount = 300; x.plan.income[2].date = '2026-11-10';
  const p = closing(advice(x), '2026-10-30');
  assert.equal(p.status, 'ready', p.reason); assert.equal(p.stock, 170); assert.equal(p.operatingCash, 100);
  assert.equal(p.gap.date, '2026-10-30'); assert.equal(p.gap.signedOperatingCash, 0);
  assert.equal(p.gap.shortBy, 20); assert.equal(p.projectedDeficitCoverage, 0);
  assert.equal(p.projectedContributions, 120, 'the later receipt is not swept early; only the prior remainder landed');
});
test('a full400 goal cost and a routine deficit consume separate dollars once, from separate ledgers', () => {
  // S1: stock = 500 + swept remainder 120 - 400 goal = 220 (was 200);
  // Bills closes at -200 (was -180).
  const x = deficitModel(); x.plan.commitments[0].date = '2026-11-04'; x.plan.commitments[0].amount = 400;
  const p = closing(advice(x), '2026-10-30');
  assert.equal(p.status, 'ready', p.reason); assert.equal(p.stock, 220); assert.equal(p.operatingCash, -200);
  assert.equal(p.projectedDraws, 400); assert.equal(p.projectedDeficitCoverage, 0);
  assert.ok(p.items.every(i => i.id !== 'a')); assert.equal(50000 + 12000 - 40000, 22000);
});
test('a full-goal cost is debited once from the pot even while Bills runs a visible deficit', () => {
  // S1: stock = 500 + swept remainder 120 - 500 goal = 120 (was 100);
  // Bills closes at +100 after the later receipt (was +120); the dated
  // gap remains the pre-receipt breach, now at the payday (was 2026-11-03
  // at -180).
  const x = deficitModel(); x.plan.commitments[0].date = '2026-11-04'; x.plan.commitments[0].amount = 500;
  x.plan.income[2].amount = 300; x.plan.income[2].date = '2026-11-10';
  const p = closing(advice(x), '2026-10-30');
  assert.equal(p.status, 'ready', p.reason); assert.equal(p.stock, 120);
  assert.equal(p.projectedDraws, 500); assert.equal(p.operatingCash, 100);
  assert.equal(p.gap.date, '2026-10-30'); assert.equal(p.gap.signedOperatingCash, 0);
  assert.equal(50000 + 12000 - 50000, 12000, 'the goal cost is paid from the pot exactly once; no coverage reuses the stock');
});
test('a later non-surplus receipt stays in Bills and grants no sweep of its own', () => {
  // S1: the contribution is the prior period's full remainder 120
  // (20 inherited + 100 surplus, was 100); Bills closes at -100 after the
  // later 100 receipt (was -80); the dated gap is the payday breach
  // (was 2026-11-03 / shortBy 200).
  const x = deficitModel(); x.plan.income[2].amount = 100; x.plan.income[2].date = '2026-11-10';
  const p = closing(advice(x), '2026-10-30');
  assert.equal(p.status, 'ready', p.reason); assert.equal(p.stock, 620);
  assert.equal(p.operatingCash, -100); assert.equal(p.projectedDeficitCoverage, 0);
  assert.equal(p.contribution, 120, 'the contribution is the prior period remainder that landed on this payday');
  assert.equal(p.gap.date, '2026-10-30'); assert.equal(p.gap.shortBy, 20);
});
for (const operating of [80, 1000]) test('owner closing: goals due before the payday sweep leave a signed pot deficit until the sweep lands ' + operating, () => {
  // Supersedes the matrix owner-closing case (300 + 400 - 500 = 200 at the
  // first close), which was derived under sweep-at-close timing. Under the
  // 2026-10-14 payday sweep, goal a (500, due 2026-10-21) is debited before
  // the first period's surplus lands on 2026-10-30.
  // S1 supersession: the first period's sweep is its FULL remainder —
  // opening + 400 receipt — so it is 480 at operating 80 (was 400) and
  // 1400 at operating 1000. At operating 80 the second close still
  // withholds, now at a signed -120 (was -200), and the third close lands
  // at 280 (was 200) with operating cash 0 (was the operating opening:
  // the inherited cash swept, it does not pass through). At operating
  // 1000 the inherited cash is large enough that the second close is
  // already ready at 800 and the third at 1200.
  const x = ownerModel(operating), a = advice(x);
  const first = closing(a, '2026-10-16'), second = closing(a, '2026-10-30'), third = closing(a, '2026-11-13');
  assert.equal(first.status, 'unavailable'); assert.equal(first.stock, null);
  assert.equal(first.diagnostics.signedSavings, -200); assert.deepEqual(first.items, []);
  assert.equal(third.operatingCash, 0); assert.deepEqual(third.items, []);
  assert.equal(third.projectedDraws, 900);
  assert.equal(30000 - 50000, -20000);
  if (operating === 80) {
    assert.equal(second.status, 'unavailable'); assert.equal(second.stock, null);
    assert.equal(second.diagnostics.signedSavings, -120); assert.deepEqual(second.items, []);
    assert.equal(third.status, 'ready', third.reason); assert.equal(third.stock, 280);
    assert.equal(third.projectedContributions, 880);
    assert.equal(-20000 + 48000 - 40000, -12000);
    assert.equal(-12000 + 40000, 28000, 'the second sweep restores the pot once both goal costs are paid');
  } else {
    assert.equal(second.status, 'ready', second.reason); assert.equal(second.stock, 800);
    assert.equal(third.status, 'ready', third.reason); assert.equal(third.stock, 1200);
    assert.equal(third.projectedContributions, 1800);
    assert.equal(30000 + 140000 - 90000, 80000);
    assert.equal(80000 + 40000, 120000, 'the second sweep adds the second period remainder once both goal costs are paid');
  }
  assert.equal(a.savingsFunding.stock.amount, 300); assert.ok(x.plan.commitments.every(c => c.settledOn === undefined));
});
for (const operating of [80, 1000]) test('full signed Savings is not replaced by operating support ' + operating, () => {
  // Supersession: under sweep-at-close these closes signed -100/-400; the
  // payday sweep lands after goal a's date, so the signed pot carries the
  // full unpaid cost until the following payday.
  // S1 supersession: receipts are 100 per period, so the first sweep is
  // the full remainder opening + 100 — 180 at operating 80 (was 100) and
  // 1100 at operating 1000. At operating 80 the second close signs -420
  // (was -500). At operating 1000 the inherited cash covers both goal
  // costs, so the second close publishes ready at 500 instead of
  // withholding (was unavailable at -500) — the signed position is never
  // replaced by operating support; it is the sweep itself that lands.
  const a = advice(ownerModel(operating, 100));
  const first = closing(a, '2026-10-16'), second = closing(a, '2026-10-30');
  assert.equal(first.status, 'unavailable'); assert.equal(first.stock, null);
  assert.equal(first.diagnostics.signedSavings, -200);
  assert.deepEqual(first.items, []); assert.deepEqual(first.rows, []);
  assert.equal(30000 - 50000, -20000);
  if (operating === 80) {
    assert.equal(second.status, 'unavailable'); assert.equal(second.stock, null);
    assert.equal(second.diagnostics.signedSavings, -420);
    assert.deepEqual(second.items, []); assert.deepEqual(second.rows, []);
    assert.equal(-20000 + 18000 - 40000, -42000);
  } else {
    assert.equal(second.status, 'ready', second.reason); assert.equal(second.stock, 500);
    assert.equal(second.projectedContributions, 1100); assert.equal(second.projectedDraws, 900);
    assert.equal(30000 + 110000 - 90000, 50000);
  }
});
test('positive signed closing arithmetic does not authorize a cost before its income arrives', () => {
  const x = ownerModel(); x.plan.income[1].date = '2026-10-24'; x.plan.commitments[0].date = '2026-10-16';
  const a = advice(x), p = closing(a, '2026-10-16');
  assert.equal(30000 - 50000, -20000, 'at the close the pot itself is signed negative: the funding income sweeps only on the next payday');
  assert.equal(p.diagnostics.signedSavings, -200);
  assert.equal(p.status, 'unavailable'); assert.equal(p.stock, null);
  assert.equal(p.gap.date, '2026-10-29'); assert.equal(p.gap.shortBy, 200);
  assert.equal(p.gap.cashFloor, 20);
  assert.equal(a.savingsFunding.period.status, 'ready', 'incumbent zero-tail condition is preserved');
});
test('two future periods of 1000 add exactly 2000 by the third close, spilling into the next requirement', () => {
  // Each period's surplus lands on the FOLLOWING payday, so the two 1000
  // surpluses complete at the third close, not the second (supersedes the
  // sweep-at-close pin, which completed at the second close).
  // S1 supersession: the two landed sweeps are the periods' full
  // remainders — 1080 (80 inherited + 1000) then 1000 (was 1000 + 1000) —
  // so the closes land at 1199 (was 1119) and 2199 (was 2119), the spill
  // into b is 699 (was 619), and the arrived-tranche attribution is
  // [301, 699] (was [381, 619]: the tranche tops a up by 1500 - 1199).
  const a = advice(input()), first = closing(a, '2026-10-16'), second = closing(a, '2026-10-30'), third = closing(a, '2026-11-13');
  assert.equal(first.end, '2026-10-29'); assert.equal(first.stock, 119);
  assert.deepEqual(values(first), [11900, 0]);
  assert.deepEqual(first.rows.map(r => r.forecastContribution), [0, 0]);
  assert.equal(second.end, '2026-11-12'); assert.equal(second.stock, 1199);
  assert.deepEqual(values(second), [119900, 0]);
  assert.deepEqual(second.rows.map(r => r.forecastContribution), [1080, 0]);
  assert.equal(third.end, '2026-11-26'); assert.equal(third.stock, 2199);
  assert.deepEqual(values(third), [150000, 69900]);
  assert.deepEqual(third.rows.map(r => r.forecastContribution), [301, 699]);
  assert.equal(11900 + 108000 + 100000, 150000 + 69900);
  assert.equal(third.actualSaved, null); assert.equal(third.trust, 'estimated');
});
test('actual current allocation, generic deadline schedule and input remain unchanged by navigation/replay', () => {
  const x = input(), a = advice(x), before = copy(a.savingsFunding);
  assert.deepEqual(a.savingsFunding.backing.items.map(i => i.saved), [119, 0]);
  for (const date of ['2026-10-30', '2026-10-16', '2026-10-30']) closing(a, date);
  assert.deepEqual(copy(a.savingsFunding), before); assert.deepEqual(copy(advice(x)), copy(a));
  assert.equal(a.savingsFunding.stock.amount, 119);
});
test('native goal expense between closes is paid once and removed only from the projection', () => {
  // S1 supersession: the landed sweep is the full remainder 1080
  // (was 1000), so the pot after the one 80 goal cost is 1119 (was 1039)
  // with 119 unallocated (was 39).
  const x = input(); x.plan.commitments[0].date = '2026-11-03'; x.plan.commitments[0].amount = 80;
  const a = advice(x), p = closing(a, '2026-10-30');
  assert.equal(p.stock, 1119); assert.deepEqual(values(p), [100000]);
  assert.equal(p.unallocated, 119); assert.equal(p.projectedDraws, 80);
  assert.ok(a.savingsFunding.backing.items.some(i => i.id === 'a'));
  assert.equal(x.plan.commitments[0].settledOn, undefined);
  assert.equal(Math.round(p.operatingCash * 100) + Math.round(p.stock * 100), 8000 + 11900 + 200000 - 8000);
});
test('bills and household deductions consume each dollar once before surplus is poured', () => {
  const x = input(); x.plan.bills = [{ id: 'bill', label: 'Invented bill', frequency: 'once', date: '2026-10-20', amount: 100, confidence: 'confirmed' }];
  x.opts.daleIncomeAuthorityEnd = '2026-11-12';
  x.plan.commitments[0].date = '2027-01-03';
  x.plan.budget.categories = [{ id: 'groceries', label: 'Invented food', class: 'essential', plannedPayday: 100, plannedWeekly: 50, confidence: 'confirmed' }];
  x.plan.opening.paydaySnapshot.opening = 180;
  x.opts.currentPeriodActuals.transactions.push({ id: 'food-receipt', date: '2026-10-03', amount: 100,
    pending: false, currency: 'CAD', atlasAccountId: 'chequing-a', accountRole: 'household-cash',
    savingsPostingEvidence: 'posted', categoryId: 'groceries', categoryLabel: 'Groceries', displayedPayee: 'Invented Superstore' });
  x.plan = LmGroups.groupPlan(x.plan);
  x.opts.currentPeriodActuals = LmGroups.groupPacket(x.opts.currentPeriodActuals, x.plan);
  const p = closing(advice(x), '2026-10-30');
  assert.equal(p.status, 'ready', p.reason);
  // Only the first period's remainder has landed by this close; the second
  // period's remainder sweeps on 2026-11-13. Supersedes the sweep-at-close
  // pin of 1819 / [150000, 31900].
  // S1 supersession: the landed amount is the first period's FULL
  // remainder — its opening is the 180 snapshot less the 100 of current
  // food spending = 80 inherited, plus the 1000 receipt, less the 100
  // bill and the 100 household hold = 880 (was the 800 net surplus) — so
  // the close is 999 (was 919).
  assert.equal(p.stock, 999); assert.deepEqual(values(p), [99900, 0]);
  assert.equal(11900 + 88000, 99900);
});
test('a small later deficit does not reduce the sweep; the shortfall publishes instead', () => {
  // S1 supersession of the native-carry pin (Savings 1119 / Bills 60):
  // the full remainder 1080 (80 inherited + 1000) sweeps, so Savings
  // lands at 1199 and the 20 bill leaves Bills at -20, published — the
  // sweep is not trimmed to preserve the floor.
  const x = input(); x.plan.income[2].amount = 0;
  x.plan.commitments[0].date = '2027-01-03';
  x.plan.bills = [{ id: 'deficit', label: 'Invented deficit bill', frequency: 'once', date: '2026-11-03', amount: 20, confidence: 'confirmed' }];
  const p = closing(advice(x), '2026-10-30');
  assert.equal(p.stock, 1199); assert.equal(p.operatingCash, -20); assert.deepEqual(values(p), [119900, 0]);
});
test('later deficit no longer limits the payday sweep; the deficit is published instead', () => {
  // Supersedes the retention-search pin (Savings 1079 / Bills 20): the full
  // surplus sweeps and Bills closes in deficit with the shortfall on the
  // packet.
  // S1 supersession: the sweep is the full remainder 1080 (was 1000), so
  // Savings lands at 1199 (was 1119) and Bills closes at -100 (was -20);
  // the dated gap is the first floor breach, on the payday itself (was
  // 2026-11-03 at -20 / shortBy 40).
  const x = input(); x.plan.income[2].amount = 0;
  x.plan.commitments[0].date = '2027-01-03';
  x.plan.bills = [{ id: 'deficit', label: 'Invented deficit bill', frequency: 'once', date: '2026-11-03', amount: 100, confidence: 'confirmed' }];
  const p = closing(advice(x), '2026-10-30');
  assert.equal(p.status, 'ready', p.reason);
  assert.equal(p.stock, 1199); assert.equal(p.operatingCash, -100); assert.equal(p.projectedDraws, 0);
  assert.equal(p.projectedDeficitCoverage, 0);
  assert.equal(p.gap.date, '2026-10-30'); assert.equal(p.gap.signedOperatingCash, 0); assert.equal(p.gap.shortBy, 20);
});
test('proved current income already in Savings is never poured into the pot again', () => {
  const x = input();
  x.plan.income.push({ id: 'current-gift', label: 'Invented received gift', frequency: 'once',
    date: '2026-10-04', amount: 200, confidence: 'confirmed' });
  x.plan.savingsPoolObservation.accounts[0].value += 200;
  x.plan.startingCash.breakdown.find(r => r.id === 'savings').value += 200;
  x.opts.currentPeriodActuals.representedActuals.push({ id: 'current-gift', date: '2026-10-04', actual: 200, transactionId: 'gift-receipt' });
  x.opts.currentPeriodActuals.transactions.push({ id: 'gift-receipt', date: '2026-10-04', amount: -200,
    currency: 'CAD', pending: false, isIncome: true, incomeId: 'current-gift', savingsPostingEvidence: 'posted',
    atlasAccountId: 'savings', accountRole: 'household-reserve', displayedPayee: 'Invented received gift' });
  const a = advice(x), p = closing(a, '2026-10-30');
  assert.equal(a.savingsFunding.period.alreadySavedIncome, 200);
  assert.equal(a.savingsFunding.period.projectedRemainingCapacity, 0);
  // S1: the landed sweep is the first period's full remainder 1080
  // (was 1000), so the close is 1399 (was 1319); the proved 200 already
  // in Savings is still counted exactly once, inside the stock.
  assert.equal(p.stock, 1399); assert.deepEqual(values(p), [139900, 0]);
});
test('only a reconciled untransferred current tail can join future surplus', () => {
  const x = input();
  x.plan.income.push({ id: 'current-gift', label: 'Invented operating receipt', frequency: 'once',
    date: '2026-10-04', amount: 200, confidence: 'confirmed' });
  x.plan.startingCash.breakdown[0].value += 200;
  x.opts.currentPeriodActuals.representedActuals.push({ id: 'current-gift', date: '2026-10-04', actual: 200, transactionId: 'gift-receipt' });
  x.opts.currentPeriodActuals.transactions.push({ id: 'gift-receipt', date: '2026-10-04', amount: -200,
    currency: 'CAD', pending: false, isIncome: true, incomeId: 'current-gift', savingsPostingEvidence: 'posted',
    atlasAccountId: 'chequing-a', accountRole: 'household-cash', displayedPayee: 'Invented operating receipt' });
  // S1: 1399 (was 1319) — the reconciled 200 tail joins through the
  // current period's own entitlement and the first future period sweeps
  // its full remainder 1080 (was 1000).
  const p = closing(advice(x), '2026-10-30'); assert.equal(p.stock, 1399);
  const uncertain = copy(x); uncertain.opts.currentPeriodActuals.representedActuals = [];
  uncertain.opts.currentPeriodActuals.transactions = [];
  const unknown = closing(advice(uncertain), '2026-10-30');
  assert.equal(unknown.status, 'unavailable'); assert.equal(unknown.stock, null);
});
test('an unexplained reported increase changes current stock only, never income entitlement', () => {
  const x = input(); x.plan.savingsPoolObservation.accounts[0].value += 200;
  x.plan.startingCash.breakdown.find(r => r.id === 'savings').value += 200;
  const a = advice(x); assert.equal(a.savingsFunding.period.alreadySavedIncome, 0);
  assert.equal(a.savingsFunding.period.projectedRemainingCapacity, 0);
  // S1: 1399 (was 1319) on the first period's full-remainder sweep 1080;
  // the unexplained 200 still changes the reported stock only.
  assert.equal(closing(a, '2026-10-30').stock, 1399);
});
test('outside native income authority remains unknown', () => {
  const x = input(); x.opts.daleIncomeAuthorityEnd = '2026-10-29';
  const a = advice(x);
  assert.ok(!a.savingsFunding.periodViews.some(p => p.start === '2026-10-30'));
  assert.equal(F.savingsFundingPublication(a.savingsFunding, { asOf: x.asOf, advice: a, periodId: 'outside-income-authority' }), null);
});
for (const gap of ['receipt', 'stock', 'bill', 'date', 'pending', 'card-coverage']) test('unknown ' + gap + ' stays unknown, never a zero or guessed surplus', () => {
  const x = input();
  if (gap === 'receipt') delete x.opts.currentPeriodActuals;
  if (gap === 'stock') x.plan.savingsPoolObservation.accounts.pop();
  if (gap === 'bill') x.plan.bills = [{ id: 'unknown', frequency: 'once', date: '2026-10-20', amount: null }];
  if (gap === 'date') delete x.plan.commitments[1].date;
  if (gap === 'pending') x.plan.savingsPoolObservation.accounts[0].pendingState = 'unresolved';
  if (gap === 'card-coverage') x.opts.currentPeriodActuals.cardCoverageRequired = true;
  const p = closing(advice(x), '2026-10-30'); assert.equal(p.status, 'unavailable'); assert.equal(p.stock, null);
});
for (const fault of ['date', 'source', 'permission', 'currency', 'items', 'stock', 'saved']) test('closing publication rejects malformed ' + fault, () => {
  const x = input(), a = advice(x), publication = copy(a.savingsFunding);
  const view = publication.periodViews.find(p => p.start === '2026-10-30'), c = view.packet.forecastClosing;
  if (fault === 'date') c.end = '2026-11-13';
  if (fault === 'source') c.source = 'Page.alternative';
  if (fault === 'permission') c.actionPermission = 'granted';
  if (fault === 'currency') c.currency = 'USD';
  if (fault === 'items') c.items = {};
  if (fault === 'stock') c.stock = null;
  if (fault === 'saved') c.items[0].saved = 1500;
  assert.equal(F.savingsFundingPublication(publication, { asOf: x.asOf, advice: a, periodId: view.id }), null);
});

function installments() {
  const x = input();
  x.plan.commitments = [
    { id: 'one', label: 'Invented installment one', group: 'installments', date: '2026-10-29', amount: 80, confidence: 'confirmed', sinkingFund: true },
    { id: 'two', label: 'Invented installment two', group: 'installments', date: '2026-11-12', amount: 60, confidence: 'confirmed', sinkingFund: true },
    { id: 'later', label: 'Invented later requirement', date: '2027-01-04', amount: 3000, confidence: 'confirmed', sinkingFund: true }];
  x.plan.groups = [{ id: 'installments', label: 'Invented installment group', planSpendSummary: true }];
  return x;
}
test('native unavoidable later gap preserves affordable earlier closes and withholds the failing close', () => {
  const x = input();
  x.plan.defaults.targetBuffer = 0;
  x.plan.startingCash.breakdown[0].value = x.plan.opening.paydaySnapshot.opening = 0;
  x.plan.savingsPoolObservation.accounts[0].value = x.plan.startingCash.breakdown[2].value = 800;
  x.plan.savingsPoolObservation.accounts[1].value = x.plan.startingCash.heldElsewhere[0].value = 0;
  x.plan.income[1].amount = x.plan.income[2].amount = 200;
  x.plan.income.push({ id: 'p3', label: 'Invented third receipt', frequency: 'once', date: '2026-11-13', amount: 200, confidence: 'confirmed' });
  x.plan.commitments = [
    { id: 'a', label: 'Invented first cost', date: '2026-10-29', amount: 500, confidence: 'confirmed', sinkingFund: true },
    { id: 'b', label: 'Invented second cost', date: '2026-11-12', amount: 600, confidence: 'confirmed', sinkingFund: true },
    { id: 'c', label: 'Invented third cost', date: '2026-11-26', amount: 400, confidence: 'confirmed', sinkingFund: true }];
  const a = advice(x), first = closing(a, '2026-10-16'), second = closing(a, '2026-10-30');
  // Under the payday sweep the first close holds only the opening stock
  // less goal a: its own 200 surplus lands on 2026-10-30. That sweep, less
  // goal b, leaves the second close signed -100 and withheld; the third
  // carries -300. Affordable closes still publish (supersedes the
  // sweep-at-close pins 500 / 100 / gap 100).
  assert.equal(first.status, 'ready', first.reason); assert.equal(first.stock, 300);
  assert.deepEqual(first.items.map(i => [i.id, i.forecastSaved]), [['b', 300], ['c', 0]]);
  assert.equal(second.status, 'unavailable'); assert.equal(second.stock, null);
  assert.equal(second.diagnostics.signedSavings, -100);
  assert.equal(second.gap.date, '2026-11-12'); assert.equal(second.gap.shortBy, 100);
  const third = closing(a, '2026-11-13');
  assert.equal(third.status, 'unavailable'); assert.equal(third.stock, null);
  assert.equal(third.gap.date, '2026-11-26'); assert.equal(third.gap.shortBy, 300);
  assert.equal(third.gap.signedOperatingCash, -100); assert.equal(third.gap.cashFloor, 0);
  assert.deepEqual(third.items, []); assert.deepEqual(third.rows, []);
  assert.equal(80000 + 20000 + 20000 - 50000 - 60000 - 40000, -30000,
    'opening + the two landed sweeps - all three costs, no invented funding');
  assert.deepEqual(copy(closing(a, '2026-10-16')), copy(first));
});
test('operating support cannot zero-clamp a -200 signed Savings close', () => {
  // S1 supersession of the -300 pin: the first period's sweep is its full
  // remainder (100 inherited opening + 200 receipt = 300, was the 200
  // surplus only), so the signed pot at this close is -200 (was -300).
  // The total household identity below is unchanged.
  const x = input(); x.plan.defaults.targetBuffer = 0;
  x.plan.startingCash.breakdown[0].value = x.plan.opening.paydaySnapshot.opening = 100;
  x.plan.savingsPoolObservation.accounts[0].value = x.plan.startingCash.breakdown[2].value = 800;
  x.plan.savingsPoolObservation.accounts[1].value = x.plan.startingCash.heldElsewhere[0].value = 0;
  x.plan.income[1].amount = x.plan.income[2].amount = 200;
  x.plan.income.push({ id: 'p3', label: 'Invented third receipt', frequency: 'once', date: '2026-11-13', amount: 200, confidence: 'confirmed' });
  x.plan.commitments = [
    { id: 'a', label: 'Invented first cost', date: '2026-10-29', amount: 500, confidence: 'confirmed', sinkingFund: true },
    { id: 'b', label: 'Invented second cost', date: '2026-11-12', amount: 600, confidence: 'confirmed', sinkingFund: true },
    { id: 'c', label: 'Invented third cost', date: '2026-11-26', amount: 400, confidence: 'confirmed', sinkingFund: true }];
  const a = advice(x), p = closing(a, '2026-11-13');
  assert.equal(p.status, 'unavailable'); assert.equal(p.stock, null); assert.deepEqual(p.rows, []);
  assert.equal(p.diagnostics.signedSavings, -200); assert.equal(p.diagnostics.nativeOperatingCash, 0);
  assert.equal(10000 + 80000 + 60000 - 50000 - 60000 - 40000, 0, 'full 1500 expenses consume household cash once');
  assert.ok(x.plan.commitments.every(c => c.settledOn === undefined));
});
test('a ledger that only balances after the next payday sweep is withheld signed, not published as zero', () => {
  // Supersedes the sweep-at-close exact-zero pin: both goal costs land
  // before the second period's own surplus sweeps, so under the
  // net-surplus sweep this close signed -300 and withheld. The
  // basis-string pin moved to the ample carry control above.
  // S1 supersession: with an operating opening of 100 the first period's
  // full-remainder sweep is 100 + 300 = 400 (was the 300 surplus only),
  // so the withheld signed position is -200 (was -300 on this shape).
  // The original operating-1000 shape no longer withholds at all: its
  // full-remainder sweep is 1300 and the close publishes ready at 700 —
  // pinned explicitly below so the change is on record, not silent.
  const x = ownerModel(100, 300);
  x.plan.commitments[1].amount = 400;
  const a = advice(x), p = closing(a, '2026-10-30');
  assert.equal(30000 + 40000 - 50000 - 40000, -20000);
  assert.equal(p.status, 'unavailable'); assert.equal(p.stock, null);
  assert.equal(p.diagnostics.signedSavings, -200);
  assert.deepEqual(p.items, []);
  const y = ownerModel(1000, 300);
  y.plan.commitments[1].amount = 400;
  const q = closing(advice(y), '2026-10-30');
  assert.equal(q.status, 'ready', q.reason); assert.equal(q.stock, 700);
  assert.equal(30000 + 130000 - 50000 - 40000, 70000,
    'opening stock + the first period full remainder (1000 inherited + 300) - both goal costs, each once');
});
for (const destination of ['chequing-a', 'savings']) test('current-tail annual goal bill is debited once with proved income destination ' + destination, () => {
  const x = ownerModel(1000);
  x.plan.bills = [{ id: 'current-annual', label: 'Invented current annual bill', frequency: 'yearly', month: 10, day: 10,
    firstDue: '2026-10-10', amount: 200, confidence: 'confirmed', jointCash: false }];
  x.plan.income.push({ id: 'current-gift', label: 'Invented current income', frequency: 'once', date: '2026-10-04', amount: 1000, confidence: 'confirmed' });
  x.opts.currentPeriodActuals.representedActuals.push({ id: 'current-gift', date: '2026-10-04', actual: 1000, transactionId: 'current-income' });
  x.opts.currentPeriodActuals.transactions.push({ id: 'current-income', date: '2026-10-04', amount: -1000,
    currency: 'CAD', pending: false, isIncome: true, incomeId: 'current-gift', savingsPostingEvidence: 'posted',
    atlasAccountId: destination, accountRole: destination === 'savings' ? 'household-reserve' : 'household-cash', displayedPayee: 'Invented current income' });
  if (destination === 'savings') {
    x.plan.savingsPoolObservation.accounts[0].value += 1000;
    x.plan.startingCash.breakdown[2].value += 1000;
  } else x.plan.startingCash.breakdown[0].value += 1000;
  const a = advice(x), p = closing(a, '2026-10-30');
  // S1 supersession: the first future period sweeps its FULL remainder.
  // Destination chequing: the gift lands in Bills, so 2400 is credited
  // across the seam (the current period's 1000 boundary credit plus the
  // first period's 1400 remainder, its opening net of the credit);
  // destination savings: the opening stock is 1300 and the remainder is
  // 1400. Either way the pot lands at 1600 (was 600) with every cost
  // still debited exactly once; the second period's own remainder has
  // not swept yet — it lands 2026-11-13.
  assert.equal(p.status, 'ready', p.reason); assert.equal(p.stock, 1600);
  assert.equal(p.projectedDraws, 1100, 'the annual bill and both goal costs are each debited exactly once');
  if (destination === 'savings') assert.equal(130000 + 140000 - 110000, 160000,
    'opening stock incl. the gift + the first period full remainder - the three costs, each once');
  else assert.equal(30000 + 240000 - 110000, 160000,
    'opening stock + the 2400 credited across the seam (1000 current credit + 1400 first remainder) - the three costs, each once');
  assert.equal(a.savingsFunding.period.alreadySavedIncome, destination === 'savings' ? 1000 : 0);
});
test('a future annual goal already deducted by Budget is not subtracted a second time', () => {
  const x = ownerModel(); x.plan.commitments.shift();
  x.plan.bills = [{ id: 'a', label: 'Invented annual goal', frequency: 'yearly', month: 10, day: 21,
    firstDue: '2026-10-21', amount: 500, confidence: 'confirmed', jointCash: false }];
  const a = advice(x);
  // The annual goal (500, 2026-10-21) and commitment b (400, 2026-11-04)
  // both land before the remainders that fund them sweep, so the first
  // two closes withhold signed; by the third close each cost has been
  // debited exactly once.
  // S1 supersession: Budget deducts the annual goal inside the first
  // period's remainder (remainder -20, published sweep 0); the Savings
  // overlap restoration returns that deduction to the sweep, bounded by
  // the Bills cash that actually exists at the close (480 = 80 opening +
  // 400 receipt), so the second close signs -120 (was -200). The second
  // period's remainder (380) then sweeps in full and the third close is
  // 260 (was 200): no dollar is counted twice and none is invented.
  // S1 repair (Systems Review 2026-10-15, PR #620 blocker 1): the 260
  // above was itself the defect — Budget published the first sweep as 0
  // (only Savings restored the overlap, capped at 480) and chained the
  // second period from a -20 opening, publishing 380. Budget now
  // restores the goal deduction inside its own remainder and publishes
  // sweeps of 480 and 400, which Savings credits exactly: the third
  // close is 280 with the paired operating position at 0.
  const first = closing(a, '2026-10-16');
  assert.equal(first.status, 'unavailable'); assert.equal(first.stock, null);
  assert.equal(first.diagnostics.signedSavings, -200);
  const second = closing(a, '2026-10-30');
  assert.equal(second.status, 'unavailable'); assert.equal(second.stock, null);
  assert.equal(second.diagnostics.signedSavings, -120);
  const third = closing(a, '2026-11-13');
  assert.equal(third.status, 'ready', third.reason); assert.equal(third.stock, 280);
  assert.equal(third.projectedContributions, 880, 'the two published sweeps (480 + 400), each credited once');
  assert.equal(third.operatingCash, 0, 'the paired Bills operating position is fully explained');
  assert.equal(third.projectedDraws, 900);
  assert.equal(30000 + 48000 + 40000 - 50000 - 40000, 28000);
});
test('a later funding gap withholds transfer-now permission without erasing earlier qualified planning closes', () => {
  const x = input(); x.plan.commitments[0].amount = 4000;
  x.plan.income.push({ id: 'current-gift', label: 'Invented operating receipt', frequency: 'once', date: '2026-10-04', amount: 200, confidence: 'confirmed' });
  x.plan.startingCash.breakdown[0].value += 200;
  x.opts.currentPeriodActuals.representedActuals.push({ id: 'current-gift', date: '2026-10-04', actual: 200, transactionId: 'gift-receipt' });
  x.opts.currentPeriodActuals.transactions.push({ id: 'gift-receipt', date: '2026-10-04', amount: -200, currency: 'CAD',
    pending: false, isIncome: true, incomeId: 'current-gift', savingsPostingEvidence: 'posted',
    atlasAccountId: 'chequing-a', accountRole: 'household-cash', displayedPayee: 'Invented operating receipt' });
  const a = advice(x);
  assert.equal(a.savingsFunding.backing.status, 'ready');
  assert.equal(a.savingsFunding.period.status, 'unavailable');
  assert.match(a.savingsFunding.period.reason, /cannot preserve the existing cash\/card floor/);
  // Owner 2026-10-16 (ownerSentinel_f70d821f734481919f25b706ea7ab1a6)
  // supersedes the blanket current-tail hold: known current net200 is a
  // projected addition, not a transfer quota, and the later4000 goal cannot
  // erase an earlier closing. The actual bank permission above still holds.
  const p = closing(a, '2026-10-16'); assert.equal(p.status, 'ready'); assert.equal(p.stock, 319);
  assert.equal(11900 + 20000, 31900);
  const later = closing(a, '2026-12-11');
  assert.equal(later.status, 'unavailable'); assert.equal(later.stock, null);
  assert.equal(later.diagnostics.signedSavings, -1601); assert.equal(later.gap.shortBy, 1601);
  assert.equal(11900 + 20000 + 108000 + 100000 - 400000, -160100);
});
test('signed native diagnostics carry -100 forward to -200 without resetting deficits or publishing zero Savings', () => {
  const x = input(); x.plan.defaults.targetBuffer = 0;
  x.plan.startingCash.breakdown[0].value = x.plan.opening.paydaySnapshot.opening = 0;
  x.plan.savingsPoolObservation.accounts[0].value = x.plan.startingCash.breakdown[2].value = 300;
  x.plan.savingsPoolObservation.accounts[1].value = x.plan.startingCash.heldElsewhere[0].value = 0;
  x.plan.income[1].amount = 0; x.plan.income[2].amount = 100;
  x.plan.commitments = [
    { id: 'a', label: 'Invented first cost', date: '2026-10-29', amount: 400, confidence: 'confirmed', sinkingFund: true },
    { id: 'b', label: 'Invented second cost', date: '2026-11-12', amount: 200, confidence: 'confirmed', sinkingFund: true }];
  const a = advice(x), sim = F.simulate(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, horizonDays: 50, viewDays: 50, targetBuffer: 0 });
  assert.equal(sim.daily.find(r => r.date === '2026-10-29').balance, -100);
  assert.equal(sim.daily.find(r => r.date === '2026-11-12').balance, -200);
  assert.equal(30000 - 40000, -10000); assert.equal(-10000 + 10000 - 20000, -20000);
  assert.equal(a.savingsFunding.period.status, 'ready', 'a zero-capacity path does not broaden the existing unavailable gate');
  for (const [start, signedOp] of [['2026-10-16', -100], ['2026-10-30', -200]]) {
    const p = closing(a, start); assert.equal(p.stock, null); assert.equal(p.status, 'unavailable');
    assert.equal(p.gap.signedOperatingCash, signedOp,
      'the closing-day native cash is a diagnostic, not published Savings (the second close now reports its own day, not the earliest breach)');
  }
});
test('installment groups retain only future members, then disappear at the final payment close', () => {
  const x = installments(), a = advice(x), current = a.savingsFunding;
  assert.deepEqual(current.backing.items.map(i => [i.id, i.saved]), [['one', 80], ['two', 39], ['later', 0]]);
  const first = closing(a, '2026-10-16'), second = closing(a, '2026-10-30');
  assert.equal(first.stock, 39); assert.equal(first.projectedDraws, 80);
  assert.deepEqual(first.items.map(i => [i.id, i.forecastSaved]), [['two', 39], ['later', 0]]);
  assert.deepEqual(first.rows.find(r => r.key === 'group:installments').members, ['two@2026-11-12']);
  // S1 supersession: the landed sweep is the first period's full
  // remainder 1080 (was 1000), so the second close is 1059 (was 979).
  assert.equal(second.stock, 1059); assert.equal(second.projectedDraws, 140);
  assert.deepEqual(second.items.map(i => [i.id, i.forecastSaved]), [['later', 1059]]);
  assert.ok(!second.rows.some(r => r.key === 'group:installments'));
  assert.equal(11900 + 108000 - 8000 - 6000, 105900, 'both costs consumed once, exact cents; only the first remainder has landed');
  assert.deepEqual(current.backing.items.map(i => [i.id, i.saved]), [['one', 80], ['two', 39], ['later', 0]]);
  assert.ok(x.plan.commitments.every(c => c.settledOn === undefined), 'date passage never creates actual settlement');
});
for (const [date, present, stock] of [['2026-10-28', false, 39], ['2026-10-29', false, 39], ['2026-10-30', true, 119]])
  test('selected closing boundary includes planned payment dated ' + date, () => {
    const x = input(); x.plan.commitments[0].date = date; x.plan.commitments[0].amount = 80;
    const a = advice(x), before = copy(a.savingsFunding), first = closing(a, '2026-10-16');
    assert.equal(first.stock, stock); assert.equal(first.items.some(i => i.id === 'a'), present);
    assert.equal(first.projectedDraws, present ? 0 : 80);
    const second = copy(closing(a, '2026-10-30'));
    for (let n = 0; n < 3; n++) {
      assert.deepEqual(copy(closing(a, '2026-10-16')), copy(first));
      assert.deepEqual(copy(closing(a, '2026-10-30')), second);
    }
    // S1 supersession: 1119 (was 1039) on the first period's
    // full-remainder sweep 1080; the planned payment is still deducted
    // exactly once.
    assert.equal(second.stock, 1119); assert.equal(second.projectedDraws, 80);
    assert.deepEqual(copy(a.savingsFunding), before);
  });
