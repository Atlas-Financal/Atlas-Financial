'use strict';
// Invented-only before/after proof that one recommend() may derive
// calendarIncomeSections' packet facts (pending/posted twin ids and id
// counts) once per packet. The reference removes only the reuse: no
// recommend() scope is ever opened, so every call derives afresh, exactly
// as before. No production test seam or cache flag.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const World = require('./fixtures/held-other-income-search-world');
const FILE = path.resolve(__dirname, '../public/forecast.js');
const source = fs.readFileSync(FILE, 'utf8');
const OPEN = '    incomeTxFactsDepth++;\n';
const CLOSE = '      incomeTxFactsDepth--;\n';
const DERIVE = '    const facts = { duplicateIds: pendingPostedDuplicateIdSet(packet), idCounts: incomeTxIdCounts(packet) };';
const VALIDATE = 'if (entry && entry.txs === txs && incomeTxFactValuesMatch(entry.values, txs)) return entry.facts;';
for (const anchor of [OPEN, CLOSE, DERIVE, VALIDATE]) {
  assert.equal(source.split(anchor).length, 2, 'exactly one proof anchor');
}
function compile(mode) {
  let code = source;
  if (mode === 'reference') code = code.replace(OPEN, '').replace(CLOSE, '');
  if (mode === 'no-validation') code = code.replace(VALIDATE, 'if (entry) return entry.facts;');
  code = 'let __derived = 0;\n' + code.replace(DERIVE, '    __derived++;\n' + DERIVE);
  code = code.replace('  const Forecast = {', '  const Forecast = {\n'
    + '    __facts: calendarIncomeTxFacts,\n'
    + '    __inScope: fn => { if (incomeTxFactsDepth === 0) incomeTxFactsMemo = new WeakMap(); incomeTxFactsDepth++;'
    + ' try { return fn(); } finally { incomeTxFactsDepth--; if (incomeTxFactsDepth === 0) incomeTxFactsMemo = null; } },\n'
    + '    __fresh: packet => ({ duplicateIds: pendingPostedDuplicateIdSet(packet), idCounts: incomeTxIdCounts(packet) }),\n'
    + '    __resetDerived: () => { __derived = 0; },\n'
    + '    __derived: () => __derived,');
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(code, FILE);
  return mod.exports;
}
const reference = compile('reference'), candidate = compile('candidate'), mutant = compile('no-validation');
const AS_OF = '2026-11-10';
const plain = facts => ({ duplicateIds: [...facts.duplicateIds].sort(), idCounts: [...facts.idCounts].sort() });

// An invented packet with one pending/posted twin, a repeated id, a null row
// and an unrelated purchase. Expected facts are written by hand.
function packet() {
  const row = (id, fields) => ({ id, date: '2026-11-05', atlasAccountId: 'chequing-a', amount: 12.5,
    originalMerchant: 'Invented cafe', pending: false, ...fields });
  return { transactions: [
    row('p1', { pending: true }), row('q1'), row('dup', { originalMerchant: 'Invented grocer' }),
    row('dup', { originalMerchant: 'Invented grocer', amount: 99 }), null,
    row('other', { originalMerchant: 'Invented hardware' }),
  ] };
}
const HAND = { duplicateIds: ['p1', 'q1'], idCounts: [['dup', 2], ['other', 1], ['p1', 1], ['q1', 1]] };
assert.deepStrictEqual(plain(candidate.__fresh(packet())), HAND, 'hand-written facts for the invented packet');

// Outside recommend() nothing is reused.
let p = packet();
const outA = candidate.__facts(p), outB = candidate.__facts(p);
assert.notEqual(outA, outB, 'outside recommend(): derived on every call');
console.log('PASS outside recommend() every call derives');

// Inside one scope: reused while unchanged; every edit in place derives afresh.
const edits = [
  ['flip pending on the twin', t => { t.transactions[0].pending = false; }],
  ['settle the twin by treatment', t => { t.transactions[0].pendingTreatment = 'confirmed-settled'; }],
  ['change an amount', t => { t.transactions[1].amount = 12.51; }],
  ['change a merchant', t => { t.transactions[1].originalMerchant = 'Invented bakery'; }],
  ['merchant from displayed payee', t => { t.transactions[1].originalMerchant = null; t.transactions[1].displayedPayee = 'Invented cafe'; }],
  ['change an account', t => { t.transactions[1].atlasAccountId = 'chequing-b'; }],
  ['change a date', t => { t.transactions[1].date = '2026-11-06'; }],
  ['change an id', t => { t.transactions[2].id = 'solo'; }],
  ['flag a row', t => { t.transactions[5].pendingPostedDuplicate = true; }],
  ['append a row', t => { t.transactions.push({ id: 'q1', date: '2026-11-05', atlasAccountId: 'chequing-a', amount: 12.5, originalMerchant: 'Invented cafe' }); }],
  ['remove a row', t => { t.transactions.splice(1, 1); }],
  ['replace a row object', t => { t.transactions[5] = { ...t.transactions[5], id: 'renamed' }; }],
  ['replace the array', t => { t.transactions = t.transactions.slice(0, 2); }],
  ['fill the null row', t => { t.transactions[4] = { id: 'late', date: '2026-11-05', atlasAccountId: 'chequing-a', amount: 3, payee: 'Invented kiosk' }; }],
];
let teeth = 0;
for (const [label, edit] of edits) {
  const t = packet(), before = plain(candidate.__fresh(t));
  candidate.__resetDerived();
  const after = candidate.__inScope(() => {
    const first = candidate.__facts(t);
    assert.equal(candidate.__facts(t), first, label + ': unchanged packet reuses its facts');
    assert.equal(candidate.__derived(), 1, label + ': derived once while unchanged');
    edit(t);
    const next = candidate.__facts(t);
    assert.equal(candidate.__derived(), 2, label + ': the edit in place derives afresh');
    return plain(next);
  });
  const fresh = plain(candidate.__fresh(t));
  assert.deepStrictEqual(after, fresh, label + ': facts after the edit equal a fresh derivation');
  if (JSON.stringify(fresh) !== JSON.stringify(before)) {
    const m = packet();
    const stale = mutant.__inScope(() => { mutant.__facts(m); edit(m); return plain(mutant.__facts(m)); });
    assert.notDeepStrictEqual(stale, fresh, 'teeth (' + label + '): without validation the stale facts would be served');
    teeth++;
  }
  console.log('PASS edit in place derives afresh: ' + label);
}
assert.ok(teeth >= 10, 'teeth: at least ten edits change the facts (' + teeth + ')');

// A field that is not a plain value is never memoised.
const odd = packet();
odd.transactions[1].originalMerchant = { toString: () => 'Invented cafe' };
candidate.__inScope(() => {
  assert.notEqual(candidate.__facts(odd), candidate.__facts(odd), 'object-valued field: derived on every call');
});
console.log('PASS non-plain field is never reused');

// Complete recommendation equality in the invented worlds the hold-set
// proofs use, with no field excluded, and fewer derivations.
const HELD = { rebate: { date: '2026-11-12', amount: 200 }, receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] };
const worlds = [
  ['held, repeated purchase dates', { ...HELD, transactions: 120, days: 30 }],
  ['held with payroll walk', { ...HELD, walk: true, transactions: 268, days: 44 }],
  ['exact receipt settles expectation', { transactions: 80, days: 30,
    rebate: { date: '2026-11-07', amount: 200 }, receipts: [{ id: 'exact', date: '2026-11-07', amount: 200 }] }],
  ['no unlinked receipt', { transactions: 80, days: 30, rebate: HELD.rebate }],
];
for (const [label, options] of worlds) {
  const data = World.build(options), untouched = structuredClone(data);
  reference.__resetDerived();
  const before = reference.recommend(data.plan, AS_OF, World.recommendOptions(data));
  const beforeDerived = reference.__derived();
  candidate.__resetDerived();
  const after = candidate.recommend(data.plan, AS_OF, World.recommendOptions(data));
  const afterDerived = candidate.__derived();
  assert.deepStrictEqual(after, before, label + ': complete recommendation unchanged');
  assert.deepStrictEqual(data, untouched, label + ': inputs unchanged');
  assert.ok(afterDerived < beforeDerived, label + ': fewer derivations');
  // A second recommend() starts from nothing: no state survives the first.
  candidate.__resetDerived();
  assert.deepStrictEqual(candidate.recommend(data.plan, AS_OF, World.recommendOptions(data)), before,
    label + ': a later recommend() is unchanged');
  assert.equal(candidate.__derived(), afterDerived, label + ': a later recommend() derives the same number of times');
  console.log('PASS complete recommendation: ' + label + ' (' + beforeDerived + ' -> ' + afterDerived + ' derivations)');
}
console.log('ALL CHECKS PASSED');
