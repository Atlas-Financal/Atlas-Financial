'use strict';
// Synthetic evidence only. Optional --compare-base <full SHA> executes the
// immutable prior engine on every identical input and compares its ENTIRE
// publication, removing only the new evidenceFailures disclosure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const F = require('../public/forecast');
const fixture = require('./fixtures/budget-funding-data');
const AS_OF = '2026-08-20';
const ROOT = path.join(__dirname, '..');
function state() {
  const data = fixture();
  data.plan.cardPurchaseCoverage = require('./fixtures/card-coverage-opening')('2026-08-14');
  data.meta.asOf = data.plan.opening.asOf = AS_OF;
  data.plan.opening.priorAsOf = '2026-08-13';
  data.plan.startingCash.breakdown = [{ id: 'chequing-a', label: 'Synthetic Bills', value: 1000 },
    { id: 'chequing-b', label: 'Synthetic Weekly', value: 0 }];
  data.plan.defaults.targetBuffer = 50;
  data.plan.bills.push({ id: 'still-due', label: 'Still due', frequency: 'once',
    date: '2026-08-25', amount: 150, confidence: 'confirmed' });
  data.plan.obligations.push({ id: 'minimum', label: 'Required card payment', debtId: 'travelvisa',
    effect: 'payment', frequency: 'once', date: '2026-08-25', amount: 25, confidence: 'confirmed' });
  data.debts = [{ id: 'travelvisa', label: 'Synthetic card', structure: 'Revolving',
    balance: 400, pending: 50, rate: 20, limit: 1000 }];
  const packet = { schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
    coverageStart: '2026-08-14', coverageThrough: AS_OF,
    transactionCoverage: 'complete', pendingCoverage: 'complete', transactions: [
      { id: 'synthetic-grocery', date: '2026-08-19', amount: 50, account: 'travelvisa',
        accountRole: 'revolving-credit', categoryLabel: 'Groceries', displayedPayee: 'Synthetic grocer', pending: true },
      { id: 'synthetic-payroll', date: '2026-08-14', amount: -1000, account: 'chequing-a',
        accountRole: 'household-cash', categoryLabel: 'Income', kindHint: 'income', pending: false },
    ] };
  return { data, packet, asOf: AS_OF, opts: {} };
}
const options = s => ({ ...s.data.plan.defaults, debts: s.data.debts,
  currentPeriodActuals: require('./fixtures/card-coverage-opening').packet(s.packet), ...s.opts });
const current = a => a.payPeriodViews.find(p => p.fromTodayFunding);
const run = (s, engine = F) => engine.recommend(s.data.plan, s.asOf, options(s));
const withoutDiagnostics = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'evidenceFailures' ? undefined : v));
function loadEngine(source) {
  const file = path.join(ROOT, 'public', 'forecast.js');
  const m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  // Expose only the existing publication seam for deliberately malformed
  // upstream publications; no production API or calculation is substituted.
  m._compile(source.replace('const Forecast = {', 'const Forecast = { testPublishBudgetPeriodFunding: publishBudgetPeriodFunding,'), file);
  return m.exports;
}
function observed(s) {
  s.opts.operatingPlan = 'live';
  s.opts.observedCash = { complete: true, asOf: s.asOf,
    accounts: s.data.plan.startingCash.breakdown.map(r => ({ ...r, evidenceDate: s.asOf })) };
  return s.opts.observedCash;
}
function possiblePair(s) {
  s.packet.transactions.push({ ...s.packet.transactions[0], id: 'synthetic-posted', pending: false });
}
function issuer(s, change = {}) {
  s.packet.transactions.push({ ...s.packet.transactions[0], id: 'synthetic-issuer',
    categoryLabel: 'Interest charge', displayedPayee: 'INTEREST CHARGE -PURCHASE', amount: 20, ...change });
}
const cases = [
  ['missing packet', s => { s.packet = null; }, 'actuals-missing'],
  ['missing transaction list', s => { delete s.packet.transactions; }, 'actuals-transactions-missing'],
  ['missing coverage start', s => { delete s.packet.coverageStart; }, 'actuals-start-missing'],
  ['missing coverage through', s => { delete s.packet.coverageThrough; }, 'actuals-stale'],
  ['stale coverage', s => { s.packet.coverageThrough = '2026-08-19'; }, 'actuals-stale'],
  ['late coverage start', s => { s.packet.coverageStart = '2026-08-15'; }, 'actuals-period-coverage'],
  ['unresolved account', s => { s.packet.transactions[0].accountRole = 'unmapped'; }, 'actuals-unmapped-account'],
  ['truncated posted coverage', s => { s.packet.transactionCoverage = 'truncated'; }, 'actuals-posted-incomplete'],
  ['incomplete posted packet', s => { s.packet.transactionCoverage = { complete: false }; }, 'actuals-posted-incomplete'],
  ['partial pending coverage', s => { s.packet.pendingCoverage = 'partial'; }, 'actuals-pending-incomplete'],
  ['unknown pending coverage', s => { s.packet.pendingCoverage = 'unknown'; }, 'actuals-pending-incomplete'],
  ['stale observation', s => { s.packet.observationAsOf = '2026-08-19'; }, 'actuals-observation-mismatch'],
  ['future observation mismatch', s => { s.packet.observationAsOf = '2026-08-21'; }, 'actuals-observation-mismatch'],
  ['missing observation date', s => { delete s.packet.observationAsOf; }, 'actuals-observation-mismatch'],
  ['missing pending identity', s => { delete s.packet.transactions[0].id; }, 'pending-identity-unresolved'],
  ['repeated pending identity', s => { s.packet.transactions.push({ ...s.packet.transactions[0] }); }, 'pending-identity-unresolved'],
  ['accountId only', s => { const t = s.packet.transactions[0]; t.accountId = t.account; delete t.account; }, 'pending-account-unresolved'],
  ['conflicting account aliases', s => { s.packet.transactions[0].accountId = 'chequing-a'; }, 'pending-account-unresolved'],
  ['missing account', s => { delete s.packet.transactions[0].account; }, 'pending-account-unresolved'],
  ['ambiguous settlement link', s => { s.packet.transactions[0].pendingPostedAmbiguous = true; }, 'pending-settlement-ambiguous'],
  ['provider possible replacement flag', s => { s.packet.transactions[0].pendingPostedDuplicate = true; }, 'pending-possible-replacement'],
  ['unresolved pending posted twin', possiblePair, 'pending-possible-replacement'],
  ['missing matching facility', s => { s.data.debts = []; }, 'pending-card-exposure-unavailable'],
  ['unknown pending balance', s => { s.data.debts[0].pending = null; }, 'pending-card-exposure-unavailable'],
  ['negative pending balance', s => { s.data.debts[0].pending = -1; }, 'pending-card-exposure-unavailable'],
  ['insufficient matching exposure', s => { s.data.debts[0].pending = 49.99; }, 'pending-card-exposure-insufficient'],
  ['excluded issuer debit also needs backing', s => issuer(s), 'pending-card-exposure-insufficient'],
  ['excluded debit amount unavailable', s => issuer(s, { amount: null }), 'pending-card-amount-unavailable'],
  ['excluded debit identity unavailable', s => issuer(s, { pendingPostedAmbiguous: true }), 'pending-card-identity-unresolved'],
  ['duplicate posted identity', s => { s.packet.transactions.push({ ...s.packet.transactions[1] }); }, 'actuals-identity-not-unique'],
  ['invalid posted amount', s => { s.packet.transactions[1].amount = null; }, 'actuals-transaction-invalid'],
  ['stale cash opening', s => { s.data.plan.opening.asOf = '2026-08-19'; }, 'cash-opening-date'],
  ['missing Bills account', s => { s.data.plan.startingCash.breakdown.shift(); }, 'cash-account-missing-or-duplicate'],
  ['missing Weekly account', s => { s.data.plan.startingCash.breakdown.pop(); }, 'cash-account-missing-or-duplicate'],
  ['duplicate cash account', s => { s.data.plan.startingCash.breakdown.push({ ...s.data.plan.startingCash.breakdown[0] }); }, 'cash-account-missing-or-duplicate'],
  ['unknown cash', s => { s.data.plan.startingCash.breakdown[0].value = null; }, 'cash-account-untrusted'],
  ['conflicting cash trust', s => { s.data.plan.startingCash.breakdown[0].status = 'CONFLICT'; }, 'cash-account-untrusted'],
  ['stale cash row', s => { s.data.plan.startingCash.breakdown[0].evidenceDate = '2026-08-19'; }, 'cash-account-stale'],
  ['live observation missing', s => { s.opts.operatingPlan = 'live'; }, 'cash-observation-missing'],
  ['live observation incomplete', s => { observed(s).complete = false; }, 'cash-observation-incomplete'],
  ['live observation wrong date', s => { observed(s).asOf = '2026-08-19'; }, 'cash-observation-date'],
  ['live Bills missing', s => { observed(s).accounts.shift(); }, 'cash-observation-account'],
  ['live Weekly missing', s => { observed(s).accounts.pop(); }, 'cash-observation-account'],
  ['live duplicate account', s => { const o = observed(s); o.accounts.push({ ...o.accounts[0] }); }, 'cash-observation-account'],
  ['live row untrusted', s => { observed(s).accounts[0].unknown = true; }, 'cash-observation-account-untrusted'],
  ['live row stale', s => { observed(s).accounts[0].evidenceDate = '2026-08-19'; }, 'cash-observation-account-stale'],
  ['live stock mismatch', s => { observed(s).accounts[0].value++; }, 'cash-observation-mismatch'],
  ['protected amount missing', s => { delete s.data.plan.commitments[0].amount; }, 'protected-cost-evidence-unavailable'],
  ['overdue protected cost', s => { s.data.plan.commitments[0].date = '2026-08-10'; }, 'protected-cost-overdue'],
  ['pending cash debit', s => { s.packet.transactions[0].account = 'chequing-a'; s.packet.transactions[0].accountRole = 'household-cash'; }, 'pending-cash-unresolved'],
];

function main() {
  const baseIndex = process.argv.indexOf('--compare-base');
  const baseSha = baseIndex >= 0 ? process.argv[baseIndex + 1] : null;
  if (baseSha) assert.match(baseSha, /^[a-f0-9]{40}$/);
  const base = baseSha ? loadEngine(execFileSync('git', ['show', baseSha + ':public/forecast.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 5e6 })) : null;
  let compared = 0;
  function check(s) {
    const before = JSON.stringify(s);
    const advice = run(s);
    assert.equal(JSON.stringify(s), before, 'diagnostics never mutate evidence or policy');
    if (base) {
      assert.deepEqual(withoutDiagnostics(advice), withoutDiagnostics(run(s, base)),
        'every pre-existing publication field, status and amount must equal immutable main');
      compared++;
    }
    return current(advice)?.fromTodayFunding;
  }
  const complete = state(), control = check(complete);
  // A second, supplied-dollar method. No call to the allocator as oracle.
  assert.equal(control.availableNow, 1000 - (200 + 150 + 25) - (300 - 50) - 50 - 50);
  assert.equal(control.contribution, 600 - (1000 - 200 - 150 - 300));
  assert.equal(control.status, 'ready');
  assert.equal(control.evidenceFailures, undefined);
  for (const [name, change, code] of cases) {
    const s = state(); change(s);
    const got = check(s);
    assert.equal(got?.status, 'unavailable', name);
    assert.equal(got.contribution, null, name);
    assert.ok(got.evidenceFailures?.some(r => r.code === code), name + ': ' + JSON.stringify(got.evidenceFailures));
    for (const issue of got.evidenceFailures) {
      assert.ok(issue.message, name + ' needs an explanation');
      // Explanatory advice was trimmed from the Budget sheet; the field stays a string and
      // no refresh/verify instruction is published (settlement evidence keeps its own caveat).
      assert.equal(typeof issue.action, 'string', name + ' keeps the action field');
      if (issue.code !== 'protected-cost-overdue') assert.doesNotMatch(issue.action, /Refresh|verify|Confirm/, name + ' publishes no advice sentence');
      assert.doesNotMatch(JSON.stringify(issue), /synthetic-grocery|synthetic-payroll|Synthetic grocer|providerTransactionId|\$/,
        'disclosure has safe labels/dates, no amounts, payees or transaction identities');
    }
  }
  // Distinct simultaneous blockers all survive in stable order, including
  // when an earlier coverage failure used to short-circuit pending checks.
  const multiple = state(); possiblePair(multiple);
  multiple.packet.pendingCoverage = 'partial';
  multiple.packet.transactionCoverage = 'truncated';
  multiple.packet.coverageStart = '2026-08-18';
  multiple.packet.observationAsOf = '2026-08-19';
  observed(multiple).accounts.pop();
  const blockers = check(multiple).evidenceFailures;
  for (const code of ['actuals-period-coverage', 'actuals-pending-incomplete', 'actuals-posted-incomplete',
    'actuals-observation-mismatch', 'cash-observation-account']) {
    assert.ok(blockers.some(r => r.code === code), code);
  }
  multiple.packet.transactions.reverse();
  assert.deepEqual(check(multiple).evidenceFailures, blockers);
  assert.deepEqual(check(multiple).evidenceFailures, blockers, 'same observation does not accumulate reasons');

  // Exposure total is never a substitute for transaction identity.
  const twin = state(); possiblePair(twin); twin.data.debts[0].pending = 999;
  assert.ok(check(twin).evidenceFailures.some(r => r.code === 'pending-possible-replacement'));
  const cashAndPending = state(); cashAndPending.packet.transactions[0].pendingPostedAmbiguous = true;
  cashAndPending.data.plan.startingCash.breakdown.pop();
  cashAndPending.packet.observationAsOf = '2026-08-19';
  const simultaneous = check(cashAndPending).evidenceFailures;
  for (const code of ['cash-account-missing-or-duplicate', 'actuals-observation-mismatch', 'pending-settlement-ambiguous']) {
    assert.ok(simultaneous.some(r => r.code === code), code);
  }
  for (const change of [
    s => { issuer(s); s.data.debts[0].pending = 70; },
    s => { s.packet.transactions[0].pending = false; s.data.debts[0].balance = 450; s.data.debts[0].pending = 0; },
    s => { s.data.plan.startingCash.breakdown.push({ id: 'savings', value: 9000 }); },
    s => { observed(s); },
    s => { s.packet.transactions.push({ ...s.packet.transactions[0], id: 'synthetic-second-purchase' }); s.data.debts[0].pending = 100; },
    s => { s.packet.transactions[0].date = '2026-08-18'; },
  ]) {
    const s = state(); change(s);
    assert.equal(check(s).status, 'ready', 'complete control remains available');
  }
  const advance = state(); advance.asOf = advance.data.plan.opening.asOf = '2026-08-21';
  advance.packet.observationAsOf = advance.packet.coverageThrough = advance.asOf;
  observed(advance);
  assert.equal(check(advance).status, 'ready');
  const payday = state(); payday.asOf = payday.data.plan.opening.asOf = '2026-08-14';
  payday.packet.observationAsOf = payday.packet.coverageThrough = payday.asOf;
  payday.packet.transactions = []; payday.data.debts[0].pending = 0;
  assert.equal(check(payday).status, 'ready');
  payday.packet.transactions.push({ id: '', date: payday.asOf, amount: 1 });
  assert.ok(check(payday).evidenceFailures.some(r => r.code === 'actuals-transaction-invalid'), 'payday uses strict seed check');

  // Exercise predicates on their real publication seam that recommend
  // ordinarily prevents: missing category values and a mismatched sum.
  const engine = loadEngine(fs.readFileSync(path.join(ROOT, 'public/forecast.js'), 'utf8'));
  for (const [name, mutate, code] of [
    ['category spent missing', p => { p.householdBudget[0].spent = null; }, 'budget-category-amount-unavailable'],
    ['category total mismatch', p => { p.householdBudget[0].hold++; }, 'budget-category-total-mismatch'],
    ['income missing', p => { p.incomeTotal = null; }, 'budget-basis-unavailable'],
  ]) {
    const s = state(), rows = structuredClone(run(s).payPeriodViews);
    for (const p of rows) { delete p.fromTodayFunding; delete p.plannedCostFunding; }
    mutate(rows.find(p => p.start === '2026-08-14'));
    const prior = structuredClone(rows);
    engine.testPublishBudgetPeriodFunding(s.data.plan, s.asOf, rows, options(s));
    assert.ok(current({ payPeriodViews: rows }).fromTodayFunding.evidenceFailures.some(r => r.code === code), name);
    if (base) {
      base.testPublishBudgetPeriodFunding(s.data.plan, s.asOf, prior, options(s));
      assert.deepEqual(withoutDiagnostics(rows), withoutDiagnostics(prior), name); compared++;
    }
  }
  console.log('PASS savings evidence: ' + cases.length + ' isolated blockers, complete controls, simultaneous/reordered blockers, payday/date advance, independent arithmetic' +
    (base ? '; ' + compared + ' whole-publication comparisons to ' + baseSha : ''));
}
module.exports = { state, options, run, current, withoutDiagnostics, loadEngine, possiblePair, observed, AS_OF };
if (require.main === module) main();
