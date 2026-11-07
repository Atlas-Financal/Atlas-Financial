'use strict';
/* Retirement proof for the legacy Forecast / Road Ahead page.
 *
 * Boots the real server.js with synthetic SITE_PASSWORD / SESSION_SECRET
 * (the test-production-live-overlay.js pattern; not production secrets),
 * performs a real login, and pins the HTTP behaviour of /planning.html:
 *
 *   - the canonical path 302-redirects authenticated users to / (Budget);
 *   - every HTTP variant the Express/static stack could treat as the same
 *     file (query string, trailing slash, case, percent-encoding, dot
 *     segments, doubled slashes, encoded traversal back to the file) must
 *     NOT serve the old page — each variant's safe behaviour is pinned
 *     exactly, so a future routing/static change that re-exposes the page
 *     fails here;
 *   - unauthenticated requests still meet the existing auth gate first
 *     (302 /login for page paths, 401 JSON for /data.json), exactly one hop;
 *   - /, /index.html, /modellers.html and the /forecast.html 404 are unchanged;
 *   - the Windows-runtime alias families Systems Review 5549092124
 *     demonstrated against the retained file (percent-encoded trailing
 *     slash, backslash as separator, NTFS ::$DATA stream suffix, plus
 *     their case and trailing-slash combinations) also 302 to / for
 *     authenticated GET and HEAD. On POSIX those aliases 404 today (the
 *     filesystem never resolves them onto the file — the 200 serving was
 *     reproduced on the documented Windows runtime); the guard must
 *     recognise them by canonical form so the retirement holds on both.
 *
 * public/planning.html stays on disk by design (Atlas boundary ruling);
 * this suite proves it is unreachable over HTTP, not that it is gone.
 */
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASS = 'synthetic-site-password';
const SECRET = 'synthetic-session-secret';
const PLANNING_SHELL = 'data-page-shell="planning"';
const BUDGET_MARKER = 'id="operating-surface"';

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

function isolatedEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  }
  env.ATLAS_LUNCHMONEY_CREDENTIAL_FILE = path.join(require('os').tmpdir(),
    'atlas-planning-retirement-no-credentials-' + process.pid, 'missing.dat');
  return Object.assign(env, extra || {});
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
    server.on('error', reject);
  });
}

function startAtlas(env) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('server start timeout\n' + stderr));
    }, 20000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!settled && /listening/.test(stdout)) {
        settled = true;
        clearTimeout(timer);
        resolve({
          child,
          stderr: () => stderr,
          stop: () => new Promise(done => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, 2000);
          }),
        });
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stderr}`));
    });
  });
}

/* Raw HTTP request: the path is sent byte-for-byte as given, so percent
 * encodings, dot segments and doubled slashes reach the server exactly as
 * a non-browser client (or a browser's address bar after its own parsing)
 * could send them. fetch()/URL would normalise several of these away. */
function rawRequest(base, method, rawPath, cookie, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body != null) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      host: u.hostname, port: u.port, path: rawPath, method, headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const rawGet = (base, rawPath, cookie) => rawRequest(base, 'GET', rawPath, cookie, null);

async function login(base) {
  const res = await rawRequest(base, 'POST', '/login', null,
    `password=${encodeURIComponent(PASS)}`);
  const setCookie = res.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie || '';
  return { status: res.status, location: res.headers.location, cookie: first.split(';')[0] };
}

const isOldPage = res => res.status === 200 && res.body.includes(PLANNING_SHELL);
const isBudget = res => res.status === 200
  && res.body.includes(BUDGET_MARKER) && !res.body.includes(PLANNING_SHELL);

/* Each variant: [label, raw path, pinned authenticated outcome].
 * kind 'redirect-root' = 302 with Location: / ; kind 'notfound' = 404;
 * kind 'budget' = 200 Budget body. Every variant additionally asserts the
 * hard safety property: the response is never the old planning page. */
const VARIANTS = [
  ['query string', '/planning.html?x=1', 'redirect-root'],
  ['trailing slash', '/planning.html/', 'redirect-root'],
  ['uppercase path', '/PLANNING.HTML', 'redirect-root'],
  ['mixed-case path', '/Planning.Html', 'redirect-root'],
  ['percent-encoded dot', '/planning%2Ehtml', 'redirect-root'],
  ['percent-encoded first letter', '/%70lanning.html', 'redirect-root'],
  ['encoded slash then dot-dot back to root', '/planning.html%2F..', 'dir-redirect-then-budget'],
  ['encoded traversal back to the file', '/planning.html%2F..%2Fplanning.html', 'redirect-root'],
  ['dot segment', '/./planning.html', 'redirect-root'],
  ['doubled slash', '//planning.html', 'redirect-root'],
  ['dot-dot segment from a sibling', '/bills/../planning.html', 'redirect-root'],
];

/* Windows-runtime alias families (Systems Review 5549092124): on the
 * documented Windows runtime these resolve onto the retained file itself —
 * a percent-encoded slash leaves a trailing-slash form, a backslash is a
 * path separator, and ::$DATA names the file's default NTFS stream. Each
 * must answer the same 302 to / as the canonical path, GET and HEAD. */
const WINDOWS_ALIASES = [
  ['encoded trailing slash, lowercase hex', '/planning.html%2f'],
  ['encoded trailing slash, uppercase hex', '/planning.html%2F'],
  ['encoded backslash separator, lowercase hex', '/%5cplanning.html'],
  ['encoded backslash separator, uppercase hex', '/%5Cplanning.html'],
  ['literal backslash separator', '/\\planning.html'],
  ['NTFS stream suffix', '/planning.html::$DATA'],
  ['NTFS stream suffix, uppercase path', '/PLANNING.HTML::$DATA'],
  ['NTFS stream suffix, mixed case', '/Planning.Html::$Data'],
  ['NTFS stream suffix with trailing slash', '/planning.html::$DATA/'],
  // Decide retirement before filesystem lookup: some runtimes reject these
  // suffix forms with 404 instead of resolving them onto the retained file.
  ['trailing period', '/planning.html.'],
  ['encoded trailing period', '/planning.html%2e'],
  ['encoded trailing space', '/planning.html%20'],
  ['mixed trailing periods and spaces', '/planning.html.%20.%20'],
  ['uppercase trailing space with query', '/PLANNING.HTML%20?alias=1'],
  ['filename suffix before NTFS stream', '/planning.html.%20::$DATA'],
  ['suffix after NTFS stream', '/planning.html::$DATA.%20'],
  ['suffixes around NTFS stream and trailing slash', '/planning.html.%20::$DATA.%20%2F'],
  ['suffix after backslash and parent traversal', '/x%5c..%5cplanning.html.%20'],
  ['parent traversal before suffixed filename', '/x/../planning.html.'],
];

function expectKind(res, kind) {
  if (kind === 'redirect-root') return res.status === 302 && res.headers.location === '/';
  if (kind === 'notfound') return res.status === 404;
  if (kind === 'budget') return isBudget(res);
  return false;
}

/* '/planning.html%2F..' decodes to a path that normalises to the site
 * root, so it is not the retired file: serve-static answers its standing
 * 301 directory redirect to '/planning.html%2F../', and following that
 * Location must land on the Budget body — never the old page. Pin both
 * hops exactly. */

(async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const atlas = await startAtlas(isolatedEnv({
    SITE_PASSWORD: PASS,
    SESSION_SECRET: SECRET,
    PORT: String(port),
  }));
  try {
    const auth = await login(base);
    ok(auth.status === 302 && auth.location === '/' && /^hfd_session=/.test(auth.cookie),
      'login issues a session and lands on /', `status ${auth.status}`);
    const cookie = auth.cookie;

    console.log('=== canonical path ===');
    {
      const res = await rawGet(base, '/planning.html', cookie);
      ok(res.status === 302 && res.headers.location === '/',
        'authenticated GET /planning.html -> 302 Location: /',
        `status ${res.status}, location ${res.headers.location}`);
      ok(!isOldPage(res), 'canonical response is not the old page');
      const followed = res.headers.location
        ? await rawGet(base, res.headers.location, cookie)
        : { status: 0, body: '' };
      ok(isBudget(followed),
        'following the redirect -> 200 Budget body, not the planning shell',
        `status ${followed.status}`);
    }

    console.log('=== HTTP variants (authenticated) ===');
    for (const [label, rawPath, kind] of VARIANTS) {
      const res = await rawGet(base, rawPath, cookie);
      ok(!isOldPage(res), `${label} (${rawPath}) does not serve the old page`,
        `status ${res.status}`);
      if (kind === 'dir-redirect-then-budget') {
        ok(res.status === 301 && res.headers.location === '/planning.html%2F../',
          `${label} pinned outcome: 301 to the directory form`,
          `status ${res.status}, location ${res.headers.location}`);
        const followed = res.headers.location
          ? await rawGet(base, res.headers.location, cookie)
          : { status: 0, body: '' };
        ok(isBudget(followed),
          `${label}: following the 301 lands on Budget, not the old page`,
          `status ${followed.status}`);
        continue;
      }
      ok(expectKind(res, kind), `${label} pinned outcome: ${kind}`,
        `status ${res.status}, location ${res.headers.location}`);
    }

    console.log('=== Windows-runtime aliases (authenticated GET + HEAD) ===');
    for (const [label, rawPath] of WINDOWS_ALIASES) {
      const get = await rawGet(base, rawPath, cookie);
      ok(!isOldPage(get), `${label} (${rawPath}) GET does not serve the old page`,
        `status ${get.status}`);
      ok(get.status === 302 && get.headers.location === '/',
        `${label} (${rawPath}) authenticated GET -> 302 Location: /`,
        `status ${get.status}, location ${get.headers.location}`);
      const head = await rawRequest(base, 'HEAD', rawPath, cookie, null);
      ok(head.status === 302 && head.headers.location === '/',
        `${label} (${rawPath}) authenticated HEAD -> 302 Location: /`,
        `status ${head.status}, location ${head.headers.location}`);
    }

    console.log('=== unauthenticated shape ===');
    for (const [label, rawPath] of [
      ['canonical', '/planning.html'],
      ['query string', '/planning.html?x=1'],
      ['percent-encoded dot', '/planning%2Ehtml'],
      ['percent-encoded first letter', '/%70lanning.html'],
    ]) {
      const res = await rawGet(base, rawPath, null);
      ok(res.status === 302 && res.headers.location === '/login',
        `unauthenticated ${label} (${rawPath}) -> 302 /login at the gate`,
        `status ${res.status}, location ${res.headers.location}`);
      ok(!isOldPage(res), `unauthenticated ${label} is never the old page`);
    }

    console.log('=== unauthenticated Windows-runtime aliases ===');
    for (const [label, rawPath] of WINDOWS_ALIASES) {
      const res = await rawGet(base, rawPath, null);
      ok(res.status === 302 && res.headers.location === '/login',
        `unauthenticated ${label} (${rawPath}) -> 302 /login at the gate`,
        `status ${res.status}, location ${res.headers.location}`);
      ok(!isOldPage(res), `unauthenticated ${label} is never the old page`);
    }
    for (const rawPath of ['/planning.html%2f', '/%5cplanning.html', '/planning.html::$DATA',
      '/planning.html.', '/planning.html%20']) {
      const head = await rawRequest(base, 'HEAD', rawPath, null, null);
      ok(head.status === 302 && head.headers.location === '/login',
        `unauthenticated HEAD ${rawPath} -> 302 /login at the gate`,
        `status ${head.status}, location ${head.headers.location}`);
    }

    console.log('=== preservation controls ===');
    // /bills.html is itself switched off now (test-legacy-pages-switched-off.js);
    // /modellers.html stays served, so it is the unrelated control.
    for (const rawPath of ['/modellers.html.', '/modellers.html%20', '/forecast.js%20']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await rawRequest(base, method, rawPath, cookie, null);
        ok((res.status === 200 || res.status === 404) && !res.headers.location,
          `${method} unrelated suffixed path ${rawPath} retains static handling`,
          `status ${res.status}, location ${res.headers.location}`);
      }
    }
    for (const rawPath of ['/planning.html.', '/planning.html%20']) {
      const res = await rawRequest(base, 'POST', rawPath, cookie, null);
      ok(res.status === 404, `POST ${rawPath} is not absorbed by the GET/HEAD retirement`,
        `status ${res.status}`);
    }
    {
      const res = await rawGet(base, '/planning.html.%20/..', cookie);
      ok(res.status === 301 && res.headers.location === '/planning.html.%20/../',
        'parent traversal out of a suffixed name retains the directory redirect');
      const followed = res.headers.location
        ? await rawGet(base, res.headers.location, cookie) : { status: 0, body: '' };
      ok(isBudget(followed), 'parent traversal out of a suffixed name still lands on Budget');
    }
    {
      const res = await rawGet(base, '/planning.html', null);
      ok(res.status === 302 && res.headers.location === '/login',
        'unauthenticated GET /planning.html -> 302 /login, exactly one hop');
    }
    {
      // Full unauthenticated chain: /planning.html -> /login -> POST -> / -> Budget.
      const visited = [];
      let hops = 0;
      let res = await rawGet(base, '/planning.html', null);
      visited.push('/planning.html');
      ok(res.status === 302 && res.headers.location === '/login', 'chain hop 1: gate -> /login');
      hops++;
      const loginPage = await rawGet(base, '/login', null);
      ok(loginPage.status === 200, 'chain: GET /login -> 200 login page',
        `status ${loginPage.status}`);
      const post = await login(base);
      ok(post.status === 302 && post.location === '/', 'chain hop 2: POST /login -> /');
      hops++;
      visited.push('/login', '/');
      const home = await rawGet(base, '/', post.cookie);
      ok(isBudget(home), 'chain lands on / -> 200 Budget', `status ${home.status}`);
      ok(hops <= 3, 'chain redirect hops bounded (<= 3)', `${hops} hops`);
      ok(new Set(visited).size === visited.length, 'chain has no repeated URL (no loop)');
    }
    {
      const root = await rawGet(base, '/', cookie);
      ok(isBudget(root), 'authenticated GET / -> 200 Budget unchanged', `status ${root.status}`);
      const idx = await rawGet(base, '/index.html', cookie);
      ok(isBudget(idx), 'authenticated GET /index.html -> 200 Budget unchanged',
        `status ${idx.status}`);
      const forecast = await rawGet(base, '/forecast.html', cookie);
      ok(forecast.status === 404, 'authenticated GET /forecast.html -> 404 (no alias created)',
        `status ${forecast.status}`);
      const modellers = await rawGet(base, '/modellers.html', cookie);
      ok(modellers.status === 200 && !isOldPage(modellers),
        'authenticated GET /modellers.html -> 200 unchanged', `status ${modellers.status}`);
      const data = await rawGet(base, '/data.json', null);
      let json = null;
      try { json = JSON.parse(data.body); } catch (e) { /* asserted below */ }
      ok(data.status === 401 && json && typeof json.error === 'string',
        'unauthenticated GET /data.json -> 401 JSON unchanged', `status ${data.status}`);
    }
  } finally {
    await atlas.stop();
  }

  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('All planning-retirement checks passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
