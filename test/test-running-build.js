'use strict';
// Exercise the authenticated HTML actually served by Atlas. No provider access.
const assert = require('assert/strict');
const net = require('net');
const path = require('path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('child_process');
const Build = require('../scripts/running-build');
const { makeHistory } = require('./test-build-provenance');
const ROOT = path.join(__dirname, '..');
const PASSWORD = randomBytes(24).toString('hex');
const SECRET = randomBytes(32).toString('hex');

async function browserProof(base, expected, suffix) {
  const { chromium } = require('playwright'); // optional; no new runtime dependency
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox'] });
  const errors = [], external = [];
  try {
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light' });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: require('./fixtures/budget-layout-data')() });
        if (['/periods.json', '/balance-history.json'].includes(url.pathname)) return route.fulfill({ json: null });
        return route.continue();
      });
      await context.request.post(base + '/login', { form: { password: PASSWORD } });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      // The previous page (kept at ?view=classic until C1): the label sits centred below Current Balance.
      await page.goto(base + '/?view=classic');
      await page.locator('.budget-step-summary').first().waitFor();
      const label = page.locator('.running-build');
      assert.equal(await label.innerText(), expected);
      const box = await label.boundingBox();
      const balance = await page.locator('[data-live-current-balance]').boundingBox();
      const align = await label.evaluate(el => getComputedStyle(el).textAlign);
      assert.ok(box && balance && box.height > 0 && box.height < 40 && box.y >= balance.y + balance.height - 1, JSON.stringify({ box, balance }));
      assert.equal(align, 'center');
      assert.equal(await label.evaluate(el => getComputedStyle(el).fontSize), '12px');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      // B7: the default Budget page is the Stack page; the label stays visible, centred, below it.
      await page.goto(base);
      await page.locator('#stack-root [data-stack-period]').first().waitFor();
      const stackLabel = page.locator('.running-build');
      assert.equal(await stackLabel.innerText(), expected);
      const stackBox = await stackLabel.boundingBox();
      const pile = await page.locator('#stack-root').boundingBox();
      assert.ok(stackBox && pile && stackBox.height > 0 && stackBox.height < 40 && stackBox.y >= pile.y + pile.height - 1,
        JSON.stringify({ stackBox, pile }));
      assert.equal(await stackLabel.evaluate(el => getComputedStyle(el).textAlign), 'center');
      assert.equal(await stackLabel.evaluate(el => getComputedStyle(el).fontSize), '12px');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const dir = process.env.ATLAS_BUILD_SCREENSHOTS_DIR;
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, `build-${suffix}-${width}.png`) });
      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], 'no external requests or GitHub dependency');
    console.log(`PASS full routed Budget build label ${suffix}: desktop 1440 / phone 390 / narrow 320, App.boot, synthetic financial JSON, centred below Current Balance (?view=classic) and below the Stack page (default), no overflow/errors/external requests`);
  } finally { await browser.close(); }
}

async function start(metadata) {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), SITE_PASSWORD: PASSWORD,
      SESSION_SECRET: SECRET, ATLAS_LIVE_OVERLAY: 'off', ...metadata },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out')); }, 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function main() {
  const h = makeHistory();
  const artifact = path.join(ROOT, Build.FILE);
  const previousArtifact = fs.existsSync(artifact) ? fs.readFileSync(artifact) : null;
  h.git('checkout', '--detach', h.merge);
  const mergeRecord = Build.capture(h.root);
  h.git('checkout', '--detach', h.squash);
  const squashRecord = Build.capture(h.root);
  h.git('checkout', '--detach', h.rebase);
  const rebaseRecord = Build.capture(h.root);
  let previousEtag = 'W/"previous-deployment"';
  let previousHtml;
  const cases = [
    [{ RENDER_GIT_COMMIT: h.merge, ATLAS_GIT_SHA: h.direct }, `Running PR #27 · ${h.merge.slice(0, 7)}`, mergeRecord],
    [{ RENDER_GIT_COMMIT: h.direct }, `Running commit ${h.direct.slice(0, 7)}`, mergeRecord],
    [{ RENDER_GIT_COMMIT: h.squash }, `Running PR #28 · ${h.squash.slice(0, 7)}`, squashRecord],
    [{ RENDER_GIT_COMMIT: h.rebase }, `Running PR #29 · ${h.rebase.slice(0, 7)}`, rebaseRecord],
    [{ RENDER_GIT_COMMIT: 'abcdef01'.repeat(5), ATLAS_GIT_SHA: '1111111' }, 'Running commit abcdef0'],
    [{ RENDER_GIT_COMMIT: '12345678'.repeat(5) }, 'Running commit 1234567'],
    [{ ATLAS_GIT_SHA: '7654321' }, 'Running commit 7654321'],
    [{}, 'Running build unavailable'],
    [{ RENDER_GIT_COMMIT: '<script>unsafe</script>', ATLAS_GIT_SHA: '7654321' }, 'Running build unavailable'],
  ];
  try {
  for (const [metadata, expected, record] of cases) {
    if (record) fs.writeFileSync(artifact, JSON.stringify(record));
    else if (fs.existsSync(artifact)) fs.unlinkSync(artifact);
    const { child, base } = await start(metadata);
    try {
      assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 302);
      assert.equal((await fetch(base + '/index.html', { redirect: 'manual' })).status, 302);
      const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: PASSWORD }) });
      assert.equal(login.status, 302);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      for (const route of ['/', '/index.html']) {
        const response = await fetch(base + route, { headers: { cookie,
          ...(previousEtag ? { 'if-none-match': previousEtag } : {}) } });
        assert.equal(response.status, 200, 'An old build validator must not hide a new build');
        assert.match(response.headers.get('cache-control'), /no-store/);
        assert.equal(response.headers.get('etag'), null, 'Build HTML does not reuse cache validators');
        const html = await response.text();
        assert.equal(html.match(/<p class="running-build"[^>]*>([^<]+)<\/p>/)[1], expected);
        assert.ok(html.indexOf('class="running-build"') < html.indexOf('id="operating-surface"'));
        assert.ok(html.includes("PR identity comes from this deployed commit's metadata"));
        assert.ok(!html.includes(PASSWORD) && !html.includes(SECRET) && !html.includes('<script>unsafe'));
        assert.equal(/Running PR/.test(html), /^Running PR/.test(expected), 'PR identity requires an exact deployed-SHA match');
        if (route === '/') {
          if (!previousHtml) previousHtml = html;
        }
      }
      assert.ok(previousHtml.includes(`Running PR #27 · ${h.merge.slice(0, 7)}`), 'Previously loaded HTML keeps its own build');
      const css = await fetch(base + '/running-build.css', { headers: { cookie } });
      assert.equal(css.status, 200);
      assert.match(css.headers.get('cache-control'), /no-store/);
      assert.equal((await fetch(base + '/.atlas-build.json', { headers: { cookie } })).status, 404,
        'server-only provenance artifact is not a browser endpoint');
      if (process.env.CHROME_PATH && (metadata.RENDER_GIT_COMMIT === h.merge || metadata.RENDER_GIT_COMMIT === h.direct)) {
        await browserProof(base, expected, metadata.RENDER_GIT_COMMIT === h.merge ? 'pr' : 'fallback');
      }
      if (process.env.ATLAS_BUILD_LOCAL_SMOKE && metadata.RENDER_GIT_COMMIT === h.merge) {
        process.stdout.write(execFileSync(process.execPath, ['test/test-local.js'], { cwd: ROOT,
          env: { PATH: process.env.PATH, TEST_BASE: base, TEST_PASSWORD: PASSWORD }, encoding: 'utf8' }));
      }
      console.log(`PASS authenticated Budget routes: ${expected}`);
    } finally {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
  }
  } finally {
    if (previousArtifact) fs.writeFileSync(artifact, previousArtifact);
    else if (fs.existsSync(artifact)) fs.unlinkSync(artifact);
    fs.rmSync(h.root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
