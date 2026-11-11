// Local smoke test for the auth gate and the data endpoint.
// Run against a server started with known SITE_PASSWORD / SESSION_SECRET.
const BASE = process.env.TEST_BASE || 'http://localhost:3111';
const PASS = process.env.TEST_PASSWORD;
if (!PASS) {
  console.error('Set TEST_PASSWORD to the same value the server was started with.');
  process.exit(2);
}

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

async function main() {
  console.log('=== unauthenticated ===');
  let r = await fetch(`${BASE}/`, { redirect: 'manual' });
  ok(r.status === 302 && (r.headers.get('location') || '').includes('/login'),
     'GET / redirects to /login', `status ${r.status} -> ${r.headers.get('location')}`);

  r = await fetch(`${BASE}/data.json`, { redirect: 'manual' });
  ok(r.status === 401, 'GET /data.json is blocked', `status ${r.status}`);

  r = await fetch(`${BASE}/assistant/current`, { redirect: 'manual' });
  ok(r.status === 401 || r.status === 503,
    'GET /assistant/current is blocked without the assistant Bearer',
    `status ${r.status}`);

  r = await fetch(`${BASE}/assistant/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    redirect: 'manual',
  });
  ok(r.status === 401 || r.status === 503,
    'POST /assistant/mcp is blocked without OAuth authorization',
    `status ${r.status}`);

  r = await fetch(`${BASE}/balance-history.json`, { redirect: 'manual' });
  ok(r.status === 401, 'GET /balance-history.json is blocked', `status ${r.status}`);

  // Talk was removed (owner decision, #821 comment 6786692208): its paths are
  // ordinary unknown paths now, so without a session the gate redirects them
  // like any other page, and nothing answers a Talk request.
  for (const route of ['/talk/context', '/talk/capability', '/talk.html']) {
    r = await fetch(`${BASE}${route}`, { redirect: 'manual' });
    ok(r.status === 302 && r.headers.get('location') === '/login',
      `GET ${route} redirects to login without a session (Talk removed)`, `status ${r.status}`);
  }
  r = await fetch(`${BASE}/talk/ask`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What should I know today?' }),
  });
  ok(r.status === 302 && r.headers.get('location') === '/login',
    'POST /talk/ask redirects to login without a session (Talk removed)', `status ${r.status}`);

  r = await fetch(`${BASE}/app.js`, { redirect: 'manual' });
  ok(r.status === 302, 'GET /app.js redirects to login', `status ${r.status}`);

  // Every page and script of the multi-page layout sits behind the same gate.
  for (const p of ['/deepdive.html', '/modellers.html', '/records.html', '/plan.js', '/forecast.js', '/balance-history.js', '/periods.json']) {
    r = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    ok(r.status === 302, `GET ${p} redirects to login`, `status ${r.status}`);
  }

  r = await fetch(`${BASE}/styles.css`);
  ok(r.status === 200, 'GET /styles.css is public (login page needs it)', `status ${r.status}`);

  r = await fetch(`${BASE}/robots.txt`);
  const robots = await r.text();
  ok(robots.includes('Disallow: /'), 'robots.txt disallows everything');

  console.log('\n=== wrong password ===');
  r = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=definitely-not-it',
  });
  ok(r.status === 401, 'rejected', `status ${r.status}`);
  ok(!(r.headers.get('set-cookie') || '').includes('hfd_session='), 'no session cookie issued');

  console.log('\n=== correct password ===');
  r = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(PASS)}`,
  });
  const setCookie = r.headers.get('set-cookie') || '';
  ok(r.status === 302, 'redirects after login', `status ${r.status}`);
  ok(setCookie.includes('hfd_session='), 'session cookie issued');
  ok(setCookie.includes('HttpOnly'), 'cookie is HttpOnly');
  ok(setCookie.includes('SameSite=Lax'), 'cookie is SameSite=Lax');
  ok(setCookie.includes('Path=/'), 'cookie path is unchanged');
  ok(setCookie.includes('Max-Age=1209600'), 'cookie retains its 14-day lifetime');
  const cookie = setCookie.split(';')[0];
  const payload = JSON.parse(Buffer.from(decodeURIComponent(cookie.slice('hfd_session='.length)).split('.')[0], 'base64url'));
  ok(typeof payload.sid === 'string' && /^[0-9a-f]{64}$/.test(payload.sid),
    'login carries a 256-bit session identity');
  r = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: `password=${encodeURIComponent(PASS)}&sid=${'f'.repeat(64)}`,
  });
  const secondCookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const secondPayload = JSON.parse(Buffer.from(decodeURIComponent(secondCookie.slice('hfd_session='.length)).split('.')[0], 'base64url'));
  ok(r.status === 302 && /^[0-9a-f]{64}$/.test(secondPayload.sid)
      && secondPayload.sid !== payload.sid && secondPayload.sid !== 'f'.repeat(64),
    'fresh successful login assigns its own distinct identity');

  console.log('\n=== authenticated ===');
  r = await fetch(`${BASE}/data.json`, { headers: { cookie } });
  ok(r.status === 200, 'GET /data.json succeeds', `status ${r.status}`);
  const data = await r.json();
  ok(data.debts && data.debts.length >= 4, 'data has debts', `${data.debts?.length} entries`);
  ok(data.questions && data.questions.length >= 3, 'data has questions', `${data.questions?.length} entries`);
  ok(!!data.mortgage && !!data.helocHistory, 'data has mortgage and HELOC history');

  r = await fetch(`${BASE}/balance-history.json`, { headers: { cookie } });
  ok(r.status === 200, 'GET /balance-history.json succeeds', `status ${r.status}`);
  const history = await r.json();

  for (const route of ['/talk/context', '/talk/capability', '/talk.html', '/talk.js']) {
    r = await fetch(`${BASE}${route}`, { headers: { cookie }, redirect: 'manual' });
    ok(r.status === 404, `GET ${route} is not served to a session (Talk removed)`, `status ${r.status}`);
  }
  r = await fetch(`${BASE}/talk/ask`, { method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What should I know today?' }) });
  ok(r.status === 404, 'POST /talk/ask is not served to a session (Talk removed)', `status ${r.status}`);
  ok(history && Array.isArray(history.snapshots), 'history has snapshots',
    history && history.snapshots ? `${history.snapshots.length} openings` : 'missing');
  ok(history.currentStateAuthority === 'data.json',
    'history names data.json as current-state authority');

  r = await fetch(`${BASE}/`, { headers: { cookie } });
  const html = await r.text();
  ok(r.status === 200 && html.includes('<title>'), 'GET / serves the dashboard', `${html.length} bytes`);
  ok(html.includes('app.js'), 'dashboard loads app.js');

  console.log('\n=== security headers ===');
  for (const h of ['x-robots-tag', 'cache-control', 'x-frame-options', 'content-security-policy', 'x-content-type-options', 'strict-transport-security']) {
    ok(!!r.headers.get(h), h, r.headers.get(h) || 'MISSING');
  }

  console.log('\n=== tampered cookie ===');
  r = await fetch(`${BASE}/data.json`, { headers: { cookie: cookie.replace(/.$/, 'X') }, redirect: 'manual' });
  ok(r.status === 401, 'tampered session rejected', `status ${r.status}`);

  console.log('\n=== logout ===');
  r = await fetch(`${BASE}/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  const cleared = r.headers.get('set-cookie') || '';
  ok(r.status === 302 && r.headers.get('location') === '/login'
      && cleared.startsWith('hfd_session=;') && cleared.includes('Max-Age=0'),
    'logout clears this browser cookie');
  r = await fetch(`${BASE}/balance-history.json`, { redirect: 'manual' });
  ok(r.status === 401, 'browser without the cleared cookie is unauthenticated');
  r = await fetch(`${BASE}/balance-history.json`, { headers: { cookie }, redirect: 'manual' });
  ok(r.status === 200, 'copied token remains valid until expiry; logout does not revoke it');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
