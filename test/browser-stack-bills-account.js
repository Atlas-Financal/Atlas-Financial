'use strict';
/* The Bills account stack card in a real browser, at phone width: real App.boot, the real public/ files, invented data
 * only (test/fixtures/bills-period-end-balance-data.js plus three invented bills, served for /data.json by route
 * interception; no server, no household data).
 *
 *   1. At 390 and 320 wide: the card is there, sky blue, closed it reads "Bills account", "Bank reading Aug 20" and
 *      "$1,373 now" with no bar; the page does not scroll sideways.
 *   2. Tapping the head opens it: Coming in, Coming out (the late bill reads "late"), Household budget still to move,
 *      Already out; the Weekly-paid bill is not on it.
 *   3. Tapping a bill line opens that bill's sheet; Escape closes it.
 *   4. A stale reading: the head is a dash with the reason.
 *   4b. No Bills chequing observation (the plan row alone): the head is a dash with its reason, no "Bank reading".
 *   5. No page errors; the other cards are unchanged in number and order.
 *
 * Optional: STACK_BILLS_ACCOUNT_SHOTS=<dir> writes screenshots. `node test/browser-stack-bills-account.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/bills-period-end-balance-data');

const root = path.join(__dirname, '..');
const shots = process.env.STACK_BILLS_ACCOUNT_SHOTS || null;
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

function world(mode) {
  const d = fx.served(), p = d.plan, pk = d.liveOverlay.currentPeriodActuals;
  p.bills.push({ id: 'paid-bills', label: 'Invented paid utility', frequency: 'once', date: '2026-08-16', amount: 45.12, confidence: 'confirmed', payingAccount: 'chequing-a' });
  p.bills.push({ id: 'weekly-bill', label: 'Invented weekly-paid bill', frequency: 'once', date: '2026-08-22', amount: 51.30, confidence: 'confirmed', payingAccount: 'chequing-b' });
  p.bills.push({ id: 'late-bill', label: 'Invented late bill', frequency: 'once', date: '2026-08-18', amount: 62.40, confidence: 'confirmed', payingAccount: 'chequing-a' });
  pk.representedActuals.push({ id: 'paid-bills', date: '2026-08-16', actual: 45.12 });
  if (mode === 'stale') d.liveOverlay.operatingPlan = 'unavailable';
  // Only the Bills chequing observation is gone; the plan's Bills row stays (OD-037: a missing reading shows a dash).
  if (mode === 'no-observation') d.liveOverlay.observedCash.accounts = d.liveOverlay.observedCash.accounts.filter(r => r.id !== 'chequing-a');
  d.meta = { ...(d.meta || {}), asOf: fx.AS_OF };
  return d;
}
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const flat = s => String(s || '').replace(/\s+/g, ' ').trim();

async function open(browser, width, mode) {
  const page = await browser.newPage({ viewport: { width, height: 1400 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://stack.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: world(mode) });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://stack.test/');
  await page.waitForFunction(() => !document.querySelector('[data-boot-notice]') && document.querySelector('.sc-cards'), null, { timeout: 30000 });
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch();
  try {
    for (const width of [390, 320]) {
      console.log(`1-3, 5. At ${width} wide`);
      const { page, errors } = await open(browser, width);
      const card = page.locator('[data-stack-card="billsacct"]');
      ok(await card.count() === 1, width + ': one Bills account card');
      const order = await page.$$eval('.sc-cards > .sc-card', els => els.map(e => e.getAttribute('data-stack-card')));
      ok(order[order.length - 1] === 'billsacct' && order.slice(0, -1).every(k => ['bills', 'budget', 'savings'].includes(k)),
        width + ': the Bills account card follows the existing cards, which keep their order', JSON.stringify(order));
      ok(await card.evaluate(e => getComputedStyle(e).backgroundColor) === 'rgb(191, 225, 246)', width + ': sky blue (#bfe1f6)');
      const head = flat(await card.locator('summary').innerText());
      ok(/Bills account/.test(head) && /Bank reading Aug 20/.test(head) && /\$1,373\s*now/.test(head), width + ': closed head', head);
      ok(await card.locator('.sc-bar').count() === 0, width + ': no bar');
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), width + ': no sideways scroll (closed)');
      await card.locator('summary').click();
      await page.waitForTimeout(200);
      const body = flat(await card.innerText());
      ok(/Coming in Invented partner salary Aug 25 \$643/.test(body) && /Coming out · this pay period Invented late bill Aug 18 · late \$62/.test(body)
        && /Household budget still to move \$161/.test(body) && /Already out Invented paid utility Aug 16 \$45/.test(body), width + ': open card', body);
      ok(!/weekly-paid/i.test(body), width + ': the Weekly-paid bill is not on the card');
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), width + ': no sideways scroll (open)');
      const overflow = await card.evaluate(c => [...c.querySelectorAll('.sc-row')].filter(r => r.scrollWidth > r.clientWidth + 1).length);
      ok(overflow === 0, width + ': no row overflows');
      if (shots) await card.screenshot({ path: path.join(shots, `bills-account-open-${width}.png`) });
      const row = card.locator('[data-stack-sheet="bill:late-bill@2026-08-18"]');
      await row.click();
      await page.waitForSelector('.stack-sheet', { timeout: 5000 });
      ok(/Invented late bill/.test(flat(await page.locator('.stack-sheet').innerText())), width + ': the bill line opens its bill sheet');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.stack-sheet'), null, { timeout: 5000 });
      ok(true, width + ': Escape closes the sheet');
      ok(errors.length === 0, width + ': no page errors', errors.join(' | '));
      await page.close();
    }
    console.log('4. A stale reading');
    {
      const { page, errors } = await open(browser, 390, 'stale');
      const head = flat(await page.locator('[data-stack-card="billsacct"] summary').innerText());
      ok(/Bills account/.test(head) && /The current cash observation is untrusted\./.test(head) && head.includes('—') && !/\$/.test(head),
        'stale: a dash with the reason, no amount', head);
      if (shots) await page.locator('[data-stack-card="billsacct"]').screenshot({ path: path.join(shots, 'bills-account-stale-390.png') });
      ok(errors.length === 0, 'stale: no page errors', errors.join(' | '));
      await page.close();
    }
    console.log('4b. No chequing observation for Bills');
    {
      const { page, errors } = await open(browser, 390, 'no-observation');
      const head = flat(await page.locator('[data-stack-card="billsacct"] summary').innerText());
      ok(/Bills account/.test(head) && /No bank reading of the Bills account is available\./.test(head) && head.includes('—') && !/\$/.test(head) && !/Bank reading Aug/.test(head),
        'no observation: a dash with the reason, no amount, no "Bank reading <date>"', head);
      ok(errors.length === 0, 'no observation: no page errors', errors.join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${checks} checks passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
