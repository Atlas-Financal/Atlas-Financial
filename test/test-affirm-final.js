'use strict';

// Owner correction 2026-08-23: Affirm has one final $32.53 payment on
// 2026-09-21. Owner 2026-08-31: Flexiti is a different closed account.
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

const data = load(DATA_PATH);
const bill = data.plan.bills.find(row => row.id === 'affirm-final');
ok(bill && bill.frequency === 'once' && bill.date === '2026-09-21'
    && near(bill.amount, 32.53) && bill.confidence === 'confirmed',
  'canonical plan carries one confirmed final $32.53 payment on September 21');

const events = Forecast.expandEvents(data.plan, '2026-08-23', '2027-09-30', {})
  .filter(event => event.id === 'affirm-final');
ok(events.length === 1 && events[0].date === '2026-09-21'
    && near(events[0].amount, -32.53),
  'the master cash walk emits exactly one final Affirm outflow',
  JSON.stringify(events));
ok(near(events.reduce((sum, event) => sum + event.amount, 0), -32.53),
  'independent event total reconciles to the owner-stated final payment');

// Finish-line audit finding 4 (3b, lead ruling on #821): a bare "Personal
// loan payment" label no longer drops a row. The final Affirm payment is the
// planned affirm-final bill; when the observer represents it (as the
// candidate check below shows it can), it is that bill, counted once and
// never household spending. With no represented match the label alone is
// Other spending that needs confirmation, never nowhere.
const affirmTx = {
  id: 'tx-affirm-final',
  date: '2026-09-21',
  amount: 32.53,
  pending: false,
  categoryLabel: 'Personal loan payment',
  accountRole: 'household-cash',
};
const cls = Forecast.classifyCurrentPeriodTransaction(affirmTx, data.plan, {
  currentPeriodActuals: { transactions: [affirmTx],
    representedActuals: [{ id: 'affirm-final', date: '2026-09-21', transactionId: 'tx-affirm-final' }] },
});
ok(cls.kind === 'bill' && cls.householdSpending === false,
  'the represented final Affirm payment is its planned bill (debt service), not variable spending',
  JSON.stringify(cls));
const bare = Forecast.classifyCurrentPeriodTransaction(affirmTx, data.plan);
ok(bare.householdSpending === true && bare.needsConfirmation === true,
  'an unrepresented "Personal loan payment" row is Other spending needing confirmation, not dropped',
  JSON.stringify(bare));

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
    amount: 32.53,
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
  JSON.stringify({
    combinedCoverage: combinedCoverage || null,
    combinedPosition: combinedPosition || null,
  }));
ok(!COMBINED.test(debtsNote) && !COMBINED.test(facts)
    && !COMBINED.test(context) && !COMBINED.test(questions),
  'current product prose does not combine Affirm and Flexiti as one name');

ok(flexitiCoverage
    && /closed/i.test(flexitiCoverage.what)
    && /nothing remaining/i.test(flexitiCoverage.what)
    && !/32\.53/.test(flexitiCoverage.what)
    && !/paid off and closed/i.test(flexitiCoverage.what),
  'Records coverage publishes Flexiti as closed with nothing remaining',
  JSON.stringify(flexitiCoverage || null));
ok(flexitiCoverage && !/2,?654\.28/.test(flexitiCoverage.what),
  'Flexiti coverage does not attach the historical $2,654.28 window total as current status',
  JSON.stringify(flexitiCoverage || null));
ok(affirmCoverage
    && /32\.53/.test(affirmCoverage.what)
    && /2026-09-21/.test(affirmCoverage.what)
    && /not closed/i.test(affirmCoverage.what)
    && !/paid off and closed/i.test(affirmCoverage.what)
    && !/\bclosed\b/i.test(affirmCoverage.what.replace(/not closed/ig, '')),
  'Records coverage publishes Affirm separately with the final $32.53 due 2026-09-21, not closed',
  JSON.stringify(affirmCoverage || null));

ok(affirmPosition
    && /Final instalment,2026-09-21/.test(affirmPosition)
    && /32\.53/.test(affirmPosition)
    && /Not closed/i.test(affirmPosition)
    && !/CLOSED/.test(affirmPosition),
  'positions.csv has a separate Affirm row: final $32.53 due 2026-09-21, not closed');
ok(flexitiPosition
    && /Instalment - CLOSED/.test(flexitiPosition)
    && /nothing remaining to pay/i.test(flexitiPosition)
    && !/32\.53/.test(flexitiPosition)
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
    && /\$32\.53 payment due 2026-09-21/.test(context)
    && !/paid\s+off and closed/.test(context),
  'CONTEXT.md no longer reports Affirm/Flexiti as paid off and closed');
ok(/Flexiti is closed/.test(debtsNote)
    && /Affirm is a different obligation/.test(debtsNote)
    && /\$32\.53 payment due 2026-09-21/.test(debtsNote)
    && /Affirm is not closed/.test(debtsNote)
    && /2,654\.28 was paid across the historical BNPL window/.test(debtsNote),
  'Deep Dive debtsNote separates Flexiti (closed) from Affirm (final payment) and keeps the window total as history');

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nFinal Affirm payment proofs passed.');
