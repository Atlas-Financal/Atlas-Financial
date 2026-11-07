'use strict';
// Invented households for the early-income settlement proofs. Every account,
// amount, date and payee is invented; nothing here reads data.json or any
// household figure. Built on the acceptance harness world so the raw payload
// runs through scripts/live-plan.js fromObservation exactly as served.
//
// Weekly spending permission expectations are hand arithmetic, not Atlas
// output. With a zero buffer and no other spending, the binding low point is
// the day before the next payday (or the levy day when payday follows it):
//   weekly = floor5((opening cash + income still to arrive before the low
//            point - levy) * 7 / spending days from as-of to the low point)
// floor5 rounds down to the $5 permission step.
const H = require('../acceptance/harness');

const EARLY_RULE = 'covers-early-or-due-on-or-before-posting';

function base(asOf, openingAsOf, bills, spending) {
  const w = H.baseWorld(asOf);
  // No designated Savings pool here: Savings is an empty chequing-side
  // account so the live overlay has fresh evidence for every posted cash row.
  w.accounts = w.accounts.filter(a => !a.held);
  const savings = w.accounts.find(a => a.id === 'savings');
  savings.reserve = false;
  savings.role = 'household-cash';
  savings.value = 0;
  w.accounts.find(a => a.id === 'chequing-a').value = bills;
  w.accounts.find(a => a.id === 'chequing-b').value = spending;
  w.budget = [];
  w.planPatch = plan => {
    plan.opening = { asOf: openingAsOf, representedEvents: [] };
    for (const row of plan.startingCash.breakdown) {
      row.value = row.id === 'chequing-a' ? 1000 : row.id === 'savings' ? 0 : 100;
      row.evidenceDate = openingAsOf;
    }
  };
  return w;
}

// Repro 1. As-of Sat Oct 17, canonical opening Mon Oct 12 (1,000 + 100).
// Child benefit 250 is due Sun Oct 18 and posts Fri Oct 16 to chequing-b.
// Levy 1,000 Thu Oct 22; payroll 1,400 Fri Oct 23.
//   control (not yet posted): 1,100 + 250 - 1,000 = 350 over Oct 17..22
//     (6 days): 350 * 7 / 6 = 408.33 -> $405/week.
//   early (posted Fri):       1,350       - 1,000 = 350 -> $405/week.
//   ambiguous (two 250 credits Fri; observed balances as in early, the
//     other credit having been spent): the occurrence is withheld,
//     1,350 - 1,000 = 350 -> $405/week. Adding Oct 18 again would leave 600
//     at the low point and print a larger permission.
function childBenefit(state) {
  const spending = state === 'control' ? 100 : 350;
  const w = base('2026-10-17', '2026-10-12', 1000, spending);
  w.income.push({ id: 'childBenefit', label: 'Invented child benefit', frequency: 'monthly', day: 18, amount: 250, confidence: 'confirmed' });
  w.commitments = [{ id: 'levy', label: 'Invented levy', amount: 1000, date: '2026-10-22', confidence: 'confirmed' }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  // Privacy-stripped credit: no payee text, so only the weekend pairing
  // (amount + chequing-b + Fri-before-Sun) can identify it.
  const credit = id => H.lm({ id, date: '2026-10-16', amount: -250, category: 'Payroll', account: 'chequing-b',
    payee: null, originalName: null });
  if (state !== 'control') w.transactions.push(credit(910001));
  if (state === 'ambiguous') w.transactions.push(credit(910002));
  return w;
}

// Repro 2. As-of Sat Oct 31, canonical opening Mon Oct 26 (1,000 + 100).
// Rent 800 is due Sun Nov 1 with an early-or-due identity rule. Levy 1,500
// Wed Nov 4; payroll Fri Nov 6, so the low point is Thu Nov 5.
//   control (not yet posted): 1,100 + 800 - 1,500 = 400 over Oct 31..Nov 5
//     (6 days): 400 * 7 / 6 = 466.67 -> $465/week.
//   early (posted Fri Oct 30): 1,900       - 1,500 = 400 -> $465/week.
//   ambiguous (two tenant credits Oct 29 and Oct 30; observed balances as in
//     early): withheld, 1,900 - 1,500 = 400 -> $465/week.
function rent(state) {
  const bills = state === 'control' ? 1000 : 1800;
  const w = base('2026-10-31', '2026-10-26', bills, 100);
  w.windowStart = '2026-10-01';
  w.income.push({ id: 'rent', label: 'Invented rent', frequency: 'monthly', day: 1, amount: 800, confidence: 'confirmed' });
  w.commitments = [{ id: 'levy', label: 'Invented levy', amount: 1500, date: '2026-11-04', confidence: 'confirmed' }];
  w.transactions = [H.lm({ date: '2026-10-23', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  w.identityRules.push({ eventId: 'rent', payeePattern: 'Invented tenant', atlasAccountId: 'chequing-a', direction: 'credit',
    postingDateRule: EARLY_RULE, earlyPayLookaheadDays: 3 });
  if (state !== 'control') w.transactions.push(H.lm({ id: 920001, date: '2026-10-30', amount: -800, category: 'Payroll', account: 'chequing-a', payee: 'Invented tenant' }));
  if (state === 'ambiguous') w.transactions.push(H.lm({ id: 920002, date: '2026-10-29', amount: -800, category: 'Payroll', account: 'chequing-a', payee: 'Invented tenant' }));
  return w;
}

module.exports = { H, childBenefit, rent };
