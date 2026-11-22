'use strict';
// Browser-side timing beacon, server side: POST /client-timing writes ONE
// closed atlas-client-timing line for a valid body from a signed-in session,
// and nothing otherwise. `node test/test-client-timing.js`
//
// Lead dispatch 2026-11-22 (the NEXT PR named on #1553). scripts/client-timing.js
// checks the body against a strict closed schema; server.js mounts it behind
// the existing session gate with a JSON-only 1 kB parser and a per-session cap.
//
// Failure it detects: an unauthenticated beacon logged; a body that is not
// exactly the schema (extra or missing key, string, fraction, negative,
// nested, array, oversized, wrong content type, compressed) logged or
// answered with anything but a bodyless refusal; an amount, payee, token or
// query in a body reaching the log or the response; more than one line per
// valid beacon; the per-session cap not holding; anything echoed back; the
// CSP changed; the browser module's compute split, its
// once-only beacon, or its no-beacon paths (a throw, an open bracket, no
// fetch timing) wrong. Release decision: any failure blocks.
//
// Invented values and canary strings only; no household data.
const assert = require('node:assert/strict');
const net = require('node:net');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PASS = 'client-timing-test-password-1234';
const SECRET = 'client-timing-test-session-secret-0123456789';
const CANARY = { amount: '987654.32', payee: 'CANARY_PAYEE_CLIENT', token: 'CANARY_TOKEN_ct_4b7e1d', query: 'CANARY_QUERY_CLIENT' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const realLog = console.log;
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; realLog('  ok ' + name); }
const freePort = () => new Promise(resolve => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const captured = [];
const captureOn = () => { console.log = (...args) => { captured.push(args.map(String).join(' ')); }; };
const captureOff = () => { console.log = realLog; };
// Every stdout line counts, of any type (atlas-timing included): this route's
// only write is its one closed line. Lines are counted after the response's
// finish handlers have run.
const settled = () => new Promise(resolve => setTimeout(resolve, 40));
const count = async () => { await settled(); return captured.length; };
const VALID = () => ({ page: 'stack', device: 'desktop', ms: { fetch: 412, compute: 95, render: 140, total: 1210 } });

(async () => {
  console.log('=== browser timing beacon: server side ===');
  const ClientTiming = require('../scripts/client-timing.js');
  const { createApplication } = require('../server.js');
  const app = createApplication({ env: { SITE_PASSWORD: PASS, SESSION_SECRET: SECRET },
    baseSource: async () => ({ meta: { asOf: '2026-10-14' }, plan: { opening: { asOf: '2026-10-14' } } }) });
  const port = await freePort();
  const server = await new Promise(resolve => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + port;
  const signIn = async () => {
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(PASS) });
    return login.headers.get('set-cookie').split(';')[0];
  };
  const post = (cookie, body, headers = {}) => fetch(base + '/client-timing?' + CANARY.query + '=' + CANARY.amount, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  captureOn();
  try {
    await check('an unauthenticated beacon is refused by the existing gate and writes no line', async () => {
      const before = (await count());
      const r = await post(null, VALID());
      // The gate is unchanged: a non-data path without a session is sent to /login.
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/login');
      assert.equal((await count()), before);
      const forged = await post('hfd_session=forged.' + CANARY.token, VALID());
      assert.equal(forged.status, 302);
      assert.equal((await count()), before);
    });

    const cookie = await signIn();
    await check('a valid beacon from a session writes exactly one closed line and echoes nothing', async () => {
      const before = (await count());
      const r = await post(cookie, VALID());
      assert.equal(r.status, 204);
      assert.equal(await r.text(), '');
      assert.equal(r.headers.get('content-security-policy'), CSP, 'the CSP is unchanged');
      const lines = (await count(), captured.slice(before));
      assert.equal(lines.length, 1);
      const line = JSON.parse(lines[0]);
      assert.deepEqual(Object.keys(line), ['type', 'page', 'device', 'ms']);
      assert.deepEqual(line, { type: 'atlas-client-timing', ...VALID() });
      assert.ok(!lines[0].includes(CANARY.query) && !lines[0].includes(CANARY.amount), 'no query in the line');
    });

    // Each refused body: 400, no body, no line.
    const refused = {
      'an extra top-level key (a payee)': { ...VALID(), payee: CANARY.payee },
      'an extra duration key (an amount)': { ...VALID(), ms: { ...VALID().ms, amount: Number(CANARY.amount) } },
      'a token as the page': { ...VALID(), page: CANARY.token },
      'an unknown device': { ...VALID(), device: 'Mozilla/5.0 ' + CANARY.token },
      'an amount as a duration': { ...VALID(), ms: { ...VALID().ms, fetch: Number(CANARY.amount) } },
      'a fractional duration': { ...VALID(), ms: { ...VALID().ms, render: 1.5 } },
      'a negative duration': { ...VALID(), ms: { ...VALID().ms, compute: -1 } },
      'a string duration': { ...VALID(), ms: { ...VALID().ms, total: '1210' } },
      'a missing duration': { page: 'stack', device: 'desktop', ms: { fetch: 1, compute: 1, render: 1 } },
      'a missing page': { device: 'desktop', ms: VALID().ms },
      'a nested object': { ...VALID(), page: { name: 'stack' } },
      'an array body': [VALID()],
      'a null body': null,
      'a __proto__ key': JSON.parse('{"page":"stack","device":"desktop","ms":{"fetch":1,"compute":1,"render":1,"total":1},"__proto__":{"x":1}}'),
    };
    for (const [label, body] of Object.entries(refused)) {
      await check('refused, no line: ' + label, async () => {
        const before = (await count());
        const text = label === 'a __proto__ key'
          ? '{"page":"stack","device":"desktop","ms":{"fetch":1,"compute":1,"render":1,"total":1},"__proto__":{"x":1}}'
          : JSON.stringify(body);
        const r = await post(cookie, text);
        assert.equal(r.status, 400);
        assert.equal(await r.text(), '');
        assert.equal((await count()), before);
      });
    }

    await check('an oversized body, a wrong content type, malformed JSON and a compressed body are refused with no line', async () => {
      const before = (await count());
      const big = { ...VALID(), pad: 'x'.repeat(2048) };
      const r1 = await post(cookie, big);
      assert.equal(r1.status, 400); assert.equal(await r1.text(), '');
      const r2 = await post(cookie, JSON.stringify(VALID()), { 'content-type': 'text/plain' });
      assert.equal(r2.status, 400); assert.equal(await r2.text(), '');
      const r3 = await post(cookie, 'page=stack&device=desktop', { 'content-type': 'application/x-www-form-urlencoded' });
      assert.equal(r3.status, 400); assert.equal(await r3.text(), '');
      const r4 = await post(cookie, '{"page":"stack",' + CANARY.token);
      assert.equal(r4.status, 400); assert.equal(await r4.text(), '');
      const r5 = await post(cookie, zlib.gzipSync(JSON.stringify(VALID())), { 'content-encoding': 'gzip' });
      assert.ok(r5.status === 400 || r5.status === 415, 'compressed body refused (' + r5.status + ')');
      assert.equal((await count()), before);
    });

    await check('no canary reaches any log line', async () => {
      const all = captured.join('\n');
      for (const value of Object.values(CANARY)) assert.ok(!all.includes(value), 'canary in the log: ' + value);
      assert.ok(!all.includes(PASS) && !all.includes(SECRET), 'no password or secret in the log');
    });

    await check('the per-session cap holds, per session', async () => {
      const capped = await signIn();
      const before = await count();
      let accepted = 0, limited = 0;
      for (let i = 0; i < 25; i++) {
        const r = await post(capped, VALID());
        if (r.status === 204) accepted++; else if (r.status === 429) limited++;
        assert.equal(await r.text(), '');
      }
      assert.equal(accepted, 20); assert.equal(limited, 5);
      // 25 requests write exactly 20 lines, all closed client lines: a capped request writes nothing.
      const written = (await count(), captured.slice(before));
      assert.equal(written.length, 20);
      assert.ok(written.every(line => line.startsWith('{"type":"atlas-client-timing"')));
      // Another session still has its own allowance.
      const other = await signIn();
      assert.equal((await post(other, VALID())).status, 204);
    });

    await check('the server timing line is unchanged for other routes and never written for this one', async () => {
      const before = await count();
      const page = await fetch(base + '/', { headers: { cookie } });
      await page.text();
      const pageLines = (await count(), captured.slice(before));
      assert.equal(pageLines.length, 1, 'a page request still writes its one atlas-timing line');
      assert.equal(JSON.parse(pageLines[0]).type, 'atlas-timing');
      assert.ok(!captured.some(line => line.includes('"type":"atlas-timing"') && line.includes('"route":"other"')),
        'no atlas-timing line for any beacon, accepted or refused');
    });

    await check('rateCap: the window resets, and the key table stays bounded', async () => {
      let t = 0;
      const allow = ClientTiming.rateCap({ limit: 2, windowMs: 1000, maxKeys: 3, clock: () => t });
      assert.deepEqual([allow('a'), allow('a'), allow('a')], [true, true, false]);
      t = 1000;
      assert.equal(allow('a'), true, 'a new window');
      for (const key of ['b', 'c', 'd']) allow(key);
      // 'a' was evicted as the oldest when 'd' arrived: it starts a fresh window.
      assert.deepEqual([allow('a'), allow('a')], [true, true]);
    });

    await check('parse accepts exactly the schema at its bounds', async () => {
      const edge = { page: 'budget', device: 'other', ms: { fetch: 0, compute: 0, render: 0, total: ClientTiming.CAP_MS } };
      assert.deepEqual(ClientTiming.parse(edge), { type: 'atlas-client-timing', ...edge });
      assert.equal(ClientTiming.parse({ ...edge, ms: { ...edge.ms, total: ClientTiming.CAP_MS + 1 } }), null);
      for (const device of ['mobile', 'desktop', 'other']) assert.ok(ClientTiming.parse({ ...edge, device }));
      assert.equal(ClientTiming.parse(Object.assign(Object.create(null), edge)), null, 'not a plain object');
    });

    // The browser module (public/client-timing.js) in a VM with a fake
    // clock and a recording fetch: no browser needed.
    const browserModule = fs.readFileSync(path.join(__dirname, '..', 'public', 'client-timing.js'), 'utf8');
    function loadBrowser({ page = 'stack-view' } = {}) {
      const clock = { t: 0 }, sent = [];
      const window = { performance: { now: () => clock.t },
        matchMedia: query => ({ matches: query === '(pointer: fine)' }),
        document: { documentElement: { classList: { contains: name => name === page } } },
        fetch: (url, init) => { sent.push({ url, init }); return Promise.resolve(); } };
      vm.runInNewContext(browserModule, { window, Math, JSON, Error, Promise });
      return { T: window.AtlasClientTiming, clock, sent, window };
    }
    await check('browser module: bracketed compute and the rest of the render split the render time', async () => {
      const b = loadBrowser();
      const T = b.T;
      assert.equal(T.computeStart(), null, 'outside the first render a bracket does nothing');
      T.fetchStart(); b.clock.t += 300; T.fetchEnd();
      let renders = 0;
      T.firstRender(() => {
        renders++; b.clock.t += 20;
        const one = T.computeStart(); b.clock.t += 10; T.computeEnd(one);
        T.computeEnd(one); // a second end of the same bracket counts nothing
        b.clock.t += 4;
        const two = T.computeStart(); b.clock.t += 5; T.computeEnd(two);
        b.clock.t += 3;
      });
      assert.equal(renders, 1);
      assert.equal(b.sent.length, 1);
      assert.equal(b.sent[0].url, '/client-timing');
      assert.equal(b.sent[0].init.method, 'POST');
      assert.equal(b.sent[0].init.credentials, 'same-origin');
      assert.deepEqual(JSON.parse(b.sent[0].init.body), { page: 'stack', device: 'desktop',
        ms: { fetch: 300, compute: 15, render: 27, total: 342 } });
      // A later first-render call (a second load) renders, and sends nothing; brackets do nothing.
      T.firstRender(() => { renders++; assert.equal(T.computeStart(), null); });
      assert.equal(renders, 2); assert.equal(b.sent.length, 1);
    });
    await check('browser module: a render that throws, or a bracket left open, sends nothing', async () => {
      const a = loadBrowser();
      a.T.fetchStart(); a.T.fetchEnd();
      assert.throws(() => a.T.firstRender(() => { a.T.computeStart(); throw new Error('render failed'); }), /render failed/);
      assert.equal(a.sent.length, 0);
      const b = loadBrowser({ page: 'none' });
      b.T.fetchStart(); b.T.fetchEnd();
      b.T.firstRender(() => { try { b.T.computeStart(); throw new Error('caught inside'); } catch (_) { /* a fail-safe */ } });
      assert.equal(b.sent.length, 0, 'compute unknown: no beacon');
    });
    await check('browser module: no fetch timing renders once with no beacon; the page enum reads stack-view', async () => {
      const a = loadBrowser();
      let renders = 0;
      a.T.firstRender(() => { renders++; });
      assert.equal(renders, 1); assert.equal(a.sent.length, 0);
      const b = loadBrowser({ page: 'none' });
      b.T.fetchStart(); b.T.fetchEnd();
      b.T.firstRender(() => {});
      assert.equal(JSON.parse(b.sent[0].init.body).page, 'budget');
    });
  } finally {
    captureOff();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(`client timing beacon: ${passed} checks passed`);
  process.exit(0);
})().catch(error => { captureOff(); console.error(error); process.exit(1); });
