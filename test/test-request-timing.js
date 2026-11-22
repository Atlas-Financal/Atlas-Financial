'use strict';
// Per-request server timing: one closed log line per authenticated request,
// and one start-up line per process, with nothing private in either.
// `node test/test-request-timing.js`
//
// Lead dispatch 2026-11-22 (Dale: the app feels slow; measure before any host
// move). scripts/request-timing.js writes {"type":"atlas-timing",...} to
// stdout for each authenticated page or API request, and server.js writes
// {"type":"atlas-startup",...} once when it is listening.
//
// Failure it detects: a request logged more than once or not at all; an
// unauthenticated request logged; any key beyond the closed set, or a
// non-numeric duration; phases that do not add up to the total; a route,
// query string, header, cookie, token, amount, payee or account name reaching
// the log; a cold flag on anything but the first logged request; no start-up
// line. Release decision: any failure blocks.
//
// Invented data and canary strings only. No household figure enters: the
// served document is a small invented object passed as baseSource.
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PASS = 'timing-test-password-1234';
const SECRET = 'timing-test-session-secret-0123456789';
// Canaries: each must never appear in any log line.
const CANARY = {
  amount: '987654.32', payee: 'CANARY_PAYEE_TIMING', account: 'CANARY_ACCOUNT_TIMING',
  token: 'CANARY_TOKEN_tm_9f2c7a', query: 'CANARY_QUERY_TIMING', path: 'CANARY_PATH_TIMING',
  header: 'CANARY_HEADER_TIMING',
};

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log('  ok ' + name); }

const freePort = () => new Promise(resolve => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const TIMING_KEYS = ['type', 'route', 'method', 'outcome', 'status', 'cold', 'ms', 'served', 'cacheHit', 'phases'];
const PHASE_KEYS = ['preData', 'dataServe', 'dataAttach', 'afterData', 'serialize', 'write', 'unattributed'];
const MS_KEYS = ['total', 'data', 'serialize', 'other'];

// Capture this process's console.log while the in-process app runs.
const captured = [];
const realLog = console.log;
function captureOn() { console.log = (...args) => { captured.push(args.map(String).join(' ')); }; }
function captureOff() { console.log = realLog; }
const timingLines = () => captured.filter(line => line.startsWith('{"type":"atlas-timing"')).map(line => JSON.parse(line));

(async () => {
  console.log('=== per-request server timing ===');
  const RequestTiming = require('../scripts/request-timing.js');
  RequestTiming._resetColdForTests();
  const { createApplication } = require('../server.js');
  // An invented served document carrying the canaries in figure-, payee-
  // and account-shaped places.
  const served = { meta: { asOf: '2026-10-14' }, plan: { opening: { asOf: '2026-10-14' } },
    canaries: { amount: Number(CANARY.amount), payee: CANARY.payee, account: CANARY.account, token: CANARY.token } };
  const app = createApplication({ env: { SITE_PASSWORD: PASS, SESSION_SECRET: SECRET },
    // A 30 ms read, so the data phase is measurably non-zero.
    baseSource: async () => { await new Promise(r => setTimeout(r, 30)); return JSON.parse(JSON.stringify(served)); } });
  const port = await freePort();
  const server = await new Promise(resolve => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + port;
  captureOn();
  try {
    // Unauthenticated: the login page and a gated page are not logged.
    await fetch(base + '/login');
    await fetch(base + '/?' + CANARY.query, { redirect: 'manual' });
    // The one page the gate lets through without a session.
    await (await fetch(base + '/styles.css')).text();
    const before = timingLines().length;
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(PASS) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const loggedAfterLogin = timingLines().length;
    // Authenticated requests, each carrying canaries in query, header and cookie.
    const headers = { cookie: cookie + '; extra=' + CANARY.token, 'x-canary': CANARY.header, authorization: 'Bearer ' + CANARY.token };
    const data = await fetch(base + '/data.json?' + CANARY.query + '=' + CANARY.amount, { headers });
    const body = await data.text();
    const page = await fetch(base + '/', { headers });
    await page.text();
    const unknown = await fetch(base + '/' + CANARY.path + '/' + CANARY.payee, { headers });
    await unknown.text();
    // Let the 'finish' handlers run.
    await new Promise(resolve => setTimeout(resolve, 50));
    captureOff();

    await check('unauthenticated requests write no timing line', () => {
      assert.equal(before, 0, 'the login page, the gated redirect and the public stylesheet are not logged');
      assert.equal(loggedAfterLogin, 0, 'the login POST itself is not logged');
    });
    await check('the served document reached the client (control: the canaries were really in play)', () => {
      assert.equal(data.status, 200);
      assert.ok(body.includes(CANARY.payee) && body.includes(CANARY.amount));
    });
    const lines = timingLines();
    await check('exactly one closed line per authenticated request', () => {
      assert.equal(lines.length, 3, 'data.json, the page and the unknown path');
      for (const line of lines) {
        assert.deepEqual(Object.keys(line), TIMING_KEYS);
        assert.deepEqual(Object.keys(line.ms), MS_KEYS);
        for (const key of MS_KEYS) assert.ok(Number.isSafeInteger(line.ms[key]) && line.ms[key] >= 0, key + ' is a whole non-negative ms');
        assert.deepEqual(Object.keys(line.phases), PHASE_KEYS);
        for (const key of PHASE_KEYS) assert.ok(Number.isSafeInteger(line.phases[key]) && line.phases[key] >= 0, key + ' is a whole non-negative ms');
        const sum = PHASE_KEYS.reduce((n, k) => n + line.phases[k], 0);
        // Each phase is truncated to whole ms: the sum is total within one ms per phase.
        assert.ok(sum <= line.ms.total && line.ms.total - sum < PHASE_KEYS.length, 'phases sum to total within rounding: ' + sum + ' vs ' + line.ms.total);
        assert.equal(line.phases.serialize, line.ms.serialize, 'the serialize phase is the existing serialize field');
        assert.ok(['GET', 'HEAD', 'POST', 'other'].includes(line.method));
        assert.ok(/^[1-5]xx$|^other$/.test(line.status));
        assert.ok(['provider-job', 'joined-job', 'retained', 'replay', 'canonical', 'none'].includes(line.served));
        assert.equal(line.outcome, 'completed');
        assert.equal(typeof line.cold, 'boolean');
        assert.equal(typeof line.cacheHit, 'boolean');
      }
      assert.deepEqual(lines.map(l => l.route), ['/data.json', '/', 'other'], 'routes normalised to the allowlist');
      assert.deepEqual(lines.map(l => l.status), ['2xx', '2xx', '4xx']);
    });
    await check('cold is true only on the first logged request of the process', () => {
      assert.deepEqual(lines.map(l => l.cold), [true, false, false]);
    });
    await check('the data read is timed and its served path named', () => {
      assert.equal(lines[0].served, 'canonical', 'baseSource serves without a live overlay');
      assert.ok(lines[0].ms.data >= 25, 'the 30 ms read is inside the data phase (' + lines[0].ms.data + ')');
      assert.ok(lines[0].ms.total >= lines[0].ms.data);
      assert.equal(lines[0].cacheHit, false);
      assert.equal(lines[1].served, 'none', 'the static page reads no data');
    });
    await check('the phases add up to the total, within rounding', () => {
      for (const l of lines) {
        const sum = l.ms.data + l.ms.serialize + l.ms.other;
        assert.ok(Math.abs(sum - l.ms.total) <= 2, `phases ${sum} vs total ${l.ms.total}`);
      }
    });
    await check('no canary reaches any log line', () => {
      const all = captured.join('\n');
      for (const [kind, value] of Object.entries(CANARY)) assert.ok(!all.includes(value), kind + ' canary absent from the log');
      assert.ok(!all.includes(cookie.split('=')[1]), 'the session cookie value is absent');
      assert.ok(!all.includes(PASS) && !all.includes(SECRET), 'no secret is logged');
    });
    await check('nothing timing-related is sent to the browser', () => {
      assert.equal(data.headers.get('server-timing'), null);
      assert.ok(![...data.headers.keys()].some(k => /timing/i.test(k)));
      assert.ok(!body.includes('atlas-timing'));
    });
  } finally {
    captureOff();
    await new Promise(resolve => server.close(resolve));
  }

  await check('a client that disconnects during the data read never yields a completed 2xx line', async () => {
    RequestTiming._resetColdForTests();
    captured.length = 0;
    let finishRead;
    const slow = createApplication({ env: { SITE_PASSWORD: PASS, SESSION_SECRET: SECRET },
      baseSource: () => new Promise(resolve => { finishRead = () => resolve(JSON.parse(JSON.stringify(served))); }) });
    const slowPort = await freePort();
    const slowServer = await new Promise(resolve => { const s = slow.listen(slowPort, '127.0.0.1', () => resolve(s)); });
    const slowBase = 'http://127.0.0.1:' + slowPort;
    try {
      const login = await fetch(slowBase + '/login', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(PASS) });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      captureOn();
      const abort = new AbortController();
      const pending = fetch(slowBase + '/data.json', { headers: { cookie }, signal: abort.signal }).catch(() => null);
      // Wait until the read has started, then go away mid-read.
      const deadline = Date.now() + 5000;
      while (!finishRead && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      assert.ok(finishRead, 'the read started');
      await new Promise(r => setTimeout(r, 40));
      abort.abort();
      await pending;
      await new Promise(r => setTimeout(r, 80));
      // The read then completes after the client is gone.
      finishRead();
      await new Promise(r => setTimeout(r, 80));
      captureOff();
      const got = timingLines();
      assert.equal(got.length, 1, 'one line for the request');
      assert.equal(got[0].outcome, 'client-closed');
      assert.equal(got[0].status, 'none', 'never a 2xx');
      assert.ok(got[0].ms.data >= 30, 'the open read counts up to the close');
      assert.ok(!got.some(l => l.outcome === 'completed' && l.status === '2xx'));
    } finally {
      captureOff();
      await new Promise(resolve => slowServer.close(resolve));
    }
  });

  await check('the record builder: allowlist, clamping and closed values', () => {
    assert.equal(RequestTiming.routeOf('/index.html'), '/');
    assert.equal(RequestTiming.routeOf('/app.js'), 'static');
    assert.equal(RequestTiming.routeOf('/../secret.js'), 'other');
    assert.equal(RequestTiming.routeOf('/data.json/extra'), 'other');
    assert.equal(RequestTiming.routeOf(undefined), 'other');
    const r = RequestTiming.record({ start: 0n, end: 5000000n, path: '/data.json?x=' + CANARY.query, data: 9000000n,
      serialize: -1n, served: CANARY.payee, cold: 'true' }, 999, 'DELETE', 'completed');
    assert.deepEqual(r, { type: 'atlas-timing', route: 'other', method: 'other', outcome: 'completed', status: 'other', cold: false,
      ms: { total: 5, data: 9, serialize: 0, other: 0 }, served: 'none', cacheHit: false,
      phases: { preData: 0, dataServe: 0, dataAttach: 0, afterData: 0, serialize: 0, write: 0, unattributed: 5 } });
    // Phase split from marks (invented ns): pre-data 1 ms, serve 4, attach 2, after-data 3, serialize 5, write 7.
    const ms = n => BigInt(n) * 1000000n;
    const phased = RequestTiming.record({ start: ms(0), end: ms(22), path: '/data.json', data: ms(6), serialize: ms(5),
      served: 'provider-job', firstDataStart: ms(1), attachStart: ms(5), lastDataEnd: ms(7),
      firstSerializeStart: ms(10), lastSerializeEnd: ms(15) }, 200, 'GET', 'completed');
    assert.deepEqual(phased.phases, { preData: 1, dataServe: 4, dataAttach: 2, afterData: 3, serialize: 5, write: 7, unattributed: 0 });
    assert.deepEqual(phased.ms, { total: 22, data: 6, serialize: 5, other: 11 }, 'the existing fields are unchanged');
    // An open read at close counts up to the close; a closed request never reads 2xx.
    const closed = RequestTiming.record({ start: 0n, end: 8000000n, path: '/data.json', data: 0n, dataOpen: 3000000n,
      serialize: 0n, served: 'provider-job', cold: false }, 200, 'GET', 'client-closed');
    assert.equal(closed.outcome, 'client-closed');
    assert.equal(closed.status, 'none');
    assert.equal(closed.ms.data, 5);
    assert.equal(RequestTiming.record({ start: 0n, end: 1n, path: '/', data: 0n, serialize: 0n, served: 'retained' }, 200, 'GET', 'completed').cacheHit, true);
  });

  await check('the real server writes one atlas-startup line when it is listening', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, PORT: String(port), SITE_PASSWORD: PASS, SESSION_SECRET: SECRET } });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', () => {});
    try {
      const deadline = Date.now() + 20000;
      while (!/"atlas-startup"/.test(out) && Date.now() < deadline && child.exitCode === null) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const lines = out.split('\n').filter(l => l.startsWith('{"type":"atlas-startup"')).map(l => JSON.parse(l));
      assert.equal(lines.length, 1);
      assert.deepEqual(Object.keys(lines[0]), ['type', 'ms']);
      assert.deepEqual(Object.keys(lines[0].ms), ['bootToListen']);
      assert.ok(Number.isSafeInteger(lines[0].ms.bootToListen) && lines[0].ms.bootToListen > 0);
    } finally {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exit;
    }
  });

  console.log(`request timing: ${passed} checks passed`);
})().catch(error => { captureOff(); console.error(error); process.exit(1); });
