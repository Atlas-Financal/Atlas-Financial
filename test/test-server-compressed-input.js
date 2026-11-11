'use strict';
/* Compressed-input rejection on the core request surface.
 *
 * Outside /settlement, server.js accepts only uncompressed request bodies.
 * A request whose Content-Encoding is present and not `identity` is refused
 * before any body parser runs, with the fixed 415 {"status":"invalid-request"}
 * — the same refusal shape the settlement router already returns
 * (scripts/settlement-evidence-http.js). The three body parsers also run with
 * inflate:false as defence in depth.
 *
 * What this replaced (reproduced on the base tree, repro-before evidence):
 * body-parser's default inflate:true decompressed compressed bodies, so a
 * well-formed gzip body was silently accepted (a JSON POST was answered
 * exactly as for uncompressed JSON; a valid gzipped login form logged in),
 * and a malformed stream fell through to the Express default error handler:
 * POST /login with garbage gzip/deflate returned a 400 text/html error page
 * carrying a zlib stack trace, and garbage br returned a 415 text/html page
 * whose stack printed absolute node_modules filesystem paths. The refusal
 * below never varies: acceptance requires the response body to be EXACTLY
 * the fixed JSON — no stack trace, no file paths, no reflected request
 * bytes, no household data.
 *
 * Boots the real server.js as a child process (the server-seam pattern)
 * with synthetic credentials; no production secret is used.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const PASS = ['synthetic', 'site', 'password'].join('-');
const SECRET = ['synthetic', 'session', 'secret', '0123456789'].join('-');
const GARBAGE = Buffer.from('GARBAGE-MARKER-not-a-compressed-stream-0123456789');
const REFUSAL = '{"status":"invalid-request"}';

let child = null;
let port = 0;
let sessionCookie = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      server.close((err) => (err ? reject(err) : resolve(p)));
    });
    server.on('error', reject);
  });
}

function request({ method = 'GET', path: p, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'] || '',
        setCookie: res.headers['set-cookie'] || [],
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function assertRefusal(r, label) {
  assert.equal(r.status, 415, `${label}: status is 415`);
  assert.match(r.contentType, /application\/json/, `${label}: refusal is JSON`);
  // Acceptance: the body is EXACTLY the fixed refusal — by construction it
  // carries no stack trace, no file paths, no reflected request bytes and
  // no household data.
  assert.equal(r.text, REFUSAL, `${label}: body is exactly the fixed refusal`);
  assert.ok(!r.text.includes('GARBAGE-MARKER'), `${label}: no reflected request bytes`);
  assert.ok(!r.text.includes('node_modules'), `${label}: no filesystem paths`);
}

before(async () => {
  port = await freePort();
  const env = { ...process.env, SITE_PASSWORD: PASS, SESSION_SECRET: SECRET, PORT: String(port) };
  for (const key of Object.keys(env)) if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  delete env.NODE_ENV;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await request({ path: '/healthz' });
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`server start timeout\n${stderr}`);
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2000).unref();
});

/* ------------------------- refusals (415, fixed body) ------------------------- */

test('garbage gzip form body is refused before parsing on /login', async () => {
  const r = await request({
    method: 'POST', path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'gzip' },
    body: GARBAGE,
  });
  assertRefusal(r, 'POST /login gzip garbage');
});

test('garbage gzip JSON body is refused before parsing on /assistant/mcp', async () => {
  const r = await request({
    method: 'POST', path: '/assistant/mcp',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: GARBAGE,
  });
  assertRefusal(r, 'POST /assistant/mcp gzip garbage');
});

test('garbage deflate form body is refused before parsing on /login', async () => {
  const r = await request({
    method: 'POST', path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'deflate' },
    body: GARBAGE,
  });
  assertRefusal(r, 'POST /login deflate garbage');
});

test('garbage br form body is refused before parsing on /login (pre-fix this leaked stack + paths)', async () => {
  const r = await request({
    method: 'POST', path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'br' },
    body: GARBAGE,
  });
  assertRefusal(r, 'POST /login br garbage');
  assert.ok(!r.text.includes('Error'), 'no error text in the refusal');
  assert.ok(!/\\|\//.test(r.text.replace(REFUSAL, '')), 'nothing beyond the fixed refusal');
});

test('a VALID gzip-compressed JSON body is refused on /assistant/mcp (compressed input is rejected categorically)', async () => {
  const r = await request({
    method: 'POST', path: '/assistant/mcp',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: zlib.gzipSync(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))),
  });
  assertRefusal(r, 'POST /assistant/mcp valid gzip');
});

test('a VALID gzip-compressed form body is refused on /login (pre-fix it silently logged in)', async () => {
  const r = await request({
    method: 'POST', path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'gzip' },
    body: zlib.gzipSync(Buffer.from('password=' + encodeURIComponent(PASS))),
  });
  assertRefusal(r, 'POST /login valid gzip');
  assert.deepEqual(r.setCookie, [], 'no session is issued for a compressed login');
});

/* ------------------------- controls (pre-fix behaviour kept) ------------------------- */

test('control: Content-Encoding identity passes through — /login wrong password keeps its pre-fix 401 page', async () => {
  const r = await request({
    method: 'POST', path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'Identity' },
    body: 'password=not-the-password',
  });
  assert.equal(r.status, 401, 'identity-encoded request is parsed and refused as a wrong password, not as compressed input');
  assert.match(r.contentType, /text\/html/);
  assert.notEqual(r.text, REFUSAL);
});

test('control: uncompressed /login with the correct password still issues a session (302)', async () => {
  const r = await request({
    method: 'POST', path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(PASS),
  });
  assert.equal(r.status, 302);
  assert.ok(r.setCookie.length > 0, 'session cookie issued');
  sessionCookie = r.setCookie[0].split(';')[0];
});

test('control: uncompressed /assistant/mcp is not refused — identical to its identity-encoding twin', async () => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  const plain = await request({
    method: 'POST', path: '/assistant/mcp',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const identity = await request({
    method: 'POST', path: '/assistant/mcp',
    headers: { 'content-type': 'application/json', 'content-encoding': 'identity' },
    body,
  });
  assert.notEqual(plain.status, 415, 'uncompressed MCP request reaches its own gate');
  assert.equal(identity.status, plain.status, 'identity encoding changes nothing');
  assert.equal(identity.text, plain.text);
});

test('control: GET /healthz is unaffected (200 ok)', async () => {
  const r = await request({ path: '/healthz' });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'ok');
});

/* ------------------------- survival ------------------------- */

test('the server process is still alive and healthy after every malformed request above', async () => {
  assert.equal(child.exitCode, null, 'server process never exited');
  const r = await request({ path: '/healthz' });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'ok');
});
