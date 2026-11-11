'use strict';
/* Lunch Money's category wins over Atlas's text rules (finish-line audit
 * finding 4, #821 6788704527; Dale's standing decisions 6785314627 and
 * 6785378997: Lunch Money's category is the authority, and anything that
 * fits no budget or bill category is Other spending and counted).
 *
 * `node test/test-lm-category-wins.js`
 *
 * Every transaction below is invented. Each case runs through the real
 * engine (Forecast.recommend → the current pay period's householdBudget and
 * otherIncome), and the expected answer is reasoned from the invented facts,
 * not read back from the code under test.
 *
 *   1. Note words. A note or tag saying "mixed", "household", "split",
 *      "restaurant" or "eating out" (including Atlas's own "item:" notes)
 *      never moves a row Lunch Money filed as Groceries.
 *   2. ATM DEP. "ATM DEP" in a note or tag is not a bank ledger type, and a
 *      deposit Lunch Money filed under a household category is that
 *      category's refund, never automatic Other income.
 *   3. Rows that used to vanish land in their row or in Other: "Mortgage"
 *      with no planned mortgage payment, "Personal Loan Payment", and
 *      "Other Bank Fees" on a card. A card payment (TD "TFR-TO C/C" or
 *      CAN TIRE MC) stays a card payment under every label, including a
 *      spending one: it moves money between the household's own accounts
 *      and its purchases are already counted (lead ruling on #821).
 *   4. Conservation. A matrix of labels x accounts x payees x plans: every
 *      posted household debit lands in exactly one place, either one
 *      household row (a category or Other) or an owner whose cash is
 *      deducted elsewhere (planned bill or mortgage, transfer, card payment,
 *      business, interest, external, savings). A row dropped by a bare
 *      "bill-label" or "debt-payment" result with no planned coverage fails.
 */
const F = require('../public/forecast.js');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;

const AS_OF = '2026-09-01';

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }] },
    opening: { asOf: AS_OF, priorAsOf: '2026-08-28', representedEvents: [] },
    income: [{
      id: 'payroll', label: 'Payroll — invented', frequency: 'biweekly',
      anchor: '2026-08-14', amount: 4000, confidence: 'confirmed',
    }],
    bills: [],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedWeekly: 450, ownerLine: 'Groceries' },
        { id: 'household', label: 'Household', class: 'essential', plannedPayday: 40, ownerLine: 'Household' },
        { id: 'restaurants', label: 'Dining', class: 'discretionary', from: ['Restaurants', 'Dining'], plannedPayday: 200, ownerLine: 'Eating out' },
      ],
      excluded: [{ from: 'Business', why: 'invented business line' }],
    },
  };
}

const debts = [
  { id: 'cashback', label: 'Invented card', secured: false, structure: 'Revolving — test',
    balance: 200, rate: 19.99, payment: 20, pending: 0 },
];

function packet(txs) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: AS_OF, coverageStart: '2026-07-01', coverageThrough: AS_OF,
    pendingCoverage: 'complete', transactionCoverage: 'complete',
    representedActuals: [], transactions: txs,
  };
}
function current(txs, plan) {
  const advice = F.recommend(plan || syntheticPlan(), AS_OF, {
    targetBuffer: 500, debts, currentPeriodActuals: packet(txs), representedEvents: [],
  });
  return ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
}
const row = (p, id) => ((p && p.householdBudget) || []).find(r => r && r.id === id) || null;
const otherRow = p => ((p && p.householdBudget) || []).find(r => r && r.otherSpending) || null;
const reconIds = r => ((r && r.recon) || []).map(t => t && t.id).filter(Boolean);
const rowsHolding = (p, id) => ((p && p.householdBudget) || []).filter(r => reconIds(r).includes(id)).map(r => r.id);
const otherIncomeIds = p => (((p && p.otherIncome) || {}).items || []).map(r => String(r && r.id));

function grocery(id, extra) {
  return Object.assign({
    id, date: '2026-08-31', amount: 42.10, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash', atlasAccountId: 'chequing-a',
    displayedPayee: 'INVENTED FOODS 001', originalMerchant: 'INVENTED FOODS 001', merchantKnown: true,
  }, extra || {});
}

console.log('=== 1. a note or tag word never moves a categorised Groceries row ===');
{
  const words = [
    ['item: mixed nuts (Atlas item note)', { note: 'item: mixed nuts' }],
    ['note "household"', { note: 'household stuff too' }],
    ['note "split"', { note: 'split with neighbours' }],
    ['note "restaurant"', { note: 'restaurant gift card inside' }],
    ['note "eating out"', { note: 'eating out supplies' }],
    ['tag "mixed"', { tags: ['mixed'] }],
    ['served flag groceryMixed', { groceryMixed: true }],
  ];
  for (const [what, extra] of words) {
    const id = 'tx-g-' + what.replace(/[^a-z]+/gi, '-').toLowerCase();
    const p = current([grocery(id, extra)]);
    const g = row(p, 'groceries');
    ok(rowsHolding(p, id).length === 1 && rowsHolding(p, id)[0] === 'groceries',
      'Lunch Money Groceries stays Groceries — ' + what, JSON.stringify(rowsHolding(p, id)));
    ok(g && near(g.spent, 42.10), 'and Groceries spent is the purchase, once — ' + what, g ? String(g.spent) : 'no row');
    ok(!reconIds(otherRow(p)).includes(id), 'and it is not in Other spending — ' + what);
  }
  // Control: the same words on an uncategorised row change nothing either way
  // (it is Other because Lunch Money gave it no category, not because of a word).
  const p = current([grocery('tx-uncat-mixed', { categoryLabel: '', note: 'item: mixed nuts' })]);
  ok(reconIds(otherRow(p)).includes('tx-uncat-mixed'),
    'control: an uncategorised row with the same note is Other spending, counted');
}

console.log('\n=== 2. ATM DEP never makes a categorised credit Other income ===');
{
  const credit = (id, extra) => Object.assign({
    id, date: '2026-08-31', amount: -25.00, pending: false,
    accountRole: 'household-cash', atlasAccountId: 'chequing-a',
  }, extra || {});
  // 2a. Lunch Money filed a TD ATM deposit under Groceries: it is a grocery
  // refund (nets Groceries), not Other income. Groceries also has a 60.00
  // purchase so the refund has something to net against: 60 - 25 = 35.
  {
    const p = current([
      grocery('tx-g-buy', { amount: 60.00 }),
      credit('tx-atm-groc', { categoryLabel: 'Groceries',
        displayedPayee: 'TD ATM DEP 000123', originalMerchant: 'TD ATM DEP 000123' }),
    ]);
    ok(!otherIncomeIds(p).some(i => i.includes('tx-atm-groc')),
      'a Groceries-filed ATM deposit is not Other income', JSON.stringify(otherIncomeIds(p)));
    ok(near(row(p, 'groceries') && row(p, 'groceries').spent, 35),
      'and it nets Groceries once (60.00 − 25.00 = 35.00)', String(row(p, 'groceries') && row(p, 'groceries').spent));
  }
  // 2b. The served flag (descriptor stripped) under a household category.
  {
    const p = current([
      grocery('tx-g-buy2', { amount: 60.00 }),
      credit('tx-atm-flag', { categoryLabel: 'Groceries', externalCashDeposit: true, merchantKnown: true }),
    ]);
    ok(!otherIncomeIds(p).some(i => i.includes('tx-atm-flag')),
      'the flag-only ATM deposit under Groceries is not Other income either');
    ok(near(row(p, 'groceries') && row(p, 'groceries').spent, 35), 'and it nets Groceries once');
  }
  // 2c. "ATM DEP" only in a note or tag is not the bank's ledger type.
  for (const [what, extra] of [['note', { note: 'ATM DEP from garage sale' }], ['tag', { tags: ['ATM DEP'] }]]) {
    const id = 'tx-note-atm-' + what;
    const p = current([credit(id, { categoryLabel: '', displayedPayee: 'INVENTED SENDER', originalMerchant: 'INVENTED SENDER', ...extra })]);
    ok(!otherIncomeIds(p).some(i => i.includes(id)),
      '"ATM DEP" in a ' + what + ' does not make a credit Other income', JSON.stringify(otherIncomeIds(p)));
  }
  // 2d. Regression: a real TD ATM deposit under a non-household label
  // (Lunch Money's incumbent "Payment, Transfer") is still Other income.
  {
    const p = current([credit('tx-atm-xfer', { categoryLabel: 'Payment, Transfer', excludeFromTotals: true,
      displayedPayee: 'TD ATM DEP 000124', originalMerchant: 'TD ATM DEP 000124' })]);
    ok(otherIncomeIds(p).filter(i => i.includes('tx-atm-xfer')).length === 1,
      'control: a TD ATM deposit filed Payment, Transfer is still one Other income item', JSON.stringify(otherIncomeIds(p)));
  }
}


function withMortgage(plan) {
  plan.obligations = [{ id: 'mortgage', debtId: 'mortgage', effect: 'payment', label: 'Mortgage',
    frequency: 'monthly', anchor: '2026-08-15', amount: 1600, confidence: 'confirmed', payingAccount: 'chequing-a' }];
  return plan;
}
const mortgageDebt = { id: 'mortgage', label: 'Mortgage', secured: true, structure: 'Amortising',
  balance: 5000, rate: 3.64, payment: 1600, pending: 0 };
function debit(id, label, extra) {
  return Object.assign({
    id, date: '2026-08-31', amount: 37.25, pending: false, categoryLabel: label,
    accountRole: 'household-cash', atlasAccountId: 'chequing-a',
    displayedPayee: 'INVENTED PAYEE ' + id, originalMerchant: 'INVENTED PAYEE ' + id, merchantKnown: true,
  }, extra || {});
}
const CARD = { accountRole: 'revolving-credit', atlasAccountId: 'cashback' };

console.log('\n=== 3. rows that used to vanish land in their row or in Other ===');
{
  const cases = [
    ['Mortgage, no planned mortgage payment', debit('tx-mort', 'Mortgage'), syntheticPlan()],
    ['Personal Loan Payment', debit('tx-loan', 'Personal Loan Payment'), syntheticPlan()],
    ['Other Bank Fees on a card', debit('tx-fee', 'Other Bank Fees', CARD), syntheticPlan()],
  ];
  for (const [what, tx, plan] of cases) {
    const p = current([tx], plan);
    ok(rowsHolding(p, tx.id).length === 1 && rowsHolding(p, tx.id)[0] === otherRow(p).id,
      what + ' is Other spending, counted once', JSON.stringify(rowsHolding(p, tx.id)));
  }
  // Mortgage under a planned mortgage payment stays out of spending: the
  // debt walk deducts that cash (the incumbent double-deduction guard).
  {
    const plan = withMortgage(syntheticPlan());
    const tx = debit('tx-mort-planned', 'Mortgage', { amount: 1600 });
    const p = current([tx], plan);
    const cls = F.classifyCurrentPeriodTransaction(tx, plan, { currentPeriodActuals: packet([tx]) });
    ok(rowsHolding(p, tx.id).length === 0 && cls.kind === 'bill',
      'a Mortgage row under a planned mortgage payment is that payment, not spending', cls.kind + '/' + cls.reason);
  }
  // Card payments under a spending label stay card payments.
  for (const [what, extra] of [
    ['TD TFR-TO C/C under Groceries', { categoryLabel: 'Groceries', original_name: 'AB123 TFR-TO C/C',
      displayedPayee: 'AB123 TFR-TO C/C', originalMerchant: 'AB123 TFR-TO C/C' }],
    ['CAN TIRE MC under Shopping-like Household', { categoryLabel: 'Household',
      displayedPayee: 'CAN TIRE MC', originalMerchant: 'CAN TIRE MC' }],
  ]) {
    const tx = debit('tx-cardpay-' + what.slice(0, 6).replace(/\W/g, ''), 'x', extra);
    const plan = syntheticPlan();
    const p = current([tx], plan);
    const cls = F.classifyCurrentPeriodTransaction(tx, plan, { currentPeriodActuals: packet([tx]) });
    ok(rowsHolding(p, tx.id).length === 0 && cls.kind === 'card-payment',
      what + ' stays a card payment, not spending', cls.kind + '/' + cls.reason);
  }
}

console.log('\n=== 4. conservation: every posted household debit lands in exactly one place ===');
{
  // The owner each debit must have, decided from the invented INPUT facts
  // alone (label, payee identity, account, planned mortgage), never from the
  // engine's answer: null means "a household row (a category or Other)".
  // The engine must then return exactly that owner kind, or put the debit in
  // exactly one household row.
  const TRANSFER_LABELS = ['payment, transfer'];
  const expectedOwner = (tx, plan) => {
    const label = String(tx.categoryLabel || '').toLowerCase();
    if (/CAN TIRE MC|TFR-TO C\/C/.test(tx.displayedPayee)) return 'card-payment';
    // Issuer finance charges are card-only; chequing overdraft interest is spending.
    if (label === 'interest charge' && tx.accountRole === 'revolving-credit') return 'interest';
    if (TRANSFER_LABELS.includes(label)) return 'transfer';
    if (label === 'business') return 'business';
    if (label === 'mortgage' && (plan.obligations || []).some(o => o.debtId === 'mortgage' && Number(o.amount) > 0)) return 'bill';
    return null;
  };
  const LABELS = ['Groceries', 'Household', 'Restaurants', 'Mortgage', 'Personal Loan Payment',
    'Other Bank Fees', 'Insurance', 'Subscriptions', 'Bills', 'Shopping', '', 'Uncategorized',
    'Payment, Transfer', 'Business', 'Interest charge', 'Gifts'];
  const ACCOUNTS = [['cheq', {}], ['card', CARD]];
  const PAYEES = [
    ['plain', {}],
    ['cantire', { displayedPayee: 'CAN TIRE MC', originalMerchant: 'CAN TIRE MC' }],
    ['tdcard', { original_name: 'AB123 TFR-TO C/C', displayedPayee: 'AB123 TFR-TO C/C', originalMerchant: 'AB123 TFR-TO C/C' }],
    ['note', { note: 'item: mixed household split' }],
  ];
  let total = 0, placedOnce = 0;
  const misses = [];
  for (const [planName, makePlan] of [['no-mortgage', syntheticPlan], ['mortgage', () => withMortgage(syntheticPlan())]]) {
    const plan = makePlan();
    const txs = [];
    let n = 0;
    for (const label of LABELS) for (const [acct, a] of ACCOUNTS) for (const [payee, pe] of PAYEES) {
      if (payee === 'tdcard' && acct === 'card') continue; // a TFR-TO leg posts on chequing
      txs.push(debit(`m-${planName}-${n++}`, label, Object.assign({ amount: 10 + n / 100 }, a, pe)));
    }
    const p = current(txs, plan);
    const opts = { currentPeriodActuals: packet(txs) };
    for (const tx of txs) {
      total++;
      const rows = rowsHolding(p, tx.id);
      const cls = F.classifyCurrentPeriodTransaction(tx, plan, opts);
      const owner = expectedOwner(tx, plan);
      const once = owner === null ? rows.length === 1 : (rows.length === 0 && cls.kind === owner);
      if (once) placedOnce++;
      else misses.push(`${tx.categoryLabel || '(none)'}|${tx.atlasAccountId}|${tx.displayedPayee.slice(0, 12)}|${planName} → expected ${owner || 'one household row'}, got rows ${JSON.stringify(rows)} ${cls.kind}/${cls.reason}`);
    }
  }
  ok(misses.length === 0, `all ${total} invented debits land in exactly one place (${placedOnce} did)`,
    misses.slice(0, 12).join('\n        '));
}

console.log(`\n${checks} checks, ${failures} failed`);
if (failures) process.exit(1);
console.log('All Lunch Money category checks passed.');
