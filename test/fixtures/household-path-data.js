'use strict';
// One invented household, one pay period (Aug 14-27). No captured household
// values. Extend the incumbent Budget fixture; use the incumbent identity rules.
// This is an expected-results ledger, not a matcher, planner or saved ledger.
const base = require('./budget-funding-data');

// Supplied independently of Forecast: opening A=300/B=100; received pay=1000;
// recurring bill=120; Groceries=300 and Dining=100 per 14 days; floor=50;
// Sep 10 cost=900. Next period can contribute 1000 minus (120 + 300 + 100) = 480,
// so today must protect 900 minus 480 = 420. Opening cash is not period income.
const ledger = [
  { key: 'payday', date: '2026-08-14', a: 1300, b: 100, card: 0,
    groceries: 0, dining: 0, other: 0, pending: 0, billPaid: false,
    sees: 'Received pay is inside $1,400 cash once; $420 is proposed, $120 bill is still due.' },
  { key: 'purchases', date: '2026-08-17', a: 1115, b: 20, card: 0,
    groceries: 80 + 60, dining: 30, other: 35, pending: 60, billPaid: true,
    sees: 'The $120 bill is paid; $80 posted plus $60 pending groceries leaves $160; Other Spend is $35.' },
  { key: 'settlement', date: '2026-08-18', a: 1115, b: 20, card: 52,
    groceries: 80 + 52, dining: 30, other: 35, pending: 0, billPaid: true,
    sees: 'The uniquely linked $52 posting replaces $60 pending once, leaving $168 groceries.' },
  { key: 'refund-transfer', date: '2026-08-19', a: 1065, b: 90, card: 52,
    groceries: 80 + 52, dining: 30, other: 35, pending: 0, billPaid: true,
    sees: 'The $20 refund increases cash, not income; the $50 A-to-B transfer creates neither income nor spending.' },
  { key: 'ambiguous', date: '2026-08-20', a: 1065, b: 90, card: 77,
    groceries: 80 + 52 + 25, dining: 30, other: 35, pending: 25, billPaid: true,
    hold: 'pending-possible-replacement',
    sees: 'The unlinked $25 pending/posting pair stays unresolved; the posted purchase is shown and savings are withheld.' },
  { key: 'resolved', date: '2026-08-21', a: 1065, b: 90, card: 75,
    groceries: 80 + 52 + 23, dining: 30, other: 35, pending: 0, billPaid: true,
    sees: 'New directed identity makes the second purchase $23 once; savings return without inventing a correction store.' },
];

function expected(row) {
  // Existing test-current-period-other-residual-contract case 29 establishes
  // positive-purchase Spent: refunds appear on no Budget spending row. This
  // ledger keeps the cash refund separately; it does not impose a net basis.
  // Reconstruct cash independently of the separately supplied account stocks:
  // $400 opening + $1,000 received pay - the posted debits + the refund.
  // The internal transfer is a $50 debit and $50 credit, net zero.
  const postedDebits = row.billPaid ? 120 + 80 + 30 + 35 : 0;
  const refund = ['refund-transfer', 'ambiguous', 'resolved'].includes(row.key) ? 20 : 0;
  const cash = 300 + 100 + 1000 - postedDebits + refund;
  const uncoveredCard = row.card + row.pending; // No backfill in this invented ledger.
  const remainingHousehold = 300 - row.groceries + 100 - row.dining;
  const operatingBills = row.billPaid ? 0 : 120;
  return { ...row, cash, uncoveredCard, remainingHousehold, operatingBills,
    spent: row.groceries + row.dining + row.other,
    budgetHold: 300 + 100 + row.other,
    // The full-period Budget result does not include the $400 opening.
    periodIncome: 1000, afterBills: 1000 - 120,
    periodResult: 1000 - 120 - 300 - 100 - row.other,
    availableNow: cash - operatingBills - remainingHousehold - 50 - uncoveredCard,
    contribution: row.hold ? null : 420,
  };
}

function fixture(key = 'payday') {
  const index = ledger.findIndex(row => row.key === key);
  if (index < 0) throw new Error('Unknown household step: ' + key);
  const row = ledger[index], data = base();
  data.meta = { asOf: '2026-08-13', title: 'Synthetic household path' };
  data.plan.opening = { asOf: '2026-08-13' };
  data.plan.defaults.targetBuffer = 50;
  data.plan.defaults.scenario = 'expected';
  data.plan.startingCash.breakdown = [
    { id: 'chequing-a', label: 'Synthetic Bills', value: 300 },
    { id: 'chequing-b', label: 'Synthetic Weekly', value: 100 },
    { id: 'savings', label: 'Synthetic reserve', value: 0 },
  ];
  data.plan.bills = [{ id: 'shaw', label: 'Synthetic internet', frequency: 'biweekly',
    anchor: '2026-08-16', amount: 120, payingAccount: 'chequing-a', confidence: 'confirmed' }];
  data.plan.budget.categories.push({ id: 'restaurants', label: 'Dining', class: 'discretionary',
    from: ['Restaurants'], plannedPayday: 100, plannedWeekly: 50, confidence: 'confirmed' });
  data.plan.commitments[0] = { id: 'named-cost', label: 'Synthetic trip',
    date: '2026-09-10', amount: 900, confidence: 'confirmed' };
  data.debts = [{ id: 'travelvisa', label: 'Synthetic card', structure: 'Revolving',
    secured: false, balance: 0, pending: 0, rate: 0, limit: 2000 }];
  const map = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture', mappings: [
    { providerAccountId: '1001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
    { providerAccountId: '1002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
    { providerAccountId: '1003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-cash' },
    { providerAccountId: '2001', canonical: { collection: 'debts', id: 'travelvisa' }, atlasRole: 'revolving-credit' },
  ] };
  const tx = (id, date, account, amount, category, payee, extra = {}) => ({ id, date, account_id: account,
    amount, currency: 'cad', category_id: category, payee, is_pending: false, status: 'cleared', ...extra });
  data.plan.cardPurchaseCoverage = require('./card-coverage-opening')('2026-08-13');
  const transactions = [tx(91001, '2026-08-14', 1001, -1000, 14, 'SEASPAN synthetic payroll')];
  if (index >= 1) transactions.push(
    tx(91002, '2026-08-16', 1001, 120, null, 'Shaw Cable synthetic bill'),
    tx(91003, '2026-08-16', 1002, 80, 11, 'Synthetic grocer'),
    tx(91004, '2026-08-16', 1001, 30, 12, 'Synthetic cafe'),
    tx(91005, '2026-08-16', 1001, 35, 13, 'Synthetic gift'),
    tx(91006, '2026-08-17', 2001, 60, 11, 'Synthetic grocer card', { is_pending: true,
      status: 'unreviewed', plaid_metadata: { transaction_id: 'synthetic-pending-one' } }),
  );
  if (index >= 2) transactions.push(tx(91007, '2026-08-18', 2001, 52, 11, 'Synthetic grocer card',
    { plaid_metadata: { transaction_id: 'synthetic-posted-one', pending_transaction_id: 'synthetic-pending-one' } }));
  if (index >= 3) transactions.push(
    tx(91008, '2026-08-19', 1002, -20, 11, 'Synthetic grocer REFUND'),
    tx(91009, '2026-08-19', 1001, 50, 15, 'AB123 TFR-TO synthetic weekly'),
    tx(91010, '2026-08-19', 1002, -50, 15, 'AB123 TFR-FR synthetic bills'),
  );
  if (index >= 4) transactions.push(
    tx(91011, '2026-08-20', 2001, 25, 11, 'Synthetic second grocer', { is_pending: true,
      status: 'unreviewed', plaid_metadata: { transaction_id: 'synthetic-pending-two' } }),
    tx(91012, '2026-08-20', 2001, index >= 5 ? 23 : 25, 11, 'Synthetic second grocer',
      { plaid_metadata: { transaction_id: 'synthetic-posted-two',
        ...(index >= 5 ? { pending_transaction_id: 'synthetic-pending-two' } : {}) } }),
  );
  const payload = { provider: 'lunchmoney', fetchedAt: row.date + 'T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-13', endDate: row.date, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, truncated: false },
    accounts: [{ id: 1001, type: 'cash', balance: row.a }, { id: 1002, type: 'cash', balance: row.b },
      { id: 1003, type: 'cash', balance: 0 },
      { id: 2001, type: 'credit', balance: row.card, credit_limit: 2000 }]
      .map(a => ({ ...a, currency: 'cad', updated_at: row.date + 'T17:55:00.000Z', balance_last_update: row.date + 'T17:55:00.000Z' })),
    categories: [
      { id: 11, name: 'Groceries' }, { id: 12, name: 'Restaurants' }, { id: 13, name: 'Gifts' },
      { id: 14, name: 'Income', is_income: true }, { id: 15, name: 'Payment, Transfer', exclude_from_totals: true },
    ], transactions };
  return { data, map, payload, periods: { periods: { ytd: { label: 'Synthetic target basis', months: 1, spending: [] } } } };
}
function variant(mode) {
  const input = fixture('resolved');
  if (mode === 'missing') {
    // Same-date refresh must not fill a missing observed stock from canonical.
    input.data.meta.asOf = input.data.plan.opening.asOf = '2026-08-21';
    input.payload.accounts = input.payload.accounts.filter(a => a.id !== 1002);
  } else if (mode === 'stale') {
    input.payload.transactionWindow.endDate = '2026-08-20';
  } else if (mode === 'floor') {
    // $1,155 current cash - $1,000 unpaid bill - $215 remaining targets
    // = -$60, which is $185 below the $125 floor ($50 buffer plus $75 uncovered card). Future payday
    // income cannot fund an Aug 24 bill. No proposal is affordable now.
    input.data.plan.bills.push({ id: 'extra-operating', label: 'Synthetic extra bill',
      amount: 1000, date: '2026-08-24', frequency: 'once', confidence: 'confirmed' });
  } else throw new Error('Unknown household variant: ' + mode);
  return input;
}
module.exports = { fixture, variant, ledger: ledger.map(expected) };
