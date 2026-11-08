'use strict';
/* Dated account-balance snapshots — a by-product of successful refresh.
 *
 *   node scripts/snapshot-balances.js
 *   node scripts/snapshot-balances.js --from-git <rev>
 *   node scripts/snapshot-balances.js --data PATH --positions PATH --map PATH --out DIR
 *
 * After an owner-approved canonical edit to data.json, run this. It writes
 * snapshots/<YYYY-MM-DD>.json for that document's as-of date.
 *
 * data.json remains the current-state authority. A snapshot is a historical
 * observation, not a second live balance, not Forecast input, and not a
 * spending series. public/periods.json still owns spending / interest / fees.
 *
 * The writer is not a second reconciler. It copies canonical balances for
 * accounts whose contemporaneous positions.csv as_of equals the snapshot
 * date, and refuses to write when a same-date positions row disagrees
 * with data.json. Mixed-date rows are omitted, not back-dated.
 *
 * Spendable completeness for that date is derived from
 * plan.startingCash.breakdown on the same canonical opening and stored as
 * snapshot coverage metadata. The page consumes that metadata; it does
 * not re-declare that dated membership. The legacy spendableCoverage/pot names
 * cover the recorded breakdown, including reserves; they do not establish
 * current Forecast spendable cash. History labels this as recorded balances.
 *
 * Re-running the same dated reading is a no-op. An existing file whose
 * contents disagree with the current reading is a hard failure — this
 * command does not rewrite history.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DATA = path.join(ROOT, 'data.json');
const DEFAULT_CSV = path.join(ROOT, 'docs', 'positions.csv');
const DEFAULT_MAP = path.join(ROOT, 'docs', 'reconciliation', 'balance-map.json');
const DEFAULT_OUT = path.join(ROOT, 'snapshots');
const SCHEMA = 'atlas-balance-snapshot/v1';
const HISTORY_SCHEMA = 'atlas-balance-history/v1';
const ISO = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SNAPSHOT_NAME = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.json$/;
const EPSILON = 0.005;

const POLICY_KEYS = [
  'plan', 'actions', 'nextDollar', 'budget', 'assumptions', 'questions',
  'income', 'bills', 'commitments', 'settled', 'helocHistory', 'helocUse',
  'paypal', 'lacrosse', 'interestCheck', 'cashflow', 'unexplained',
];

function near(a, b) {
  return Math.abs(Number(a) - Number(b)) <= EPSILON;
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

// A missing balance is unknown, never zero. Number(null) and Number('')
// are both 0, so a canonical value:null or a blank positions.csv cell
// would otherwise pass the equality check and publish as a complete $0
// reading. Only a finite number, or a non-blank numeric string, is known.
function knownNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parsePositions(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cols = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i]; });
    return row;
  });
}

function cashRows(data) {
  const cash = (data.plan && data.plan.startingCash) || {};
  return {
    breakdown: cash.breakdown || [],
    heldElsewhere: cash.heldElsewhere || [],
  };
}

function findCash(data, id) {
  const pots = cashRows(data);
  const inBreakdown = pots.breakdown.find(r => r.id === id);
  if (inBreakdown) return { row: inBreakdown, pot: 'spendable' };
  const elsewhere = pots.heldElsewhere.find(r => r.id === id);
  if (elsewhere) return { row: elsewhere, pot: 'held-elsewhere' };
  return null;
}

function expectedSpendableIds(data) {
  const breakdown = cashRows(data).breakdown || [];
  const ids = [];
  const seen = new Set();
  for (const row of breakdown) {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    ids.push(row.id);
  }
  ids.sort();
  return ids;
}

function spendableCoverageFrom(data, accounts) {
  const expectedIds = expectedSpendableIds(data);
  const present = new Set(
    (accounts || [])
      .filter(a => a && a.collection === 'cash' && a.pot === 'spendable'
        && Number.isFinite(knownNumber(a.balance)))
      .map(a => a.id)
  );
  return {
    expectedIds,
    complete: expectedIds.length > 0 && expectedIds.every(id => present.has(id)),
  };
}

function findDebt(data, id) {
  return ((data.debts || []).find(r => r.id === id)) || null;
}

function snapshotAsOf(data) {
  const meta = data && data.meta && data.meta.asOf;
  if (typeof meta !== 'string' || !ISO.test(meta)) {
    throw new Error('data.json meta.asOf is missing or not YYYY-MM-DD');
  }
  const opening = data.plan && data.plan.opening && data.plan.opening.asOf;
  if (typeof opening === 'string' && opening && opening !== meta) {
    throw new Error(`meta.asOf ${meta} disagrees with plan.opening.asOf ${opening}`);
  }
  return meta;
}

function buildAccount(mapping, data, posRow) {
  const target = mapping.canonical;
  const collection = target.collection;
  const id = target.id;
  let balance;
  let label;
  let confidence;
  let pending;
  let pendingUnknown = false;
  let pot;
  if (collection === 'cash') {
    const found = findCash(data, id);
    if (!found) return { skip: 'missing-canonical' };
    balance = knownNumber(found.row.value);
    label = found.row.label || mapping.accountLabel;
    confidence = found.row.confidence || posRow.confidence || null;
    pot = found.pot;
  } else if (collection === 'debts') {
    const row = findDebt(data, id);
    if (!row) return { skip: 'missing-canonical' };
    balance = knownNumber(row.balance);
    label = row.label || mapping.accountLabel;
    confidence = row.confidence || posRow.confidence || null;
    if (row.pendingUnknown === true) {
      pendingUnknown = true;
      pending = null;
    } else if (!Number.isFinite(knownNumber(row.pending))) {
      pending = null;
    } else {
      pending = round2(row.pending);
    }
  } else {
    return { skip: 'unsupported-collection' };
  }
  if (!Number.isFinite(balance)) return { skip: 'non-numeric-balance' };

  const posBalance = knownNumber(posRow.balance);
  if (!Number.isFinite(posBalance) || !near(balance, posBalance)) {
    throw new Error(
      `${id}: canonical ${balance} disagrees with positions.csv ${posRow.balance} on ${posRow.as_of}`
    );
  }

  const side = String(posRow.side || '').toLowerCase() === 'liability' ? 'liability' : 'asset';
  const rec = {
    id,
    label,
    collection,
    side,
    currency: posRow.currency || 'CAD',
    balance: round2(balance),
  };
  if (collection === 'debts') {
    rec.pending = pending;
    if (pendingUnknown) rec.pendingUnknown = true;
  }
  if (pot) rec.pot = pot;
  if (confidence) rec.confidence = String(confidence).toLowerCase().startsWith('verified')
    ? 'verified'
    : String(confidence);
  rec.provenance = {
    canonicalLocator: `${collection}:${id}`,
    observationId: mapping.observationId,
    sourceAsOf: posRow.as_of,
  };
  return rec;
}

function buildSnapshot(data, positionsRows, map) {
  const asOf = snapshotAsOf(data);
  const mappings = (map && map.mappings) || [];
  if (!mappings.length) throw new Error('balance-map.json has no mappings');

  const byLabel = new Map();
  for (const row of positionsRows) {
    if (row.entity !== 'Household') continue;
    if (row.account_label) byLabel.set(row.account_label, row);
  }

  const accounts = [];
  const omitted = [];
  for (const mapping of mappings) {
    const posRow = byLabel.get(mapping.accountLabel);
    if (!posRow) {
      omitted.push({ id: mapping.canonical.id, reason: 'no-positions-row' });
      continue;
    }
    if (posRow.as_of !== asOf) {
      omitted.push({
        id: mapping.canonical.id,
        reason: 'different-as-of',
        sourceAsOf: posRow.as_of,
      });
      continue;
    }
    const rec = buildAccount(mapping, data, posRow);
    if (rec.skip) {
      omitted.push({ id: mapping.canonical.id, reason: rec.skip });
      continue;
    }
    accounts.push(rec);
  }

  if (!accounts.length) {
    throw new Error(`no same-date accounts for ${asOf}; refusing an empty snapshot`);
  }

  accounts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schema: SCHEMA,
    asOf,
    role: 'historical-observation',
    currentStateAuthority: 'data.json',
    spendableCoverage: spendableCoverageFrom(data, accounts),
    accounts,
    omitted,
  };
}

function publicSnapshot(doc) {
  const out = {
    schema: doc.schema,
    asOf: doc.asOf,
    role: doc.role,
    currentStateAuthority: doc.currentStateAuthority,
  };
  if (doc.spendableCoverage) {
    out.spendableCoverage = {
      expectedIds: Array.isArray(doc.spendableCoverage.expectedIds)
        ? doc.spendableCoverage.expectedIds.slice()
        : [],
      complete: doc.spendableCoverage.complete === true,
    };
  }
  out.accounts = doc.accounts;
  return out;
}

function encodeSnapshot(doc) {
  return JSON.stringify(publicSnapshot(doc), null, 4) + '\n';
}

function snapshotPath(dir, asOf) {
  return path.join(dir, `${asOf}.json`);
}

function assertNoPolicy(doc) {
  const blob = JSON.stringify(doc);
  for (const key of POLICY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(doc, key)) {
      throw new Error(`snapshot must not carry policy/current-state key ${key}`);
    }
  }
  if (/"plan"\s*:/.test(blob) || /"nextDollar"\s*:/.test(blob) || /"SITE_PASSWORD"/.test(blob)) {
    throw new Error('snapshot contains forbidden policy or secret material');
  }
}

function writeSnapshot(doc, destDir) {
  if (!doc || !ISO.test(doc.asOf)) throw new Error('snapshot asOf is not YYYY-MM-DD');
  assertNoPolicy(doc);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = snapshotPath(destDir, doc.asOf);
  const encoded = encodeSnapshot(doc);
  if (fs.existsSync(dest)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch (err) {
      throw new Error(`existing ${path.basename(dest)} is not readable JSON: ${err.message}`);
    }
    if (existing.asOf && existing.asOf !== doc.asOf) {
      throw new Error(`existing ${path.basename(dest)} asOf ${existing.asOf} does not match filename`);
    }
    if (JSON.stringify(publicSnapshot(existing)) === JSON.stringify(publicSnapshot(doc))) {
      return { status: 'unchanged', path: dest, asOf: doc.asOf, accounts: doc.accounts.length };
    }
    const err = new Error(
      `snapshot ${doc.asOf} already exists and disagrees with the current reading; refusing to rewrite history`
    );
    err.code = 'SNAPSHOT_CONFLICT';
    err.path = dest;
    throw err;
  }
  fs.writeFileSync(dest, encoded, 'utf8');
  return { status: 'written', path: dest, asOf: doc.asOf, accounts: doc.accounts.length };
}

function loadSnapshotFile(file) {
  const name = path.basename(file);
  const m = SNAPSHOT_NAME.exec(name);
  if (!m) throw new Error(`refusing undated snapshot filename ${name}`);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.asOf !== `${m[1]}-${m[2]}-${m[3]}`) {
    throw new Error(`${name} asOf ${doc.asOf} does not match filename`);
  }
  if (doc.schema !== SCHEMA) throw new Error(`${name} has unexpected schema ${doc.schema}`);
  if (!Array.isArray(doc.accounts)) throw new Error(`${name} has no accounts array`);
  return doc;
}

function loadHistory(dir) {
  const root = dir || DEFAULT_OUT;
  if (!fs.existsSync(root)) {
    return {
      schema: HISTORY_SCHEMA,
      authority: 'snapshots/',
      currentStateAuthority: 'data.json',
      snapshots: [],
    };
  }
  const files = fs.readdirSync(root).filter(f => SNAPSHOT_NAME.test(f)).sort();
  const snapshots = files.map(f => {
    const doc = loadSnapshotFile(path.join(root, f));
    return publicSnapshot(doc);
  });
  return {
    schema: HISTORY_SCHEMA,
    authority: 'snapshots/',
    currentStateAuthority: 'data.json',
    snapshots,
  };
}

function gitShow(rev, file) {
  return execFileSync('git', ['show', `${rev}:${file.replace(/\\/g, '/')}`], {
    encoding: 'utf8',
    cwd: ROOT,
  });
}

function parseArgs(argv) {
  const out = {
    data: DEFAULT_DATA,
    positions: DEFAULT_CSV,
    map: DEFAULT_MAP,
    dest: DEFAULT_OUT,
    fromGit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') out.data = path.resolve(argv[++i]);
    else if (a === '--positions') out.positions = path.resolve(argv[++i]);
    else if (a === '--map') out.map = path.resolve(argv[++i]);
    else if (a === '--out') out.dest = path.resolve(argv[++i]);
    else if (a === '--from-git') out.fromGit = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function loadInputs(opts) {
  if (opts.fromGit) {
    return {
      data: JSON.parse(gitShow(opts.fromGit, 'data.json')),
      positions: parsePositions(gitShow(opts.fromGit, 'docs/positions.csv')),
      map: JSON.parse(gitShow(opts.fromGit, 'docs/reconciliation/balance-map.json')),
    };
  }
  return {
    data: JSON.parse(fs.readFileSync(opts.data, 'utf8')),
    positions: parsePositions(fs.readFileSync(opts.positions, 'utf8')),
    map: JSON.parse(fs.readFileSync(opts.map, 'utf8')),
  };
}

function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'Usage: node scripts/snapshot-balances.js [--from-git REV] [--data PATH] [--positions PATH] [--map PATH] [--out DIR]\n'
    );
    return { status: 'help' };
  }
  const inputs = loadInputs(opts);
  const doc = buildSnapshot(inputs.data, inputs.positions, inputs.map);
  return writeSnapshot(doc, opts.dest);
}

if (require.main === module) {
  try {
    const result = run(process.argv.slice(2));
    if (result.status === 'help') process.exit(0);
    process.stdout.write(
      `${result.status} ${result.asOf} (${result.accounts} accounts) ${result.path}\n`
    );
  } catch (err) {
    process.stderr.write(err.message + '\n');
    process.exit(err.code === 'SNAPSHOT_CONFLICT' ? 2 : 1);
  }
}

module.exports = {
  SCHEMA,
  HISTORY_SCHEMA,
  DEFAULT_OUT,
  parsePositions,
  parseCsvLine,
  snapshotAsOf,
  expectedSpendableIds,
  spendableCoverageFrom,
  buildSnapshot,
  writeSnapshot,
  loadHistory,
  publicSnapshot,
  encodeSnapshot,
  knownNumber,
  run,
};
