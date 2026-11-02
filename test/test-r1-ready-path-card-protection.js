'use strict';
// R1 — ready-path conservation (Atlas #787 6542859623; Muse 6578085777).
// With card-purchase coverage READY, an uncovered card purchase is a Bills
// obligation: it is owed to the card and its cash is not transferable. It
// must be preserved once, coherently, across the observed Bills stock, the
// remaining household requirement, the S1 seed, every later remainder and
// sweep, and the Savings arrivals those sweeps credit. A protected amount
// withheld at first must never return through a later sweep. "Ready" means
// the coverage ledger is qualified, not that every purchase is covered.
//
// Every figure below is invented and hand-derived from the ledger written
// beside it; no expected value is produced by the code under test. The
// covered and cash-purchase controls are separate inputs that reach the
// same household position by a different, already-correct route.
//
// Ledger common to every case (fixture savings-future-closing-data):
// - as of 2026-10-07; active pay period 2026-10-02..2026-10-15; payday
//   snapshot 80 on 2026-10-02; Bills stock 80 before any card payment leg;
// - receipts 1000 on 2026-10-16 and 1000 on 2026-10-30; no bills;
// - Savings stock 119 (30 + 89); goal a 1500 due 2026-12-18 and goal b
//   1000 due 2027-01-04 (outside the published horizon);
// - target buffer 20; Groceries with no target, so card spending lands on
//   the household Other row, whose hold rises to what was spent;
// - coverage opening confirmed on 2026-10-02 (empty unless stated).
// With P = the uncovered obligation the household must still pay from
// Bills, the hand ledger is:
//   active close 80 - P; next opening 80 - P; that period's sweep
//   80 - P + 1000; later openings 0; later sweeps 1000, 0, 0, 0;
//   Savings closes 119, 1199 - P, 2199 - P, 2199 - P, 699 - P (goal a).
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'public/forecast'));
const input = require('./fixtures/savings-future-closing-data');

const row = o => Object.assign({ pending: false, currency: 'CAD', savingsPostingEvidence: 'posted' }, o);
const cardRow = (id, date, amount, ref, extra) => row(Object.assign({ id, date, amount,
  atlasAccountId: 'tdcc', accountRole: 'revolving-credit', categoryLabel: 'Groceries', coverageRef: ref }, extra));
const billsRow = (id, date, amount, ref, extra) => row(Object.assign({ id, date, amount,
  atlasAccountId: 'chequing-a', accountRole: 'household-cash', categoryLabel: 'Groceries', coverageRef: ref }, extra));
const PAYMENT = { categoryLabel: 'Credit card payment' };

// c: { purchase, pending, cash, carried, pay: [amount, [[ref, cents$]], other, purpose],
//      reverse, refund, unrecorded, noOpening, noPolicy }
function build(c = {}) {
  const x = input();
  x.plan.budget.categories = [{ id: 'groceries', label: 'Groceries', class: 'essential',
    ...(c.target ? { plannedPayday: c.target } : { plannedWeekly: 0 }), confidence: 'confirmed' }];
  if (!c.noCard) x.plan.cardPurchaseCoverage = { opening: { asOf: '2026-10-02', confirmed: true,
    currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] }, payments: [], refunds: [], reversals: [] };
  if (c.carried) x.plan.cardPurchaseCoverage.opening.purchases.push({ ref: 'cov-0', accountId: 'tdcc',
    date: '2026-09-28', amount: c.carried, covered: 0 });
  if (c.noPolicy) delete x.plan.savingsEarmarks.allocationPolicy;
  const T = x.opts.currentPeriodActuals.transactions;
  let stock = 80;
  if (c.purchase) T.push(cardRow('CARD-1', '2026-10-05', c.purchase, 'cov-1', { pending: !!c.pending }));
  if (c.cash) { T.push(billsRow('CASH-1', '2026-10-05', c.cash, 'cash-1')); stock -= c.cash; }
  if (c.pay) {
    const [amount, parts, other = 0, purpose = null] = c.pay;
    stock -= amount;
    T.push(billsRow('PAY-D', '2026-10-06', amount, 'pay-d', PAYMENT));
    T.push(cardRow('PAY-C', '2026-10-06', -amount, 'pay-c', PAYMENT));
    x.plan.cardPurchaseCoverage.payments.push({ id: 'p1', confirmed: true, debitRef: 'pay-d', creditRef: 'pay-c',
      allocations: parts.map(([purchaseRef, amount]) => ({ purchaseRef, amount })), otherAmount: other, otherPurpose: purpose });
    if (c.reverse) {
      stock += amount;
      T.push(cardRow('REV-D', '2026-10-07', amount, 'rev-d', PAYMENT));
      T.push(billsRow('REV-C', '2026-10-07', -amount, 'rev-c', PAYMENT));
      x.plan.cardPurchaseCoverage.reversals.push({ confirmed: true, paymentId: 'p1', cardDebitRef: 'rev-d',
        cashCreditRef: 'rev-c', allocations: parts.map(([purchaseRef, amount]) => ({ purchaseRef, amount })), otherAmount: other });
    }
  }
  if (c.refund) {
    T.push(cardRow('REF-1', '2026-10-06', -c.refund, 'ref-1'));
    x.plan.cardPurchaseCoverage.refunds.push({ confirmed: true, purchaseRef: 'cov-1', refundRef: 'ref-1' });
  }
  if (c.unrecorded) {
    stock -= c.unrecorded;
    T.push(billsRow('UNR-D', '2026-10-06', c.unrecorded, 'unr-d', PAYMENT));
    T.push(cardRow('UNR-C', '2026-10-06', -c.unrecorded, 'unr-c', PAYMENT));
  }
  if (c.noOpening) delete x.plan.cardPurchaseCoverage;
  x.plan.startingCash.breakdown[0].value = stock;
  return x;
}
function run(c) {
  const x = build(c), before = JSON.stringify(x);
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  assert.equal(JSON.stringify(x), before, 'no input mutation');
  return a;
}
const cents = n => n == null ? n : Math.round(n * 100);
const STARTS = ['2026-10-02', '2026-10-16', '2026-10-30', '2026-11-13', '2026-11-27', '2026-12-11'];
const view = (a, start) => {
  const v = a.payPeriodViews.find(p => p.start === start);
  assert.ok(v, 'Budget period ' + start);
  return v;
};
function closes(a) {
  return STARTS.slice(1).map(start => {
    const id = a.savingsFunding.periodViews.find(p => p.start === start).id;
    return F.savingsFundingPublication(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: id }).forecastClosing;
  });
}
// The hand ledger above, in cents, for a protected obligation P (dollars).
function ledger(P) {
  const p = Math.round(P * 100);
  return { activeClose: 8000 - p, openings: [8000 - p, 0, 0, 0, 0], sweeps: [108000 - p, 100000, 0, 0, 0],
    savings: [11900, 119900 - p, 219900 - p, 219900 - p, 69900 - p] };
}
function budgetChain(a) {
  return { activeClose: cents(view(a, STARTS[0]).plannedPeriodClose),
    openings: STARTS.slice(1).map(s => cents(view(a, s).opening)),
    sweeps: STARTS.slice(1).map(s => cents(view(a, s).paydaySweep)) };
}
function assertBudget(a, P, label, { activeClose = true } = {}) {
  const want = ledger(P), got = budgetChain(a);
  if (activeClose) assert.equal(got.activeClose, want.activeClose, label + ': active planned close');
  assert.deepEqual(got.openings, want.openings, label + ': every later Budget opening');
  assert.deepEqual(got.sweeps, want.sweeps, label + ': every later published sweep');
  // Conservation, independent of the ledger: everything that ever sweeps,
  // plus what stays in the chain, is the stock and receipts less P once.
  const swept = got.sweeps.reduce((s, v) => s + v, 0);
  assert.equal(swept, 8000 + 200000 - Math.round(P * 100), label + ': P leaves the sweep chain exactly once');
}
function assertSavings(a, P, label, { gap = true } = {}) {
  const want = ledger(P), got = closes(a);
  got.forEach((c, i) => assert.equal(c.status, 'ready', label + ': Savings close ' + i + ' ready'));
  assert.deepEqual(got.map(c => cents(c.stock)), want.savings, label + ': every later Savings close');
  assert.deepEqual(got.map(c => cents(c.contribution)), [0, 108000 - Math.round(P * 100), 100000, 0, 0],
    label + ': each arrival is the sweep Budget published, never the protected cents');
  // The protected cents stay in operating cash: the funding gap from
  // 2026-11-13 on is the target buffer alone, exactly as with no purchase.
  if (gap) for (const c of got.slice(2)) assert.equal(cents(c.gap && c.gap.shortBy), 2000, label + ': only the buffer gap');
}

test('control: no card evidence (incumbent) and an empty ready ledger publish the same chain', () => {
  const none = run({ noCard: true }), empty = run({});
  assert.equal(empty.cardPurchaseCoverage.status, 'ready');
  assert.equal(cents(empty.cardPurchaseCoverage.reservedCash), 0);
  for (const a of [none, empty]) { assertBudget(a, 0, 'no obligation'); assertSavings(a, 0, 'no obligation'); }
});

test('zero coverage, current purchase: 42.50 owed to the card never returns through a later sweep', () => {
  const a = run({ purchase: 42.5 });
  assert.equal(a.cardPurchaseCoverage.status, 'ready', 'ready ledger, purchase still uncovered');
  assert.equal(cents(a.cardPurchaseCoverage.reservedCash), 4250);
  assertBudget(a, 42.5, 'uncovered'); assertSavings(a, 42.5, 'uncovered');
});

test('partial coverage: a confirmed 10.00 backfill leaves 32.50 protected; same household position', () => {
  const a = run({ purchase: 42.5, pay: [10, [['cov-1', 10]]] });
  assert.equal(cents(a.cardPurchaseCoverage.reservedCash), 3250);
  assertBudget(a, 42.5, 'partial'); assertSavings(a, 42.5, 'partial');
});

test('full coverage and a cash purchase (controls) reach the same position by a different route', () => {
  const full = run({ purchase: 42.5, pay: [42.5, [['cov-1', 42.5]]] }), cash = run({ cash: 42.5 });
  assert.equal(cents(full.cardPurchaseCoverage.reservedCash), 0);
  for (const [a, l] of [[full, 'covered'], [cash, 'cash']]) { assertBudget(a, 42.5, l); assertSavings(a, 42.5, l); }
});

test('an actual payment reversal restores the protection exactly', () => {
  const a = run({ purchase: 42.5, pay: [42.5, [['cov-1', 42.5]]], reverse: true });
  assert.equal(cents(a.cardPurchaseCoverage.reservedCash), 4250, 'the reversed backfill is owed again');
  assertBudget(a, 42.5, 'reversed'); assertSavings(a, 42.5, 'reversed');
});

test('an actual refund relieves only what it refunds (30.00 still owed)', () => {
  // Card 42.50, refund 12.50 to the card: Bills still owes 30.00. The
  // incumbent Budget hold keeps the gross 42.50 (refund classification is
  // not this outcome), so only the seed, sweeps and Savings are pinned.
  const a = run({ purchase: 42.5, refund: 12.5 });
  assert.equal(cents(a.cardPurchaseCoverage.reservedCash), 3000);
  assertBudget(a, 30, 'refund', { activeClose: false }); assertSavings(a, 30, 'refund');
});

test('carried purchase from before the cycle (outside this period\'s household hold) is protected once', () => {
  const a = run({ carried: 30 });
  assert.equal(cents(a.cardPurchaseCoverage.reservedCash), 3000);
  assert.equal(cents(a.cardPurchaseCoverage.earlierPeriods.remaining), 3000);
  assertBudget(a, 30, 'carried'); assertSavings(a, 30, 'carried');
  const terms = view(a, STARTS[0]).plannedPeriodCloseTerms;
  assert.equal(cents(terms.earlierCardPurchaseReserve), 3000, 'the close names the carried deduction');
  assert.equal(cents(view(a, STARTS[0]).plannedPeriodClose),
    cents(terms.opening) + cents(terms.incomeAdded) - cents(terms.periodBillLoad) - cents(terms.budgetHold)
      - cents(terms.annualSavingsNeed) - cents(terms.earlierCardPurchaseReserve), 'published terms reconcile');
});

test('current and carried together: 72.50, each counted once (not twice through the hold)', () => {
  const a = run({ purchase: 42.5, carried: 30 });
  assert.equal(cents(a.cardPurchaseCoverage.reservedCash), 7250);
  assertBudget(a, 72.5, 'mixed'); assertSavings(a, 72.5, 'mixed');
});

test('carried purchase backfilled inside the cycle: the stock seed already holds the paid share', () => {
  // Full and partial in-cycle backfills of the carried 30.00. The seed,
  // sweeps and Savings follow the stock. The active planned close keeps
  // its snapshot basis, which does not see an in-cycle Bills payment (a
  // separate, pre-existing item recorded in the merge card), so it is not
  // pinned here.
  for (const pay of [[30, [['cov-0', 30]]], [10, [['cov-0', 10]]]]) {
    const a = run({ carried: 30, pay });
    assertBudget(a, 30, 'carried backfill ' + pay[0], { activeClose: false });
    assertSavings(a, 30, 'carried backfill ' + pay[0]);
  }
});

test('known non-purchase purpose: a 15.00 prior-debt payment leaves Bills; the 42.50 stays protected', () => {
  const a = run({ purchase: 42.5, pay: [15, [], 15, 'prior-debt'] });
  assert.equal(cents(a.cardPurchaseCoverage.reservedCash), 4250);
  // Stock 65; P stays 42.50; the opening is 65 - 42.50 = 22.50.
  const got = budgetChain(a);
  assert.deepEqual(got.openings, [2250, 0, 0, 0, 0]);
  assert.deepEqual(got.sweeps, [102250, 100000, 0, 0, 0]);
  assert.deepEqual(closes(a).map(c => cents(c.stock)), [11900, 114150, 214150, 214150, 64150]);
});

test('pending purchase: the Budget chain protects it; Savings stays withheld as before', () => {
  const a = run({ purchase: 42.5, pending: true });
  assert.equal(cents(a.cardPurchaseCoverage.reservedCash), 4250);
  assertBudget(a, 42.5, 'pending');
  for (const c of closes(a)) { assert.equal(c.status, 'unavailable'); assert.equal(c.stock, null); }
});

test('unknown purpose or no coverage opening: not the ready path, unchanged and never a number', () => {
  const unknown = run({ purchase: 42.5, unrecorded: 15 }), unopened = run({ purchase: 42.5, noOpening: true });
  assert.equal(unknown.cardPurchaseCoverage.status, 'unavailable');
  assert.equal(unopened.cardPurchaseCoverage.status, 'unavailable');
  for (const a of [unknown, unopened]) for (const s of STARTS.slice(1)) {
    assert.equal(view(a, s).opening, null); assert.equal(view(a, s).paydaySweep, null);
  }
  for (const a of [unknown, unopened]) for (const c of closes(a)) assert.equal(c.stock, null);
  // The matching-only estimate chain beside the null figures agrees with
  // the ready ledger for the same purchase (37.50 / 1037.50).
  const twin = view(unopened, STARTS[1]).cardMatchingEstimate;
  assert.equal(cents(twin.opening), 3750); assert.equal(cents(twin.paydaySweep), 103750);
});

test('no Savings policy: the Budget chain protects current, carried and mixed obligations once', () => {
  for (const [c, P] of [[{}, 0], [{ purchase: 42.5 }, 42.5], [{ carried: 30 }, 30], [{ purchase: 42.5, carried: 30 }, 72.5]]) {
    const a = run({ ...c, noPolicy: true });
    assert.equal(a.savingsFunding, undefined, 'no Savings consumer');
    assertBudget(a, P, 'no policy P=' + P);
  }
});

test('a remaining household target stays deducted and the reserve is added once (target 100 a period)', () => {
  // Groceries target 100 a period, still unspent; the 42.50 card purchase
  // lands on Other (hold = spent). Active: 80 - 100 - 42.50 = -62.50. Then
  // -62.50 + 1000 - 100 = 837.50 sweeps; 1000 - 100 = 900 sweeps; every
  // later period is -100 and carries. Savings 119, 956.50, 1856.50,
  // 1856.50, 356.50 (goal a). The cash-purchase control is identical.
  const card = run({ purchase: 42.5, target: 100 }), cash = run({ cash: 42.5, target: 100 });
  for (const [a, l] of [[card, 'card'], [cash, 'cash']]) {
    const got = budgetChain(a);
    assert.equal(got.activeClose, -6250, l);
    assert.deepEqual(got.openings, [-6250, 0, 0, -10000, -20000], l);
    assert.deepEqual(got.sweeps, [83750, 90000, 0, 0, 0], l);
    assert.deepEqual(closes(a).map(c => cents(c.stock)), [11900, 95650, 185650, 185650, 35650], l);
  }
});

test('a ready-ledger card purchase that pays a scheduled bill is withheld once, like paying it from Bills', () => {
  // Pre-review observation 2. An invented 50.00 once-bill due 2026-10-05 is
  // paid by card (represented by that purchase) or, as the control, paid
  // from Bills (stock 80 -> 30). Either way the bill is settled inside the
  // active period and 50.00 must leave the sweep chain once: active close
  // 80 - 50 = 30; next opening 30; sweeps 1030, 1000. Savings 119, 1149,
  // 2149, 2149, 649. (Main published opening 80 and sweep 1080 for the card
  // form: the represented bill left remainingBills while its cash stayed.)
  function billCase(byCard) {
    const x = build({});
    x.plan.bills = [{ id: 'phone', label: 'Invented phone', frequency: 'once', date: '2026-10-05', amount: 50,
      confidence: 'confirmed', ...(byCard ? { cardPaid: true } : {}) }];
    const P = x.opts.currentPeriodActuals;
    if (byCard) {
      P.transactions.push(cardRow('CARD-B', '2026-10-05', 50, 'cov-b', { categoryLabel: 'Phone', representedBill: true }));
      P.representedActuals.push({ id: 'phone', date: '2026-10-05', actual: 50, transactionId: 'CARD-B' });
    } else {
      P.transactions.push(billsRow('CASH-B', '2026-10-05', 50, 'cash-b', { categoryLabel: 'Phone' }));
      P.representedActuals.push({ id: 'phone', date: '2026-10-05', actual: 50, transactionId: 'CASH-B' });
      x.plan.startingCash.breakdown[0].value = 30;
    }
    const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
    return a;
  }
  const card = billCase(true), cash = billCase(false);
  assert.equal(card.cardPurchaseCoverage.status, 'ready');
  assert.equal(cents(card.cardPurchaseCoverage.reservedCash), 5000);
  // The Savings-close gap diagnostic reads the native cash walk, which in
  // this fixture still schedules the once-bill (its representation is only
  // in the observation packet), so it is not the buffer alone here. It is
  // pinned as identical between the card and Bills forms instead.
  assertBudget(card, 50, 'card-paid bill'); assertSavings(card, 50, 'card-paid bill', { gap: false });
  assertBudget(cash, 50, 'Bills-paid bill'); assertSavings(cash, 50, 'Bills-paid bill', { gap: false });
  assert.deepEqual(closes(card).map(c => cents(c.gap && c.gap.shortBy)), closes(cash).map(c => cents(c.gap && c.gap.shortBy)),
    'the gap diagnostic is identical for the card and Bills forms');
});
