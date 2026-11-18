'use strict';
// ATLAS-069 child driver: a worker-constructor failure on a forced refresh
// must hold replay of the retained observation, exactly like every other
// forced-refresh termination path. server-live-refresh binds
// worker_threads.Worker at require time, so the throwing Worker subclass
// is installed before the module is loaded — the parent suite cannot do
// this in its own process, where the module is already loaded. Prints
// ATLAS069-CONSTRUCTOR-OK and exits 0 on success; exits 1 otherwise.
// Synthetic fixtures only, via the parent suite's exported helpers.
const path = require('node:path');
const assert = require('node:assert/strict');
const threads = require('node:worker_threads');
const RealWorker = threads.Worker;
let failConstruction = false;
threads.Worker = class extends RealWorker {
  constructor(...args) {
    if (failConstruction) throw new Error('synthetic-constructor-failure');
    super(...args);
  }
};
const T = require('./test-server-observation-memory');
const Fixture = require('./fixtures/budget-surface-data');
const Refresh = require('../scripts/server-live-refresh');
const { provider, environment, CLOCK } = T;
const canonical = Fixture.canonical();
const originalNow = Date.now;
Date.now = () => Date.parse(CLOCK);
(async () => {
  const mock = await provider();
  const env = environment(mock.base);
  try {
    await Refresh.serve(canonical, env); // seed qualified evidence
    failConstruction = true;
    await assert.rejects(Refresh.serve(canonical, env, { forceRefresh: true }),
      error => error.code === 'live-refresh-unavailable');
    failConstruction = false;
    const count = mock.calls.length;
    let readCheck;
    await Refresh.serve(canonical, env, { preferObservation: true, onCheck(value) { readCheck = value; } });
    assert.equal(mock.calls.length - count, 10, 'read after constructor failure revalidates live');
    assert.equal(readCheck.source, 'provider', 'read after constructor failure is a provider check');
    console.log('ATLAS069-CONSTRUCTOR-OK');
  } finally {
    Date.now = originalNow;
    await mock.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
