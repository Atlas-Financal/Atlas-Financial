'use strict';

// Known-failure gate for the invented ledger simulator.
//
// The simulator's own runner exits 0 whenever it completes, even when it has
// reproduced a financial defect. This gate turns its report into a pass/fail
// answer against a checked-in ledger of known failures (known-failures.json):
//
//   * a failure that matches a recorded entry is reported as expected;
//   * a failure that matches no entry fails the run (exit 1);
//   * a recorded entry that no longer reproduces fails the run (exit 1) and
//     tells the builder to remove that entry, so a fix cannot land without
//     the ledger being updated and the list cannot rot;
//   * a recorded entry whose smallest reproducing witness moved fails the run
//     (exit 1) with the values to record;
//   * a missing, unreadable, empty or malformed ledger, a report that is not
//     the sample the ledger describes, a tampered report, or a simulator
//     harness or coverage failure fails closed (exit 2).
//
// Usage, from the repository root:
//   node test/ledger-simulator/gate.js [--ledger FILE] [--report FILE]
//        [--output FILE] [--verdict FILE]
// Without --report it runs the fixed CI sample in process. --output saves
// that report. --verdict writes the verdict JSON, which names entries and
// signatures only, never rows or amounts.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { signature } = require('./signature');

const DEFAULT_LEDGER = path.join(__dirname, 'known-failures.json');
const STATUSES = ['open-pr', 'backlog', 'parked', 'unplaced'];
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

class LedgerError extends Error {}
const fail = (message) => {
  throw new LedgerError(message);
};
const text = (v) => typeof v === 'string' && v.trim().length > 0 && !v.includes('|');
const exactKeys = (obj, keys, where) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(where + ' must be an object');
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  const absent = keys.filter((k) => !Object.hasOwn(obj, k));
  if (extra.length || absent.length)
    fail(where + ' has unexpected keys [' + extra.join(', ') + '] or missing keys [' + absent.join(', ') + ']');
};

const keyOf = (e) => [e.invariant, e.cause, e.figure, e.habit, e.effect].join('|');

function validateLedger(ledger) {
  exactKeys(ledger, ['schema', 'note', 'run', 'entries'], 'ledger');
  if (ledger.schema !== 1) fail('ledger schema must be 1');
  if (!text(ledger.note)) fail('ledger note must be a non-empty string');
  exactKeys(ledger.run, ['mode', 'seeds', 'days'], 'ledger run');
  if (!text(ledger.run.mode)) fail('ledger run mode must be a string');
  if (
    !Array.isArray(ledger.run.seeds) ||
    !ledger.run.seeds.length ||
    !ledger.run.seeds.every((s) => Number.isSafeInteger(s) && s >= 0)
  )
    fail('ledger run seeds must be a non-empty list of whole numbers');
  if (!Number.isSafeInteger(ledger.run.days) || ledger.run.days < 0) fail('ledger run days must be a whole number');
  // An empty list fails closed. If every known failure is ever fixed, retiring
  // the ledger is a deliberate change to this gate, not an empty file.
  if (!Array.isArray(ledger.entries) || ledger.entries.length === 0)
    fail('ledger has no entries; an empty ledger fails closed');
  const ids = new Set(),
    keys = new Set();
  ledger.entries.forEach((e, i) => {
    const where = 'entry ' + (e && typeof e.id === 'string' ? e.id : '#' + i);
    exactKeys(
      e,
      ['id', 'invariant', 'cause', 'figure', 'habit', 'effect', 'rootCause', 'witness', 'clearedBy'],
      where
    );
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.id)) fail(where + ': id must be lower-case words joined by hyphens');
    for (const k of ['invariant', 'cause', 'figure', 'habit', 'effect', 'rootCause'])
      if (!text(e[k])) fail(where + ': ' + k + ' must be a non-empty string without "|"');
    exactKeys(e.witness, ['seed', 'day', 'panel', 'fault'], where + ' witness');
    if (!Number.isSafeInteger(e.witness.seed) || e.witness.seed < 0) fail(where + ': witness seed must be a whole number');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.witness.day)) fail(where + ': witness day must be YYYY-MM-DD');
    if (!text(e.witness.panel)) fail(where + ': witness panel must be a string');
    if (e.witness.fault !== null && !text(e.witness.fault)) fail(where + ': witness fault must be a string or null');
    exactKeys(e.clearedBy, ['status', 'ref'], where + ' clearedBy');
    if (!STATUSES.includes(e.clearedBy.status)) fail(where + ': clearedBy status must be one of ' + STATUSES.join(', '));
    if (!text(e.clearedBy.ref)) fail(where + ': clearedBy ref must name the issue, PR or backlog item');
    if (ids.has(e.id)) fail('duplicate entry id ' + e.id);
    if (keys.has(keyOf(e))) fail('duplicate entry for ' + keyOf(e));
    ids.add(e.id);
    keys.add(keyOf(e));
  });
  return ledger;
}

function loadLedger(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail('cannot read ledger ' + file + ': ' + err.code);
  }
  if (!raw.trim()) fail('ledger file is empty; an empty ledger fails closed');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('ledger is not valid JSON');
  }
  return validateLedger(parsed);
}

function validateReport(report, ledger, { checkIdentity }) {
  if (!report || typeof report !== 'object') fail('report must be an object');
  if (report.schema !== 2) fail('report schema must be 2');
  if (checkIdentity) {
    const { reportId, ...contents } = report;
    if (reportId !== digest(contents)) fail('report identity mismatch');
  }
  const run = ledger.run;
  if (report.mode !== run.mode || report.days !== run.days || JSON.stringify(report.seeds) !== JSON.stringify(run.seeds))
    fail(
      'report sample (' +
        JSON.stringify({ mode: report.mode, seeds: report.seeds, days: report.days }) +
        ') is not the sample the ledger describes (' +
        JSON.stringify(run) +
        ')'
    );
  if (report.rates && Object.keys(report.rates).length) fail('report used non-default frequency dials');
  for (const k of ['consensus', 'additional'])
    if (!Array.isArray(report[k]) || !report[k].every((g) => g && Array.isArray(g.witnesses)))
      fail('report ' + k + ' must be a list of groups with witnesses');
}

// Pure decision: no I/O. Returns the verdict object.
function judge(report, ledger) {
  const byKey = new Map(ledger.entries.map((e) => [keyOf(e), e]));
  const seen = new Map();
  const expected = [],
    unrecorded = [],
    drifted = [];
  for (const group of [...report.consensus, ...report.additional])
    for (const w of group.witnesses) {
      for (const k of ['check', 'cause', 'figure', 'habit'])
        if (typeof w[k] !== 'string') fail('report witness is missing ' + k);
      const key = w.check + '|' + signature(w);
      if (seen.has(key)) continue;
      seen.set(key, w);
      const entry = byKey.get(key);
      if (!entry) {
        unrecorded.push({
          key,
          witness: { seed: w.seed, day: w.day, panel: w.panel, fault: w.fault?.name ?? null },
        });
        continue;
      }
      const actual = { seed: w.seed, day: w.day, panel: w.panel, fault: w.fault?.name ?? null };
      if (JSON.stringify(actual) !== JSON.stringify(entry.witness))
        drifted.push({ id: entry.id, recorded: entry.witness, actual });
      else expected.push(entry.id);
    }
  const stale = ledger.entries.filter((e) => !seen.has(keyOf(e))).map((e) => e.id);
  const ok = !unrecorded.length && !stale.length && !drifted.length;
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    expected,
    unrecorded,
    stale,
    drifted,
    missingConsensus: report.missingConsensus || [],
  };
}

function explain(v, ledgerFile) {
  const rel = path.relative(process.cwd(), ledgerFile) || ledgerFile;
  const lines = [];
  lines.push('Ledger simulator gate: ' + v.verdict);
  lines.push(v.expected.length + ' known failure(s) reproduced as recorded in ' + rel + ':');
  for (const id of v.expected) lines.push('  expected  ' + id);
  for (const u of v.unrecorded)
    lines.push(
      '  NEW       ' +
        u.key +
        ' (smallest witness: seed ' +
        u.witness.seed +
        ', day ' +
        u.witness.day +
        ', panel ' +
        u.witness.panel +
        (u.witness.fault ? ', fault ' + u.witness.fault : '') +
        '). This failure is not in the known-failure ledger. Fix the defect, or record it in ' +
        rel +
        ' with its root cause and the item expected to clear it.'
    );
  for (const id of v.stale)
    lines.push(
      '  STALE     ' +
        id +
        ' no longer reproduces. If a fix landed, remove entry "' +
        id +
        '" from ' +
        rel +
        ' in the same pull request' +
        (v.missingConsensus.length
          ? '. For a fixed consensus case (' + v.missingConsensus.join(', ') + '), also keep a control as the simulator brief requires (#1611 7231990282)'
          : '') +
        '.'
    );
  for (const d of v.drifted)
    lines.push(
      '  MOVED     ' +
        d.id +
        ' still reproduces, but its smallest witness changed from ' +
        JSON.stringify(d.recorded) +
        ' to ' +
        JSON.stringify(d.actual) +
        '. Update that entry\'s "witness" in ' +
        rel +
        ', after checking the change is expected.'
    );
  return lines.join('\n') + '\n';
}

function options(argv) {
  const opts = { ledger: DEFAULT_LEDGER };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!['--ledger', '--report', '--output', '--verdict'].includes(arg)) throw new LedgerError('unknown option ' + arg);
    if (i + 1 >= argv.length) throw new LedgerError('missing value for ' + arg);
    opts[arg.slice(2)] = argv[++i];
  }
  return opts;
}

async function main(argv) {
  const opts = options(argv);
  const ledger = loadLedger(opts.ledger);
  let report;
  if (opts.report) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(opts.report, 'utf8'));
    } catch {
      fail('cannot read report ' + opts.report);
    }
    report = parsed;
    validateReport(report, ledger, { checkIdentity: true });
  } else {
    const sim = require('./run');
    assert.equal(ledger.run.mode, 'advisory', 'the in-process gate runs the fixed advisory sample');
    report = await sim.run({ ...sim.options(['--advisory']), tolerateMissingConsensus: true });
    if (opts.output) fs.writeFileSync(opts.output, JSON.stringify(report, null, 2) + '\n');
    validateReport(report, ledger, { checkIdentity: true });
  }
  const verdict = judge(report, ledger);
  if (opts.verdict) fs.writeFileSync(opts.verdict, JSON.stringify(verdict, null, 2) + '\n');
  process.stdout.write(explain(verdict, opts.ledger));
  return verdict.verdict === 'PASS' ? 0 : 1;
}

if (require.main === module)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      if (err instanceof LedgerError) console.error('LEDGER OR REPORT FAILURE (fails closed): ' + err.message);
      else console.error('HARNESS OR COVERAGE FAILURE', err.stack);
      process.exitCode = 2;
    }
  );

module.exports = { judge, validateLedger, loadLedger, validateReport, keyOf, LedgerError, digest };
