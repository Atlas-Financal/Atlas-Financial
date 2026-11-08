'use strict';
// Rendered-page half of test-savings-dated-balance-item-liability.js (#930).
// Registered node suites cannot open Chromium in the hosted standard job
// (Playwright is not a runtime dependency), so the two headline page cases
// live here as a browser-*.js proof, like test/browser-savings-owner-confirmed-paid.js.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');

const TRIP_LINK = { categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
  effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' };

// A 600 trip (Nov 20, linked to the Trip category) and a 600 gift (Dec 10).
function world(savings, balanceDate, purchases, { card = false, aggregate = true } = {}) {
  const w = H.baseWorld();
  const sav = w.accounts.find(a => a.id === 'savings');
  sav.value = savings;
  if (balanceDate) sav.balanceDate = balanceDate;
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true },
  ];
  w.savingsPool = {};
  w.links = [TRIP_LINK];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...purchases.map(p => H.lm({ category: 'Trip', payee: 'Invented airline', ...p }))];
  if (card) {
    w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
    w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
      pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
    if (aggregate) w.planPatch = plan => { plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
      opening: { asOf: '2026-10-09', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } }; };
  }
  return w;
}
const cardCharge = (amount, date = '2026-10-11') => ({ date, amount, account: 'travelvisa', providerAccountId: 9004 });
const savingsCardPayment = (amount, date) => [
  { date, amount, account: 'savings', payee: 'Invented card payment', category: 'Transfer', raw: { category_name: 'Credit Card Payment' } },
  { date, amount: -amount, account: 'travelvisa', providerAccountId: 9004, payee: 'PAYMENT - THANK YOU', category: 'Transfer',
    raw: { category_name: 'Credit Card Payment' } }];

// ------------------------------------------------- the page a household reads
(async () => {
  try {
    const read = async w => H.withBudget(w, async p => {
      const s = await H.snap(p);
      return { trip: H.goal(s, 'Invented trip'), gift: H.goal(s, 'Invented gift'), savings: s.savings };
    });
    for (const [why, w] of [
      ['direct', world(1000, '2026-10-10', [{ date: '2026-10-12', amount: 500, account: 'savings' }])],
      ['card', world(1000, '2026-10-10', [cardCharge(500), ...savingsCardPayment(500, '2026-10-12')], { card: true })]]) {
      const s = await read(w);
      assert.match(s.savings, /Reported combined savings: \$1,000\.00/, why + ': the dated report stays visible');
      assert.match(s.trip, /\$100\.00\s*Saved.*Paid \$500\.00/, why + ': trip saved 100, paid 500');
      assert.match(s.gift, /\$400\.00\s*Saved/, why + ': gift saved 400');
      assert.match(s.gift, /Still to fund ≈ estimated \$200\.00/, why + ': gift still to fund 200');
    }
    console.log('savings dated balance item liability: engine and page checks passed');
  } finally {
    await H.closeBrowser();
  }
})().catch(e => { console.error(e); process.exit(1); });
