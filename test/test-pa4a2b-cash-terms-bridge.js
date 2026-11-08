'use strict';
// PA-4a-2b (Astra #787 6534140193 §1-2, §4; Atlas dispositions 6531287856 and
// 6538656590): under an eligible card-MATCHING-only hold, a current-cycle card
// purchase inside the household hold H is not Bills cash already spent. One
// qualified remaining requirement D feeds the S1 seed, the Budget closing walk
// and the Savings close. Expected cents are hand-computed from the invented
// fixtures below (Astra's matrix rows scaled to them), never read back from
// the engine. Synthetic data only.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'public/forecast'));
const { ledger } = require('./fixtures/chronological-savings-data');
const closingInput = require('./fixtures/savings-future-closing-data');

const CARD_REASON = 'Confirm the card-coverage opening, transaction units and explicit purchase/payment links before using available cash.';
const cents = v => v == null ? v : Math.round(v * 100);
// Ruling 7: the published opening stays unknown; the typed estimate rides beside it.
const estimated = view => {
  assert.equal(view.opening, null, 'the card-matching opening is never published as the opening');
  assert.equal(view.paydaySweep, null);
  return view.cardMatchingEstimate && view.cardMatchingEstimate.trust === 'estimated'
    ? cents(view.cardMatchingEstimate.opening) : null;
};
const posted = o => ({ pending: false, currency: 'CAD', savingsPostingEvidence: 'posted', ...o });
const purchase = amount => posted({ id: 'CARD-1', date: '2026-10-05', amount, atlasAccountId: 'tdcc',
  accountRole: 'revolving-credit', categoryLabel: 'Groceries', coverageRef: 'cov-1' });
const DEBTS = [{ id: 'tdcc', label: 'Emerald', balance: 500, pending: 0, rate: 0.2, limit: 2000, structure: 'Revolving' },
  { id: 'travelvisa', label: 'Travel', balance: 300, pending: 0, rate: 0.2, limit: 2000, structure: 'Revolving' }];

// Active-seed fixture: Bills stock 8000, no current income, no other bills,
// category target 0, so H is the card charge itself and R is the next
// Bills opening (current net is not positive, so the boundary credit Q = 0).
function seedCase({ charge = 4250, pay = 0, payCard = 'tdcc', alloc = null, other = 0, record = true,
  creditOnly = false, reversal = false, obligation = null, card = 'tdcc', extra = [] } = {}) {
  const x = ledger();
  x.plan.income = x.plan.income.filter(r => r.id === 'payroll');
  x.plan.budget = { categories: [{ id: 'groceries', label: 'Groceries', monthly: 0, essential: true }] };
  const t = (charge ? [{ ...purchase(charge / 100), atlasAccountId: card }] : []).concat(extra);
  if (pay) {
    if (!creditOnly) t.push(posted({ id: 'PAY-D', date: '2026-10-06', amount: pay / 100, atlasAccountId: 'chequing-a',
      accountRole: 'household-cash', categoryLabel: 'Credit Card Payment', coverageRef: 'pay-d' }));
    t.push(posted({ id: 'PAY-C', date: '2026-10-06', amount: -pay / 100, atlasAccountId: payCard,
      accountRole: 'revolving-credit', categoryLabel: 'Credit Card Payment', coverageRef: 'pay-c' }));
    if (!creditOnly) x.plan.startingCash.breakdown[0].value = (8000 - pay) / 100;
    if (record) x.plan.cardPurchaseCoverage = { payments: [{ id: 'p1', confirmed: true, creditRef: 'pay-c',
      debitRef: 'pay-d', allocations: alloc ? [{ purchaseRef: 'cov-1', amount: alloc / 100 }] : [],
      otherAmount: other / 100, ...(other ? { otherPurpose: 'prior-debt' } : {}) }],
    refunds: [], reversals: reversal ? [{ confirmed: true, paymentId: 'p1', cardDebitRef: 'rev-d',
      cashCreditRef: 'rev-c', allocations: [{ purchaseRef: 'cov-1', amount: 1 }], otherAmount: 0 }] : [] };
  }
  if (obligation) x.plan.obligations = [obligation];
  x.opts.currentPeriodActuals.transactions = (x.opts.currentPeriodActuals.transactions || []).concat(t);
  const before = JSON.stringify(x);
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: DEBTS });
  assert.equal(JSON.stringify(x), before, 'no input mutation');
  const views = a.payPeriodViews.filter(p => p.role !== 'lookback');
  return { a, active: views[0], next: views[1] };
}
const cardMinimum = debtId => ({ id: 'card-min', ...(debtId ? { debtId } : {}), effect: 'payment',
  label: 'Card minimum', frequency: 'monthly', day: 12, firstDue: '2026-10-12', amount: 10,
  confidence: 'confirmed', payingAccount: 'chequing-a' });

test('active seed, card charge 4250: R = 8000 - 4250 = 3750, estimated with the card-matching basis', () => {
  const { a, active, next } = seedCase();
  assert.deepEqual(a.cardPurchaseCoverage.issues.map(i => i.code), ['coverage-opening-unconfirmed']);
  assert.equal(estimated(next), 3750);
  assert.equal(cents(next.cardMatchingEstimate.paydaySweep), 3750);
  assert.equal(next.cardMatchingEstimate.basis, 'card-matching-unresolved');
  assert.match(next.cardMatchingEstimate.reason, /card purchase matching/);
  assert.equal(next.openingTrust, undefined, 'no published estimated opening for a nature the page does not read');
  // The seed and the active planned close agree on the same requirement.
  assert.equal(cents(active.plannedPeriodClose), 3750);
});

test('a card identified only by accountRole is a card, not cash: the same 3750', () => {
  assert.equal(estimated(seedCase({ card: 'amexgold' }).next), 3750);
});

test('pending Bills cash is never relieved as spent: the seed holds (incumbent pending guard)', () => {
  const pendingCash = posted({ id: 'CASH-P', date: '2026-10-06', amount: 10, pending: true,
    atlasAccountId: 'chequing-a', accountRole: 'household-cash', categoryLabel: 'Groceries' });
  const { next } = seedCase({ extra: [pendingCash] });
  assert.equal(estimated(next), null);
});

test('active seed, card charge 500000: R = 8000 - 500000 = -492000 and the next sweep is 0', () => {
  const { a, next } = seedCase({ charge: 500000 });
  assert.ok(a.cardPurchaseCoverage.issues.some(i => i.code === 'coverage-bills-backing-unconfirmed'));
  assert.equal(estimated(next), -492000);
  assert.equal(cents(next.cardMatchingEstimate.paydaySweep), 0);
});

test('ready control: no card purchase keeps the calculated seed (8000) with no estimate marker', () => {
  const { a, next } = seedCase({ charge: 0 });
  assert.equal(a.cardPurchaseCoverage, undefined);
  assert.equal(cents(next.opening), 8000);
  assert.notEqual(next.openingTrust, 'estimated');
  assert.equal(next.openingBasis, undefined);
  assert.equal(next.cardMatchingEstimate, undefined);
});

test('qualified H settlement already in the observed opening: stock 6000, H_remaining 4250 - 2000; close stays 3750', () => {
  const { a, next } = seedCase({ pay: 2000, alloc: 2000 });
  assert.deepEqual(a.cardPurchaseCoverage.payments.map(p => p.status), ['reconciled']);
  assert.equal(estimated(next), 6000 - (4250 - 2000));
  assert.equal(estimated(next), 3750);
});

test('posted mixed payment 3000 = 2000 to H + 1000 prior debt: 5000 - 2250 = 2750; the debt share is not a second debit', () => {
  const { next } = seedCase({ pay: 3000, alloc: 2000, other: 1000 });
  assert.equal(estimated(next), 5000 - 2250);
});

test('posted payment with genuinely unresolved purpose on the held card: unknown (null), never a numeric guess', () => {
  const { a, next } = seedCase({ pay: 2000, record: false });
  assert.ok(a.cardPurchaseCoverage.issues.some(i => i.code === 'coverage-payment-or-credit-purpose-unconfirmed'));
  assert.equal(estimated(next), null);
});

test('ruling 6: an unresolved credit on a card holding no purchase inside H is excluded from F; R = 8000 - 4250', () => {
  const { a, next } = seedCase({ pay: 2000, payCard: 'travelvisa', record: false, creditOnly: true });
  assert.ok(a.cardPurchaseCoverage.issues.some(i => i.code === 'coverage-payment-or-credit-purpose-unconfirmed'));
  assert.equal(estimated(next), 3750);
  // The same credit on the card that holds the H purchase cannot be proved non-contributing.
  assert.equal(estimated(seedCase({ pay: 2000, payCard: 'tdcc', record: false, creditOnly: true }).next), null);
  // An unpaired cash leg names no card, so its contribution is ambiguous.
  assert.equal(estimated(seedCase({ pay: 2000, payCard: 'travelvisa', record: false }).next), null);
});

test('ruling 1: a remaining scheduled card payment that could overlap H holds; a proven different card stays numeric', () => {
  assert.equal(estimated(seedCase({ obligation: cardMinimum('tdcc') }).next), null);
  assert.equal(estimated(seedCase({ obligation: cardMinimum(null) }).next), null);
  // Disjoint: 8000 - 4250 - the 1000 minimum on another card = 2750.
  assert.equal(estimated(seedCase({ obligation: cardMinimum('travelvisa') }).next), 2750);
});

test('ruling 5: a settlement that could also be a scheduled card bill the seed still deducts withholds the seed', () => {
  // Remaining same-card bill on 10-10: the 2000 settlement could be inside it.
  const remaining = { ...cardMinimum('tdcc'), firstDue: '2026-10-10', day: 10, amount: 20 };
  assert.equal(estimated(seedCase({ pay: 2000, alloc: 2000, obligation: remaining }).next), null);
  // A once-only same-card payment dated before the as-of that nothing
  // represents is still deducted by the seed, so the 2000 settlement could be
  // counted twice: the seed holds. (Represented by the settlement, it is
  // inside the observed stock and the seed is 3750; see the B2 witness below.
  // A recurring same-card payment has later occurrences and holds; see Q3.)
  const paid = { id: 'card-min', debtId: 'tdcc', effect: 'payment', label: 'Invented card payment',
    frequency: 'once', date: '2026-10-06', firstDue: '2026-10-06', amount: 20, confidence: 'confirmed', payingAccount: 'chequing-a' };
  const x = seedCase({ pay: 2000, alloc: 2000, obligation: paid });
  assert.equal(estimated(x.next), null, 'unrepresented: the seed still deducts it, so it could double');
});

// PA-4a-2b option (b) (Atlas #812 6540159717; Muse #787 6540609418): one
// qualified result per accounting basis. Shared invented scene: snapshot 8000
// on 10-02, a 4250 Groceries card purchase on 10-05, a 2000 Bills payment
// (PAY-D / PAY-C) on 10-06, observed Bills 6000 at the 10-07 as-of. Every
// expected value is a hand ledger:
//   close basis (snapshot)  = 8000 - B - 4250 + (H share of a represented
//                             settlement, counted once) - (unrepresented
//                             non-H settlement share);
//   cutover basis (seed)    = 6000 - deducted remaining B - (4250 - F).
function b2Case({ obligations = [], bills = [], represented = [], extra = [], record = true, alloc = 2000,
  other = 0, payDate = '2026-10-06', policy = true, otherCash = 0 } = {}) {
  const x = ledger();
  x.plan.income = x.plan.income.filter(r => r.id === 'payroll');
  x.plan.budget = { categories: [{ id: 'groceries', label: 'Groceries', monthly: 0, essential: true }] };
  if (!policy) delete x.plan.savingsEarmarks.allocationPolicy;
  x.plan.obligations = obligations;
  x.plan.bills = bills;
  const pay = (alloc + other) / 100;
  x.plan.startingCash.breakdown[0].value = 80 - pay - otherCash / 100;
  if (record) x.plan.cardPurchaseCoverage = { payments: [{ id: 'p1', confirmed: true, creditRef: 'pay-c', debitRef: 'pay-d',
    allocations: alloc ? [{ purchaseRef: 'cov-1', amount: alloc / 100 }] : [], otherAmount: other / 100,
    ...(other ? { otherPurpose: 'prior-debt' } : {}) }], refunds: [], reversals: [] };
  x.opts.currentPeriodActuals.transactions = [purchase(42.5),
    posted({ id: 'PAY-D', date: payDate, amount: pay, atlasAccountId: 'chequing-a',
      accountRole: 'household-cash', categoryLabel: 'Credit Card Payment', coverageRef: 'pay-d' }),
    posted({ id: 'PAY-C', date: payDate, amount: -pay, atlasAccountId: 'tdcc',
      accountRole: 'revolving-credit', categoryLabel: 'Credit Card Payment', coverageRef: 'pay-c' })].concat(extra);
  x.opts.currentPeriodActuals.representedActuals = represented;
  const before = JSON.stringify(x);
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: DEBTS });
  assert.equal(JSON.stringify(x), before, 'no input mutation');
  const views = a.payPeriodViews.filter(v => v.role !== 'lookback');
  const est = v => v.cardMatchingEstimate && v.cardMatchingEstimate.trust === 'estimated' ? cents(v.cardMatchingEstimate.opening) : null;
  return { a, active: views[0], next: views[1], later: views[2], seed: est(views[1]) };
}
const minimum = (o = {}) => ({ ...cardMinimum('tdcc'), firstDue: '2026-10-06', day: 6, amount: 20, ...o });
const repBy = (id, date) => [{ id, date, actual: 20, transactionId: 'PAY-D' }];
const closeOf = v => [cents(v.plannedPeriodClose), v.plannedPeriodCloseTrust];

const onceMin = (o = {}) => ({ id: 'card-min', debtId: 'tdcc', effect: 'payment', label: 'Invented card payment',
  frequency: 'once', date: '2026-10-06', firstDue: '2026-10-06', amount: 20, confidence: 'confirmed', payingAccount: 'chequing-a', ...o });

test('B2 witness: a deducted row represented by the settlement is never counted twice; the seed is its own basis', () => {
  // Recurring same-card minimum (Atlas's witness): later occurrences are in
  // the dependent horizon (Q3), so both bases hold, never 1750.
  const recurring = b2Case({ obligations: [minimum()], represented: repBy('card-min', '2026-10-06') });
  assert.equal(recurring.active.plannedPeriodClose, null);
  assert.notEqual(cents(recurring.active.plannedPeriodClose), 1750);
  assert.equal(recurring.seed, null);
  // Once-only: the snapshot close deducts the represented row and H is
  // unreduced; no inspectable restoration exists, so the close is unknown.
  // The observed-stock seed excludes the represented row: 6000 - 2250 = 3750.
  const once = b2Case({ obligations: [onceMin()], represented: repBy('card-min', '2026-10-06') });
  assert.equal(once.active.plannedPeriodClose, null);
  assert.match(once.active.plannedPeriodCloseReason, /counted twice/);
  assert.equal(once.seed, 3750);
  // The same identity holds through another card's id or a plain bill row.
  assert.equal(b2Case({ obligations: [onceMin({ debtId: 'travelvisa' })], represented: repBy('card-min', '2026-10-06') }).active.plannedPeriodClose, null);
  const bill = { id: 'card-min', label: 'Invented card bill', frequency: 'monthly', day: 6, amount: 20, confidence: 'confirmed' };
  assert.equal(b2Case({ bills: [bill], represented: repBy('card-min', '2026-10-06') }).active.plannedPeriodClose, null);
  // Unrepresented, the 10-06 bill is dated after the 10-02 snapshot this
  // close opens from, so the snapshot cash never held it: the close deducts
  // it. 8000 - 2000 - 4250 = 1750. (Bills audit of 57cb421: the opening
  // exclusion is measured against the close's own opening date, not the
  // plan's later settlement date; this was 3750 before.)
  assert.deepEqual(closeOf(b2Case({ bills: [bill] }).active), [1750, 'estimated']);
});

test('B2 without a Savings policy: the noncombined carry consumes the same result', () => {
  const held = b2Case({ obligations: [onceMin()], represented: repBy('card-min', '2026-10-06'), policy: false });
  assert.equal(held.active.plannedPeriodClose, null);
  assert.equal(held.next.opening, null, 'the withheld close feeds no numeric opening');
  // Qualified control: 8000 - 4250 = 3750 carried.
  const clean = b2Case({ policy: false });
  assert.deepEqual(closeOf(clean.active), [3750, 'estimated']);
  assert.equal(cents(clean.next.opening), 3750);
});

test('Q3: a same-card payment due in a later period holds the seed and the close', () => {
  // Purchase unpaid, no settlement (8000 stock, 4250 purchase); a same-card
  // 1000 payment on 10-20 (next period) could be paying it, so both 2750 and
  // 3750 fit the evidence.
  const later = onceMin({ date: '2026-10-20', firstDue: '2026-10-20', amount: 10 });
  const held = seedCase({ obligation: later });
  assert.equal(held.active.plannedPeriodClose, null);
  assert.equal(estimated(held.next), null);
  // Different-card control stays numeric: close 8000 - 4250 = 3750; seed 3750.
  const other = seedCase({ obligation: { ...later, debtId: 'travelvisa' } });
  assert.deepEqual(closeOf(other.active), [3750, 'estimated']);
  assert.equal(estimated(other.next), 3750);
});

test('early-paid future-dated bill represented by the settlement holds both bases', () => {
  const { active, seed } = b2Case({ obligations: [onceMin({ date: '2026-10-10', firstDue: '2026-10-10' })],
    represented: repBy('card-min', '2026-10-10') });
  assert.equal(active.plannedPeriodClose, null);
  assert.equal(seed, null);
});

test('every unsuccessful qualification is unknown on the close and its carry, never a generic estimate', () => {
  const credit = posted({ id: 'CR-X', date: '2026-10-06', amount: -5, atlasAccountId: 'tdcc',
    accountRole: 'revolving-credit', categoryLabel: 'Credit Card Payment', coverageRef: 'cr-x' });
  const cases = {
    'unresolved credit on the held card': [{ obligations: [minimum()], represented: repBy('card-min', '2026-10-06'), extra: [credit] }, /unconfirmed purpose/],
    'unrepresented same-card bill the close deducts': [{ obligations: [minimum({ firstDue: '2026-10-10', day: 10 })] }, /scheduled card payment/],
    'card-less payment obligation': [{ obligations: [minimum({ debtId: undefined, firstDue: '2026-10-10', day: 10 })] }, /scheduled card payment/],
  };
  for (const [name, [input, reason]] of Object.entries(cases)) for (const policy of [true, false]) {
    const { active, next, seed } = b2Case({ ...input, policy });
    assert.equal(active.plannedPeriodClose, null, `${name} (policy ${policy}): close`);
    assert.equal(active.plannedPeriodCloseTrust, 'unknown', `${name}: trust`);
    if (reason) assert.match(active.plannedPeriodCloseReason, reason, name);
    if (!policy) assert.equal(next.opening, null, `${name}: the rejected close feeds no numeric opening`);
    assert.equal(seed, null, `${name}: seed`);
  }
});

test('overdue once-only unverified obligation the seed deducts holds both bases (no date filter)', () => {
  const held = b2Case({ obligations: [onceMin({ id: 'card-pay' })] });
  assert.equal(held.active.plannedPeriodClose, null);
  assert.equal(held.seed, null);
  // Represented by the settlement: the close cannot restore it (unknown),
  // while the observed-stock seed excludes it: 6000 - 2250 = 3750.
  const ok = b2Case({ obligations: [onceMin({ id: 'card-pay' })], represented: repBy('card-pay', '2026-10-06') });
  assert.equal(ok.active.plannedPeriodClose, null);
  assert.equal(ok.seed, 3750);
});

test('positive controls: proved disjoint, an unrepresented non-H share, and an independent seed', () => {
  // Disjoint: a different card's unrepresented 10-10 minimum.
  // Close 8000 - 2000 - 4250 = 1750; seed 6000 - 2000 - 2250 = 1750.
  const disjoint = b2Case({ obligations: [minimum({ debtId: 'travelvisa', firstDue: '2026-10-10', day: 10 })] });
  assert.deepEqual(closeOf(disjoint.active), [1750, 'estimated']);
  assert.equal(disjoint.seed, 1750);
  // A 3000 settlement, 2000 to H and 1000 prior debt, unrepresented. The
  // snapshot plan keeps its identity: 8000 - 4250 = 3750 (Atlas Q6: the
  // non-H 1000 is outside the scoped plan). The observed-stock seed:
  // 5000 - 2250 = 2750.
  const mixed = b2Case({ other: 1000 });
  assert.deepEqual(closeOf(mixed.active), [3750, 'estimated']);
  assert.equal(mixed.seed, 2750);
  // Independent bases: a once-only same-card 10-04 payment by its own Bills
  // debit (MIN-1). The snapshot close deducts it and nothing links it to the
  // settlement, so the close is unknown; on the observed stock it is already
  // paid, so the seed qualifies: (8000 - 2000 - 2000) - 2250 = 1750.
  const independent = b2Case({ otherCash: 2000,
    obligations: [onceMin({ date: '2026-10-04', firstDue: '2026-10-04' })],
    represented: [{ id: 'card-min', date: '2026-10-04', actual: 20, transactionId: 'MIN-1' }],
    extra: [posted({ id: 'MIN-1', date: '2026-10-04', amount: 20, atlasAccountId: 'chequing-a',
      accountRole: 'household-cash', categoryLabel: 'Bills', coverageRef: 'min-1' })] });
  assert.equal(independent.active.plannedPeriodClose, null);
  assert.match(independent.active.plannedPeriodCloseReason, /scheduled card payment/);
  assert.equal(independent.seed, 1750);
});

test('C7: a hard card hold without a Savings policy feeds no numeric dependent opening', () => {
  const p = { windowDays: 120, defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: '2026-10-07', paydaySnapshot: { periodStart: '2026-10-02', asOf: '2026-10-02', opening: 500 },
      representedEvents: [{ id: 'payroll', date: '2026-10-02' }] },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 500 }] },
    income: [{ id: 'payroll', frequency: 'biweekly', anchor: '2026-10-02', amount: 1000, confidence: 'confirmed' }],
    bills: [], obligations: [], commitments: [], budget: { categories: [] } };
  const pkt = { schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-10-07', coverageStart: '2026-09-01',
    coverageThrough: '2026-10-07', pendingCoverage: 'complete', transactionCoverage: 'complete', representedActuals: [],
    transactions: [purchase(5000)] };
  const a = F.recommend(p, '2026-10-07', { weeklyVariable: 0, debts: [], currentPeriodActuals: pkt });
  const [active, next] = a.payPeriodViews.filter(v => v.role !== 'lookback');
  assert.equal(active.plannedPeriodClose, null);
  assert.equal(next.opening, null, 'never the -3500.00 carried from a withheld close');
  assert.equal(next.plannedPeriodClose, null);
});

test('a confirmed reversal is not yet qualified by this slice: unknown, never the unreversed figure', () => {
  const { next } = seedCase({ pay: 2000, alloc: 2000, reversal: true });
  assert.equal(estimated(next), null);
});

test('hard holds stay hard: incomplete history gives no seed', () => {
  const x = ledger();
  x.plan.income = x.plan.income.filter(r => r.id === 'payroll');
  x.plan.budget = { categories: [{ id: 'groceries', label: 'Groceries', monthly: 0, essential: true }] };
  x.opts.currentPeriodActuals.transactions = [purchase(42.5)];
  x.opts.currentPeriodActuals.transactionCoverage = 'truncated';
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: DEBTS });
  assert.ok(a.cardPurchaseCoverage.issues.some(i => i.code === 'coverage-history-incomplete'));
  assert.equal(a.payPeriodViews.filter(p => p.role !== 'lookback')[1].opening, null);
});

// Savings chain: the incumbent future-closing fixture (verified closes 519 /
// 1599 / 2599 with the clean nature) plus one 42.50 card purchase whose
// matching is unresolved. The card spend is still owed from Bills, so the
// current period's sweep and every later close fall by exactly 4250.
const FUTURE = ['2026-10-16', '2026-10-30', '2026-11-13'];
function savingsCase({ charge = 0, movement = false } = {}) {
  const x = closingInput();
  x.plan.income.push({ id: 'p0', label: 'Invented current receipt', frequency: 'once',
    date: '2026-10-09', amount: 400, confidence: 'confirmed' });
  if (movement) x.opts.currentPeriodActuals.savingsMovementUnconfirmed =
    [{ accountId: 'savings', reason: 'transaction-posting-status-unconfirmed' }];
  if (charge) x.opts.currentPeriodActuals.transactions = (x.opts.currentPeriodActuals.transactions || [])
    .concat([purchase(charge / 100)]);
  const before = JSON.stringify(x);
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  assert.equal(JSON.stringify(x), before, 'no input mutation');
  const closing = start => a.savingsFunding.periodViews.find(p => p.start === start).packet.forecastClosing;
  const published = start => {
    const view = a.savingsFunding.periodViews.find(p => p.start === start);
    return F.savingsFundingPublication(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id });
  };
  return { a, closing, published };
}

test('Savings ready control: the clean closes are unchanged (51900 / 159900 / 259900)', () => {
  const { a, closing } = savingsCase();
  assert.equal(a.savingsFunding.status, 'ready');
  assert.deepEqual(FUTURE.map(s => cents(closing(s).stock)), [51900, 159900, 259900]);
  for (const s of FUTURE) {
    assert.equal(closing(s).nature, 'if-eligible-surplus-saved');
    assert.equal(closing(s).cardMatchingEstimate, undefined);
  }
});

test('card-only estimate: typed closes 51900 - 4250 = 47650 / 155650 / 255650 ride beside an unknown published close', () => {
  const { a, closing, published } = savingsCase({ charge: 4250 });
  // The card spend is still owed from Bills and the current sweep is 4250
  // smaller, so Bills at each close equals the clean control's.
  const control = savingsCase();
  assert.deepEqual(FUTURE.map(s => cents(closing(s).cardMatchingEstimate.operatingCash)),
    FUTURE.map(s => cents(control.closing(s).operatingCash)));
  const next = a.payPeriodViews.find(p => p.start === FUTURE[0]);
  assert.equal(next.opening, null);
  assert.equal(next.cardMatchingEstimate.trust, 'estimated');
  // The public packet keeps the incumbent card reason; nothing is promoted.
  assert.equal(a.savingsFunding.status, 'unavailable');
  assert.equal(a.savingsFunding.reason, CARD_REASON);
  assert.equal(a.savingsFunding.backing.status, 'ready');
  assert.deepEqual(FUTURE.map(s => cents(closing(s).cardMatchingEstimate.stock)), [47650, 155650, 255650]);
  for (const s of FUTURE) {
    const c = closing(s);
    assert.equal(c.status, 'unavailable');
    assert.equal(c.stock, null, 'never zero, a stale close or an unmarked total');
    assert.equal(c.trust, 'unknown');
    assert.equal(c.estimateBasis, 'card-matching-unresolved');
    assert.deepEqual(c.estimateReasons, [CARD_REASON]);
    assert.equal(c.cardMatchingEstimate.nature, 'card-matching-estimate');
    assert.equal(c.cardMatchingEstimate.trust, 'estimated');
    assert.ok(c.cardMatchingEstimate.assumptions.some(t => /not counted as Bills cash already spent/.test(t)));
    // Ruling 7: the selector keeps the rest of the qualified packet and shows the close as unknown.
    const p = published(s);
    assert.ok(p, 'the projected packet is not nulled');
    assert.equal(p.forecastClosing.status, 'unavailable');
    assert.equal(p.forecastClosing.stock, null);
  }
});

test('a role-only card gives the same typed closes as a known card id', () => {
  const x = closingInput();
  x.plan.income.push({ id: 'p0', label: 'Invented current receipt', frequency: 'once',
    date: '2026-10-09', amount: 400, confidence: 'confirmed' });
  x.opts.currentPeriodActuals.transactions = (x.opts.currentPeriodActuals.transactions || [])
    .concat([{ ...purchase(42.5), atlasAccountId: 'amexgold' }]);
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  const stock = s => cents(a.savingsFunding.periodViews.find(p => p.start === s).packet.forecastClosing.cardMatchingEstimate.stock);
  assert.deepEqual(FUTURE.map(stock), [47650, 155650, 255650]);
});

test('combined movement + card estimate: both reasons, never the movement-only nature', () => {
  const { a, closing } = savingsCase({ charge: 4250, movement: true });
  assert.equal(a.savingsFunding.backing.status, 'unavailable');
  assert.deepEqual(FUTURE.map(s => cents(closing(s).cardMatchingEstimate.stock)), [47650, 155650, 255650]);
  for (const s of FUTURE) {
    const c = closing(s);
    assert.equal(c.status, 'unavailable');
    assert.equal(c.estimateBasis, 'reported-balance-movement-and-card-matching');
    assert.equal(c.estimateReasons.length, 2);
    assert.equal(c.estimateReasons[1], CARD_REASON);
    assert.equal(c.cardMatchingEstimate.nature, 'reported-balance-and-card-matching-estimate');
    assert.notEqual(c.nature, 'reported-balance-estimate');
  }
});

test('movement-only control: the incumbent reported-balance estimate is unchanged (51900 / 159900 / 259900)', () => {
  const { closing, published } = savingsCase({ movement: true });
  assert.deepEqual(FUTURE.map(s => cents(closing(s).stock)), [51900, 159900, 259900]);
  for (const s of FUTURE) {
    assert.equal(closing(s).nature, 'reported-balance-estimate');
    assert.equal(published(s).forecastClosing.nature, 'reported-balance-estimate');
  }
});

test('ruling 8: the below-reserve branch is soft only on qualified operating cash', () => {
  const run = qualified => {
    const p = { windowDays: 120, defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
      opening: { asOf: '2026-10-07', paydaySnapshot: { periodStart: '2026-10-02', asOf: '2026-10-02', opening: 500 },
        representedEvents: [{ id: 'payroll', date: '2026-10-02' }] },
      startingCash: { breakdown: [{ id: 'chequing-a', value: 500 }, ...(qualified ? [{ id: 'chequing-b', value: 0 }] : [])] },
      income: [{ id: 'payroll', frequency: 'biweekly', anchor: '2026-10-02', amount: 1000, confidence: 'confirmed' }],
      bills: [], obligations: [], commitments: [], budget: { categories: [] } };
    const pkt = { schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-10-07', coverageStart: '2026-09-01',
      coverageThrough: '2026-10-07', pendingCoverage: 'complete', transactionCoverage: 'complete', representedActuals: [],
      transactions: [purchase(5000)] };
    const a = F.recommend(p, '2026-10-07', { weeklyVariable: 0, debts: [], currentPeriodActuals: pkt });
    assert.ok(a.cardPurchaseCoverage.issues.some(i => i.code === 'coverage-bills-backing-unconfirmed'));
    return a.payPeriodViews.filter(v => v.role !== 'lookback')[0];
  };
  assert.equal(run(true).plannedPeriodCloseTrust, 'estimated');
  // One chequing row is absent: the stock is not qualified, so the hold stays hard.
  const hard = run(false);
  assert.equal(hard.plannedPeriodClose, null);
  assert.notEqual(hard.plannedPeriodCloseTrust, 'estimated');
});

// Codex P1 on #812: when a later period's sweep is unknown, the closes already
// computed must still carry their estimate labels. Main publishes the
// movement-only estimate there with the clean nature; the card estimate leaked
// as a ready unlabelled close at the pre-repair head.
function missingLaterSweep({ charge = 0, movement = false }) {
  const x = closingInput();
  x.plan.income.push({ id: 'p0', label: 'Invented current receipt', frequency: 'once',
    date: '2026-10-09', amount: 400, confidence: 'confirmed' });
  x.plan.income.push({ id: 'late', label: 'Invented unknown receipt', frequency: 'once',
    date: '2026-10-30', amount: null, confidence: 'unknown' });
  x.opts.disabled = ['late'];
  if (movement) x.opts.currentPeriodActuals.savingsMovementUnconfirmed =
    [{ accountId: 'savings', reason: 'transaction-posting-status-unconfirmed' }];
  if (charge) x.opts.currentPeriodActuals.transactions = (x.opts.currentPeriodActuals.transactions || [])
    .concat([purchase(charge / 100)]);
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  return start => a.savingsFunding.periodViews.find(p => p.start === start).packet.forecastClosing;
}

test('a missing later sweep never lets an earlier card-matching close publish unlabelled', () => {
  const closing = missingLaterSweep({ charge: 4250 });
  const first = closing(FUTURE[0]);
  assert.equal(first.status, 'unavailable');
  assert.equal(first.stock, null);
  assert.equal(cents(first.cardMatchingEstimate.stock), 47650);
  assert.equal(first.cardMatchingEstimate.nature, 'card-matching-estimate');
  assert.equal(closing(FUTURE[1]).status, 'unavailable');
});

test('a missing later sweep keeps the movement-only estimate label on earlier closes', () => {
  const closing = missingLaterSweep({ movement: true });
  const first = closing(FUTURE[0]);
  assert.equal(first.status, 'ready');
  assert.equal(cents(first.stock), 51900);
  assert.equal(first.nature, 'reported-balance-estimate');
  assert.ok(first.verifiedReason, 'the withheld verified reason is named');
});

test('C1: a negative-pot card close withholds its gap, diagnostics and amounts beside a typed gap', () => {
  const run = (charge, movement = false) => {
    const x = closingInput();
    if (movement) x.opts.currentPeriodActuals.savingsMovementUnconfirmed =
      [{ accountId: 'savings', reason: 'transaction-posting-status-unconfirmed' }];
    x.plan.income.push({ id: 'p0', label: 'Invented current receipt', frequency: 'once',
      date: '2026-10-09', amount: 400, confidence: 'confirmed' });
    // An invented 520.00 goal cost on 10-20 overdraws the pot at the 10-29 close.
    x.plan.commitments.push({ id: 'big', label: 'Invented goal', date: '2026-10-20', amount: 520,
      confidence: 'confirmed', sinkingFund: true });
    if (charge) x.opts.currentPeriodActuals.transactions = (x.opts.currentPeriodActuals.transactions || [])
      .concat([purchase(charge / 100)]);
    const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
    return a.savingsFunding.periodViews.find(p => p.start === FUTURE[0]).packet.forecastClosing;
  };
  // Clean control: the published gap is 100 (one dollar short).
  const clean = run(0);
  assert.equal(cents(clean.gap.shortBy), 100);
  // Card estimate: 100 + 4250 = 4350 short, typed only.
  const card = run(4250);
  assert.equal(card.status, 'unavailable');
  assert.equal(card.gap, undefined, 'no primary gap');
  assert.equal(card.diagnostics, undefined, 'no primary diagnostics');
  assert.doesNotMatch(card.reason, /\$/, 'no amount in the published reason');
  assert.equal(cents(card.cardMatchingEstimate.gap.shortBy), 4350);
  assert.equal(card.cardMatchingEstimate.nature, 'card-matching-estimate');
  // Combined movement + card basis: the same boundary, with both reasons.
  const combined = run(4250, true);
  assert.equal(combined.status, 'unavailable');
  assert.equal(combined.gap, undefined);
  assert.equal(combined.diagnostics, undefined);
  assert.doesNotMatch(combined.reason, /\$|Funding gap/, 'no amount or gap text in the published reason');
  assert.equal(cents(combined.cardMatchingEstimate.gap.shortBy), 4350);
  assert.equal(combined.cardMatchingEstimate.nature, 'reported-balance-and-card-matching-estimate');
});

test('untraceable household evidence (contradictory account aliases) is unknown on both bases', () => {
  const contradictory = posted({ id: 'CASH-1', date: '2026-10-05', amount: 5, atlasAccountId: 'chequing-a',
    accountId: 'chequing-b', accountRole: 'household-cash', categoryLabel: 'Groceries' });
  for (const policy of [true, false]) {
    // Control: the same scene without the contradictory row qualifies (3750).
    assert.deepEqual(closeOf(b2Case({ policy }).active), [3750, 'estimated']);
    const { active, next, seed } = b2Case({ extra: [contradictory], policy });
    assert.equal(active.plannedPeriodClose, null);
    assert.match(active.plannedPeriodCloseReason, /cannot qualify it/);
    assert.equal(active.plannedPeriodCloseTrust, 'unknown');
    assert.equal(seed, null);
    if (!policy) assert.equal(next.opening, null);
  }
});

// Atlas #812 6541992380 / Muse 6542020449: opening inclusion is part of the
// close basis, linkage is lossless and order-independent, and a scoped close
// whose cash carry has no inspectable term is not carried (Q6). Invented
// ledger: Bills 8000 before the settlement, an in-cycle H card purchase of
// 4250, a confirmed settlement PAY-D (2000 to H unless stated). The snapshot
// is cash before its own day's flows; a payday-morning opening (as-of on the
// payday, no snapshot) is the observed stock and may already hold same-day
// posted cash.
function inclusionCase({ source = 'snapshot', payDate = '2026-10-02', purchaseDate = '2026-10-02', bills = [],
  represented = [], policy = true, alloc = 2000, other = 0 } = {}) {
  const x = ledger();
  const asOf = source === 'payday-morning' ? '2026-10-02' : '2026-10-07';
  x.asOf = asOf;
  x.plan.opening.asOf = asOf;
  if (source !== 'snapshot') delete x.plan.opening.paydaySnapshot;
  const packet = x.opts.currentPeriodActuals;
  packet.observationAsOf = asOf;
  packet.coverageThrough = asOf;
  if (packet.savingsFetchCoverage) packet.savingsFetchCoverage.endDate = asOf;
  x.plan.income = x.plan.income.filter(r => r.id === 'payroll');
  x.plan.budget = { categories: [{ id: 'groceries', label: 'Groceries', monthly: 0, essential: true }] };
  if (!policy) delete x.plan.savingsEarmarks.allocationPolicy;
  x.plan.obligations = [];
  x.plan.bills = bills;
  const pay = (alloc + other) / 100;
  x.plan.startingCash.breakdown[0].value = 80 - pay;
  x.plan.cardPurchaseCoverage = { payments: [{ id: 'p1', confirmed: true, creditRef: 'pay-c', debitRef: 'pay-d',
    allocations: alloc ? [{ purchaseRef: 'cov-1', amount: alloc / 100 }] : [], otherAmount: other / 100,
    ...(other ? { otherPurpose: 'prior-debt' } : {}) }], refunds: [], reversals: [] };
  packet.transactions = [{ ...purchase(42.5), date: purchaseDate },
    posted({ id: 'PAY-D', date: payDate, amount: pay, atlasAccountId: 'chequing-a',
      accountRole: 'household-cash', categoryLabel: 'Credit Card Payment', coverageRef: 'pay-d' }),
    posted({ id: 'PAY-C', date: payDate, amount: -pay, atlasAccountId: 'tdcc',
      accountRole: 'revolving-credit', categoryLabel: 'Credit Card Payment', coverageRef: 'pay-c' })];
  packet.representedActuals = represented;
  const before = JSON.stringify(x);
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: DEBTS });
  assert.equal(JSON.stringify(x), before, 'no input mutation');
  const views = a.payPeriodViews.filter(v => v.role !== 'lookback');
  const est = v => v.cardMatchingEstimate && v.cardMatchingEstimate.trust === 'estimated' ? cents(v.cardMatchingEstimate.opening) : null;
  return { a, active: views[0], next: views[1], seed: est(views[1]) };
}
const paydayBill = { id: 'card-bill', label: 'Invented card bill', frequency: 'monthly', day: 2, amount: 20, confidence: 'confirmed' };
const paydayRep = [{ id: 'card-bill', date: '2026-10-02', actual: 20, transactionId: 'PAY-D' }];

test('opening inclusion: a same-day settlement after a snapshot is a period flow; on a payday-morning opening it is ambiguous', () => {
  for (const policy of [true, false]) {
    // Snapshot 8000 is before the 10-02 settlement: 8000 - 2000 - 2250 = 3750,
    // which equals the close identity 8000 - 4250. Seed: 6000 - 2250 = 3750.
    const snap = inclusionCase({ policy });
    assert.equal(snap.active.openingSource, 'snapshot');
    assert.deepEqual(closeOf(snap.active), [3750, 'estimated'], `snapshot (policy ${policy})`);
    if (policy) assert.equal(snap.seed, 3750);
    else assert.equal(cents(snap.next.opening), 3750, 'the qualified close is carried');
    // Represented same-day bill: the snapshot close deducts that row and the
    // unreduced H, so it is unknown (no restoration).
    const snapBill = inclusionCase({ policy, bills: [paydayBill], represented: paydayRep });
    assert.equal(snapBill.active.plannedPeriodClose, null);
    assert.match(snapBill.active.plannedPeriodCloseReason, /counted twice/);
    // Payday-morning 6000 may or may not hold the 2000: 3750 if it does, 1750
    // if it does not. Unknown with or without the bill; never 1750.
    for (const bills of [[], [paydayBill]]) {
      const pm = inclusionCase({ policy, source: 'payday-morning', bills, represented: bills.length ? paydayRep : [] });
      assert.equal(pm.active.openingSource, 'payday-morning');
      assert.equal(cents(pm.active.opening), 6000);
      assert.equal(pm.active.plannedPeriodClose, null, `payday-morning (bill ${bills.length}, policy ${policy})`);
      assert.notEqual(cents(pm.active.plannedPeriodClose), 1750);
      assert.equal(pm.active.plannedPeriodCloseTrust, 'unknown');
      assert.match(pm.active.plannedPeriodCloseReason, /falls on the opening date/);
      if (!policy) assert.equal(pm.next.opening, null, 'the ambiguous close feeds no numeric carry');
      // The observed-stock seed is its own basis: 6000 - 2250 = 3750.
      if (policy) assert.equal(pm.seed, 3750);
    }
  }
});

test('opening inclusion: a settlement already inside a posted cutover opening is named; a later settlement is a period flow', () => {
  // As-of 10-07 with no snapshot: the opening is the posted cutover (10-07).
  // A 10-06 settlement funding H is inside it, so the unreduced hold would
  // count it again: unknown with its own reason. On the opening day itself
  // inclusion is ambiguous.
  const inside = inclusionCase({ source: 'cutover-opening', payDate: '2026-10-06', purchaseDate: '2026-10-05' });
  assert.equal(inside.active.openingSource, 'cutover-opening');
  assert.equal(inside.active.plannedPeriodClose, null);
  assert.match(inside.active.plannedPeriodCloseReason, /already inside the opening cash/);
  const sameDay = inclusionCase({ source: 'cutover-opening', payDate: '2026-10-07', purchaseDate: '2026-10-05' });
  assert.match(sameDay.active.plannedPeriodCloseReason, /falls on the opening date/);
  // After the snapshot (10-06): a period flow, 8000 - 4250 = 3750.
  assert.deepEqual(closeOf(inclusionCase({ payDate: '2026-10-06', purchaseDate: '2026-10-05' }).active), [3750, 'estimated']);
});

test('Q6: a non-H settlement share outside the scoped plan keeps the close but withholds its no-policy carry', () => {
  // 3000 settlement after the snapshot: 2000 to H, 1000 prior debt. Scoped
  // plan 8000 - 4250 = 3750; physical tail 8000 - 3000 - 2250 = 2750. No
  // Forecast-owned term reconciles the 1000, so the 3750 is not carried.
  const nopol = b2Case({ other: 1000, policy: false });
  assert.deepEqual(closeOf(nopol.active), [3750, 'estimated']);
  assert.equal(nopol.next.opening, null);
  // With a policy the observed-stock seed is 5000 - 2250 = 2750, unchanged.
  assert.equal(b2Case({ other: 1000 }).seed, 2750);
  // Non-H only, same day as the snapshot: scoped 3750 stands, carry withheld;
  // seed 6000 - 4250 = 1750.
  const nonH = inclusionCase({ alloc: 0, other: 2000, policy: false });
  assert.deepEqual(closeOf(nonH.active), [3750, 'estimated']);
  assert.equal(nonH.next.opening, null);
  assert.equal(inclusionCase({ alloc: 0, other: 2000 }).seed, 1750);
  // On a payday-morning opening a non-H share does not change the scoped
  // close (6000 - 4250 = 1750), but whether it already left is unknown, so
  // the carry is withheld.
  const pmNonH = inclusionCase({ source: 'payday-morning', alloc: 0, other: 2000, policy: false });
  assert.deepEqual(closeOf(pmNonH.active), [1750, 'estimated']);
  assert.equal(pmNonH.next.opening, null);
  // A pure-H settlement after the opening has no share outside the plan: carried.
  assert.equal(cents(b2Case({ policy: false }).next.opening), 3750);
});

test('linkage is lossless and order-independent: every distinct debit identity of an occurrence is inspected', () => {
  // One 2000 bill row on 10-06 represented by the settlement PAY-D (1000, all
  // to H) and an ordinary debit OTHER-D (1000). Either order: the close
  // deducts a row the settlement represents, so it is unknown.
  const bill6 = { id: 'card-bill', label: 'Invented card bill', frequency: 'monthly', day: 6, amount: 20, confidence: 'confirmed' };
  const other = posted({ id: 'OTHER-D', date: '2026-10-06', amount: 10, atlasAccountId: 'chequing-a',
    accountRole: 'household-cash', categoryLabel: 'Bills', coverageRef: 'other-d' });
  const pd = { id: 'card-bill', date: '2026-10-06', actual: 10, transactionId: 'PAY-D' };
  const od = { id: 'card-bill', date: '2026-10-06', actual: 10, transactionId: 'OTHER-D' };
  for (const policy of [true, false]) for (const represented of [[pd, od], [od, pd]]) {
    const r = b2Case({ bills: [bill6], represented, alloc: 1000, otherCash: 1000, extra: [other], policy });
    assert.equal(r.active.plannedPeriodClose, null, `order ${represented[0].transactionId} first (policy ${policy})`);
    assert.match(r.active.plannedPeriodCloseReason, /counted twice/);
    if (!policy) assert.equal(r.next.opening, null);
    // The observed-stock seed excludes the paid row: 6000 - (4250 - 1000) = 2750.
    if (policy) assert.equal(r.seed, 2750);
  }
  // Exact duplicate evidence adds no identity: the same result as one entry.
  const once = b2Case({ bills: [bill6], represented: repBy('card-bill', '2026-10-06') });
  const twice = b2Case({ bills: [bill6], represented: repBy('card-bill', '2026-10-06').concat(repBy('card-bill', '2026-10-06')) });
  assert.equal(twice.active.plannedPeriodClose, null);
  assert.equal(twice.active.plannedPeriodCloseReason, once.active.plannedPeriodCloseReason);
  assert.equal(twice.seed, once.seed);
  // Conflicting evidence for the settlement debit (two actuals) stays linked.
  const conflict = b2Case({ bills: [bill6], represented: [{ ...pd, actual: 20 }, { ...pd, actual: 5 }] });
  assert.equal(conflict.active.plannedPeriodClose, null);
  // One debit representing two deducted occurrences holds.
  const bill6b = { ...bill6, id: 'card-bill-b', label: 'Invented second bill' };
  const multi = b2Case({ bills: [bill6, bill6b], represented: repBy('card-bill', '2026-10-06').concat(repBy('card-bill-b', '2026-10-06')) });
  assert.equal(multi.active.plannedPeriodClose, null);
  assert.match(multi.active.plannedPeriodCloseReason, /counted twice/);
  // Unrelated multi-payment control: the row is represented by two ordinary
  // debits and the settlement represents nothing. Close 8000 - 2000 - 4250 =
  // 1750; seed (8000 - 2000 - 2000) - 2250 = 1750; carried without a policy.
  const o2 = posted({ ...other, id: 'OTHER2-D', coverageRef: 'other2-d' });
  const unrelated = { bills: [bill6], otherCash: 2000, extra: [{ ...other }, o2],
    represented: [od, { ...od, transactionId: 'OTHER2-D' }] };
  const u = b2Case(unrelated);
  assert.deepEqual(closeOf(u.active), [1750, 'estimated']);
  assert.equal(u.seed, 1750);
  assert.equal(cents(b2Case({ ...unrelated, policy: false }).next.opening), 1750);
});

// Atlas #812 6542560178 / Muse 6542634657: the H share of a settlement is
// only what it allocates to purchases this hold contains (the same recon
// universe the remaining-requirement loop consumes); everything else left
// Bills outside the scoped plan. The same split drives opening inclusion and
// the Q6 carry. Invented ledger: snapshot 8000 on payday 10-02 (as-of 10-07)
// unless stated, packet coverage from 09-25, H purchase CARD-1 4250, a
// prior-cycle card purchase CARD-0 1000 (09-28) and a current-cycle
// Restaurants purchase CARD-2 2000 that no budget row holds.
const cardTx = (id, date, amountCents, o = {}) => posted({ id, date, amount: amountCents / 100, atlasAccountId: 'tdcc',
  accountRole: 'revolving-credit', categoryLabel: 'Groceries', coverageRef: id.toLowerCase(), ...o });
const P1 = (date = '2026-10-05') => cardTx('CARD-1', date, 4250, { coverageRef: 'cov-1' });
const P0 = cardTx('CARD-0', '2026-09-28', 1000, { coverageRef: 'cov-0' });
const P2 = cardTx('CARD-2', '2026-10-04', 2000, { coverageRef: 'cov-2', categoryLabel: 'Restaurants' });
function settle({ id = 'p1', d = 'PAY-D', c = 'PAY-C', date, alloc = [], other = 0 }) {
  const total = alloc.reduce((s, a) => s + a[1], 0) + other;
  return {
    txs: [posted({ id: d, date, amount: total / 100, atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      categoryLabel: 'Credit Card Payment', coverageRef: d.toLowerCase() }),
    posted({ id: c, date, amount: -total / 100, atlasAccountId: 'tdcc', accountRole: 'revolving-credit',
      categoryLabel: 'Credit Card Payment', coverageRef: c.toLowerCase() })],
    record: { id, confirmed: true, creditRef: c.toLowerCase(), debitRef: d.toLowerCase(),
      allocations: alloc.map(([ref, a]) => ({ purchaseRef: ref, amount: a / 100 })), otherAmount: other / 100,
      ...(other ? { otherPurpose: 'prior-debt' } : {}) },
  };
}
// source: 'snapshot' | 'payday-morning' | 'walk' (no snapshot; plan.opening.asOf = dated).
function shareCase({ source = 'snapshot', stock, purchases, settlements = [], bills = [], represented = [], extra = [],
  policy = true, dated = null, gap = null, movement = false } = {}) {
  const x = ledger();
  const asOf = source === 'payday-morning' ? '2026-10-02' : '2026-10-07';
  x.asOf = asOf;
  x.plan.opening.asOf = dated || asOf;
  if (source !== 'snapshot') delete x.plan.opening.paydaySnapshot;
  const packet = x.opts.currentPeriodActuals;
  packet.observationAsOf = asOf;
  packet.coverageThrough = asOf;
  packet.coverageStart = '2026-09-25';
  if (packet.savingsFetchCoverage) Object.assign(packet.savingsFetchCoverage, { startDate: '2026-09-25', endDate: asOf });
  if (movement) packet.savingsMovementUnconfirmed = [{ accountId: 'savings', reason: 'transaction-posting-status-unconfirmed' }];
  x.plan.income = x.plan.income.filter(r => r.id === 'payroll');
  x.plan.budget = { categories: [{ id: 'groceries', label: 'Groceries', monthly: 0, essential: true }] };
  if (!policy) delete x.plan.savingsEarmarks.allocationPolicy;
  x.plan.obligations = [];
  x.plan.bills = bills;
  x.plan.startingCash.breakdown[0].value = stock / 100;
  const sets = settlements.map(settle);
  if (sets.length) x.plan.cardPurchaseCoverage = { payments: sets.map(s => s.record), refunds: [], reversals: [] };
  packet.transactions = [].concat(purchases, ...sets.map(s => s.txs), extra);
  packet.representedActuals = represented;
  const before = JSON.stringify(x);
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: DEBTS, ...(gap ? { paydayGapCash: gap } : {}) });
  assert.equal(JSON.stringify(x), before, 'no input mutation');
  const views = a.payPeriodViews.filter(v => v.role !== 'lookback');
  const est = v => v.cardMatchingEstimate && v.cardMatchingEstimate.trust === 'estimated' ? cents(v.cardMatchingEstimate.opening) : null;
  return { a, active: views[0], next: views[1], later: views[2], seed: est(views[1]) };
}
// The published close equals its own terms identity, never adjusted.
const termsOf = v => {
  const t = v.plannedPeriodCloseTerms;
  return cents(t.opening) + cents(t.incomeAdded) - cents(t.periodBillLoad) - cents(t.budgetHold) - cents(t.annualSavingsNeed);
};

test('Q6: the H share is this hold\'s own recon universe; cash allocated outside H is outside the scoped plan', () => {
  // [shape, observed stock at 10-07, settlement(s), seed oracle]. Every shape
  // posts its payment on 10-06, after the snapshot: scoped close
  // 8000 - 4250 = 3750 stands; the no-policy carry is withheld when any cent
  // left outside H; the observed-stock seed is stock - (4250 - H share).
  const cases = {
    'prior debt as otherAmount': [5000, [{ date: '2026-10-06', alloc: [['cov-1', 2000]], other: 1000 }], 2750],
    'prior-cycle purchase as an allocation': [5000, [{ date: '2026-10-06', alloc: [['cov-1', 2000], ['cov-0', 1000]] }], 2750],
    'separate records': [5000, [{ id: 'p0', d: 'PAY0-D', c: 'PAY0-C', date: '2026-10-06', alloc: [['cov-0', 1000]] },
      { date: '2026-10-06', alloc: [['cov-1', 2000]] }], 2750],
    'current-cycle purchase no budget row holds': [4000, [{ date: '2026-10-06', alloc: [['cov-1', 2000], ['cov-2', 2000]] }], 1750],
    'wholly outside H': [7000, [{ date: '2026-10-06', alloc: [['cov-0', 1000]] }], 2750],
  };
  for (const [name, [stock, settlements, seed]] of Object.entries(cases)) {
    const purchases = [P0, P1(), P2];
    const nopol = shareCase({ stock, purchases, settlements, policy: false });
    assert.deepEqual(closeOf(nopol.active), [3750, 'estimated'], `${name}: scoped close`);
    assert.equal(termsOf(nopol.active), 3750, `${name}: close identity`);
    assert.equal(nopol.next.opening, null, `${name}: the unreconciled carry is withheld`);
    assert.equal(nopol.next.paydaySweep, null, `${name}: no sweep from it`);
    assert.equal(nopol.next.plannedPeriodClose, null, `${name}: no later close from it`);
    assert.equal(nopol.later.opening, null, `${name}: never resurrected later`);
    const pol = shareCase({ stock, purchases, settlements });
    assert.deepEqual(closeOf(pol.active), [3750, 'estimated']);
    assert.equal(pol.seed, seed, `${name}: independent seed (outside-H cash not subtracted again)`);
  }
  // Entirely H-funded and partly H-funded controls carry: 8000 - 2000 - 2250
  // = 3750 and 8000 - 1000 - 3250 = 3750 physically.
  for (const [stock, alloc] of [[6000, 2000], [7000, 1000]]) {
    const purchases = [P0, P1()];
    const h = shareCase({ stock, purchases, settlements: [{ date: '2026-10-06', alloc: [['cov-1', alloc]] }], policy: false });
    assert.deepEqual(closeOf(h.active), [3750, 'estimated']);
    assert.equal(cents(h.next.opening), 3750, `H-only ${alloc}: carried`);
    assert.equal(shareCase({ stock, purchases, settlements: [{ date: '2026-10-06', alloc: [['cov-1', alloc]] }] }).seed, 3750);
  }
  // A combined Savings movement hold changes none of this.
  const moved = shareCase({ stock: 5000, purchases: [P0, P1()], movement: true, policy: false,
    settlements: [{ date: '2026-10-06', alloc: [['cov-1', 2000], ['cov-0', 1000]] }] });
  assert.deepEqual(closeOf(moved.active), [3750, 'estimated']);
  assert.equal(moved.next.opening, null);
});

test('opening inclusion uses the same H split: only an H-funding debit makes the close ambiguous', () => {
  // Payday-morning opening (as-of 10-02, opening 7000), H purchase on 10-02,
  // a same-day payment wholly to the prior-cycle purchase: the scoped close
  // 7000 - 4250 = 2750 does not depend on inclusion, so it stands; whether the
  // cash already left is unknown, so the carry is withheld. Seed 7000 - 4250.
  const wholly = shareCase({ source: 'payday-morning', stock: 7000, purchases: [P0, P1('2026-10-02')], policy: false,
    settlements: [{ date: '2026-10-02', alloc: [['cov-0', 1000]] }] });
  assert.equal(wholly.active.openingSource, 'payday-morning');
  assert.deepEqual(closeOf(wholly.active), [2750, 'estimated']);
  assert.equal(wholly.next.opening, null);
  assert.equal(shareCase({ source: 'payday-morning', stock: 7000, purchases: [P0, P1('2026-10-02')],
    settlements: [{ date: '2026-10-02', alloc: [['cov-0', 1000]] }] }).seed, 2750);
  // Mixed on the same day: the H share makes inclusion matter, so the close
  // is unknown; the seed is 5000 - 2250 = 2750.
  const mixed = shareCase({ source: 'payday-morning', stock: 5000, purchases: [P0, P1('2026-10-02')],
    settlements: [{ date: '2026-10-02', alloc: [['cov-1', 2000], ['cov-0', 1000]] }] });
  assert.equal(mixed.active.plannedPeriodClose, null);
  assert.match(mixed.active.plannedPeriodCloseReason, /falls on the opening date/);
  assert.equal(mixed.seed, 2750);
  // A snapshot is before its own day's flows: the same wholly-outside payment
  // on 10-02 keeps 8000 - 4250 = 3750 and withholds only the carry.
  const snap = shareCase({ stock: 7000, purchases: [P0, P1('2026-10-02')], policy: false,
    settlements: [{ date: '2026-10-02', alloc: [['cov-0', 1000]] }] });
  assert.deepEqual(closeOf(snap.active), [3750, 'estimated']);
  assert.equal(snap.next.opening, null);
});

test('a zero-gap cutover-walk opening is the dated reading itself and may hold same-day cash; a reconstructed morning does not', () => {
  // No snapshot, as-of 10-07, H purchase 4250 on 10-02, settlement 2000 to H.
  // Zero gap: the plan's dated opening IS the payday (10-02), so the 8000 is
  // a reading of unknown time of day: a same-day H-funding debit is unknown.
  const zero = date => shareCase({ source: 'walk', dated: '2026-10-02', stock: 8000, purchases: [P1('2026-10-02')],
    settlements: [{ date, alloc: [['cov-1', 2000]] }], policy: false });
  const sameDay = zero('2026-10-02');
  assert.equal(sameDay.active.openingSource, 'cutover-walk');
  assert.equal(sameDay.active.plannedPeriodClose, null);
  assert.match(sameDay.active.plannedPeriodCloseReason, /falls on the opening date/);
  assert.equal(sameDay.next.opening, null);
  // After the opening day it is a period flow: 8000 - 4250 = 3750.
  assert.deepEqual(closeOf(zero('2026-10-06').active), [3750, 'estimated']);
  // Positive gap: the morning is reconstructed from a 09-30 reading plus a
  // complete (empty) gap, so it is cash before 10-02's flows: 3750, carried.
  const walk = shareCase({ source: 'walk', dated: '2026-09-30', stock: 8000, purchases: [P1('2026-10-02')], policy: false,
    settlements: [{ date: '2026-10-02', alloc: [['cov-1', 2000]] }],
    gap: { complete: true, movements: [], coverageStart: '2026-10-01', coverageThrough: '2026-10-01' } });
  assert.equal(walk.active.openingSource, 'cutover-walk');
  assert.deepEqual(closeOf(walk.active), [3750, 'estimated']);
  assert.equal(cents(walk.next.opening), 3750);
});

test('cutover linkage stands on its own: a plain bill paid early by the settlement, and one debit claimed twice', () => {
  // A plain monthly bill due 10-10 (after the 10-07 as-of; not a payment
  // obligation, so neither ruling 1 nor the Q3 horizon applies) paid early on
  // 10-06 by the settlement debit. The seed would deduct the row and relieve
  // H by the same cash: 6000 - 2000 - 2250 = 1750 against 3750 counted once.
  const early = { id: 'early-bill', label: 'Invented bill', frequency: 'monthly', day: 10, amount: 20, confidence: 'confirmed' };
  const other = posted({ id: 'OTHER-D', date: '2026-10-06', amount: 10, atlasAccountId: 'chequing-a',
    accountRole: 'household-cash', categoryLabel: 'Bills', coverageRef: 'other-d' });
  const single = shareCase({ stock: 6000, purchases: [P1()], bills: [early],
    settlements: [{ date: '2026-10-06', alloc: [['cov-1', 2000]] }],
    represented: [{ id: 'early-bill', date: '2026-10-10', actual: 20, transactionId: 'PAY-D' }] });
  assert.equal(single.seed, null, 'cutover linkage holds the seed');
  const pd = { id: 'early-bill', date: '2026-10-10', actual: 10, transactionId: 'PAY-D' };
  const od = { id: 'early-bill', date: '2026-10-10', actual: 10, transactionId: 'OTHER-D' };
  for (const represented of [[pd, od], [od, pd]]) {
    const r = shareCase({ stock: 6000, purchases: [P1()], bills: [early], extra: [other], represented,
      settlements: [{ date: '2026-10-06', alloc: [['cov-1', 1000]] }] });
    assert.equal(r.seed, null, `order ${represented[0].transactionId} first: the seed holds`);
  }
  // One debit claimed by two occurrences (two 2000 bills on 10-06, both
  // represented by the 2000 settlement that also funds H): it cannot be
  // attributed once, so both bases hold.
  const bill6 = { id: 'bill-a', label: 'Invented card bill', frequency: 'monthly', day: 6, amount: 20, confidence: 'confirmed' };
  const bill6b = { ...bill6, id: 'bill-b', label: 'Invented second bill' };
  const twice = shareCase({ stock: 6000, purchases: [P1()], bills: [bill6, bill6b],
    settlements: [{ date: '2026-10-06', alloc: [['cov-1', 2000]] }],
    represented: [{ id: 'bill-a', date: '2026-10-06', actual: 20, transactionId: 'PAY-D' },
      { id: 'bill-b', date: '2026-10-06', actual: 20, transactionId: 'PAY-D' }] });
  assert.equal(twice.active.plannedPeriodClose, null);
  assert.equal(twice.seed, null);
  // The legitimate side: the settlement represents exactly one occurrence
  // (next month's), so nothing is counted twice. This month's unrepresented
  // 10-06 occurrence is after the 10-02 snapshot, so the snapshot close
  // deducts it once (Bills audit of 57cb421; was 3750):
  // close 8000 - 2000 - 4250 = 1750; the 10-07 cutover seed already has it
  // inside observed stock: 6000 - 2250 = 3750.
  const once = shareCase({ stock: 6000, purchases: [P1()], bills: [bill6],
    settlements: [{ date: '2026-10-06', alloc: [['cov-1', 2000]] }],
    represented: [{ id: 'bill-a', date: '2026-11-06', actual: 20, transactionId: 'PAY-D' }] });
  assert.deepEqual(closeOf(once.active), [1750, 'estimated']);
  assert.equal(once.seed, 3750);
});

test('excluded pending twins cannot reach the H split: the reconciler already holds them hard', () => {
  // A pending duplicate of the H purchase (with or without its own reference)
  // raises an identity or replacement issue before matching, so the hold is
  // not matching-only and nothing numeric is published on either basis.
  for (const ref of ['cov-1p', undefined]) {
    const twin = cardTx('CARD-1P', '2026-10-05', 4250, { coverageRef: ref, pending: true, pendingPostedDuplicate: true });
    for (const policy of [true, false]) {
      const r = shareCase({ stock: 6000, purchases: [P1(), twin], policy, settlements: [{ date: '2026-10-06', alloc: [['cov-1', 2000]] }] });
      assert.equal(r.active.plannedPeriodClose, null);
      assert.equal(r.seed, null);
      if (!policy) assert.equal(r.next.opening, null);
    }
  }
});
