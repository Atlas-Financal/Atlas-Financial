'use strict';
// Capture-on-refresh input shape (#818). Invented finances only.
// Production's inputFor() reads public/periods.json, an OBJECT
// ({ asOf, thisMonth, lastMonth, source, periods, monthly }). The capture seam
// requires `periods` to be the monthly ARRAY, so passing the parsed file made
// every capture fail with history-capture-input-invalid. Earlier tests fed
// `periods: []` directly and never exercised the file shape.
//   S1 inputFor() hands the seam the file's `monthly` array, not the object
//   S2 the real file shape, through inputFor() -> captureOnce() with an
//      in-memory store, records a closing for a fully ended period
//   S3 fail closed: a missing file or a file without a `monthly` array still
//      produces history-capture-input-invalid, never a guessed source
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Capture = require('../scripts/period-history-refresh-capture');
const Observer = require('../scripts/provider-observe');
const { START, END, NEXT, input } = require('./fixtures/private-period-history-input');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-periods-shape-'));
const file = (name, value) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(value)); return f; };
// Same top-level keys and member types as public/periods.json; invented values.
const realShape = () => ({
  asOf: '2030-02-14', thisMonth: '2030-02', lastMonth: '2030-01',
  source: { note: 'invented' }, periods: { 'this-month': { start: '2030-02-01' } },
  monthly: [{ month: '2030-01', categories: {} }, { month: '2030-02', categories: {} }],
});
function observation(day) {
  const raw = input({ day, periodStart: START });
  delete raw.kind; delete raw.periodStart;
  const at = raw.capturedAt; delete raw.capturedAt;
  const env = { [Observer.MAP_JSON_ENV]: JSON.stringify(raw.accountMap) };
  return { canonical: raw.data, payload: raw.payload, env, now: () => new Date(at) };
}
// In-memory store with the two methods captureOnce uses; no database.
async function openDouble() {
  const kept = [];
  return {
    read: async () => kept.map(c => ({ kind: c.content.kind, period: c.content.period })),
    append: async ({ candidate }) => { kept.push(candidate); return { status: 'appended' }; },
  };
}

test('S1 inputFor passes the monthly array, not the periods.json object', () => {
  const o = observation(NEXT);
  const built = Capture.inputFor(o.canonical, o.payload, o.env, { periodsFile: file('real.json', realShape()) });
  assert.ok(Array.isArray(built.periods), 'periods is an array');
  assert.deepEqual(built.periods, realShape().monthly);
});

test('S2 the real file shape records a closing for a fully ended period', async () => {
  const o = observation(NEXT);
  const store = await openDouble();
  const built = Capture.inputFor(o.canonical, o.payload, o.env, { periodsFile: file('real2.json', realShape()) });
  const result = await Capture.captureOnce({ input: built, store, now: o.now });
  assert.equal(result.closing, 'appended', 'closing captured, not history-capture-input-invalid');
  const rows = await store.read();
  assert.deepEqual(rows.filter(r => r.kind === 'closing').map(r => [r.period.start, r.period.end]), [[START, END]]);
});

test('S3 fails closed when the file is missing or has no monthly array', async () => {
  const o = observation(NEXT);
  const store = await openDouble();
  const bad = [
    path.join(dir, 'absent.json'),
    file('array.json', [1, 2]),
    file('nomonthly.json', { ...realShape(), monthly: undefined }),
    file('objmonthly.json', { ...realShape(), monthly: { a: 1 } }),
  ];
  for (const periodsFile of bad) {
    const built = Capture.inputFor(o.canonical, o.payload, o.env, { periodsFile });
    assert.equal(built.periods, null);
    const result = await Capture.captureOnce({ input: built, store, now: o.now });
    assert.equal(result.closing, 'history-capture-input-invalid');
  }
  assert.equal((await store.read()).length, 0, 'nothing recorded');
});
