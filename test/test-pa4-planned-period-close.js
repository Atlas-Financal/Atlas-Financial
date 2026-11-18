'use strict';
// PA-4a (owner direction 2026-10-30; adopted packet #787 6526949494):
// every pay period publishes an opening-inclusive planned close under its
// own name. Unresolved card purchase/payment matching labels it estimated
// with a reason instead of blanking it; a deficit is published and carried;
// the balance-after-deductions identity (no opening) and available-now
// qualification are unchanged. Synthetic plan; expected cents are literal.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const F = require(path.join(process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..'), 'public/forecast'));

const ASOF = '2026-10-07';
// Payday snapshot opening 500 on 2026-10-02; biweekly pay 1000; one monthly
// bill on the 20th; no household budget categories.
function plan(bill = 120) {
  return {
    windowDays: 120, defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: ASOF, paydaySnapshot: { periodStart: '2026-10-02', asOf: '2026-10-02', opening: 500 },
      representedEvents: [{ id: 'payroll', date: '2026-10-02' }] },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 500 }, { id: 'chequing-b', value: 0 }] },
    income: [{ id: 'payroll', frequency: 'biweekly', anchor: '2026-10-02', amount: 1000, confidence: 'confirmed' }],
    bills: [{ id: 'b1', label: 'Synthetic bill', frequency: 'monthly', day: 20, amount: bill, confidence: 'confirmed' }],
    obligations: [], commitments: [], budget: { categories: [] },
  };
}
// One posted card purchase of 42.50 with no confirmed coverage opening:
// card matching is unresolved (coverage-opening-unconfirmed).
function actuals(card) {
  return { schema: 'atlas-current-period-actuals/v1', observationAsOf: ASOF, coverageStart: '2026-09-01',
    coverageThrough: ASOF, pendingCoverage: 'complete', transactionCoverage: 'complete', representedActuals: [],
    transactions: card ? [{ id: 'CARD-1', date: '2026-10-05', amount: 42.5, pending: false, currency: 'CAD',
      savingsPostingEvidence: 'posted', atlasAccountId: 'tdcc', accountRole: 'revolving-credit',
      categoryLabel: 'Groceries', coverageRef: 'cov-1' }] : [] };
}
function run(card, bill) {
  const p = plan(bill), before = JSON.stringify(p);
  const a = F.recommend(p, ASOF, { weeklyVariable: 0, debts: [], currentPeriodActuals: actuals(card) });
  assert.equal(JSON.stringify(p), before, 'no input mutation');
  return a;
}
const periods = a => a.payPeriodViews.filter(p => p.role !== 'lookback').slice(0, 4);
const c = n => Math.round(n * 100);

test('card matching unresolved: the planned close is published, ESTIMATED, with the reason on the figure', () => {
  const a = run(true);
  assert.equal(a.cardPurchaseCoverage.status, 'unavailable', 'fixture: card hold is on');
  for (const p of periods(a)) {
    assert.equal(typeof p.plannedPeriodClose, 'number', `${p.start}: not blanked`);
    assert.equal(p.plannedPeriodCloseTrust, 'estimated', `${p.start}: estimated`);
    assert.match(p.plannedPeriodCloseReason, /card purchase and payment matching is unresolved/);
    assert.match(p.plannedPeriodCloseReason, /not verified safe-to-spend cash/);
  }
  // Hand-derived: 500 opening + 1000 pay - 42.50 card spend = 1457.50; next
  // period opens there, + 1000 pay - 120 bill = 2337.50.
  const [active, next] = periods(a);
  assert.equal(c(active.plannedPeriodClose), 145750);
  assert.equal(c(next.plannedPeriodClose), 233750);
});

test('coverage not in play: the same identity publishes calculated, with no card reason', () => {
  const a = run(false);
  const [active, next] = periods(a);
  assert.equal(c(active.plannedPeriodClose), 150000); // 500 + 1000
  assert.equal(c(next.plannedPeriodClose), 238000);   // 1500 + 1000 - 120
  for (const p of periods(a)) {
    assert.equal(p.plannedPeriodCloseTrust, 'calculated');
    assert.equal(p.plannedPeriodCloseReason, null);
  }
});

test('the card purchase is deducted exactly once', () => {
  const held = periods(run(true)), clear = periods(run(false));
  assert.equal(c(clear[0].plannedPeriodClose) - c(held[0].plannedPeriodClose), 4250, 'one 42.50 deduction, not two');
});

test('a deficit is published negative, carried into the next opening, with zero sweep', () => {
  const [, deficit, after] = periods(run(true, 2600));
  // 1457.50 opening + 1000 pay - 2600 bill = -142.50.
  assert.equal(c(deficit.plannedPeriodClose), -14250, 'not clamped to zero');
  assert.equal(deficit.plannedPeriodCloseTerms.deficit, true);
  assert.equal(deficit.paydaySweep, 0, 'no sweep from a deficit');
  assert.equal(c(after.opening), -14250, 'the negative carries in full');
  assert.equal(c(after.plannedPeriodClose), -14250 + 100000);
});

test('balance after deductions keeps its identity (no opening) and terms reconcile', () => {
  for (const p of periods(run(true))) {
    assert.equal(p.predictedEndingBalance, p.balanceAfterDeductions, `${p.start}: BAD identity unchanged`);
    const t = p.plannedPeriodCloseTerms;
    assert.equal(c(p.plannedPeriodClose),
      c(t.opening) + c(t.incomeAdded) - c(t.periodBillLoad) - c(t.budgetHold) - c(t.annualSavingsNeed),
      `${p.start}: published terms close`);
  }
});

test('available-now qualification is unchanged under the card hold', () => {
  assert.equal(run(true).currentPeriodAction.unavailable, true, 'still held while matching is unresolved');
  assert.notEqual(run(false).currentPeriodAction.unavailable, true);
});

test('an unknown opening publishes no planned close, with the reason', () => {
  const p = plan(); delete p.opening.paydaySnapshot; p.startingCash.breakdown[0].value = null;
  const a = F.recommend(p, ASOF, { weeklyVariable: 0, debts: [], currentPeriodActuals: actuals(false) });
  const active = periods(a)[0];
  assert.equal(active.plannedPeriodClose, null, 'unknown opening is never zero');
  assert.equal(active.plannedPeriodCloseTrust, 'unknown');
  assert.match(active.plannedPeriodCloseReason, /opening or a deduction is not known/);
});

// Pre-review finding: only a card-MATCHING hold may estimate; every other
// card hold leaves the plan's cash basis unknown (never a number, never 0).
const CARD_DEBTS = [{ id: 'card', label: 'Synthetic card', balance: 821.43, pending: 0, rate: 0, limit: 2000 }];
function cardMinimumObligation() {
  return { id: 'card', debtId: 'card', effect: 'payment', label: 'Synthetic card minimum', frequency: 'monthly',
    day: 7, firstDue: '2026-10-07', amount: 47.39, confidence: 'estimated', payingAccount: 'chequing-a',
    statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08', minimum: 47.39, currency: 'cad',
      confidence: 'confirmed' }],
    sentPayments: [{ scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum', debitId: 'synthetic-debit',
      postedOn: '2026-10-05', amount: 47.39, currency: 'cad', fundingAccountId: 'chequing-a', pending: false }] };
}
function hardHold(mutate) {
  const p = plan(), pkt = actuals(true); mutate(p, pkt);
  const a = F.recommend(p, ASOF, { weeklyVariable: 0, debts: CARD_DEBTS, currentPeriodActuals: pkt });
  assert.equal(a.cardPurchaseCoverage.status, 'unavailable', 'fixture: card hold is on');
  return periods(a);
}
for (const [label, mutate] of [
  ['incomplete transaction history', (p, pkt) => { pkt.transactionCoverage = 'partial'; }],
  ['unknown Bills balance', (p) => { p.startingCash.breakdown[0].unknown = true; }],
  ['unconfirmed card currency', (p, pkt) => { pkt.transactions[0].currency = 'USD'; }],
  // The coverage issues stay matching-only here; only the card minimum is
  // unavailable (a sent payment with unconfirmed cash inclusion).
  ['unavailable card minimum', (p) => { p.obligations = [cardMinimumObligation()]; }],
]) {
  test(`hard card hold (${label}): planned close is null with the card reason`, () => {
    for (const per of hardHold(mutate)) {
      assert.equal(per.plannedPeriodClose, null, `${per.start}: no number`);
      assert.equal(per.plannedPeriodCloseTrust, 'unknown');
      assert.match(per.plannedPeriodCloseReason, /card coverage is unavailable for a reason other than matching/);
    }
  });
}

test('estimated trust carries forward into periods that open from an estimated close', () => {
  const p = plan(); p.bills[0].confidence = 'estimated'; // an estimated deduction in each period
  const pkt = actuals(false);
  pkt.transactions = [];
  const per = periods(F.recommend(p, ASOF, { weeklyVariable: 0, debts: [], currentPeriodActuals: pkt }));
  const firstEstimated = per.findIndex(x => x.plannedPeriodCloseTrust === 'estimated');
  assert.ok(firstEstimated >= 0, 'fixture: an estimated close exists');
  for (const later of per.slice(firstEstimated + 1)) {
    if (later.plannedPeriodClose === null) continue;
    assert.equal(later.plannedPeriodCloseTrust, 'estimated', `${later.start}: carried estimated, never calculated`);
    assert.match(later.plannedPeriodCloseReason, /estimated/);
  }
});

test('card reserve shortfall: disclosed on the active period, estimated, never deducted from the plan', () => {
  const p = plan(), pkt = actuals(true);
  // PA-4a-2b (Atlas 6538656590, ruling 8): the below-reserve branch is soft
  // only on qualified operating cash, so both chequing rows are present.
  p.startingCash.breakdown.push({ id: 'chequing-b', value: 0 });
  pkt.transactions[0].amount = 5000; // a purchase larger than the known Bills balance
  const a = F.recommend(p, ASOF, { weeklyVariable: 0, debts: [], currentPeriodActuals: pkt });
  assert.deepEqual(a.cardPurchaseCoverage.issues.map(i => i.code).sort(),
    ['coverage-bills-backing-unconfirmed', 'coverage-opening-unconfirmed'], 'fixture: matching-only, below-reserve branch');
  const active = periods(a)[0];
  const d = active.cardReserveShortfall;
  // 5000 matching-derived reserve - 500 known Bills balance = 4500.00.
  assert.equal(Math.round(d.amount * 100), 450000);
  assert.ok(d.trust === 'estimated' && d.deducted === false);
  for (const later of periods(a).slice(1)) {
    assert.equal(later.cardReserveShortfall, undefined, `${later.start}: disclosed on the active period only`);
  }
  assert.match(d.reason, /not the plan deficit/);
  // Not deducted: the planned close is still opening + income - the card spend counted once.
  assert.equal(active.plannedPeriodCloseTrust, 'estimated');
  assert.equal(Math.round(active.plannedPeriodClose * 100), 50000 + 100000 - 500000);
  // No disclosure without the below-reserve branch.
  assert.equal(periods(run(true))[0].cardReserveShortfall, undefined);
});

test('card matching plus another estimated input: both reasons are published', () => {
  const p = plan(); p.bills[0].confidence = 'estimated';
  const per = periods(F.recommend(p, ASOF, { weeklyVariable: 0, debts: [], currentPeriodActuals: actuals(true) }));
  const both = per.filter(x => x.periodBillLoadTrust === 'estimated' && x.plannedPeriodClose !== null);
  assert.ok(both.length, 'fixture: a period with an estimated bill and a card-matching estimate');
  for (const x of both) {
    assert.equal(x.plannedPeriodCloseTrust, 'estimated');
    assert.match(x.plannedPeriodCloseReason, /card purchase and payment matching is unresolved/, `${x.start}: card reason`);
    assert.match(x.plannedPeriodCloseReason, /an input to this close .* is estimated/, `${x.start}: input reason kept`);
  }
});

// PA-1: an unqualified Savings movement makes projected openings estimated;
// the planned close built on them is estimated too, never calculated.
test('PA-1 movement hold: every projected planned close is estimated, with a reason', () => {
  const input = require('./fixtures/savings-future-closing-data');
  const run1 = unq => {
    const x = input();
    x.plan.income.push({ id: 'p0', label: 'Invented', frequency: 'once', date: '2026-10-09', amount: 400, confidence: 'confirmed' });
    if (unq) x.opts.currentPeriodActuals.savingsMovementUnconfirmed = [{ accountId: 'savings', reason: 'transaction-posting-status-unconfirmed' }];
    return F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] }).payPeriodViews.filter(v => v.role === 'future');
  };
  const held = run1(true), clear = run1(false);
  assert.ok(held.length >= 3 && held.every(v => v.openingTrust === 'estimated'), 'fixture: PA-1 hold is on');
  assert.ok(clear.every(v => v.plannedPeriodCloseTrust === 'calculated'), 'control: calculated without the hold');
  for (const v of held) {
    assert.equal(typeof v.plannedPeriodClose, 'number', `${v.start}: published`);
    assert.equal(v.plannedPeriodCloseTrust, 'estimated', `${v.start}: estimated, not calculated`);
    assert.match(v.plannedPeriodCloseReason, /is estimated/);
  }
});

// Atlas #809 B1: a Savings-funded yearly bill is excluded from paycheck Bills
// and enters the close as annualSavingsNeed; its own confidence must feed the
// close's trust. Invented fixture: 200 premium due 2026-10-25 against a
// purpose-reserve goal; every other input confirmed.
function annualFixture(confidence, amount = 200) {
  const { ledger } = require('./fixtures/chronological-savings-data');
  const { advance } = require('./fixtures/savings-daily-allocation-contract');
  const i = advance(ledger(), '2026-10-10');
  i.plan.income[0].anchor = '2026-08-14';
  i.plan.income = i.plan.income.map(row => ({ ...row, confidence: 'confirmed' }));
  i.plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 80 };
  i.plan.opening.representedEvents = [];
  i.opts.currentPeriodActuals.coverageStart = '2026-10-09';
  i.opts.currentPeriodActuals.savingsFetchCoverage.startDate = '2026-10-09';
  i.plan.bills = [{ id: 'annual', label: 'Invented annual premium', amount, frequency: 'yearly',
    month: 10, day: 25, firstDue: '2026-10-25', jointCash: false, confidence }];
  i.plan.savingsEarmarks.pools[1].goalRefs = [{ kind: 'yearly-bill', id: 'annual' }];
  const a = F.recommend(i.plan, i.asOf, { ...i.opts, debts: [], weeklyVariable: 0 });
  const views = a.payPeriodViews.filter(p => p.role === 'future');
  return { due: views.find(p => p.start === '2026-10-23'), later: views.filter(p => p.start > '2026-10-23') };
}

test('annual provision confirmed (control): the close is calculated with the provision deducted', () => {
  const { due, later } = annualFixture('confirmed');
  assert.ok(due.plannedPeriodCloseTerms.annualSavingsNeed > 0, 'fixture: an unfunded provision lands in this period');
  assert.equal(due.plannedPeriodCloseTrust, 'calculated');
  assert.equal(due.plannedPeriodCloseReason, null);
  for (const p of later) assert.equal(p.plannedPeriodCloseTrust, 'calculated', `${p.start}: control stays calculated`);
});

// Carry redesign (Atlas 6535096443 point 4): the future carry restores the
// annual provision exactly (availableRemainder adds annualSavingsNeed back
// before the one sweep), so later closes do not depend on it. The next test
// proves that amount independence directly: a confirmed 200 and a confirmed
// 900 provision give the same sweep and the same later openings and closes.
test('exactly restored annual provision: its amount does not move the sweep or later closes', () => {
  const small = annualFixture('confirmed', 200), large = annualFixture('confirmed', 900);
  assert.notEqual(c(large.due.plannedPeriodClose), c(small.due.plannedPeriodClose), 'fixture: the due-period close moves with it');
  assert.equal(c(large.due.paydaySweep), c(small.due.paydaySweep), 'the sweep basis restores the provision exactly');
  assert.ok(small.later.length);
  small.later.forEach((p, n) => {
    assert.equal(c(large.later[n].opening), c(p.opening), `${p.start}: opening independent of the amount`);
    assert.equal(c(large.later[n].plannedPeriodClose), c(p.plannedPeriodClose));
  });
});

test('annual provision estimated: the due-period close is estimated; the exactly restored provision does not taint later closes', () => {
  const { due, later } = annualFixture('estimated');
  assert.ok(due.plannedPeriodCloseTerms.annualSavingsNeed > 0);
  assert.equal(due.plannedPeriodCloseTrust, 'estimated', 'never promoted to calculated');
  assert.match(due.plannedPeriodCloseReason, /an input to this close .* is estimated/);
  assert.ok(later.length);
  for (const p of later) assert.equal(p.plannedPeriodCloseTrust, 'calculated', `${p.start}: restored term does not taint`);
});

test('annual provision with unknown confidence: the due-period close is unknown; later closes stay independent', () => {
  const { due, later } = annualFixture('unknown');
  assert.equal(due.plannedPeriodClose, null, 'a numeric amount does not make unknown confidence calculated');
  assert.equal(due.plannedPeriodCloseTrust, 'unknown');
  assert.match(due.plannedPeriodCloseReason, /unavailable trust/);
  const control = annualFixture('confirmed');
  assert.ok(later.length);
  later.forEach((p, n) => {
    assert.equal(c(p.opening), c(control.later[n].opening), `${p.start}: opening independent of the provision`);
    assert.equal(c(p.plannedPeriodClose), c(control.later[n].plannedPeriodClose));
    assert.equal(p.plannedPeriodCloseTrust, 'calculated');
  });
});

// Atlas #809 B1 (re-review at f0f0e1b5): the annual provision in the ACTIVE
// period. Without an allocation policy the next opening is this close's own
// cash, so an unknown close must keep the dependent later closes unknown.
// Atlas's synthetic discriminator: the PA-4 plan plus a 200 Savings-funded
// yearly bill due 2026-10-10; carry 500 + 1000 - 200 = 1300 into Oct 16.
function activeAnnual(confidence) {
  const p = plan();
  p.bills.push({ id: 'annual', label: 'Synthetic annual', frequency: 'yearly', month: 10, day: 10,
    firstDue: '2026-10-10', amount: 200, jointCash: false, confidence });
  p.savingsEarmarks = { version: 1, currency: 'CAD', history: [], pools: [{ id: 'pool', accountId: 'savings',
    label: 'Synthetic pool', role: 'purpose-reserve', purpose: 'Synthetic', goalRefs: [{ kind: 'yearly-bill', id: 'annual' }] }] };
  return periods(F.recommend(p, ASOF, { weeklyVariable: 0, debts: [], currentPeriodActuals: actuals(false) }));
}

test('active annual provision, confirmed control: 1300 carries and the next close is calculated', () => {
  const [active, next] = activeAnnual('confirmed');
  assert.equal(c(active.plannedPeriodClose), 130000);
  assert.equal(active.plannedPeriodCloseTrust, 'calculated');
  assert.equal(c(next.opening), 130000, 'fixture: the next opening is the active close cash');
  assert.equal(c(next.plannedPeriodClose), 218000); // 1300 + 1000 - 120
  assert.equal(next.plannedPeriodCloseTrust, 'calculated');
});

test('active annual provision, estimated: the active and dependent later closes are estimated', () => {
  const [active, ...later] = activeAnnual('estimated');
  assert.equal(active.plannedPeriodCloseTrust, 'estimated');
  for (const p of later) if (p.plannedPeriodClose !== null) assert.equal(p.plannedPeriodCloseTrust, 'estimated', p.start);
});

test('active annual provision, unknown confidence: the dependent later closes are unknown, never calculated', () => {
  const [active, ...later] = activeAnnual('unknown');
  assert.equal(active.plannedPeriodClose, null);
  assert.equal(active.plannedPeriodCloseTrust, 'unknown');
  assert.equal(c(later[0].opening), 130000, 'fixture: a finite carry still seeds the next opening');
  for (const p of later) {
    assert.equal(p.plannedPeriodClose, null, `${p.start}: depends on the unknown active close`);
    assert.equal(p.plannedPeriodCloseTrust, 'unknown');
  }
});

// The S1 observed-Bills seed (allocation policy installed) is independently
// qualified: it does not include the Savings-funded provision, so the next
// opening is identical whether the provision is confirmed or unknown, and a
// later close built on it is not poisoned by the active display.
test('independent S1 seam: an unknown active provision does not blank the independently seeded next close', () => {
  const run1 = confidence => {
    const { ledger } = require('./fixtures/chronological-savings-data');
    const { advance } = require('./fixtures/savings-daily-allocation-contract');
    const i = advance(ledger(), '2026-10-10');
    i.plan.income[0].anchor = '2026-08-14';
    i.plan.income = i.plan.income.map(row => ({ ...row, confidence: 'confirmed' }));
    i.plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 80 };
    i.plan.opening.representedEvents = [];
    i.opts.currentPeriodActuals.coverageStart = '2026-10-09';
    i.opts.currentPeriodActuals.savingsFetchCoverage.startDate = '2026-10-09';
    i.plan.bills = [{ id: 'annual', label: 'Invented annual premium', amount: 200, frequency: 'yearly',
      month: 10, day: 15, firstDue: '2026-10-15', jointCash: false, confidence }];
    i.plan.savingsEarmarks.pools[1].goalRefs = [{ kind: 'yearly-bill', id: 'annual' }];
    assert.ok(i.plan.savingsEarmarks.allocationPolicy, 'fixture: S1 seam installed');
    return F.recommend(i.plan, i.asOf, { ...i.opts, debts: [], weeklyVariable: 0 }).payPeriodViews.filter(v => v.role !== 'lookback');
  };
  const known = run1('confirmed'), unknown = run1('unknown');
  assert.equal(unknown[0].plannedPeriodCloseTrust, 'unknown', 'the active display is still unknown');
  assert.equal(c(unknown[1].opening), c(known[1].opening), 'fixture: the seeded opening does not depend on the provision');
  assert.equal(c(unknown[1].plannedPeriodClose), c(known[1].plannedPeriodClose));
  assert.equal(unknown[1].plannedPeriodCloseTrust, 'calculated', 'independent seam is not poisoned');
});

// ---- Carry-trust redesign proof matrix (Muse 6535162602; Atlas 6535096443).
// Each carry branch derives the next opening's provenance from the inputs
// that carry actually uses. Invented values, literal cents.

// Noncombined active carry, with and without the account split. A one-time
// 120 bill on 2026-10-10 (active, after as-of) is the only contributing term.
function noncombined(confidence, breakdown) {
  const p = plan();
  p.startingCash.breakdown = breakdown;
  p.bills = [{ id: 'once', label: 'Synthetic one-time bill', frequency: 'yearly', month: 10, day: 10,
    firstDue: '2026-10-10', amount: 120, confidence }];
  return periods(F.recommend(p, ASOF, { weeklyVariable: 0, debts: [], currentPeriodActuals: actuals(false) }));
}
const SINGLE = [{ id: 'chequing-a', value: 500 }];
const SPLIT = [{ id: 'chequing-a', value: 300 }, { id: 'chequing-b', value: 200 }];

for (const [label, breakdown, nextOpening] of [['pooled opening', SINGLE, 138000], ['account split', SPLIT, 118000]]) {
  test(`noncombined carry (${label}): confirmed control carries calculated; a zero carry stays calculated`, () => {
    const [active, next, after] = noncombined('confirmed', breakdown);
    assert.equal(c(active.plannedPeriodClose), 138000); // 500 + 1000 - 120
    assert.equal(c(next.opening), nextOpening, 'split retains only the Bills stock (1380 - (500 - 300))');
    assert.equal(c(next.plannedPeriodClose), nextOpening + 100000);
    assert.equal(c(after.opening), 0, 'positive remainder sweeps; carry is zero');
    assert.equal(c(after.plannedPeriodClose), 100000);
    for (const p of [active, next, after]) assert.equal(p.plannedPeriodCloseTrust, 'calculated', p.start);
  });
  test(`noncombined carry (${label}): an estimated active term carries estimated, through a zero carry too`, () => {
    const [active, next, after] = noncombined('estimated', breakdown);
    assert.equal(active.plannedPeriodCloseTrust, 'estimated');
    assert.equal(next.plannedPeriodCloseTrust, 'estimated');
    assert.equal(c(after.opening), 0);
    assert.equal(after.plannedPeriodCloseTrust, 'estimated', 'sign-sensitive: a computed zero carry is not proof of independence');
    assert.match(after.plannedPeriodCloseReason, /is estimated/);
  });
  test(`noncombined carry (${label}): an unknown-confidence active term keeps dependent closes unknown`, () => {
    const [active, next, after] = noncombined('unknown', breakdown);
    assert.equal(active.plannedPeriodClose, null);
    assert.equal(c(next.opening), nextOpening, 'fixture: a finite carry still seeds the next opening');
    for (const p of [next, after]) {
      assert.equal(p.plannedPeriodClose, null, p.start);
      assert.equal(p.plannedPeriodCloseTrust, 'unknown');
      assert.match(p.plannedPeriodCloseReason, /opening it carries from, has unavailable trust/);
    }
  });
}

// S1 observed-Bills seed: provenance follows the seed's own selectors. This
// pins the pre-review under-carry example: a non-Savings yearly bill due in
// the active window after as-of is subtracted by the seed.
function s1Seed(mutate) {
  const { ledger } = require('./fixtures/chronological-savings-data');
  const { advance } = require('./fixtures/savings-daily-allocation-contract');
  const i = advance(ledger(), '2026-10-10');
  i.plan.income[0].anchor = '2026-08-14';
  i.plan.income = i.plan.income.map(row => ({ ...row, confidence: 'confirmed' }));
  i.plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 80 };
  i.plan.opening.representedEvents = [];
  i.opts.currentPeriodActuals.coverageStart = '2026-10-09';
  i.opts.currentPeriodActuals.savingsFetchCoverage.startDate = '2026-10-09';
  i.plan.bills = [];
  mutate(i);
  assert.ok(i.plan.savingsEarmarks.allocationPolicy, 'fixture: S1 seam installed');
  return F.recommend(i.plan, i.asOf, { ...i.opts, debts: [], weeklyVariable: 0 }).payPeriodViews.filter(v => v.role !== 'lookback');
}
const yearlyBill = (confidence, amount = 300) => i => {
  i.plan.bills = [{ id: 'oneoff', label: 'Synthetic yearly bill', amount, frequency: 'yearly',
    month: 10, day: 15, firstDue: '2026-10-15', confidence }];
};

test('S1 seed, confirmed control: the seeded next close is calculated (literal values)', () => {
  const [active, next, after] = s1Seed(yearlyBill('confirmed'));
  assert.equal(c(active.plannedPeriodClose), -22000); // 80 - 300
  assert.equal(c(next.opening), -22000, 'seeded from current Bills less the remaining bill');
  assert.equal(c(next.plannedPeriodClose), -14300);   // -220 + 77 receipt
  assert.equal(c(after.plannedPeriodClose), -14300);  // the deficit carries in full, zero sweep
  for (const p of [active, next, after]) assert.equal(p.plannedPeriodCloseTrust, 'calculated', p.start);
});

test('S1 seed, estimated remaining bill: the seeded later closes are estimated', () => {
  const [active, next, after] = s1Seed(yearlyBill('estimated'));
  assert.equal(active.plannedPeriodCloseTrust, 'estimated');
  assert.equal(next.plannedPeriodCloseTrust, 'estimated');
  assert.equal(after.plannedPeriodCloseTrust, 'estimated');
});

test('S1 seed, unknown-confidence remaining bill: the seeded later closes are unknown, never calculated', () => {
  for (const [amount, opening] of [[300, -22000], [600, -52000]]) {
    const [active, next, after] = s1Seed(yearlyBill('unknown', amount));
    assert.equal(active.plannedPeriodClose, null);
    assert.equal(c(next.opening), opening, 'fixture: the seeded opening moves with the bill (a real dependency)');
    for (const p of [next, after]) {
      assert.equal(p.plannedPeriodClose, null, `${p.start} (bill ${amount})`);
      assert.equal(p.plannedPeriodCloseTrust, 'unknown');
    }
  }
});

test('S1 seed, estimated remaining receipt: the seeded close is never published as calculated', () => {
  // The selected in-window receipt is a seed input. Its cancellation against
  // the boundary credit is not established from the same component, so it
  // stays a dependency (estimated), never calculated.
  const [active, next] = s1Seed(i => i.plan.income.push({ id: 'gift2', label: 'Invented receipt',
    frequency: 'once', date: '2026-10-20', amount: 50, confidence: 'estimated' }));
  assert.equal(active.plannedPeriodCloseTrust, 'estimated');
  assert.equal(next.plannedPeriodCloseTrust, 'estimated');
});

// Null carry with a fallback opening. This pins the pre-review over-carry
// example: a mid-period cutover opening (no payday snapshot) leaves the
// active close unknown and its carry null; the next opening comes from the
// cutover-walk fallback. No stale active provenance attaches. The fallback
// has no established trust of its own, so the close discloses that.
test('null carry, cutover-walk fallback: no stale provenance; the fallback discloses its own unestablished trust', () => {
  const p = { ...plan(), opening: { asOf: ASOF }, startingCash: { amount: 500 } };
  const [active, next, after] = periods(F.recommend(p, ASOF, { weeklyVariable: 0, debts: [] }));
  assert.equal(active.plannedPeriodClose, null);
  assert.match(active.plannedPeriodCloseReason, /opening or a deduction is not known/);
  assert.equal(next.openingSource, 'cutover-walk');
  assert.equal(c(next.opening), 500, 'fixture: the incumbent cutover walk publishes its 5.00 start-of-day opening, unchanged');
  assert.equal(next.plannedPeriodClose, null);
  assert.match(next.plannedPeriodCloseReason, /fallback cash walk whose trust is not established/);
  assert.doesNotMatch(next.plannedPeriodCloseReason, /carries from/, 'no stale carry provenance');
  assert.equal(after.plannedPeriodClose, null, 'a carry from an unqualified fallback stays unknown');
  assert.equal(after.plannedPeriodCloseTrust, 'unknown');
});

// ---- Pre-review findings on the redesign (B1-B4), literal values.

// B3: the close and its carry add only incomeAdded. A receipt already inside
// the payday-morning opening is not a term and must not taint.
test('income already inside the opening does not taint the close or its carry', () => {
  for (const confidence of ['estimated', 'unknown']) {
    const p = { ...plan(), opening: { asOf: '2026-10-02', representedEvents: [{ id: 'payroll', date: '2026-10-02' },
      { id: 'gift', date: '2026-10-02' }] }, startingCash: { breakdown: [{ id: 'chequing-a', value: 1600 }, { id: 'chequing-b', value: 0 }] } };
    p.income.push({ id: 'gift', frequency: 'once', date: '2026-10-02', amount: 100, confidence });
    const [active, next, after] = periods(F.recommend(p, '2026-10-02', { weeklyVariable: 0, debts: [] }));
    assert.equal(c(active.plannedPeriodClose), 160000, `${confidence}: opening 1600, nothing added`);
    assert.equal(c(next.plannedPeriodClose), 248000); // 1600 + 1000 - 120
    assert.equal(c(after.plannedPeriodClose), 100000);
    for (const v of [active, next, after]) assert.equal(v.plannedPeriodCloseTrust, 'calculated', `${confidence} ${v.start}`);
  }
});

// B2: a pooled active opening read from startingCash takes that row's
// qualification; after the account split only the retained Bills stock does.
test('pooled startingCash opening: an estimated or unknown row qualifies the close and its carry', () => {
  const run1 = tags => {
    const p = { ...plan(), opening: { asOf: '2026-10-02', representedEvents: [{ id: 'payroll', date: '2026-10-02' }] },
      startingCash: { breakdown: [{ id: 'chequing-a', value: 1500, ...tags }, { id: 'chequing-b', value: 0 }] } };
    return periods(F.recommend(p, '2026-10-02', { weeklyVariable: 0, debts: [] }));
  };
  const [a0, n0] = run1({});
  assert.deepEqual([c(a0.plannedPeriodClose), a0.plannedPeriodCloseTrust, c(n0.plannedPeriodClose), n0.plannedPeriodCloseTrust],
    [150000, 'calculated', 238000, 'calculated']);
  const [a1, n1] = run1({ confidence: 'estimated' });
  assert.deepEqual([a1.plannedPeriodCloseTrust, n1.plannedPeriodCloseTrust], ['estimated', 'estimated']);
  const [a2, n2] = run1({ unknown: true });
  assert.deepEqual([a2.plannedPeriodClose, n2.plannedPeriodClose], [null, null]);
});

test('account split: the retained Bills stock qualifies the carry; the replaced account does not taint it', () => {
  const run1 = breakdown => noncombined('confirmed', breakdown);
  const [, bEst, bEstAfter] = run1([{ id: 'chequing-a', value: 300, confidence: 'estimated' }, { id: 'chequing-b', value: 200 }]);
  assert.equal(c(bEst.opening), 118000);
  assert.deepEqual([bEst.plannedPeriodCloseTrust, bEstAfter.plannedPeriodCloseTrust], ['estimated', 'estimated']);
  const [, bUnk] = run1([{ id: 'chequing-a', value: 300, unknown: true }, { id: 'chequing-b', value: 200 }]);
  assert.equal(bUnk.plannedPeriodClose, null);
  assert.equal(bUnk.plannedPeriodCloseTrust, 'unknown');
  const [, other, otherAfter] = run1([{ id: 'chequing-a', value: 300 }, { id: 'chequing-b', value: 200, confidence: 'estimated' }]);
  assert.equal(c(other.plannedPeriodClose), 218000);
  assert.deepEqual([other.plannedPeriodCloseTrust, otherAfter.plannedPeriodCloseTrust], ['calculated', 'calculated'],
    'the split replaces the pooled component; the other account is not used');
});

// B1: the S1 boundary credit moves with the active native surplus, so an
// estimated bill already paid before as-of (outside the seed's remaining
// bills) still reaches the seeded close. The planned amount moves the next
// opening (1000 -> 1050): a real dependency, never calculated.
test('S1 boundary credit: an estimated paid bill reaches the seeded close through the credit', () => {
  const ownerModel = require('./fixtures/savings-owner-closing-data');
  const run1 = (confidence, planned) => {
    const x = ownerModel(1000);
    x.plan.income.push({ id: 'current-gift', label: 'Invented', frequency: 'once', date: '2026-10-04', amount: 1000, confidence: 'confirmed' });
    x.opts.currentPeriodActuals.representedActuals.push({ id: 'current-gift', date: '2026-10-04', actual: 1000, transactionId: 'current-income' });
    x.opts.currentPeriodActuals.transactions.push({ id: 'current-income', date: '2026-10-04', amount: -1000, currency: 'CAD', pending: false,
      isIncome: true, incomeId: 'current-gift', savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a',
      accountRole: 'household-cash', displayedPayee: 'Invented' });
    x.plan.startingCash.breakdown[0].value += 1000;
    x.plan.bills = [{ id: 'paid-bill', label: 'Invented paid bill', frequency: 'yearly', month: 10, day: 5,
      firstDue: '2026-10-05', amount: planned, confidence }];
    x.opts.currentPeriodActuals.representedActuals.push({ id: 'paid-bill', date: '2026-10-05', actual: 100, transactionId: 'bill-tx' });
    x.opts.currentPeriodActuals.transactions.push({ id: 'bill-tx', date: '2026-10-05', amount: 100, currency: 'CAD', pending: false,
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a', accountRole: 'household-cash', displayedPayee: 'Invented' });
    x.plan.startingCash.breakdown[0].value -= 100;
    return F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] }).payPeriodViews.filter(v => v.role !== 'lookback');
  };
  const [, ctl] = run1('confirmed', 100);
  assert.deepEqual([c(ctl.opening), c(ctl.plannedPeriodClose), ctl.plannedPeriodCloseTrust], [100000, 140000, 'calculated']);
  const [, e100] = run1('estimated', 100), [, e150] = run1('estimated', 150);
  assert.deepEqual([c(e100.opening), c(e150.opening)], [100000, 105000], 'fixture: the seed moves with the planned amount');
  assert.deepEqual([e100.plannedPeriodCloseTrust, e150.plannedPeriodCloseTrust], ['estimated', 'estimated']);
  assert.equal(c(e150.plannedPeriodClose), 145000);
});

// B4: exactly restored goal rows. An estimated goal bill makes its own
// period estimated; its overlap restoration cancels its deduction, so the
// next opening equals the confirmed control and stays calculated.
test('exactly restored goal bill: the current-period (S1 seed + credit) restoration does not taint later closes', () => {
  const ownerModel = require('./fixtures/savings-owner-closing-data');
  const run1 = confidence => {
    const x = ownerModel(); x.plan.commitments = [];
    x.plan.savingsPoolObservation.accounts[0].value = 1000; x.plan.startingCash.breakdown[2].value = 1000;
    x.plan.bills = [{ id: 'a', label: 'Invented current annual goal', frequency: 'yearly', month: 10, day: 10,
      firstDue: '2026-10-10', amount: 500, confidence, jointCash: false }];
    return F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] }).payPeriodViews.filter(v => v.role !== 'lookback');
  };
  const ctl = run1('confirmed'), est = run1('estimated');
  assert.equal(c(est[0].plannedPeriodClose), -42000);
  assert.equal(est[0].plannedPeriodCloseTrust, 'estimated', 'the goal bill is a term of its own period');
  for (const n of [1, 2]) {
    assert.equal(c(est[n].opening), c(ctl[n].opening), `${est[n].start}: restored exactly`);
    assert.equal(c(est[n].plannedPeriodClose), c(ctl[n].plannedPeriodClose));
    assert.equal(est[n].plannedPeriodCloseTrust, 'calculated');
  }
  assert.deepEqual([c(est[1].plannedPeriodClose), c(est[2].plannedPeriodClose)], [48000, 40000]);
});

test('exactly restored goal bill: the future-carry restoration does not taint the next close', () => {
  const ownerModel = require('./fixtures/savings-owner-closing-data');
  const run1 = confidence => {
    const y = ownerModel(); y.plan.commitments.shift();
    y.plan.bills = [{ id: 'a', label: 'Invented annual goal', frequency: 'yearly', month: 10, day: 21,
      firstDue: '2026-10-21', amount: 500, confidence, jointCash: false }];
    return F.recommend(y.plan, y.asOf, { ...y.opts, weeklyVariable: 0, debts: [] }).payPeriodViews.filter(v => v.role !== 'lookback');
  };
  const ctl = run1('confirmed'), est = run1('estimated');
  assert.equal(c(est[1].plannedPeriodClose), -2000);
  assert.equal(est[1].plannedPeriodCloseTrust, 'estimated');
  assert.equal(c(est[2].opening), c(ctl[2].opening));
  assert.equal(c(est[2].plannedPeriodClose), 40000);
  assert.equal(est[2].plannedPeriodCloseTrust, 'calculated', 'restored exactly; not a carry dependency');
});

// B4: future-carry income. An estimated receipt in the first future period
// only; a large bill makes that period's remainder negative, so the deficit
// carries in full into the next opening, which must keep the estimate.
test('future carry: an estimated receipt reaches the next close through a negative carry', () => {
  const run1 = confidence => {
    const p = plan();
    p.income.push({ id: 'gift', frequency: 'once', date: '2026-10-20', amount: 50, confidence });
    p.bills = [{ id: 'big', label: 'Synthetic large bill', frequency: 'yearly', month: 10, day: 22,
      firstDue: '2026-10-22', amount: 3000, confidence: 'confirmed' }];
    return periods(F.recommend(p, ASOF, { weeklyVariable: 0, debts: [] }));
  };
  const [, n0, a0] = run1('confirmed');
  assert.deepEqual([c(n0.plannedPeriodClose), c(a0.opening), c(a0.plannedPeriodClose), a0.plannedPeriodCloseTrust],
    [-45000, -45000, 55000, 'calculated']); // 1500 + 1000 + 50 - 3000; then -450 + 1000
  const [, n1, a1] = run1('estimated');
  assert.equal(n1.plannedPeriodCloseTrust, 'estimated');
  assert.equal(a1.plannedPeriodCloseTrust, 'estimated', 'the carry depends on the estimated receipt');
});

// Re-pre-review of 499b8462: the future-carry budget term is live. A dated
// retired reserve covers 10-16 only, so 10-30's own budget is calculated and
// it inherits the estimate solely through the carry (the deficit carries in
// full). Invented: 500 opening; 1000 pay; 3000 bill on the 20th.
test('future carry: an estimated budget reserve in one period reaches the next close only through the carry', () => {
  const run1 = targetHistory => {
    const p = { ...plan(), opening: { asOf: '2026-10-02', representedEvents: [{ id: 'payroll', date: '2026-10-02' }] },
      startingCash: { breakdown: [{ id: 'chequing-a', value: 500 }, { id: 'chequing-b', value: 0 }] },
      bills: [{ id: 'b1', label: 'Synthetic bill', frequency: 'monthly', day: 20, amount: 3000, confidence: 'confirmed' }],
      budget: { categories: [{ id: 'other-spend', label: 'Other', targetHistory }] } };
    return periods(F.recommend(p, '2026-10-02', { weeklyVariable: 0, debts: [] }));
  };
  const [, c16, c30] = run1([]);
  assert.deepEqual([c(c16.plannedPeriodClose), c(c30.plannedPeriodClose), c30.plannedPeriodCloseTrust],
    [-150000, -50000, 'calculated']);
  const [, r16, r30] = run1([{ effectiveThrough: '2026-10-16', futurePayPeriodReserve: 100 }]);
  assert.deepEqual([r16.budgetHold, r16.budgetHoldTrust, c(r16.plannedPeriodClose), r16.plannedPeriodCloseTrust],
    [100, 'estimated', -160000, 'estimated']); // 500 + 1000 - 3000 - 100
  assert.equal(r30.budgetHold, 0);
  assert.notEqual(r30.budgetHoldTrust, 'estimated', 'fixture: the next period budget is not itself estimated');
  assert.equal(c(r30.opening), -160000, 'the deficit carries in full');
  assert.equal(c(r30.plannedPeriodClose), -60000);
  assert.equal(r30.plannedPeriodCloseTrust, 'estimated', 'inherited through the carry budget term');
});
