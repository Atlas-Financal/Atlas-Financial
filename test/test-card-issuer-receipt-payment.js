'use strict';
/* A posted TD "PAYMENT - THANK YOU" card credit is the issuer's receipt for a payment onto that card (Grok Bot ruling, Plan #6,
 * rule 17, 2026-11-17; test/test-td-payment-thank-you.js). The observer qualifies it as `tdCardPaymentCredit`, and Forecast
 * already reads that flag where it pairs payments (isTdCardPaymentCredit). The card publication did not: a posted credit that
 * carried the flag was published `credit-unconfirmed`, which withheld the card's whole Spent, so its repayment target fell to
 * the minimum ("new charges unavailable") and the Credit deduction, Balance After Deductions and Surplus followed. The card
 * publication now reads the same identity, for a posted, unambiguous card-side row only (public/forecast-card-period.js).
 *
 * The whole path is exercised, no stub: invented provider payload -> the real observer (Live.fromObservation) -> Forecast.recommend
 * -> the Credit line, the Credit totals, Balance After Deductions and Surplus.
 *
 * World (test/fixtures/card-coverage-aggregate-world.js): income 1,000, one bill (the Travel card's 25 minimum, due on the as-of),
 * a 150 groceries hold, an 80 grocery purchase and 9 of interest on the Travel card, and the receipt for 105. Every expected figure
 * is worked by hand from the rules below, never read back from the code under test.
 *
 *   Spent (new charges) = 80 purchase + 9 interest = 89; the receipt is neither a charge nor spending.
 *   Target = max(minimum 25, new charges 89, over-limit 0) = 89, counted once.
 *   Already counted above = the 80 purchase, which the groceries hold deducts; countedOffset = min(89, 80) = 80.
 *   Deduction = max(0, 89 - 80) = 9; the bills already hold the 25 minimum, so the card term is 9 - 25 = -16.
 *   Balance After Deductions = 1,000 - 25 (bills) - 150 (hold) - (-16) = 841; Surplus = 841 (nothing held, nothing beyond).
 *   Before the repair the receipt withheld Spent: target = minimum 25 (a lower bound), deduction 25, 1,000 - 25 - 150 - 0 = 825, estimated.
 *
 * Invented data only. `node test/test-card-issuer-receipt-payment.js`
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const { world } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' - ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);
const ROOT = path.join(__dirname, '..');

// Main before this repair (the card publication that never read the receipt flag), for the byte-for-byte "before" reading.
const BASE = '06759b5c115275a0632137723dfefde126877042';
const FILES = ['public/display-name.js', 'public/forecast-card-period.js', 'public/forecast.js'];
const show = file => cp.execFileSync('git', ['show', BASE + ':' + file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const readNow = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
function engineOf(source) {
  const c = { console };
  c.window = c;
  vm.createContext(c);
  for (const file of FILES) vm.runInContext(source(file), c);
  return c.Forecast;
}
const OLD = engineOf(show);

const synced = x => { x.payload.accounts[3].last_fetch = x.asOf + 'T17:00:00Z'; x.payload.accounts[3].plaid_last_successful_update = x.asOf + 'T17:00:00Z'; };
// The observer, then Forecast, with the card evidence the page route carries (as test-card-target-credit-deduction.js does).
function advise(rows, engine = F, extra = {}, editPacket) {
  const x = world(rows, { edit: synced, ...extra });
  const o = Live.fromObservation(x);
  const ov = o.data.liveOverlay;
  if (editPacket) editPacket(ov.currentPeriodActuals.transactions);
  return engine.recommend(o.data.plan, x.asOf, { debts: o.data.debts, currentPeriodActuals: ov.currentPeriodActuals,
    cardPeriodBalanceEvidence: ov.cardPeriodBalanceEvidence, cardLiveOverlay: { applied: true, overlays: ov.overlays } });
}
const active = r => r.payPeriodViews.find(p => p.role === 'active');
const lineOf = (v, id = 'travelvisa') => v.stackSummary.credit.lines.find(l => l.id === id);
const kinds = line => line.transactions.map(t => t.kind);

const transfer = { category_name: 'Transfer' };
const purchase = ['card', 80, null, 'purchase'];
const interest = ['card', 9, null, 'purchase', { payee: 'INTEREST CHARGES', category_name: 'Interest' }];
const receipt = (amount = 105, extra = {}) => ['card', -amount, null, 'credit',
  { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', ...transfer, ...extra }];
const payerDebit = (amount = 105) => ['bills', amount, null, 'cash',
  { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', ...transfer }];
const isReceipt = t => t.amount === -105;
const charges = [purchase, interest];

// What the household was shown before this repair, and what the same Credit line must read without any receipt.
const withheldReading = v => {
  const l = lineOf(v);
  ok(l.spent.amount === null && l.spent.reasons.includes('card-credit-purpose-unconfirmed')
    && kinds(l).includes('credit-unconfirmed') && !kinds(l).includes('payment')
    && cents(l.target.amount) === 2500 && l.target.reasons.includes('new-charges-unavailable')
    && cents(l.deduction.amount) === 2500 && l.deduction.alreadyCounted === null
    && cents(v.balanceAfterDeductions) === 82500 && v.balanceAfterDeductionsTrust === 'estimated'
    && cents(v.stackSummary.surplus.amount) === 82500 && v.stackSummary.surplus.trust === 'estimated',
  'withheld: Spent unavailable (credit unconfirmed), target the 25.00 minimum, deduction 25.00, Balance After Deductions and Surplus 825.00 estimated',
  JSON.stringify([l.spent, l.target, l.deduction, v.balanceAfterDeductions]));
};

console.log('1. The repair: the posted receipt is a card-side payment, so the period\'s charges are known again');
{
  // The observer qualifies the receipt and publishes only the flag, never the bank description.
  const x = world([purchase, interest, receipt()], { edit: synced });
  const observed = Live.fromObservation(x).data.liveOverlay.currentPeriodActuals.transactions.find(isReceipt);
  ok(observed && observed.tdCardPaymentCredit === true && !observed.cardPaymentIdentity && !observed.kindHint
    && !('original_name' in observed) && !('originalName' in observed) && !observed.displayedPayee,
  'the real observer stamps tdCardPaymentCredit on the receipt and publishes no description, kind hint or payer identity',
  JSON.stringify(observed));

  withheldReading(active(advise([...charges, receipt()], OLD)));

  const v = active(advise([...charges, receipt()]));
  const l = lineOf(v);
  ok(kinds(l).join() === 'charge,interest,payment' && l.transactions.find(t => t.amount === -105).payment === true,
    'the receipt row is published as a payment (kind payment), not a credit of unconfirmed purpose', JSON.stringify(kinds(l)));
  ok(cents(l.spent.amount) === 8900 && l.spent.trust === 'calculated' && l.spent.reasons.length === 0,
    'Spent is known again: 80.00 + 9.00 = 89.00, calculated, the receipt not counted as spending', JSON.stringify(l.spent));
  ok(cents(l.target.amount) === 8900 && cents(l.target.newCharges) === 8900 && cents(l.target.minimum) === 2500
    && l.target.trust === 'calculated' && l.target.reasons.length === 0,
  'target max(25.00, 89.00, 0) = 89.00, calculated, no "new charges unavailable"', JSON.stringify(l.target));
  ok(cents(l.deduction.alreadyCounted) === 8000 && cents(l.deduction.countedOffset) === 8000 && cents(l.deduction.amount) === 900
    && l.deduction.beyondMinimumPaid === 0 && cents(l.deduction.target) === 8900 && l.deduction.trust === 'calculated',
  'deduction 89.00 - 80.00 already counted above (the nonzero offset) = 9.00', JSON.stringify(l.deduction));
  ok(cents(v.predictedEndingBalanceTerms.cardRepaymentAdjustment) === -1600 && cents(v.balanceAfterDeductions) === 84100
    && v.balanceAfterDeductionsTrust == null, 'Balance After Deductions 1,000 - 25 - 150 - (9 - 25) = 841.00, card term -16.00, calculated',
  JSON.stringify([v.predictedEndingBalanceTerms, v.balanceAfterDeductions, v.balanceAfterDeductionsTrust]));
  const s = v.stackSummary.surplus;
  ok(cents(s.amount) === 84100 && cents(s.terms.credit) === 900 && s.trust === 'calculated',
    'Surplus 841.00 = Balance After Deductions (nothing held, nothing beyond), its Credit term 9.00, calculated', JSON.stringify(s));
  // The receipt is a payment, not spending: nothing changes against the same ledger without it.
  const none = active(advise(charges));
  ok(JSON.stringify([none.balanceAfterDeductions, none.stackSummary.surplus, lineOf(none).spent, lineOf(none).target, lineOf(none).deduction])
    === JSON.stringify([v.balanceAfterDeductions, v.stackSummary.surplus, l.spent, l.target, l.deduction]),
  'the same ledger without the receipt publishes the identical Spent, target, deduction, Balance After Deductions and Surplus');
  // No paying account is observed here: the receipt is never read as Paid back (it is the card's side, not the payer's).
  ok(l.paidBack.amount === null && l.paidBack.reasons.includes('paying-account-not-observed') && l.paidToward.amount === null
    && l.stillToPayBack.amount === null && l.paid.amount === 105 && l.paid.trust === 'estimated'
    && l.paid.reasons.includes('card-payment-unconfirmed'),
  'with no payer observed, Paid back stays unavailable (the receipt is not read as Paid back); the card-side Paid is 105.00, estimated',
  JSON.stringify([l.paidBack, l.stillToPayBack, l.paid]));
}

console.log('2. Payer-side control: the debit that funded the receipt and the receipt are one payment, never two');
{
  const rows = [...charges, payerDebit(), receipt()];
  const v = active(advise(rows)), l = lineOf(v);
  ok(cents(l.paidBack.amount) === 10500 && l.paidBack.trust === 'calculated' && cents(l.paidToward.amount) === 10500,
    'Paid back is the payer\'s 105.00 once (not 210.00 from the debit plus the receipt)', JSON.stringify(l.paidBack));
  ok(cents(l.paid.amount) === 10500 && l.paid.trust === 'calculated' && cents(l.spent.amount) === 8900
    && l.stillToPayBack.amount === 0 && l.targetCovered.value === true && l.minimumCovered.value === true,
  'card-side Paid 105.00 (the receipt, once), Spent 89.00, Still to pay back 0.00 (105.00 against the 89.00 target), covered',
  JSON.stringify([l.paid, l.spent, l.stillToPayBack, l.targetCovered, l.minimumCovered]));
  const totals = v.stackSummary.credit.totals;
  ok(cents(totals.minimumsPaid.amount) === 10500 && totals.minimumsCoveredCount === 1,
    'the Credit head\'s paid side reads 105.00 once, with the one due minimum covered', JSON.stringify(totals.minimumsPaid));
  ok(cents(l.deduction.amount) === 900 && cents(v.balanceAfterDeductions) === 84100 && cents(v.stackSummary.surplus.amount) === 84100,
    'the payer-side debit moves no Credit figure: deduction 9.00, Balance After Deductions and Surplus 841.00',
    JSON.stringify([l.deduction.amount, v.balanceAfterDeductions, v.stackSummary.surplus.amount]));
  // Before the repair the payer side was already read once; only Spent and the target were withheld.
  const old = active(advise(rows, OLD)), ol = lineOf(old);
  ok(cents(ol.paidBack.amount) === 10500 && ol.spent.amount === null && ol.stillToPayBack.amount === null,
    'control: on main the payer side already counted the 105.00 once; only Spent and Still to pay back were withheld',
    JSON.stringify([ol.paidBack, ol.spent, ol.stillToPayBack]));
}

console.log('3. Pending and unknown stay withheld, exactly as before');
{
  const pending = active(advise([...charges, receipt(105, { is_pending: true })]));
  withheldReading(pending);
  const wrongText = active(advise([...charges, receipt(105, { original_name: 'PAYMENT THANK YOU' })]));
  withheldReading(wrongText);
  // A credit with the bank's other wording, whatever its sign, amount or category, is never inferred a payment.
  withheldReading(active(advise([...charges, ['card', -105, null, 'credit', { payee: 'Invented credit', original_name: 'Invented credit', ...transfer }]])));
  withheldReading(active(advise([...charges, ['card', -105, null, 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'Invented credit',
    category_name: 'Credit Card Payment' }]])));
  // The receipt's exact description on a card outside the mapped TD cards (invented mbna): not a payment.
  const other = active(advise([...charges, ['card2', -40, null, 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', ...transfer }]],
    F, { twoCards: true }));
  const ol = lineOf(other, 'mbna');
  ok(kinds(ol).join() === 'credit-unconfirmed' && ol.spent.reasons.includes('card-credit-purpose-unconfirmed')
    && kinds(lineOf(other)).join() === 'charge,interest' && cents(lineOf(other).spent.amount) === 8900,
  'the same receipt text on another card (not a mapped TD card) stays credit-unconfirmed; Travel is unaffected',
  JSON.stringify([kinds(ol), ol.spent]));
}
const rowKind = v => {
  const rows = v.stackSummary.credit.lines.flatMap(l => l.transactions).filter(t => t.amount === -105);
  assert.equal(rows.length, 1, 'the receipt is published once');
  return rows[0].kind;
};
// Rows edited after the observer: each is a way the flag could reach the card publication without a qualified posted receipt.
// [name, edit, still on the Travel line (its Spent is then withheld), extra world options]
const EDITS = [
  ['flag removed (a negative credit is never a payment by sign or amount)', t => { delete t.find(isReceipt).tdCardPaymentCredit; }, true],
  ['pending/posted pairing ambiguous', t => { t.find(isReceipt).pendingPostedAmbiguous = true; }, true],
  ['pending/posted duplicate', t => { t.find(isReceipt).pendingPostedDuplicate = true; }, true],
  ['contradictory evidence', t => { t.find(isReceipt).contradictoryEvidence = true; }, true],
  ['posting evidence is pending', t => { t.find(isReceipt).savingsPostingEvidence = 'pending'; }, true],
  ['the packet row itself is pending', t => { t.find(isReceipt).pending = true; }, true],
  ['a conflicting kind hint (refund)', t => { t.find(isReceipt).kindHint = 'refund'; }, true],
  ['conflicting account identity (accountId names another card)', t => { t.find(isReceipt).accountId = 'mbna'; }, true],
  ['not a mapped TD card account', t => { const r = t.find(isReceipt); r.atlasAccountId = 'mbna'; r.account = 'mbna'; r.accountId = 'mbna'; }, false,
    { twoCards: true }],
];
for (const [name, edit, staysOnTravel, extra] of EDITS) {
  const v = active(advise([...charges, receipt()], F, extra || {}, edit));
  ok(rowKind(v) === 'credit-unconfirmed' && (!staysOnTravel || (lineOf(v).spent.amount === null && cents(v.balanceAfterDeductions) === 82500)),
    'stays withheld, not a payment: ' + name, JSON.stringify([rowKind(v), lineOf(v).spent, v.balanceAfterDeductions]));
}

console.log('4. Each qualification is load-bearing: the repaired source with it removed fails its control');
{
  const source = readNow('public/forecast-card-period.js');
  const mutant = (from, to) => {
    assert.equal(source.split(from).length - 1, 1, 'mutation anchor appears once: ' + from);
    return engineOf(file => file === 'public/forecast-card-period.js' ? source.replace(from, to) : readNow(file));
  };
  const edit = name => EDITS.find(e => e[0].startsWith(name));
  // The repaired source keeps the case withheld; the mutant, written without that qualification, publishes a payment.
  const kindOf = (engine, rows, [, editPacket, , extra]) => rowKind(active(advise(rows, engine, extra || {}, editPacket)));
  const noEdit = [null, undefined];
  const CASES = [
    ['posted only (a pending receipt)', "tx.pending === false && tx.savingsPostingEvidence === 'posted'", 'true',
      [...charges, receipt(105, { is_pending: true })], noEdit],
    ['the flag, not the sign (an unflagged credit)', 'const issuerReceipt = ', 'const issuerReceipt = value != null && value < 0 || ',
      [...charges, receipt()], edit('flag removed')],
    ['no conflicting kind hint', "value < 0 && hint === ''", 'value < 0',
      [...charges, receipt()], edit('a conflicting kind hint')],
    ["Forecast's one receipt identity (a conflicting account identity)", 'primitives.tdCardPaymentCredit(tx) === true', 'true',
      [...charges, receipt()], edit('conflicting account identity')],
    ["Forecast's one receipt identity (not a mapped TD card)", 'primitives.tdCardPaymentCredit(tx) === true', 'true',
      [...charges, receipt()], edit('not a mapped TD card')],
  ];
  for (const [name, from, to, rows, e] of CASES) {
    const before = kindOf(F, rows, e), mutated = kindOf(mutant(from, to), rows, e);
    ok(before === 'credit-unconfirmed' && mutated === 'payment',
      'mutant: without "' + name + '" the receipt becomes a payment (repaired source: ' + before + ')', mutated);
  }
}

console.log(`
PASS card issuer receipt payment (${checks})`);
