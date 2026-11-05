'use strict';
// Entirely invented finances and identities. No data.json or live credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const History = require('../scripts/private-period-history');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');

const START = '2030-02-01', END = '2030-02-14';
const clone = value => JSON.parse(JSON.stringify(value));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-history-test-'));
const cli = path.join(__dirname, '..', 'scripts', 'private-period-history-cli.js');
function directory(name) { const dir = path.join(temporary, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; }
function input(day = START, kind = 'original') {
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const cash = ids.map((id, i) => ({ id, label: 'Invented cash ' + i, value: [1000, 500, 100][i], evidenceDate: day, confidence: 'confirmed' }));
  return {
    kind, capturedAt: day + 'T18:01:00Z', periodStart: START, periods: [],
    ...(kind === 'actual-correction' ? { reason: 'invented source revision' } : {}),
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
        currency: 'cad', balance: row.value, balance_as_of: day + 'T17:59:00Z', updated_at: day + 'T17:59:00Z', balance_last_update: day + 'T17:59:00Z' })),
      categories: [{ id: 'invented-category', name: 'Groceries' }], tags: [{ id: 'invented-tag', name: 'invented household note' }],
      transactions: [{ id: 'invented-transaction', account_id: 'invented-account-1', date: START, amount: '12.34', currency: 'cad',
        category_id: 'invented-category', payee: 'Invented Market', original_name: 'INVENTED MARKET SOURCE',
        notes: 'invented evidence', tags: ['invented-tag'], is_pending: false, updated_at: day + 'T17:58:00Z', balance_last_update: day + 'T17:58:00Z' }],
      transactionWindow: { startDate: START, endDate: day, complete: true, hasMore: false, truncated: false },
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
    },
  };
}
function capture(data = input()) {
  const clean = clone(data), time = clean.capturedAt; delete clean.capturedAt;
  return History.capture(clean, { now: () => new Date(time) });
}
function append(destination, candidate) { return History.append({ destination, enabled: true, candidate }); }
function rejects(fn, code) { assert.throws(fn, error => error.code === code, code); }
function files(dir) { return fs.readdirSync(dir).filter(name => name.endsWith('.json')); }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

try {
  const source = input(), before = JSON.stringify(source), candidate = capture(source);
  assert.equal(JSON.stringify(source), before, 'capture leaves canonical data and source immutable');
  assert.equal(candidate.content.period.end, END);
  const refreshed = Live.fromObservation(source), options = Operating.recommendOpts(refreshed.data, {});
  options.periods = source.periods;
  const native = Forecast.recommend(refreshed.data.plan, START, options).payPeriodViews.find(p => p.start === START);
  assert.deepEqual(candidate.content.publication, JSON.parse(JSON.stringify(native)), 'archive reprints native Forecast without a second planner');
  assert.equal(native.householdBudget.find(row => row.id === 'groceries').spent, 12.34, 'invented posted CAD debit is preserved independently');
  rejects(() => History.append({ destination: temporary, candidate }), 'history-capture-disabled');
  rejects(() => History.capture(source), 'history-capture-clock-owned');
  const oldSource = clone(source); delete oldSource.capturedAt;
  rejects(() => History.capture(oldSource, { now: () => new Date('2030-02-15T18:01:00Z') }), 'history-original-opening-unproven');
  rejects(() => capture({ ...input('2030-02-02'), kind: 'original' }), 'history-original-opening-unproven');
  rejects(() => capture({ ...source, payload: { ...source.payload, access_token: 'invented-forbidden-value' } }), 'history-private-input-invalid');
  rejects(() => capture({ ...source, accountMap: { ...source.accountMap, scope: 'fixture' } }), 'history-forecast-capture-failed');

  const archive = directory('archive');
  const first = append(archive, candidate);
  const firstPath = path.join(archive, files(archive)[0]), firstHash = hash(firstPath);
  const retry = input(); retry.capturedAt = START + 'T19:01:00Z'; retry.payload.fetchedAt = START + 'T19:00:00Z';
  assert.equal(append(archive, capture(retry)).status, 'duplicate', 'fetch clock alone does not create a revision');
  const changedOriginal = input(); changedOriginal.payload.transactions[0].amount = '18.50';
  rejects(() => append(archive, capture(changedOriginal)), 'history-original-or-closing-conflict');
  const amendment = input('2030-02-02', 'plan-amendment');
  amendment.declaredAt = '2030-02-02T17:00:00Z'; amendment.effectiveFrom = START; amendment.reason = 'invented owner amendment';
  amendment.data.plan.budget.categories[0].plannedPayday = 55;
  const amendmentCandidate = capture(amendment), second = append(archive, amendmentCandidate);
  assert.equal(second.baselineRevision, first.revisionId);
  assert.equal(hash(firstPath), firstHash, 'retroactive amendment never rewrites original');

  const closingInput = input('2030-02-15', 'closing');
  const closing = append(archive, capture(closingInput));
  const correction = input('2030-02-16', 'actual-correction');
  correction.reason = 'invented later posting';
  correction.payload.transactions.push({ ...correction.payload.transactions[0], id: 'invented-late-posting', amount: '3.21' });
  const revised = append(archive, capture(correction));
  assert.equal(append(archive, amendmentCandidate).status, 'duplicate', 'an old delivery retry remains a no-op after later revisions');
  assert.equal(revised.previousRevision, closing.revisionId);
  assert.equal(hash(firstPath), firstHash);
  const record = History.read({ destination: archive, revisionId: first.revisionId });
  assert.equal(record.content.evidence.input.payload.transactions[0].id, 'invented-transaction', 'provider identity retained privately');
  assert.equal(record.content.evidence.input.payload.transactions[0].original_name, 'INVENTED MARKET SOURCE');
  assert.deepEqual(History.replayPublication(record), record.content.publication);
  const incompatible = clone(record); incompatible.content.engine.files.find(file => file.path === 'public/forecast.js').sha256 = 'b'.repeat(64);
  // A changed private record is caught before replay, even if its public amounts agree.
  rejects(() => History.replayPublication(incompatible), 'history-capture-integrity-failed');
  assert.equal(History.read({ destination: archive }).length, 4);
  assert.ok(!JSON.stringify(History.read({ destination: archive })).includes('invented-transaction'), 'metadata never exports source IDs');

  const notesOnly = clone(correction); notesOnly.capturedAt = '2030-02-16T19:01:00Z';
  notesOnly.payload.fetchedAt = '2030-02-16T19:00:00Z'; notesOnly.payload.transactions[0].notes = 'invented changed evidence';
  assert.equal(append(archive, capture(notesOnly)).status, 'appended', 'source changes remain revisions even when amounts agree');

  // Regenerate saved inputs through capture after newer revisions, rather than
  // redelivering the exact candidate. The runtime clock changes captureId.
  const retryResults = [], retryExpected = [];
  for (const kind of ['plan-amendment', 'actual-correction']) {
    const destination = directory('regenerated-' + kind);
    append(destination, capture(input()));
    const earlierAmendment = input('2030-02-02', 'plan-amendment');
    Object.assign(earlierAmendment, { declaredAt: '2030-02-02T17:00:00Z', effectiveFrom: START, reason: 'invented first amendment' });
    earlierAmendment.data.plan.budget.categories[0].plannedPayday = 55;
    const amendmentReceipt = append(destination, capture(earlierAmendment));
    const laterAmendment = input('2030-02-03', 'plan-amendment');
    Object.assign(laterAmendment, { declaredAt: '2030-02-03T17:00:00Z', effectiveFrom: START, reason: 'invented second amendment' });
    laterAmendment.data.plan.budget.categories[0].plannedPayday = 65;
    append(destination, capture(laterAmendment));
    const observedClose = input('2030-02-15', 'closing');
    observedClose.data.plan.budget.categories[0].plannedPayday = 65;
    append(destination, capture(observedClose));
    const earlierCorrection = input('2030-02-16', 'actual-correction');
    earlierCorrection.data.plan.budget.categories[0].plannedPayday = 65;
    earlierCorrection.payload.transactions[0].amount = '18.50';
    const correctionReceipt = append(destination, capture(earlierCorrection));
    const laterCorrection = input('2030-02-17', 'actual-correction');
    laterCorrection.data.plan.budget.categories[0].plannedPayday = 65;
    laterCorrection.payload.transactions[0].amount = '21.00';
    const newest = append(destination, capture(laterCorrection));
    const saved = kind === 'plan-amendment' ? earlierAmendment : earlierCorrection;
    const existing = kind === 'plan-amendment' ? amendmentReceipt : correctionReceipt;
    const regenerated = capture({ ...saved, capturedAt: '2030-02-18T18:01:00Z' });
    assert.notEqual(regenerated.captureId, existing.captureId, 'later capture is actually regenerated');
    const result = append(destination, regenerated), rows = History.read({ destination });
    const tip = History.read({ destination, revisionId: rows.at(-1).revisionId });
    retryResults.push({ kind, status: result.status, receipt: result.revisionId, count: rows.length,
      head: tip.revisionId, spent: tip.content.publication.householdBudget.find(row => row.id === 'groceries').spent });
    retryExpected.push({ kind, status: 'duplicate', receipt: existing.revisionId, count: 6, head: newest.revisionId, spent: 21 });

    if (kind === 'actual-correction') {
      for (const [index, change] of ['source', 'configuration', 'reason', 'engine'].entries()) {
        const distinct = change === 'source' ? input('2030-02-19', 'actual-correction') : clone(earlierCorrection);
        distinct.capturedAt = '2030-02-' + (19 + index) + 'T18:01:00Z';
        if (change === 'source') {
          distinct.data.plan.budget.categories[0].plannedPayday = 65;
          distinct.payload.transactions[0].amount = '18.50';
        }
        if (change === 'configuration') distinct.data.plan.budget.categories[0].plannedPayday = 75;
        if (change === 'reason') distinct.reason = 'invented separately justified correction';
        const next = capture(distinct);
        if (change === 'engine') {
          // An invented alternate engine version; reseal this synthetic envelope
          // with JSON's sorted-property serializer, without History internals.
          next.content.engine.commit = 'b'.repeat(40);
          const body = { schema: next.schema, capturedAt: next.capturedAt, content: next.content }, keys = new Set();
          const collect = value => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { keys.add(key); collect(child); } };
          collect(body);
          next.captureId = crypto.createHash('sha256').update(JSON.stringify(body, [...keys].sort())).digest('hex');
        }
        const receipt = append(destination, next);
        assert.equal(receipt.status, 'appended', 'distinct ' + change + ' evidence remains appendable');
        if (change === 'source') assert.equal(History.read({ destination, revisionId: receipt.revisionId })
          .content.publication.householdBudget.find(row => row.id === 'groceries').spent, 18.5,
        'genuinely newer source can correct back to an earlier amount without being mistaken for its old delivery');
      }
    }
  }
  assert.deepEqual(retryResults, retryExpected, 'regenerated amendment/correction retries preserve the existing receipt, count, newest head and actual publication');

  const unsupported = directory('unsupported');
  rejects(() => append(unsupported, capture(input('2030-02-15', 'actual-correction'))), 'history-closing-required');
  const reconstructed = capture(input('2030-02-15', 'reconstructed'));
  assert.equal(reconstructed.content.planBasis, 'current-policy-reconstruction');
  assert.equal(append(unsupported, reconstructed).kind, 'reconstructed');

  const brokenCoverage = input('2030-02-15', 'closing');
  brokenCoverage.payload.transactionWindow.complete = false;
  brokenCoverage.payload.pendingCoverage.complete = false;
  const incomplete = capture(brokenCoverage);
  assert.equal(incomplete.content.provenance.transactionWindow.complete, false);
  assert.equal(incomplete.content.provenance.pendingCoverage.complete, false);
  assert.ok(incomplete.content.publication.householdBudget.every(row => row.spent == null), 'unavailable actuals never become zero');

  const locked = directory('locked'); fs.writeFileSync(path.join(locked, '.capture.lock'), '', { mode: 0o600 });
  rejects(() => append(locked, candidate), 'history-capture-busy');
  assert.equal(files(locked).length, 0);
  const interrupted = directory('interrupted'), originalLink = fs.linkSync;
  try {
    fs.linkSync = () => { throw Object.assign(new Error('invented interruption'), { code: 'EIO' }); };
    rejects(() => append(interrupted, candidate), 'history-io-failed');
  } finally { fs.linkSync = originalLink; }
  assert.deepEqual(History.read({ destination: interrupted }), [], 'an interrupted staging write is not a committed revision');
  assert.equal(append(interrupted, candidate).status, 'appended', 'retry recovers after pre-publication failure');
  const afterCommit = directory('after-commit'), candidateFile = path.join(temporary, 'candidate.json');
  fs.writeFileSync(candidateFile, JSON.stringify(candidate), { mode: 0o600 });
  const killed = spawnSync(process.execPath, ['-e', `
    const fs = require('fs'), H = require(process.argv[1]);
    const realLink = fs.linkSync;
    fs.linkSync = (...args) => { realLink(...args); process.exit(73); };
    H.append({ destination: process.argv[2], enabled: true, candidate: JSON.parse(fs.readFileSync(process.argv[3])) });
  `, require.resolve('../scripts/private-period-history'), afterCommit, candidateFile], { encoding: 'utf8' });
  assert.equal(killed.status, 73);
  assert.equal(History.read({ destination: afterCommit }).length, 1, 'process crash after atomic publication leaves one complete readable revision');
  rejects(() => append(afterCommit, candidate), 'history-capture-busy');
  // The child is proven terminated; emulate the documented operator lock recovery.
  fs.unlinkSync(path.join(afterCommit, '.capture.lock'));
  assert.equal(append(afterCommit, candidate).status, 'duplicate');
  const restored = directory('restored');
  for (const file of files(archive)) fs.copyFileSync(path.join(archive, file), path.join(restored, file));
  assert.deepEqual(History.read({ destination: restored }), History.read({ destination: archive }), 'backup restore preserves the chain');
  const lastRestored = files(restored).sort().at(-1), expectedHead = History.read({ destination: restored }).at(-1).revisionId;
  fs.unlinkSync(path.join(restored, lastRestored));
  rejects(() => History.read({ destination: restored, expectedHead }), 'history-head-mismatch');
  fs.copyFileSync(path.join(archive, lastRestored), path.join(restored, lastRestored));
  const alteredPath = path.join(restored, files(restored)[0]);
  const altered = JSON.parse(fs.readFileSync(alteredPath)); altered.content.publication.budgetHold = 999;
  fs.writeFileSync(alteredPath, JSON.stringify(altered));
  rejects(() => History.read({ destination: restored }), 'history-capture-integrity-failed');
  fs.copyFileSync(firstPath, alteredPath);
  fs.unlinkSync(path.join(restored, files(restored)[1]));
  rejects(() => History.read({ destination: restored }), 'history-integrity-failed');
  for (const file of files(archive)) fs.copyFileSync(path.join(archive, file), path.join(restored, file));
  fs.appendFileSync(path.join(restored, files(restored)[0]), 'broken');
  rejects(() => History.read({ destination: restored }), 'history-io-failed');

  rejects(() => append(path.join(__dirname, '..'), candidate), 'history-destination-forbidden');
  const publicDir = directory('public'); rejects(() => append(publicDir, candidate), 'history-destination-forbidden');
  const linked = path.join(temporary, 'linked'); fs.symlinkSync(archive, linked, 'dir');
  rejects(() => append(linked, candidate), 'history-destination-forbidden');
  const nestedRepo = directory('nested-repository'); fs.mkdirSync(path.join(nestedRepo, '.git'));
  fs.writeFileSync(path.join(nestedRepo, '.git', 'HEAD'), 'ref: refs/heads/invented\n');
  rejects(() => append(nestedRepo, candidate), 'history-destination-forbidden');
  const bareRepo = directory('bare-repository'); fs.mkdirSync(path.join(bareRepo, 'objects')); fs.writeFileSync(path.join(bareRepo, 'HEAD'), 'invented');
  rejects(() => append(bareRepo, candidate), 'history-destination-forbidden');
  const symlinkEntry = directory('symlink-entry'); fs.symlinkSync(firstPath, path.join(symlinkEntry, path.basename(firstPath)));
  rejects(() => History.read({ destination: symlinkEntry }), 'history-entry-not-private');
  if (process.platform !== 'win32') {
    const exposed = directory('exposed'); fs.chmodSync(exposed, 0o755);
    rejects(() => append(exposed, candidate), 'history-destination-not-private');
  }
  const inputFile = path.join(temporary, 'input.json'); fs.writeFileSync(inputFile, JSON.stringify(oldSource), { mode: 0o600 });
  const preview = spawnSync(process.execPath, ['-e', `
    const RealDate = Date;
    global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2030-02-01T18:01:00Z'])); } };
    process.stdout.write(JSON.stringify(require(process.argv[1]).run(['capture', '--input', process.argv[2]])));
  `, cli, inputFile], { encoding: 'utf8' });
  assert.equal(preview.status, 0); assert.equal(JSON.parse(preview.stdout).status, 'disabled-preview');
  assert.ok(!preview.stdout.includes('invented-transaction') && !preview.stdout.includes('Invented Market'));
  const failure = spawnSync(process.execPath, [cli, 'capture', '--input', '/invented/private/source'], { encoding: 'utf8' });
  assert.equal(failure.status, 1); assert.equal(failure.stderr.trim(), 'history-cli-failed');
  assert.ok(!failure.stderr.includes('/invented/private/source'));
  console.log('PASS private pay-period archive: native capture, revisions, retry, recovery, integrity and privacy');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
