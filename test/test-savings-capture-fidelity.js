'use strict';
/* G1 v3: capture-side fidelity of the Savings capture evidence (adopted design
 * 6554987596 §6 and 6555018088 §4; obligation table 6554939787 §D).
 * `node --test test/test-savings-capture-fidelity.js`
 *
 * The validators' guarantee is bounded: schema, relationship, constant and
 * internal-consistency checks. Whether each part digest encodes the value the
 * page actually received rests on this file, against the capture's lossless
 * observation-time descriptor snapshots (capturePages options.originals):
 *  1. an independent reference encoder over descriptor snapshots, validated
 *     against the production encoder by vectors (it never calls it);
 *  2. every result r<k>, its identity subparts, the first-reference
 *     de-duplication and every observation's ref, rebuilt from the originals
 *     (never from the live results) and equal to the written evidence;
 *  3. the original-fixed mutation matrix with an explicit expected-verdict
 *     table for the reconstruction, the formatter and the workflow mirror;
 *  4. the reference attacks; 5. the S1-S4 forms.
 *
 * Inputs: the six funded invented inputs, the two committed invented repros
 * (test/fixtures/savings-capture: S1, S2) and two PERTURBATIONS of
 * savings-live-ready (S3, S4), for which no frozen-fixture coverage is claimed.
 * No household input is read, and nothing but test names, counts and timings
 * is printed. Each page capture takes about ten seconds and is made once.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const Snapshot = require('../scripts/figures-snapshot.js');
const Comment = require('../scripts/figures-comment.js');
const Capture = require('../scripts/figures-page-capture.js');

const ROOT = path.join(__dirname, '..');
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

/* ---- the reference encoder ------------------------------------------------ */
// Written from the publication grammar (atlas-savings-publication/v1), not
// from the implementation: n null, u undefined, b1/b0, d<String(number)> with
// d-0 for negative zero, s<JSON string>, [elements], {"key":value,...} in own
// key order, O{...} for a null-prototype object, and @"description":value for
// a symbol-keyed member, kept by description. It refuses a proxy, a foreign
// prototype, an accessor, a non-enumerable string key, a symbol key on an
// array, a sparse or extra-property array, a nonfinite number, a function,
// bigint or symbol value, a cycle, an empty, missing or repeated symbol
// description within one object, and the resource limits (depth 48 below the
// root, one million values, 65536-character strings, keys and descriptions,
// 16 MiB of encoding). Input: a Capture.describeValue descriptor snapshot.
// onRootMember(key, encoding), if given, receives each member of the root
// container as it is encoded, so a reconstruction needs no second pass.
const LIMITS = Object.freeze({ depth: 48, values: 1000000, chars: 65536, bytes: 16 * 1024 * 1024 });
function referenceEncode(snapshot, onRootMember) {
  let values = 0, tokenBytes = 0;
  const refuse = why => { throw new Error('reference encoder refuses (' + why + ')'); };
  const token = text => {
    tokenBytes += text.length;
    if (tokenBytes > LIMITS.bytes) refuse('size');
    return text;
  };
  const sized = text => (text.length > LIMITS.bytes ? refuse('size') : text);
  const quoted = text => (text.length > LIMITS.chars ? refuse('length') : JSON.stringify(text));
  const elements = (node, depth, emit) => {
    if (node.props.some(p => typeof p.key !== 'string')) refuse('symbol key on an array');
    const lengthProp = node.props.find(p => p.key === 'length');
    const length = lengthProp && lengthProp.kind === 'data' && lengthProp.value.t === 'number' ? lengthProp.value.v : -1;
    if (!Number.isSafeInteger(length) || length < 0 || node.props.length !== length + 1) refuse('sparse or extra-property array');
    const byIndex = new Map(node.props.map(p => [p.key, p]));
    const out = new Array(length);
    for (let i = 0; i < length; i++) {
      const p = byIndex.get(String(i));
      if (!p) refuse('hole');
      if (p.kind !== 'data') refuse('accessor');
      out[i] = encode(p.value, depth + 1);
      if (emit) emit(String(i), out[i]);
    }
    return out;
  };
  const members = (node, depth, emit) => {
    const descriptions = new Set();
    return node.props.map(p => {
      if (p.kind !== 'data') refuse('accessor');
      let label;
      if (typeof p.key === 'string') {
        if (!p.enumerable) refuse('non-enumerable string key');
        label = quoted(p.key);
      } else {
        const name = p.key.symbol;
        if (typeof name !== 'string' || name === '' || descriptions.has(name)) refuse('ambiguous symbol key');
        descriptions.add(name);
        label = '@' + quoted(name);
      }
      const encoded = encode(p.value, depth + 1);
      if (emit) emit(p.key, encoded);
      return label + ':' + encoded;
    });
  };
  function encode(node, depth) {
    values += 1;
    if (values > LIMITS.values) refuse('value count');
    if (depth > LIMITS.depth) refuse('depth');
    switch (node.t) {
      case 'null': return token('n');
      case 'undefined': return token('u');
      case 'boolean': return token(node.v ? 'b1' : 'b0');
      case 'number':
        if (node.v === '-0') return token('d-0');
        if (typeof node.v !== 'number' || !Number.isFinite(node.v)) refuse('nonfinite number');
        return token('d' + String(node.v));
      case 'string': return token('s' + quoted(node.v));
      case 'object': break;
      default: refuse(node.t); // proxy, cycle, deep, function, bigint, symbol
    }
    const emit = depth === 0 ? onRootMember : null;
    if (node.cls === 'array') return sized('[' + elements(node, depth, emit).join(',') + ']');
    if (node.cls === 'plain') return sized('{' + members(node, depth, emit).join(',') + '}');
    if (node.cls === 'null') return sized('O{' + members(node, depth, emit).join(',') + '}');
    return refuse('prototype ' + node.cls);
  }
  return encode(snapshot, 0);
}
const stringPart = value => sha256(referenceEncode({ t: 'string', v: value }));

/* ---- the reconstruction --------------------------------------------------- */
// The positive period classes, written from design 6555018088 §1 (the exact
// own key list in producer order, and the constants of each class).
const PERIOD_BASIS = 'operating-surplus-before-proposals';
const READY_KEYS = ['status', 'basis', 'start', 'end', 'entitlement', 'transferred', 'nativePeriodSurplus',
  'alreadySavedIncome', 'remainingEntitlement', 'availableNow', 'proposal', 'unassigned', 'projectedRemainingCapacity',
  'currentCash', 'futureIncome', 'cashCapacity', 'trust', 'cashThrough', 'incomeAuthorityThrough', 'completeness',
  'allocations', 'cycleAllocations', 'actualSaved', 'originalPaydayPlan'];
const CLASS_KEYS = {
  'v1-ready': READY_KEYS,
  'v1-ready-withheld': [...READY_KEYS, 'reason'],
  'v1-unknown': ['status', 'reason', 'entitlement', 'transferred', 'remainingEntitlement', 'availableNow', 'proposal', 'unassigned', 'actualSaved'],
  'v2-packet': ['status', 'kind', 'basis', 'start', 'end', 'trust', 'proposal', 'actualSaved', 'allocations', 'cycleAllocations', 'reason'],
};
const dataProp = (node, key) => node.props.find(p => p.key === key && p.kind === 'data');
const isString = (node, key, value) => { const p = dataProp(node, key); return !!p && p.value.t === 'string' && p.value.v === value; };
const isNull = (node, key) => { const p = dataProp(node, key); return !!p && p.value.t === 'null'; };
function periodClass(period, keys) {
  const exactly = list => list.length === keys.length && list.every((key, i) => key === keys[i]);
  if (exactly(CLASS_KEYS['v1-ready']) && isString(period, 'status', 'ready') && isString(period, 'basis', PERIOD_BASIS)
    && isString(period, 'completeness', 'bounded')) return 'v1-ready';
  // A v1-ready period after the withhold (fc:14940): v1-ready's constants
  // except status, plus a reason and the three withheld figures null.
  if (exactly(CLASS_KEYS['v1-ready-withheld']) && isString(period, 'status', 'unavailable') && isString(period, 'basis', PERIOD_BASIS)
    && isString(period, 'completeness', 'bounded') && ['proposal', 'availableNow', 'actualSaved'].every(key => isNull(period, key))) return 'v1-ready-withheld';
  if (exactly(CLASS_KEYS['v1-unknown']) && isString(period, 'status', 'unavailable')
    && keys.every(key => key === 'status' || key === 'reason' || isNull(period, key))) return 'v1-unknown';
  if (exactly(CLASS_KEYS['v2-packet']) && isString(period, 'basis', PERIOD_BASIS)
    && (isString(period, 'kind', 'historical') || isString(period, 'kind', 'projected'))) return 'v2-packet';
  return 'unsupported';
}
// class|keylist|kind|start|end|status, from the result's own enumerable data
// property `period` when it is a plain object.
function identityOf(result) {
  const p = result.props.find(q => q.key === 'period' && q.kind === 'data' && q.enumerable);
  const period = p && p.value;
  if (!period || period.t !== 'object' || period.cls !== 'plain') return 'unsupported|absent|absent|absent|absent|absent';
  const keys = period.props.filter(q => typeof q.key === 'string' && q.enumerable).map(q => q.key);
  const sub = key => { const q = dataProp(period, key); return q ? sha256(referenceEncode(q.value)) : 'absent'; };
  return [periodClass(period, keys), sha256(JSON.stringify(keys)), sub('kind'), sub('start'), sub('end'), sub('status')].join('|');
}
// One result from its descriptor snapshot: shape, manifest, parts, digest and
// identity. A top-level symbol key is refused (design 6554987596 §7). Each
// part is the reference encoding of that member's snapshot, taken from one
// walk of the whole result, so the whole-result refusals and limits apply as
// the evidence writer applies them (caseData checks the parts against
// separate referenceEncode calls too).
function reconstructResult(original) {
  assert.equal(original.t, 'object', 'an original is an object snapshot');
  if (original.props.some(p => typeof p.key !== 'string')) throw new Error('reconstruction refuses (top-level symbol key)');
  const encoded = new Map();
  referenceEncode(original, (key, encoding) => { encoded.set(key, encoding); });
  const shape = original.cls === 'array' ? 'array' : original.cls === 'null' ? 'null-object' : 'object';
  const names = shape === 'array' ? [...encoded.keys()]
    : original.props.filter(p => typeof p.key === 'string' && p.enumerable && p.kind === 'data').map(p => p.key);
  const parts = names.map(name => sha256(encoded.get(name)));
  const keys = JSON.stringify(names);
  return { shape, keys, parts, digest: sha256(shape + '\n' + keys + '\n' + parts.join('\n')), identity: shape === 'array' ? undefined : identityOf(original) };
}
// Every result key, in first-reference order, and every observation's ref and
// type. A null result has no original; its o.result is read only to confirm
// that it is null.
function reconstructCapture(observations) {
  const results = {}, refs = [], types = [];
  const byDigest = new Map();
  observations.forEach((o, n) => {
    if (!o.original) {
      assert.equal(o.result, null, 'observation ' + n + ' is either an object with its original or null');
      refs.push('null'); types.push('null');
      return;
    }
    const r = reconstructResult(o.original);
    if (!byDigest.has(r.digest)) {
      const k = 'r' + byDigest.size;
      byDigest.set(r.digest, k);
      const at = 'savings.capture.' + k + '.';
      results[at + 'shape'] = r.shape;
      results[at + 'keys'] = r.keys;
      r.parts.forEach((part, j) => { results[at + 'part.' + j] = part; });
      results[at + 'digest'] = r.digest;
      if (r.identity !== undefined) results[at + 'identity'] = r.identity;
    }
    refs.push(byDigest.get(r.digest)); types.push(r.shape === 'array' ? 'array' : 'object');
  });
  results['savings.capture.results'] = byDigest.size;
  return { count: observations.length, results, refs, types };
}
// The same view of written (or mutated) evidence, and the differences, as
// key names only.
const lines = map => Array.from({ length: map['savings.capture.count'] }, (_, n) => String(map['savings.capture.o' + n]).split('|'));
function evidenceView(map) {
  const results = {};
  for (const key of Object.keys(map)) if (key === 'savings.capture.results' || /^savings\.capture\.r\d+\./.test(key)) results[key] = map[key];
  const fields = lines(map);
  return { count: map['savings.capture.count'], results, refs: fields.map(f => f[5]), types: fields.map(f => f[6]) };
}
function differences(evidence, rebuilt) {
  const out = [];
  if (evidence.count !== rebuilt.count) out.push('count');
  for (const key of new Set([...Object.keys(evidence.results), ...Object.keys(rebuilt.results)])) {
    if (!(key in evidence.results)) out.push('evidence lacks ' + key);
    else if (!(key in rebuilt.results)) out.push('evidence has extra ' + key);
    else if (evidence.results[key] !== rebuilt.results[key]) out.push('differs ' + key);
  }
  for (let n = 0; n < Math.max(evidence.refs.length, rebuilt.refs.length); n++) {
    if (evidence.refs[n] !== rebuilt.refs[n]) out.push('ref o' + n);
    if (evidence.types[n] !== rebuilt.types[n]) out.push('type o' + n);
  }
  return out;
}

/* ---- the inputs and their captures ---------------------------------------- */
const FUNDED = Snapshot.loadInventedInputs().filter(input => input.id.startsWith('savings-'));
const clone = value => JSON.parse(JSON.stringify(value));
const repro = file => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'savings-capture', file), 'utf8'));
  return Snapshot.validateInventedInput(doc, file);
};
const liveReady = () => FUNDED.find(input => input.id === 'savings-live-ready').doc;
// S3 and S4 are PERTURBATIONS, not frozen fixtures (design 6554987596 §6): the
// engine's recommend output is corrupted so that the real selector withholds.
// S3: the next pay period's planned requirements name another currency, so
// its packet is invalid and withheld. S4: the top-level publication names
// another currency, so every selector call returns null.
const withholdNextPacket = advice => {
  const views = advice && advice.savingsFunding && advice.savingsFunding.periodViews;
  const next = Array.isArray(views) ? views.find(view => view && view.role === 'next') : null;
  if (next && next.packet && next.packet.plannedRequirements) next.packet.plannedRequirements.currency = 'USD';
  return advice;
};
const withholdTopLevel = advice => {
  if (advice && advice.savingsFunding) advice.savingsFunding.currency = 'USD';
  return advice;
};
const PERTURBATION_LABEL = 'PERTURBATION of savings-live-ready; no frozen-fixture coverage is claimed';
const CASES = [
  ...FUNDED.map(input => ({ id: input.id, label: input.id + ' (committed invented input)', doc: () => input.doc })),
  { id: 'S1', label: 'S1 historical-pools (committed invented repro)', doc: () => repro('s1-historical-pools.json') },
  { id: 'S2', label: 'S2 ready-withheld V1 (committed invented repro)', doc: () => repro('s2-ready-withheld.json') },
  { id: 'S3', label: 'S3 withheld next packet (' + PERTURBATION_LABEL + ')', doc: liveReady, corrupt: withholdNextPacket },
  { id: 'S4', label: 'S4 withheld top-level result (' + PERTURBATION_LABEL + ')', doc: liveReady, corrupt: withholdTopLevel },
];
// The live results of this one capture stay available to test 2's
// fixed-snapshot check, which then releases them; test 3's nested deletion
// reads one original of the same input.
const FIXED_DEMO = 'savings-live-ready';
const KEEP_ORIGINALS = new Set(['savings-live-ready']);
const memo = new Map();
// One capture per case, with originals: its evidence, the itemized head, the
// reconstruction and (KEEP_ORIGINALS) the first original of each result.
function caseData(id) {
  if (memo.has(id)) return memo.get(id);
  const spec = CASES.find(c => c.id === id);
  assert.ok(spec, 'known case ' + id);
  const doc = spec.doc();
  const data = clone(doc.data), periods = doc.periods == null ? null : clone(doc.periods);
  const started = Date.now();
  const real = F.recommend;
  const evidence = {};
  let capture, head;
  try {
    // A perturbation corrupts recommend in both realms: the page's own
    // Forecast (the capture) and this process's Forecast (the itemized
    // snapshot of buildFiguresSnapshot).
    if (spec.corrupt) F.recommend = function perturbed(...args) { return spec.corrupt(real.apply(this, args)); };
    const run = () => Capture.capturePages(data, periods, ROOT, { originals: true });
    capture = spec.corrupt
      ? Capture.withPerturbations({ recommend: inPage => function perturbed(...args) { return spec.corrupt(inPage.apply(this, args)); } }, run)
      : run();
    Snapshot.__putCaptureEvidence(evidence, '', capture);
    head = { ...Snapshot.buildFiguresSnapshot(data, periods), ...evidence };
  } finally {
    F.recommend = real;
  }
  const captured = Date.now();
  const reconstruction = reconstructCapture(capture.observations);
  // Each distinct result's parts, recomputed member by member as
  // sha256(referenceEncode(member snapshot)) from its first original.
  const partMismatches = [];
  const firstOriginal = new Map();
  capture.observations.forEach((o, n) => {
    const ref = reconstruction.refs[n];
    if (!o.original || firstOriginal.has(ref)) return;
    firstOriginal.set(ref, o.original);
    JSON.parse(reconstruction.results['savings.capture.' + ref + '.keys']).forEach((name, j) => {
      const member = o.original.props.find(p => p.key === name);
      if (sha256(referenceEncode(member.value)) !== reconstruction.results['savings.capture.' + ref + '.part.' + j]) partMismatches.push(ref + '.part.' + j);
    });
  });
  if (!KEEP_ORIGINALS.has(id)) firstOriginal.clear();
  const entry = { id, label: spec.label, evidence, head, reconstruction, firstOriginal, partMismatches,
    capture: id === FIXED_DEMO ? capture : null, ms: { capture: captured - started, reconstruction: Date.now() - captured } };
  memo.set(id, entry);
  return entry;
}

/* ---- evidence editing helpers --------------------------------------------- */
const rkey = (k, field) => 'savings.capture.r' + k + '.' + field;
function readResult(map, k) {
  const names = JSON.parse(map[rkey(k, 'keys')]);
  return { shape: map[rkey(k, 'shape')], names, parts: names.map((_, j) => map[rkey(k, 'part.' + j)]), identity: map[rkey(k, 'identity')] };
}
// Writes one result's manifest and parts and recomputes its digest from them,
// so only the variant rules can tell.
function writeResult(map, k, r) {
  for (const key of Object.keys(map)) if (key.startsWith(rkey(k, 'part.'))) delete map[key];
  map[rkey(k, 'shape')] = r.shape;
  map[rkey(k, 'keys')] = JSON.stringify(r.names);
  r.parts.forEach((part, j) => { map[rkey(k, 'part.' + j)] = part; });
  map[rkey(k, 'digest')] = sha256(r.shape + '\n' + JSON.stringify(r.names) + '\n' + r.parts.join('\n'));
  map[rkey(k, 'identity')] = r.identity;
}
function editResult(head, k, edit) {
  const r = readResult(head, k);
  edit(r);
  writeResult(head, k, r);
  return head;
}
const partOf = (head, k, name) => { const r = readResult(head, k); return r.parts[r.names.indexOf(name)]; };
const setLine = (head, n, fields) => { head['savings.capture.o' + n] = fields.join('|'); };
const setRef = (head, n, ref) => { const f = lines(head)[n]; f[5] = ref; setLine(head, n, f); };
// The view a context names (the last periodId or period=view), as the
// validators read it.
const viewOf = context => {
  let id = null;
  for (const m of String(context).matchAll(/(?:^|,)(?:periodId="([^"]*)"|period=view:([^,]*))/g)) id = m[1] ?? m[2];
  return id;
};
// Each result's class and, for a packet, the view its identity start names
// (from the first Budget advice's view lines).
function resultViews(head) {
  const views = new Map();
  const advice = head['savings.capture.advice.0'].split('|');
  for (let j = 0; j < Number(advice[5]); j++) {
    const [id, role, start] = head['savings.capture.advice.0.view.' + j].split('|');
    views.set(start, { id, role });
  }
  return Array.from({ length: head['savings.capture.results'] }, (_, k) => {
    const [cls, , , start] = head[rkey(k, 'identity')].split('|');
    return { ref: 'r' + k, k, cls, view: cls === 'v2-packet' ? views.get(start) : null };
  });
}
const resultFor = (head, test) => { const r = resultViews(head).find(test); assert.ok(r, 'the evidence has the result this row edits'); return r; };
const swap = (list, a, b) => { [list[a], list[b]] = [list[b], list[a]]; };
// A copy of one descriptor snapshot with one nested string-keyed member
// deleted (the deepest-first object that has one; arrays are descended).
function withoutOneNestedKey(node) {
  if (node.t !== 'object') return null;
  if (node.cls !== 'array') {
    const i = node.props.map(p => typeof p.key === 'string').lastIndexOf(true);
    if (i >= 0) return { ...node, props: node.props.filter((_, j) => j !== i) };
  }
  for (let j = 0; j < node.props.length; j++) {
    if (node.props[j].kind !== 'data') continue;
    const inner = withoutOneNestedKey(node.props[j].value);
    if (inner) return { ...node, props: node.props.map((p, x) => (x === j ? { ...p, value: inner } : p)) };
  }
  return null;
}

/* ---- the workflow mirror -------------------------------------------------- */
// The posting step's independent validator (.github/workflows/figures-review.yml),
// from the comment line naming "Savings capture evidence" to just before
// `const digestState`, with the script's 12-space indentation stripped. It
// reads the posting step's own `head`, `headInputs` (a Map of invented-input
// id to digest), `has` and `DIGEST`, increments `invalid`, and loads only the
// built-in crypto. Its prefix loop runs over '' and then 'fixture.<id>.' for
// each id in headInputs; an empty Map makes it evaluate exactly the household
// prefix '', where this file writes the evidence (unprefixed keys).
const HAS_SOURCE = 'const has = (map, key) => map !== null && Object.prototype.hasOwnProperty.call(map, key);';
const has = (map, key) => map !== null && Object.prototype.hasOwnProperty.call(map, key);
const DIGEST = /^[a-f0-9]{64}$/;
const LEGACY_MIRROR = 'atlas-savings-page-capture/v2';
let mirrorMemo = null;
function workflowMirror() {
  if (mirrorMemo) return mirrorMemo;
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'figures-review.yml'), 'utf8');
  const all = text.split(/\r?\n/);
  const start = all.findIndex(line => /^\s*\/\//.test(line) && line.includes('Savings capture evidence'));
  const end = start < 0 ? -1 : all.findIndex((line, i) => i > start && /^\s*const digestState\b/.test(line));
  assert.ok(start >= 0 && end > start, 'the workflow mirror block is found');
  const body = all.slice(start, end);
  assert.ok(body.every(line => line.trim() === '' || line.startsWith(' '.repeat(12))), 'the block sits at the posting script\'s indentation');
  const block = body.map(line => (line.trim() === '' ? '' : line.slice(12))).join('\n');
  assert.ok(text.includes(HAS_SOURCE) && text.includes('DIGEST = /^[a-f0-9]{64}$/'), 'the wrapper passes the posting step\'s own has and DIGEST');
  const source = '(function (head, headInputs, has, DIGEST) { let invalid = 0;\n' + block + '\nreturn invalid; })';
  const sandbox = { require: name => {
    if (name !== 'crypto' && name !== 'fs') throw new Error('the workflow mirror may load only crypto and fs, not ' + name);
    return require(name);
  } };
  const fn = vm.runInNewContext(source, sandbox, { filename: 'figures-review.yml#savings-capture-evidence' });
  const run = head => fn(head, new Map(), has, DIGEST);
  const smoke = run({});
  assert.ok(Number.isSafeInteger(smoke) && smoke > 0, 'the extracted mirror evaluates, and refuses an empty head');
  const version = (/'(atlas-savings-page-capture\/v\d+)\+atlas-savings-publication\/v\d+'/.exec(block) || [])[1] || null;
  mirrorMemo = { run, version, skip: version === LEGACY_MIRROR
    ? 'the workflow mirror still reports ' + LEGACY_MIRROR + ' (its v3 rewrite is pending); the mirror column is not asserted'
    : false };
  return mirrorMemo;
}
const verdict = problems => (problems > 0 ? 'refuses' : 'accepts');

/* ---- 1 ---------------------------------------------------------------------- */
const sym = (object, description, value, enumerable = false) =>
  Object.defineProperty(object, Symbol(description), { value, enumerable, writable: true, configurable: true });
const nest = levels => { let v = 1; for (let i = 0; i < levels; i++) v = { d: v }; return v; };
const LONG = 'x'.repeat(60000);
const ACCEPTED = [
  ['null', () => null], ['undefined', () => undefined], ['true', () => true], ['false', () => false],
  ['zero', () => 0], ['negative zero', () => -0], ['integer', () => 42], ['negative fraction', () => -7.25],
  ['inexact sum', () => 0.1 + 0.2], ['large exponent', () => 1e21], ['small exponent', () => 1e-7],
  ['denormal', () => 5e-324], ['max safe integer', () => Number.MAX_SAFE_INTEGER],
  ['empty string', () => ''], ['escapes', () => 'quote " backslash \\ newline \n tab \t nul \u0000'],
  ['unicode', () => 'e\u0301 \u2713 \u2028 \ud83d\ude00'], ['lone surrogate', () => '\ud800'],
  ['empty array', () => []], ['empty object', () => ({})], ['empty null-prototype object', () => Object.create(null)],
  ['nested empties', () => ({ a: [], b: {}, c: Object.create(null), d: [[], {}] })],
  ['own undefined member', () => ({ a: undefined })],
  ['integer-like key order', () => ({ b: 1, 2: 'two', a: 2, 1: 'one' })],
  ['negative zero nested', () => ({ a: [0, -0, null, [undefined, false]], b: -0 })],
  ['null-prototype object with members', () => Object.assign(Object.create(null), { x: 1, y: [1, 2], z: Object.assign(Object.create(null), { w: 's' }) })],
  ['nested non-enumerable symbol-keyed scalar (kept)', () => ({ rows: [], stock: sym({ cents: 1 }, 'savingsReportedCents', 500) })],
  ['nested enumerable symbol-keyed members', () => ({ a: sym(sym({}, 'first', { b: 1 }, true), 'second', [1], true) })],
  ['one symbol shared by two objects', () => { const s = Symbol('k'); return { a: { [s]: 1 }, b: { [s]: 2 } }; }],
  ['equal descriptions in different objects', () => ({ a: { [Symbol('k')]: 1 }, b: { [Symbol('k')]: 2 } })],
  ['a shared, non-cyclic reference', () => { const shared = { v: 1 }; return { a: shared, b: [shared, shared] }; }],
  ['another realm\'s plain object, array and null-prototype object', () => vm.runInNewContext('({ a: [1, { b: null }], c: Object.create(null), d: -0 })')],
  ['depth at the limit (48)', () => nest(48)],
  ['string at the length limit', () => ({ s: 'x'.repeat(65536) })],
  ['key at the length limit', () => ({ ['k'.repeat(65536)]: 1 })],
  ['symbol description at the length limit', () => sym({}, 'd'.repeat(65536), 1)],
  ['just under the size limit', () => Array.from({ length: 250 }, () => LONG)],
];
const REFUSED = [
  ['proxy', () => new Proxy({}, {})], ['nested proxy', () => ({ a: new Proxy([], {}) })],
  ['class instance (foreign prototype)', () => new (class Packet { constructor() { this.a = 1; } })()],
  ['Date (foreign prototype)', () => new Date(0)], ['nested Date', () => ({ at: new Date(0) })],
  ['Map', () => new Map([[1, 2]])], ['boxed number', () => Object(1)], ['typed array', () => new Uint8Array(2)],
  ['object with a non-intrinsic prototype', () => Object.create({ inherited: 1 })],
  ['Array subclass', () => { class Rows extends Array {} return Rows.from([1, 2]); }],
  ['array with a null prototype', () => Object.setPrototypeOf([1], null)],
  ['enumerable accessor', () => Object.defineProperty({}, 'a', { get() { return 1; }, enumerable: true })],
  ['nested accessor', () => ({ a: Object.defineProperty({}, 'b', { get() { return 1; }, enumerable: true }) })],
  ['accessor array element', () => Object.defineProperty([0], '0', { get() { return 1; }, enumerable: true })],
  ['symbol-keyed accessor', () => ({ a: Object.defineProperty({}, Symbol('s'), { get() { return 1; } }) })],
  ['non-enumerable string property', () => Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false })],
  ['nested non-enumerable string property', () => ({ a: Object.defineProperty({}, 'hidden', { value: 2, enumerable: false }) })],
  ['symbol key on an array', () => Object.defineProperty([1], Symbol('s'), { value: 1 })],
  ['sparse array', () => [1, , 3]], // eslint-disable-line no-sparse-arrays
  ['trailing holes', () => { const a = [1]; a.length = 3; return a; }],
  ['extra-property array', () => Object.assign([1], { extra: 2 })],
  ['NaN', () => NaN], ['Infinity', () => Infinity], ['nested -Infinity', () => ({ a: [-Infinity] })],
  ['cycle', () => { const o = {}; o.self = o; return o; }],
  ['array cycle', () => { const a = []; a.push(a); return a; }],
  ['indirect cycle', () => { const a = { b: {} }; a.b.a = a; return a; }],
  ['two symbols with one description', () => ({ o: sym(sym({}, 'x', 1), 'x', 2) })],
  ['empty symbol description', () => ({ o: sym({}, '', 1) })],
  ['symbol without a description', () => ({ o: Object.defineProperty({}, Symbol(), { value: 1 }) })],
  ['function value', () => ({ f() {} })], ['bigint value', () => ({ n: 1n })], ['symbol value', () => ({ s: Symbol('v') })],
  ['depth beyond the limit (49)', () => nest(49)],
  ['beyond the snapshot\'s own depth (70)', () => nest(70)],
  ['string beyond the length limit', () => 'x'.repeat(65537)],
  ['key beyond the length limit', () => ({ ['k'.repeat(65537)]: 1 })],
  ['symbol description beyond the length limit', () => ({ o: sym({}, 'd'.repeat(65537), 1) })],
  ['over the size limit', () => Array.from({ length: 300 }, () => LONG)],
  ['over the value-count limit', () => new Array(1000000).fill(0)],
];
const sameText = (a, b, message) => {
  if (a.length + b.length > 4096) assert.deepEqual([a.length, sha256(a)], [b.length, sha256(b)], message);
  else assert.equal(a, b, message);
};

test('independent reference encoder', () => {
  // The vectors are snapshotted with the capture's own describeValue, then
  // encoded both ways; the reference encoder never calls encodePublication.
  for (const [name, make] of ACCEPTED) {
    sameText(referenceEncode(Capture.describeValue(make())), Snapshot.encodePublication(make(), 'vector ' + name), name);
  }
  for (const [name, make] of REFUSED) {
    assert.throws(() => Snapshot.encodePublication(make(), 'vector ' + name), /unencodable savings publication/, 'production refuses ' + name);
    assert.throws(() => referenceEncode(Capture.describeValue(make())), /reference encoder refuses/, 'reference refuses ' + name);
  }
  // Spot checks of the grammar itself, independent of both implementations.
  assert.equal(referenceEncode(Capture.describeValue({ a: [null, undefined, true, false, -0, 1.5, 's'], b: Object.create(null) })),
    '{"a":[n,u,b1,b0,d-0,d1.5,s"s"],"b":O{}}');
  assert.equal(referenceEncode(Capture.describeValue({ stock: sym({ cents: 1 }, 'savingsReportedCents', 500) })),
    '{"stock":{"cents":d1,@"savingsReportedCents":d500}}', 'a nested non-enumerable symbol-keyed scalar is kept by description');
  // The root-member hook yields each member's own reference encoding.
  const sample = Capture.describeValue({ a: [1, { b: -0 }], c: Object.create(null), d: sym({ e: 's' }, 'f', null) });
  const members = [];
  referenceEncode(sample, (key, encoding) => members.push([key, encoding]));
  assert.deepEqual(members, sample.props.map(p => [p.key, referenceEncode(p.value)]));
  // A top-level symbol key: the encoder alone keeps it by description, but the
  // evidence writer (captureResultParts) and this reconstruction refuse it
  // before enumeration, so Object.keys can never erase it.
  const topSymbols = [
    () => sym({ source: 'Forecast.savingsDailyFunding' }, 'savingsReportedCents', 1),
    () => sym({ source: 'Forecast.savingsDailyFunding' }, 'visible', 2, true),
  ];
  for (const make of topSymbols) {
    assert.equal(referenceEncode(Capture.describeValue(make())), Snapshot.encodePublication(make(), 'top-level symbol'));
    assert.throws(() => Snapshot.__putCaptureEvidence({}, '', { runs: [], advices: [], observations: [
      { page: 'budget', state: 'default', route: 'r', source: 's', context: 'c', result: make(), error: null }] }), /top-level symbol/);
    assert.throws(() => reconstructResult(Capture.describeValue(make())), /top-level symbol/);
  }
});

/* ---- 2 ---------------------------------------------------------------------- */
test('reconstruction from lossless originals equals the evidence exactly', async t => {
  // The positive classes written above agree with the producer's and the
  // formatter's tables (one fact in three homes; the reconstruction keeps
  // its own copy so it does not borrow the producer's).
  assert.deepEqual(Object.keys(CLASS_KEYS), Object.keys(Snapshot.PERIOD_CLASS_KEYS));
  for (const [cls, keys] of Object.entries(CLASS_KEYS)) {
    assert.deepEqual(keys, Snapshot.PERIOD_CLASS_KEYS[cls] || [...Snapshot.PERIOD_CLASS_KEYS['v1-ready'], 'reason'], cls);
    assert.deepEqual(keys, Comment.CAPTURE_PERIOD_CLASSES[cls], cls);
  }
  assert.equal(FUNDED.length, 6, 'six funded invented inputs');
  for (const spec of CASES) {
    await t.test(spec.label, st => {
      const c = caseData(spec.id);
      st.diagnostic(spec.id + ': capture and evidence ' + c.ms.capture + ' ms, reconstruction ' + c.ms.reconstruction + ' ms, '
        + c.reconstruction.count + ' observations, ' + c.reconstruction.results['savings.capture.results'] + ' results');
      assert.equal(c.evidence['savings.capture.version'], Snapshot.CAPTURE_EVIDENCE);
      assert.deepEqual(differences(evidenceView(c.evidence), c.reconstruction), [], 'every r<k> key and every ref, exactly');
      assert.deepEqual(c.partMismatches, [], 'every part is sha256(referenceEncode(member snapshot))');
      assert.ok(c.reconstruction.count > 0, 'the pages observed the selector');
    });
    if (spec.id === FIXED_DEMO) await t.test('every snapshot is fixed at observation time (' + FIXED_DEMO + ')', fixedSnapshots);
  }
});
// After the capture, the live result objects are mutated; the evidence was
// written from them before, and the reconstruction from the originals still
// equals it, so no later mutation of a shared object is ever the comparison.
function fixedSnapshots() {
  const c = caseData(FIXED_DEMO);
  assert.ok(c.capture, 'the live capture is still held for this check');
  const { observations } = c.capture;
  // A top-level result and one of its own packets, each an observed result.
  let first = null, packetObservation = null;
  for (const o of observations) {
    if (!o.original || !Array.isArray(o.result.periodViews)) continue;
    packetObservation = observations.find(q => q.original && o.result.periodViews.some(view => view && view.packet === q.result));
    if (packetObservation) { first = o; break; }
  }
  assert.ok(first && packetObservation, 'a packet inside a top-level result is itself an observed result');
  const live = first.result, packet = packetObservation.result;
  for (const o of [first, packetObservation]) {
    assert.equal(Snapshot.encodePublication(o.result, 'live'), referenceEncode(o.original), 'live and original agree before the edit');
  }
  // Mutate the shared live objects: a top-level key deleted, a nested value
  // changed, and a packet (also reachable from the top-level result) rewritten.
  delete live[Object.keys(live).find(key => key !== 'period' && key !== 'periodViews')];
  live.period.status = 'tampered';
  packet.rows = [{ tampered: true }];
  packet.status = 'tampered';
  for (const o of [first, packetObservation]) {
    assert.notEqual(Snapshot.encodePublication(o.result, 'live'), referenceEncode(o.original), 'the live object moved');
  }
  // Then every live result is emptied outright.
  for (const o of observations) if (o.result) for (const key of Reflect.ownKeys(o.result)) Reflect.deleteProperty(o.result, key);
  assert.ok(observations.some(o => o.result && Object.keys(o.result).length === 0), 'the live results are gone');
  assert.deepEqual(differences(evidenceView(c.evidence), reconstructCapture(observations)), [],
    'the reconstruction from every original is unchanged');
  c.capture = null; // release the live page realms
}

/* ---- 3 ---------------------------------------------------------------------- */
// Rows from 6554939787 §D, adapted to v3 evidence. Each edits the itemized
// head plus evidence of one input with the originals held fixed; a result's
// digest is recomputed from its edited manifest and parts.
const ROWS = {
  'delete a required key (stock, V1)': ['savings-live-ready', head => editResult(head, resultFor(head, r => r.cls === 'v1-ready').k, r => {
    const j = r.names.indexOf('stock'); r.names.splice(j, 1); r.parts.splice(j, 1);
  })],
  'delete one packet\'s forecastClosing (next)': ['savings-live-ready', head => editResult(head, resultFor(head, r => r.view && r.view.role === 'next').k, r => {
    const j = r.names.indexOf('forecastClosing'); r.names.splice(j, 1); r.parts.splice(j, 1);
  })],
  'delete reason from the v1-unknown result': ['savings-estimated-close', head => editResult(head, resultFor(head, r => r.cls === 'v1-unknown').k, r => {
    const j = r.names.indexOf('reason'); assert.ok(j >= 0); r.names.splice(j, 1); r.parts.splice(j, 1);
  })],
  'add a forbidden key (plannedRequirements on V1)': ['savings-live-ready', head => {
    const next = resultFor(head, r => r.view && r.view.role === 'next');
    const planned = partOf(head, next.k, 'plannedRequirements');
    return editResult(head, resultFor(head, r => r.cls === 'v1-ready').k, r => { r.names.push('plannedRequirements'); r.parts.push(planned); });
  }],
  'add reason on a ready result': ['savings-live-ready', head => editResult(head, resultFor(head, r => r.cls === 'v1-ready').k, r => {
    const j = r.names.indexOf('status') + 1; r.names.splice(j, 0, 'reason'); r.parts.splice(j, 0, stringPart('withheld'));
  })],
  'duplicate a key (rows)': ['savings-live-ready', head => editResult(head, resultFor(head, r => r.view && r.view.role === 'past').k, r => {
    const j = r.names.indexOf('rows'); r.names.splice(j + 1, 0, 'rows'); r.parts.splice(j + 1, 0, r.parts[j]);
  })],
  'reorder two keys with their parts (rows, stock)': ['savings-live-ready', head => editResult(head, resultFor(head, r => r.view && r.view.role === 'past').k, r => {
    const a = r.names.indexOf('rows'), b = r.names.indexOf('stock'); swap(r.names, a, b); swap(r.parts, a, b);
  })],
  'swap two constant parts (currency, source)': ['savings-live-ready', head => editResult(head, resultFor(head, r => r.cls === 'v1-ready').k, r => {
    swap(r.parts, r.names.indexOf('currency'), r.names.indexOf('source'));
  })],
  'swap two non-constant parts (rows, unresolved)': ['savings-live-ready', head => {
    const target = resultFor(head, r => partOf(head, r.k, 'rows') !== partOf(head, r.k, 'unresolved'));
    return editResult(head, target.k, r => { swap(r.parts, r.names.indexOf('rows'), r.names.indexOf('unresolved')); });
  }],
  'nested deletion (one part re-digested from a modified nested value)': ['savings-live-ready', (head, c) => {
    const v1 = resultFor(head, r => r.cls === 'v1-ready');
    const original = c.firstOriginal.get(v1.ref).props.find(p => p.key === 'stock');
    const modified = withoutOneNestedKey(original.value);
    assert.ok(modified, 'the stock part has a nested key to delete');
    const part = sha256(referenceEncode(modified));
    return editResult(head, v1.k, r => {
      const j = r.names.indexOf('stock'); assert.notEqual(r.parts[j], part); r.parts[j] = part;
    });
  }],
  'point one observation at another variant\'s result': ['savings-live-ready', head => {
    const v1 = resultFor(head, r => r.cls === 'v1-ready'), packet = resultFor(head, r => r.cls === 'v2-packet');
    setRef(head, lines(head).findIndex(f => f[5] === v1.ref), packet.ref);
    return head;
  }],
  'point one packet observation at another same-role view\'s packet': ['savings-live-ready', head => {
    const [a, b] = resultViews(head).filter(r => r.view && r.view.role === 'past');
    setRef(head, lines(head).findIndex(f => f[5] === a.ref), b.ref);
    return head;
  }],
  'consistently swap two future views\' results everywhere': ['savings-live-ready', head => {
    const [a, b] = resultViews(head).filter(r => r.view && r.view.role === 'future');
    const ra = readResult(head, a.k), rb = readResult(head, b.k);
    writeResult(head, a.k, rb); writeResult(head, b.k, ra);
    return head;
  }],
  'change one identity subpart (start digest)': ['savings-live-ready', head => {
    const [a, b] = resultViews(head).filter(r => r.view && r.view.role === 'past');
    const id = head[rkey(a.k, 'identity')].split('|'); id[3] = head[rkey(b.k, 'identity')].split('|')[3];
    head[rkey(a.k, 'identity')] = id.join('|');
    return head;
  }],
};
// The expected verdicts. The bounded validators cannot, by design, detect a
// swap of two non-constant parts or a consistent deletion inside a value:
// those two rows rest on the reconstruction alone.
const REFUSE = { reconstruction: 'differs', formatter: 'refuses', mirror: 'refuses' };
const BLIND = { reconstruction: 'differs', formatter: 'accepts', mirror: 'accepts' };
const EXPECTED_VERDICTS = {
  'delete a required key (stock, V1)': REFUSE,
  'delete one packet\'s forecastClosing (next)': REFUSE,
  'delete reason from the v1-unknown result': REFUSE,
  'add a forbidden key (plannedRequirements on V1)': REFUSE,
  'add reason on a ready result': REFUSE,
  'duplicate a key (rows)': REFUSE,
  'reorder two keys with their parts (rows, stock)': REFUSE,
  'swap two constant parts (currency, source)': REFUSE,
  'swap two non-constant parts (rows, unresolved)': BLIND,
  'nested deletion (one part re-digested from a modified nested value)': BLIND,
  'point one observation at another variant\'s result': REFUSE,
  'point one packet observation at another same-role view\'s packet': REFUSE,
  'consistently swap two future views\' results everywhere': REFUSE,
  'change one identity subpart (start digest)': REFUSE,
};
const columns = (table, names) => Object.fromEntries(Object.entries(table).map(([row, v]) => [row, Object.fromEntries(names.map(n => [n, v[n]]))]));

test('the mutation matrix: reconstruction fails on every row; each validator matches its verdict table', async t => {
  const mirror = workflowMirror();
  const inputs = new Map(['savings-live-ready', 'savings-estimated-close'].map(id => [id, caseData(id)]));
  for (const [id, c] of inputs) {
    assert.deepEqual(differences(evidenceView(c.head), c.reconstruction), [], id + ': the unedited head reconstructs');
    assert.equal(Comment.captureEvidenceProblems(c.head, ['']), 0, id + ': the unedited head is valid');
  }
  assert.deepEqual(Object.keys(ROWS), Object.keys(EXPECTED_VERDICTS));
  const mutated = {}, actual = {};
  for (const [row, [id, apply]] of Object.entries(ROWS)) {
    const c = inputs.get(id);
    const head = apply({ ...c.head }, c);
    assert.notDeepEqual(head, c.head, row + ' edits the evidence');
    mutated[row] = head;
    actual[row] = { reconstruction: differences(evidenceView(head), c.reconstruction).length > 0 ? 'differs' : 'equal',
      formatter: verdict(Comment.captureEvidenceProblems(head, [''])) };
  }
  assert.deepEqual(actual, columns(EXPECTED_VERDICTS, ['reconstruction', 'formatter']));
  await t.test('workflow mirror column', { skip: mirror.skip }, () => {
    for (const [id, c] of inputs) assert.equal(mirror.run(c.head), 0, id + ': the mirror accepts the unedited head');
    const column = Object.fromEntries(Object.entries(mutated).map(([row, head]) => [row, { mirror: verdict(mirror.run(head)) }]));
    assert.deepEqual(column, columns(EXPECTED_VERDICTS, ['mirror']));
  });
});

/* ---- 4 ---------------------------------------------------------------------- */
// Design 6555018088 §3: each is enforced by both validators.
const ATTACKS = {
  // Within one pay-period state only, that view's packet observations are
  // pointed at another same-role view's packet, and back.
  'same-role swap of two views\' results within one state': head => {
    const [a, b] = resultViews(head).filter(r => r.view && r.view.role === 'past');
    const state = 'period:' + a.view.id + '/lens:today';
    let changed = 0;
    lines(head).forEach((f, n) => {
      if (f[1] !== state || (f[5] !== a.ref && f[5] !== b.ref)) return;
      f[5] = f[5] === a.ref ? b.ref : a.ref; setLine(head, n, f); changed++;
    });
    assert.ok(changed > 0, 'the state observed the view\'s packet');
    return head;
  },
  // A Plan spend observation relabelled to a Budget advice label.
  'cross-page advice reuse': head => {
    const all = lines(head);
    const n = all.findIndex(f => f[0] === 'planSpend' && /^planSpend-advice#\d+\.savingsFunding$/.test(f[3]));
    assert.ok(n >= 0, 'a Plan spend observation');
    const label = all[n][3].split('.')[0];
    const f = all[n]; f[3] = f[3].replace(label, 'budget-advice#1'); f[4] = f[4].split(label).join('budget-advice#1');
    setLine(head, n, f);
    return head;
  },
  // A result#k source pointed at the same view's same result in another state.
  'cross-state result#k repointing': head => {
    const all = lines(head);
    for (let n = 0; n < all.length; n++) {
      const m = /^result#(\d+)$/.exec(all[n][3]);
      if (!m) continue;
      const prior = all[Number(m[1])];
      // The predecessor is now this state's own goals call (r4 R-pass), whose
      // advice label is per state: compare the source with the label erased.
      const role = src => src.replace(/-advice#\d+/, '-advice#N');
      const other = all.findIndex((f, j) => j < n && f[1] !== all[n][1] && f[0] === prior[0] && f[2] === prior[2]
        && role(f[3]) === role(prior[3]) && f[5] === prior[5] && f[6] === 'object' && viewOf(f[4]) === viewOf(prior[4]));
      if (other < 0) continue;
      all[n][3] = 'result#' + other; setLine(head, n, all[n]);
      return head;
    }
    return assert.fail('a pass-through observation with an equivalent observation in another state');
  },
  // A result#k source naming an observation of the same state whose ref
  // differs (the same view when one exists).
  'result#k naming an observation whose ref differs': head => {
    const all = lines(head);
    for (let n = 0; n < all.length; n++) {
      const m = /^result#(\d+)$/.exec(all[n][3]);
      if (!m) continue;
      const prior = all[Number(m[1])];
      const candidates = all.map((f, j) => [f, j]).filter(([f, j]) => j < n && f[0] === all[n][0] && f[1] === all[n][1]
        && f[6] === 'object' && f[5] !== prior[5]);
      if (!candidates.length) continue;
      const pick = candidates.find(([f]) => viewOf(f[4]) === viewOf(all[n][4])) || candidates[0];
      all[n][3] = 'result#' + pick[1]; setLine(head, n, all[n]);
      return head;
    }
    return assert.fail('a pass-through observation with a differently-referenced observation in its state');
  },
};

test('reference attacks are refused by both validators', async t => {
  const mirror = workflowMirror();
  const attacked = [];
  for (const id of ['savings-live-ready', 'savings-estimated-close']) {
    const c = caseData(id);
    assert.equal(Comment.captureEvidenceProblems(c.head, ['']), 0, id + ': the unedited evidence is valid');
    for (const [name, attack] of Object.entries(ATTACKS)) {
      const head = attack({ ...c.head });
      assert.notDeepEqual(head, c.head, name + ' edits the evidence');
      assert.ok(Comment.captureEvidenceProblems(head, ['']) > 0, id + ': the formatter refuses ' + name);
      attacked.push([id, name, head]);
    }
  }
  await t.test('workflow mirror', { skip: mirror.skip }, () => {
    for (const id of ['savings-live-ready', 'savings-estimated-close']) assert.equal(mirror.run(caseData(id).head), 0, id + ': unedited');
    for (const [id, name, head] of attacked) assert.ok(mirror.run(head) > 0, id + ': the mirror refuses ' + name);
  });
});

/* ---- 5 ---------------------------------------------------------------------- */
const anchors = head => Array.from({ length: head['savings.capture.advices'] }, (_, i) => {
  const [label, page, state, funding, current, nviews, top, topNull, topPlan] = head['savings.capture.advice.' + i].split('|');
  const views = Array.from({ length: Number(nviews) }, (_, j) => {
    const [id, role, start, end, byId, byView, rawPacket] = head['savings.capture.advice.' + i + '.view.' + j].split('|');
    return { id, role, start, end, byId, byView, rawPacket };
  });
  return { label, page, state, funding, current, top, topNull, topPlan, views };
});
const topLevel = head => resultViews(head).filter(r => /^v1-/.test(r.cls));

test('S1-S4 validate and exercise their forms (S3 and S4 are perturbations: no frozen-fixture coverage is claimed)', async t => {
  const mirror = workflowMirror();
  await t.test('S1: a historical-pools top-level result (committed invented repro)', () => {
    const { head } = caseData('S1');
    const v1 = topLevel(head);
    assert.ok(v1.length === 1 && v1[0].cls === 'v1-ready', 'one ready top-level result');
    assert.equal(partOf(head, v1[0].k, 'allocationMode'), sha256('s"historical-pools"'));
    assert.ok(!readResult(head, v1[0].k).names.includes('goalAllocation'), 'no goalAllocation outside combined mode');
    assert.equal(Comment.captureEvidenceProblems(head, ['']), 0);
  });
  await t.test('S2: a ready-withheld top-level result without a top-level reason (committed invented repro)', () => {
    const { head } = caseData('S2');
    const v1 = topLevel(head);
    assert.ok(v1.length === 1 && v1[0].cls === 'v1-ready-withheld', 'one ready-withheld top-level result');
    assert.ok(!readResult(head, v1[0].k).names.includes('reason'), 'the withhold sets no top-level reason');
    assert.equal(partOf(head, v1[0].k, 'status'), stringPart('unavailable'));
    assert.equal(head['savings.funding.status'], 'unavailable');
    assert.equal(Comment.captureEvidenceProblems(head, ['']), 0);
  });
  await t.test('S3: a withheld next packet (' + PERTURBATION_LABEL + ')', () => {
    const { head } = caseData('S3');
    const budget = anchors(head).filter(a => a.page === 'budget');
    assert.ok(budget.length > 0);
    for (const a of budget) {
      const next = a.views.find(v => v.role === 'next');
      assert.ok(a.top === 'object' && next && next.byId === 'null', a.state + ': the next view\'s byId anchor is null');
    }
    const nextStates = lines(head).filter(f => /^period:next-pay-period\/lens:/.test(f[1]) && f[3] === 'other-object');
    assert.ok(nextStates.length > 0, 'the next view\'s states read its raw packet');
    assert.ok(nextStates.every(f => f[5] === 'null' && f[6] === 'null'), 'its other-object observations are null');
    const nextStart = budget[0].views.find(v => v.role === 'next').start;
    assert.ok(!resultViews(head).some(r => r.cls === 'v2-packet' && head[rkey(r.k, 'identity')].split('|')[3] === nextStart),
      'no next packet is in the results');
    assert.ok(Object.keys(head).some(k => /^savings\.period\.[^.]+\.publication$/.test(k) && head[k] === 'withheld'),
      'the itemized snapshot withholds a period too (both realms perturbed)');
    assert.equal(Comment.captureEvidenceProblems(head, ['']), 0);
  });
  await t.test('S4: a withheld top-level result (' + PERTURBATION_LABEL + ')', () => {
    const { head } = caseData('S4');
    assert.equal(head['savings.capture.results'], 0, 'no object results at all');
    assert.ok(lines(head).every(f => f[5] === 'null' && f[6] === 'null'), 'every observation is null');
    for (const a of anchors(head)) {
      if (a.page === 'budget') {
        assert.deepEqual([a.top, a.topNull, a.topPlan], ['null', 'null', 'null'], a.state);
        for (const v of a.views) assert.deepEqual([v.byId, v.byView, v.rawPacket], ['null', 'null', 'none'], a.state + ' ' + v.id);
      } else assert.equal(a.topPlan, 'null', a.state);
    }
    assert.equal(head['savings.current.publication'], 'withheld', 'the itemized snapshot withholds too (both realms perturbed)');
    assert.equal(Comment.captureEvidenceProblems(head, ['']), 0);
  });
  await t.test('workflow mirror: S1-S4', { skip: mirror.skip }, () => {
    for (const id of ['S1', 'S2', 'S3', 'S4']) assert.equal(mirror.run(caseData(id).head), 0, id);
  });
});
