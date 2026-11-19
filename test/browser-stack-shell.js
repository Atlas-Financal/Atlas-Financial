'use strict';
/* B1, the Stack Wallet page shell, in a real browser: real App.boot, the real public/ files, invented data only
 * (test/fixtures/budget-surface-data.js served for /data.json by route interception; no server, no household data).
 *
 *   1. ?view=classic (the previous page, kept until C1): unchanged. With the Stack scripts served or blocked, the
 *      rendered body is byte-identical; no Stack stylesheet, class or element appears.
 *   1b. B7, the switch-over: with no query (and with ?view=stack) the Stack page is the Budget page.
 *   5. B7 fail-safe: if the shell throws while drawing, it removes itself and the page is the classic page, body
 *      byte-identical to ?view=classic, never blank. Without JavaScript the default route and ?view=classic match.
 *   2. ?view=stack: the shell replaces the current page with the title "Budget", the quiet "Last updated" line from
 *      the overlay's sync instant (the current footer's rule), and one timeline chip per published pay period with its
 *      date, the current period marked and selected.
 *   3. Every printed amount is the published value it names: a chip prints its period's stackSummary.surplus amount,
 *      coral when negative, and nothing at all when none is published (never $0). Checked with invented published
 *      values (whole dollars, cents, negative, absent) and with main's engine, which publishes no surplus yet.
 *   4. Tapping a chip selects it; every registered block is called with ctx = { data, plan, recommendation,
 *      selectedPeriodKey, Forecast }, and the key follows the tap. "Now" returns to the current period.
 *
 * Optional: STACK_SHELL_SHOTS=<dir> writes before/after screenshots (390 and 1440, light and dark).
 * `node test/browser-stack-shell.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
const SYNC_AT = '2026-08-20T16:10:00.000Z';
const shots = process.env.STACK_SHELL_SHOTS || null;
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

function served() {
  const d = fx.served();
  d.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt = SYNC_AT;
  return d;
}
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' };
async function open(browser, { query = '', blockStack = false, width = 390, theme = 'light', tamperShell = null, js = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', javaScriptEnabled: js });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://stack.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: served() });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    if (blockStack && /^\/stack[.-]/.test(u.pathname)) return route.fulfill({ status: 404, body: '' });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    let body = fs.readFileSync(file);
    if (tamperShell && u.pathname === '/stack-shell.js') body = tamperShell(body.toString('utf8'));
    return route.fulfill({ body, contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://stack.test/' + query);
  if (js) await page.waitForFunction(() => !document.querySelector('[data-boot-notice]'), null, { timeout: 30000 });
  return { page, errors };
}
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    console.log('1. ?view=classic: the previous page is unchanged');
    {
      // The current page's wave animation stamps a time-based phase on each load (--blend-wave-phase); that one
      // value is normalised, everything else must match exactly.
      const a = await open(browser, { query: '?view=classic' }), b = await open(browser, { query: '?view=classic', blockStack: true });
      await settle(a.page); await settle(b.page);
      const bodyA = await a.page.evaluate(() => document.body.innerHTML.replace(/<script[^>]*><\/script>/g, '').replace(/--blend-wave-phase:\s*-?[\d.]+s;/g, '--blend-wave-phase:;'));
      const bodyB = await b.page.evaluate(() => document.body.innerHTML.replace(/<script[^>]*><\/script>/g, '').replace(/--blend-wave-phase:\s*-?[\d.]+s;/g, '--blend-wave-phase:;'));
      let at = 0;
      while (at < bodyA.length && bodyA[at] === bodyB[at]) at++;
      ok(bodyA === bodyB, 'the rendered body is identical with the Stack scripts served or blocked',
        `first difference at ${at}: served «${bodyA.slice(Math.max(0, at - 120), at + 120)}» blocked «${bodyB.slice(Math.max(0, at - 120), at + 120)}»`);
      const probe = await a.page.evaluate(() => ({ cls: document.documentElement.classList.contains('stack-view'),
        root: !!document.getElementById('stack-root'), css: [...document.querySelectorAll('link[rel=stylesheet]')]
          .some(l => /\/stack\/|budget-stack-fonts/.test(l.href)), blocks: typeof window.StackBlocks?.register }));
      ok(!probe.cls && !probe.root && !probe.css, 'no Stack class, element or stylesheet with ?view=classic', JSON.stringify(probe));
      ok(probe.blocks === 'function', 'StackBlocks exists for the block files');
      ok(a.errors.length === 0 && b.errors.length === 0, 'no page errors', a.errors.concat(b.errors).join('; '));
      await a.page.close(); await b.page.close();
    }

    console.log('1b. B7: the default route is the Stack page');
    for (const query of ['', '?view=stack']) {
      const { page, errors } = await open(browser, { query });
      await page.waitForSelector('#stack-root [data-stack-period]', { timeout: 30000 });
      const probe = await page.evaluate(() => ({ cls: document.documentElement.classList.contains('stack-view'),
        title: document.querySelector('#stack-root h1')?.textContent,
        hidden: [...document.querySelector('.wrap').children].filter(el => el.id !== 'stack-root' && !el.hasAttribute('data-boot-notice'))
          .every(el => getComputedStyle(el).display === 'none') }));
      ok(probe.cls && probe.title === 'Budget' && probe.hidden, `${query || '(no query)'}: the Stack page shows and the previous page is hidden`, JSON.stringify(probe));
      ok(errors.length === 0, `${query || '(no query)'}: no page errors`, errors.join('; '));
      await page.close();
    }

    console.log('2. ?view=stack: title, Last updated, one chip per published pay period');
    const { page, errors } = await open(browser, { query: '?view=stack' });
    await page.waitForSelector('#stack-root [data-stack-period]');
    const view = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('[data-stack-period]')];
      return { title: document.querySelector('#stack-root h1').textContent,
        updated: document.querySelector('[data-stack-updated]').textContent,
        current: [...document.querySelector('.wrap').children].filter(el => el.id !== 'stack-root' && !el.hasAttribute('data-boot-notice'))
          .every(el => getComputedStyle(el).display === 'none') && document.getElementById('stack-root').checkVisibility(),
        chips: chips.map(c => ({ key: c.dataset.stackPeriod, pressed: c.getAttribute('aria-pressed'),
          now: c.getAttribute('aria-current'), date: c.querySelector('.stack-chip-date').textContent,
          projected: c.classList.contains('is-projected'),
          dashed: getComputedStyle(c).borderTopStyle,
          amount: c.querySelector('[data-stack-chip-amount]').textContent })) };
    });
    const F = require('../public/forecast.js');
    const d = served();
    const views = F.recommend(d.plan, d.meta.asOf, F.budgetRecommendInputs(d, {})).payPeriodViews;
    ok(view.title === 'Budget' && view.current === true, 'title "Budget"; every part of the current page is hidden and the Stack root is shown', JSON.stringify([view.title, view.current]));
    const expectedUpdated = 'Last updated ' + new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(SYNC_AT));
    ok(view.updated === expectedUpdated, 'the Last updated line reads the overlay sync instant, as the current footer does', view.updated);
    ok(view.chips.length === views.length && view.chips.every((c, i) => c.key === views[i].start),
      `one chip per published pay period, in order (${views.length})`);
    const active = views.find(v => v.role === 'active');
    ok(view.chips.filter(c => c.pressed === 'true').map(c => c.key).join() === active.start
      && view.chips.filter(c => c.now === 'date').map(c => c.key).join() === active.start,
    'the current period is marked and selected', active.start);
    const dates = views.map(v => new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(v.start + 'T12:00:00Z')));
    ok(view.chips.every((c, i) => c.date === dates[i]), 'each chip shows its period start date');
    ok(views.some(v => v.evidenceState === 'projected') && views.some(v => v.evidenceState !== 'projected')
      && view.chips.every((c, i) => c.projected === (views[i].evidenceState === 'projected')
        && (c.dashed === 'dashed') === (views[i].evidenceState === 'projected')),
    'a projected view (evidenceState, as published) draws a dashed chip; historical and live views do not',
    JSON.stringify(view.chips.map((c, i) => [views[i].evidenceState, c.projected, c.dashed])));
    const words = await page.evaluate(() => document.getElementById('stack-root').textContent);
    ok(!/Projected|Past|Last pay period|This pay period/i.test(words), 'no period label anywhere on the Stack page (no text labels)');
    const head = await page.evaluate(() => ({ range: document.querySelector('.stack-period-range').textContent,
      text: document.querySelector('[data-stack-period-head]').textContent, dot: !!document.querySelector('[data-stack-period-now]') }));
    const fmt = iso => new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z'));
    const range = v => fmt(v.start) + ' \u2013 ' + (v.start.slice(0, 7) === v.end.slice(0, 7) ? String(Number(v.end.slice(8))) : fmt(v.end));
    ok(head.range === range(active) && head.text === range(active) && head.dot,
      'the shell heads the current period with its range and the current-period marker, and no words', JSON.stringify(head));
    const sheets = await page.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet]')].map(l => new URL(l.href).pathname)
      .filter(p => /^\/stack[.-]/.test(p)));
    ok(sheets.join() === ['/stack.css', '/stack-waterfall.css', '/stack-cards.css', '/stack-credit.css',
      '/stack-sheet.css'].join(), 'the shell and each block stylesheet are loaded under the flag', sheets.join());
    const frame = await page.evaluate(() => ({ pile: [...document.querySelector('[data-stack-pile]').querySelectorAll('[data-stack-block]')]
      .map(e => e.dataset.stackBlock), overlay: document.querySelector('[data-stack-block="sheet"]').closest('[data-stack-pile]') === null }));
    ok(frame.pile.join() === 'timeline,waterfall,cards,credit' && frame.overlay,
      'mount order: timeline, waterfall, cards, credit in the pile; the sheet outside it', JSON.stringify(frame));
    ok(views.every(v => !(v.stackSummary && v.stackSummary.surplus)) && view.chips.every(c => c.amount === ''),
      'main publishes no surplus yet, so every chip prints nothing: never $0');

    console.log('3. every printed amount is the published value it names');
    const invented = [1000, -250.5, null, 0.25, -3];
    await page.evaluate(values => {
      const original = Forecast.recommend;
      Forecast.recommend = function () {
        const r = original.apply(this, arguments);
        (r.payPeriodViews || []).forEach((v, i) => {
          const amount = values[i % values.length];
          if (amount !== null) v.stackSummary = Object.assign(v.stackSummary || {}, { surplus: { amount, trust: 'estimated' } });
        });
        return r;
      };
      App.rerender();
    }, invented);
    await settle(page);
    const printed = await page.evaluate(() => [...document.querySelectorAll('[data-stack-period]')].map(c => ({
      text: c.querySelector('[data-stack-chip-amount]').textContent, neg: c.classList.contains('is-neg'),
      valueNeg: c.querySelector('[data-stack-chip-amount]').classList.contains('is-neg') })));
    const want = { 1000: '+$1,000', '-250.5': '−$250.50', 0.25: '+$0.25', '-3': '−$3' };
    ok(printed.every((p, i) => {
      const v = invented[i % invented.length];
      return v === null ? p.text === '' && !p.neg : p.text === want[v] && p.neg === (v < 0) && p.valueNeg === (v < 0);
    }), 'each chip prints its published surplus exactly (+$1,000, −$250.50, +$0.25, −$3), coral when negative, nothing when absent',
    JSON.stringify(printed.slice(0, 5)));

    console.log('4. selection drives every block');
    await page.evaluate(() => {
      window.__stackCalls = [];
      window.StackBlocks.register('waterfall', (container, ctx) => {
        window.__stackCalls.push({ key: ctx.selectedPeriodKey, keys: Object.keys(ctx).sort().join(),
          sameRec: ctx.recommendation && ctx.recommendation.payPeriodViews.some(v => v.start === ctx.selectedPeriodKey),
          plan: ctx.plan === ctx.data.plan, forecast: ctx.Forecast === Forecast });
        container.textContent = 'test block ' + ctx.selectedPeriodKey;
      });
    });
    const target = views[views.length - 1].start;
    await page.click(`[data-stack-period="${target}"]`);
    const after = await page.evaluate(() => ({ calls: window.__stackCalls,
      pressed: [...document.querySelectorAll('[data-stack-period][aria-pressed="true"]')].map(c => c.dataset.stackPeriod),
      block: document.querySelector('[data-stack-block="waterfall"]').textContent }));
    const last = after.calls[after.calls.length - 1];
    const lastView = views[views.length - 1];
    const later = await page.evaluate(() => ({ text: document.querySelector('[data-stack-period-head]').textContent,
      dot: !!document.querySelector('[data-stack-period-now]') }));
    ok(lastView.evidenceState === 'projected' && later.text === range(lastView) && !later.dot,
      'another period is headed by its range alone: no label, no current marker', JSON.stringify(later));
    ok(after.pressed.join() === target && last.key === target && after.block === 'test block ' + target,
      'tapping a chip selects it and the block renders for that period', JSON.stringify(after.pressed));
    ok(last.keys === 'Forecast,data,plan,recommendation,selectedPeriodKey' && last.sameRec && last.plan && last.forecast,
      'the block receives ctx = { data, plan, recommendation, selectedPeriodKey, Forecast }', last.keys);
    await page.click('[data-stack-now]');
    const back = await page.evaluate(() => window.__stackCalls[window.__stackCalls.length - 1].key);
    ok(back === active.start, '"Now" returns to the current period');
    ok(errors.length === 0, 'no page errors under the flag', errors.join('; '));
    await page.close();

    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      for (const [width, theme] of [[390, 'light'], [390, 'dark'], [1440, 'light'], [1440, 'dark']]) {
        for (const [stage, opts] of [['before', { blockStack: true }], ['after', {}], ['after-invented-surplus', { inject: true }]]) {
          const x = await open(browser, { query: '?view=stack', width, theme, blockStack: !!opts.blockStack });
          if (opts.inject) {
            // Invented published values, to show the chip look before #1426 publishes a real surplus.
            await x.page.evaluate(values => {
              const original = Forecast.recommend;
              Forecast.recommend = function () {
                const r = original.apply(this, arguments);
                (r.payPeriodViews || []).forEach((v, i) => {
                  v.stackSummary = Object.assign(v.stackSummary || {}, { surplus: { amount: values[i % values.length], trust: 'estimated' } });
                });
                return r;
              };
              App.rerender();
            }, [420, 185, -90, 610, 240, -35, 380]);
          }
          await settle(x.page);
          await x.page.screenshot({ path: path.join(shots, `${stage}-${width}-${theme}.png`), fullPage: false });
          await x.page.close();
        }
      }
      console.log('  screenshots written to ' + shots);
    }
    console.log('5. B7 fail-safe and no JavaScript');
    {
      const normal = body => body.replace(/<script[^>]*><\/script>/g, '').replace(/--blend-wave-phase:\s*-?[\d.]+s;/g, '--blend-wave-phase:;');
      const classic = await open(browser, { query: '?view=classic' });
      await settle(classic.page);
      const classicBody = normal(await classic.page.evaluate(() => document.body.innerHTML));
      // The shell's own drawing throws (a tampered copy of stack-shell.js, served only to this page).
      const broken = await open(browser, { tamperShell: src => src.replace('function timelineHtml() {',
        "function timelineHtml() { throw new Error('invented shell failure');") });
      await settle(broken.page);
      const probe = await broken.page.evaluate(() => ({ cls: document.documentElement.classList.contains('stack-view'),
        root: !!document.getElementById('stack-root'), text: document.querySelector('.wrap').innerText.trim().length }));
      ok(!probe.cls && !probe.root && probe.text > 0, 'a shell failure removes the Stack page and the previous page shows (not blank)', JSON.stringify(probe));
      const brokenBody = normal(await broken.page.evaluate(() => document.body.innerHTML));
      ok(brokenBody === classicBody, 'after the fallback, the body is byte-identical to ?view=classic');
      ok(broken.errors.length === 0, 'the failure is caught (no uncaught page error)', broken.errors.join('; '));
      await classic.page.close(); await broken.page.close();
      const a = await open(browser, { js: false }), b = await open(browser, { query: '?view=classic', js: false });
      const [ba, bb] = [await a.page.evaluate(() => document.body.innerHTML), await b.page.evaluate(() => document.body.innerHTML)];
      ok(ba === bb && ba.trim().length > 0, 'without JavaScript, the default route and ?view=classic serve the same non-empty page');
      await a.page.close(); await b.page.close();
    }

    console.log(`\nPASS Stack shell browser checks (${checks})`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
