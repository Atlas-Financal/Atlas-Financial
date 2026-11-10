'use strict';
// Optional cold-process benchmark. Invented fixture, no provider networking.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
if (process.argv[2] === '--sample') {
  const mode = process.argv[3];
  const F = require('../public/forecast'), O = require('../scripts/provider-observe');
  const OA = require('../scripts/operating-answer'), Live = require('../scripts/live-plan');
  const fixture = require('./fixtures/budget-surface-data');
  const payload = { ...fixture.payload(), tags: [] };
  for (const name of ['node:http','node:https']) require(name).request = () => { throw new Error('unexpected network'); };
  O.loadLiveAccountMap = () => structuredClone(fixture.map);
  O.resolveLiveCredential = async () => ({ token: 'SYNTHETIC-OFFLINE-NOT-A-CREDENTIAL', source: 'env' });
  O.fetchLunchMoneyLive = async () => structuredClone(payload);
  if (mode === 'uncached') OA.createRefreshEvaluation = () => ({ fromRefreshedState: OA.fromRefreshedState });
  const original = F.recommend; let calls = 0, receipt;
  F.recommend = (...args) => { calls++; return original(...args); };
  const start = performance.now();
  Live.applyForServer(fixture.canonical(), { ATLAS_LIVE_OVERLAY: 'live' },
    { onObservation(value) { receipt = value; } }).then(data => {
    const durationMs = performance.now() - start;
    assert.equal(receipt.qualified, true); assert(receipt.evidence);
    assert.equal(calls, mode === 'uncached' ? 2 : 1);
    const digest = require('node:crypto').createHash('sha256').update(JSON.stringify({ data, receipt })).digest('hex');
    console.log(JSON.stringify({ mode, durationMs, forecastCalls: calls, digest }));
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const runs = ['uncached','cached','cached','uncached'].map(mode => {
    const child = spawnSync(process.execPath, [__filename,'--sample',mode],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr || 'benchmark child failed');
    return JSON.parse(child.stdout.trim());
  });
  assert.equal(new Set(runs.map(run => run.digest)).size, 1, 'complete outputs must match across controls');
  const mean = mode => runs.filter(run => run.mode === mode).reduce((sum, run) => sum + run.durationMs, 0) / 2;
  console.log(JSON.stringify({ schema: 'atlas-refresh-evaluation-profile/v1', runtime: process.version,
    input: 'invented budget-surface fixture', coldProcesses: true, runs,
    uncachedMeanMs: mean('uncached'), cachedMeanMs: mean('cached'),
    improvementPercent: (1 - mean('cached') / mean('uncached')) * 100 }, null, 2));
}
