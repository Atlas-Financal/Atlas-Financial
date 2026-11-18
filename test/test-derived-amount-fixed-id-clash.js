'use strict';
/* Lead ask after #1369: an id named by more than one plan row (two bills, two obligations, or a bill and an
 * obligation) is ambiguous, so derivedAmountFixedBills never makes it a candidate. Before this, a bill/bill or
 * obligation/obligation pair silently overwrote one another in the candidate map, and the survivor could be fixed.
 *
 * Path: invented raw Lunch Money payloads (the live window plus the 200-day history read) -> scripts/provider-observe.js
 * -> scripts/live-plan.js (acceptance harness) -> served plan.
 *
 * Invented world: the acceptance harness base world as of Wed 2026-10-14 and invented monthly rows due on the 12th,
 * paid from chequing-a and identified by payee. Three completed $90 payments (Jul, Aug, Sep 12) would derive a lone
 * $90 row fixed. By hand: a lone row is fixed; any id that two rows share is never fixed, whichever row the
 * payments match.
 *
 * `node test/test-derived-amount-fixed-id-clash.js`
 */
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const pay = date => H.lm({ date, amount: 90, account: 'chequing-a', payee: 'Invented utility', category: 'Utilities' });
const HISTORY = ['2026-07-12', '2026-08-12', '2026-09-12'].map(pay);
const BILL = { id: 'utility', label: 'Invented utility', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed',
  payee: 'Invented utility' };
const OBLIGATION = { id: 'utility', debtId: 'utility', effect: 'payment', label: 'Invented utility loan', frequency: 'monthly',
  day: 12, anchor: '2026-07-12', amount: 90, confidence: 'confirmed', payingAccount: 'chequing-a' };
const DEBT = { id: 'utility', label: 'Invented utility loan', balance: 5000, rate: 5, payment: 90, confidence: 'confirmed' };
const RULE = { eventId: 'utility', payeePattern: 'Invented utility', atlasAccountId: 'chequing-a', direction: 'debit' };

function serve({ bills = [], obligations = [], obligationRule = false }) {
  const w = H.baseWorld();
  w.bills = bills;
  w.obligations = obligations;
  w.debts = obligations.length ? [DEBT] : [];
  // Bill rows carrying `payee` get their rule from the harness; obligation-only worlds name it explicitly.
  if (obligationRule || !bills.some(b => b.payee)) w.identityRules = (w.identityRules || []).concat([RULE]);
  w.transactions = [];
  w.amountHistory = { transactions: HISTORY };
  const r = H.observe(w);
  if (r.error) throw r.error;
  const fixed = [].concat(r.plan.bills || [], r.plan.obligations || []).filter(row => row.amountFixed === true);
  return { fixed };
}

console.log('1. Controls: a lone row derives fixed');
{
  ok(serve({ bills: [BILL] }).fixed.length === 1, 'a lone bill with three completed $90 payments: fixed');
  ok(serve({ obligations: [OBLIGATION] }).fixed.length === 1, 'a lone plain obligation with the same history: fixed');
}

console.log('2. An id two plan rows share is never fixed');
{
  const twoBills = serve({ bills: [BILL, { ...BILL, label: 'Invented utility (copy)' }] });
  ok(twoBills.fixed.length === 0, 'two bills sharing the id: neither is fixed', JSON.stringify(twoBills.fixed.map(r => r.label)));
  const twoObligations = serve({ obligations: [OBLIGATION, { ...OBLIGATION, label: 'Invented utility loan (copy)' }] });
  ok(twoObligations.fixed.length === 0, 'two obligations sharing the id: neither is fixed', JSON.stringify(twoObligations.fixed.map(r => r.label)));
  const billAndObligation = serve({ bills: [BILL], obligations: [OBLIGATION] });
  ok(billAndObligation.fixed.length === 0, 'a bill and an obligation sharing the id: neither is fixed',
    JSON.stringify(billAndObligation.fixed.map(r => r.label)));
}

console.log('3. A rejected id still counts as an identity conflict (Codex P2 on #1374)');
{
  // Two 'utility' rows (a clash) and one unique 'other' bill, all identified by the same payee on the same account.
  // By hand: every payment is identified by both ids, so it is ambiguous and fixes neither; 'other' is never fixed.
  const other = { ...BILL, id: 'other', label: 'Invented other' };
  const s = serve({ bills: [BILL, { ...BILL, label: 'Invented utility (copy)' }, other] });
  ok(s.fixed.length === 0, 'a unique bill sharing its payee with a clashing id is not fixed from those payments',
    JSON.stringify(s.fixed.map(r => r.id)));
  // The same holds when the other identifying row is a non-candidate obligation (a card minimum shape).
  const card = serve({ bills: [other], obligations: [{ ...OBLIGATION, statementOccurrences: [] }], obligationRule: true });
  ok(card.fixed.length === 0, 'a bill sharing its payee with a non-candidate obligation is not fixed from those payments',
    JSON.stringify(card.fixed.map(r => r.id)));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll amountFixed id-clash checks passed.');
