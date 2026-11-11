'use strict';
// Capture-on-refresh input shape (#818). Invented finances only.
// Production's inputFor() reads public/periods.json, an OBJECT
// ({ asOf, thisMonth, lastMonth, source, periods, monthly }), and the served
// path (operating-answer.js recommendOpts) gives Forecast exactly that object.
// The capture gates required an ARRAY, so every capture failed with
// history-capture-input-invalid; earlier tests passed `periods: []` directly.
//   S1 the real file shape, through inputFor() -> captureOnce() with an
//      in-memory store, records a closing for a fully ended period
//   S2 page equivalence: the stored closing equals what Forecast computes for
//      the same inputs with the same periods object, and the object itself is
//      what Forecast received
//   S3 fail closed: a missing file, a non-object, or an object without an
//      array `monthly` is history-capture-input-invalid; an empty array (the
//      legacy "no monthly source") is still accepted
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Capture = require('../scripts/period-history-refresh-capture');
const Observer = require('../scripts/provider-observe');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');
const Forecast = require('../public/forecast');
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

test('S1 the real file shape records a closing for a fully ended period', async () => {
  const o = observation(NEXT);
  const store = await openDouble();
  const built = Capture.inputFor(o.canonical, o.payload, o.env, { periodsFile: file('real.json', realShape()) });
  assert.deepEqual(built.periods, realShape(), 'inputFor passes the parsed file, the object the served path gives Forecast');
  const result = await Capture.captureOnce({ input: built, store, now: o.now });
  assert.equal(result.closing, 'appended', 'closing captured, not history-capture-input-invalid');
  const rows = await store.read();
  assert.deepEqual(rows.filter(r => r.kind === 'closing').map(r => [r.period.start, r.period.end]), [[START, END]]);
});

test('S2 page equivalence: the stored closing equals Forecast on the same periods object', async () => {
  const o = observation(NEXT);
  const shape = realShape();
  const built = Capture.inputFor(o.canonical, o.payload, o.env, { periodsFile: file('real3.json', shape) });
  const kept = [];
  const store = { read: async () => [], append: async ({ candidate }) => { kept.push(candidate); return { status: 'appended' }; } };
  await Capture.captureOnce({ input: built, store, now: o.now });
  const closing = kept.find(c => c.content.kind === 'closing');
  assert.ok(closing, 'a closing was captured');
  // Independent expectation: what the served path computes for these inputs,
  // with the periods object the page and operating-answer give Forecast.
  const live = Live.fromObservation({ data: built.data, payload: built.payload, accountMap: built.accountMap,
    identity: built.identity, periods: shape });
  const asOf = Operating.asOfFrom(live.data, {});
  const served = Forecast.recommend(live.data.plan, asOf, { ...Operating.recommendOpts(live.data, {}), periods: shape });
  const view = served.payPeriodViews.find(p => p.start === START && p.end === END);
  assert.ok(view, 'the served Forecast has the closed period');
  assert.deepEqual(closing.content.publication, JSON.parse(JSON.stringify(view)), 'stored close equals the served publication');
  assert.deepEqual(closing.content.evidence.forecastOptions.periods, shape, 'Forecast received the same periods object');
});

test('S3 fails closed on a missing file or a shape without an array monthly', async () => {
  const o = observation(NEXT);
  const store = await openDouble();
  const bad = [
    path.join(dir, 'absent.json'),
    file('nonempty-array.json', [1, 2]),
    file('nomonthly.json', { ...realShape(), monthly: undefined }),
    file('objmonthly.json', { ...realShape(), monthly: { a: 1 } }),
    file('string.json', 'periods'),
  ];
  for (const periodsFile of bad) {
    const built = Capture.inputFor(o.canonical, o.payload, o.env, { periodsFile });
    const result = await Capture.captureOnce({ input: built, store, now: o.now });
    assert.equal(result.closing, 'history-capture-input-invalid', periodsFile);
  }
  assert.equal((await store.read()).length, 0, 'nothing recorded');
  // Legacy callers that supply no monthly source pass an empty array.
  const legacy = Capture.inputFor(o.canonical, o.payload, o.env, { periodsFile: file('empty.json', []) });
  assert.equal((await Capture.captureOnce({ input: legacy, store, now: o.now })).closing, 'appended');
});
