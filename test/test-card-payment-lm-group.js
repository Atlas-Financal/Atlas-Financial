'use strict';
// Lunch Money's own card-payment link (lead dispatch U5). A posted LM
// transaction group (both rows carry the v2 group_parent_id) that spans two
// accounts and holds exactly one household-cash debit and one card-payment
// credit of equal amount proves where the payment went: the two rows pair with
// each other, whatever their payees or notes. An ungrouped pair behaves as
// today; a group of any other shape withholds; a same-account group (an LM
// split, which shares the parent field) reads as if ungrouped.
// Invented numbers only; every expected figure is written from the rule by hand.
//
// World (test/fixtures/card-coverage-aggregate-world.js): Bills 500, Travel
// Visa debt 400 with a 25 minimum due on the as-of, groceries allowance 150,
// one 80 card purchase. Hand-derived for a 105 Bills -> Travel Visa payment:
// the 25 minimum first, then the 80 purchase; reserve 0; Bills 395; available
// now = 395 - 0 - 70 (groceries left) - 0 = 325.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const generic = { payee: 'Invented card payment', original_name: 'Invented card payment', category_name: 'Payment, Transfer' };
const group = { group_parent_id: 777001 };
const purchase = ['card', 80, null, 'purchase'];
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const issues = s => (s.coverage.issues || []).map(i => i.code);
const paidOnce = (s, why) => {
  check(s.coverage.status === 'ready', why + ': ready ' + JSON.stringify(s.coverage.issues));
  check(s.coverage.reservedCash === 0, why + ': reserve 0');
  check(s.coverage.payments.length === 1, why + ': exactly one payment (got ' + s.coverage.payments.length + ')');
  const p = s.coverage.payments[0] || {};
  check(p.minimumPayment === 25 && p.backfill === 80 && p.cardPayment === 0, why + ': minimum 25 first, then the 80 purchase');
  check(s.period.fromTodayFunding.availableNow === 325, why + ': available now 395 - 0 - 70 - 0 = 325 (got '
    + s.period.fromTodayFunding.availableNow + ')');
};
const withheld = (s, why, code) => {
  check(s.coverage.status === 'unavailable' && s.period.fromTodayFunding.availableNow === null, why + ': withheld');
  if (code) check(issues(s).includes(code), why + ': ' + code + ' in ' + JSON.stringify(issues(s)));
};
const orders = rows => [['in order', rows], ['reversed', rows.slice().reverse()]];

// 1. A grouped generic card payment (no TD identity, no note): the group alone proves it.
const grouped = [purchase, ['bills', 105, null, 'cash', { ...generic, ...group }], ['card', -105, null, 'credit', { ...generic, ...group }]];
for (const [name, rows] of orders(grouped)) paidOnce(run(world(rows)), 'grouped pair, ' + name);
// 2. The same rows ungrouped behave as today: the generic credit's purpose is unconfirmed.
// Since the lead's 2026-11-18 dispatch (Dale, stop 2) the generic credit is
// To confirm, counted as neither payment nor refund (the generic debit is no
// card-payment leg), so the 80 purchase stays reserved and the 25 minimum due.
{
  const s = run(world([purchase, ['bills', 105, null, 'cash', generic], ['card', -105, null, 'credit', generic]]));
  const why = 'ungrouped generic pair';
  check(s.coverage.status === 'ready' && s.coverage.estimateBasis === 'card-credit-purpose-unconfirmed', why + ': the credit To confirm');
  check(s.coverage.reservedCash === 80 && s.coverage.toConfirm.length === 1 && s.coverage.toConfirm[0].amount === 105
    && s.coverage.payments.length === 0, why + ': purchase reserved, one row, no payment');
  check(s.period.fromTodayFunding.availableNow === 220, why + ': available now 395 - 80 - 70 - 25 = 220 (got '
    + s.period.fromTodayFunding.availableNow + ')');
}
// 3. A grouped TD pair pays once, and an extra ungrouped TD debit of the same amount
// does not join it: it has no destination of its own. Since the lead's
// 2026-11-18 dispatch (Dale) it is applied to no card and listed To confirm.
const tdDebit = ref => ['bills', 105, null, 'cash', { payee: ref + ' TFR-TO C/C', original_name: ref + ' TFR-TO C/C', category_name: 'Transfer' }];
const tdCredit = ['card', -105, null, 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', category_name: 'Transfer', ...group }];
paidOnce(run(world([purchase, [...tdDebit('AB123').slice(0, 4), { ...tdDebit('AB123')[4], ...group }], tdCredit])), 'grouped TD pair');
{
  const s = run(world([purchase, [...tdDebit('AB123').slice(0, 4), { ...tdDebit('AB123')[4], ...group }], tdCredit, tdDebit('CD456')]));
  check(s.coverage.status === 'ready' && s.coverage.trust === 'estimated' && s.coverage.toConfirm.length === 1,
    'grouped TD pair + an outside equal TD debit: an estimate, the outside debit To confirm');
  check(s.coverage.payments.length === 1, 'the grouped pair is still the one payment; the outside debit never joins it');
}
// 4. Any other group shape never pairs. Since the lead's 2026-11-18 dispatch
// (Dale, stop 2), where the only issue is the generic credit's purpose, that
// credit is To confirm, counted as neither payment nor refund: the 80
// purchase stays reserved and the 25 minimum due, and the generic debits
// have already left Bills.
const creditToConfirm = (s, why, amount, available) => {
  check(s.coverage.status === 'ready' && s.coverage.estimateBasis === 'card-credit-purpose-unconfirmed', why + ': the credit To confirm');
  check(s.coverage.reservedCash === 80 && s.coverage.payments.length === 0, why + ': purchase reserved, no payment');
  check(s.coverage.toConfirm.length === 1 && s.coverage.toConfirm[0].amount === amount, why + ': one row, the ' + amount);
  check(s.period.fromTodayFunding.availableNow === available, why + ': available now ' + available + ' (got '
    + s.period.fromTodayFunding.availableNow + ')');
};
// Bills 500 - 105 = 395; 395 - 80 - 70 - 25 = 220.
creditToConfirm(run(world([purchase, ['bills', 105, null, 'cash', { ...generic, ...group }], ['card', -100, null, 'credit', { ...generic, ...group }]])),
  'grouped, unequal amounts', 100, 220);
// Bills 500 - 105 - 10 = 385; 385 - 80 - 70 - 25 = 210.
creditToConfirm(run(world([...grouped, ['bills', 10, null, 'cash', { ...generic, ...group }]])), 'grouped, three members', 105, 210);
withheld(run(world([purchase, ['bills', 105, null, 'cash', { ...generic, ...group }],
  ['card', -105, null, 'credit', { ...generic, ...group, is_pending: true }]])), 'grouped, pending credit');
withheld(run(world([purchase, ['savings', 105, null, 'cash', { ...generic, ...group }], ['card', -105, null, 'credit', { ...generic, ...group }]],
  { savingsOpening: 1000 })), 'grouped, a Savings (not household-cash) debit', 'coverage-payment-group-unconfirmed');
// 5. A Weekly household-cash debit in a group is a Weekly-funded payment (#1304):
// it covers the card once. Weekly is -105 in this world, so pooled cash is
// 500 - 105 = 395 and available now is 325, as for Bills.
paidOnce(run(world([purchase, ['weekly', 105, null, 'cash', { ...generic, ...group }], ['card', -105, null, 'credit', { ...generic, ...group }]])),
  'grouped Weekly debit');
// 6. A same-account group is an LM split: it reads exactly as the same rows ungrouped.
{
  const split = run(world([purchase, ['bills', 60, null, 'cash', { ...generic, ...group }], ['bills', 45, null, 'cash', { ...generic, ...group }]]));
  const plain = run(world([purchase, ['bills', 60, null, 'cash', generic], ['bills', 45, null, 'cash', generic]]));
  check(split.coverage.status === plain.coverage.status && JSON.stringify(issues(split)) === JSON.stringify(issues(plain))
    && split.period.fromTodayFunding.availableNow === plain.period.fromTodayFunding.availableNow,
  'same-account group (a split) reads as ungrouped (available ' + split.period.fromTodayFunding.availableNow + ')');
}
// 6b. A split of a card-payment debit (two "Credit Card Payment" pieces on Bills,
// one group, one account) beside the card's credit: it reads exactly as the
// same pieces ungrouped, never as a group of another shape.
{
  const ccp = { payee: 'Invented card payment', original_name: 'Invented card payment', category_name: 'Credit Card Payment' };
  const rows = extra => [purchase, ['bills', 60, null, 'cash', { ...ccp, ...extra }], ['bills', 45, null, 'cash', { ...ccp, ...extra }],
    ['card', -105, null, 'credit', ccp]];
  const split = run(world(rows(group))), plain = run(world(rows({})));
  check(split.coverage.status === plain.coverage.status && JSON.stringify(issues(split)) === JSON.stringify(issues(plain)),
    'a split card-payment debit reads as ungrouped: ' + JSON.stringify(issues(split)) + ' vs ' + JSON.stringify(issues(plain)));
  check(!issues(split).includes('coverage-payment-group-unconfirmed'), 'a split is never a group of another shape');
}
// 7. Real Lunch Money returns the group's own parent row too: no account of its
// own (it spans two), listing its children. A complete group (exactly the listed
// children present, each on a mapped account) is not a coverage gap, and the
// payment pays once as in case 1. A parent listing a child that is not present,
// or a child on an unmapped account, keeps the history incomplete and withholds.
const withParent = ({ extraChild = false, childAccount = null } = {}) => x => {
  const kids = x.payload.transactions.filter(t => t.group_parent_id === 777001);
  if (childAccount) kids[0].account_id = childAccount;
  x.payload.transactions.push({ id: 777001, date: x.asOf, amount: 0, payee: 'Invented card payment group',
    category_name: 'Payment, Transfer', is_group_parent: true, is_pending: false, status: 'reviewed', currency: 'cad', notes: null,
    children: [...kids.map(t => ({ id: t.id, amount: t.amount, plaid_account_id: null, manual_account_id: t.account_id })),
      ...(extraChild ? [{ id: 999001, amount: 1, plaid_account_id: null, manual_account_id: 3001 }] : [])] });
};
for (const [name, rows] of orders(grouped)) {
  const s = run(world(rows, { edit: withParent() }));
  check(s.packet.transactionCoverage === 'complete', 'complete group with its parent row, ' + name + ': coverage complete (got '
    + s.packet.transactionCoverage + ')');
  paidOnce(s, 'complete group with its parent row, ' + name);
  check(s.period.householdBudget[0].spent === 80, 'complete group with its parent row, ' + name + ': groceries spent 80, once');
}
for (const [name, opts] of [['a listed child is missing', { extraChild: true }], ['a child is on an unmapped account', { childAccount: 3999 }]]) {
  const s = run(world(grouped, { edit: withParent(opts) }));
  check(s.packet.transactionCoverage === 'incomplete', name + ': coverage incomplete (got ' + s.packet.transactionCoverage + ')');
  withheld(s, name);
}
// 8. Opening rollover with a grouped, noted TD payment (#1322 pre-review): one
// date rule with ordinary pairing (#1298), so grouping never changes the figure.
// Run B as of 10-03, confirmed opening 10-02, a new 75 purchase, the 09-20
// minimum To confirm (25) in this invented opening; Bills 395.
//  - debit 10-01 (noted Travel Visa), credit 10-02: the debit belongs to the old
//    period, so no payment here; reserve 75; available 395 - 25 - 75 - 75 = 220.
//  - mirror, credit 10-01, debit 10-02: one payment by the debit's date, the 75
//    purchase then 30 to debt; reserve 0; available 395 - 25 - 75 - 0 = 295.
{
  const policy = { rule: 'aggregate-per-card-per-pay-period', opening: { asOf: '2026-10-02', confirmed: true,
    currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } };
  const debit = (date, extra) => ['bills', 105, date, 'cash', { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C',
    category_name: 'Transfer', notes: 'card payment: Travel Visa ...9999', ...extra }];
  const credit = (date, extra) => ['card', -105, date, 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU',
    category_name: 'Transfer', ...extra }];
  for (const [name, dDate, cDate, pays, reserve, avail] of [['debit before the rollover', '2026-10-01', '2026-10-02', 0, 75, 220],
    ['mirror', '2026-10-02', '2026-10-01', 1, 0, 295]]) {
    for (const extra of [{}, group]) {
      const s = run(world([['card', 80, '2026-09-20', 'purchase'], debit(dDate, extra), credit(cDate, extra), ['card', 75, '2026-10-02', 'purchase']],
        { asOf: '2026-10-03', minimumDate: '2026-09-20', policy }));
      const why = 'rollover, ' + name + (extra.group_parent_id ? ', grouped' : ', ungrouped');
      check(s.coverage.status === 'ready', why + ': ready ' + JSON.stringify(s.coverage.issues));
      check(s.coverage.payments.length === pays, why + ': ' + pays + ' payment(s) (got ' + s.coverage.payments.length + ')');
      check(s.coverage.reservedCash === reserve, why + ': reserve ' + reserve + ' (got ' + s.coverage.reservedCash + ')');
      check(s.period.fromTodayFunding.availableNow === avail, why + ': available now ' + avail + ' (got '
        + s.period.fromTodayFunding.availableNow + ')');
    }
  }
}
// 9. A grouped debit whose note names another card than the grouped credit's is
// contradictory and withholds.
withheld(run(world([purchase, ['bills', 105, null, 'cash', { ...generic, ...group, notes: 'card payment: TD Cash Back Visa ...8888' }],
  ['card', -105, null, 'credit', { ...generic, ...group }]])), 'grouped debit noted for another card', 'coverage-payment-group-unconfirmed');
// 10. An unlisted row standing in for a listed child: the parent lists the debit
// and a child that is not present, while the credit row (not listed) carries the
// group id. The count matches, the ids do not: coverage stays incomplete.
{
  const s = run(world(grouped, { edit: x => {
    const [d] = x.payload.transactions.filter(t => t.group_parent_id === 777001);
    x.payload.transactions.push({ id: 777001, date: x.asOf, amount: 0, payee: 'Invented card payment group',
      category_name: 'Payment, Transfer', is_group_parent: true, is_pending: false, status: 'reviewed', currency: 'cad', notes: null,
      children: [{ id: d.id, amount: d.amount, plaid_account_id: null, manual_account_id: d.account_id },
        { id: 999002, amount: -105, plaid_account_id: null, manual_account_id: 3004 }] });
  } }));
  check(s.packet.transactionCoverage === 'incomplete', 'an unlisted stand-in child: coverage incomplete (got ' + s.packet.transactionCoverage + ')');
  withheld(s, 'an unlisted stand-in child');
}
// 11. The category wins (lead ruling, #1322; as in #1316). A group in which either
// row carries a spending category is not a card payment: both rows read exactly
// as ungrouped.
//  - A Bills transfer grouped with a 105 Groceries refund on the card: the refund
//    stays a refund and covers the 80 purchase (reserve 0); the 25 minimum is still
//    due (nothing paid it); Bills 395; available 395 - 25 - 70 - 0 = 300; no payment.
//  - A Groceries debit grouped with a card credit: as ungrouped (withheld).
{
  const groc = { payee: 'Invented grocer', original_name: 'Invented grocer', category_name: 'Groceries' };
  const ccp = { payee: 'Invented card payment', original_name: 'Invented card payment', category_name: 'Credit Card Payment' };
  for (const [name, d, c] of [['grouped Groceries refund credit', generic, groc], ['grouped Groceries debit', groc, generic],
    ['a "Credit Card Payment" debit grouped with a Groceries refund', ccp, groc]]) {
    const rows = extra => [purchase, ['bills', 105, null, 'cash', { ...d, ...extra }], ['card', -105, null, 'credit', { ...c, ...extra }]];
    const g = run(world(rows(group))), u = run(world(rows({})));
    check(g.coverage.status === u.coverage.status && JSON.stringify(issues(g)) === JSON.stringify(issues(u))
      && g.coverage.reservedCash === u.coverage.reservedCash && g.period.fromTodayFunding.availableNow === u.period.fromTodayFunding.availableNow
      && g.coverage.payments.length === u.coverage.payments.length,
    name + ': reads exactly as ungrouped (' + g.coverage.status + ', available ' + g.period.fromTodayFunding.availableNow + ')');
    check(!issues(g).includes('coverage-payment-group-unconfirmed'), name + ': never a group of another shape');
    if (c === groc && d === generic) {
      check(g.coverage.status === 'ready' && g.coverage.payments.length === 0 && g.coverage.reservedCash === 0,
        name + ': no payment; the refund covers the 80 purchase (reserve 0)');
      check(g.period.fromTodayFunding.availableNow === 300, name + ': available now 395 - 25 - 70 - 0 = 300 (got '
        + g.period.fromTodayFunding.availableNow + ')');
    }
  }
}

console.log(`  PASS  a Lunch Money card-payment group proves the payment's destination (${checks} checks)`);
