'use strict';

// ATLAS-080 resolver foundation: standalone, strictly synthetic proof for the
// pure settlement-evidence resolver (scripts/settlement-evidence-resolver.js).
// Everything here is a fixture: the acquisition { packet, join, plan, map } is
// INJECTED and labelled synthetic — the production crosswalk exporter that
// would produce the join's tuple -> emitted-row provenance from a real
// sanitizedCurrentPeriodActuals pass is UNIMPLEMENTED (addendum section A.8),
// the authorize used with the real controller/store is a deterministic ticket
// fixture (no production authorize exists; D1/P1 stay open), and the
// household/accounts/goals are synthetic. The resolver module itself exports
// no authorize and imports no session code. Case ids (AC-*, AD-*) name the
// contract cases each test pins, as amended by the addendum and Atlas's GO.
const test = require('node:test');
const LmGroups = require('./lm-groups-fixture.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const C = require('../scripts/planned-obligation-settlement-contract');
const S = require('../scripts/settlement-evidence-store');
const A = require('../scripts/settlement-evidence-file-adapter');
const L = require('../scripts/settlement-evidence-loader');
const { createSettlementEvidenceConfirmation } = require('../scripts/settlement-evidence-confirmation');
const R = require('../scripts/settlement-evidence-resolver');
const Forecast = require('../public/forecast.js');

const householdId = 'household-' + 'a'.repeat(32);
const otherHouseholdId = 'household-' + 'd'.repeat(32);
const actorId = 'session-' + 'b'.repeat(64);
const otherActor = 'session-' + 'c'.repeat(64);
const op = n => 'operation-' + n.toString(16).padStart(32, '0');
const context = { ticket: 'synthetic-session-a' };
const otherContext = { ticket: 'synthetic-session-b' };
const T0 = Date.parse('2026-10-20T12:00:00Z');
const clone = x => JSON.parse(JSON.stringify(x));
const AUTHORITY = { householdId, actorId };
const GOAL_ID = 'commitment:synthetic-trip';

// ---------------------------------------------------------------------------
// Synthetic acquisition fixtures. Packet rows carry LOCAL ids ('tx-1', ...)
// exactly as the shipped sanitizer emits them; the join facts are the
// explicit tuple -> emitted-row provenance of the same (synthetic) pass —
// one fact per emitted row, nothing for a row the sanitizer dropped.
// ---------------------------------------------------------------------------
const ACCT_A = 'synthetic-provider-account-a';
const ACCT_B = 'synthetic-provider-account-b';
const TUPLE_A = { providerAccountId: ACCT_A, transactionId: 'synthetic-provider-transaction-1' };
const TUPLE_B = { providerAccountId: ACCT_B, transactionId: 'synthetic-provider-transaction-2' };

function spendRow(overrides = {}) {
  return LmGroups.groupTx({
    id: 'tx-1', coverageRef: null, date: '2026-10-19', amount: 60, currency: 'cad',
    pending: false, categoryLabel: 'Groceries', merchantKnown: true,
    atlasAccountId: 'chequing-a', accountRole: 'household-cash', representedBill: false,
    ...overrides,
  }, standardPlan());
}
function standardPlan() {
  return LmGroups.groupPlan({
    commitments: [{ id: 'synthetic-trip', label: 'Synthetic Trip', amount: 300 }],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries' },
        { id: 'restaurants', label: 'Restaurants' },
        { id: 'insurance', label: 'Home Insurance' },
      ],
      excluded: [],
    },
  });
}
function standardPacket(rows, representedActuals = []) {
  return LmGroups.groupPacket({
    schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-10-20',
    coverageStart: '2026-10-01', coverageThrough: '2026-10-20',
    transactionWindow: { startDate: '2026-10-01', endDate: '2026-10-20', complete: true, hasMore: false, truncated: false },
    pendingCoverage: 'complete', transactionCoverage: 'complete',
    representedActuals, transactions: rows,
  }, standardPlan());
}
function standardMap() {
  return {
    provider: 'lunchmoney', schema: 'atlas-provider-account-map/v1', scope: 'synthetic-fixture',
    mappings: [
      { providerAccountId: ACCT_A, atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-a' } },
      { providerAccountId: ACCT_B, atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-b' } },
    ],
  };
}
function standardAcquisition() {
  return {
    packet: standardPacket([spendRow()]),
    join: [{ localId: 'tx-1', ...TUPLE_A }],
    plan: standardPlan(),
    map: standardMap(),
  };
}
function handlesFor(acq, tuple = TUPLE_A, goalId = GOAL_ID) {
  return {
    transaction: R.deriveSelectionHandle(R.computeInstanceDigest(acq.packet), { householdId, ...tuple }),
    commitment: R.deriveChoiceHandle(R.computePlanDigest(acq.plan), goalId),
  };
}
function makeResolver(acquire) {
  return R.createSettlementEvidenceResolver({ householdId, acquire });
}
function resolverFor(acq) {
  return makeResolver(async () => acq);
}
// A classify that runs the REAL Forecast classifier and records every call.
function classifyRecorder() {
  const calls = [];
  const classify = (tx, plan, opts) => {
    const verdict = Forecast.classifyCurrentPeriodTransaction(tx, plan, opts);
    calls.push({ tx, plan, opts, verdict });
    return verdict;
  };
  return { classify, calls };
}
// A classify stub for pure resolution semantics (the resolver never reads the
// verdict; the controller does — controller-level tests use the recorder's
// real verdicts through the controller's own closure instead).
function stubClassify() {
  const calls = [];
  const classify = (tx, plan, opts) => {
    calls.push({ tx, plan, opts });
    return { kind: 'spend', categoryId: 'groceries', householdSpending: true, reason: null, needsConfirmation: false };
  };
  return { classify, calls };
}
const resolveDirect = (resolver, selection, classify) =>
  resolver.resolveSelection({ authority: AUTHORITY, selection, classify });

// ---------------------------------------------------------------------------
// Controller-level world: the real confirmation controller + store + POSIX
// file adapter in a disposable temp dir, the real resolver over a mutable
// synthetic acquisition, and a deterministic ticket-fixture authorize.
// ---------------------------------------------------------------------------
async function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-resolver-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = {
    dir, time: T0, pin: null, backups: new Map(), calls: [], tokens: new Map(),
    acquisition: standardAcquisition(), authHook: null, acquireHook: null, acquireCalls: 0,
  };
  const pinStore = {
    async read() { return clone(w.pin); },
    async advance(expected, next) {
      const ok = expected === null ? w.pin === null
        : w.pin && expected.revision === w.pin.revision && expected.digest === w.pin.digest;
      if (!ok) return false;
      w.pin = clone(next);
      return true;
    },
  };
  const backupStore = {
    async put(revision, digest, bytes) {
      const entry = { revision, digest, artifactId: 'synthetic-backup-' + revision };
      w.backups.set(digest, { ...entry, bytes: Buffer.from(bytes) });
      return clone(entry);
    },
    async get(revision, digest) {
      const value = w.backups.get(digest);
      return value && value.revision === revision ? Buffer.from(value.bytes) : null;
    },
    async list() { return [...w.backups.values()].map(({ bytes, ...entry }) => clone(entry)); },
  };
  w.pinStore = pinStore;
  w.backupStore = backupStore;
  w.openStore = (hh = householdId) => S.createSettlementEvidenceStore({
    householdId: hh, ...A.createSettlementEvidenceFileAdapter(dir), pinStore, backupStore, now: () => w.time,
  });
  w.store = w.openStore();
  assert.equal((await w.store.bootstrap()).status, 'bootstrapped');
  w.authorize = async ctx => {
    if (w.authHook) return w.authHook(ctx);
    if (ctx && ctx.ticket === otherContext.ticket) return { householdId, actorId: otherActor };
    if (!ctx || ctx.ticket !== context.ticket) return null;
    return { householdId, actorId };
  };
  w.acquire = async () => {
    w.acquireCalls++;
    if (w.acquireHook) return w.acquireHook();
    return w.acquisition;
  };
  w.resolver = makeResolver(w.acquire);
  w.newController = (store = w.store, resolver = w.resolver) => createSettlementEvidenceConfirmation({
    householdId, authorize: w.authorize, resolveSelection: resolver.resolveSelection, now: () => w.time,
    store: {
      async prepare(input) { w.calls.push('prepare'); return store.prepare(input); },
      async commitWithoutRecovery(input) { w.calls.push('commitWithoutRecovery'); return store.commitWithoutRecovery(input); },
      commit() { assert.fail('controller must never fall back to ordinary recovering commit'); },
      async outcome(input) { w.calls.push('outcome'); return store.outcome(input); },
      bootstrap() { assert.fail('controller must never bootstrap'); },
      reconcile() { assert.fail('controller must never reconcile'); },
    },
  });
  w.controller = w.newController();
  w.selection = handlesFor(w.acquisition);
  w.prepare = async (n = 1, cents = 2500, ctx = context, selection = w.selection, controller = w.controller) => {
    const result = await controller.prepare(ctx, { operationId: op(n), selection: clone(selection), assignedCents: cents });
    if (result.status === 'prepared') w.tokens.set(op(n), result.previewToken);
    return result;
  };
  w.confirm = (n = 1, confirmed = true, ctx = context, controller = w.controller) => {
    const previewToken = w.tokens.get(op(n));
    return controller.confirm(ctx, {
      operationId: op(n), confirmed,
      ...(previewToken === undefined ? {} : { previewToken }),
    });
  };
  w.outcome = (n = 1, ctx = context, controller = w.controller) =>
    controller.outcome(ctx, { operationId: op(n) });
  w.documentBytes = () => fs.readFileSync(path.join(dir, 'document.json'));
  w.document = () => JSON.parse(w.documentBytes().toString('utf8'));
  w.load = () => L.loadSettlementEvidence({
    config: { householdId },
    readPin: () => clone(w.pin),
    readDocument: () => w.documentBytes(),
  });
  return w;
}
// The AC-4 latch event, shared by the AC-5 and restart tests: op1 commits
// durably while its post-commit reauthorization check sees a different actor,
// so confirm surfaces unknown and the controller's latch is set.
async function latchEvent(w) {
  await w.prepare(3);
  await w.prepare(1);
  let calls = 0;
  w.authHook = async () => {
    calls++;
    return calls >= 4 ? { householdId, actorId: otherActor } : { householdId, actorId };
  };
  const result = await w.confirm(1);
  w.authHook = null;
  assert.equal(result.status, 'unknown', 'post-commit reauthorization failure surfaces unknown');
  assert.equal(w.document().operations.length, 1, 'the commit is durable despite the unknown');
  return result;
}

// ---------------------------------------------------------------------------
// BIND (addendum section B). The encoder is exported precisely so these
// vectors pin the grammar independently of the resolver that consumes it.
// ---------------------------------------------------------------------------
const latin = buf => buf.toString('latin1');
const BIND_VECTORS = [
  [0, 'n1:0'], [-0, 'n2:-0'], [45, 'n2:45'], [45.5, 'n4:45.5'], [0.1, 'n3:0.1'],
  [1 / 3, 'n18:0.' + '3'.repeat(16)], [1e20, 'n21:100000000000000000000'],
  [1e21, 'n5:1e+21'], [5e-324, 'n6:5e-324'], [-1.5e-7, 'n7:-1.5e-7'],
  [null, 'z'], [undefined, 'u'], [true, 't'],
  [{}, 'o0:'], [{ a: undefined }, 'o1:s1:au'], [{ a: null }, 'o1:s1:az'],
  [[], 'a0:'], [[undefined], 'a1:u'], [[null], 'a1:z'], [[,], 'a1:h'],
  [[[1, , 2]], 'a1:a3:n1:1hn1:2'],
  ['a"b\n', 's4:a"b\x0a'],
  ['a\uD800b', 's5:a\xed\xa0\x80b'],
  ['\uFFFD', 's3:\xef\xbf\xbd'],
  [{ '\u{10000}': 1, '\uE000': 2 }, 'o2:s3:\xee\x80\x80n1:2s4:\xf0\x90\x80\x80n1:1'],
  [{ amount: 45.5, pending: false, note: undefined, parent: null },
    'o4:s6:amountn4:45.5s4:noteus6:parentzs7:pendingf'],
];

test('AC-15 BIND golden vectors V1-V28 reproduce byte-for-byte; V29 worked digest matches', () => {
  BIND_VECTORS.forEach(([input, expected], i) => {
    assert.equal(latin(R.bindEncode(input)), expected, `V${i + 1}`);
  });
  const shared = { v: 1 };
  assert.equal(latin(R.bindEncode([shared, shared])), 'a2:o1:s1:vn1:1o1:s1:vn1:1', 'V26 alias');
  assert.equal(latin(R.bindEncode([{ v: 1 }, { v: 1 }])), 'a2:o1:s1:vn1:1o1:s1:vn1:1', 'V27 duplicate');
  assert.equal(
    R.bindDigest({ domain: 'atlas-settlement-selection-binding/v1', amount: 45.5, pending: false, note: undefined, parent: null }),
    'f2fcef639aae7d0f3220c1417634ebb7c01610447433a9046f32ecd08dada38e', 'V29 worked digest');
});

test('AC-16 BIND distinctions the grammar exists to keep', () => {
  assert.notEqual(latin(R.bindEncode(-0)), latin(R.bindEncode(0)), '-0 differs from 0');
  assert.notEqual(latin(R.bindEncode([,])), latin(R.bindEncode([undefined])), 'hole differs from present undefined');
  assert.notEqual(latin(R.bindEncode([undefined])), latin(R.bindEncode([null])), 'undefined differs from null');
  assert.notEqual(latin(R.bindEncode({ a: undefined })), latin(R.bindEncode({})), 'present-undefined key binds');
  assert.notEqual(latin(R.bindEncode('a\uD800b')), latin(R.bindEncode('\uFFFD')), 'lone surrogate differs from U+FFFD (WTF-8 is injective)');
  assert.notEqual(latin(R.bindEncode([1, 2])), latin(R.bindEncode([2, 1])), 'array order is significant');
  // Key order is UTF-8 byte order, not the ledger's UTF-16 order: U+E000
  // sorts before U+10000 here (V25), the reverse of UTF-16 code-unit order.
  const pair = { '\u{10000}': 1, '\uE000': 2 };
  assert.ok(latin(R.bindEncode(pair)).startsWith('o2:s3:\xee\x80\x80'), 'UTF-8 byte key order');
});

test('AC-17 BIND rejection vectors and fail-closed bounds', () => {
  const cyclic = {}; cyclic.self = cyclic;
  let depth21 = {}; { let cur = depth21; for (let i = 0; i < 20; i++) { cur.n = {}; cur = cur.n; } }
  const rejections = [
    ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
    ['cyclic record', cyclic], ['Date', new Date()], ['Map', new Map()],
    ['class instance', new (class {})()], ['function value', { f() {} }],
    ['bigint', 10n], ['symbol value', Symbol('v')],
    ['symbol key', { [Symbol('s')]: 1 }],
    ['depth-21 nesting', depth21],
    ['non-enumerable key', (() => { const o = {}; Object.defineProperty(o, 'h', { value: 1, enumerable: false }); return o; })()],
    ['array too long', new Array(R.BIND_LIMITS.maxArrayLength + 1)],
    ['string too long', 'x'.repeat(R.BIND_LIMITS.maxStringBytes + 1)],
    ['key too long', { ['k'.repeat(R.BIND_LIMITS.maxKeyBytes + 1)]: 1 }],
    ['too many keys', Object.fromEntries(Array.from({ length: R.BIND_LIMITS.maxKeysPerRecord + 1 }, (_, i) => ['k' + i, i]))],
    ['too many nodes', Array.from({ length: R.BIND_LIMITS.maxNodes + 1 }, () => 1)],
  ];
  for (const [label, input] of rejections) {
    assert.throws(() => R.bindEncode(input), undefined, label);
    assert.throws(() => R.bindSnapshot(input), undefined, 'snapshot: ' + label);
  }
  // Depth exactly at the bound is admitted (top record is depth 1).
  let depth20 = {}; { let cur = depth20; for (let i = 0; i < 19; i++) { cur.n = {}; cur = cur.n; } }
  assert.doesNotThrow(() => R.bindEncode(depth20), 'depth 20 admitted');
  assert.throws(() => R.bindDigest({ noDomain: true }), undefined, 'bindDigest requires a string domain');
  assert.throws(() => R.bindDigest('not-a-record'), undefined, 'bindDigest requires a plain record');
});

test('AD-7 snapshot parity: snapshot-then-encode equals direct encode; rejections throw identically', () => {
  for (const [input] of BIND_VECTORS) {
    const snap = R.bindSnapshot(input);
    assert.equal(latin(R.bindEncode(snap)), latin(R.bindEncode(input)), 'parity');
    if (input !== null && typeof input === 'object') assert.notEqual(snap, input, 'never reference-identical');
  }
  // An accessor's getter is never invoked by snapshot or encode.
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'g', { enumerable: true, get() { getterCalls++; return 1; } });
  assert.throws(() => R.bindSnapshot(accessor));
  assert.throws(() => R.bindEncode(accessor));
  assert.equal(getterCalls, 0, 'getter invocation counter stays 0');
  // Holes and present-undefined keys survive the snapshot; later source
  // mutation cannot reach the copy.
  const src = { a: [1, , 3], b: undefined };
  const snap = R.bindSnapshot(src);
  assert.equal(1 in snap.a, false, 'hole preserved');
  assert.ok(Object.hasOwn(snap, 'b'), 'present-undefined key preserved');
  src.a[0] = 99; src.b = 'mutated';
  assert.equal(latin(R.bindEncode(snap)), 'o2:s1:aa3:n1:1hn1:3s1:bu');
  // Encoding is preserved through freeze (no lossy clone anywhere).
  const frozen = R.freezeDeep(R.bindSnapshot({ x: [1, { y: 'z' }], u: undefined }));
  assert.equal(latin(R.bindEncode(frozen)), latin(R.bindEncode({ x: [1, { y: 'z' }], u: undefined })));
});

test('Amendment 4 / AD-7 pins: descriptor-safe __proto__, getter-free holes, incremental bounds', () => {
  // An own __proto__ data property stays an own data property: the snapshot
  // is built descriptor-by-descriptor, never by assignment, so no prototype
  // is mutated and nothing is polluted.
  const rec = {};
  Object.defineProperty(rec, '__proto__', { value: { marker: 1 }, enumerable: true, writable: true, configurable: true });
  const snap = R.bindSnapshot(rec);
  assert.ok(Object.hasOwn(snap, '__proto__'), '__proto__ remains an own property');
  assert.deepEqual(snap['__proto__'], { marker: 1 });
  assert.equal(Object.getPrototypeOf(snap), Object.prototype, 'snapshot prototype unmutated');
  assert.equal({}.marker, undefined, 'Object.prototype unpolluted');
  assert.equal(latin(R.bindEncode(snap)), latin(R.bindEncode(rec)), 'encoding includes the __proto__ key');
  assert.ok(latin(R.bindEncode(rec)).includes('s9:__proto__'));
  // Array holes never invoke inherited indexed getters and never become
  // values: the encoder reads own descriptors only. The getter is installed
  // on the array's OWN prototype chain (not Object.prototype, which would
  // poison every array in the process, including the encoder's buffers).
  let inheritedCalls = 0;
  const holey = [,];
  const getterProto = {};
  Object.defineProperty(getterProto, '0', {
    configurable: true,
    get() { inheritedCalls++; return 'inherited'; },
  });
  Object.setPrototypeOf(holey, getterProto);
  assert.equal(latin(R.bindEncode(holey)), 'a1:h');
  const holeySnap = R.bindSnapshot(holey);
  assert.equal(holeySnap.length, 1);
  assert.equal(0 in holeySnap, false, 'hole stays a hole');
  assert.equal(inheritedCalls, 0, 'inherited indexed getter never invoked');
  // Only the intrinsic array length is exempt: extra own properties,
  // accessors and symbol keys on arrays reject per the grammar.
  const extra = [1]; extra.extra = 2;
  assert.throws(() => R.bindEncode(extra), 'array extra property rejects');
  const accessorSlot = [1];
  Object.defineProperty(accessorSlot, '0', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => R.bindEncode(accessorSlot), 'array accessor slot rejects');
  const symbolKeyed = [1]; symbolKeyed[Symbol('s')] = 2;
  assert.throws(() => R.bindEncode(symbolKeyed), 'array symbol key rejects');
  // Bounds are checked before expansion: a sparse oversize array rejects on
  // its length without iterating or materializing its holes.
  assert.throws(() => R.bindEncode(new Array(200000)), /length/, 'sparse oversize array rejects on length first');
  assert.throws(() => R.bindSnapshot(new Array(200000)), /length/);
});

test('B4 snapshot and encoder enforce equivalent incremental encoded-byte budgets, framing included', () => {
  // PR #671 Systems Review B4: the snapshot's byte budget must account for
  // exactly the bytes the encoder emits — tags, length/count framing and
  // content — incrementally, or values pass the snapshot and fail the
  // encoder (Atlas's probe: four 8-MiB strings). Parity is pinned at the
  // exact limit (both accept) and at limit-plus-one (both fail closed).
  const MAX = R.BIND_LIMITS.maxBytes;
  assert.equal(MAX, 33554432, 'the shared encoded-byte budget');
  // (a) Four max-length strings: raw content alone equals the budget, so
  // framing pushes the encoded total over it. BOTH paths must refuse.
  const fourMax = Array.from({ length: 4 }, () => 'x'.repeat(R.BIND_LIMITS.maxStringBytes));
  assert.throws(() => R.bindEncode(fourMax), undefined, 'encoder refuses four max strings');
  assert.throws(() => R.bindSnapshot(fourMax), undefined, 'snapshot refuses four max strings (framing counted)');
  // (a) Exact limit: [4 x 8,388,598-byte strings, true] frames to exactly
  // 33,554,432 encoded bytes (array header 3 + 4 x (9 + 8,388,598) + 1).
  const exactStrings = [...Array.from({ length: 4 }, () => 'x'.repeat(8388598)), true];
  assert.equal(R.bindEncode(exactStrings).length, MAX, 'encoder accepts at the exact limit');
  assert.doesNotThrow(() => R.bindSnapshot(exactStrings), 'snapshot accepts at the exact limit');
  assert.equal(R.bindEncode(R.bindSnapshot(exactStrings)).length, MAX, 'snapshot output encodes to the same total');
  // (a) Limit plus one framed byte: both refuse.
  const overStrings = [...Array.from({ length: 4 }, (_, i) => 'x'.repeat(i === 0 ? 8388599 : 8388598)), true];
  assert.throws(() => R.bindEncode(overStrings), undefined, 'encoder refuses limit-plus-one');
  assert.throws(() => R.bindSnapshot(overStrings), undefined, 'snapshot refuses limit-plus-one');
  // (b) Key-dominated parity: 511 keys of exactly 65,536 bytes each. The
  // encoder must preflight cumulative key bytes BEFORE allocating any
  // encoded-key buffer; the snapshot must charge the same framed key cost.
  // Framed total with a 61,437-byte string value on one key is exactly the
  // budget (record header 5 + 511 x (7 + 65,536) + 510 x 1 + (7 + 61,437)).
  const keyOf = i => String(i).padStart(6, '0') + 'k'.repeat(65536 - 6);
  const keyedExact = {};
  for (let i = 0; i < 511; i++) keyedExact[keyOf(i)] = true;
  keyedExact[keyOf(0)] = 'x'.repeat(61437);
  assert.equal(R.bindEncode(keyedExact).length, MAX, 'encoder accepts the key-dominated exact limit');
  assert.doesNotThrow(() => R.bindSnapshot(keyedExact), 'snapshot accepts the key-dominated exact limit');
  const keyedOver = { ...keyedExact, [keyOf(0)]: 'x'.repeat(61438) };
  assert.throws(() => R.bindEncode(keyedOver), undefined, 'encoder refuses key-dominated limit-plus-one');
  assert.throws(() => R.bindSnapshot(keyedOver), undefined, 'snapshot refuses key-dominated limit-plus-one');
  // (b) Atlas's allocation probe shape: 513 max-length keys (33,619,968 raw
  // key bytes) refuse on BOTH paths.
  const keyedHuge = {};
  for (let i = 0; i < 513; i++) keyedHuge[keyOf(i)] = 1;
  assert.throws(() => R.bindEncode(keyedHuge), undefined, 'encoder refuses 513 max-length keys');
  assert.throws(() => R.bindSnapshot(keyedHuge), undefined, 'snapshot refuses 513 max-length keys');
});

// ---------------------------------------------------------------------------
// txRef v1 (contract section 2).
// ---------------------------------------------------------------------------
test('AC-7 txRef golden vector, recomputed independently of the module', () => {
  const record = {
    domain: 'atlas-settlement-txref/v1', householdId,
    provider: 'lunchmoney', providerAccountId: ACCT_A, transactionId: TUPLE_A.transactionId,
  };
  const expected = 'tx-' + crypto.createHash('sha256')
    .update(JSON.stringify(record), 'utf8').digest('hex').slice(0, 32);
  const actual = R.deriveTxRef({ householdId, ...TUPLE_A });
  assert.equal(actual, expected);
  assert.match(actual, /^tx-[a-f0-9]{32}$/);
});

test('AC-8 txRef is independent of row content, date, amount and instance', async () => {
  const a = standardAcquisition();
  const b = standardAcquisition();
  b.packet.transactions[0] = spendRow({ amount: 999.99, date: '2026-10-02', categoryLabel: 'Restaurants' });
  const stub = stubClassify();
  const sa = await resolveDirect(resolverFor(a), handlesFor(a), stub.classify);
  const sb = await resolveDirect(resolverFor(b), handlesFor(b), stub.classify);
  assert.equal(sa.txRef, sb.txRef, 'same tuple, different content: one txRef');
  assert.notEqual(sa.selectionBinding, sb.selectionBinding, 'bindings still cover the content');
});

test('AC-9 txRef is sensitive to every tuple component, exactly as written', () => {
  const base = R.deriveTxRef({ householdId, ...TUPLE_A });
  assert.notEqual(R.deriveTxRef({ householdId: otherHouseholdId, ...TUPLE_A }), base, 'household');
  assert.notEqual(R.deriveTxRef({ householdId, providerAccountId: ACCT_B, transactionId: TUPLE_A.transactionId }), base, 'account');
  assert.notEqual(R.deriveTxRef({ householdId, providerAccountId: ACCT_A, transactionId: 'synthetic-provider-transaction-9' }), base, 'transaction');
  assert.notEqual(
    R.deriveTxRef({ householdId, providerAccountId: ACCT_A, transactionId: 'SYNTHETIC-PROVIDER-TRANSACTION-1' }),
    base, 'case-only change differs (no case folding)');
  assert.notEqual(
    R.deriveTxRef({ householdId, providerAccountId: ACCT_A, transactionId: '00123' }),
    R.deriveTxRef({ householdId, providerAccountId: ACCT_A, transactionId: '123' }),
    'leading zeros are content, not numbers');
});

test('AC-10 txRef is stable for the same tuple across instances and resolver factories', async () => {
  const stub = stubClassify();
  const one = await resolveDirect(resolverFor(standardAcquisition()), handlesFor(standardAcquisition()), stub.classify);
  const two = await resolveDirect(resolverFor(standardAcquisition()), handlesFor(standardAcquisition()), stub.classify);
  assert.equal(one.txRef, two.txRef);
  assert.equal(one.txRef, R.deriveTxRef({ householdId, ...TUPLE_A }));
});

test('AC-11 a tuple with a null provider account can never resolve or derive', async () => {
  const acq = standardAcquisition();
  acq.join = [{ localId: 'tx-1', providerAccountId: null, transactionId: TUPLE_A.transactionId }];
  const { classify, calls } = classifyRecorder();
  assert.equal(await resolveDirect(resolverFor(acq), handlesFor(standardAcquisition()), classify), null);
  assert.equal(calls.length, 0, 'classify never invoked for an unresolvable tuple');
  assert.throws(() => R.deriveTxRef({ householdId, providerAccountId: null, transactionId: 'x' }));
});

test('AC-12 an instance-level txRef collision refuses the whole instance (no fallback ref)', async () => {
  // Two distinct tuples forced onto one ref by patching the contract digest
  // for the txref domain only: the resolver must refuse everything rather
  // than resolve either tuple under a colliding (or alternate) ref.
  const original = C.digest;
  C.digest = value => (value && value.domain === 'atlas-settlement-txref/v1'
    ? 'f'.repeat(64) : original(value));
  try {
    const acq = standardAcquisition();
    acq.packet = standardPacket([spendRow(), spendRow({ id: 'tx-2', amount: 25 })]);
    acq.join = [{ localId: 'tx-1', ...TUPLE_A }, { localId: 'tx-2', ...TUPLE_B }];
    const { classify, calls } = stubClassify();
    assert.equal(await resolveDirect(resolverFor(acq), handlesFor(acq), classify), null);
    assert.equal(await resolveDirect(resolverFor(acq), handlesFor(acq, TUPLE_B), classify), null);
    assert.equal(calls.length, 0, 'nothing is classified under a colliding instance');
  } finally {
    C.digest = original;
  }
});

// ---------------------------------------------------------------------------
// Resolver semantics against injected acquisitions (direct calls).
// ---------------------------------------------------------------------------
function billAcquisition() {
  const row = spendRow({ id: 'tx-2', amount: 120, representedBill: true });
  return {
    packet: standardPacket([row], [{ id: 'ra-1', date: '2026-10-19', actual: 120, postedOn: '2026-10-19', transactionId: 'tx-2' }]),
    join: [{ localId: 'tx-2', ...TUPLE_A }],
    plan: standardPlan(), map: standardMap(),
  };
}
const TUPLE_TRANSFER_IN = { providerAccountId: ACCT_B, transactionId: 'synthetic-provider-transfer-in' };
function internalAcquisition() {
  const legOut = {
    id: 'tx-3', coverageRef: null, date: '2026-10-19', amount: -200, currency: 'cad', pending: false,
    atlasAccountId: 'chequing-a', accountRole: 'household-cash',
    tfrReference: 'AB123', tfrDirection: 'FR', representedBill: false,
  };
  const legIn = { ...legOut, id: 'tx-4', amount: 200, atlasAccountId: 'chequing-b', tfrDirection: 'TO' };
  return {
    packet: standardPacket([legOut, legIn]),
    join: [
      { localId: 'tx-3', providerAccountId: ACCT_A, transactionId: 'synthetic-provider-transfer-out' },
      { localId: 'tx-4', ...TUPLE_TRANSFER_IN },
    ],
    plan: standardPlan(), map: standardMap(),
  };
}

test('AD-1 classify is invoked exactly once, on the joined canonical packet row, with reference-equal aliases', async () => {
  const acq = standardAcquisition();
  const { classify, calls } = classifyRecorder();
  const selection = await resolveDirect(resolverFor(acq), handlesFor(acq), classify);
  assert.ok(selection, 'resolves');
  assert.equal(selection.matchCount, 1);
  assert.deepEqual(selection.identity, {
    householdId, source: 'lunchmoney',
    providerAccountId: TUPLE_A.providerAccountId, transactionId: TUPLE_A.transactionId,
  });
  assert.equal(selection.txRef, R.deriveTxRef({ householdId, ...TUPLE_A }));
  assert.equal(selection.goalId, GOAL_ID);
  assert.equal(selection.asOf, '2026-10-20');
  assert.deepEqual(selection.evidence, {
    accountId: 'chequing-a', currency: 'cad', direction: 'debit',
    date: '2026-10-19', cents: 6000, posted: true,
  });
  assert.deepEqual(Object.keys(selection).sort(),
    ['asOf', 'evidence', 'goalBinding', 'goalId', 'identity', 'matchCount', 'selectionBinding', 'txRef'],
    'the qualified shape carries no verdict or classification field (AC-28)');
  assert.equal(calls.length, 1, 'exactly one classify invocation');
  assert.equal(calls[0].opts.packet, calls[0].opts.currentPeriodActuals, 'both aliases are the identical object');
  assert.equal(calls[0].tx, calls[0].opts.currentPeriodActuals.transactions[0],
    'the classified row is an element of the packet passed in opts');
  assert.equal(calls[0].tx.id, 'tx-1', 'the joined canonical (local-id) row, not a provider row');
  assert.equal(calls[0].verdict.kind, 'spend');
});

test('AD-2 a tuple with no emitted row resolves null and classify is never invoked', async () => {
  const acq = standardAcquisition();
  const orphan = { providerAccountId: ACCT_A, transactionId: 'synthetic-provider-transaction-orphan' };
  const { classify, calls } = classifyRecorder();
  assert.equal(await resolveDirect(resolverFor(acq), handlesFor(acq, orphan), classify), null);
  assert.equal(calls.length, 0);
});

test('AD-3 a tuple provenanced to two emitted rows refuses (exactly-one join or fail closed)', async () => {
  const acq = standardAcquisition();
  acq.packet = standardPacket([spendRow(), spendRow({ id: 'tx-2', amount: 25 })]);
  acq.join = [{ localId: 'tx-1', ...TUPLE_A }, { localId: 'tx-2', ...TUPLE_A }];
  const { classify, calls } = classifyRecorder();
  assert.equal(await resolveDirect(resolverFor(acq), handlesFor(acq), classify), null);
  assert.equal(calls.length, 0);
});

test('Amendment 1 filtered collision: a sanitizer-dropped tuple must not resolve to the surviving row', async () => {
  // Shipped-source counterexample: two posted provider rows share native id
  // 'synthetic-shared-native-id' on accounts A and B. A's row has a null
  // amount and is dropped by the sanitizer BEFORE local ids are assigned, so
  // the pass emits only B's row. Honest provenance therefore contains only
  // B's fact; a join keyed by transactionId alone would hand A B's row.
  const sharedA = { providerAccountId: ACCT_A, transactionId: 'synthetic-shared-native-id' };
  const sharedB = { providerAccountId: ACCT_B, transactionId: 'synthetic-shared-native-id' };
  const acq = {
    packet: standardPacket([spendRow({ atlasAccountId: 'chequing-b', amount: 10 })]),
    join: [{ localId: 'tx-1', ...sharedB }],
    plan: standardPlan(), map: standardMap(),
  };
  const { classify, calls } = classifyRecorder();
  const resolver = resolverFor(acq);
  assert.equal(await resolveDirect(resolver, handlesFor(acq, sharedA), classify), null,
    'the dropped tuple has no provenance and must not inherit the surviving row');
  assert.equal(calls.length, 0);
  const resolvedB = await resolveDirect(resolver, handlesFor(acq, sharedB), classify);
  assert.ok(resolvedB, 'the emitted tuple resolves to its own row');
  assert.equal(resolvedB.evidence.accountId, 'chequing-b');
  assert.equal(resolvedB.evidence.cents, 1000);
});

test('Amendment 1 multiple visible rows under one local id refuse every tuple on that id', async () => {
  const sharedA = { providerAccountId: ACCT_A, transactionId: 'synthetic-shared-native-id' };
  const sharedB = { providerAccountId: ACCT_B, transactionId: 'synthetic-shared-native-id' };
  const acq = {
    packet: standardPacket([
      spendRow({ amount: null, atlasAccountId: 'chequing-a' }),
      spendRow({ amount: 10, atlasAccountId: 'chequing-b' }),
    ]),
    join: [{ localId: 'tx-1', ...sharedA }, { localId: 'tx-1', ...sharedB }],
    plan: standardPlan(), map: standardMap(),
  };
  const { classify, calls } = classifyRecorder();
  const resolver = resolverFor(acq);
  assert.equal(await resolveDirect(resolver, handlesFor(acq, sharedA), classify), null);
  assert.equal(await resolveDirect(resolver, handlesFor(acq, sharedB), classify), null);
  assert.equal(calls.length, 0, 'an ambiguous local id is never classified');
});

test('B2 tuple keys are injective: NUL-shifted producer pairs refuse before classify', async () => {
  // PR #671 Systems Review B2: a NUL-delimited string key collapses
  // (account 'acct<NUL>one', transaction 't') and (account 'acct',
  // transaction 'one<NUL>t') onto one key. Two such provenance entries
  // sharing one local id and one packet row must be TWO producers of that
  // row — ambiguity that refuses — never one merged tuple resolving with
  // matchCount 1. Native ids do not exclude NUL, so the key encoding must
  // be injective (nested maps / structural identity), and txRef v1 is
  // untouched by the fix.
  const shiftedA = { providerAccountId: 'acct\u0000one', transactionId: 't' };
  const shiftedB = { providerAccountId: 'acct', transactionId: 'one\u0000t' };
  const nulMap = standardMap();
  nulMap.mappings.push(
    { providerAccountId: shiftedA.providerAccountId, atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-a' } },
    { providerAccountId: shiftedB.providerAccountId, atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-a' } },
  );
  const acq = {
    packet: standardPacket([spendRow()]),
    join: [{ localId: 'tx-1', ...shiftedA }, { localId: 'tx-1', ...shiftedB }],
    plan: standardPlan(), map: nulMap,
  };
  const { classify, calls } = classifyRecorder();
  const resolver = resolverFor(acq);
  assert.equal(await resolveDirect(resolver, handlesFor(acq, shiftedA), classify), null,
    'the first shifted tuple must not resolve through the collision');
  assert.equal(await resolveDirect(resolver, handlesFor(acq, shiftedB), classify), null,
    'the second shifted tuple must not resolve through the collision');
  assert.equal(calls.length, 0, 'ambiguous producers refuse BEFORE classify is invoked');
  // Control: either tuple ALONE over the same row resolves normally, so the
  // refusal above is the ambiguity, not the NUL content itself.
  const solo = { ...acq, join: [{ localId: 'tx-1', ...shiftedA }] };
  const soloMap = standardMap();
  soloMap.mappings.push({ providerAccountId: shiftedA.providerAccountId, atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-a' } });
  solo.map = soloMap;
  const stub = stubClassify();
  assert.ok(await resolveDirect(resolverFor(solo), handlesFor(solo, shiftedA), stub.classify),
    'a sole NUL-bearing tuple resolves when it is unambiguous');
});

test('AC-34 two packet rows sharing one local id refuse even with a single join fact', async () => {
  const acq = standardAcquisition();
  acq.packet = standardPacket([spendRow(), spendRow({ amount: 25 })]);
  const { classify, calls } = classifyRecorder();
  assert.equal(await resolveDirect(resolverFor(acq), handlesFor(acq), classify), null);
  assert.equal(calls.length, 0);
});

test('AD-4/AD-5 classification always runs on the canonical row with both aliases (bill and internal-movement probes)', async () => {
  // Bill probe: the verdict must be computed from the joined canonical row
  // (representedBill + representedActuals linkage intact), never from a
  // reconstructed provider-shaped row.
  const bill = billAcquisition();
  const billRec = classifyRecorder();
  const billSelection = await resolveDirect(resolverFor(bill), handlesFor(bill), billRec.classify);
  assert.ok(billSelection, 'the resolver returns the selection; Rule E admission is the controller\u2019s');
  assert.equal(billRec.calls.length, 1);
  assert.equal(billRec.calls[0].verdict.kind, 'bill');
  assert.equal(billRec.calls[0].verdict.reason, 'represented-bill');
  // Internal-movement probe: the verdict exists only because the movement
  // index reads opts.currentPeriodActuals; the resolver passes both aliases
  // as the same object, and the debit leg is what resolves.
  const internal = internalAcquisition();
  const inRec = classifyRecorder();
  const inSelection = await resolveDirect(resolverFor(internal), handlesFor(internal, TUPLE_TRANSFER_IN), inRec.classify);
  assert.ok(inSelection);
  assert.equal(inRec.calls[0].verdict.kind, 'internal-movement');
  assert.equal(inRec.calls[0].tx.id, 'tx-4', 'the debit leg\u2019s canonical row is classified');
  assert.equal(inSelection.evidence.cents, 20000);
  assert.equal(inSelection.evidence.accountId, 'chequing-b');
  // The alias is load-bearing: the same row classified with only the packet
  // alias does NOT produce the movement verdict (the index reads
  // currentPeriodActuals only). The wrong shape is fixture-dependent; the
  // divergence is the pinned fact.
  const legIn = internal.packet.transactions[1];
  const aliasOnly = Forecast.classifyCurrentPeriodTransaction(legIn, internal.plan, { packet: internal.packet });
  assert.notEqual(aliasOnly.kind, 'internal-movement');
  // Across every fixture, classify only ever receives packet elements with
  // both aliases reference-equal — no normalized provider row is ever built.
  for (const rec of [billRec, inRec]) {
    for (const call of rec.calls) {
      assert.equal(call.opts.packet, call.opts.currentPeriodActuals);
      assert.ok(call.opts.currentPeriodActuals.transactions.includes(call.tx));
    }
  }
});

test('AC-33 (amended) handles are recomputable selectors: a never-minted but currently-derivable handle resolves; a fabricated or absent-goal handle refuses', async () => {
  const acq = standardAcquisition();
  // This factory has never resolved anything; the presented handle was
  // computed from the public derivations alone. Deterministic handles are
  // selectors recomputable by any holder of the content, not session-minted
  // tokens — matching CURRENT derivation is the test, not minting history.
  const fresh = resolverFor(acq);
  const { classify, calls } = classifyRecorder();
  assert.ok(await resolveDirect(fresh, handlesFor(acq), classify), 'recomputed handle resolves');
  assert.equal(calls.length, 1);
  const fabricated = { transaction: 'selection-' + 'f'.repeat(32), commitment: handlesFor(acq).commitment };
  assert.equal(await resolveDirect(fresh, fabricated, classify), null, 'a handle matching no current derivation refuses');
  const absentGoal = {
    transaction: handlesFor(acq).transaction,
    commitment: R.deriveChoiceHandle(R.computePlanDigest(acq.plan), 'commitment:absent-goal'),
  };
  assert.equal(await resolveDirect(fresh, absentGoal, classify), null, 'absent-goal rejection preserved');
  assert.equal(calls.length, 1, 'refusals never reach classify');
});

test('B1/AC-31 (corrected) identification is current-derivation only: an amount change kills the old handle pair in warm and fresh factories alike', async () => {
  // PR #671 Systems Review B1: the identification memo is removed. A handle
  // pair identifies ONLY by matching derivations from the CURRENT
  // acquisition; process history revives nothing. Changing the packet row
  // amount 60 -> 61 changes the row digest and therefore the instance
  // digest and the selection handle, so the old pair is unresolvable in
  // EVERY factory over the new content — warm (this factory resolved the
  // pair a moment ago) or fresh. The resolver returns null and classify is
  // never invoked; at the controller this surfaces as selection-unavailable.
  let current = standardAcquisition();
  const resolver = makeResolver(async () => current);
  const { classify, calls } = classifyRecorder();
  const original = handlesFor(current);
  assert.ok(await resolveDirect(resolver, original, classify), 'resolves on its own instance');
  const callsAfterResolve = calls.length;
  current = standardAcquisition();
  current.packet.transactions[0] = spendRow({ amount: 61 });
  assert.equal(await resolveDirect(resolver, original, classify), null,
    'a warm factory must not revive an invalidated handle pair');
  assert.equal(await resolveDirect(resolverFor(current), original, classify), null,
    'a fresh factory over identical current content refuses identically');
  assert.equal(calls.length, callsAfterResolve, 'no classify invocation for an invalidated handle');
  assert.ok(await resolveDirect(resolver, handlesFor(current), classify),
    'the current content\u2019s own handles resolve in the same warm factory');
  // Superseding instance: a completely different transaction set. The tuple
  // the handles name is absent from current content, so nothing resolves.
  current = {
    packet: standardPacket([spendRow({ id: 'tx-9' })]),
    join: [{ localId: 'tx-9', providerAccountId: ACCT_A, transactionId: 'synthetic-provider-transaction-9' }],
    plan: standardPlan(), map: standardMap(),
  };
  const before = calls.length;
  assert.equal(await resolveDirect(resolver, original, classify), null);
  assert.equal(calls.length, before, 'no classify invocation for a stale handle');
  assert.equal(await resolveDirect(resolverFor(current), original, classify), null);
});

test('AC-32 deterministic re-mint: identical content in two factories derives identical handles and selections', async () => {
  const a = standardAcquisition();
  const b = standardAcquisition();
  assert.deepEqual(handlesFor(a), handlesFor(b));
  const stub = stubClassify();
  const sa = await resolveDirect(resolverFor(a), handlesFor(a), stub.classify);
  const sb = await resolveDirect(resolverFor(b), handlesFor(b), stub.classify);
  assert.deepEqual(sa, sb);
});

test('AC-29 returned selections are owned snapshots: later source mutation cannot reach them', async () => {
  const acq = standardAcquisition();
  const { classify } = stubClassify();
  const selection = await resolveDirect(resolverFor(acq), handlesFor(acq), classify);
  const pristine = clone(selection);
  acq.packet.transactions[0].amount = 999;
  acq.packet.coverageStart = '1999-01-01';
  acq.plan.commitments[0].amount = 1;
  acq.map.mappings[0].atlasRole = 'mutated';
  assert.deepEqual(selection, pristine, 'the returned selection is immune to source mutation');
  const again = await resolveDirect(resolverFor(standardAcquisition()), handlesFor(standardAcquisition()), classify);
  assert.deepEqual(again, pristine, 'a pristine re-resolve reproduces it exactly');
});

test('AC-30/AD-12 observation identity ignores acquisition-external fields; packet order moves the packet binding only', async () => {
  const stub = stubClassify();
  // Envelope/fetch metadata ride along on the injected acquisition object in
  // production-shaped data; the resolver reads only packet/join/plan/map, so
  // differing fetch stamps change nothing derived.
  const a = { ...standardAcquisition(), providerEnvelope: { fetchedAt: '2026-10-20T01:00:00Z' } };
  const b = { ...standardAcquisition(), providerEnvelope: { fetchedAt: '2026-10-20T09:30:00Z' } };
  const sa = await resolveDirect(resolverFor(a), handlesFor(a), stub.classify);
  const sb = await resolveDirect(resolverFor(b), handlesFor(b), stub.classify);
  assert.deepEqual(sa, sb, 'timestamps outside the bound content never bind (T1-T4)');
  // A content change inside the packet does move the instance.
  assert.notEqual(
    R.computeInstanceDigest(standardPacket([spendRow({ amount: 61 })])),
    R.computeInstanceDigest(standardPacket([spendRow()])));
  // Permutation: the instance is a sorted multiset of row digests (stable),
  // while the packet binding stays order-sensitive.
  const rowB = spendRow({ id: 'tx-2', amount: 25, atlasAccountId: 'chequing-b' });
  const join = [{ localId: 'tx-1', ...TUPLE_A }, { localId: 'tx-2', ...TUPLE_B }];
  const ordered = { packet: standardPacket([spendRow(), rowB]), join, plan: standardPlan(), map: standardMap() };
  const permuted = { packet: standardPacket([rowB, spendRow()]), join, plan: standardPlan(), map: standardMap() };
  assert.equal(R.computeInstanceDigest(permuted.packet), R.computeInstanceDigest(ordered.packet));
  assert.notEqual(R.computePacketDigest(permuted.packet), R.computePacketDigest(ordered.packet));
  const so = await resolveDirect(resolverFor(ordered), handlesFor(ordered), stub.classify);
  const sp = await resolveDirect(resolverFor(permuted), handlesFor(ordered), stub.classify);
  assert.ok(sp, 'handles resolve across a permutation');
  assert.equal(sp.txRef, so.txRef);
  assert.notEqual(sp.selectionBinding, so.selectionBinding, 'the packet binding is order-sensitive');
});

test('AD-11 exactly one acquisition per resolve; an incoherent join fails closed', async () => {
  let acquisitions = 0;
  const acq = standardAcquisition();
  const resolver = makeResolver(async () => { acquisitions++; return acq; });
  const stub = stubClassify();
  assert.ok(await resolveDirect(resolver, handlesFor(acq), stub.classify));
  assert.equal(acquisitions, 1, 'one coherent acquisition per resolve, never a retained copy (E3)');
  // A join fact naming a local id the packet does not contain is incoherent:
  // that tuple cannot resolve. (The production mid-flight form of this case
  // belongs to the unimplemented exporter, section A.6/A.8.)
  const incoherent = standardAcquisition();
  incoherent.join = [{ localId: 'tx-99', ...TUPLE_A }];
  const rec = classifyRecorder();
  assert.equal(await resolveDirect(resolverFor(incoherent), handlesFor(incoherent), rec.classify), null);
  assert.equal(rec.calls.length, 0);
});

test('AC-27 (resolver half) acquisition failure fails closed and classify is never invoked', async () => {
  const { classify, calls } = classifyRecorder();
  const throwing = makeResolver(async () => { throw new Error('synthetic acquisition unavailable'); });
  assert.equal(await resolveDirect(throwing, handlesFor(standardAcquisition()), classify), null);
  const garbage = makeResolver(async () => ({ packet: null, join: [], plan: null, map: null }));
  assert.equal(await resolveDirect(garbage, handlesFor(standardAcquisition()), classify), null);
  assert.equal(calls.length, 0);
});

test('B3 every required acquisition-envelope field is taken via validated own data descriptors; accessors refuse uninvoked', async () => {
  // PR #671 Systems Review B3: reading raw.packet (etc.) directly invokes
  // an enumerable getter on the acquisition object BEFORE ownership. Each
  // required envelope field — packet, join, plan, map — must be obtained
  // via its own DATA descriptor; an accessor field refuses resolution and
  // its getter is never invoked. Each field is pinned individually.
  const base = standardAcquisition();
  const handles = handlesFor(base);
  for (const field of ['packet', 'join', 'plan', 'map']) {
    let getterCalls = 0;
    const holder = { packet: base.packet, join: base.join, plan: base.plan, map: base.map };
    Object.defineProperty(holder, field, {
      enumerable: true, configurable: true,
      get() { getterCalls++; return base[field]; },
    });
    const { classify, calls } = classifyRecorder();
    const resolver = makeResolver(async () => holder);
    assert.equal(await resolveDirect(resolver, handles, classify), null,
      `an accessor ${field} field refuses resolution`);
    assert.equal(getterCalls, 0, `the ${field} getter is never invoked`);
    assert.equal(calls.length, 0, `no classify invocation behind an accessor ${field}`);
  }
  // Control: the same values behind plain data properties resolve normally.
  const plain = { packet: base.packet, join: base.join, plan: base.plan, map: base.map };
  const stub = stubClassify();
  assert.ok(await resolveDirect(resolverFor(plain), handles, stub.classify),
    'plain data envelope fields resolve');
});

// ---------------------------------------------------------------------------
// Controller-level cases: the real confirmation controller + store, driven
// by the real resolver (the fixture authorize above is the only synthetic
// boundary besides the injected acquisition).
// ---------------------------------------------------------------------------
test('AC-18 the ledger canonicalization is untouched with the resolver loaded; BIND never enters it', () => {
  const record = { b: 2, a: 'x', domain: 'atlas-settlement-test/v1' };
  const expected = crypto.createHash('sha256')
    .update(JSON.stringify({ a: 'x', b: 2, domain: 'atlas-settlement-test/v1' }), 'utf8').digest('hex');
  assert.equal(C.digest(record), expected, 'contract digest byte-identical');
  assert.throws(() => C.digest({ f: 1.5 }), undefined,
    'the ledger canonical still refuses floats — the two digest families never mix');
});

test('End-to-end (AC-28): spend prepares, confirms and commits; loader qualifies the evidence; bindings never persist', async t => {
  const w = await world(t);
  const prepared = await w.prepare(1);
  assert.equal(prepared.status, 'prepared');
  const receipt = await w.confirm(1);
  assert.equal(receipt.status, 'committed');
  assert.equal(w.document().operations.length, 1);
  const loaded = await w.load();
  assert.equal(loaded.status, 'qualified');
  assert.equal(loaded.evidence.commitments.length, 1);
  assert.equal(loaded.evidence.commitments[0].goalId, GOAL_ID);
  assert.equal(loaded.evidence.commitments[0].links[0].txRef, R.deriveTxRef({ householdId, ...TUPLE_A }));
  assert.equal(loaded.evidence.commitments[0].links[0].assignedCents, 2500);
  // Bindings are comparison material only: not in the document, the preview
  // result, or the receipt.
  const stub = stubClassify();
  const sel = await resolveDirect(resolverFor(standardAcquisition()), handlesFor(standardAcquisition()), stub.classify);
  const artifacts = JSON.stringify(w.document()) + JSON.stringify(prepared) + JSON.stringify(receipt);
  assert.ok(!artifacts.includes(sel.selectionBinding), 'selection binding absent from artifacts');
  assert.ok(!artifacts.includes(sel.goalBinding), 'goal binding absent from artifacts');
  assert.ok(!artifacts.includes('atlas-bind'), 'no BIND output in any artifact');
});

test('AC-13/AC-14 one txRef derivation site in the module; a second operation over an active (goal, txRef) pair cannot allocate', async t => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'settlement-evidence-resolver.js'), 'utf8');
  assert.equal(source.split('atlas-settlement-txref/v1').length - 1, 1, 'exactly one derivation site');
  const w = await world(t);
  await w.prepare(1);
  assert.equal((await w.confirm(1)).status, 'committed');
  const second = await w.prepare(2);
  assert.notEqual(second.status, 'prepared', 'Rule D: one active allocation per pair until retracted');
  assert.equal(w.document().operations.length, 1, 'no second allocation was recorded');
});

test('AD-5 (controller) Rule E admission from real verdicts: bill is eligibility-unresolved, internal movement is ineligible', async t => {
  const w = await world(t);
  const bill = billAcquisition();
  w.acquisition = bill;
  const billResult = await w.prepare(1, 2500, context, handlesFor(bill));
  assert.deepEqual(billResult, { status: 'unavailable', reason: 'selection-eligibility-unresolved' });
  const internal = internalAcquisition();
  w.acquisition = internal;
  const inResult = await w.prepare(2, 2500, context, handlesFor(internal, TUPLE_TRANSFER_IN));
  assert.deepEqual(inResult, { status: 'rejected', reason: 'selection-ineligible' });
  assert.equal(w.document().operations.length, 0, 'neither admission outcome commits anything');
});

test('AD-2 (controller) an unresolvable selection prepares unavailable and the store is never called', async t => {
  const w = await world(t);
  const orphan = { providerAccountId: ACCT_A, transactionId: 'synthetic-provider-transaction-orphan' };
  const result = await w.prepare(1, 2500, context, handlesFor(w.acquisition, orphan));
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(w.calls, [], 'resolution failure happens before any store call');
});

test('AC-1 the authorize context never enters artifacts; a malformed context is an invalid request', async t => {
  const w = await world(t);
  const bad = await w.controller.prepare('synthetic-session-a',
    { operationId: op(7), selection: clone(w.selection), assignedCents: 2500 });
  assert.deepEqual(bad, { status: 'unavailable', reason: 'invalid-request' });
  await w.prepare(1);
  await w.confirm(1);
  const artifacts = JSON.stringify(w.document()) + JSON.stringify(w.pin);
  assert.ok(!artifacts.includes('synthetic-session'), 'no session ticket material in durable artifacts');
});

test('AC-2 confirm under a different actor is unknown and commits nothing', async t => {
  const w = await world(t);
  await w.prepare(1);
  assert.deepEqual(await w.confirm(1, true, otherContext), { status: 'unknown', operationId: op(1) });
  assert.equal(w.document().operations.length, 0);
});

test('AC-3 after expiry the committing actor reads the original receipt, others read unknown, and the loader shows the effect', async t => {
  const w = await world(t);
  await w.prepare(1);
  const receipt = await w.confirm(1);
  assert.equal(receipt.status, 'committed');
  w.time += C.TTL_MS + 1000;
  assert.deepEqual(await w.outcome(1), receipt, 'the original receipt survives preview expiry');
  assert.deepEqual(await w.outcome(1, otherContext), { status: 'unknown', operationId: op(1) });
  const loaded = await w.load();
  assert.equal(loaded.status, 'qualified');
  assert.equal(loaded.evidence.commitments.length, 1);
});

test('AC-4/R4 failed post-commit reauthorization surfaces unknown while the durable commit stands', async t => {
  const w = await world(t);
  await latchEvent(w);
  const receipt = await w.outcome(1);
  assert.equal(receipt.status, 'committed', 'R4 resolves to R2: the receipt is the truth after the fact');
  assert.equal(receipt.operationId, op(1));
});

test('AC-5/R0/R5 latch lifecycle: blocks prepares, binds to the committing actor, clears on their outcome, never crosses instances', async t => {
  const w = await world(t);
  await latchEvent(w);
  assert.deepEqual(await w.prepare(2), { status: 'unavailable', reason: 'outcome-unresolved' });
  assert.deepEqual(await w.confirm(3), { status: 'unknown', operationId: op(3) },
    'an unrelated retained confirm is unknown while the latch is set');
  assert.deepEqual(await w.outcome(1, otherContext), { status: 'unknown', operationId: op(1) },
    'a different actor\u2019s outcome does not clear the latch');
  assert.equal((await w.prepare(2)).reason, 'outcome-unresolved', 'the latch persists');
  // A fresh controller instance starts unlatched (R5: the latch is a closure
  // variable; a restart clears it, the durable receipt is untouched).
  const twoRows = standardAcquisition();
  twoRows.packet = standardPacket([spendRow(), spendRow({ id: 'tx-2', amount: 25, atlasAccountId: 'chequing-b' })]);
  twoRows.join = [{ localId: 'tx-1', ...TUPLE_A }, { localId: 'tx-2', ...TUPLE_B }];
  w.acquisition = twoRows;
  const fresh = w.newController();
  assert.equal((await w.prepare(9, 2500, context, handlesFor(twoRows, TUPLE_B), fresh)).status, 'prepared',
    'the fresh instance is not latched');
  // The committing actor's outcome returns the receipt and clears the latch.
  const receipt = await w.outcome(1);
  assert.equal(receipt.status, 'committed');
  assert.equal((await w.prepare(2, 2500, context, handlesFor(twoRows, TUPLE_B))).status, 'prepared',
    'prepares flow again after clearing');
});

test('AC-6 authorize refusal makes prepare unavailable and the store is never touched', async t => {
  const w = await world(t);
  w.authHook = async () => null;
  assert.equal((await w.prepare(1)).status, 'unavailable');
  assert.deepEqual(w.calls, [], 'no store call was made');
});

test('AC-19 mode S: confirm succeeds against a structural deep copy of the prepare-time acquisition', async t => {
  const w = await world(t);
  await w.prepare(1);
  w.acquisition = clone(w.acquisition);
  assert.equal((await w.confirm(1)).status, 'committed', 'bindings are content, never object identity');
});

test('AC-20 mode F: a rebuilt identical acquisition confirms; a moved asOf is selection-changed', async t => {
  const w = await world(t);
  await w.prepare(1);
  w.acquisition = standardAcquisition();
  assert.equal((await w.confirm(1)).status, 'committed');
  const w2 = await world(t);
  await w2.prepare(1);
  const moved = standardAcquisition();
  moved.packet.observationAsOf = '2026-10-21';
  w2.acquisition = moved;
  assert.deepEqual(await w2.confirm(1), { status: 'rejected', reason: 'selection-changed' });
  assert.equal(w2.document().operations.length, 0);
});

test('AC-22 (amended) / Amendment 2 + B1: retained packet drift binds; handle-invalidating drift fails closed as selection-unavailable; a notes-driven retained flip must drift', async t => {
  // (i) A change to the retained canonical packet row drifts the binding —
  // shown directly (the relabelled content, resolved under its own current
  // handles, binds differently). At confirm, the row sits inside handle
  // derivation (row digest -> instance digest), so the presented pair is
  // invalidated and, with the identification memo removed (B1), confirm
  // fails closed as selection-unavailable rather than selection-changed.
  const stub = stubClassify();
  const baseSelection = await resolveDirect(
    resolverFor(standardAcquisition()), handlesFor(standardAcquisition()), stub.classify);
  const relabelledDirect = standardAcquisition();
  relabelledDirect.packet.transactions[0] = spendRow({ categoryLabel: 'Restaurants' });
  const relabelledSelection = await resolveDirect(
    resolverFor(relabelledDirect), handlesFor(relabelledDirect), stub.classify);
  assert.notEqual(relabelledSelection.selectionBinding, baseSelection.selectionBinding,
    'the binding itself drifts on a retained packet-row change');
  const w1 = await world(t);
  await w1.prepare(1);
  const relabelled = standardAcquisition();
  relabelled.packet.transactions[0] = spendRow({ categoryLabel: 'Restaurants' });
  w1.acquisition = relabelled;
  assert.deepEqual(await w1.confirm(1), { status: 'rejected', reason: 'selection-unavailable' });
  assert.equal(w1.document().operations.length, 0);
  // (ii) A notes-only change whose retained effects are unchanged does NOT
  // drift. Notes live upstream of the sanitizer and never reach the
  // resolver; the acquisition below changes only a notes side-channel while
  // packet/join/plan/map — every bound value — stays identical. No raw note
  // is persisted or bound anywhere in this foundation.
  const w2 = await world(t);
  await w2.prepare(1);
  w2.acquisition = {
    ...standardAcquisition(),
    providerNotes: { 'synthetic-provider-transaction-1': 'a completely different note' },
  };
  assert.equal((await w2.confirm(1)).status, 'committed', 'stable ONLY because every bound value is unchanged');
  // (iii) A notes change that flips a retained derived value MUST drift:
  // the sanitizer's notes-driven personal-owner/derived-flag inference
  // (provider-observe 4444-4466) is retained in the packet (4515-4538), so
  // the flip changes the canonical packet row and its digest.
  const w3 = await world(t);
  await w3.prepare(1);
  const flipped = standardAcquisition();
  flipped.packet.transactions[0] = spendRow({ personalOwner: 'dale' });
  w3.acquisition = flipped;
  // The flip changes the canonical packet row, so the binding drifts (the
  // direct comparison in (i) is the binding-level pin); at confirm the
  // invalidated handle pair fails closed as selection-unavailable (B1).
  assert.deepEqual(await w3.confirm(1), { status: 'rejected', reason: 'selection-unavailable' });
  assert.equal(w3.document().operations.length, 0);
});

test('AC-23 (B1-corrected) an unrelated commitment added to the plan invalidates the choice handle: selection-unavailable', async t => {
  // The plan digest feeds the choice handle, so ANY plan change — even to
  // an unrelated commitment — invalidates the presented pair. Under
  // current-derivation-only identification (B1) the resolver returns null
  // and confirm fails closed as selection-unavailable; reaching a binding
  // comparison (selection-changed) requires a pair that still re-resolves,
  // e.g. the preserved packet-envelope/map/asOf drift classes.
  const w = await world(t);
  await w.prepare(1);
  const grown = standardAcquisition();
  grown.plan.commitments.push({ id: 'synthetic-other', label: 'Synthetic Other', amount: 10 });
  w.acquisition = grown;
  assert.deepEqual(await w.confirm(1), { status: 'rejected', reason: 'selection-unavailable' });
  assert.equal(w.document().operations.length, 0);
});

test('AC-24 (B1-corrected) a change to the goal row itself invalidates the choice handle: selection-unavailable', async t => {
  const w = await world(t);
  await w.prepare(1);
  const changed = standardAcquisition();
  changed.plan.commitments[0] = { id: 'synthetic-trip', label: 'Synthetic Trip', amount: 350 };
  w.acquisition = changed;
  assert.deepEqual(await w.confirm(1), { status: 'rejected', reason: 'selection-unavailable' });
  assert.equal(w.document().operations.length, 0);
});

test('AC-25 a coverage-boundary-only packet change drifts via the packet binding', async t => {
  const w = await world(t);
  await w.prepare(1);
  const shifted = standardAcquisition();
  shifted.packet.coverageStart = '2026-09-02';
  w.acquisition = shifted;
  // coverageStart is in the packet binding but not the instance digest, so
  // the handle still identifies the row — and the binding refuses the drift.
  assert.deepEqual(await w.confirm(1), { status: 'rejected', reason: 'selection-changed' });
  assert.equal(w.document().operations.length, 0);
});

test('AC-26 an account-map remap drifts and nothing commits', async t => {
  const w = await world(t);
  await w.prepare(1);
  const remapped = standardAcquisition();
  remapped.map.mappings[0] = { ...remapped.map.mappings[0], atlasRole: 'household-reserve' };
  w.acquisition = remapped;
  assert.deepEqual(await w.confirm(1), { status: 'rejected', reason: 'selection-changed' });
  assert.equal(w.document().operations.length, 0);
});

test('AC-27 (controller half) confirm-time acquisition failure is selection-unavailable and the document is untouched', async t => {
  const w = await world(t);
  await w.prepare(1);
  const before = w.documentBytes();
  w.acquireHook = () => { throw new Error('synthetic acquisition unavailable'); };
  assert.deepEqual(await w.confirm(1), { status: 'rejected', reason: 'selection-unavailable' },
    'the resolver never falls back to a retained prepare-time copy (E3)');
  assert.ok(w.documentBytes().equals(before), 'document bytes unchanged');
});

test('B1 (controller) an amount change at confirm invalidates the handle pair: selection-unavailable, document untouched', async t => {
  // The controller's own distinction (confirmation :393-394): a resolver
  // null at confirm is selection-unavailable; a re-resolved selection whose
  // bindings differ is selection-changed. With the memo removed, an amount
  // change (60 -> 61) changes the row/instance digests, the presented pair
  // no longer re-resolves, and confirm fails closed as unavailable — it
  // must NOT be revived into a binding comparison by process history.
  const w = await world(t);
  await w.prepare(1);
  const before = w.documentBytes();
  const drifted = standardAcquisition();
  drifted.packet.transactions[0] = spendRow({ amount: 61 });
  w.acquisition = drifted;
  assert.deepEqual(await w.confirm(1), { status: 'rejected', reason: 'selection-unavailable' });
  assert.ok(w.documentBytes().equals(before), 'document bytes unchanged');
  assert.equal(w.document().operations.length, 0);
});

test('B1 (controller, preserved drift pin) a packet permutation at confirm still re-resolves and is selection-changed', async t => {
  // Packet permutation is in Atlas's preserved list: the instance digest
  // sorts row digests, so the handles survive, the selection re-resolves
  // against current content, and the order-sensitive packet binding then
  // refuses the drift as selection-changed through the unchanged controller.
  const w = await world(t);
  const twoRows = standardAcquisition();
  twoRows.packet = standardPacket([spendRow(), spendRow({ id: 'tx-2', amount: 25, atlasAccountId: 'chequing-b' })]);
  twoRows.join = [{ localId: 'tx-1', ...TUPLE_A }, { localId: 'tx-2', ...TUPLE_B }];
  w.acquisition = twoRows;
  w.selection = handlesFor(twoRows);
  await w.prepare(1);
  const permuted = clone(twoRows);
  permuted.packet.transactions.reverse();
  w.acquisition = permuted;
  assert.deepEqual(await w.confirm(1), { status: 'rejected', reason: 'selection-changed' });
  assert.equal(w.document().operations.length, 0);
});

test('AD-13 (B1-corrected) plan-only change: the old selection handle resolves with the newly derived choice handle; the stale pair fails closed at confirm', async t => {
  const w = await world(t);
  await w.prepare(1);
  const changed = standardAcquisition();
  changed.plan.commitments[0] = { id: 'synthetic-trip', label: 'Synthetic Trip (renamed)', amount: 300 };
  // Direct: the unchanged selection handle plus the choice handle derived
  // from the CURRENT plan resolves against the current acquisition.
  const stub = stubClassify();
  const direct = await resolveDirect(resolverFor(changed), {
    transaction: w.selection.transaction,
    commitment: R.deriveChoiceHandle(R.computePlanDigest(changed.plan), GOAL_ID),
  }, stub.classify);
  assert.ok(direct, 'selection handle is plan-independent; the new choice handle matches current derivation');
  assert.notEqual(direct.goalBinding, (await resolveDirect(
    resolverFor(standardAcquisition()), w.selection, stub.classify)).goalBinding);
  // Controller: the retained stale pair no longer re-resolves — the plan
  // change invalidated its choice handle — so confirm fails closed as
  // selection-unavailable (B1: no memo revival into a binding comparison).
  // Handles remain content selectors (D1): a resolving handle still proves
  // nothing at confirm beyond current derivation, and drift that leaves
  // handles derivable (packet permutation, envelope, map, asOf) is what
  // reaches the binding comparison as selection-changed.
  w.acquisition = changed;
  assert.deepEqual(await w.confirm(1), { status: 'rejected', reason: 'selection-unavailable' });
  assert.equal(w.document().operations.length, 0);
});

// ---------------------------------------------------------------------------
// Restart matrix (addendum section C) in a real child process: a fresh
// controller over the same durable directory, with a resolver that must
// never be consulted for committed outcomes.
// ---------------------------------------------------------------------------
function durableBytes(dir) {
  const read = name => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  };
  return { document: read('document.json'), journal: read('journal.json') };
}

test('AC-21/AD-8/AD-9/AD-10 restart matrix R1-R4: durable truth is actor-bound and readable with no resolver and no writes', async t => {
  const w = await world(t);
  await w.prepare(2); // an uncommitted preview (R1)
  await latchEvent(w); // op1 committed durably, post-commit auth failed (R4's event)
  const receipt = await w.outcome(1); // clears the parent latch; captures the receipt
  assert.equal(receipt.status, 'committed');
  const before = durableBytes(w.dir);
  const root = path.join(__dirname, '..');
  const childScript = `
    const S = require(${JSON.stringify(path.join(root, 'scripts', 'settlement-evidence-store.js'))});
    const A = require(${JSON.stringify(path.join(root, 'scripts', 'settlement-evidence-file-adapter.js'))});
    const { createSettlementEvidenceConfirmation } = require(${JSON.stringify(path.join(root, 'scripts', 'settlement-evidence-confirmation.js'))});
    const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    const deny = async () => { throw new Error('must not be called'); };
    let resolverCalls = 0;
    const store = S.createSettlementEvidenceStore({
      householdId: input.householdId,
      ...A.createSettlementEvidenceFileAdapter(input.dir),
      pinStore: { read: async () => input.pin, advance: deny },
      backupStore: { put: deny, get: deny, list: deny },
      now: () => input.time,
    });
    const authorize = async ctx => {
      if (ctx && ctx.ticket === 'synthetic-session-a') return { householdId: input.householdId, actorId: input.actorId };
      if (ctx && ctx.ticket === 'synthetic-session-b') return { householdId: input.householdId, actorId: input.otherActor };
      return null;
    };
    const controller = createSettlementEvidenceConfirmation({
      householdId: input.householdId, authorize,
      resolveSelection: async () => { resolverCalls++; return null; },
      store, now: () => input.time,
    });
    (async () => {
      const out = {};
      out.confirmCommitted = await controller.confirm({ ticket: 'synthetic-session-a' },
        { operationId: input.op1, confirmed: false });
      out.outcomeCommitted = await controller.outcome({ ticket: 'synthetic-session-a' }, { operationId: input.op1 });
      out.confirmUncommitted = await controller.confirm({ ticket: 'synthetic-session-a' },
        { operationId: input.op2, confirmed: true, previewToken: 'ab'.repeat(32) });
      out.outcomeOther = await controller.outcome({ ticket: 'synthetic-session-b' }, { operationId: input.op1 });
      out.confirmOther = await controller.confirm({ ticket: 'synthetic-session-b' },
        { operationId: input.op1, confirmed: true, previewToken: 'ab'.repeat(32) });
      out.resolverCalls = resolverCalls;
      process.stdout.write(JSON.stringify(out));
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const input = JSON.stringify({
    dir: w.dir, pin: w.pin, householdId, actorId, otherActor,
    op1: op(1), op2: op(2), time: w.time,
  });
  const child = spawnSync(process.execPath, ['-e', childScript], { input, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout);
  assert.deepEqual(out.confirmCommitted, receipt,
    'AD-8/R2: confirm returns the original receipt BEFORE any preview lookup, resolver never consulted');
  assert.deepEqual(out.outcomeCommitted, receipt, 'AD-10: the receipt stays readable under the committing actor');
  assert.deepEqual(out.confirmUncommitted, { status: 'unknown', operationId: op(2) },
    'R1: an uncommitted preview is process state and does not survive restart');
  assert.deepEqual(out.outcomeOther, { status: 'unknown', operationId: op(1) }, 'AD-9/R3: outcome is actor-bound');
  assert.deepEqual(out.confirmOther, { status: 'unknown', operationId: op(1) }, 'AD-9/R3: confirm is actor-bound');
  assert.equal(out.resolverCalls, 0, 'the resolver is never consulted for durable outcomes');
  const after = durableBytes(w.dir);
  assert.ok(before.document.equals(after.document), 'AD-10: document bytes identical across the restart reads');
  assert.equal(Buffer.compare(before.journal || Buffer.alloc(0), after.journal || Buffer.alloc(0)), 0,
    'AD-10: journal bytes identical');
});

// ---------------------------------------------------------------------------
// Namespace, composition and module posture (contract sections 5 and 6).
// ---------------------------------------------------------------------------
test('AC-35 a resolver bound to another household refuses; the loader reports household-mismatch', async t => {
  const w = await world(t);
  const foreign = R.createSettlementEvidenceResolver({ householdId: otherHouseholdId, acquire: w.acquire });
  const controllerB = w.newController(w.store, foreign);
  const result = await w.prepare(1, 2500, context, w.selection, controllerB);
  assert.equal(result.status, 'unavailable', 'the resolver refuses a foreign authority household');
  const loaded = await L.loadSettlementEvidence({
    config: { householdId: otherHouseholdId },
    readPin: () => clone(w.pin),
    readDocument: () => w.documentBytes(),
  });
  assert.deepEqual(loaded, { status: 'unavailable', reason: 'household-mismatch' });
});

test('AC-36 a household-B store cannot bootstrap over household-A traces and the document is untouched', async t => {
  const w = await world(t);
  await w.prepare(1);
  await w.confirm(1);
  const before = w.documentBytes();
  const storeB = w.openStore(otherHouseholdId);
  const boot = await storeB.bootstrap();
  assert.notEqual(boot.status, 'bootstrapped', 'genesis over another household\u2019s traces is refused');
  assert.ok(w.documentBytes().equals(before), 'document bytes unchanged');
});

test('AC-37 the settlement namespace is a pure derivation of the assigned household id', () => {
  assert.equal(R.settlementNamespace(householdId), 'settlement-' + 'a'.repeat(32));
  assert.equal(R.settlementNamespace(otherHouseholdId), 'settlement-' + 'd'.repeat(32));
  assert.notEqual(R.settlementNamespace(householdId), R.settlementNamespace(otherHouseholdId));
  assert.throws(() => R.settlementNamespace('not-a-household'), undefined, 'malformed ids refuse');
});

test('AC-38 absent configuration constructs no resolver (the shipped darkness is preserved)', () => {
  assert.throws(() => R.createSettlementEvidenceResolver(), TypeError);
  assert.throws(() => R.createSettlementEvidenceResolver({ acquire: async () => standardAcquisition() }), TypeError,
    'no householdId: no resolver');
  assert.throws(() => R.createSettlementEvidenceResolver({ householdId }), TypeError,
    'no acquisition: no resolver — there is no default and the production exporter is unimplemented');
  assert.throws(() => R.createSettlementEvidenceResolver({ householdId: 'household-xyz', acquire: async () => null }), TypeError);
});

test('AC-39/AD-6 module posture: no authorize, no session imports, no crosswalk reconstruction, honest hash wording (Amendment 5)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'settlement-evidence-resolver.js'), 'utf8');
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
  assert.deepEqual(requires.sort(), ['./planned-obligation-settlement-contract', 'node:crypto'],
    'the module imports only the contract digest and node:crypto');
  assert.ok(!('authorize' in R), 'no authorize is exported');
  assert.deepEqual(Object.keys(R).sort(), [
    'BIND_LIMITS', 'bindDigest', 'bindEncode', 'bindSnapshot', 'computeAccountMapDigest',
    'computeInstanceDigest', 'computePacketDigest', 'computePacketRowDigest', 'computePlanDigest',
    'createSettlementEvidenceResolver', 'deriveChoiceHandle', 'deriveSelectionHandle', 'deriveTxRef',
    'freezeDeep', 'settlementNamespace',
  ], 'the export surface is exactly the foundation surface — no alternate ref derivation');
  // AD-6: the join is never reconstructed inside the resolver — no local-id
  // derivation, no coverage-reference join, no amount/date/payee matching.
  assert.ok(!source.includes('localIdFor'), 'no sanitizer local-id reconstruction');
  assert.ok(!source.includes('coverageRef'), 'coverageRef is never a join key');
  assert.ok(!/amount\s*===|date\s*===|payee\s*===/.test(source.replace(/row\.date > asOf/, '')),
    'no field-value join reconstruction');
  // Amendment 5: the truncated-hash security wording is stated correctly.
  assert.ok(/64-bit/.test(source) && /birthday/i.test(source),
    'the header states ~64-bit birthday strength for the 128-bit truncated output');
});

// === Write admission (paired resolver capability) =========================
// resolvePairedSelection resolves and classifies exactly once through the
// same core as resolveSelection and returns the ordinary selection plus
// the freshness witness PAIRED with that exact acquisition, captured from
// the raw acquisition's own data descriptor in the same uninterrupted
// snapshot continuation as the four data fields (never reread from the
// retained envelope after classification). Only data enters the snapshot /
// binding path: the witness is never snapshotted, serialized, digested or
// invoked by the resolver, and an acquisition without a genuine function
// witness (absent, non-function, or behind an accessor) yields no pair.

test('WA-R1 resolvePairedSelection returns the ordinary selection plus its paired witness, classifying once', async () => {
  const witness = () => true;
  const acq = { ...standardAcquisition(), witness };
  const resolver = resolverFor(acq);
  const stub = stubClassify();
  const paired = await resolver.resolvePairedSelection(
    { authority: AUTHORITY, selection: handlesFor(acq), classify: stub.classify });
  assert.ok(paired, 'paired resolution succeeds');
  assert.deepEqual(Object.keys(paired).sort(), ['selection', 'witness']);
  assert.equal(paired.witness, witness, 'the exact paired witness is returned');
  assert.equal(stub.calls.length, 1, 'classify invoked exactly once');
  const plain = await resolveDirect(resolverFor(acq), handlesFor(acq), stubClassify().classify);
  assert.deepEqual(paired.selection, plain, 'the paired selection is the ordinary selection');
  assert.equal(JSON.stringify(paired.selection).includes('witness'), false,
    'no witness material enters the selection');
});

test('WA-R2 an acquisition without a genuine function witness yields no pair', async () => {
  const cases = [
    ['absent', standardAcquisition()],
    ['non-function', { ...standardAcquisition(), witness: 'fresh' }],
    ['null', { ...standardAcquisition(), witness: null }],
  ];
  for (const [name, acq] of cases) {
    const paired = await resolverFor(acq).resolvePairedSelection(
      { authority: AUTHORITY, selection: handlesFor(standardAcquisition()), classify: stubClassify().classify });
    assert.equal(paired, null, name);
  }
  // An accessor witness is refused WITHOUT being invoked.
  let getterCalls = 0;
  const accessorAcq = standardAcquisition();
  Object.defineProperty(accessorAcq, 'witness', { enumerable: true,
    get() { getterCalls++; return () => true; } });
  const paired = await resolverFor(accessorAcq).resolvePairedSelection(
    { authority: AUTHORITY, selection: handlesFor(standardAcquisition()), classify: stubClassify().classify });
  assert.equal(paired, null, 'accessor witness refused');
  assert.equal(getterCalls, 0, 'the accessor was never invoked');
});

test('WA-R3 resolveSelection ignores a paired witness entirely and never invokes it', async () => {
  let witnessCalls = 0;
  const acq = { ...standardAcquisition(), witness: () => { witnessCalls++; return true; } };
  const selection = await resolveDirect(resolverFor(acq), handlesFor(acq), stubClassify().classify);
  assert.ok(selection, 'ordinary resolution is unaffected by the pairing');
  assert.equal(witnessCalls, 0);
});

test('WA-R4 a failed resolution yields no pair even when a witness is present', async () => {
  const acq = { ...standardAcquisition(), join: [], witness: () => true };
  const paired = await resolverFor(acq).resolvePairedSelection(
    { authority: AUTHORITY, selection: handlesFor(standardAcquisition()), classify: stubClassify().classify });
  assert.equal(paired, null);
});

test('WA-R5 the paired witness is captured at snapshot time, not reread after classification (B3)', async () => {
  const originalWitness = () => true;
  const substitutedWitness = () => false;
  const acq = { ...standardAcquisition(), witness: originalWitness };
  const resolver = resolverFor(acq);
  const stub = stubClassify();
  // A mutation during classification replaces the retained envelope's
  // witness between the acquisition snapshot and any later read. The
  // pair must carry the witness captured in the same uninterrupted
  // snapshot continuation as the four data fields.
  const classify = (tx, plan, opts) => {
    const verdict = stub.classify(tx, plan, opts);
    acq.witness = substitutedWitness;
    return verdict;
  };
  const paired = await resolver.resolvePairedSelection(
    { authority: AUTHORITY, selection: handlesFor(acq), classify });
  assert.ok(paired, 'paired resolution succeeds');
  assert.equal(stub.calls.length, 1, 'classify invoked exactly once');
  assert.equal(paired.witness, originalWitness,
    'the snapshot-time witness is carried, not the post-classification substitute');
  assert.notEqual(paired.witness, substitutedWitness);
});

test('WA-R6 the paired witness survives a mutation queued as a microtask during classification (B3)', async () => {
  const originalWitness = () => true;
  const substitutedWitness = () => false;
  const acq = { ...standardAcquisition(), witness: originalWitness };
  const resolver = resolverFor(acq);
  const stub = stubClassify();
  // The substitution is QUEUED as a microtask during classification: it
  // lands after the core's synchronous continuation yields but before
  // any post-await reread of the retained envelope could run. The pair
  // must still carry the snapshot-time witness.
  const classify = (tx, plan, opts) => {
    const verdict = stub.classify(tx, plan, opts);
    queueMicrotask(() => { acq.witness = substitutedWitness; });
    return verdict;
  };
  const paired = await resolver.resolvePairedSelection(
    { authority: AUTHORITY, selection: handlesFor(acq), classify });
  assert.ok(paired, 'paired resolution succeeds');
  assert.equal(stub.calls.length, 1, 'classify invoked exactly once');
  assert.equal(paired.witness, originalWitness,
    'the snapshot-time witness is carried, not the microtask substitute');
  assert.notEqual(paired.witness, substitutedWitness);
});
