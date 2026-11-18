'use strict';
// Rank 18, Transfer / Payment (Grok Bot's rule 17 answer on transfers and its #1149 conditions;
// lead, 2026-11-18). A POSTED chequing debit filed as Transfer or Payment, with no other side proven
// by the ledger (a transfer group, link or mark; never a name or amount match), left household cash.
// It is held To confirm, out of every category and Other, and deducted ONCE by the existing held
// term (heldOutflowSpending). Before this, the same $400 filed as Transfer left the remainder at
// 1,632.01 while filed as Shopping it gave 1,232.01. Everything another owner proves stays with it.
// Invented data only: the Budget surface household plus extra legs; every expected figure is the
// fixture's own literal (remainder before the leg 1,632.01 = 4,050 - 1,665 - 752.99).
const F = require('../public/forecast');
const { world } = require('./fixtures/money-out-worlds');

let failures = 0;
function ok(cond, msg, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}${!cond && detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}
const cents = n => Math.round(Number(n) * 100);
function viewOf(served) {
  const advice = F.recommend(served.plan, '2026-08-20', { ...served.plan.defaults, debts: served.debts || [],
    currentPeriodActuals: served.liveOverlay.currentPeriodActuals, representedEvents: served.liveOverlay.representedEvents });
  const cur = advice.payPeriodViews.find(view => view.timelineRole === 'current');
  return { cur, terms: cur.predictedEndingBalanceTerms, held: cur.heldOutflowsToConfirm || null,
    other: (cur.householdBudget || []).find(row => row.id === 'other-spending'), advice };
}
const run = (legs, options) => viewOf(world(legs, options));
const BEFORE = 1632.01; // 4,050 income - 1,665 bills - 752.99 household hold, from the fixture header
const DEBIT = 400;
const transfer = { category: 'transfer', amount: DEBIT };
const heldAmount = view => view.terms && view.terms.heldOutflowSpending;
const reasons = view => (view.held && view.held.recon || []).map(row => row.includeReason);

console.log('\n=== the same $400 moves the remainder by the same amount however it is filed ===');
const control = run([]);
const shopping = run([{ category: 'shopping', amount: DEBIT }]);
const unproven = run([transfer]);
ok(cents(control.cur.balanceAfterDeductions) === cents(BEFORE), 'control: the remainder is 1,632.01', String(control.cur.balanceAfterDeductions));
ok(cents(shopping.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT), 'filed as Shopping: the remainder falls by 400.00');
ok(cents(unproven.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT),
  'filed as Transfer with no proven other side: the remainder falls by the same 400.00', String(unproven.cur.balanceAfterDeductions));
ok(heldAmount(unproven) === DEBIT && unproven.terms.closes === true,
  'the 400 is the held term, once, and the terms still close', JSON.stringify(unproven.terms));
ok(unproven.held && unproven.held.total === DEBIT && reasons(unproven).join() === 'transfer-debit-unproven',
  'it is listed To confirm, once, with its own reason', JSON.stringify(unproven.held));
ok(unproven.other && control.other && unproven.other.spent === control.other.spent, 'it is not Other spending (Other is unchanged)');
ok(cents(unproven.cur.plannedPeriodClose) === cents(control.cur.plannedPeriodClose)
  && unproven.cur.plannedPeriodCloseTerms && unproven.cur.plannedPeriodCloseTerms.heldOutflowSpending === DEBIT,
  'the planned close holds the same term; its amount is unchanged (the 400 already left the opening)');
ok(!heldAmount(shopping) && !heldAmount(control) && !shopping.held, 'a Shopping debit or no debit adds no held term');
const paymentLabel = run([{ category: 'payment', amount: DEBIT }]);
ok(cents(paymentLabel.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT) && heldAmount(paymentLabel) === DEBIT,
  'filed as Payment, Transfer: the same, once');
for (const kind of ['payment', 'bill-payment', 'transfer']) {
  const hinted = run([{ category: 'transfer', amount: DEBIT, kind }]);
  ok(cents(hinted.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT) && heldAmount(hinted) === DEBIT,
    'a Transfer with the generic kind "' + kind + '" and no card pair: held once', String(hinted.cur.balanceAfterDeductions));
}
const onA = run([{ ...transfer, account: 1001 }]);
ok(heldAmount(onA) === DEBIT, 'the other household chequing account: the same');

console.log('\n=== a pending one is unchanged (not added in) ===');
{
  const pending = run([{ ...transfer, pending: true }]);
  ok(cents(pending.cur.balanceAfterDeductions) === cents(BEFORE) && !heldAmount(pending) && !pending.held,
    'the remainder stays 1,632.01 and nothing is held', String(pending.cur.balanceAfterDeductions));
}

console.log('\n=== a debit another owner already counts is counted once, there ===');
{
  // The invented mortgage payment (1,400, Aug 15) is linked to its scheduled bill. Re-filed as
  // Transfer or Payment, Transfer it is still that bill's payment.
  for (const label of ['transfer', 'payment']) {
    const refiled = run([], { refile: { 92002: label } });
    ok(cents(refiled.cur.balanceAfterDeductions) === cents(BEFORE) && !heldAmount(refiled),
      'the linked 1,400 bill payment filed as ' + label + ': the remainder is unchanged, nothing held', String(refiled.cur.balanceAfterDeductions));
    ok(refiled.cur.periodBillLoad === control.cur.periodBillLoad, 'filed as ' + label + ': the bill load is the same, counted once as the bill');
  }
  // A proven move between two household accounts (both TD transfer legs, one reference).
  const moved = run([
    { account: 1002, category: 'transfer', amount: DEBIT, original: 'AB123 TFR-TO INVENTED SAVINGS', payee: 'Transfer out' },
    { account: 1001, category: 'transfer', amount: -DEBIT, original: 'AB123 TFR-FR INVENTED OPERATING', payee: 'Transfer in' },
  ]);
  ok(cents(moved.cur.balanceAfterDeductions) === cents(BEFORE) && !heldAmount(moved),
    'a proven transfer pair is not held', String(moved.cur.balanceAfterDeductions));
  // A row the ledger groups with its other side (a Lunch Money group) is linked there, never held here.
  const grouped = run([{ ...transfer, groupParent: 99001 }]);
  ok(!heldAmount(grouped) && !grouped.held, 'a Transfer debit in a Lunch Money group is not held', JSON.stringify(grouped.held));
  const tdCard = run([{ category: 'transfer', amount: DEBIT, original: 'AB124 TFR-TO C/C', payee: 'Card payment' }]);
  ok(cents(tdCard.cur.balanceAfterDeductions) === cents(BEFORE) && !heldAmount(tdCard),
    'a card payment by its recipient identity is not held', String(tdCard.cur.balanceAfterDeductions));
}

console.log('\n=== only a card payment the card ledger ACCEPTED is proven ===');
{
  const CARD = 400;
  const pay = r => ({ id: 'pay-1', confirmed: true, debitRef: r.debit, creditRef: r.credit, allocations: [{ purchaseRef: r.purchase, amount: CARD }], otherAmount: 0 });
  const leg = [{ category: 'transfer', amount: CARD, account: 1001 }];
  const purchaseOnly = run([], { card: { amount: CARD } });
  ok(cents(purchaseOnly.cur.balanceAfterDeductions) === cents(BEFORE - CARD) && !heldAmount(purchaseOnly),
    'control: the card purchase alone lowers the remainder once (1,232.01)', String(purchaseOnly.cur.balanceAfterDeductions));
  const paired = run(leg, { card: { amount: CARD, declare: pay } });
  ok(cents(paired.cur.balanceAfterDeductions) === cents(purchaseOnly.cur.balanceAfterDeductions) && !heldAmount(paired),
    'an accepted card pair: nothing held; the purchase is counted once', JSON.stringify([paired.cur.balanceAfterDeductions, heldAmount(paired)]));
  const unpaired = run(leg, { card: { amount: CARD } });
  ok(cents(unpaired.cur.balanceAfterDeductions) === cents(purchaseOnly.cur.balanceAfterDeductions - CARD) && heldAmount(unpaired) === CARD,
    'the same legs with no accepted pair: the 400 is held once', JSON.stringify([unpaired.cur.balanceAfterDeductions, heldAmount(unpaired)]));
  const conflicted = run(leg, { card: { amount: CARD, declare: r => [pay(r), { ...pay(r), id: 'pay-2' }] } });
  ok(heldAmount(conflicted) === CARD, 'a pair claimed twice (not reconciled) proves nothing: held once');
  // A declaration the reconciler rejects proves nothing either.
  const served = world([transfer]);
  const tx = served.liveOverlay.currentPeriodActuals.transactions.find(row => row.amount === DEBIT);
  served.plan.cardPurchaseCoverage.payments = [{ id: 'decl-a', confirmed: false, debitRef: tx.coverageRef, creditRef: 'card-credit-a', allocations: [], otherAmount: DEBIT }];
  ok(heldAmount(viewOf(served)) === DEBIT, 'an unconfirmed declaration proves nothing: held once');
}

console.log('\n=== a card-payment or debt-payment category alone is not proof (lead blocker on #1388) ===');
{
  const CARD = 400;
  const pay = r => ({ id: 'pay-1', confirmed: true, debitRef: r.debit, creditRef: r.credit, allocations: [{ purchaseRef: r.purchase, amount: CARD }], otherAmount: 0 });
  for (const [label, leg] of [
    ['a "Credit Card Payment" category', { categoryName: 'Credit Card Payment', amount: CARD, account: 1001 }],
    ['a "CC Payment" category', { categoryName: 'CC Payment', amount: CARD, account: 1001 }],
    ['a "Personal Loan Payment" category with a transfer hint', { categoryName: 'Personal Loan Payment', kind: 'transfer', amount: CARD, account: 1001 }],
  ]) {
    const unpaired = run([leg]);
    ok(cents(unpaired.cur.balanceAfterDeductions) === cents(BEFORE - CARD) && heldAmount(unpaired) === CARD,
      label + ', no pair, group or identity: held once', JSON.stringify([unpaired.cur.balanceAfterDeductions, heldAmount(unpaired)]));
    const purchaseOnly = run([], { card: { amount: CARD } });
    const paired = run([leg], { card: { amount: CARD, declare: pay } });
    ok(cents(paired.cur.balanceAfterDeductions) === cents(purchaseOnly.cur.balanceAfterDeductions) && !heldAmount(paired),
      label + ' the card ledger pairs: not held; the purchase counts once', JSON.stringify([paired.cur.balanceAfterDeductions, heldAmount(paired)]));
    const grouped = run([{ ...leg, groupParent: 99002 }]);
    ok(!heldAmount(grouped), label + ' in a Lunch Money group: not held');
  }
}

console.log('\n=== Grok Bot condition 1: only an exact single-card minimum category keeps a debit out ===');
{
  const MIN = 60, CARDMIN = 'Minimum payment - TD Travel Visa';
  const Category = require('../scripts/card-minimum-category.js');
  const names = Object.keys(Category.CATEGORIES);
  ok(names.length > 0 && names.every(name => typeof Category.CATEGORIES[name] === 'string' && Category.CATEGORIES[name])
    && Object.isFrozen(Category.CATEGORIES), 'every minimum category names exactly one card, and the mapping is frozen');
  const leg = (categoryName, extra) => [{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18', categoryName, ...(extra || {}) }];
  const counts = (view, label) => ok(cents(view.cur.balanceAfterDeductions) === cents(BEFORE - MIN) && heldAmount(view) === MIN,
    label + ': the 60 is held once', JSON.stringify([view.cur.balanceAfterDeductions, heldAmount(view)]));
  const stays = (view, label) => ok(cents(view.cur.balanceAfterDeductions) === cents(BEFORE) && !heldAmount(view),
    label + ': nothing held, the remainder is unchanged', JSON.stringify([view.cur.balanceAfterDeductions, heldAmount(view)]));
  counts(run(leg('Minimum payment - Invented unconnected destination')), 'a "Minimum payment - ..." label naming no known card');
  counts(run(leg(CARDMIN, { excludeBudget: false, excludeTotals: false })), 'an exact owner category without the owner\'s exclude flags');
  counts(run(leg(CARDMIN)), 'an exact owner category the minimum owner did not accept');
  stays(run(leg(CARDMIN), { minimumOwner: true }), 'a minimum the category protocol accepted');
  stays(run(leg(CARDMIN), { minimumOwner: true, durableMinimum: true }), 'a minimum already owned by a durable record');
}

console.log('\n=== a noted card payment the card ledger did not pair is not owned (Codex P1 on #1388) ===');
{
  // A Transfer debit noted "card payment: Travel Visa" is a provisional minimum candidate. Card coverage
  // finds no posted card credit for it, so qualification drops it: neither owner counts it, so it is held.
  const MIN = 60;
  const noted = [{ account: 1001, amount: MIN, category: 'transfer', date: '2026-08-18', notes: 'card payment: Travel Visa' }];
  const served = world(noted, { minimumOwner: true });
  const view = viewOf(served);
  ok(cents(view.cur.balanceAfterDeductions) === cents(BEFORE - MIN) && heldAmount(view) === MIN,
    'an unpaired noted payment is held once (1,572.01), not exempt as a minimum', JSON.stringify([view.cur.balanceAfterDeductions, heldAmount(view)]));
  ok(!served.liveOverlay.currentPeriodActuals.transactions.some(tx => tx.cardMinimumOwned === true),
    'no row stays marked owned after qualification drops the candidate');
  // The paired control (the mark survives qualification) is in test-card-payment-note-minimum section 8.
}

console.log('\n=== the card-minimum owner export decides (Forecast.cardMinimumOwnedDebits) ===');
{
  const MIN = 60;
  const plain = [{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18' }];
  const owned = run(plain, { durableMinimum: true });
  ok(cents(owned.cur.balanceAfterDeductions) === cents(BEFORE) && !heldAmount(owned),
    'a debit a durable owner record counts, with no category: not held as well', JSON.stringify([owned.cur.balanceAfterDeductions, heldAmount(owned)]));
  ok(heldAmount(run(plain)) === MIN, 'control: the same debit with no owner record is held once');
  // Condition (3) on refresh: the same ledger observed again after the durable owner record is
  // withdrawn. The debit is no longer owned, so it comes back, held once (never dropped, never doubled).
  const sameWorld = (withRecord) => run(plain, withRecord ? { durableMinimum: true } : {});
  const first = sameWorld(true), refreshed = sameWorld(false);
  ok(!heldAmount(first) && heldAmount(refreshed) === MIN && cents(refreshed.cur.balanceAfterDeductions) === cents(BEFORE - MIN),
    'condition (3): a withdrawn owner record returns the debit on the next refresh, held once',
    JSON.stringify([heldAmount(first), heldAmount(refreshed), refreshed.cur.balanceAfterDeductions]));
  const other = 'f'.repeat(64);
  const elsewhere = run(plain, { durableMinimum: { debitId: other, movementIdentity: { source: 'lunchmoney-minimum-category', debitId: other } } });
  ok(heldAmount(elsewhere) === MIN, 'an owner record naming another debit does not own this one: held once');
  // No debit identity reaches the served packet: only booleans and the export status.
  const served = world(plain, { durableMinimum: true });
  const packet = served.liveOverlay.currentPeriodActuals;
  const blob = JSON.stringify(packet);
  const hash = require('node:crypto').createHash('sha256').update('lunchmoney-minimum-category:94001').digest('hex');
  ok(packet.cardMinimumOwnership === 'available' && packet.transactions.some(tx => tx.cardMinimumOwned === true),
    'the packet carries the export status and the boolean on the owned row');
  ok(!blob.includes(hash) && !/"debitId"/.test(blob) && !/[a-f0-9]{64}/.test(blob), 'the packet carries no debit identity or 64-hex hash');
}

console.log('\n=== Grok Bot condition 2: a disagreement is held To confirm and named, not Unavailable ===');
{
  const MIN = 60, CARDMIN = 'Minimum payment - TD Travel Visa';
  const leg = [{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18', categoryName: CARDMIN }];
  // The owner record says the Sep 22 occurrence; the ledger's category links it to Aug 22.
  const options = { minimumOwner: true, durableMinimum: { scheduledDate: '2026-09-22' } };
  const disagree = run(leg, options);
  const row = disagree.held && disagree.held.recon.find(item => item.amount === MIN);
  ok(cents(disagree.cur.balanceAfterDeductions) === cents(BEFORE - MIN) && heldAmount(disagree) === MIN
    && row && row.cardMinimumDisagreement === true && disagree.held.total === MIN,
    'the 60 is held once, named as a disagreement, and the term is a number', JSON.stringify([disagree.cur.balanceAfterDeductions, disagree.held]));
  ok(F.cardMinimumState(world(leg, options).plan, '2026-08-20').payments.length === 0, 'neither minimum is marked sent');
  const agree = run(leg, { minimumOwner: true, durableMinimum: true });
  ok(cents(agree.cur.balanceAfterDeductions) === cents(BEFORE) && !heldAmount(agree), 'same debit and occurrence: the owner record wins, nothing held');
}

console.log('\n=== Grok Bot condition 3: an unreadable owner record makes the term Unavailable and names it ===');
{
  const MIN = 60;
  const plain = [{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18' }];
  const unreadable = run(plain, { durableMinimum: { intent: undefined } });
  ok(unreadable.cur.balanceAfterDeductions == null && unreadable.held && unreadable.held.total == null
    && unreadable.held.recon.some(row => row.cardMinimumUnknown === true),
    'the remainder is not computed and the held total is Unavailable (never 0)', JSON.stringify([unreadable.cur.balanceAfterDeductions, unreadable.held]));
  ok(Array.isArray(unreadable.held.cardMinimumUnreadable) && unreadable.held.cardMinimumUnreadable.some(item => item.what === 'purpose'),
    'it names what could not be read (a label and a word)', JSON.stringify(unreadable.held.cardMinimumUnreadable));
  ok(!JSON.stringify(unreadable.held).match(/[a-f0-9]{64}/), 'no identity in the published names');
}

console.log('\n=== condition 4: counted once ===');
{
  const both = run([transfer, { category: 'transfer', amount: 25, date: '2026-08-18' }]);
  ok(heldAmount(both) === DEBIT + 25 && both.held.recon.length === 2 && cents(both.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT - 25),
    'two unproven debits: each held once, summed once', JSON.stringify([heldAmount(both), both.cur.balanceAfterDeductions]));
  ok(both.other && control.other && both.other.spent === control.other.spent, 'neither joins Other spending');
}

console.log('\n=== the Budget page names why each is held (plan.js prints Forecast\'s rows) ===');
{
  const { loadBudgetPage } = require('./lib/budget-page-harness');
  const page = loadBudgetPage();
  const text = html => String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const budgetHtml = (legs, options) => {
    const served = world(legs, options);
    const view = viewOf(served);
    page.context.__period = view.cur; page.context.__served = served;
    return page.get('calendarBudgetHtml(__period, __served.liveOverlay, __served.plan)');
  };
  const MIN = 60, CARDMIN = 'Minimum payment - TD Travel Visa';
  const plain = text(budgetHtml([transfer]));
  ok(/To confirm/.test(plain) && /Not counted as spending/.test(plain), 'an unproven Transfer is listed under To confirm', plain.slice(0, 200));
  const disagree = budgetHtml([{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18', categoryName: CARDMIN }],
    { minimumOwner: true, durableMinimum: { scheduledDate: '2026-09-22' } });
  ok(/data-tx-minimum-disagreement/.test(disagree) && /Owner record and ledger link disagree \(card or occurrence\)/.test(text(disagree)),
    'condition 2: the row says the owner record and the ledger link disagree');
  const unreadable = budgetHtml([{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18' }],
    { durableMinimum: { intent: undefined } });
  ok(/data-budget-held-unreadable/.test(unreadable) && /Unavailable\. Could not read .+ \(purpose\)\./.test(text(unreadable))
    && /data-tx-minimum-unknown/.test(unreadable),
    'condition 3: the To confirm total reads Unavailable and names what could not be read', (text(unreadable).match(/Could not read[^.]*\./) || [])[0]);
  ok(!/data-budget-held-unreadable|data-tx-minimum/.test(budgetHtml([transfer])), 'neither note on a plain unproven Transfer');
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
