'use strict';
// Forecast fields an exact-main (frozen engine) comparison cannot see,
// because main predates them. Each is PROVED in its empty state on the
// invented input first, then removed from the current-engine side, so the
// comparison still covers every other field. A comparison input that
// carries saved closes would fail the proof loudly instead of hiding a move.
//
//   categorySpendingTrends (Forecast.categorySpendingTrends, #1384): with no
//   qualifying saved close, no trend is published.
//   stackSummary (Stack Wallet, every pay period, set last by publishStackSummary):
//   income (A1) proves its three lines sum to the period's incomeTotal to the
//   cent and its total copies incomeTotal / incomeTrust, or that every line is
//   null and unavailable when incomeTotal is withheld. A later key (A6
//   cards) adds its own proof here before it is stripped.
//     bills (A2): the bill total split into mortgage, card minimums and
//     other, proved to sum to the period's periodBillLoad, or every part
//     null and unavailable;
//     surplus (A2): income − other bills − household − mortgage − credit −
//     item spending, proved against its own terms and the bills split here,
//     and on unmodified output to equal Balance After Deductions plus its
//     held outflows and card payments beyond the minimum;
//     savings (A5): each goal's planned amount beside what moved, proved by
//     proveStackSavings below.
//     credit and creditBreakdown (desk ruling (E), #1573): the view's card-target publication
//     and the waterfall's Credit rows, proved by proveStackCredit below.
//   reconMatchesSpent (budget rows): whether a row's listed transactions
//   reconcile to its Spent to the cent, proved by withoutReconMatchesSpent.
//   billHistory (Stack Wallet bill sheet): each bill's past and current
//   occurrences, proved against the published bill rows by proveBillHistory.
//   stackBillPart / stackBillAmount / stackBillDebtId (Stack Wallet bill
//   cards): each counted bill row's place in its period's bills split, proved
//   by proveStackBillParts: the marked rows of each part add up, in cents,
//   to that part of the published split; a withheld split marks no row.
//   paidState (Stack Wallet A3, Forecast.billPaidState): each published bill
//   row's Paid / Not paid word. Presentation only; proved one of its three
//   words, then removed wherever a published row carries it.
const assert = require('node:assert/strict');

const finite = v => typeof v === 'number' && Number.isFinite(v);
// The comparisons that call this may already have normalised a period's
// other figures (restored a frozen engine's numbers), so the proof here is
// the surplus's own: its amount is exactly its published terms, its trust a
// published value, and a withheld surplus lists no terms. The identity with
// the period's published Balance After Deductions (surplus = BAD + held +
// beyond the minimum) is proved on unmodified output in
// test/test-stack-summary-surplus.js.
const cents = v => Math.round(v * 100);
function proveStackBills(view, bills) {
  assert.ok(bills && typeof bills === 'object', 'authorized addition: stackSummary.bills is published');
  if (bills.other === null) {
    assert.ok(bills.mortgage === null && bills.cardMinimums === null && bills.trust === 'unavailable' && typeof bills.reason === 'string',
      'authorized addition: a withheld bills split is null throughout, unavailable, with a reason');
    return;
  }
  assert.ok(finite(bills.mortgage) && finite(bills.other) && Array.isArray(bills.cardMinimums)
    && bills.cardMinimums.every(card => card && typeof card.debtId === 'string' && finite(card.amount)),
    'authorized addition: a published bills split lists its parts');
  assert.ok(['calculated', 'estimated'].includes(bills.trust), 'authorized addition: a published bills split is calculated or estimated');
}
const STACK_BILL_MARKS = ['stackBillPart', 'stackBillAmount', 'stackBillDebtId', 'stackBillPaymentEvidence', 'stackBillAmountTrust', 'stackBillPaid'];
const STACK_BILL_PARTS = new Set(['mortgage', 'cardMinimum', 'other']);
const STACK_BILL_EVIDENCE = new Set(['posted-equal', 'posted-differs', 'posted-verified', 'pending', 'none']);
// The evidence the page's paid check shows (Forecast stackBillPaidEvidence).
const STACK_BILL_PAID_EVIDENCE = new Set(['posted-equal', 'posted-verified']);
function proveStackBillParts(view, bills) {
  const rows = Array.isArray(view.bills) ? view.bills : [];
  const marked = rows.filter(row => row && STACK_BILL_MARKS.some(key => Object.hasOwn(row, key)));
  if (bills.other === null) assert.equal(marked.length, 0, 'authorized addition: a withheld bills split marks no bill row');
  for (const row of marked) {
    assert.ok(STACK_BILL_PARTS.has(row.stackBillPart) && finite(row.stackBillAmount), 'authorized addition: a marked bill row names its part and amount');
    assert.equal(Object.hasOwn(row, 'stackBillDebtId'), row.stackBillPart === 'cardMinimum', 'authorized addition: only a card minimum names its line');
    assert.ok(STACK_BILL_EVIDENCE.has(row.stackBillPaymentEvidence), 'authorized addition: a marked row names its payment evidence');
    if (['posted-equal', 'posted-differs', 'posted-verified'].includes(row.stackBillPaymentEvidence)) {
      assert.equal(row.displayAmountBasis, 'posted-actual', 'authorized addition: posted evidence only on a posted payment');
      const plan = row.planned != null && Number.isFinite(Number(row.planned)) ? Number(row.planned) : Number(row.amount);
      const posted = cents(Math.abs(row.actual));
      const verified = row.billPaymentVerified === true;
      // Grok Bot's "bill verified" note: verified exactly where the row carries the stamp and the posted payment is
      // the counted amount; otherwise posted-equal exactly where it is both the planned and the counted amount.
      assert.equal(verified && posted === cents(row.stackBillAmount), row.stackBillPaymentEvidence === 'posted-verified',
        'authorized addition: posted-verified exactly where a verified posted payment is the counted amount');
      assert.equal(!verified && posted === cents(row.stackBillAmount) && posted === cents(Math.abs(plan)), row.stackBillPaymentEvidence === 'posted-equal',
        'authorized addition: posted-equal exactly where an unverified posted payment is both the planned and the counted amount');
    }
    assert.ok(!Object.hasOwn(row, 'billPaymentVerified') || (row.billPaymentVerified === true && row.displayAmountBasis === 'posted-actual'),
      'authorized addition: only a posted payment carries the verified stamp');
    if (Object.hasOwn(row, 'stackBillAmountTrust')) assert.ok(['calculated', 'estimated', 'unknown'].includes(row.stackBillAmountTrust), 'authorized addition: a marked amount\'s trust is a trust word');
  }
  if (marked.length) {
    const sum = list => list.reduce((total, row) => total + cents(row.stackBillAmount), 0);
    assert.equal(sum(marked.filter(row => row.stackBillPart === 'other')), cents(bills.other), 'authorized addition: the other rows add up to bills.other');
    assert.equal(sum(marked.filter(row => row.stackBillPart === 'mortgage')), cents(bills.mortgage), 'authorized addition: the mortgage rows add up to bills.mortgage');
    const lines = new Map(bills.cardMinimums.map(card => [card.debtId, cents(card.amount)]));
    const byLine = new Map();
    for (const row of marked.filter(r => r.stackBillPart === 'cardMinimum')) byLine.set(row.stackBillDebtId, (byLine.get(row.stackBillDebtId) || 0) + cents(row.stackBillAmount));
    assert.deepEqual([...byLine].sort(), [...lines].sort(), 'authorized addition: each line\'s minimum rows add up to its cardMinimums amount');
  }
  // stackSummary.bills.paid (Dale, 2026-11-20 "bills needs the paid/owed"): the
  // Bills part's checked rows (stackBillPaid, from the payment evidence),
  // summed in cents; 0 and calculated with none checked; withheld (null,
  // unavailable, a reason) when the split or a paid row's trust is unpublished.
  for (const row of marked) assert.equal(row.stackBillPaid, STACK_BILL_PAID_EVIDENCE.has(row.stackBillPaymentEvidence),
    'authorized addition: a row is checked paid exactly where its payment evidence confirms it');
  const paidRows = marked.filter(row => row.stackBillPart === 'other' && row.stackBillPaid);
  // Paid needs the period's ledger read: outside a later period, Budget's own actuals gate must be complete.
  const progress = view.budgetProgress;
  if (!(progress && (progress.role === 'future' || (progress.coverage && progress.coverage.complete === true)))) {
    assert.equal(bills.paid, null, 'authorized addition: Bills paid is withheld where the period\'s posted evidence is not complete');
  }
  if (bills.paid === null) {
    assert.ok(bills.paidTrust === 'unavailable' && typeof bills.paidReason === 'string', 'authorized addition: a withheld Bills paid is unavailable, with a reason');
  } else {
    assert.equal(cents(bills.paid), paidRows.reduce((total, row) => total + cents(row.stackBillAmount), 0),
      'authorized addition: Bills paid is the sum of the checked Bills rows');
    const rank = { calculated: 0, estimated: 1 };
    assert.equal(bills.paidTrust, paidRows.length
      ? paidRows.reduce((worst, row) => rank[row.stackBillAmountTrust] > rank[worst] ? row.stackBillAmountTrust : worst, 'calculated')
      : bills.trust,
      'authorized addition: Bills paid carries the weakest trust of its rows (the split\'s own trust with none)');
  }
  for (const row of marked) for (const key of STACK_BILL_MARKS) delete row[key];
}
function proveStackSurplus(view, surplus, bills) {
  assert.ok(surplus && typeof surplus === 'object', 'authorized addition: stackSummary.surplus is published');
  assert.equal(typeof surplus.projected, 'boolean', 'authorized addition: surplus.projected is a flag');
  if (surplus.amount === null) {
    assert.equal(surplus.terms, null, 'authorized addition: a withheld surplus lists no terms');
    assert.equal(surplus.trust, 'unavailable', 'authorized addition: a withheld surplus reads unavailable');
    assert.equal(typeof surplus.reason, 'string', 'authorized addition: a withheld surplus says why');
    return;
  }
  const t = surplus.terms;
  assert.ok(t && finite(t.income) && finite(t.bills) && finite(t.household) && finite(t.mortgage) && finite(t.credit),
    'authorized addition: a published surplus lists its terms');
  // Desk ruling (E) (#1573): where a Credit breakdown is published, the credit term is its total (the targets less what is
  // already counted above); otherwise the minimums of the bills split, as before.
  const breakdown = view.stackSummary && view.stackSummary.creditBreakdown;
  const creditCents = breakdown ? cents(breakdown.total) : bills.cardMinimums.reduce((sum, card) => sum + cents(card.amount), 0);
  assert.ok(bills.other === t.bills && bills.mortgage === t.mortgage && creditCents === cents(t.credit),
    'authorized addition: the surplus\'s bills and mortgage terms are the bills split, and its credit term the Credit breakdown (else the minimums)');
  const item = finite(t.savingsItemSpending) ? t.savingsItemSpending : 0;
  assert.equal(cents(surplus.amount), cents(t.income) - cents(t.bills) - cents(t.household) - cents(t.mortgage) - cents(t.credit) - cents(item),
    'authorized addition: surplus = income - bills - household - mortgage - credit - item spending, its own terms');
  assert.ok(['calculated', 'estimated'].includes(surplus.trust), 'authorized addition: a published surplus is calculated or estimated');
}

// stackSummary.credit (desk ruling (E), #1573): the view's one card-target publication (Forecast.stackCreditLines), each line
// with its target and its deduction; creditBreakdown: the waterfall's Credit rows, proved to sum to the credit term.
function proveStackCredit(view, credit, breakdown, surplus) {
  if (credit !== null) {
    assert.ok(credit && Array.isArray(credit.lines) && credit.totals, 'authorized addition: stackSummary.credit lists lines and totals');
    for (const line of credit.lines) {
      assert.ok(line.target && line.deduction, 'authorized addition: each Credit line carries its target and deduction');
      if (line.deduction.amount !== null) assert.ok(line.deduction.amount >= 0, 'authorized addition: a deduction is never negative');
      else assert.equal(line.deduction.trust, 'unavailable', 'authorized addition: a withheld deduction reads unavailable');
      // OD-033: Still to pay back = max(0, target − paid back), unknown when either is; targetCovered = paid back ≥ a target
      // above $0. Worked here from the line's own published target and paidToward.
      // Paid back is paidToward qualified for display: never negative (withheld instead), else paidToward itself.
      assert.ok(line.paidBack && (line.paidBack.amount === null || (line.paidBack.amount >= 0 && line.paidBack.amount === line.paidToward.amount)),
        'authorized addition: Paid back is never negative, and where published it is the line\'s paidToward');
      const t = line.target.amount, w = line.paidBack.amount;
      assert.ok(line.stillToPayBack && line.targetCovered, 'authorized addition: each Credit line carries stillToPayBack and targetCovered');
      if (t === null || w === null) {
        assert.ok(line.stillToPayBack.amount === null && line.targetCovered.value === 'unknown', 'authorized addition: an unknown side leaves Still to pay back unknown, never $0');
      } else {
        assert.equal(cents(line.stillToPayBack.amount), Math.max(0, cents(t) - cents(w)), 'authorized addition: Still to pay back is target − paid back, floored at 0');
        assert.ok(line.stillToPayBack.amount <= t, 'authorized addition: Still to pay back never exceeds the target');
        assert.equal(line.targetCovered.value, cents(t) > 0 && cents(w) >= cents(t), 'authorized addition: targetCovered is paid back ≥ a target above $0');
      }
      // The deduction's two published parts close it per line, so no reader needs the totals to show them.
      if (line.deduction.amount !== null) assert.equal(cents(line.target.amount) - cents(line.deduction.countedOffset) - cents(line.deduction.beyondNetted),
        cents(line.deduction.amount), 'authorized addition: target − countedOffset − beyondNetted is the deduction, per line');
    }
    // OD-052: the Credit head's totals, worked here from the lines: Σ paid back and Σ target over every line (the HELOC
    // included), each withheld when any line's is, never a partial sum.
    const t = credit.totals;
    assert.ok(t.paidBack && t.target && t.targetCovered, 'authorized addition: the Credit totals carry paidBack, target and targetCovered');
    if (t.paidBack.amount !== null) assert.equal(cents(t.paidBack.amount), credit.lines.reduce((sum, line) => sum + cents(line.paidBack.amount), 0),
      'authorized addition: totals.paidBack is Σ each line\'s Paid back');
    else assert.equal(t.paidBack.trust, 'unavailable', 'authorized addition: a withheld paid back total reads unavailable');
    if (credit.lines.some(line => line.paidBack.amount === null)) assert.equal(t.paidBack.amount, null, 'authorized addition: a withheld line withholds totals.paidBack');
    if (credit.lines.every(line => line.target.amount !== null)) assert.equal(cents(t.target.amount), credit.lines.reduce((sum, line) => sum + cents(line.target.amount), 0),
      'authorized addition: totals.target is Σ each line\'s target');
    else assert.ok(t.target.amount === null && t.target.trust === 'unavailable', 'authorized addition: a withheld target withholds totals.target');
    if (t.targetCovered.value === true) assert.ok(credit.lines.every(line => cents(line.target.amount) === 0 || line.targetCovered.value === true),
      'authorized addition: the head is covered only when every line with a target is');
  }
  if (breakdown === null) return;
  assert.ok(breakdown && Array.isArray(breakdown.rows), 'authorized addition: a Credit breakdown lists rows');
  // No "Already counted above" row (Dale, 2026-11-24, #1617 7121410691): the breakdown publishes no catch-all and no counted row.
  assert.deepEqual(Object.keys(breakdown).sort(), ['basis', 'rows', 'stillToPayBack', 'total', 'trust'], 'authorized addition: the Credit breakdown carries only its basis, card rows, their sum, total and trust');
  assert.ok(['targets', 'minimums'].includes(breakdown.basis), 'authorized addition: the Credit term is the targets\' deduction or the minimums');
  // OD-057: the Credit line's first figure is the sum of the rows the dropdown lists, withheld when any row is.
  if (breakdown.rows.some(row => row.amount === null)) assert.ok(breakdown.stillToPayBack.amount === null && breakdown.stillToPayBack.trust === 'unavailable',
    'authorized addition: a withheld row withholds the Credit line\'s still to pay back');
  else assert.equal(cents(breakdown.stillToPayBack.amount), breakdown.rows.reduce((sum, row) => sum + cents(row.amount), 0),
    'authorized addition: the Credit line\'s still to pay back is Σ the dropdown rows');
  // Display only (OD-033; desk ruling (1)): every row is checked against the per-line figures, never against the total, so
  // a catch-all offset (the targets minus the Credit term) fails here.
  const lines = credit ? credit.lines : [];
  const byId = new Map(lines.map(line => [String(line.id), line]));
  for (const row of breakdown.rows) {
    const line = byId.get(String(row.debtId));
    if (line) assert.equal(row.amount, line.stillToPayBack.amount, 'authorized addition: a card row is that card\'s Still to pay back');
  }
  const minimums = view.stackSummary && view.stackSummary.bills && Array.isArray(view.stackSummary.bills.cardMinimums) ? view.stackSummary.bills.cardMinimums : [];
  if (breakdown.basis === 'minimums') {
    // A completed or saved period keeps its historical cash deduction: the minimums, unchanged by the rows shown.
    assert.equal(cents(breakdown.total), minimums.reduce((sum, card) => sum + cents(card.amount), 0),
      'authorized addition: a completed period\'s Credit total is its card minimums');
  } else if (credit) {
    const unlined = minimums.filter(card => !byId.has(String(card.debtId))).reduce((sum, card) => sum + cents(card.amount), 0);
    if (lines.every(line => line.deduction.amount !== null)) assert.equal(lines.reduce((sum, line) => sum + cents(line.deduction.amount), 0) + unlined,
      cents(breakdown.total), 'authorized addition: the Credit total is Σ each line\'s deduction (and any unlined minimum), unchanged');
  }
  if (surplus && surplus.amount !== null) assert.equal(cents(surplus.terms.credit), cents(breakdown.total),
    'authorized addition: the breakdown total is the surplus\'s credit term');
}

const INCOME_LINES = ['dale', 'amanda', 'other'];
function proveStackIncome(view, income) {
  if (view.capturedClose && typeof view.incomeTotal === 'number') {
    // A saved close: its total stands as saved; the lines are withheld (the archive keeps no income class).
    assert.equal(income.total.amount, view.incomeTotal, 'authorized addition: a saved close keeps its income total');
    for (const k of INCOME_LINES) {
      assert.equal(income[k].amount, null, 'authorized addition: a saved close withholds the income lines');
      assert.equal(income[k].trust, 'unavailable', 'authorized addition: a withheld line reads unavailable');
    }
  } else if (typeof view.incomeTotal === 'number') {
    const cents = INCOME_LINES.reduce((c, k) => c + Math.round(income[k].amount * 100), 0);
    assert.equal(cents, Math.round(view.incomeTotal * 100), 'authorized addition: stackSummary.income sums to incomeTotal');
    assert.equal(income.total.amount, view.incomeTotal, 'authorized addition: stackSummary.income.total is incomeTotal');
  } else {
    for (const k of [...INCOME_LINES, 'total']) {
      assert.equal(income[k].amount, null, 'authorized addition: a withheld incomeTotal withholds stackSummary.income');
      assert.equal(income[k].trust, 'unavailable', 'authorized addition: a withheld line reads unavailable');
    }
  }
}
// Stack Savings (owner rule, Dale 2026-11-20): the savings balance poured into
// the goals nearest due first, on the current and next periods only (null on
// every other). Each goal's saved is between 0 and its needed, both published
// or both null with trust unavailable; the head is the goals summed, and
// saved + unallocated is the balance (at most it, once items have left);
// reasons come from the closed set.
const SAVINGS_REASONS = new Set(['owner-rule:balance-poured-nearest-due-first', 'balance-current', 'balance-dated', 'balance-carried',
  'balance-unavailable', 'balance-negative', 'rows-items-mismatch', 'pour-stopped-at-unknown-need', 'no-savings-items',
  'items-due-this-period-left', 'period-bounds-unknown']);
const isFigure = v => typeof v === 'number' && Number.isFinite(v);
function proveStackSavings(view, savings) {
  if (!['current', 'next'].includes(view.timelineRole)) {
    assert.equal(savings, null, 'authorized addition: only the current and next periods publish stackSummary.savings');
    return;
  }
  assert.ok(savings && Array.isArray(savings.items) && savings.totals, 'authorized addition: stackSummary.savings lists items and totals');
  for (const item of savings.items) {
    assert.ok(item.saved === null ? item.needed === null && item.trust === 'unavailable'
      : isFigure(item.saved) && isFigure(item.needed) && item.saved >= 0 && item.saved <= item.needed && ['calculated', 'estimated'].includes(item.trust),
    'authorized addition: a goal\'s saved is between 0 and its needed with a trust word, or both null and unavailable');
  }
  const t = savings.totals;
  if (t.saved !== null) {
    const cents = v => Math.round(v * 100);
    assert.equal(cents(t.saved), savings.items.reduce((c, item) => c + cents(item.saved), 0), 'authorized addition: the head\'s saved is the goals summed');
    assert.equal(cents(t.needed), savings.items.reduce((c, item) => c + cents(item.needed), 0), 'authorized addition: the head\'s needed is the goals summed');
    // An item that left the card this period still holds its share of the balance (lead ruling on ATLAS
    // REVIEWER 7056773000), so saved + unallocated is the balance exactly only when nothing has left; otherwise it
    // is at most the balance (the held shares are proved in test-stack-savings-summary's audit).
    if (t.reasons.includes('items-due-this-period-left')) assert.ok(cents(t.saved) + cents(t.unallocated) <= cents(t.balance),
      'authorized addition: with items that left, saved + unallocated is at most the balance');
    else assert.equal(cents(t.saved) + cents(t.unallocated), cents(t.balance), 'authorized addition: saved + unallocated is the balance');
  } else assert.ok(t.needed === null && t.unallocated === null && t.trust === 'unavailable', 'authorized addition: a withheld pour publishes no head');
  assert.ok(Array.isArray(t.reasons) && t.reasons.every(r => SAVINGS_REASONS.has(r)), 'authorized addition: savings totals reasons are closed');
}
// The Bills account card (Dale's decision on #821; lead brief #1620 7181064255): only the active view carries it; its
// reading is the Bills close's observedCash and date or nothing; its transactions list holds only the Bills account's
// own current-period ledger transactions, newest first, or null when unreadable.
const ACCOUNT_TRUST = new Set(['calculated', 'estimated', 'unavailable']);
const ACCOUNT_DIRECTION = new Set(['in', 'out']);
function proveStackBillsAccount(view, account) {
  const close = view.billsAccountPeriodBalance;
  if (view.role !== 'active' || !close || close.source !== 'Forecast.billsAccountPeriodBalance') {
    assert.equal(account, null, 'authorized addition: only the active view with a Bills close carries stackSummary.billsAccount');
    return;
  }
  const now = account.now;
  assert.ok(now.amount === null ? now.asOf === null && now.trust === 'unavailable' && typeof now.reason === 'string' && now.reason
    : now.amount === close.observedCash && now.asOf === close.observedAsOf && now.trust === 'estimated' && now.reason === null,
  'authorized addition: the Bills reading is the close\'s observedCash and date, or nothing with a reason');
  assert.deepEqual(Object.keys(account).sort(), ['now', 'reason', 'status', 'transactions'],
    'authorized addition: stackSummary.billsAccount carries only its four keys');
  if (account.status !== 'ready') {
    assert.ok(account.transactions === null && typeof account.reason === 'string' && account.reason,
      'authorized addition: a withheld card publishes no transaction list and states a reason');
    return;
  }
  assert.ok(account.reason === null && Array.isArray(account.transactions),
    'authorized addition: a ready card publishes a transaction array with no reason');
  for (let i = 0; i < account.transactions.length; i++) {
    const row = account.transactions[i];
    assert.ok(typeof row.id === 'string' && row.id && typeof row.label === 'string' && row.label
      && typeof row.date === 'string' && row.date >= close.start && row.date <= close.end
      && isFigure(row.amount) && row.amount >= 0 && ACCOUNT_DIRECTION.has(row.direction)
      && typeof row.pending === 'boolean' && ACCOUNT_TRUST.has(row.trust)
      && row.trust === (row.pending ? 'estimated' : 'calculated'),
    'authorized addition: each Bills account transaction carries id, label, period date, non-negative amount, direction, pending and trust');
    if (i > 0) assert.ok(account.transactions[i - 1].date >= row.date, 'authorized addition: Bills account transactions are newest first');
  }
}
function withoutStackSummary(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Object.hasOwn(node, 'stackSummary') && Object.hasOwn(node, 'incomeTotal')) {
    assert.deepEqual(Object.keys(node.stackSummary), ['income', 'bills', 'surplus', 'savings', 'billsAccount', 'credit', 'creditBreakdown'], 'authorized addition: stackSummary carries only proved keys');
    proveStackIncome(node, node.stackSummary.income);
    proveStackBills(node, node.stackSummary.bills);
    proveStackBillParts(node, node.stackSummary.bills);
    proveStackSurplus(node, node.stackSummary.surplus, node.stackSummary.bills);
    proveStackSavings(node, node.stackSummary.savings);
    proveStackBillsAccount(node, node.stackSummary.billsAccount);
    proveStackCredit(node, node.stackSummary.credit, node.stackSummary.creditBreakdown, node.stackSummary.surplus);
    delete node.stackSummary;
  }
  for (const value of Object.values(node)) withoutStackSummary(value, seen);
}


const PAID_STATES = new Set(['paid', 'not-paid', 'carried']);
function withoutBillPaidState(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Object.hasOwn(node, 'paidState') && Object.hasOwn(node, 'settlement')) {
    assert.ok(PAID_STATES.has(node.paidState), `authorized addition: bill paidState is one of three words (${node.paidState})`);
    delete node.paidState;
  }
  for (const value of Object.values(node)) withoutBillPaidState(value, seen);
}

// reconMatchesSpent (budget category transactions, CARDS' #1450): a boolean
// set only on a household budget row whose Spent is a number, true exactly
// when the cents of its counted recon rows (less the pending twin of a posted
// transaction) equal round(Spent x 100). Proved here by recomputing it from
// the row, then removed. Presentation only.
function withoutReconMatchesSpent(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Object.hasOwn(node, 'reconMatchesSpent') && Object.hasOwn(node, 'recon')) {
    assert.equal(typeof node.reconMatchesSpent, 'boolean', 'authorized addition: reconMatchesSpent is a boolean');
    assert.ok(typeof node.spent === 'number' && Number.isFinite(node.spent), 'authorized addition: reconMatchesSpent only beside a numeric Spent');
    const counted = (node.recon || []).filter(r => !(r && r.pendingPostedDuplicate === true && r.pending === true && r.pendingAmountEstimated !== true));
    const finite = counted.every(r => r && typeof r.amount === 'number' && Number.isFinite(r.amount));
    const cents = finite ? counted.reduce((sum, r) => sum + Math.round(r.amount * 100), 0) : null;
    assert.equal(node.reconMatchesSpent, finite && cents === Math.round(node.spent * 100),
      'authorized addition: reconMatchesSpent states whether the counted rows reconcile to Spent to the cent');
    delete node.reconMatchesSpent;
  }
  for (const value of Object.values(node)) withoutReconMatchesSpent(value, seen);
}

// billHistory (Stack Wallet, bill sheet): proved against the published bill
// rows it copies, then removed. Every entry is one published period row with
// the same id and date, never a carried copy, listed once, in date order newest
// first. Its amount follows the row's own displayAmountBasis (a linked actual
// or the scheduled amount, never mixed), with null exactly when trust is
// unavailable. Its occurrence is that row's identity. Every period's
// non-carried dated row (past, current and future) is listed. Run before withoutBillPaidState, which removes the rows' paidState.
const BILL_HISTORY_TRUST_WORDS = new Set(['calculated', 'estimated', 'unknown', 'unavailable']);
// Forecast's occurrence identity, as the history keys it: the row's
// occurrenceKey (id@scheduledDate) when it publishes one, else its id and
// date (or scheduledDate).
const billOccurrenceOf = row => (typeof row.occurrenceKey === 'string' && row.occurrenceKey.startsWith(row.id + '@')
  ? row.occurrenceKey : row.id + '@' + (typeof row.scheduledDate === 'string' && row.scheduledDate ? row.scheduledDate : row.date));
function proveBillHistory(advice) {
  const history = advice.billHistory;
  assert.ok(history && typeof history === 'object' && !Array.isArray(history), 'authorized addition: billHistory is a map of bill id to occurrences');
  const rows = new Map();
  const occurrences = new Set();
  for (const view of Array.isArray(advice.payPeriodViews) ? advice.payPeriodViews : []) {
    if (!view) continue;
    for (const row of Array.isArray(view.bills) ? view.bills : []) {
      if (!row || typeof row.id !== 'string' || !row.id || typeof row.date !== 'string' || row.paidState === 'carried') continue;
      const key = row.id + '@' + row.date;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(row);
      occurrences.add(billOccurrenceOf(row));
    }
  }
  const listed = new Set();
  for (const [id, list] of Object.entries(history)) {
    assert.ok(Array.isArray(list) && list.length, `authorized addition: billHistory.${id} lists occurrences`);
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      assert.deepEqual(Object.keys(entry), ['date', 'amount', 'amountBasis', 'trust', 'paidState', 'occurrence', 'paidConfirmed'], `authorized addition: billHistory.${id} entry shape`);
      if (i) assert.ok(list[i - 1].date >= entry.date, `authorized addition: billHistory.${id} is newest first`);
      const candidates = rows.get(id + '@' + entry.date) || [];
      const row = candidates.find(r => r.paidState === entry.paidState && !listed.has(billOccurrenceOf(r)));
      assert.ok(row, `authorized addition: billHistory.${id}@${entry.date} copies a published row of an occurrence not already listed`);
      const actual = row.displayAmountBasis === 'posted-actual' || row.displayAmountBasis === 'unconfirmed-actual';
      assert.equal(entry.amountBasis, actual ? row.displayAmountBasis : 'schedule', `authorized addition: billHistory.${id}@${entry.date} basis is the row's`);
      const raw = actual ? row.actual : row.amount;
      const expected = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(Math.abs(raw) * 100) / 100 : null;
      assert.equal(entry.amount, expected, `authorized addition: billHistory.${id}@${entry.date} amount is the basis amount`);
      assert.ok(BILL_HISTORY_TRUST_WORDS.has(entry.trust), `authorized addition: billHistory.${id}@${entry.date} trust is a trust word`);
      const carriedTrust = ['calculated', 'estimated'].includes(row.displayAmountTrust) ? row.displayAmountTrust : 'unknown';
      assert.equal(entry.trust, expected === null ? 'unavailable' : carriedTrust,
        `authorized addition: billHistory.${id}@${entry.date} trust is the row's display trust (an unrecognised word reads unknown)`);
      assert.equal(entry.amount === null, entry.trust === 'unavailable', `authorized addition: billHistory.${id}@${entry.date} null amount iff unavailable`);
      assert.equal(entry.occurrence, billOccurrenceOf(row), `authorized addition: billHistory.${id}@${entry.date} occurrence is the row's identity`);
      const planOf = row.planned != null && Number.isFinite(Number(row.planned)) ? Number(row.planned) : Number(row.amount);
      assert.equal(entry.paidConfirmed, row.paidState === 'paid' && row.displayAmountBasis === 'posted-actual'
        && typeof row.actual === 'number' && (Math.round(Math.abs(row.actual) * 100) === Math.round(Math.abs(planOf) * 100)
          || row.billPaymentVerified === true),
      `authorized addition: billHistory.${id}@${entry.date} paidConfirmed only for a posted payment of exactly the plan, or a verified one`);
      listed.add(billOccurrenceOf(row));
    }
  }
  // Each published occurrence (by identity, so a statement's moved date and
  // the saved close's original date are one) is listed exactly once.
  for (const key of occurrences) assert.ok(listed.has(key), `authorized addition: billHistory lists the published occurrence ${key}`);
  assert.equal(listed.size, Object.values(history).reduce((n, list) => n + list.length, 0), 'authorized addition: one entry per occurrence');
}

function withoutAuthorizedAdditions(advice) {
  if (!advice || typeof advice !== 'object') return advice;
  withoutStackSummary(advice);
  withoutReconMatchesSpent(advice);
  if (Object.hasOwn(advice, 'billHistory')) {
    proveBillHistory(advice);
    delete advice.billHistory;
  }
  withoutBillPaidState(advice);
  if (!Object.hasOwn(advice, 'categorySpendingTrends')) return advice;
  const trends = advice.categorySpendingTrends;
  assert.equal(trends && trends.status, 'insufficient', 'authorized addition: categorySpendingTrends publishes no trend here');
  assert.equal(trends.trust, 'unavailable', 'authorized addition: categorySpendingTrends reads unavailable');
  assert.deepEqual(trends.categories, [], 'authorized addition: categorySpendingTrends lists nothing');
  assert.equal(trends.qualifyingCloses, 0, 'authorized addition: no qualifying saved close');
  delete advice.categorySpendingTrends;
  return advice;
}

// For flattened trust-tag maps ('.path.to.trust' -> value): the addition's
// own tags, proved unavailable, are not main's fields.
function authorizedTagKey(key, value) {
  if (/\.stackSummary\.income\.(dale|amanda|other|total)\.trust$/.test(key) || /\.stackSummary\.(surplus|bills)\.trust$/.test(key)
    // The Bills paid figure's trust (Dale, 2026-11-20 "bills needs the paid/owed"): proved in proveStackBillParts.
    || /\.stackSummary\.bills\.paidTrust$/.test(key)
    || /\.stackSummary\.savings\.(items\.\d+\.(trust|savedTrust)|totals\.(trust|entitlementTrust))$/.test(key)) {
    assert.ok(['calculated', 'estimated', 'unavailable'].includes(value), `authorized addition tag ${key} is a trust word`);
    return true;
  }
  // Desk ruling (E) (#1573): the view's card-target publication and the Credit breakdown, each figure with its own trust
  // word (a card line's figures, totals and deduction; a breakdown row), proved in proveStackCredit.
  if (/\.stackSummary\.credit\.(lines\.\d+|totals)(\.[A-Za-z]+)*\.(trust|[a-zA-Z]+Trust)$/.test(key)
    || /\.stackSummary\.creditBreakdown\.(rows\.\d+\.trust|stillToPayBack\.trust|trust)$/.test(key)) {
    assert.ok(['calculated', 'estimated', 'unavailable'].includes(value), `authorized addition tag ${key} is a trust word`);
    return true;
  }
  // The Bills account card (Dale's decision on #821; lead brief #1620 7181064255): its reading and each transaction's
  // trust, proved in proveStackBillsAccount (posted calculated, pending estimated).
  if (/\.stackSummary\.billsAccount\.(now|transactions\.\d+)\.trust$/.test(key)) {
    assert.ok(['calculated', 'estimated', 'unavailable'].includes(value), `authorized addition tag ${key} is a trust word`);
    return true;
  }
  // The Stack bill cards' per-row amount trust (#1465): the row's own posted or plan word, never a new certainty.
  if (/\.bills\.\d+\.stackBillAmountTrust$/.test(key)) {
    assert.ok(['calculated', 'estimated', 'unknown'].includes(value), `authorized addition tag ${key} is a trust word`);
    return true;
  }
  if (/^\.billHistory\.[^.]+\.\d+\.trust$/.test(key)) {
    assert.ok(BILL_HISTORY_TRUST_WORDS.has(value), `authorized addition tag ${key} is a trust word`);
    return true;
  }
  if (!key.startsWith('.categorySpendingTrends.')) return false;
  assert.equal(value, 'unavailable', `authorized addition tag ${key} reads unavailable`);
  return true;
}

module.exports = { withoutAuthorizedAdditions, authorizedTagKey };
