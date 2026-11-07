'use strict';
// Read side of the period-history archive (#818). Invented records only.
//   R1 off by default: no store contact, the document is unchanged
//   R2 first attach serves nothing and starts one background read; the next
//      attach carries the records, minimal fields only
//   R3 a failed, hanging or throwing store never throws, never delays and
//      leaves the document as it would be without history
//   R4 reads are cached for REFRESH_MS and refreshed in the background
const assert = require('node:assert/strict');
const Read = require('../scripts/period-history-read');

const ON = { [Read.FLAG]: 'on' };
const record = (kind, start, end, extra = {}) => ({
  schema: 'atlas-private-period-history-projection/v1', sourceSchema: 'atlas-private-period-history/v2',
  captureId: 'c'.repeat(64), capturedAt: end + 'T19:00:00.000Z', contentKey: 'k'.repeat(64), sequence: 1,
  previousRevision: null, baselineRevision: null, revisionId: kind[0].repeat(64),
  content: { period: { start, end, timezone: 'America/Vancouver' }, kind, asOf: end, declaredAt: null, effectiveFrom: null,
    reason: null, planBasis: 'see-baseline-revision', engine: { commit: 'a'.repeat(40), filesFingerprint: 'f'.repeat(64) },
    provenance: { provider: 'lunchmoney', fetchedAt: end + 'T18:00:00.000Z', sourceFingerprint: 's'.repeat(64),
      policyFingerprint: 'p'.repeat(64), accountMapFingerprint: 'm'.repeat(64), identityFingerprint: 'i'.repeat(64),
      transactionWindow: null, pendingCoverage: null },
    sourceCompleteness: { status: 'complete', reasons: [] }, closingState: 'complete-at-capture',
    cutoff: { rule: 'household-day', end, tz: 'America/Vancouver' },
    publication: { start, end, balanceAfterDeductions: 1000, balanceAfterDeductionsTrust: null } },
  ...extra,
});
const ROWS = [record('closing', '2026-09-25', '2026-10-08'), record('first-observed', '2026-10-09', '2026-10-22')];
function storeOf(rows, { fail, hang } = {}) {
  const calls = { open: 0, read: 0, retire: 0 };
  const open = async () => {
    calls.open++;
    if (fail === 'open') { const e = new Error('history-store-unavailable'); e.code = e.message; throw e; }
    if (hang) await new Promise(() => {});
    return {
      async read(opts) {
        calls.read++;
        if (fail === 'read') throw new Error('PRIVATE-DRIVER-TEXT');
        if (!opts) return rows.map(r => ({ revisionId: r.revisionId, kind: r.content.kind, period: r.content.period }));
        return rows.find(r => r.revisionId === opts.revisionId);
      },
      async retire() { calls.retire++; },
    };
  };
  return { open, calls };
}
const settle = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };

(async () => {
  // R1
  for (const env of [{}, { [Read.FLAG]: 'ON' }, { [Read.FLAG]: 'true' }]) {
    const s = storeOf(ROWS), r = Read.create({ env, openStore: s.open, log: () => {} });
    const doc = { meta: { asOf: '2026-10-14' } };
    ok(r.withHistory(doc) === doc && s.calls.open === 0, 'off: unchanged document, no store contact');
  }

  // R2 + R4
  let now = 0;
  const s = storeOf(ROWS), lines = [];
  const r = Read.create({ env: ON, openStore: s.open, clock: () => now, log: line => lines.push(JSON.parse(line)) });
  const doc = { meta: { asOf: '2026-10-14' } };
  const first = r.withHistory(doc);
  ok(first === doc && !('periodHistory' in first), 'first attach serves without history');
  ok(s.calls.open === 1, 'one background read starts');
  await settle(); await settle();
  const second = r.withHistory(doc);
  ok(Array.isArray(second.periodHistory) && second.periodHistory.length === 2, 'next attach carries the records');
  ok(!('periodHistory' in doc), 'the input document is not mutated');
  const sent = second.periodHistory[0];
  ok(JSON.stringify(Object.keys(sent)) === JSON.stringify(['schema', 'capturedAt', 'content'])
    && JSON.stringify(Object.keys(sent.content)) === JSON.stringify(['period', 'kind', 'asOf', 'closingState', 'planBasis', 'provenance', 'publication'])
    && JSON.stringify(sent.content.provenance) === JSON.stringify({ policyFingerprint: 'p'.repeat(64) }),
  'only the reprinted fields leave the archive');
  ok(!JSON.stringify(second.periodHistory).includes('s'.repeat(64)) && !JSON.stringify(second.periodHistory).includes('a'.repeat(40)),
    'source fingerprints and engine identity stay in the archive');
  ok(s.calls.retire === 1, 'the read session is retired');
  r.withHistory(doc); r.withHistory(doc);
  ok(s.calls.open === 1, 'cached within REFRESH_MS');
  now += Read.REFRESH_MS;
  ok(Array.isArray(r.withHistory(doc).periodHistory), 'a stale cache is still served while refreshing');
  ok(s.calls.open === 2, 'a stale cache starts one background refresh');
  ok(lines.every(line => Object.keys(line).join() === 'type,outcome,records'), 'fixed log fields only');

  // R3
  for (const mode of [{ fail: 'open' }, { fail: 'read' }, { hang: true }]) {
    const b = storeOf(ROWS, mode), log = [];
    const reader = Read.create({ env: ON, openStore: b.open, log: line => log.push(line) });
    const started = process.hrtime.bigint();
    const out = reader.withHistory(doc);
    ok(Number(process.hrtime.bigint() - started) / 1e6 < 50, JSON.stringify(mode) + ': attach does not wait');
    await settle(); await settle();
    const after = reader.withHistory(doc);
    ok(out === doc && after === doc, JSON.stringify(mode) + ': served exactly as without history');
    ok(!log.join('').includes('PRIVATE'), JSON.stringify(mode) + ': no driver text logged');
  }
  const throwing = Read.create({ env: ON, openStore: () => { throw new Error('PRIVATE'); }, log: () => {} });
  ok(throwing.withHistory(doc) === doc, 'a throwing opener never throws');
  ok(Read.create({ env: ON, openStore: storeOf(ROWS).open, log: () => {} }).withHistory(null) === null, 'a non-object passes through');

  console.log('PASS period-history read side: ' + checks + ' checks');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
