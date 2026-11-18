'use strict';
// A saved close keeps each household category row's plan trust (owner
// direction via the lead, 2026-11-18: saved-period trends count only rows
// whose saved plan is not an estimate). Store change only:
//   R1 a new close keeps the row's trust: an untagged row (Forecast's
//      calculated default) is stored 'calculated'; an estimated row keeps
//      'estimated' and its plannedTrust;
//   R2 a record saved before this change (no row trust) still reads;
//   R3 nothing else in the stored record changes: with the two row fields
//      removed, the projection equals main's, captured as a fixture;
//   R4 the saved-close reprint is unchanged: no trust word reaches a
//      reprinted category row.
// Invented data only (test/fixtures/private-period-history-input.js).
//
// `node test/test-saved-close-row-plan-trust.js`
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, input } = require('./fixtures/private-period-history-input');
const { pgWorld, URL_VALUE } = require('./fixtures/period-history-pg-double');
const MAIN = require('./fixtures/saved-close-row-plan-trust-main.json');

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const { digest, canonical } = History.contract;

function closeCandidate(edit) {
  const raw = input({ day: '2030-02-16', kind: 'closing', periodStart: START });
  delete raw.kind; delete raw.periodStart;
  const time = raw.capturedAt; delete raw.capturedAt;
  if (edit) edit(raw);
  return History.captureClosing(raw, { now: () => new Date(time) });
}

(async () => {
  // R1 untagged rows: stored 'calculated', no plannedTrust invented.
  const record = Pg.project(closeCandidate());
  const rows = record.content.publication.householdBudget;
  ok(rows.length === 6 && rows.every(row => row.trust === 'calculated' && !Object.hasOwn(row, 'plannedTrust')),
    'R1 every untagged category row is stored calculated, with no plannedTrust');

  // R1 an estimated row keeps its tag. The candidate's own publication is
  // tagged the way Forecast tags a carried Lunch Money budget, then resealed.
  const candidate = closeCandidate();
  const groceries = candidate.content.publication.householdBudget.find(row => row.id === 'groceries');
  Object.assign(groceries, { trust: 'estimated', plannedTrust: 'estimated' });
  const body = { schema: candidate.schema, capturedAt: candidate.capturedAt, content: candidate.content };
  const tagged = Pg.project({ ...body, captureId: digest(body) });
  const stored = id => tagged.content.publication.householdBudget.find(row => row.id === id);
  ok(stored('groceries').trust === 'estimated' && stored('groceries').plannedTrust === 'estimated',
    'R1 an estimated row keeps trust and plannedTrust estimated');
  ok(stored('fuel').trust === 'calculated', 'R1 the untagged row beside it is stored calculated');

  // R2 a record saved before this change still reads. The store's connection
  // owner refuses a process carrying TLS-trust variables (as in
  // test-private-period-history-postgres.js); CI runs clean.
  const trustClean = !Object.keys(process.env).some(k => /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i.test(k));
  if (!trustClean) console.log('  SKIP  R2: process environment carries TLS-trust variables; run with them unset');
  else {
  const env = { [Pg.ENV_NAME]: URL_VALUE };
  const w = pgWorld();
  const store = await Pg.openPeriodHistoryPostgres({ env, Client: w.Client });
  await store.append({ enabled: true, candidate: closeCandidate() });
  const row = JSON.parse(w.committed[0].record);
  for (const budget of row.content.publication.householdBudget) { delete budget.trust; delete budget.plannedTrust; }
  const { revisionId, ...rest } = row;
  const old = { ...rest, revisionId: digest(rest) };
  w.committed[0] = { sequence: 1, revision_id: old.revisionId, record: canonical(old) };
  const read = await store.read({ revisionId: old.revisionId });
  ok(read && read.content.publication.householdBudget.every(budget => !Object.hasOwn(budget, 'trust')),
    'R2 an older record with no row trust reads, and is not given one');
  }

  // R3 nothing else changes: main's projection of the same close.
  const strip = content => { const copy = JSON.parse(JSON.stringify(content)); delete copy.engine;
    for (const budget of copy.publication.householdBudget) { delete budget.trust; delete budget.plannedTrust; } return copy; };
  assert.deepEqual(strip(record.content), MAIN.content, 'R3 the stored record equals main\'s apart from the row trust');
  checks++;

  // R4 the reprint carries no trust word onto the saved period.
  const today = input({ day: '2030-02-20', kind: 'first-observed', periodStart: '2030-02-15' }).data.plan;
  const advice = F.recommend(today, '2030-02-20', { debts: [], periods: [], periodHistory: [tagged] });
  const past = advice.payPeriodViews.find(view => view.start === START);
  ok(past && past.capturedClose && past.householdBudget.length > 0
    && past.householdBudget.every(budget => !Object.hasOwn(budget, 'trust') && !Object.hasOwn(budget, 'plannedTrust')),
    'R4 the reprinted saved period carries no trust word on any category row');

  console.log(`All ${checks} saved-close row trust checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
