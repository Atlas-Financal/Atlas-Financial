'use strict';

// Canonical product/date shape is checked separately from invented payment cents.
// No household amount is the public behavior oracle.
// Prove the canonical cash event, provider settlement identity, debt-service
// classification, and the published Affirm/Flexiti split independently of
// the live household cents.

const fs = require('fs');
const path = require('path');
const Forecast = require('../public/forecast.js');
const Observe = require('../scripts/provider-observe.js');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data.json');
const MAP_PATH = path.join(ROOT, 'docs', 'connectivity', 'fixtures',
  'provider-account-map.json');
const IDENTITY_PATH = path.join(ROOT, 'docs', 'connectivity',
  'transaction-identity.json');
const POSITIONS_PATH = path.join(ROOT, 'docs', 'positions.csv');
const FACTS_PATH = path.join(ROOT, 'docs', 'ACCOUNT_FACTS.md');
const CONTEXT_PATH = path.join(ROOT, 'CONTEXT.md');
const QUESTIONS_PATH = path.join(ROOT, 'docs', '01_OPEN_QUESTIONS.md');

let failures = 0;
function ok(condition, label, detail) {
  if (condition) {
    console.log(`\x1b[32m✓\x1b[0m ${label}`);
    return;
  }
  failures += 1;
  console.log(`\x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
}
function load(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function near(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) < 0.005;
}

const COMBINED = /Affirm\s*\/\s*Flexiti/i;

const household = load(DATA_PATH);
const liveBill = household.plan.bills.find(row => row.id === 'affirm-final');
const FINAL = 27.43; // independent invented final instalment
const data = JSON.parse(JSON.stringify(household));
const bill = data.plan.bills.find(row => row.id === 'affirm-final');
bill.amount = FINAL;
ok(bill && bill.frequency === 'once' && bill.date === '2026-09-21'
    && Number.isFinite(liveBill.amount) && liveBill.amount > 0 && bill.confidence === 'confirmed',
  'canonical plan carries one confirmed synthetic final payment payment on September 21');

const events = Forecast.expandEvents(data.plan, '2026-08-23', '2027-09-30', {})
  .filter(event => event.id === 'affirm-final');
ok(events.length === 1 && events[0].date === '2026-09-21'
    && near(events[0].amount, -FINAL),
  'the master cash walk emits exactly one final Affirm outflow',
  JSON.stringify(events));
ok(near(events.reduce((sum, event) => sum + event.amount, 0), -FINAL),
  'independent event total reconciles to the invented final payment');

const cls = Forecast.classifyCurrentPeriodTransaction({
  date: '2026-09-21',
  amount: FINAL,
  pending: false,
  categoryLabel: 'Personal loan payment',
  accountRole: 'household-cash',
}, data.plan);
ok(cls.kind === 'card-payment' && cls.householdSpending === false,
  'Lunch Money Personal loan payment is debt service, not variable spending',
  JSON.stringify(cls));

const payload = {
  provider: 'lunchmoney',
  fetchedAt: '2026-09-21T18:00:00.000Z',
  transactionWindow: {
    startDate: '2026-09-01', endDate: '2026-09-21',
    complete: true, hasMore: false, truncated: false,
  },
  pendingCoverage: {
    complete: true, basis: 'is_pending-unbounded',
    hasMore: false, truncated: false,
  },
  accounts: [
    { id: 1001, name: 'Fixture Chequing A', type: 'cash', balance: 1000,
      updated_at: '2026-09-21T17:55:00.000Z' },
    { id: 1002, name: 'Fixture Chequing B', type: 'cash', balance: 500,
      updated_at: '2026-09-21T17:55:00.000Z' },
  ],
  transactions: [{
    id: 9211,
    account_id: 1002,
    date: '2026-09-21',
    amount: FINAL,
    currency: 'cad',
    is_pending: false,
    payee: 'AFFIRM CANADA _V',
    category_name: 'Personal loan payment',
  }],
};
const report = Observe.observe({
  provider: 'lunchmoney',
  payload,
  accountMap: load(MAP_PATH),
  data,
  identity: load(IDENTITY_PATH),
});
const candidate = (report.representedEventCandidates || [])
  .find(row => row.id === 'affirm-final');
ok(candidate && candidate.date === '2026-09-21'
    && candidate.postingDate === '2026-09-21'
    && candidate.direction === 'debit'
    && candidate.amountNotUsed === true,
  'exact payee, account, direction and date can settle the final occurrence',
  JSON.stringify(report.representedEventCandidates || []));

const positions = read(POSITIONS_PATH);
const facts = read(FACTS_PATH);
const context = read(CONTEXT_PATH);
const questions = read(QUESTIONS_PATH);
const debtsNote = String(data.debtsNote || '');
const historicalAmountText = (debtsNote.match(/([0-9][0-9,.]*) was paid across the historical BNPL window/) || [])[1];
const coverage = Array.isArray(data.coverage) ? data.coverage : [];
const flexitiCoverage = coverage.find(row => row.source === 'Flexiti');
const affirmCoverage = coverage.find(row => row.source === 'Affirm');
const combinedCoverage = coverage.find(row => COMBINED.test(String(row.source || '')));
const positionLines = positions.split(/\r?\n/).filter(Boolean);
const affirmPosition = positionLines.find(line => /^Household,Affirm,BNPL,/.test(line));
const flexitiPosition = positionLines.find(line => /^Household,Flexiti,BNPL,/.test(line));
const combinedPosition = positionLines.find(line => COMBINED.test(line.split(',')[1] || ''));

ok(!combinedCoverage && !combinedPosition,
  'current product records do not keep a combined Affirm/Flexiti row',
  'product rows must remain separate');
ok(!COMBINED.test(debtsNote) && !COMBINED.test(facts)
    && !COMBINED.test(context) && !COMBINED.test(questions),
  'current product prose does not combine Affirm and Flexiti as one name');

ok(flexitiCoverage
    && /closed/i.test(flexitiCoverage.what)
    && /nothing remaining/i.test(flexitiCoverage.what)
    && !String(flexitiCoverage.what).includes(String(liveBill.amount))
    && !/paid off and closed/i.test(flexitiCoverage.what),
  'Records coverage publishes Flexiti as closed with nothing remaining');
ok(flexitiCoverage && historicalAmountText && !String(flexitiCoverage.what).includes(historicalAmountText),
  'Flexiti coverage does not attach the historical the documented amount window total as current status');
ok(affirmCoverage
    && String(affirmCoverage.what).includes(String(liveBill.amount))
    && /2026-09-21/.test(affirmCoverage.what)
    && /not closed/i.test(affirmCoverage.what)
    && !/paid off and closed/i.test(affirmCoverage.what)
    && !/\bclosed\b/i.test(affirmCoverage.what.replace(/not closed/ig, '')),
  'Records coverage publishes Affirm separately with the synthetic final payment due 2026-09-21, not closed');

ok(affirmPosition
    && /Final instalment,2026-09-21/.test(affirmPosition)
    && String(affirmPosition).includes(String(liveBill.amount))
    && /Not closed/i.test(affirmPosition)
    && !/CLOSED/.test(affirmPosition),
  'positions.csv has a separate Affirm row: synthetic final payment due 2026-09-21, not closed');
ok(flexitiPosition
    && /Instalment - CLOSED/.test(flexitiPosition)
    && /nothing remaining to pay/i.test(flexitiPosition)
    && !String(flexitiPosition).includes(String(liveBill.amount))
    && !/2026-09-21/.test(flexitiPosition),
  'positions.csv has a separate Flexiti row: closed, nothing remaining');

ok(/Flexiti — CLOSED/.test(facts)
    && /nothing remaining to pay/i.test(facts)
    && /Affirm — FINAL PAYMENT PENDING/.test(facts)
    && !/Affirm\/Flexiti — FINAL PAYMENT PENDING/.test(facts)
    && /Affirm is not closed/.test(facts)
    && !/\*\*Affirm — CLOSED\*\*/.test(facts)
    && !/Affirm[^\n]{0,40}paid off and closed/i.test(facts),
  'ACCOUNT_FACTS records Flexiti closed and Affirm still pending, never combined');
ok(/Flexiti is owner-confirmed closed/.test(context)
    && /Affirm is a different obligation/.test(context)
    && String(context).includes('$' + liveBill.amount.toFixed(2) + ' payment due ' + liveBill.date)
    && !/paid\s+off and closed/.test(context),
  'CONTEXT.md no longer reports Affirm/Flexiti as paid off and closed');
ok(/Flexiti is closed/.test(debtsNote)
    && /Affirm is a different obligation/.test(debtsNote)
    && String(debtsNote).includes('$' + liveBill.amount.toFixed(2) + ' payment due ' + liveBill.date)
    && /Affirm is not closed/.test(debtsNote)
    && Boolean(historicalAmountText),
  'Deep Dive debtsNote separates Flexiti (closed) from Affirm (final payment) and keeps the window total as history');

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nFinal Affirm payment proofs passed.');
