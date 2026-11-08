'use strict';
/* A17 + M8 — an undecodable session cookie is no session, not a 500.
 *
 * Starts the real server.js with synthetic SITE_PASSWORD / SESSION_SECRET
 * on a free local port and sends `Cookie: hfd_session=%` (and two other
 * malformed percent-encodings) to the auth gate. Before the fix,
 * decodeURIComponent threw inside readCookie and the gate answered 500.
 * After it, the request is treated exactly like one with no cookie.
 *
 * Only status codes and redirect targets are read; no response body, no
 * household figure, no provider call.
 *
 * `node test/test-malformed-session-cookie.js`
 */
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASS = 'synthetic-malformed-cookie-password';
const SECRET = 'synthetic-malformed-cookie-session-secret';
const BAD = ['%', '%E0%A4%A', 'abc%zz'];

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

function startServer(port) {
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  env.ATLAS_LUNCHMONEY_CREDENTIAL_FILE = path.join(os.tmpdir(), `atlas-a17-no-credentials-${process.pid}`, 'missing.dat');
  Object.assign(env, { SITE_PASSWORD: PASS, SESSION_SECRET: SECRET, PORT: String(port) });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('start timeout\n' + err)); } }, 15000);
    child.stdout.on('data', c => {
      out += c;
      if (!done && /listening/.test(out)) { done = true; clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', c => { err += c; });
    child.on('exit', code => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`exited ${code}\n${err}`)); } });
  });
}

async function call(base, method, route, cookie, body) {
  const headers = {};
  if (cookie != null) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + route, { method, headers, redirect: 'manual', body: body ? JSON.stringify(body) : undefined });
  try { await res.arrayBuffer(); } catch (_) { /* body not inspected */ }
  return { status: res.status, location: res.headers.get('location') || '' };
}

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = await startServer(port);
  try {
    const routes = [
      ['GET', '/'],
      ['GET', '/data.json'],
      ['GET', '/talk/context'],
      ['POST', '/talk/ask', { question: 'invented question' }],
      ['GET', '/login'],
    ];
    const baseline = {};
    for (const [method, route, body] of routes) {
      baseline[route] = await call(base, method, route, null, body);
    }
    for (const bad of BAD) {
      console.log(`=== Cookie: hfd_session=${bad} ===`);
      for (const [method, route, body] of routes) {
        const r = await call(base, method, route, `hfd_session=${bad}`, body);
        ok(r.status !== 500 && r.status === baseline[route].status && r.location === baseline[route].location,
          `${method} ${route} answers like no cookie (${baseline[route].status}), not 500`, `got ${r.status}`);
      }
    }
    console.log('=== a valid session still works next to a malformed unrelated cookie ===');
    const login = await fetch(base + '/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(PASS)}`,
    });
    const sessionCookie = (login.headers.get('set-cookie') || '').split(';')[0];
    ok(login.status === 302 && /^hfd_session=/.test(sessionCookie), 'synthetic login issues a session cookie');
    const authedRoot = await call(base, 'GET', '/data.json', `other=%; ${sessionCookie}`);
    ok(authedRoot.status === 200, 'the signed session is still accepted beside an undecodable other cookie', `got ${authedRoot.status}`);
    const badThenGood = await call(base, 'GET', '/data.json', `hfd_session=%; ${sessionCookie}`);
    ok(badThenGood.status === 401, 'a malformed hfd_session listed first is still no session (fail closed)', `got ${badThenGood.status}`);
  } finally {
    child.kill('SIGTERM');
  }
  console.log('\n' + (failures ? `${failures} failure(s)` : 'All malformed session cookie checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
