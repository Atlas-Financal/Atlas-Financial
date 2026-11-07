'use strict';
// Real Budget shell, invented data, local release swap. Optional Playwright proof.
// NODE_PATH=<playwright modules> CHROME_PATH=<browser> node test/browser-app-release-resume.js
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const root = process.env.ATLAS_RELEASE_ASSETS || path.join(__dirname, '..', 'public');
const data = require('./fixtures/budget-layout-data')();
const OLD = '1111111', NEW = '2222222';

(async () => {
  let release = OLD, error = false, slow = false;
  const requests = [], errors = [], external = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push(pathname + new URL(req.url, 'http://localhost').search);
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/away') { res.setHeader('Content-Type', 'text/html'); return res.end('<title>Local navigation proof</title>'); }
    if (['/data.json', '/periods.json', '/balance-history.json'].includes(pathname)) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(pathname === '/data.json' ? data : null));
    }
    const file = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    let body = fs.readFileSync(file);
    if (pathname === '/' || pathname === '/index.html') {
      if (error) { res.writeHead(503); return res.end('unavailable'); }
      body = body.toString().replace('Running build unavailable', `Running commit ${release}`);
    }
    if (slow && pathname === '/index.html') return setTimeout(() => res.end(body), 150);
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const resume = async page => page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  const advance = async page => page.evaluate(() => {
    const prior = Date.now(); Date.now = () => prior + 30000;
  });
  const waitCheck = async page => {
    await page.waitForTimeout(250);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  };
  // ATLAS_RELEASE_ENGINE narrows the run to one engine. A name that matches
  // no engine must fail, never run zero browsers and report success.
  const engines = [chromium, webkit].filter(e => !process.env.ATLAS_RELEASE_ENGINE || e.name() === process.env.ATLAS_RELEASE_ENGINE);
  let completedRuns = 0;
  try {
    assert.ok(engines.length > 0, `ATLAS_RELEASE_ENGINE ${JSON.stringify(process.env.ATLAS_RELEASE_ENGINE)} matches no engine (chromium, webkit)`);
    for (const engine of engines) {
      const browser = await engine.launch(engine === chromium
        ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : {});
      try {
        for (const width of [390, 1440]) {
          release = OLD; error = false; slow = false; requests.length = 0;
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          await context.addInitScript(() => addEventListener('pageshow', event => {
            sessionStorage.setItem('synthetic-pageshow-persisted', String(event.persisted));
          }));
          await context.route('**/*', route => {
            if (new URL(route.request().url()).origin === base) return route.continue();
            external.push(route.request().url()); return route.abort();
          });
          await context.addCookies([{ name: 'synthetic-session', value: 'kept', url: base }]);
          const page = await context.newPage();
          page.on('pageerror', e => errors.push(e.message));
          await page.goto(base);
          await page.locator('.budget-step-summary').first().waitFor();
          assert.equal(await page.locator('.running-build').innerText(), `Running commit ${OLD}`);
          const figures = await page.locator('#operating-surface').innerText();
          const initialData = requests.filter(r => r.startsWith('/data.json')).length;
          await page.evaluate(() => {
            localStorage.setItem('synthetic-saved-answer', 'kept');
            const input = document.createElement('textarea');
            input.id = 'synthetic-draft'; input.value = 'Unsent household question';
            document.querySelector('.wrap').append(input); input.focus();
            window.syntheticPending = true;
          });
          await resume(page); await waitCheck(page);
          assert.equal(await page.locator('[data-app-release]').count(), 0, 'unchanged release is quiet');
          release = NEW;
          // A separate cold navigation already receives the new release.
          const cold = await context.newPage(); await cold.goto(base);
          await cold.locator('.budget-step-summary').first().waitFor();
          assert.equal(await cold.locator('.running-build').innerText(), `Running commit ${NEW}`);
          await cold.close();
          const dataBeforeResume = requests.filter(r => r.startsWith('/data.json')).length;
          const rootBefore = requests.filter(r => r === '/' || r === '/index.html').length;
          const probesBefore = requests.filter(r => r === '/index.html').length;
          await advance(page); slow = true;
          await page.evaluate(() => {
            for (let i = 0; i < 4; i++) window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
          });
          await waitCheck(page);
          console.log(JSON.stringify({ engine: engine.name(), width,
            retainedBuild: await page.locator('.running-build').innerText(),
            liveRelease: NEW, resumeShellReads: requests.filter(r => r === '/' || r === '/index.html').length - rootBefore,
            resumeDataReads: requests.filter(r => r.startsWith('/data.json')).length - dataBeforeResume }));
          assert.equal(await page.locator('[data-app-release]').count(), 1,
            'a retained old document must detect a newer release on resume');
          assert.equal(requests.filter(r => r === '/index.html').length - probesBefore, 1,
            'overlapping resume events coalesce');
          assert.equal(await page.locator('#synthetic-draft').inputValue(), 'Unsent household question');
          assert.equal(await page.evaluate(() => document.activeElement.id), 'synthetic-draft');
          assert.equal(await page.evaluate(() => window.syntheticPending), true);
          assert.equal(await page.evaluate(() => localStorage.getItem('synthetic-saved-answer')), 'kept');
          assert.equal(requests.filter(r => r.startsWith('/data.json')).length, dataBeforeResume);
          assert.equal(requests.some(r => r.includes('refresh=force')), false);
          assert.equal(await page.locator('#operating-surface').innerText(), figures, 'update detection leaves financial rendering unchanged');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          if (process.env.ATLAS_RELEASE_SCREENSHOTS) {
            fs.mkdirSync(process.env.ATLAS_RELEASE_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.ATLAS_RELEASE_SCREENSHOTS, `release-${engine.name()}-${width}.png`) });
          }
          // Even a user tap is cancellable; cancelled update retains input/session.
          page.once('dialog', dialog => dialog.dismiss());
          await page.getByRole('button', { name: 'Reload Atlas' }).click();
          assert.equal(await page.locator('#synthetic-draft').inputValue(), 'Unsent household question');
          page.once('dialog', dialog => dialog.accept());
          await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Reload Atlas' }).click()]);
          await page.locator('.budget-step-summary').first().waitFor();
          assert.equal(await page.locator('.running-build').innerText(), `Running commit ${NEW}`);
          assert.equal(await page.locator('[data-app-release]').count(), 0);
          assert.equal((await context.cookies()).find(c => c.name === 'synthetic-session').value, 'kept');
          assert.equal(await page.evaluate(() => localStorage.getItem('synthetic-saved-answer')), 'kept');
          for (let i = 0; i < 3; i++) { await advance(page); await resume(page); await waitCheck(page); }
          assert.equal(await page.locator('[data-app-release]').count(), 0, 'new release never loops');
          // Errors and offline resumes preserve the document without claiming an update.
          error = true; await advance(page); await resume(page); await waitCheck(page);
          assert.equal(await page.locator('[data-app-release]').count(), 0);
          await context.setOffline(true); await advance(page); await resume(page); await waitCheck(page);
          assert.equal(await page.locator('.running-build').innerText(), `Running commit ${NEW}`);
          await context.setOffline(false); error = false;
          const dataAfter = requests.filter(r => r.startsWith('/data.json')).length;
          await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await waitCheck(page);
          assert.equal(requests.filter(r => r.startsWith('/data.json')).length, dataAfter, 'visibility resumes do not fetch financial data');
          await page.goto(base + '/away'); await page.goBack();
          await page.locator('.budget-step-summary').first().waitFor();
          assert.equal(await page.locator('.running-build').innerText(), `Running commit ${NEW}`);
          console.log(`Actual history return ${engine.name()} ${width}: pageshow.persisted=${await page.evaluate(() => sessionStorage.getItem('synthetic-pageshow-persisted'))}`);
          assert.ok(initialData > 0);
          console.log(`PASS ${engine.name()} ${width}: cold/current, retained resume/update, coalescing, unchanged/repeat, offline/error, draft/pending/saved/session, deliberate cancellable reload; no forced financial refresh`);
          await context.close();
          completedRuns++;
        }
      } finally { await browser.close(); }
    }
    assert.equal(completedRuns, engines.length * 2, 'every selected engine ran both widths');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], 'no external requests');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
