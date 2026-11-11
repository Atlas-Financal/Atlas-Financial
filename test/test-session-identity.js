'use strict';
// Synthetic, dependency-free proofs against the actual server session functions
// and login/logout handlers. The bounded VM never starts a server, reads household
// data, loads configured credentials, or calls a provider.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const SECRET = 'synthetic-session-identity-signing-secret';
const PASSWORD = 'synthetic-session-identity-password';
const NOW = 1800000000000;
const LIFETIME = 14 * 24 * 60 * 60 * 1000;
let now = NOW;
let entropyCalls = 0;
const routes = new Map();
function block(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from, 'server boundary must exist');
  return source.slice(from, to);
}
const context = vm.createContext({
  Buffer, PASSWORD, SECRET, SESSION_HOURS: 14 * 24,
  Date: { now: () => now },
  crypto: {
    createHmac: crypto.createHmac, timingSafeEqual: crypto.timingSafeEqual,
    randomBytes(size) {
      assert.equal(size, 32, 'login must request 256 bits of cryptographic randomness');
      entropyCalls++;
      return crypto.randomBytes(size);
    },
  },
  app: { get() {}, post(route, handler) { routes.set(route, handler); } },
});
vm.runInContext([
  block('function sign(', 'function assistantConfigured('),
  block('function secureFlag(', '// The health check'),
  'globalThis.sessionTest = { verify, authed, actor: typeof sessionActor === "function" ? sessionActor : () => null };',
].join('\n'), context, { filename: 'server-session-boundary.js' });
const session = context.sessionTest;
const cookieFor = token => `hfd_session=${encodeURIComponent(token)}`;
const request = (token, extra = {}) => ({
  ip: 'synthetic-client', body: {}, headers: token ? { cookie: cookieFor(token) } : {},
  secure: false, get() { return ''; }, ...extra,
});
function response() {
  return {
    statusCode: 200, headers: {},
    status(code) { this.statusCode = code; return this; },
    type() { return this; }, send() { return this; },
    set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    redirect(location) { this.statusCode = 302; this.location = location; return this; },
  };
}
function login(extra = {}) {
  const res = response();
  routes.get('/login')(request(null, { body: { password: PASSWORD }, ...extra }), res);
  assert.equal(res.statusCode, 302, 'correct password must succeed');
  const header = res.headers['set-cookie'];
  const token = decodeURIComponent(header.split(';')[0].slice('hfd_session='.length));
  return { header, token, payload: JSON.parse(Buffer.from(token.split('.')[0], 'base64url')) };
}
// Independent fixture signer also verifies that the incumbent HMAC covers sid.
function signed(payload, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}
let failures = 0;
function check(label, run) {
  try { run(); console.log('  PASS  ' + label); }
  catch { failures++; console.log('  FAIL  ' + label); }
}

const a = login();
const b = login();
check('same-clock successful logins receive distinct 256-bit identities', () => {
  assert.match(a.payload.sid, /^[0-9a-f]{64}$/);
  assert.match(b.payload.sid, /^[0-9a-f]{64}$/);
  assert.notEqual(a.payload.sid, b.payload.sid);
  assert.notEqual(a.token, b.token);
  assert.equal(entropyCalls, 2);
});
check('actor is stable for one verified login and distinct across logins', () => {
  assert.equal(session.actor(request(a.token)), `session-${a.payload.sid}`);
  assert.equal(session.actor(request(a.token)), session.actor(request(a.token)));
  assert.notEqual(session.actor(request(a.token)), session.actor(request(b.token)));
});
check('incumbent HMAC covers expiry and identity; 14-day duration is unchanged', () => {
  assert.equal(a.payload.exp, NOW + LIFETIME);
  assert.equal(a.token, signed(a.payload));
  assert.equal(session.authed(request(a.token)), true);
});
check('cookie attributes and HTTP/HTTPS Secure behavior stay unchanged', () => {
  assert.equal(a.header.split(';').slice(1).join(';'), ' HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600');
  const tls = login({ secure: true });
  const proxy = login({ get: name => name === 'x-forwarded-proto' ? 'https' : '' });
  for (const item of [tls, proxy]) assert.equal(item.header.split(';').slice(1).join(';'),
    ' HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600');
});
check('caller-supplied identity, cookie and actor cannot select the new login identity', () => {
  const supplied = 'f'.repeat(64);
  const chosen = login({ headers: { cookie: cookieFor(a.token) },
    body: { password: PASSWORD, sid: supplied, actor: `session-${supplied}`, exp: NOW + 1 } });
  assert.match(chosen.payload.sid, /^[0-9a-f]{64}$/);
  assert.notEqual(chosen.payload.sid, supplied);
  assert.notEqual(chosen.payload.sid, a.payload.sid);
  assert.equal(chosen.payload.exp, NOW + LIFETIME);
  assert.equal(session.actor(request(null, { body: { sid: supplied, actor: `session-${supplied}` } })), null);
});
check('wrong password issues no cookie and consumes no identity randomness', () => {
  const before = entropyCalls;
  const res = response();
  routes.get('/login')(request(null, { body: { password: 'synthetic-wrong-password', sid: 'f'.repeat(64) } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(entropyCalls, before);
});
check('legacy expiry-only token retains read authentication but never gains an actor', () => {
  const token = signed({ exp: NOW + LIFETIME });
  assert.equal(session.authed(request(token)), true);
  assert.equal(session.actor(request(token)), null);
});
check('identity and expiry tampering, wrong signature and malformed envelope refuse an actor', () => {
  const changed = Buffer.from(JSON.stringify({ ...a.payload, sid: 'e'.repeat(64) })).toString('base64url');
  const later = Buffer.from(JSON.stringify({ ...a.payload, exp: NOW + 2 * LIFETIME })).toString('base64url');
  for (const token of [`${changed}.${a.token.split('.')[1]}`, `${later}.${a.token.split('.')[1]}`,
    signed(a.payload, 'synthetic-wrong-signing-secret'), a.token + '.extra', '', 'malformed', 'a.b']) {
    assert.equal(session.actor(request(token)), null);
  }
  assert.equal(session.actor(request(null, { headers: { cookie: 'hfd_session=%E0%A4%A' } })), null);
});
check('validly signed malformed identity or expiry cannot authenticate an actor', () => {
  for (const sid of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 123, {}, []]) {
    assert.equal(session.actor(request(signed({ exp: NOW + LIFETIME, sid }))), null);
  }
  for (const exp of [null, 0, 'later', String(NOW + LIFETIME), {}, [], true, 1.5]) {
    assert.equal(session.actor(request(signed({ exp, sid: 'a'.repeat(64) }))), null);
  }
});
check('expiry uses the existing boundary and rejects both new and legacy tokens after it', () => {
  now = a.payload.exp;
  assert.equal(session.authed(request(a.token)), true);
  assert.equal(session.actor(request(a.token)), `session-${a.payload.sid}`);
  now++;
  assert.equal(session.authed(request(a.token)), false);
  assert.equal(session.actor(request(a.token)), null);
  assert.equal(session.authed(request(signed({ exp: a.payload.exp }))), false);
  now = NOW;
});
check('logout clears the browser cookie; copied token remains valid', () => {
  const res = response();
  routes.get('/logout')(request(a.token, { secure: true }), res);
  assert.equal(res.location, '/login');
  assert.equal(res.headers['set-cookie'], 'hfd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  assert.equal(session.authed(request()), false);
  assert.equal(session.authed(request(a.token)), true);
  assert.equal(session.actor(request(a.token)), `session-${a.payload.sid}`);
});
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exitCode = failures ? 1 : 0;
