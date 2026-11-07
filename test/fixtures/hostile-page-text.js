'use strict';
// Invented hostile text for the page-renderer escaping proofs. No household
// value, payee, merchant, provider id or balance appears here: every string is
// made up, and every amount is a small round invented number. The base is the
// invented Budget-surface household (./budget-surface-data), so the real
// Forecast functions the pages call accept it unchanged.
//
// The strings model what an outside feed can carry: a Lunch Money category
// name, a bank description or a note typed elsewhere. Each must reach the page
// as the same characters, never as markup.
const fx = require('./budget-surface-data');

// Breaks out of text into a live element with an event handler.
const LABEL = '"><img src=x onerror=alert(1)>';
// Breaks out of a double-quoted attribute into a live event attribute.
const ID = 'x" onmouseover="alert(1)" data-x="';
// Breaks out of a single-quoted attribute, and carries a script element.
const NOTE = "'><script>alert(2)</script><b onclick=alert(3)>";
// A category name with a closing tag and an svg handler.
const CATEGORY = '</td><svg onload=alert(4)>';
// Ordinary text that must still display exactly: an apostrophe and an ampersand.
const ORDINARY = "Tim's Café & Bakery";

const PAYLOADS = [LABEL, ID, NOTE, CATEGORY];

function hostile() {
  const d = fx.served();
  const plan = d.plan;
  // Bills and subscriptions: Forecast.householdBills / householdSubscriptions.
  plan.bills[0].id = ID;
  plan.bills[0].label = LABEL;
  plan.bills[0].note = NOTE;
  plan.bills[1].label = ORDINARY;
  plan.bills.push({ id: ID + 's', label: LABEL, frequency: 'monthly', day: 3, amount: 10,
    confidence: 'confirmed', subscription: true, note: NOTE, payingAccount: plan.bills[0].payingAccount });
  // The card minimum's schedule label reaches Credit's next payment and Deep
  // Dive's dated payments through Forecast.expandEvents.
  plan.obligations[0].label = CATEGORY;
  plan.obligations[0].debtId = ID;
  // Budget app (index.html): category names, an income label and a dated
  // commitment's label all reach plan.js renderers.
  plan.budget.categories[0].label = LABEL;
  plan.budget.categories[1].label = ORDINARY;
  plan.income[1].label = NOTE;
  plan.commitments[0].label = CATEGORY;
  // Credit: Forecast.creditAccounts reads the debt record.
  d.debts[0].id = ID;
  d.debts[0].label = LABEL;
  d.debts[0].structure = NOTE;
  // Records and Deep Dive fields.
  d.meta.coverage = LABEL;
  d.meta.transactions = 10;
  d.meta.statements = 1;
  d.meta.disclaimer = NOTE;
  d.netWorth = { caveat: NOTE };
  d.assets = [{ label: LABEL, value: 100 }];
  d.coverage = [
    { source: LABEL, what: NOTE, status: CATEGORY },
    { source: ORDINARY, what: ORDINARY, status: 'complete' },
  ];
  plan.assumptions = [NOTE, ORDINARY];
  plan.billsNote = CATEGORY;
  plan.commitments.push({ id: ID + 'c', label: LABEL, when: NOTE, amount: 50,
    confidence: CATEGORY, note: NOTE });
  d.settled = [{ date: '2026-08-15', what: LABEL, amount: 10, note: NOTE }];
  d.upcomingNote = NOTE;
  d.commitments = { heading: LABEL, note: NOTE, totalNote: NOTE };
  d.paypal = { categories: [{ label: CATEGORY, total: 10, perMonth: 1 },
    { label: ORDINARY, total: 10, perMonth: 1 }], perMonth: 2, note: NOTE, crossCheck: 2 };
  d.cashflow = [{ m: LABEL, v: 10, note: NOTE }, { m: CATEGORY, v: -10 }];
  d.unexplained = [{ label: LABEL, amount: 10, note: NOTE }];
  d.helocHistory = [{ m: LABEL, v: 100, note: NOTE }, { m: CATEGORY, v: 110 }];
  d.coachPayment = { chain: [{ when: LABEL, what: NOTE, balance: 10 }], note: NOTE,
    reading: NOTE, remaining: NOTE };
  d.counterparties = { total: 4, attributed: 2, previous: 1, note: NOTE, finding: NOTE,
    action: NOTE, matching: NOTE };
  d.questions = [{ tier: 1, q: LABEL, detail: NOTE, changes: CATEGORY, owner: ID },
    { tier: 2, q: ORDINARY, detail: ORDINARY, changes: ORDINARY, owner: ORDINARY }];
  return d;
}

module.exports = { hostile, LABEL, ID, NOTE, CATEGORY, ORDINARY, PAYLOADS };
