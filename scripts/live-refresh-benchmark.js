// Offline fresh-provider CPU benchmark, using the same applyForServer call as the worker.
// node scripts/live-refresh-benchmark.js                 # five cold processes per case
// node --cpu-prof --cpu-prof-dir=/tmp scripts/live-refresh-benchmark.js --sample history
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Budget = require('../test/fixtures/budget-surface-data');
const Cards = require('../test/fixtures/cardcov-probe-data');
const Live = require('./live-plan');
const Observer = require('./provider-observe');
const Forecast = require('../public/forecast');
const Timing = require('./refresh-stage-timing');

const CASE_NAMES = ['budget', 'cards', 'history'];
function buildCase(name) {
  if (!CASE_NAMES.includes(name)) throw new Error('Unknown benchmark case');
  if (name === 'budget') return { data: Budget.canonical(), payload: { ...Budget.payload(), tags: [] },
    identity: Budget.identity, accountMap: Budget.map, periods: null };
  const input = Cards.build();
  if (name === 'history') {
    // Keep the full-size plan and its current pay-period spend. Add a quarter of
    // historical, posted provider activity distributed across the mapped accounts.
    const { transactions, transactionWindow } = input.payload;
    const start = Date.parse(transactionWindow.startDate);
    for (let i = 0; i < 3000; i++) {
      const template = transactions[1 + i % 140];
      const date = new Date(start - (1 + i % 90) * 86400000).toISOString().slice(0, 10);
      transactions.push({ ...template, id: 100000 + i, date });
    }
    transactionWindow.startDate = new Date(start - 90 * 86400000).toISOString().slice(0, 10);
  }
  return input;
}

const cpuMs = usage => (usage.user + usage.system) / 1000;

// Process-local substitutions only. Use in a dedicated process, one case at a time.
async function runCase(input) {
  if (typeof input === 'string') input = buildCase(input);
  const periodsFile = path.resolve(__dirname, '../public/periods.json');
  const identityFile = path.resolve(__dirname, '../docs/connectivity/transaction-identity.json');
  const jsonFiles = new Map([[periodsFile, JSON.stringify(input.periods)], [identityFile, JSON.stringify(input.identity)]]);
  const restore = [];
  function replace(target, key, fn) {
    const original = target[key];
    target[key] = fn(original);
    restore.push(() => { target[key] = original; });
  }
  let forecast, publication;
  const stages = {};
  try {
    replace(fs, 'readFileSync', original => function(file, ...args) {
      if (jsonFiles.has(file)) return jsonFiles.get(file);
      if (typeof file === 'string' && /\.(json|csv)$/i.test(file)) throw new Error('Unexpected benchmark data file');
      return original.call(this, file, ...args);
    });
    replace(Observer, 'resolveLiveCredential', () => async () => ({ source: 'env', token: 'invented' }));
    replace(Observer, 'loadLiveAccountMap', () => () => input.accountMap);
    replace(Observer, 'fetchLunchMoneyLive', () => async () => input.payload);
    replace(Forecast, 'recommend', original => (...args) => {
      forecast = original(...args);
      return forecast;
    });
    // Include both primary and replay stages, as the production log does.
    replace(Timing, 'sync', original => (key, compute) => {
      const start = performance.now(), cpu = process.cpuUsage();
      try { return original(key, compute); }
      finally {
        const stage = stages[key] ||= { cpuMs: 0, wallMs: 0 };
        stage.cpuMs += cpuMs(process.cpuUsage(cpu));
        stage.wallMs += performance.now() - start;
      }
    });
    const env = { ATLAS_LIVE_OVERLAY: 'live', ATLAS_LIVE_OVERLAY_NOW: input.payload.fetchedAt,
      [Observer.API_BASE_ENV]: 'http://127.0.0.1' };
    const start = performance.now(), cpu = process.cpuUsage();
    const data = await Live.applyForServer(input.data, env, { onObservation(check) { publication = check; } });
    const totalCpu = cpuMs(process.cpuUsage(cpu)), totalWall = performance.now() - start;
    if (!data.liveOverlay?.applied || !publication?.qualified || !publication.evidence || !forecast) {
      throw new Error('Expected a qualified live refresh with a Forecast and replay evidence');
    }
    return { data, forecast, stages, cpuMs: totalCpu, wallMs: totalWall };
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}

async function main(args) {
  if (args[0] === '--sample' && args.length === 2) {
    const input = buildCase(args[1]);
    const { stages, cpuMs, wallMs } = await runCase(input);
    console.log(JSON.stringify({ transactions: input.payload.transactions.length, stages, total: { cpuMs, wallMs } }));
    return;
  }
  if (args.length) throw new Error('Usage: live-refresh-benchmark.js [--sample budget|cards|history]');
  const median = values => values.sort((a, b) => a - b)[2];
  const rows = [];
  for (const name of CASE_NAMES) {
    const samples = Array.from({ length: 5 }, () => JSON.parse(execFileSync(process.execPath,
      [__filename, '--sample', name], { encoding: 'utf8' })));
    for (const key of ['normalizeMs', 'overlayMs', 'forecastMs', 'sourceReplayMs', 'total']) {
      const times = samples.map(sample => key === 'total' ? sample.total : sample.stages[key]);
      rows.push({ case: name, transactions: samples[0].transactions, stage: key,
        cpuMs: Math.round(median(times.map(time => time.cpuMs))), wallMs: Math.round(median(times.map(time => time.wallMs))) });
    }
  }
  console.log('Median of 5 fresh processes. Forecast is inside overlay. Replay overlaps normalize and overlay.');
  console.table(rows);
}
module.exports = { CASE_NAMES, buildCase, runCase };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
