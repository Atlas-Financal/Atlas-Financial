'use strict';
// Issue #818 slice 1: the rollover closing-capture seam of the private
// pay-period archive. Entirely invented finances and identities. No
// data.json, no live credentials, no server or scheduler wiring: the seam
// is exercised directly and through the operator CLI only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const History = require('../scripts/private-period-history');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');

// Biweekly payroll anchored 2030-02-01: cycles 02-01..02-14, 02-15..02-28,
// 03-01..03-14. A capture on 02-15 (first day of cycle 2) must close cycle 1.
const START = '2030-02-01', END = '2030-02-14';
const NEXT_START = '2030-02-15', NEXT_END = '2030-02-28';
const clone = value => JSON.parse(JSON.stringify(value));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-history-closing-test-'));
const cli = path.join(__dirname, '..', 'scripts', 'private-period-history-cli.js');
function directory(name) { const dir = path.join(temporary, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; }
function input(day) {
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const cash = ids.map((id, i) => ({ id, label: 'Invented cash ' + i, value: [1000, 500, 100][i], evidenceDate: day, confidence: 'confirmed' }));
  return {
    capturedAt: day + 'T18:01:00Z', periods: [],
    data: { meta: { asOf: day }, accounts: [], debts: [], revolvingExtra: [], plan: {
      opening: { asOf: day, representedEvents: [] }, startingCash: { breakdown: cash },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      income: [{ id: 'payroll', label: 'Invented income', frequency: 'biweekly', anchor: START, amount: 200, confidence: 'confirmed' }],
      bills: [], commitments: [], obligations: [], groups: [], funding: { options: [] },
      budget: { categories: [['groceries', 40], ['fuel', 15], ['restaurants', 10], ['dale-guilt-free', 5],
        ['amanda-guilt-free', 5], ['pets', 5], ['other-spend', 20]].map(([id, plannedPayday]) =>
        ({ id, label: 'Invented ' + id, plannedPayday, class: 'essential', confidence: 'confirmed', from: [] })) },
    } },
    accountMap: { provider: 'lunchmoney', schema: 'atlas-provider-account-map/v1', scope: 'owner-observed', mappings: ids.map((id, i) =>
      ({ providerAccountId: 'invented-account-' + i, atlasRole: 'household-cash', canonical: { id, collection: 'cash' } })) },
    identity: { rules: [], billPaymentPayees: [] },
    payload: { provider: 'lunchmoney', fetchedAt: day + 'T18:00:00Z',
      accounts: cash.map((row, i) => ({ id: 'invented-account-' + i, name: 'Invented provider cash ' + i,
        currency: 'cad', balance: row.value, balance_as_of: day + 'T17:59:00Z', updated_at: day + 'T17:59:00Z' })),
      categories: [{ id: 'invented-category', name: 'Groceries' }], tags: [{ id: 'invented-tag', name: 'invented household note' }],
      transactions: [{ id: 'invented-transaction', account_id: 'invented-account-1', date: START, amount: '12.34', currency: 'cad',
        category_id: 'invented-category', payee: 'Invented Market', original_name: 'INVENTED MARKET SOURCE',
        notes: 'invented evidence', tags: ['invented-tag'], is_pending: false, updated_at: day + 'T17:58:00Z' }],
      transactionWindow: { startDate: START, endDate: day, complete: true, hasMore: false, truncated: false },
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
    },
  };
}
function closingInput(day) { const clean = input(day); delete clean.capturedAt; return clean; }
function captureClosing(day) {
  return History.captureClosing(closingInput(day), { now: () => new Date(day + 'T18:01:00Z') });
}
function appendClosing(destination, day) {
  return History.appendClosing({ destination, enabled: true, input: closingInput(day),
    now: () => new Date(day + 'T18:01:00Z') });
}
function rejects(fn, code) { assert.throws(fn, error => error.code === code, code); }
function files(dir) { return fs.readdirSync(dir).filter(name => name.endsWith('.json')); }

try {
  // Rollover derivation: no caller-named kind or period. On the first day of
  // cycle 2 the seam closes cycle 1 and reprints its native publication.
  const candidate = captureClosing(NEXT_START);
  assert.equal(candidate.content.kind, 'closing');
  assert.deepEqual(candidate.content.period, { start: START, end: END, timezone: Forecast.HOUSEHOLD_TIMEZONE });
  const source = closingInput(NEXT_START);
  const refreshed = Live.fromObservation(source), options = Operating.recommendOpts(refreshed.data, {});
  options.periods = source.periods;
  const native = Forecast.recommend(refreshed.data.plan, NEXT_START, options)
    .payPeriodViews.find(p => p.start === START && p.end === END);
  assert.deepEqual(candidate.content.publication, JSON.parse(JSON.stringify(native)),
    'closing capture reprints the native Forecast row for the closed period');

  // The seam owns the selection: caller kind / periodStart / clock refused.
  rejects(() => History.captureClosing({ ...closingInput(NEXT_START), kind: 'closing' },
    { now: () => new Date(NEXT_START + 'T18:01:00Z') }), 'history-closing-selection-invalid');
  rejects(() => History.captureClosing({ ...closingInput(NEXT_START), periodStart: START },
    { now: () => new Date(NEXT_START + 'T18:01:00Z') }), 'history-closing-selection-invalid');
  rejects(() => History.captureClosing(input(NEXT_START)), 'history-capture-clock-owned');

  // Append side: disabled by default, exactly like append.
  const archive = directory('archive');
  rejects(() => History.appendClosing({ destination: archive, input: closingInput(NEXT_START),
    now: () => new Date(NEXT_START + 'T18:01:00Z') }), 'history-capture-disabled');

  const first = appendClosing(archive, NEXT_START);
  assert.equal(first.status, 'appended');
  assert.equal(first.kind, 'closing');
  assert.equal(first.period.start, START);
  assert.equal(files(archive).length, 1);

  // Idempotent across later observations of the same rollover: a rollover
  // trigger may run repeatedly; the closed period is captured exactly once.
  const again = appendClosing(archive, '2030-02-16');
  assert.equal(again.status, 'already-captured');
  assert.equal(again.revisionId, first.revisionId);
  assert.equal(files(archive).length, 1, 'repeat rollover observation adds no revision');

  // The next rollover closes the next period as its own revision; the first
  // closing record is never rewritten.
  const firstPath = path.join(archive, files(archive)[0]);
  const firstBytes = fs.readFileSync(firstPath, 'utf8');
  const second = appendClosing(archive, '2030-03-01');
  assert.equal(second.status, 'appended');
  assert.deepEqual([second.period.start, second.period.end], [NEXT_START, NEXT_END]);
  assert.equal(second.previousRevision, first.revisionId);
  assert.equal(files(archive).length, 2);
  assert.equal(fs.readFileSync(firstPath, 'utf8'), firstBytes, 'later rollover never rewrites an earlier close');

  // A destination inside a repository stays forbidden through this seam.
  rejects(() => History.appendClosing({ destination: path.join(__dirname, '..'), enabled: true,
    input: closingInput(NEXT_START), now: () => new Date(NEXT_START + 'T18:01:00Z') }),
    'history-destination-forbidden');

  // CLI: preview is metadata-only; the enabled verb appends one closing.
  // The synthetic clock is a test-only seam (a stubbed Date in a -e wrapper,
  // the same pattern as the foundation suite); the CLI exposes no clock.
  const cliDir = directory('cli-archive');
  const inputPath = path.join(temporary, 'closing-input.json');
  fs.writeFileSync(inputPath, JSON.stringify(closingInput(NEXT_START)));
  const runCli = args => spawnSync(process.execPath, ['-e', `
    const RealDate = Date;
    global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['${NEXT_START}T18:01:00Z'])); } };
    process.stdout.write(JSON.stringify(require(process.argv[1]).run(process.argv.slice(2))));
  `, cli, ...args], { encoding: 'utf8' });
  const preview = runCli(['capture-closing', '--input', inputPath]);
  assert.equal(preview.status, 0, preview.stderr);
  const previewBody = JSON.parse(preview.stdout);
  assert.equal(previewBody.status, 'disabled-preview');
  assert.equal(previewBody.kind, 'closing');
  assert.ok(!preview.stdout.includes('Invented Market'), 'CLI preview never prints source rows');
  assert.equal(files(cliDir).length, 0);
  const enabled = runCli(['capture-closing', '--input', inputPath, '--destination', cliDir, '--enable-private-history']);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).status, 'appended');
  assert.equal(files(cliDir).length, 1);
  const repeated = runCli(['capture-closing', '--input', inputPath, '--destination', cliDir, '--enable-private-history']);
  assert.equal(JSON.parse(repeated.stdout).status, 'already-captured');
  assert.equal(files(cliDir).length, 1);

  console.log('private period history rollover closing capture: all checks passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
