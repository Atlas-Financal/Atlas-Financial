'use strict';
// Boot warm-up (owner grant, Dale, 2026-11-23, #821 7090586736; scripts/live-refresh-warmup.js).
// `node test/test-live-refresh-warmup.js`
//
// Failure it detects: a warm-up that runs with the flag off or more than once per process start; one that retries,
// loops or starts a second provider job beside an open; one whose failure leaves a state an ordinary failed open would
// not; a log line that carries anything but its fixed code and a duration. Release decision: any failure blocks.
//
// Real workers and a loopback provider for the refresh path; the server wiring runs in child processes with the
// refresh entry stubbed. Invented data only (test/fixtures/budget-surface-data.js); no live credential, no provider
// write, no household figure.
const threads = require('node:worker_threads');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

// Count workers before the refresh module captures the constructor.
const workers = [];
const RealWorker = threads.Worker;
threads.Worker = class extends RealWorker {
  constructor(file, options) { super(file, options); const record = { ended: false };
    record.exit = new Promise(resolve => this.once('exit', () => { record.ended = true; resolve(); })); workers.push(record); }
};
const Warmup = require('../scripts/live-refresh-warmup.js');
const Refresh = require('../scripts/server-live-refresh.js');
const Fixture = require('./fixtures/budget-surface-data');
const canonical = Fixture.canonical(), payload = Fixture.payload();
const map = { ...Fixture.map, scope: 'live' };
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = performance.now() + 15000;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error('Synthetic test deadline: ' + label); await pause(10); }
}
const canaries = ['SYNTHETIC-SECRET-CANARY', 'SYNTHETIC-PRIVATE'];
const logs = [];
const log = text => logs.push(text);
const lineShape = text => { const entry = JSON.parse(text);
  return JSON.stringify(Object.keys(entry)) === JSON.stringify(['type', 'outcome', 'ms']) && entry.type === 'live-refresh-warmup'
    && /^[a-z-]+$/.test(entry.outcome) && Number.isSafeInteger(entry.ms) && entry.ms >= 0 && !canaries.some(c => text.includes(c)); };

async function provider() {
  const calls = [], held = [];
  let hold = false, failure = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push(url.pathname);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (failure) return send(503, { error: 'SYNTHETIC-PRIVATE-PROVIDER-ERROR', token: 'SYNTHETIC-SECRET-CANARY' });
    if (url.pathname === '/v2/me') { if (hold) { held.push(res); return; } return send(200, { user_id: 1 }); }
    if (url.pathname === '/v2/plaid_accounts') return send(200, { plaid_accounts: payload.accounts });
    if (url.pathname === '/v2/manual_accounts') return send(200, { manual_accounts: [] });
    if (url.pathname === '/v2/categories') return send(200, { categories: payload.categories });
    if (url.pathname === '/v2/tags') return send(200, { tags: [] });
    if (url.pathname === '/v2/budgets/settings') return send(200, { budget_period_granularity: 'month', budget_period_quantity: 1, budget_period_anchor_date: '2026-01-01' });
    if (url.pathname === '/v2/summary') return send(200, { aligned: false, categories: [] });
    if (url.pathname === '/v2/transactions') {
      const isPending = url.searchParams.get('is_pending') === 'true';
      return send(200, { has_more: false, transactions: payload.transactions.filter(tx => !isPending || tx.is_pending) });
    }
    send(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, base: 'http://127.0.0.1:' + server.address().port + '/v2',
    hold() { hold = true; }, fail(value) { failure = value; },
    release() { hold = false; for (const res of held.splice(0)) if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"user_id":1}'); } },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function environment(base, extra = {}) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
  return { ...env, ATLAS_LIVE_OVERLAY: 'live', LUNCHMONEY_ACCESS_TOKEN: 'SYNTHETIC-SECRET-CANARY', ATLAS_LUNCHMONEY_API_BASE: base,
    ATLAS_LIVE_OVERLAY_NOW: payload.fetchedAt, ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify(map), ...extra };
}
const countMe = mock => mock.calls.filter(call => call === '/v2/me').length;
// The options GET /data.json passes to the refresh (server.js), with its header hook.
const openOptions = () => ({ preferObservation: true, forceRefresh: false, onCheck() {} });
// Real-path child: one fresh process per run, so no observation memory carries between the control and the warm-up.
async function failedThenOpen(useWarmup) {
  const mock = await provider();
  try {
    const env = environment(mock.base, { ATLAS_LIVE_REFRESH_WARMUP: 'on' });
    mock.fail(true);
    let first;
    if (useWarmup) first = await Warmup.start({ env, log: () => {}, serve: options => Refresh.serve(canonical, env, options) });
    else first = await Refresh.serve(canonical, env, openOptions()).then(() => 'served', error => error.code || 'failed');
    const firstCalls = mock.calls.length;
    await pause(500);
    const quiet = mock.calls.length === firstCalls;
    mock.fail(false);
    const next = await Refresh.serve(canonical, env, openOptions()).then(served => 'served-' + (served?.liveOverlay?.applied === true), error => error.code || 'failed');
    return { first, firstCalls, quiet, nextCalls: mock.calls.length - firstCalls, next };
  } finally { await mock.close(); }
}

if (process.env.ATLAS_WARMUP_TEST_REAL) {
  const realLog = console.log;
  console.log = () => {};
  console.error = () => {};
  failedThenOpen(process.env.ATLAS_WARMUP_TEST_REAL === 'warmup')
    .then(result => Promise.all(workers.map(record => record.exit)).then(() => { realLog('WARMUP-CHILD ' + JSON.stringify(result)); process.exit(0); }),
      () => process.exit(1));
// Child mode: start the real server with the refresh entry stubbed, report what the warm-up asked for, then exit.
} else if (process.env.ATLAS_WARMUP_TEST_CHILD) {
  const Refresh = require('../scripts/server-live-refresh.js');
  const calls = [], lines = [];
  const realLog = console.log;
  console.log = (...args) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('{"type":"live-refresh-warmup"')) lines.push(JSON.parse(text)); else realLog(...args);
  };
  const mode = process.env.ATLAS_WARMUP_TEST_CHILD;
  Refresh.serve = (canonical, env, options) => {
    calls.push({ preferObservation: options?.preferObservation === true, forceRefresh: options?.forceRefresh === true,
      hasCanonical: !!canonical && typeof canonical === 'object' });
    if (mode === 'fail') return Promise.reject(Object.assign(new Error('SYNTHETIC-PRIVATE-FAILURE'), { code: 'live-refresh-timeout' }));
    options?.onCheck?.({ source: 'provider', qualified: true });
    return Promise.resolve({ meta: {}, liveOverlay: {} });
  };
  const { startServer } = require('../server.js');
  const env = { SITE_PASSWORD: 'warmup-test-password-1234', SESSION_SECRET: 'warmup-test-session-secret-0123456789abcdef',
    ATLAS_LIVE_OVERLAY: 'live', ...(process.env.ATLAS_WARMUP_TEST_FLAG ? { ATLAS_LIVE_REFRESH_WARMUP: process.env.ATLAS_WARMUP_TEST_FLAG } : {}) };
  (async () => {
    const first = await startServer({ env, port: 0, host: '127.0.0.1' });
    const second = await startServer({ env, port: 0, host: '127.0.0.1' });
    await new Promise(resolve => setTimeout(resolve, 400));
    await first.close(); await second.close();
    realLog('WARMUP-CHILD ' + JSON.stringify({ calls, lines }));
    process.exit(0);
  })().catch(error => { realLog('WARMUP-CHILD-ERROR ' + (error && error.code)); process.exit(1); });
} else if (threads.isMainThread && require.main === module) {
  function child(mode, flag, real) {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [__filename], { cwd: path.resolve(__dirname, '..'),
        env: { PATH: process.env.PATH, ...(real ? { ATLAS_WARMUP_TEST_REAL: real } : { ATLAS_WARMUP_TEST_CHILD: mode }),
          ...(flag ? { ATLAS_WARMUP_TEST_FLAG: flag } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', chunk => { out += chunk; });
      proc.stderr.on('data', chunk => { out += chunk; });
      proc.on('exit', code => {
        const lineText = out.split('\n').find(l => l.startsWith('WARMUP-CHILD '));
        if (code !== 0 || !lineText) return reject(new Error('warm-up child failed: exit ' + code));
        resolve({ ...JSON.parse(lineText.slice('WARMUP-CHILD '.length)), out });
      });
    });
  }

  (async () => {
    console.log('1. The switch and the module');
    {
      let called = 0;
      ok(Warmup.start({ env: { ATLAS_LIVE_OVERLAY: 'live' }, serve: () => { called++; }, log }) === null && called === 0,
        'flag absent: nothing starts and nothing is called');
      for (const value of ['ON', 'true', '1', 'on ']) {
        ok(Warmup.start({ env: { ATLAS_LIVE_OVERLAY: 'live', ATLAS_LIVE_REFRESH_WARMUP: value }, serve: () => { called++; }, log }) === null && called === 0,
          'flag ' + JSON.stringify(value) + ' is not exactly on: nothing starts');
      }
      logs.length = 0;
      ok(await Warmup.start({ env: { ATLAS_LIVE_OVERLAY: 'off', ATLAS_LIVE_REFRESH_WARMUP: 'on' }, serve: () => { called++; }, log }) === 'skipped-not-live'
        && called === 0 && logs.length === 1 && lineShape(logs[0]), 'flag on but not live mode: no refresh, one skip line');
      logs.length = 0;
      ok(await Warmup.start({ env: { ATLAS_LIVE_OVERLAY: 'live', ATLAS_LIVE_REFRESH_WARMUP: 'on' }, composition: 'active', serve: () => { called++; }, log }) === 'skipped-composition'
        && called === 0 && logs.length === 1, 'an active settlement composition is never warmed');
      logs.length = 0;
      let served = 0, retained = 0;
      const outcome = await Warmup.start({ env: { ATLAS_LIVE_OVERLAY: 'live', ATLAS_LIVE_REFRESH_WARMUP: 'on' }, log,
        serve: options => { served++; options.onCheck({ qualified: true }); return Promise.reject(Object.assign(new Error('SYNTHETIC-PRIVATE-X'), { code: 'live-refresh-timeout' })); },
        retain: () => { retained++; } });
      await pause(300);
      ok(outcome === 'live-refresh-timeout' && served === 1 && retained === 0 && logs.length === 1 && lineShape(logs[0]),
        'a failure is one attempt, never retried, nothing retained, one fixed-code line', logs.join(' | '));
      logs.length = 0;
      ok(await Warmup.start({ env: { ATLAS_LIVE_OVERLAY: 'live', ATLAS_LIVE_REFRESH_WARMUP: 'on' }, log,
        serve: () => { throw new Error('SYNTHETIC-PRIVATE-THROW'); } }) === 'failed' && logs.length === 1 && lineShape(logs[0]),
        'a thrown error with no refresh code logs "failed" and none of its text');
    }

    console.log('2. The server: exactly one warm-up per process start, through the open path, only with the flag on');
    {
      const on = await child('ok', 'on');
      ok(on.calls.length === 1, 'flag on: two compositions started in one process make exactly one refresh call', JSON.stringify(on.calls));
      ok(on.calls[0].preferObservation === true && on.calls[0].forceRefresh === false && on.calls[0].hasCanonical,
        "the warm-up passes an ordinary open's options (prefer observation, not forced) and the canonical document");
      ok(on.lines.length === 1 && on.lines[0].outcome === 'qualified' && lineShape(JSON.stringify(on.lines[0])), 'one log line, outcome qualified', JSON.stringify(on.lines));
      const off = await child('ok', null);
      ok(off.calls.length === 0 && off.lines.length === 0, 'flag off: no refresh call and no log line');
      const fail = await child('fail', 'on');
      ok(fail.calls.length === 1 && fail.lines.length === 1 && fail.lines[0].outcome === 'live-refresh-timeout'
        && !canaries.some(c => fail.out.includes(c)), 'a failed warm-up is one call, never retried, and logs no private text', JSON.stringify(fail));
    }

    console.log('3. The real refresh path: an open during the warm-up joins it');
    {
      const mock = await provider();
      try {
        const env = environment(mock.base, { ATLAS_LIVE_REFRESH_WARMUP: 'on' });
        mock.hold();
        logs.length = 0;
        const before = workers.length;
        let retainedServed = null;
        const warm = Warmup.start({ env, log, serve: options => Refresh.serve(canonical, env, options), retain: served => { retainedServed = served; } });
        await until(() => countMe(mock) === 1, 'warm-up reached the provider');
        const open = Refresh.serve(canonical, env, openOptions());
        await pause(100);
        ok(countMe(mock) === 1 && workers.length === before + 1, 'an open during the warm-up starts no second job and no second worker', JSON.stringify({ me: countMe(mock), workers: workers.length - before }));
        mock.release();
        const [outcome, opened] = await Promise.all([warm, open]);
        ok(outcome === 'qualified' && retainedServed && JSON.stringify(opened) === JSON.stringify(retainedServed),
          'both settle on the one job: the open receives what the warm-up retained', outcome);
        ok(countMe(mock) === 1, 'one provider identity read in all');
        ok(logs.length === 1 && lineShape(logs[0]), 'one warm-up line, fixed keys, no figure or secret', logs[0]);
      } finally { await mock.close(); }
    }

    console.log('4. A failed warm-up leaves exactly the state a failed open leaves');
    {
      // Control: a failed ordinary open, then an open. Warm-up: a failed warm-up, then an open. Each in a fresh process.
      const control = await child(null, null, 'open'), warmed = await child(null, null, 'warmup');
      ok(warmed.quiet && control.quiet, 'no provider call follows a failed warm-up (no retry)', JSON.stringify(warmed));
      ok(warmed.firstCalls === control.firstCalls && warmed.nextCalls === control.nextCalls && warmed.next === control.next,
        'the next open after a failed warm-up makes the same provider calls and gets the same result as after a failed open',
        JSON.stringify({ control, warmed }));
      ok(warmed.nextCalls > 0 && warmed.next === 'served-true', 'and that open reaches the provider again and is served applied, as after a failed open');
    }
    await Promise.all(workers.map(record => record.exit));
    console.log(`live refresh warm-up: ${checks} checks passed`);
    process.exit(0);
  })().catch(error => { console.error(error); process.exit(1); });
}
