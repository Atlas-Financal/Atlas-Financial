'use strict';
// Manual offline profile, not a CI timing gate.
// Usage: node test/proofs/refresh-replay-before-after.js /path/to/base-checkout
// Four cold processes run base/head/head/base. Each drives the real observer,
// overlay, refresh-trust, Forecast and source replay, with invented acquisition.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function sample(target, mode) {
  // Block networking before fixture construction or production imports.
  for (const name of ['node:http', 'node:https']) require(name).request = () => {
    throw new Error('Unexpected network in invented refresh profile');
  };
  globalThis.fetch = () => { throw new Error('Unexpected network in invented refresh profile'); };
  const fixture = require('../fixtures/refresh-replay-size-data').build();
  const { data, payload, map } = fixture;
  const counts = { transactions: payload.transactions.length,
    pending: payload.transactions.filter(row => row.is_pending).length,
    recurringRows: payload.transactions.filter(row => row.recurring_id != null).length,
    configuredRecurringRows: payload.transactions.filter(row => row.recurring_id === 88).length,
    distinctDates: new Set(payload.transactions.map(row => row.date)).size,
    historyDays: (Date.parse(payload.transactionWindow.endDate) - Date.parse(payload.transactionWindow.startDate)) / 86400000,
    bills: data.plan.bills.length, debts: data.debts.length,
    obligations: data.plan.obligations.length, income: data.plan.income.length,
    commitments: data.plan.commitments.length };
  assert.deepEqual(counts, { transactions: 1001, pending: 7, recurringRows: 107,
    configuredRecurringRows: 3, distinctDates: 82,
    historyDays: 99, bills: 33, debts: 7, obligations: 8, income: 4, commitments: 17 });
  const F = require(path.join(target, 'public/forecast'));
  const O = require(path.join(target, 'scripts/provider-observe'));
  const Live = require(path.join(target, 'scripts/live-plan'));
  const Timing = require(path.join(target, 'scripts/refresh-stage-timing'));
  O.loadLiveAccountMap = () => structuredClone(map);
  O.resolveLiveCredential = async () => ({ token: 'SYNTHETIC-OFFLINE-NOT-A-CREDENTIAL', source: 'env' });
  O.fetchLunchMoneyLive = async () => structuredClone(payload);
  let forecastCalls = 0, observerCalls = 0, forecastCpuMs = 0, forecastElapsedMs = 0;
  const recommend = F.recommend, observe = O.observe;
  F.recommend = function (...args) {
    forecastCalls++;
    const start = performance.now(), cpuStart = process.cpuUsage();
    try { return recommend.apply(this, args); }
    finally {
      const cpu = process.cpuUsage(cpuStart);
      forecastCpuMs += (cpu.user + cpu.system) / 1000;
      forecastElapsedMs += performance.now() - start;
    }
  };
  O.observe = function (...args) { observerCalls++; return observe.apply(this, args); };
  const before = structuredClone(fixture), inputSha256 = digest(fixture);
  let receipt, stages;
  const start = performance.now(), cpuStart = process.cpuUsage();
  const result = await Timing.run(() => Live.applyForServer(data, { ATLAS_LIVE_OVERLAY: 'live' },
    { onObservation(value) { receipt = value; } }), value => { stages = value; });
  const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
  assert.deepEqual(fixture, before, 'canonical plan and source inputs remain unchanged');
  assert.equal(result.liveOverlay.applied, true);
  assert.equal(receipt.qualified, true);
  assert.equal(observerCalls, 2, 'both independent observations still execute');
  assert.equal(forecastCalls, mode === 'base' ? 2 : 1, 'only identical Forecast input is reused');
  assert.equal(!!receipt.evidence, mode !== 'base', 'complete replay equality now earns retention');
  if (receipt.evidence) {
    assert.equal(receipt.evidence.payload.transactions[20].recurring_id, payload.transactions[20].recurring_id);
  }
  // Evidence retention is the one intentional internal receipt difference.
  // No field is excluded from the served response comparison.
  const { evidence, ...receiptWithoutEvidence } = receipt;
  return { mode, counts, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
    forecastCalls, observerCalls, forecastElapsedMs, forecastCpuMs, stages,
    inputSha256, servedDataSha256: digest(result),
    receiptWithoutEvidenceSha256: digest(receiptWithoutEvidence),
    evidenceRetained: !!evidence };
}

async function main() {
  if (process.argv[2] === '--sample') {
    console.log(JSON.stringify(await sample(path.resolve(process.argv[3]), process.argv[4])));
    return;
  }
  assert(process.argv[2], 'Supply the baseline checkout path');
  const baseline = path.resolve(process.argv[2]);
  assert(fs.existsSync(path.join(baseline, 'scripts/live-plan.js')), 'baseline checkout exists');
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const runs = ['base', 'head', 'head', 'base'].map(mode => {
    const child = spawnSync(process.execPath, [__filename, '--sample', mode === 'base' ? baseline : ROOT, mode],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.status, 0, child.error?.message || child.stderr || 'benchmark child failed');
    return JSON.parse(child.stdout.trim());
  });
  for (const field of ['inputSha256', 'servedDataSha256', 'receiptWithoutEvidenceSha256']) {
    assert.equal(new Set(runs.map(run => run[field])).size, 1, field + ' agrees in all four runs');
  }
  const mean = (mode, field) => runs.filter(run => run.mode === mode)
    .reduce((sum, run) => sum + run[field], 0) / 2;
  console.log(JSON.stringify({ schema: 'atlas-refresh-replay-before-after/v1', runtime: process.version,
    fixture: 'invented household, collection counts matched to 2026-11-13 v2 GET',
    transport: 'invented acquisition, no network or provider wait', coldProcesses: true,
    wholeServedDataEqual: true, excludedServedFields: [],
    receiptDifference: 'evidence is null on base; complete replay earns retention on head', runs,
    baseMeanMs: mean('base', 'elapsedMs'), headMeanMs: mean('head', 'elapsedMs'),
    baseMeanCpuMs: mean('base', 'cpuMs'), headMeanCpuMs: mean('head', 'cpuMs'),
    wallReductionPercent: (1 - mean('head', 'elapsedMs') / mean('base', 'elapsedMs')) * 100,
    cpuReductionPercent: (1 - mean('head', 'cpuMs') / mean('base', 'cpuMs')) * 100 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
