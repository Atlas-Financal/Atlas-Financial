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
 *   4. A stale or missing reading: the head is a dash without explanatory text.
 *   4b. An unpaired Bills debit: all three lists are visible, with the transfer once under Already out.
 *   6. Closed cards are all the same height whichever card is last (the Bills account card has no bar and a two-line head):
 *      the closed heads are equal, and each card's visible strip (its top to the next card's top, or its foot) agrees within
 *      the 4px by which the last card's foot padding (22px) exceeds the 18px of padding the next card leaves showing.
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
  if (mode === 'unpaired') pk.transactions = pk.transactions.filter(row => row.id !== 'weekly-credit');
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
      ok(await card.getByText('Transfer', { exact: true }).count() === 0, width + ': paired Weekly funding is not also an unpaired transfer');
      ok(await card.locator('.sc-why').count() === 0, width + ': paired control has no explanatory sentence');
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
    console.log('6. Equal closed-card heights, in the default order and with each card last');
    for (const width of [390, 320]) {
      const { page, errors } = await open(browser, width);
      // One entry per card slot (Credit included): the closed head's height, the card's height, and its visible strip.
      const measure = () => page.$$eval('[data-stack-pile] > [data-stack-slot]', els => els.map((slot, i) => {
        const c = slot.querySelector('details.sc-card, .stack-credit') || slot, h = c.querySelector('summary, .stack-credit-head') || c;
        const next = els[i + 1], top = c.getBoundingClientRect().top;
        const end = next ? (next.querySelector('details.sc-card, .stack-credit') || next).getBoundingClientRect().top : c.getBoundingClientRect().bottom;
        return { id: slot.getAttribute('data-stack-slot'), head: h.getBoundingClientRect().height, card: c.getBoundingClientRect().height, strip: end - top, last: !next };
      }));
      const check = async (label) => {
        const m = await measure(), cards = m.filter(x => x.id !== 'credit'), info = JSON.stringify(m);
        ok(cards.length >= 3 && cards.some(x => x.id === 'billsacct'), width + ' ' + label + ': the cards are there', info);
        ok(new Set(cards.map(x => x.head)).size === 1, width + ' ' + label + ': every closed card head is the same height', info);
        const notLast = cards.filter(x => !x.last);
        ok(new Set(notLast.map(x => x.card)).size === 1, width + ' ' + label + ': every card with another below it is the same height', info);
        const strips = cards.map(x => x.strip);
        ok(Math.max(...strips) - Math.min(...strips) <= 4, width + ' ' + label + ': the visible strip of every card agrees within 4px', info);
        return m;
      };
      await check('default order');
      const move = async (id, key, times) => {
        await page.locator('[data-stack-slot="' + id + '"] > details > summary').first().focus();
        for (let i = 0; i < times; i++) await page.keyboard.press(key);
        await page.waitForTimeout(100);
      };
      const n = (await measure()).length;
      await move('billsacct', 'Alt+ArrowDown', n);
      let m = await check('Bills account last');
      ok(m[m.length - 1].id === 'billsacct', width + ': the Bills account card is the last in the pile', JSON.stringify(m.map(x => x.id)));
      await move('bills', 'Alt+ArrowDown', n);
      m = await check('Bills last');
      ok(m[m.length - 1].id === 'bills', width + ': the Bills card is the last in the pile', JSON.stringify(m.map(x => x.id)));
      // Open, the card grows and nothing else moves out of line: the open card is taller than closed, the rest keep their height.
      const closedHead = (await measure()).find(x => x.id === 'billsacct').head;
      await page.locator('[data-stack-card="billsacct"] > summary').click();
      await page.waitForTimeout(200);
      const opened = (await measure()).find(x => x.id === 'billsacct');
      ok(opened.card > closedHead && opened.head >= closedHead, width + ': open, the Bills account card is taller than closed', JSON.stringify(opened));
      ok(errors.length === 0, width + ': no page errors', errors.join(' | '));
      await page.close();
    }
    console.log('4. A stale or missing Bills bank reading');
    for (const mode of ['stale', 'no-observation']) {
      const { page, errors } = await open(browser, 390, mode);
      const card = page.locator('[data-stack-card="billsacct"]');
      const head = flat(await card.locator('summary').innerText());
      ok(/^Bills account\s*—$/.test(head), mode + ': only the title and a dash in the head', head);
      if (shots) await card.screenshot({ path: path.join(shots, 'bills-account-' + mode + '-390.png') });
      await card.locator('summary').click();
      ok(await card.locator('.sc-why').count() === 0, mode + ': no explanatory sentence on the open card');
      if (mode === 'stale') ok(flat(await card.locator('.sc-unavailable').innerText()) === '—', 'stale: unreadable lists render as a dash');
      ok(errors.length === 0, mode + ': no page errors', errors.join(' | '));
      await page.close();
    }
    console.log('4b. A posted transfer out of Bills with no paired Weekly credit');
    {
      const { page, errors } = await open(browser, 390, 'unpaired');
      const card = page.locator('[data-stack-card="billsacct"]');
      await card.locator('summary').click();
      const captions = await card.locator('.sc-cap:visible').allTextContents();
      assert.deepEqual(captions, ['Coming in', 'Coming out · this pay period', 'Already out'], '390: all three sections are visible in order');
      const transfers = card.locator('.sc-row').filter({ has: page.getByText('Transfer', { exact: true }) });
      ok(await transfers.count() === 1, '390: exactly one transfer across the three lists');
      const transfer = transfers.first();
      const alreadyOutTransfers = card.locator('.sc-cap:text-is("Already out") ~ .sc-row').filter({ has: page.getByText('Transfer', { exact: true }) });
      ok(await alreadyOutTransfers.count() === 1, '390: the transfer belongs to Already out');
      ok(flat(await transfer.innerText()) === 'Transfer Aug 18 $240' && await transfer.locator('.sc-check').count() === 0,
        '390: the transfer has its posted date and displayed amount without a paid-bill check');
      ok(await card.locator('.sc-why').count() === 0, '390: no explanatory sentence on the unpaired card');
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '390: unpaired card fits the viewport');
      ok(errors.length === 0, '390: no page errors', errors.join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${checks} checks passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
