'use strict';
// Full browser proof for the dated bank balance (owner decision 2026-11-07):
// the real index.html, served from public/ with invented /data.json, renders
// the plan built from last evening's sync with its dated label, and a same-day
// sync renders the incumbent labels. Invented data only; every request is
// intercepted. The npm-test suite test/test-dated-bank-balance.js proves the
// same labels through the page's own renderers without a browser.
//   CHROME_PATH=<Chromium> node test/browser-dated-bank-balance.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { BALANCE_DAY, TODAY_SYNC, LAST_EVENING, observe } = require('./fixtures/dated-bank-balance-data');

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

async function pageProof() {
  console.log('\n=== rendered main page (index.html): dated label, informational note ===');
  const { chromium } = require('playwright'); // browser proof only; not an npm-test dependency
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
  const pub = path.join(ROOT, 'public');
  const origin = 'http://dated-balance.test';
  const errors = [], external = [];
  async function render(data) {
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== origin) { external.push(u.origin); return route.abort(); }
      if (route.request().method() !== 'GET') return route.abort();
      if (u.pathname === '/data.json') return route.fulfill({ json: data });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
      const file = path.resolve(pub, '.' + (u.pathname === '/' ? '/index.html' : u.pathname));
      if (!file.startsWith(pub + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(file),
        contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto(origin + '/');
    await page.locator('[data-budget-today-cash]').first().waitFor({ state: 'attached' });
    const result = await page.evaluate(() => {
      const card = document.querySelector('[data-budget-today-cash]');
      // The full refresh-trust card is the page's own renderer; it is mounted
      // on the safe-mode surface, so render it from the served packet here.
      const holder = document.createElement('div');
      holder.innerHTML = typeof refreshTrustHtml === 'function' ? refreshTrustHtml(App.data.refreshTrust) : '';
      const aside = holder.querySelector('.refresh-trust');
      const status = Array.from(document.querySelectorAll('span.muted'))
        .map(n => n.textContent).find(t => /Financial coverage/.test(t)) || '';
      return {
        eyebrow: card ? (card.querySelector('.budget-cash-eyebrow') || {}).textContent : '',
        heading: card ? (card.querySelector('h2') || {}).textContent : '',
        cardBalanceAsOf: card && card.getAttribute('data-balance-as-of'),
        state: aside && aside.getAttribute('data-refresh-trust-state'),
        balanceAsOf: aside && aside.getAttribute('data-balance-as-of'),
        warn: !!(aside && aside.classList.contains('warn')),
        text: aside ? aside.textContent.replace(/\s+/g, ' ') : '',
        status,
        unavailable: !!document.querySelector('[data-operating-plan="unavailable"]'),
        body: document.body.innerText,
      };
    });
    await page.close();
    return result;
  }
  try {
    const d = await render(observe({ at: LAST_EVENING }).data);
    ok(d.eyebrow === 'Balances as of October 13 · next bank sync pending' && d.cardBalanceAsOf === BALANCE_DAY,
      'main balance card reads "Balances as of October 13 · next bank sync pending"', d.eyebrow);
    ok(d.heading === 'Balance at latest bank sync', 'the balance is titled the latest bank sync, not "Current balance"', d.heading);
    ok(!/Today · October 1[34]/.test(d.body), 'no "Today" label is put on the dated balance');
    ok(/Financial coverage: latest bank sync, not today's balances\./.test(d.status),
      'the coverage line says latest bank sync, not today\'s balances', d.status);
    ok(d.state === 'dated-latest-update' && d.balanceAsOf === BALANCE_DAY, 'trust note is the dated latest-update state', d.state);
    ok(!d.warn, 'trust note is informational, not the warning tone');
    ok(/Latest update/.test(d.text) && /Balances as of October 13 · next bank sync pending\./.test(d.text),
      'trust note reads "Latest update · Balances as of October 13 · next bank sync pending"', d.text.slice(0, 160));
    ok(!/Attention needed/.test(d.text + d.body), 'no "Attention needed" error for a dated sync');
    ok(!d.unavailable && !/Current plan unavailable/.test(d.body), 'the plan renders; no "Current plan unavailable"');

    const s = observe({ at: TODAY_SYNC });
    const t = await render(s.data);
    ok(/^Today · October 14$/.test(t.eyebrow) && t.heading === 'Current balance' && !t.cardBalanceAsOf
      && t.state !== 'dated-latest-update' && !/next bank sync pending/.test(t.text + t.body),
      'control: a same-day sync renders the incumbent "Today" card and no dated label', t.eyebrow);
    ok(errors.length === 0, 'no page errors', errors.join(' | '));
    ok(external.length === 0, 'no external requests');
  } finally { await browser.close(); }
}

pageProof().then(() => {
  console.log(failures ? `\n${failures} failure(s)` : '\nAll dated bank balance browser checks passed.');
  process.exit(failures ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
