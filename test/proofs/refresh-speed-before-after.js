'use strict';
// Manual, offline benchmark; timings are evidence, never a CI latency gate.
// Usage: node test/proofs/refresh-speed-before-after.js /path/to/base-checkout
// The same invented input is built before timing each fresh engine. Four cold
// child processes alternate base/head to limit warm-up and run-order bias.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const ROOT = path.resolve(__dirname, '../..');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

if (process.argv[2] === '--sample') {
  const file = path.resolve(process.argv[3], 'public/forecast.js');
  // No provider, credentials, household file or server participates.
  for (const name of ['node:http', 'node:https']) require(name).request = () => {
    throw new Error('Unexpected network in invented benchmark');
  };
  globalThis.fetch = () => { throw new Error('Unexpected network in invented benchmark'); };
  const World = require('../fixtures/held-other-income-search-world');
  const asOf = '2026-11-10';
  const data = World.build({ asOf, walk: true, transactions: 2000, days: 44,
    rebate: { date: '2026-11-12', amount: 200 },
    receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] });
  const options = World.recommendOptions(data);
  const before = digest({ data, options });
  // A fresh engine module for both variants, after the shared fixture builder.
  // Relative dependencies resolve against the selected checkout.
  const engine = new Module(file, module);
  engine.filename = file;
  engine.paths = Module._nodeModulePaths(path.dirname(file));
  engine._compile(fs.readFileSync(file, 'utf8'), file);
  const started = performance.now(), cpuStarted = process.cpuUsage();
  const result = engine.exports.recommend(data.plan, asOf, options);
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStarted);
  assert(result && typeof result === 'object', 'recommendation completes');
  assert.equal(digest({ data, options }), before, 'input is unchanged');
  console.log(JSON.stringify({ elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
    inputSha256: before, outputSha256: digest(result),
    transactions: data.liveOverlay.currentPeriodActuals.transactions.length }));
} else {
  assert(process.argv[2], 'Supply the baseline checkout path');
  const baseline = path.resolve(process.argv[2]);
  assert(fs.existsSync(path.join(baseline, 'public/forecast.js')), 'baseline engine exists');
  const safeEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) safeEnv[key] = process.env[key];
  }
  const runs = ['base', 'head', 'head', 'base'].map(mode => {
    const child = spawnSync(process.execPath, [__filename, '--sample', mode === 'base' ? baseline : ROOT],
      { cwd: ROOT, env: safeEnv, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.status, 0, child.error?.message || child.stderr || 'benchmark child failed');
    return { mode, ...JSON.parse(child.stdout.trim()) };
  });
  assert.equal(new Set(runs.map(run => run.inputSha256)).size, 1, 'identical invented input in every run');
  assert.equal(new Set(runs.map(run => run.outputSha256)).size, 1, 'complete recommendation equality, no excluded fields');
  const mean = (mode, field) => runs.filter(run => run.mode === mode)
    .reduce((sum, run) => sum + run[field], 0) / 2;
  console.log(JSON.stringify({ schema: 'atlas-refresh-speed-before-after/v1', runtime: process.version,
    fixture: 'invented 2000 purchases / 44 days / held income / 2027 payroll walk',
    coldProcesses: true, wholeOutputEqual: true, excludedOutputFields: [], runs,
    baseMeanMs: mean('base', 'elapsedMs'), headMeanMs: mean('head', 'elapsedMs'),
    baseMeanCpuMs: mean('base', 'cpuMs'), headMeanCpuMs: mean('head', 'cpuMs'),
    wallReductionPercent: (1 - mean('head', 'elapsedMs') / mean('base', 'elapsedMs')) * 100,
    cpuReductionPercent: (1 - mean('head', 'cpuMs') / mean('base', 'cpuMs')) * 100 }, null, 2));
}
