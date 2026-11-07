'use strict';
// Real Budget main view, stepped back to a completed period, invented data:
// internet 60 paid, water 120 unpaid. The period's Bills step prints
// Not confirmed paid $120.00 (paid + not confirmed = total), never
// "Remaining bills to pay $0.00".
// NODE_PATH=<playwright> CHROME_PATH=<chromium> node test/browser-completed-period-remaining-bills.js
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');
(async () => {
  const w = H.baseWorld();
  w.bills = [
    { id: 'net', label: 'Invented internet', amount: 60, frequency: 'monthly', day: 28, confidence: 'confirmed', payee: 'Invented net co' },
    { id: 'water', label: 'Invented water', amount: 120, frequency: 'monthly', day: 1, confidence: 'confirmed', payee: 'Invented water co' },
  ];
  w.transactions = [
    H.lm({ id: 900001, date: '2026-09-25', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ id: 900002, date: '2026-09-28', amount: 60, category: 'Internet', account: 'chequing-a', payee: 'Invented net co' }),
    H.lm({ id: 900004, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
  ];
  try {
    await H.withBudget(w, async p => {
      await p.step(-1);
      const s = await H.snap(p);
      assert.match(s.range, /Sep 25/, 'stepped back to the completed period');
      const bills = H.section(s, 'Bills');
      assert.match(bills, /Total bills this period\s*\$180\.00/);
      assert.match(bills, /Paid bills this period\s*\$60\.00/);
      assert.match(bills, /Not confirmed paid\s*\$120\.00/, 'the unpaid water bill is not confirmed paid');
      assert.doesNotMatch(bills, /Remaining bills to pay/, 'no $0 remaining beside an unpaid row');
      assert.match(H.bill(s, 'Invented water'), /To confirm/);
      assert.deepEqual(p.errors, []);
    });
    console.log('  PASS  browser: a completed period shows the unpaid bill as not confirmed paid');
  } finally { await H.closeBrowser(); }
})().catch(e => { console.error(e); process.exit(1); });
