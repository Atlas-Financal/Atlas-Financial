'use strict';

// Proves the known-failure gate's exit status with a small invented stand-in
// invariant, so these tests do not depend on Atlas's current defects staying
// put. Each case writes an invented ledger and an invented report, runs the
// real gate command on them and checks its exit code and message.
//
//   node test/ledger-simulator/test-gate.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { digest, judge, validateLedger, loadLedger, keyOf } = require('./gate');
const { effect } = require('./signature');

const GATE = path.join(__dirname, 'gate.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-gate-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

// Stand-in invariant: a published total must equal the sum of its rows.
// Invented worlds, integer cents.
function totalMatchesRows(world) {
  const expected = world.rows.reduce((n, r) => n + r.cents, 0);
  return expected === world.published
    ? []
    : [
        {
          check: 'stand-in-total',
          cause: 'stand-in/' + world.cause,
          figure: 'Invented total',
          habit: world.habit,
          expected,
          actual: world.published,
        },
      ];
}
const brokenA = { cause: 'double-count', habit: 'invented-repeat', rows: [{ cents: 1000 }, { cents: 1500 }], published: 3500 };
const fixedA = { ...brokenA, published: 2500 };
const brokenB = { cause: 'dropped-row', habit: 'invented-late', rows: [{ cents: 700 }, { cents: 300 }], published: 700 };

const RUN = { mode: 'advisory', seeds: [11], days: 3 };
function report(worlds, { seed = 11, day = '2026-10-02', panel = 'stand-in', sample = RUN } = {}) {
  const failures = worlds.flatMap(totalMatchesRows);
  const contents = {
    schema: 2,
    mode: sample.mode,
    seeds: sample.seeds,
    days: sample.days,
    rates: {},
    stats: {},
    consensus: [],
    additional: failures.map((f) => ({ cause: f.cause, witnesses: [{ ...f, seed, day, panel, rows: [] }] })),
  };
  return { ...contents, reportId: digest(contents) };
}
function entry(world, extra = {}) {
  const [f] = totalMatchesRows(world);
  return {
    id: 'stand-in-' + world.cause,
    invariant: f.check,
    cause: f.cause,
    figure: f.figure,
    habit: f.habit,
    effect: effect(f),
    rootCause: 'Invented stand-in defect for the gate tests.',
    witness: { seed: 11, day: '2026-10-02', panel: 'stand-in', fault: null },
    clearedBy: { status: 'unplaced', ref: 'Invented stand-in; nothing to clear' },
    ...extra,
  };
}
function ledger(entries, over = {}) {
  return { schema: 1, note: 'Invented ledger for the gate tests.', run: RUN, entries, ...over };
}
let n = 0;
function gate(ledgerValue, reportValue, { rawLedger } = {}) {
  n++;
  const lf = path.join(dir, 'ledger-' + n + '.json'),
    rf = path.join(dir, 'report-' + n + '.json');
  if (rawLedger !== undefined) fs.writeFileSync(lf, rawLedger);
  else if (ledgerValue !== undefined) fs.writeFileSync(lf, JSON.stringify(ledgerValue));
  fs.writeFileSync(rf, typeof reportValue === 'string' ? reportValue : JSON.stringify(reportValue));
  const out = spawnSync(process.execPath, [GATE, '--ledger', lf, '--report', rf], { encoding: 'utf8' });
  return { code: out.status, text: out.stdout + out.stderr };
}
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok ' + passed + ' - ' + name);
}

// The stand-in invariant itself detects its violation and passes when fixed.
test('stand-in invariant detects a wrong total and passes a right one', () => {
  assert.equal(totalMatchesRows(brokenA).length, 1);
  assert.equal(totalMatchesRows(fixedA).length, 0);
});

test('an unrecorded invariant failure exits non-zero', () => {
  const r = gate(ledger([entry(brokenB)]), report([brokenA, brokenB]));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /NEW +stand-in-total\|stand-in\/double-count\|Invented total\|invented-repeat\|too-high/);
  assert.match(r.text, /not in the known-failure ledger/);
});

test('a recorded invariant failure is reported as expected and exits zero', () => {
  const r = gate(ledger([entry(brokenA)]), report([brokenA]));
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /PASS/);
  assert.match(r.text, /expected +stand-in-double-count/);
});

test('a recorded failure that no longer reproduces exits non-zero and says to remove the entry', () => {
  const r = gate(ledger([entry(brokenA), entry(brokenB)]), report([fixedA, brokenB]));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /STALE +stand-in-double-count no longer reproduces/);
  assert.match(r.text, /remove entry "stand-in-double-count"/);
  assert.match(r.text, /expected +stand-in-dropped-row/);
});

test('a recorded failure whose smallest witness moved exits non-zero with the new witness', () => {
  const r = gate(ledger([entry(brokenA)]), report([brokenA], { day: '2026-10-03' }));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /MOVED +stand-in-double-count/);
  assert.match(r.text, /"day":"2026-10-03"/);
});

test('a failure with the same cause but a different effect is not covered by the entry', () => {
  const lower = { ...brokenA, published: 2000 };
  const r = gate(ledger([entry(brokenA)]), report([lower]));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /NEW .*too-low/);
  assert.match(r.text, /STALE +stand-in-double-count/);
});

// Fail closed: every corrupted or empty ledger exits 2, before any judgement.
const closed = [
  ['missing ledger file', { ledger: undefined }],
  ['empty ledger file', { rawLedger: '' }],
  ['ledger that is not JSON', { rawLedger: '{"schema":1,' }],
  ['ledger with no entries', { ledger: ledger([]) }],
  ['ledger with entries missing', { ledger: { schema: 1, note: 'x', run: RUN } }],
  ['ledger with the wrong schema', { ledger: ledger([entry(brokenA)], { schema: 2 }) }],
  ['entry with no clearing item', { ledger: ledger([{ ...entry(brokenA), clearedBy: undefined }]) }],
  ['entry with a blank clearing ref', { ledger: ledger([entry(brokenA, { clearedBy: { status: 'backlog', ref: ' ' } })]) }],
  ['entry with an unknown clearing status', { ledger: ledger([entry(brokenA, { clearedBy: { status: 'soon', ref: 'x' } })]) }],
  ['entry with an extra field', { ledger: ledger([{ ...entry(brokenA), extra: 1 }]) }],
  ['entry with a bad witness day', { ledger: ledger([entry(brokenA, { witness: { seed: 11, day: '10/02', panel: 'p', fault: null } })]) }],
  ['duplicate entry ids', { ledger: ledger([entry(brokenA), entry(brokenB, { id: 'stand-in-double-count' })]) }],
  ['two entries for one failure', { ledger: ledger([entry(brokenA), entry(brokenA, { id: 'stand-in-again' })]) }],
  ['ledger run that is not the report sample', { ledger: ledger([entry(brokenA)], { run: { ...RUN, seeds: [12] } }) }],
];
for (const [name, c] of closed)
  test('fails closed: ' + name, () => {
    const r = gate(c.ledger, report([brokenA]), { rawLedger: c.rawLedger });
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /fails closed/);
  });

test('fails closed on a tampered report', () => {
  const rep = report([brokenA]);
  rep.additional[0].witnesses[0].actual = 2500;
  const r = gate(ledger([entry(brokenA)]), rep);
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /report identity mismatch/);
});

test('fails closed on an unreadable report', () => {
  const r = gate(ledger([entry(brokenA)]), 'not json');
  assert.equal(r.code, 2, r.text);
});

test('the pure judgement matches the command', () => {
  const v = judge(report([fixedA, brokenB]), validateLedger(ledger([entry(brokenA), entry(brokenB)])));
  assert.deepEqual(
    { verdict: v.verdict, expected: v.expected, stale: v.stale, unrecorded: v.unrecorded.length },
    { verdict: 'FAIL', expected: ['stand-in-dropped-row'], stale: ['stand-in-double-count'], unrecorded: 0 }
  );
});

// The checked-in ledger is well formed and names the fixed CI sample.
test('the checked-in known-failure ledger is valid and names a clearing item for every entry', () => {
  const real = loadLedger(path.join(__dirname, 'known-failures.json'));
  assert.deepEqual(real.run, { mode: 'advisory', seeds: [73], days: 7 });
  for (const e of real.entries) assert.ok(e.clearedBy.ref.length > 10, e.id);
  // The six consensus causes are each recorded at least once.
  const causes = new Set(real.entries.map((e) => e.cause));
  for (const c of ['topup', 'line-payment', 'equal-card', 'bill', 'shopping', 'false-minimum'])
    assert.ok(causes.has(c), 'consensus cause not recorded: ' + c);
  assert.equal(new Set(real.entries.map(keyOf)).size, real.entries.length);
});

console.log('known-failure gate: ' + passed + ' checks passed');
