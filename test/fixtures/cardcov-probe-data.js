'use strict';
// Synthetic household for the cardCoverageState probe-reuse test. Every value is invented (seeded PRNG).
// Only structural COUNTS mirror the committed plan (4 income, 8 obligations,
// 33 bills, 18 commitments, 7 debts, 4 funding options, 21 categories).
let seed = 20261015;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = a => a[Math.floor(rnd() * a.length)];
const money = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
const AS_OF = '2026-10-14', OPENING = '2026-10-09', START = '2026-10-09';
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const cash = ['chequing-a', 'chequing-b', 'savings'];
function build(scale = 1, seedValue = 20261015, options = {}) {
  const cardPurchases = options.cardPurchases !== false;
  seed = seedValue;
  const n = k => Math.max(1, Math.round(k * scale));
  const debts = [];
  for (let i = 0; i < n(7); i++) debts.push({ id: 'card' + i, label: 'Invented card ' + i, structure: i === 0 ? 'HELOC' : 'Revolving',
    secured: i === 0, balance: money(500, 9000), pending: 0, limit: money(10000, 20000), rate: money(4, 22) });
  const income = [
    { id: 'payroll', label: 'Invented payroll', frequency: 'biweekly', anchor: START, amount: money(3000, 4200), confidence: 'confirmed' },
    { id: 'partner15', label: 'Invented partner pay A', frequency: 'monthly', day: 15, amount: money(1200, 1600), confidence: 'confirmed' },
    { id: 'partnerEnd', label: 'Invented partner pay B', frequency: 'monthly', day: 28, amount: money(1200, 1600), confidence: 'confirmed' },
    { id: 'benefit', label: 'Invented benefit', frequency: 'monthly', day: 20, amount: money(200, 600), confidence: 'estimated' },
  ].slice(0, n(4));
  const freqs = ['monthly', 'monthly', 'monthly', 'biweekly', 'quarterly', 'yearly'];
  const bills = [];
  for (let i = 0; i < n(33); i++) {
    const f = pick(freqs), b = { id: 'bill' + i, label: 'Invented bill ' + i, frequency: f, amount: money(15, 600),
      confidence: rnd() < 0.7 ? 'confirmed' : 'estimated', payingAccount: pick(['chequing-a', 'chequing-b']) };
    if (f === 'monthly') b.day = 1 + Math.floor(rnd() * 28);
    if (f === 'biweekly') b.anchor = addDays(START, Math.floor(rnd() * 14));
    if (f === 'quarterly') { b.day = 1 + Math.floor(rnd() * 28); b.firstDue = addDays(AS_OF, 5 + Math.floor(rnd() * 80)); }
    if (f === 'yearly') { const d = addDays(AS_OF, 10 + Math.floor(rnd() * 300)); b.firstDue = d; b.month = +d.slice(5, 7); b.day = +d.slice(8, 10); }
    bills.push(b);
  }
  const obligations = [];
  for (let i = 0; i < n(8); i++) obligations.push({ id: 'ob' + i, label: 'Invented minimum ' + i, debtId: debts[i % debts.length].id,
    effect: 'payment', frequency: 'monthly', day: 1 + Math.floor(rnd() * 28), amount: money(25, 300), confidence: 'confirmed', payingAccount: 'chequing-a' });
  const commitments = [];
  for (let i = 0; i < n(18); i++) commitments.push({ id: 'c' + i, label: 'Invented plan ' + i, group: 'g' + (i % 2),
    date: addDays(AS_OF, 7 + Math.floor(rnd() * 330)), amount: money(50, 2500), confidence: rnd() < 0.5 ? 'confirmed' : 'estimated', sinkingFund: rnd() < 0.4 });
  const categories = [];
  for (let i = 0; i < n(21); i++) categories.push({ id: 'cat' + i, label: 'Invented category ' + i, class: rnd() < 0.5 ? 'essential' : 'discretionary',
    from: ['ProvCat' + i], plannedPayday: money(20, 450), confidence: 'confirmed' });
  const data = {
    meta: { asOf: OPENING, title: 'Synthetic loading-perf household' },
    accounts: [], revolvingExtra: [], debts,
    plan: {
      windowDays: 91, opening: { asOf: OPENING },
      cardPurchaseCoverage: require('./card-coverage-opening')(OPENING),
      startingCash: { breakdown: cash.map(id => ({ id, label: 'Invented ' + id, value: money(100, 2500) })) },
      defaults: { targetBuffer: 300, extraDebtMonthly: 0, scenario: 'expected' },
      income, bills, obligations, commitments,
      groups: [{ id: 'g0', label: 'Invented group 0', planSpendSummary: true }, { id: 'g1', label: 'Invented group 1' }],
      funding: { heading: 'Cover the gap', note: '', options: [0, 1, 2, 3].map(i => ({ id: 'pot' + i, label: 'Invented pot ' + i, short: 'pot' + i, available: money(0, 3000), rank: i + 1 })) },
      budget: { categories },
    },
  };
  const accountMap = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture', mappings: [
    ...cash.map((id, i) => ({ providerAccountId: String(1001 + i), canonical: { collection: 'cash', id }, atlasRole: 'household-cash' })),
    ...debts.map((d, i) => ({ providerAccountId: String(2001 + i), canonical: { collection: 'debts', id: d.id }, atlasRole: 'revolving-credit' })) ] };
  const provCats = categories.map((c, i) => ({ id: 100 + i, name: 'ProvCat' + i, is_income: false, exclude_from_totals: false }))
    .concat([{ id: 900, name: 'Income', is_income: true, exclude_from_totals: false }]);
  const txs = []; let tid = 50000;
  const tx = (account, date, amount, payee, category) => ({ id: tid++, account_id: account, date, amount, currency: 'cad', payee, category_id: category, is_pending: false, status: 'cleared' });
  txs.push(tx(1001, START, -income[0].amount, 'Invented payroll employer', 900));
  for (let i = 0; i < n(140); i++) {
    const d = addDays(START, Math.floor(rnd() * 6));
    const toCard = rnd() >= 0.6, cardIx = Math.floor(rnd() * debts.length);
    const acct = toCard && cardPurchases ? 2001 + cardIx : 1002;
    txs.push(tx(acct, d, money(3, 180), 'Invented merchant ' + (i % 37), 100 + Math.floor(rnd() * categories.length)));
  }
  const payload = { provider: 'lunchmoney', fetchedAt: AS_OF + 'T18:00:00.000Z',
    transactionWindow: { startDate: START, endDate: AS_OF, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, truncated: false },
    accounts: [...cash.map((id, i) => ({ id: 1001 + i, type: 'cash', balance: data.plan.startingCash.breakdown[i].value })),
      ...debts.map((d, i) => ({ id: 2001 + i, type: 'credit', balance: d.balance, credit_limit: d.limit }))]
      .map(a => ({ ...a, currency: 'cad', updated_at: AS_OF + 'T17:55:00.000Z', balance_last_update: AS_OF + 'T17:55:00.000Z' })),
    categories: provCats, tags: [], transactions: txs };
  const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [
    { eventId: 'payroll', payeePattern: 'Invented payroll employer', atlasAccountId: 'chequing-a', direction: 'credit' }], billPaymentPayees: [] };
  const periods = { asOf: OPENING, thisMonth: '2026-10', lastMonth: '2026-09', source: { note: 'synthetic' }, periods: {}, monthly: [] };
  return { data, accountMap, payload, identity, periods, AS_OF };
}
module.exports = { build };
