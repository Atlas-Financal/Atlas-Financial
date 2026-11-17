'use strict';
// Browser proof of the Bills section (partly-paid PR; Grok rule 17, bill-payment confirmation): the real page, fed by the real
// observer -> live overlay -> Forecast path with invented Lunch Money rows, prints
//   - "Partly paid · $X still to pay" for a posted payment below the plan (at any shortfall, even one cent),
//   - "Payment pending" for a pending linked payment, never Paid,
//   - plain "Paid" for an exact payment, and nothing else changes.
// Expectations are written by hand from the rules. Invented numbers only. Run by hand like the other browser proofs.
//
// `node test/browser-bills-partly-paid.js`
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const world = (...txs) => {
  const w = H.baseWorld();
  w.bills = [HYDRO];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }), ...txs];
  return w;
};
// The Bills-tile dot state the face prints for the row (budget-blend.js billState -> data-s).
const dot = p => p.page.locator('.blend-bill-item[data-blend-bill^="hydro:"]').first().getAttribute('data-s');
const pay = (amount, extra = {}) => H.lm({ date: '2026-10-12', amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro', ...extra });

(async () => {
  try {
    console.log('Bills section');
    await H.withBudget(world(pay(40)), async p => {
      const s = await H.snap(p); const line = H.bill(s, 'Invented hydro');
      ok(/Partly paid/.test(line) && /\$50\.00 still to pay/.test(line), '40 posted on a 90 bill: "Partly paid" with $50.00 still to pay', line);
      ok(!/\bPaid\b(?! ?·)(?!.*Partly)/.test(line.replace(/Partly paid/g, '')), 'the row is not labelled plain Paid', line);
      const state = await dot(p);
      ok(state === 'due', 'its Bills-tile dot is the still-to-pay state, never the Paid green', state);
      ok(p.errors.length === 0, 'no page errors', p.errors.join('; '));
    });
    await H.withBudget(world(pay(89.99)), async p => {
      const s = await H.snap(p); const line = H.bill(s, 'Invented hydro');
      ok(/Partly paid/.test(line) && /\$0\.01 still to pay/.test(line), 'one cent short: "Partly paid" with $0.01 still to pay (any shortfall)', line);
    });
    await H.withBudget(world(pay(90, { pending: true })), async p => {
      const s = await H.snap(p); const line = H.bill(s, 'Invented hydro');
      ok(/Payment pending|Pending/.test(line) && !/\$90\.00\s*Paid/.test(line), 'a pending 90: "Payment pending", never Paid', line);
    });
    await H.withBudget(world(pay(90)), async p => {
      const s = await H.snap(p); const line = H.bill(s, 'Invented hydro');
      ok(/\$90\.00\s*Paid/.test(line) && !/Partly|pending/i.test(line), 'an exact 90 is plain Paid (control)', line);
      const state = await dot(p);
      ok(state === 'paid', 'an exact 90 keeps the Paid dot (control)', state);
    });
    await H.withBudget(world(), async p => {
      const s = await H.snap(p); const line = H.bill(s, 'Invented hydro');
      ok(line && !/Paid|Partly|pending/i.test(line.replace(/Not paid/gi, '')), 'an unpaid bill is neither Paid, Partly paid nor pending (control)', line);
    });
  } catch (e) {
    failures++; console.error(e);
  } finally {
    await H.closeBrowser();
  }
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nPASS bills partly paid browser proof');
})();
