'use strict';
/* Switch-off proof for the eight legacy pages (lead decision under the owner
 * standing rule, #787 6709716878: the household uses only the main app at /;
 * owner decision #821 6786692208: modellers and plan spend go too).
 *
 * Boots the real server.js with synthetic SITE_PASSWORD / SESSION_SECRET
 * (not production secrets), performs a real login, and pins:
 *
 *   - server.js holds ONE switch list, SWITCHED_OFF_PATHS, naming exactly
 *     the eight pages and their page-only scripts;
 *   - every listed path, and the HTTP aliases express.static could resolve
 *     back onto the same file, answers an authenticated GET and HEAD with
 *     302 Location: / — never the old page or script body;
 *   - following the redirect lands on the main app;
 *   - unauthenticated requests still meet the existing session gate first;
 *   - POST is not absorbed by the switch;
 *   - /, /index.html, every script the main app loads, and /periods.json
 *     are still served;
 *   - the main app never loads or fetches a switched-off path.
 *
 * Step 1 left the files on disk (reversible). Under #822 the pages are being
 * deleted one slice at a time: REMOVED lists the ones already gone. Their
 * paths stay in SWITCHED_OFF_PATHS, so an old bookmark still redirects to /.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASS = 'synthetic-site-password';
const SECRET = 'synthetic-session-secret';
const BUDGET_MARKER = 'id="operating-surface"';

const PAGES = ['planning', 'bills', 'subscriptions', 'credit', 'records', 'deepdive', 'modellers', 'plan-spend'];
const SWITCHED_OFF = PAGES.flatMap(p => [`/${p}.html`, `/${p}.js`]);

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

/* ---- 1. one switch list, and the main app never needs it ---- */
console.log('=== one switch list in server.js ===');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const listMatch = serverSrc.match(/const SWITCHED_OFF_PATHS = new Set\(\[([\s\S]*?)\]\);/);
const listed = listMatch ? [...listMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
ok(!!listMatch, 'server.js declares SWITCHED_OFF_PATHS');
ok(JSON.stringify([...listed].sort()) === JSON.stringify([...SWITCHED_OFF].sort()),
  'the list names exactly the eight pages and their page-only scripts', listed.join(' '));
ok(listed.every(p => p === p.toLowerCase()), 'every entry is lower-case canonical');
ok((serverSrc.match(/const SWITCHED_OFF_PATHS\b/g) || []).length === 1
    && /app\.get\(\[\.\.\.SWITCHED_OFF_PATHS\]/.test(serverSrc)
    && /SWITCHED_OFF_PATHS\.has\(canonical\)/.test(serverSrc),
  'the list is declared once and read by both the literal route and the canonical guard');
ok(!/canonical === '\/planning\.html'/.test(serverSrc),
  'no per-page literal comparison survives beside the list');
const REMOVED = ['records', 'deepdive', 'bills', 'subscriptions', 'credit'];
for (const p of PAGES) {
  const onDisk = ['html', 'js'].map(ext => fs.existsSync(path.join(ROOT, 'public', `${p}.${ext}`)));
  if (REMOVED.includes(p)) {
    ok(!onDisk[0] && !onDisk[1], `public/${p}.html and public/${p}.js are removed (#822)`);
  } else {
    ok(onDisk[0] && onDisk[1], `public/${p}.html and public/${p}.js stay on disk until their removal slice`);
  }
}

const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const indexScripts = [...indexHtml.matchAll(/<script[^>]*\ssrc="([^"?]+)/g)].map(m => m[1]);
ok(indexScripts.length > 0, 'the main app loads scripts', indexScripts.join(' '));
ok(indexScripts.every(s => !SWITCHED_OFF.includes(s.toLowerCase())),
  'no script the main app loads is switched off');
const NAME = /(planning|bills|subscriptions|credit|records|deepdive|modellers|plan-spend)\.(html|js)/i;
for (const s of indexScripts) {
  const src = fs.readFileSync(path.join(ROOT, 'public', s.replace(/^\//, '')), 'utf8');
  const fetches = [...src.matchAll(/(?:fetch|import|importScripts)\s*\(\s*(['"`])([^'"`]*)\1/g)]
    .map(m => m[2]).filter(u => NAME.test(u));
  ok(fetches.length === 0, `${s} never fetches or imports a switched-off path`, fetches.join(' '));
  const links = [...src.matchAll(/href\s*=\s*\\?(['"`])\/?([^'"`\\]*)\\?\1/gi)]
    .map(m => m[2]).filter(u => NAME.test(u));
  ok(links.length === 0, `${s} never builds or targets a link to a switched-off page`, links.join(' '));
}
// The main app's own markup links nowhere that would only bounce back to /.
const PAGE_LINK = /href\s*=\s*(['"])\/?(?:planning|bills|subscriptions|credit|records|deepdive|modellers|plan-spend)(?:\.html|\.js)?(?:[?#/][^'"]*)?\1/gi;
const indexLinks = indexHtml.match(PAGE_LINK) || [];
ok(indexLinks.length === 0, 'public/index.html links to no switched-off page', indexLinks.join(' '));
// The pattern itself is not hollow: it catches each spelling the old markup used.
for (const probe of ['<a href="/deepdive.html">', "<a href='/records.html'>", '<a href="/Planning.HTML?x=1">', '<a href="/plan-spend">']) {
  ok((probe.match(PAGE_LINK) || []).length === 1, 'link pattern catches ' + probe);
}

/* ---- 2. HTTP behaviour through the real server ---- */
function isolatedEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  }
  env.ATLAS_LUNCHMONEY_CREDENTIAL_FILE = path.join(require('os').tmpdir(),
    'atlas-legacy-switch-off-no-credentials-' + process.pid, 'missing.dat');
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
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
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

/* Raw request: the path reaches the server byte-for-byte, so percent
 * encodings, dot segments and backslashes are not normalised away. */
function rawRequest(base, method, rawPath, cookie, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body != null) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
const rawGet = (base, p, cookie) => rawRequest(base, 'GET', p, cookie, null);
const isRootRedirect = res => res.status === 302 && res.headers.location === '/';
const isBudget = res => res.status === 200 && res.body.includes(BUDGET_MARKER);
// The old file's own bytes must never come back on any of these paths.
const fileBody = {};
// A removed page (#822) has no bytes to come back; any 200 with a body on its
// path would still be wrong, so it is compared against nothing and must not
// be a 200 at all.
for (const p of SWITCHED_OFF) {
  const file = path.join(ROOT, 'public', p.slice(1));
  fileBody[p] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
const servesFile = (res, p) => res.status === 200 && res.body.length > 0
  && (fileBody[p] === null || res.body.slice(0, 200) === fileBody[p].slice(0, 200));

/* Aliases of one path that express.static could resolve onto the same file
 * (POSIX) or that resolve onto it on the Windows runtime. */
function aliases(p) {
  const name = p.slice(1);
  const enc = '%' + name.charCodeAt(0).toString(16) + name.slice(1);
  return [
    p + '?x=1', p + '/', p.toUpperCase(), '/' + enc, p.replace('.', '%2E'),
    '/.' + p, '/' + p, '/zz/..' + p, p + '%2F..' + p,
    '/%5c' + name, p + '%2f', p + '::$DATA', p + '.', p + '%20', p + '.%20::$DATA',
  ];
}

(async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const atlas = await startAtlas(isolatedEnv({
    SITE_PASSWORD: PASS, SESSION_SECRET: SECRET, PORT: String(port),
  }));
  try {
    const login = await rawRequest(base, 'POST', '/login', null, `password=${encodeURIComponent(PASS)}`);
    const sc = login.headers['set-cookie'];
    const cookie = ((Array.isArray(sc) ? sc[0] : sc) || '').split(';')[0];
    ok(login.status === 302 && /^hfd_session=/.test(cookie), 'synthetic login issues a session');

    console.log('=== the main app is still served ===');
    for (const p of ['/', '/index.html']) {
      const res = await rawGet(base, p, cookie);
      ok(isBudget(res), `authenticated GET ${p} -> 200 main app`, `status ${res.status}`);
    }
    for (const s of indexScripts) {
      const res = await rawGet(base, s, cookie);
      ok(res.status === 200 && !res.headers.location, `main-app script ${s} -> 200`, `status ${res.status}`);
    }
    for (const p of ['/periods.json']) {
      const res = await rawGet(base, p, cookie);
      ok(res.status === 200 && !res.headers.location, `still-on path ${p} -> 200`, `status ${res.status}`);
    }

    console.log('=== each switched-off path (authenticated) ===');
    for (const p of SWITCHED_OFF) {
      const get = await rawGet(base, p, cookie);
      ok(isRootRedirect(get) && !servesFile(get, p), `GET ${p} -> 302 Location: /`,
        `status ${get.status}, location ${get.headers.location}`);
      const head = await rawRequest(base, 'HEAD', p, cookie, null);
      ok(isRootRedirect(head), `HEAD ${p} -> 302 Location: /`, `status ${head.status}`);
      const followed = await rawGet(base, get.headers.location || '/__none__', cookie);
      ok(isBudget(followed), `following ${p} lands on the main app`, `status ${followed.status}`);
      for (const a of aliases(p)) {
        const res = await rawGet(base, a, cookie);
        ok(!servesFile(res, p), `alias ${a} never serves the old file`, `status ${res.status}`);
        ok(isRootRedirect(res), `alias ${a} -> 302 Location: /`,
          `status ${res.status}, location ${res.headers.location}`);
      }
      const post = await rawRequest(base, 'POST', p, cookie, '');
      ok(post.status === 404, `POST ${p} is not absorbed by the GET/HEAD switch`, `status ${post.status}`);
    }

    console.log('=== the session gate still comes first ===');
    for (const p of SWITCHED_OFF) {
      for (const method of ['GET', 'HEAD']) {
        const res = await rawRequest(base, method, p, null, null);
        ok(res.status === 302 && res.headers.location === '/login',
          `unauthenticated ${method} ${p} -> 302 /login`, `status ${res.status}, location ${res.headers.location}`);
      }
    }
  } finally {
    await atlas.stop();
  }

  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('All legacy-page switch-off checks passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
