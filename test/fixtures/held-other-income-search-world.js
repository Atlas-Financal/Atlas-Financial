'use strict';
// One invented household of realistic size for the payday-search speed proof
// (test-held-other-income-search-equivalence.js). Every amount, label, id and
// date is invented here; nothing is copied or scaled from household data.
// Shape: 33 bills, 9 debt obligations on 7 debts, 17 dated costs, 4 scheduled
// incomes plus one expected one-off Other Income, a 91-day window, and a
// provider transaction history built through the repo's own provider-observe.
// It is a plain test fixture, not a figures input.
const fs = require('fs');
const path = require('path');
const O = require('../../scripts/provider-observe');
const coverageOpening = require('./card-coverage-opening');

const BASE = path.join(__dirname, 'figures-inputs', 'savings-chained-closes.json');
const FIRST_PAYDAY = '2026-10-02';
const addDays = (iso, n) => {
  const t = new Date(iso + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

function household(asOf, opts) {
  const d = JSON.parse(fs.readFileSync(BASE, 'utf8')).data;
  const p = d.plan;
  let periodStart = FIRST_PAYDAY;
  while (addDays(periodStart, 14) <= asOf) periodStart = addDays(periodStart, 14);
  d.meta.asOf = asOf;
  p.windowDays = 91;
  p.opening = { asOf, paydaySnapshot: { periodStart, asOf: periodStart, opening: 900 }, representedEvents: [] };
  p.defaults = { targetBuffer: 300, extraDebtMonthly: 0, scenario: 'expected' };
  p.startingCash.breakdown = [{ id: 'chequing-a', value: opts.cash == null ? 2400 : opts.cash }, { id: 'chequing-b', value: 350 },
    { id: 'savings', value: 600 }];
  p.income = [
    { id: 'payroll', label: 'Invented payroll A', frequency: 'biweekly', anchor: FIRST_PAYDAY, amount: 2900, confidence: 'confirmed' },
    { id: 'payroll-2', label: 'Invented payroll B', frequency: 'biweekly', anchor: FIRST_PAYDAY, amount: 2100, confidence: 'confirmed' },
    { id: 'benefit', label: 'Invented monthly benefit', frequency: 'monthly', day: 20, amount: 450, confidence: 'estimated' },
    { id: 'side', label: 'Invented side income', frequency: 'monthly', day: 5, amount: 300, confidence: 'estimated' },
  ];
  if (opts.rebate) {
    p.income.push({ id: 'rebate', label: 'Invented rebate', frequency: 'once', date: opts.rebate.date,
      amount: opts.rebate.amount, incomeClass: 'other', confidence: 'confirmed' });
  }
  const bills = [];
  for (let i = 0; i < 24; i++) {
    bills.push({ id: 'm' + i, label: 'Invented monthly bill ' + i, frequency: 'monthly', day: 1 + (i * 7) % 28,
      amount: 35 + (i * 37) % 260, confidence: i % 3 ? 'confirmed' : 'estimated',
      ...(i % 6 === 0 ? { payingAccount: 'card-' + (i % 5) } : {}),
      ...(i % 8 === 1 ? { budgetCategory: 'subscriptions' } : {}) });
  }
  for (let i = 0; i < 3; i++) {
    bills.push({ id: 'bw' + i, label: 'Invented biweekly bill ' + i, frequency: 'biweekly',
      anchor: addDays('2026-10-03', i * 3), amount: 40 + i * 25, confidence: 'confirmed' });
    bills.push({ id: 'q' + i, label: 'Invented quarterly bill ' + i, frequency: 'quarterly', month: 10 + i, day: 15,
      firstDue: `2026-${10 + i}-15`, amount: 180 + i * 40, confidence: 'estimated' });
    bills.push({ id: 'y' + i, label: 'Invented yearly bill ' + i, frequency: 'yearly', month: 11 + (i % 2), day: 10 + i,
      firstDue: `2026-${11 + (i % 2)}-${10 + i}`, amount: 300 + i * 150, confidence: 'confirmed', jointCash: false });
  }
  p.bills = bills;
  d.debts = [];
  p.obligations = [];
  for (let i = 0; i < 5; i++) {
    d.debts.push({ id: 'card-' + i, label: 'Invented card ' + i, secured: false, balance: 800 + i * 950,
      pending: i % 2 ? 40 : 0, pendingUnknown: false, limit: 3000 + i * 2000, rate: 19.99 + i, payment: 25 + i * 20,
      frequency: 'Monthly minimum', confidence: 'estimated' });
    p.obligations.push({ id: 'card-min-' + i, debtId: 'card-' + i, effect: 'payment', label: 'Invented card minimum ' + i,
      frequency: 'monthly', day: 3 + i * 5, amount: 25 + i * 20, confidence: 'estimated', payingAccount: 'chequing-a' });
  }
  d.debts.push({ id: 'loc', label: 'Invented line of credit', secured: true, balance: 18000, pending: 0,
    pendingUnknown: false, limit: 40000, rate: 7.2, payment: 110, frequency: 'Monthly interest', confidence: 'estimated' });
  d.debts.push({ id: 'loan', label: 'Invented term loan', secured: true, balance: 210000, rate: 4.9, payment: 1450,
    frequency: 'Monthly', confidence: 'confirmed' });
  p.obligations.push(
    { id: 'loc-interest', debtId: 'loc', effect: 'payment', label: 'Invented line interest', frequency: 'monthly',
      day: 21, amount: 110, confidence: 'estimated', payingAccount: 'chequing-a' },
    { id: 'loan-pay', debtId: 'loan', effect: 'payment', label: 'Invented loan payment', frequency: 'monthly',
      day: 1, amount: 1450, confidence: 'confirmed', payingAccount: 'chequing-a' },
    { id: 'card-extra-0', debtId: 'card-0', effect: 'payment', label: 'Invented extra card payment',
      frequency: 'monthly', day: 25, amount: 50, confidence: 'estimated', payingAccount: 'chequing-a' });
  p.groups = [{ id: 'club', label: 'Invented club costs', planSpendSummary: true },
    { id: 'travel', label: 'Invented travel', planSpendSummary: true }];
  p.commitments = [];
  for (let i = 0; i < 17; i++) {
    p.commitments.push({ id: 'c' + i, label: 'Invented dated cost ' + i,
      ...(i % 3 === 0 ? { group: 'club' } : i % 3 === 1 ? { group: 'travel' } : {}),
      date: addDays(asOf, 9 + i * 11), amount: 80 + (i * 53) % 700, confidence: i % 2 ? 'confirmed' : 'estimated',
      adjustable: i % 4 === 0, sinkingFund: true });
  }
  p.budget = { categories: [
    { id: 'groceries', label: 'Invented groceries', class: 'essential', plannedPayday: 520, plannedWeekly: 260, confidence: 'confirmed' },
    { id: 'fuel', label: 'Invented fuel', class: 'essential', plannedPayday: 160, plannedWeekly: 80, confidence: 'confirmed' },
    { id: 'dining', label: 'Invented dining', class: 'discretionary', plannedPayday: 120, plannedWeekly: 60, confidence: 'estimated' },
    { id: 'kids', label: 'Invented kids', class: 'discretionary', plannedPayday: 100, plannedWeekly: 50, confidence: 'estimated' },
  ] };
  p.savingsEarmarks.pools[0].goalRefs = [{ kind: 'group', id: 'club' }];
  p.savingsEarmarks.pools[1].goalRefs = [{ kind: 'yearly-bill', id: 'y0' }];
  p.savingsEarmarks.pools[1].reconciledOn = addDays(asOf, -2);
  p.savingsEarmarks.allocationPolicy.effectiveFrom = asOf;
  p.savingsPoolObservation.asOf = asOf;
  for (const account of p.savingsPoolObservation.accounts) account.evidenceDate = asOf;
  p.savingsPoolObservation.accounts[0].value = 600;
  return d;
}

const ACCOUNT_MAP = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture', mappings: [
  { providerAccountId: 'fx-hub', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
  { providerAccountId: 'fx-weekly', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
  ...[0, 1, 2, 3, 4].map(i => ({ providerAccountId: 'fx-card-' + i,
    canonical: { collection: 'debts', id: 'card-' + i }, atlasRole: 'revolving-credit' })) ] };
const RULES = [
  { eventId: 'payroll', payeePattern: 'FIXTURE PAYROLL A', atlasAccountId: 'chequing-a', direction: 'credit' },
  { eventId: 'payroll-2', payeePattern: 'FIXTURE PAYROLL B', atlasAccountId: 'chequing-a', direction: 'credit' }];
const CATEGORIES = ['Groceries', 'Gas', 'Restaurants', 'Uncategorised', 'Kids', 'Household'];
const row = (id, account, date, amount, payee, categoryLabel, extra = {}) => ({ providerTransactionId: id,
  providerAccountId: account, date, amount, payee, categoryLabel, currency: 'cad', pending: false,
  savingsPostingEvidence: 'posted', isIncome: /income/i.test(categoryLabel), ...extra });

// build({ asOf, transactions, days, rebate, receipts }) -> served-shaped data.
//   transactions: how many invented purchases; days: how far back they reach;
//   rebate: { date, amount } adds an expected one-off Other Income;
//   cash: the invented bills-account opening (default 2400);
//   receipts: [{ id, date, amount }] unlinked Other Income credits.
function build(options = {}) {
  const asOf = options.asOf || '2026-11-10';
  const count = options.transactions == null ? 268 : options.transactions;
  const days = options.days || 44;
  const data = household(asOf, options);
  const start = addDays(asOf, -days);
  const rows = [];
  for (let i = 0; i < count; i++) {
    // Purchases sit on the two cash accounts: a card purchase with no confirmed
    // coverage opening would make card coverage, and so the payday answer, unavailable.
    const account = i % 2 ? 'fx-weekly' : 'fx-hub';
    rows.push(row('t' + i, account, addDays(start, 1 + (i * 7) % days), 6 + (i * 13) % 140 + 0.37,
      'Invented merchant ' + (i % 40), CATEGORIES[i % CATEGORIES.length]));
  }
  for (let payday = FIRST_PAYDAY; payday <= asOf; payday = addDays(payday, 14)) {
    if (payday < start) continue;
    rows.push(row('payA-' + payday, 'fx-hub', payday, -2900, 'FIXTURE PAYROLL A', 'Income'));
    rows.push(row('payB-' + payday, 'fx-hub', payday, -2100, 'FIXTURE PAYROLL B', 'Income'));
  }
  for (const receipt of options.receipts || []) {
    rows.push(row(receipt.id, 'fx-hub', receipt.date, -receipt.amount, 'INVENTED PAYER', 'Other Income'));
  }
  const input = { plan: data.plan, accountMap: ACCOUNT_MAP, identityRules: RULES, transactions: rows,
    transactionWindow: { startDate: start, endDate: asOf, complete: true, hasMore: false, truncated: false } };
  const candidates = O.representedEventCandidates(input);
  const report = { transactions: rows, representedEventCandidates: candidates,
    transactionWindow: input.transactionWindow, fetchedAt: asOf + 'T18:00:00.000Z', pendingCoverage: { complete: true } };
  const packet = O.sanitizedCurrentPeriodActuals(report, { asOf, plan: data.plan, accountMap: ACCOUNT_MAP, identityRules: RULES });
  data.plan.opening.representedEvents = candidates.map(({ id, date }) => ({ id, date }));
  // An explicitly asserted empty card-coverage ledger at the start of the
  // invented history, so card coverage is ready and the payday answer publishes.
  data.plan.cardPurchaseCoverage = coverageOpening(start);
  data.liveOverlay = { applied: true, operatingPlan: 'live', asOf, effectiveAsOf: asOf,
    currentPeriodActuals: coverageOpening.packet(packet) };
  return data;
}

// The options the refresh worker passes to Forecast.recommend (scripts/operating-answer.js recommendOpts).
function recommendOptions(data) {
  const plan = data.plan, overlay = data.liveOverlay;
  return { fundingSources: plan.funding && plan.funding.options, debts: data.debts, revolvingExtra: data.revolvingExtra,
    periods: null, currentPeriodActuals: overlay.currentPeriodActuals, observedCash: overlay.observedCash || null,
    targetBuffer: plan.defaults.targetBuffer, operatingPlan: overlay.operatingPlan,
    operatingPlanNote: overlay.operatingPlanNote };
}

module.exports = { build, recommendOptions, addDays };
