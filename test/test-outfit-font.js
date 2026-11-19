'use strict';
/* F7 (lead ruling, ATLAS LEAD 11): the Stack Wallet page's Outfit font is self-hosted under the existing CSP.
 *
 *   1. The two Outfit woff2 subsets and the SIL OFL 1.1 licence live under public/fonts/, as Geist does.
 *   2. public/budget-stack-fonts.css declares them with same-origin /fonts/ URLs only: no other host, no data: URI.
 *   3. The real server (synthetic password, invented secret) serves each font and the stylesheet to a signed-in browser,
 *      byte-identical to the file, as font/woff2 and text/css, with the same CSP and gate behaviour as Geist.
 *      font-src stays 'self'.
 *   4. The current page does not load it: index.html references neither the stylesheet nor the font.
 *
 * The server starts on the repository's committed data.json (not an invented fixture), with a synthetic password,
 * as test-response-compression.js does. This test requests only /healthz, /login, the fonts, Geist, the stylesheet
 * and / (reading its CSP header only); it reads and prints no figure.
 * `node test/test-outfit-font.js`
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const FONTS = ['Outfit-latin.woff2', 'Outfit-latin-ext.woff2'];
const PASS = 'synthetic-outfit-font-password';
const SECRET = 'synthetic-outfit-font-session-secret-0123456789';

test('the font files are woff2 and carry their OFL licence', () => {
  for (const name of FONTS) {
    const bytes = fs.readFileSync(path.join(PUBLIC, 'fonts', name));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${name} is a woff2 file`);
    assert.ok(bytes.length > 1000 && bytes.length < 200000, `${name} is a plausible subset size (${bytes.length})`);
  }
  const licence = fs.readFileSync(path.join(PUBLIC, 'fonts', 'Outfit-LICENSE.txt'), 'utf8');
  assert.match(licence, /The Outfit Project Authors/, 'the licence names the Outfit authors');
  assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/, 'the licence is the SIL OFL 1.1 text');
});

test('the stylesheet points only at the same-origin font files', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'budget-stack-fonts.css'), 'utf8');
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(m => m[1]);
  assert.deepEqual(urls.slice().sort(), FONTS.map(f => '/fonts/' + f).sort(), 'exactly the two self-hosted files');
  assert.ok(!/https?:|\/\/|data:/.test(urls.join(' ')), 'no other host, no protocol-relative URL, no data: URI');
  assert.match(css, /font-family:\s*"Outfit"/, 'the family is "Outfit"');
  assert.match(css, /Outfit-LICENSE\.txt/, 'the stylesheet names the licence file');
});

test('the current page loads neither the stylesheet nor the font', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.ok(!/budget-stack-fonts\.css|Outfit/.test(html), 'index.html is unchanged by F7');
  // The Stack page's own stylesheets (public/stack*.css, B1) are the font's consumer; the shell links them only under
  // ?view=stack and scopes every rule to html.stack-view (test-stack-shell.js), so the current page never uses it.
  for (const name of fs.readdirSync(PUBLIC).filter(f => f.endsWith('.css') && f !== 'budget-stack-fonts.css' && !/^stack[.-]/.test(f))) {
    assert.ok(!/Outfit/.test(fs.readFileSync(path.join(PUBLIC, name), 'utf8')), `${name} does not use Outfit`);
  }
});

/* ------------------------------ real server ------------------------------ */
let child = null, port = 0, cookie = '';
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function request(p, headers = {}, method = 'GET', body = null) {
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
    try { if ((await request('/healthz')).status === 200) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`server start timeout\n${stderr}`);
    await new Promise(r => setTimeout(r, 200));
  }
  const login = await request('/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'POST',
    'password=' + encodeURIComponent(PASS));
  assert.equal(login.status, 302, 'synthetic login');
  cookie = login.headers['set-cookie'][0].split(';')[0];
});
after(() => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
});

const fontSrc = csp => (String(csp || '').split(';').map(s => s.trim()).find(s => s.startsWith('font-src')) || '');

test('server: each font is served same-origin, byte-identical, under font-src \'self\'', async () => {
  const geist = await request('/fonts/Geist.woff2', { cookie });
  assert.equal(geist.status, 200, 'control: Geist is served');
  for (const name of FONTS) {
    const r = await request('/fonts/' + name, { cookie });
    assert.equal(r.status, 200, `${name}: served`);
    assert.ok(r.raw.equals(fs.readFileSync(path.join(PUBLIC, 'fonts', name))), `${name}: byte-identical to the file`);
    assert.match(String(r.headers['content-type']), /^font\/woff2/, `${name}: font/woff2`);
    assert.equal(fontSrc(r.headers['content-security-policy']), "font-src 'self'", `${name}: font-src stays 'self'`);
    assert.equal(r.headers['content-security-policy'], geist.headers['content-security-policy'], `${name}: the same CSP as Geist`);
    const anon = await request('/fonts/' + name);
    const anonGeist = await request('/fonts/Geist.woff2');
    assert.equal(anon.status, anonGeist.status, `${name}: without a session, the gate answers as it does for Geist (${anon.status})`);
  }
  const css = await request('/budget-stack-fonts.css', { cookie });
  assert.equal(css.status, 200, 'the stylesheet is served');
  assert.match(String(css.headers['content-type']), /^text\/css/, 'as text/css');
  const page = await request('/', { cookie });
  assert.equal(page.status, 200);
  assert.equal(fontSrc(page.headers['content-security-policy']), "font-src 'self'", 'the page CSP keeps font-src \'self\'');
});
