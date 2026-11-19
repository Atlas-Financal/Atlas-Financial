'use strict';
/* Response compression on the allowlisted page and data responses.
 *
 * Failure this detects: a page or data response that decodes to different
 * bytes than the uncompressed one (a figure the household reads would
 * change), a compressed or re-headered auth, session, assistant, OAuth,
 * settlement, health or error response, a security header lost or changed by
 * compression, or a missing Vary: Accept-Encoding that lets a cache serve one
 * encoding to a client that asked for another. Release decision: any failure
 * blocks the compression change from merging.
 *
 * Part 1 drives the middleware directly in a small Express app (invented
 * bodies), so every predicate is exercised at sizes above the threshold.
 * Part 2 boots the real server.js as a child process with synthetic
 * credentials (the server-seam pattern) and compares each response with its
 * identity-encoded twin. No production secret or household data is used.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');
const { compressAllowlisted, negotiate, MIN_BYTES } = require('../scripts/response-compression.js');

const ROOT = path.join(__dirname, '..');
const PASS = ['synthetic', 'site', 'password'].join('-');
const SECRET = ['synthetic', 'session', 'secret', '0123456789'].join('-');
const SECURITY_HEADERS = [
  'x-robots-tag', 'cache-control', 'x-content-type-options', 'x-frame-options',
  'referrer-policy', 'strict-transport-security', 'content-security-policy',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      server.close(err => (err ? reject(err) : resolve(p)));
    });
    server.on('error', reject);
  });
}

function request(port, { method = 'GET', path: p, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function decode(r) {
  const coding = r.headers['content-encoding'];
  if (coding === 'br') return zlib.brotliDecompressSync(r.raw);
  if (coding === 'gzip') return zlib.gunzipSync(r.raw);
  assert.equal(coding, undefined, `unexpected coding ${coding}`);
  return r.raw;
}

function varies(r) {
  return String(r.headers.vary || '').split(',').map(s => s.trim().toLowerCase()).includes('accept-encoding');
}

/* ------------------------------ negotiation ------------------------------ */

test('Accept-Encoding negotiation: br preferred, gzip fallback, q=0 refuses, * covers the rest', () => {
  const cases = [
    [undefined, null], ['', null], ['identity', null], ['deflate', null],
    ['gzip', 'gzip'], ['br', 'br'], ['gzip, deflate, br', 'br'], ['br, gzip', 'br'],
    ['br;q=0, gzip', 'gzip'], ['gzip;q=0, br;q=0', null], ['gzip;q=0', null],
    ['*', 'br'], ['*;q=0', null], ['*, br;q=0', 'gzip'], ['gzip;q=1, br;q=0.5', 'gzip'],
    ['BR', 'br'], [' gzip ; q=0.8 ', 'gzip'], ['br;q=abc, gzip', 'gzip'],
  ];
  for (const [header, expected] of cases) {
    assert.equal(negotiate(header), expected, `Accept-Encoding ${JSON.stringify(header)}`);
  }
});

/* --------------------------- middleware, direct --------------------------- */

const BIG_JSON = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i, label: `invented row ${i}` })) });
const BIG_TEXT = 'invented body line\n'.repeat(400);
assert.ok(Buffer.byteLength(BIG_JSON) > 4 * MIN_BYTES && Buffer.byteLength(BIG_TEXT) > 4 * MIN_BYTES);

let mini = null;
let miniPort = 0;
before(async () => {
  const app = express();
  app.use(compressAllowlisted);
  app.get('/data.json', (req, res) => {
    if (req.query.mode === 'unauthorised') return res.status(401).type('json').send(BIG_JSON);
    if (req.query.mode === 'error') return res.status(503).type('json').send(BIG_JSON);
    if (req.query.mode === 'cookie') { res.cookie('invented', 'value'); return res.json(JSON.parse(BIG_JSON)); }
    if (req.query.mode === 'encoded') { res.set('Content-Encoding', 'identity'); return res.type('json').send(BIG_JSON); }
    if (req.query.mode === 'small') return res.json({ ok: true });
    if (req.query.mode === 'stream') {
      res.type('json');
      res.write(BIG_JSON.slice(0, 1000));
      res.write(Buffer.from(BIG_JSON.slice(1000, 3000)));
      return res.end(BIG_JSON.slice(3000));
    }
    return res.json(JSON.parse(BIG_JSON));
  });
  app.get('/', (_req, res) => res.type('html').end(BIG_TEXT));
  app.get('/redirect.html', (_req, res) => res.status(302).set('Location', '/').type('html').send(BIG_TEXT));
  for (const p of ['/login', '/logout', '/healthz', '/assistant/current', '/assistant/mcp',
    '/settlement/evidence.json', '/.well-known/oauth-protected-resource', '/login.html', '/assistant/x.js']) {
    app.all(p, (_req, res) => res.type('json').send(BIG_JSON));
  }
  app.get('/image.png', (_req, res) => res.type('png').send(Buffer.alloc(8192, 7)));
  app.get('/app.js', (_req, res) => res.type('js').send(BIG_TEXT));
  app.post('/data.json', (_req, res) => res.type('json').send(BIG_JSON));
  miniPort = await freePort();
  await new Promise(resolve => { mini = app.listen(miniPort, '127.0.0.1', resolve); });
});
after(() => { if (mini) mini.close(); });

const AE = { 'accept-encoding': 'br, gzip' };

test('direct: allowlisted 200 compresses with br, falls back to gzip, and decodes byte-identically', async () => {
  for (const p of ['/data.json', '/', '/app.js', '/data.json?mode=stream']) {
    const plain = await request(miniPort, { path: p });
    const br = await request(miniPort, { path: p, headers: AE });
    const gz = await request(miniPort, { path: p, headers: { 'accept-encoding': 'gzip' } });
    assert.equal(plain.headers['content-encoding'], undefined, `${p}: identity without Accept-Encoding`);
    assert.equal(br.headers['content-encoding'], 'br', `${p}: br`);
    assert.equal(gz.headers['content-encoding'], 'gzip', `${p}: gzip`);
    assert.ok(decode(br).equals(plain.raw), `${p}: br decodes to the identity bytes`);
    assert.ok(decode(gz).equals(plain.raw), `${p}: gzip decodes to the identity bytes`);
    assert.equal(Number(br.headers['content-length']), br.raw.length, `${p}: Content-Length is the encoded length`);
    assert.ok(br.raw.length < plain.raw.length, `${p}: smaller`);
    for (const r of [plain, br, gz]) assert.ok(varies(r), `${p}: Vary: Accept-Encoding on every allowlisted 200`);
  }
});

test('direct: a non-200, a cookie, an existing Content-Encoding, a small body or a binary type is never compressed', async () => {
  const cases = [
    ['/data.json?mode=unauthorised', 401, false],
    ['/data.json?mode=error', 503, false],
    ['/redirect.html', 302, false],
    ['/data.json?mode=cookie', 200, true],
    ['/data.json?mode=encoded', 200, true],
    ['/data.json?mode=small', 200, true],
    ['/image.png', 200, false],
  ];
  for (const [p, status, vary] of cases) {
    const plain = await request(miniPort, { path: p });
    const asked = await request(miniPort, { path: p, headers: AE });
    assert.equal(asked.status, status, `${p}: status`);
    assert.notEqual(asked.headers['content-encoding'], 'br', `${p}: not br`);
    assert.notEqual(asked.headers['content-encoding'], 'gzip', `${p}: not gzip`);
    assert.ok(asked.raw.equals(plain.raw), `${p}: body unchanged`);
    if (status !== 200) assert.ok(!varies(asked), `${p}: a non-200 gains no Vary header`);
    else if (vary) assert.ok(varies(asked), `${p}: an allowlisted 200 still varies`);
  }
});

test('direct: excluded routes and non-GET methods pass through untouched', async () => {
  const paths = ['/login', '/logout', '/healthz', '/assistant/current', '/assistant/mcp',
    '/settlement/evidence.json', '/.well-known/oauth-protected-resource', '/login.html', '/assistant/x.js'];
  for (const p of paths) {
    for (const method of ['GET', 'POST']) {
      const plain = await request(miniPort, { method, path: p });
      const asked = await request(miniPort, { method, path: p, headers: AE });
      assert.equal(asked.status, 200, `${method} ${p}: reached`);
      assert.equal(asked.headers['content-encoding'], undefined, `${method} ${p}: not compressed`);
      assert.ok(!varies(asked), `${method} ${p}: no Vary added`);
      assert.ok(asked.raw.equals(plain.raw), `${method} ${p}: body unchanged`);
    }
  }
  const post = await request(miniPort, { method: 'POST', path: '/data.json', headers: AE });
  assert.equal(post.headers['content-encoding'], undefined, 'POST /data.json: not compressed');
  assert.ok(!varies(post), 'POST /data.json: no Vary added');
  const head = await request(miniPort, { method: 'HEAD', path: '/app.js', headers: AE });
  assert.equal(head.headers['content-encoding'], undefined, 'HEAD: not compressed');
});

/* ------------------------------ real server ------------------------------ */

let child = null;
let port = 0;
let cookie = '';

before(async () => {
  port = await freePort();
  const env = { ...process.env, SITE_PASSWORD: PASS, SESSION_SECRET: SECRET, PORT: String(port) };
  for (const key of Object.keys(env)) if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  delete env.NODE_ENV;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await request(port, { path: '/healthz' });
      if (r.status === 200) break;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`server start timeout\n${stderr}`);
    await new Promise(r => setTimeout(r, 200));
  }
  const login = await request(port, {
    method: 'POST', path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept-encoding': 'br, gzip' },
    body: 'password=' + encodeURIComponent(PASS),
  });
  assert.equal(login.status, 302, 'synthetic login');
  assert.equal(login.headers['content-encoding'], undefined, 'the login response is not compressed');
  cookie = login.headers['set-cookie'][0].split(';')[0];
});
after(() => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
});

const VOLATILE = new Set(['date', 'content-length', 'content-encoding', 'vary', 'connection', 'keep-alive',
  'x-atlas-observation-checked-at', 'x-atlas-observation-attempted-at']);
function stableHeaders(r) {
  return Object.fromEntries(Object.entries(r.headers).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => a.localeCompare(b)));
}

test('server: without a session, the gate answers exactly as before, never compressed and with no Vary added', async () => {
  for (const p of ['/', '/index.html', '/data.json', '/balance-history.json', '/forecast.js', '/plan.js', '/app.js', '/assistant/current']) {
    const plain = await request(port, { path: p });
    const asked = await request(port, { path: p, headers: AE });
    // /assistant/current answers 503 when no assistant token is configured.
    assert.ok([302, 401, 503].includes(asked.status), `${p}: refused (${asked.status})`);
    assert.equal(asked.status, plain.status, `${p}: same status`);
    assert.equal(asked.headers['content-encoding'], undefined, `${p}: not compressed`);
    assert.ok(!varies(asked), `${p}: no Vary: Accept-Encoding on the gate's answer`);
    assert.deepEqual(stableHeaders(asked), stableHeaders(plain), `${p}: headers unchanged`);
    assert.ok(asked.raw.equals(plain.raw), `${p}: body unchanged`);
  }
});

test('server: login, health, robots and OAuth metadata are never compressed', async () => {
  for (const p of ['/login', '/healthz', '/robots.txt', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/assistant/mcp']) {
    const plain = await request(port, { path: p, headers: { cookie } });
    const asked = await request(port, { path: p, headers: { cookie, ...AE } });
    assert.equal(asked.headers['content-encoding'], undefined, `${p}: not compressed`);
    assert.ok(!varies(asked), `${p}: no Vary added`);
    assert.equal(asked.status, plain.status, `${p}: same status`);
    assert.ok(asked.raw.equals(plain.raw), `${p}: body unchanged`);
  }
  // These bodies are small, so the size threshold alone would leave them
  // alone; the direct tests above prove the route exclusion at full size.
});

test('server: each allowlisted page and data response decodes byte-identically, with every security header unchanged', async () => {
  const assets = ['/', '/index.html', '/data.json', '/balance-history.json', '/forecast.js', '/plan.js', '/app.js', '/styles.css', '/budget-blend.js'];
  for (const p of assets) {
    const plain = await request(port, { path: p, headers: { cookie } });
    assert.equal(plain.status, 200, `${p}: served`);
    for (const ae of ['br, gzip', 'gzip', 'br;q=0, gzip']) {
      const asked = await request(port, { path: p, headers: { cookie, 'accept-encoding': ae } });
      const expected = ae === 'br, gzip' ? 'br' : 'gzip';
      if (plain.raw.length >= MIN_BYTES) assert.equal(asked.headers['content-encoding'], expected, `${p} [${ae}]: ${expected}`);
      assert.ok(decode(asked).equals(plain.raw), `${p} [${ae}]: decodes to the identity bytes`);
      assert.ok(varies(asked) && varies(plain), `${p} [${ae}]: Vary: Accept-Encoding`);
      for (const h of SECURITY_HEADERS) {
        assert.ok(plain.headers[h], `${p}: ${h} present`);
        assert.equal(asked.headers[h], plain.headers[h], `${p} [${ae}]: ${h} unchanged`);
      }
      assert.deepEqual(stableHeaders(asked), stableHeaders(plain), `${p} [${ae}]: every other header unchanged`);
      assert.equal(Number(asked.headers['content-length']), asked.raw.length, `${p} [${ae}]: Content-Length is the sent length`);
    }
    const none = await request(port, { path: p, headers: { cookie, 'accept-encoding': 'identity' } });
    assert.equal(none.headers['content-encoding'], undefined, `${p}: identity when only identity is accepted`);
    assert.ok(none.raw.equals(plain.raw), `${p}: identity body unchanged`);
  }
});

test('server: the public stylesheet compresses without a session; a small file, a redirect and a 404 are left alone', async () => {
  const css = await request(port, { path: '/styles.css', headers: AE });
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-encoding'], 'br', 'styles.css (needed by the login page) compresses');
  assert.ok(decode(css).equals(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'))), 'styles.css decodes to the file');
  const small = await request(port, { path: '/fonts.css', headers: { cookie, ...AE } });
  assert.ok(small.raw.length < MIN_BYTES && small.headers['content-encoding'] === undefined, 'a file under the threshold is sent as is');
  for (const [p, status] of [['/planning.html', 302], ['/missing-asset.js', 404]]) {
    const plain = await request(port, { path: p, headers: { cookie } });
    const asked = await request(port, { path: p, headers: { cookie, ...AE } });
    assert.equal(asked.status, status, `${p}: status`);
    assert.equal(asked.headers['content-encoding'], undefined, `${p}: not compressed`);
    assert.ok(!varies(asked), `${p}: no Vary added`);
    assert.deepEqual(stableHeaders(asked), stableHeaders(plain), `${p}: headers unchanged`);
  }
});

test('server.js mounts compression after the auth gate and before the data and static routes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const gate = src.indexOf("return res.redirect('/login');\n});");
  const mount = src.indexOf('app.use(ResponseCompression.compressAllowlisted);');
  const data = src.indexOf("app.get('/data.json'");
  const statics = src.indexOf('app.use(express.static(');
  assert.ok(gate > 0 && mount > gate, 'mounted after the gate');
  assert.ok(mount < data && mount < statics, 'mounted before the data and static routes');
  assert.equal(src.split('compressAllowlisted').length - 1, 1, 'mounted once');
  assert.ok(!/require\(['"]compression['"]\)/.test(src), 'no blanket compression package');
});
