// Verify the deployed site from outside. Only checks behaviour visible without
// the password — which is exactly the behaviour that matters most.
const BASE = process.env.LIVE_BASE || 'https://atlas-financial-o6w1.onrender.com';
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

async function main() {
  console.log(`Target: ${BASE}\n`);

  // Free instances sleep; give it time to wake.
  let root = null;
  for (let i = 0; i < 10; i++) {
    try {
      root = await fetch(`${BASE}/`, { redirect: 'manual' });
      break;
    } catch (e) {
      console.log(`  (waiting for the instance to wake — attempt ${i + 1})`);
      await new Promise(r => setTimeout(r, 6000));
    }
  }
  if (!root) { console.log('  FAIL  site unreachable'); process.exit(1); }

  console.log('=== the data must not be reachable without signing in ===');
  const data = await fetch(`${BASE}/data.json`, { redirect: 'manual' });
  ok(data.status === 401, 'GET /data.json returns 401', `status ${data.status}`);
  const body = await data.text();
  ok(!body.includes('546026') && !body.includes('balance') && body.length < 200,
     'no financial data in the body', `${body.length} bytes`);

  console.log('\n=== removed Talk paths answer nothing without a session ===');
  // Talk was removed (#821 comment 6786692208). Its paths are ordinary
  // unknown paths: the gate redirects them to /login and no handler answers.
  for (const route of ['/talk/context', '/talk/capability']) {
    const removed = await fetch(`${BASE}${route}`, { redirect: 'manual' });
    ok(removed.status === 302 && (removed.headers.get('location') || '').includes('/login'),
      `GET ${route} redirects to /login`, `status ${removed.status}`);
  }
  const talkAsk = await fetch(`${BASE}/talk/ask`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What should I know today?' }),
  });
  ok(talkAsk.status === 302 && (talkAsk.headers.get('location') || '').includes('/login'),
    'POST /talk/ask redirects to /login', `status ${talkAsk.status}`);
  const talkAskBody = await talkAsk.text();
  ok(!/answer|ATLAS_TALK|AIza/.test(talkAskBody) && talkAskBody.length < 200,
     'unauthenticated request to a removed Talk path returns no answer and no secret',
     `${talkAskBody.length} bytes`);

  console.log('\n=== login gate ===');
  ok(root.status === 302 && (root.headers.get('location') || '').includes('/login'),
     'GET / redirects to /login', `status ${root.status}`);
  const login = await fetch(`${BASE}/login`);
  const html = await login.text();
  ok(login.status === 200 && html.includes('Password'), 'login page renders', `${html.length} bytes`);
  ok(!html.includes('546026') && !html.includes('Triangle'), 'login page leaks no figures');

  const badPw = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=not-the-password',
  });
  ok(badPw.status === 401, 'wrong password rejected', `status ${badPw.status}`);
  ok(!(badPw.headers.get('set-cookie') || '').includes('hfd_session='), 'no cookie issued on failure');

  console.log('\n=== assets are gated too ===');
  for (const p of ['/app.js', '/index.html']) {
    const r = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    ok(r.status === 302 || r.status === 401, `${p} is gated`, `status ${r.status}`);
  }

  console.log('\n=== headers survived the proxy ===');
  const want = {
    'x-robots-tag': /noindex/,
    'cache-control': /no-store/,
    'x-frame-options': /DENY/,
    'content-security-policy': /default-src 'none'/,
    'x-content-type-options': /nosniff/,
    'strict-transport-security': /max-age/,
  };
  for (const [h, re] of Object.entries(want)) {
    const v = login.headers.get(h) || '';
    ok(re.test(v), h, v || 'MISSING');
  }
  ok(!login.headers.get('x-powered-by'), 'x-powered-by suppressed');

  console.log('\n=== search engines ===');
  const robots = await fetch(`${BASE}/robots.txt`);
  const rt = await robots.text();
  ok(rt.includes('Disallow: /'), 'robots.txt disallows everything', rt.trim().replace(/\n/g, ' | '));

  console.log('\n=== https ===');
  ok(BASE.startsWith('https://'), 'served over HTTPS');

  console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
