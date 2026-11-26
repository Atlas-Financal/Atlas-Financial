'use strict';
/* The Bills account stack card in a real browser, at phone width: real App.boot, the real public/ files, invented data
 * only (test/fixtures/bills-period-end-balance-data.js plus invented ledger rows, served for /data.json by route
 * interception; no server, no household data).
 *
 *   1. At 390 and 320 wide: the card is there, sky blue, closed it reads "Bills account", "Bank reading Aug 20" and
 *      "$1,373 now" with no bar; the page does not scroll sideways.
 *   2. Tapping the head opens it: shows only the Bills account's own current-pay-period ledger transactions, newest
 *      first (posted debit, posted credit reading as in with +, pending row reading as pending, transfer); Weekly,
 *      Savings, card, and out-of-period rows do not appear; removed sections (Coming in, Coming out, Household budget
 *      still to move, Already out) do not appear.
 *   3. Equal closed-card heights, in the default order and with each card last; opening grows the card taller.
 *   4. Stale, missing-observation, and pending-incomplete states: unreadable readings and unreadable lists show a dash
 *      with no explanatory sentence.
 *   5. An unpaired Bills transfer: still appears once on the open card with no matching/pairing and no sentence.
 *   6. No page errors; the other cards are unchanged in number and order.
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
  const d = fx.served(), pk = d.liveOverlay.currentPeriodActuals;
  pk.transactions.push(
    fx.tx('bills-credit', 'chequing-a', '2026-08-17', -412.50, 'Income', { displayedPayee: 'Invented Employer Payroll', isIncome: true }),
    fx.tx('bills-pending', 'chequing-a', '2026-08-20', 58.90, 'Utilities', { displayedPayee: 'Invented Pending Hydro', pending: true }),
    fx.tx('savings-tx', 'savings', '2026-08-19', 75.00, 'Transfer', { displayedPayee: 'Invented Savings Row', accountRole: 'household-reserve' }),
    fx.tx('prior-period-bills', 'chequing-a', '2026-08-13', 19.99, 'Utilities', { displayedPayee: 'Invented Prior Period' }),
  );
  if (mode === 'unpaired') pk.transactions = pk.transactions.filter(row => row.id !== 'weekly-credit');
  if (mode === 'stale') d.liveOverlay.operatingPlan = 'unavailable';
  if (mode === 'no-observation') d.liveOverlay.observedCash.accounts = d.liveOverlay.observedCash.accounts.filter(r => r.id !== 'chequing-a');
  if (mode === 'pending-incomplete') pk.pendingCoverage = 'partial';
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
      console.log(`1-2, 6. At ${width} wide`);
      const { page, errors } = await open(browser, width);
      const card = page.locator('[data-stack-card="billsacct"]');
      ok(await card.count() === 1, width + ': one Bills account card');
      const order = await page.$$eval('.sc-cards > .sc-card', els => els.map(e => e.getAttribute('data-stack-card')));
      ok(order[order.length - 1] === 'billsacct' && order.slice(0, -1).every(k => ['bills', 'budget', 'savings'].includes(k)),
        width + ': the Bills account card follows the existing cards, which keep their order', JSON.stringify(order));
      ok(await card.evaluate(e => getComputedStyle(e).backgroundColor) === 'rgb(191, 225, 246)', width + ': sky blue (#bfe1f6)');
      const head = flat(await card.locator('summary').innerText());
      ok(/Bills account/.test(head) && /Bank reading Aug 20/.test(head) && /\$1,373\s*now/.test(head), width + ': closed head unchanged', head);
      ok(await card.locator('.sc-bar').count() === 0, width + ': no bar');
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), width + ': no sideways scroll (closed)');
      await card.locator('summary').click();
      await page.waitForTimeout(200);
      const rows = await card.locator('.sc-row').evaluateAll(els => els.map(el => ({
        text: el.innerText.replace(/\s+/g, ' ').trim(),
        pending: el.classList.contains('sc-pending'),
        incoming: !!el.querySelector('.sc-in'),
      })));
      assert.deepEqual(rows, [
        { text: 'Invented Pending Hydro Aug 20 · Pending $58.90', pending: true, incoming: false },
        { text: 'Invented card-debit Aug 20 $111.11', pending: false, incoming: false },
        { text: 'Invented direct-grocery Aug 19 $31.27', pending: false, incoming: false },
        { text: 'AB123 TFR-TO invented Aug 18 $240.16', pending: false, incoming: false },
        { text: 'Invented Employer Payroll Aug 17 +$412.50', pending: false, incoming: true },
      ]);
      ok(true, width + ': open card shows only the 5 Bills account transactions, newest first, with pending and money-in styling');
      const body = flat(await card.innerText());
      ok(!/Coming in|Coming out|Household budget still to move|Already out/.test(body),
        width + ': retired sections are absent', body);
      ok(await card.locator('.sc-cap, .sc-why, .sc-check, [data-stack-sheet]').count() === 0,
        width + ': no section captions, explanatory text, paid checks, or bill sheet links');
      ok(!/weekly-dining|TFR-FR|Savings Row|card-purchase|Prior Period/i.test(body),
        width + ': Weekly, Savings, card, and prior-period rows do not appear', body);
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), width + ': no sideways scroll (open)');
      const overflow = await card.evaluate(c => [...c.querySelectorAll('.sc-row')].filter(r => r.scrollWidth > r.clientWidth + 1).length);
      ok(overflow === 0, width + ': no row overflows');
      if (shots) await card.screenshot({ path: path.join(shots, `bills-account-open-${width}.png`) });
      ok(errors.length === 0, width + ': no page errors', errors.join(' | '));
      await page.close();
    }
    console.log('3. Equal closed-card heights, in the default order and with each card last');
    for (const width of [390, 320]) {
      const { page, errors } = await open(browser, width);
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
        ok(new Set(cards.map(x => x.card)).size === 1, width + ' ' + label + ': every card is the same height, the last included', info);
        const strips = cards.filter(x => !x.last).map(x => x.strip);
        ok(new Set(strips).size === 1, width + ' ' + label + ': every card above the last shows the same visible strip', info);
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
      const closedHead = (await measure()).find(x => x.id === 'billsacct').head;
      await page.locator('[data-stack-card="billsacct"] > summary').click();
      await page.waitForTimeout(200);
      const opened = (await measure()).find(x => x.id === 'billsacct');
      ok(opened.card > closedHead && opened.head >= closedHead, width + ': open, the Bills account card is taller than closed', JSON.stringify(opened));
      ok(errors.length === 0, width + ': no page errors', errors.join(' | '));
      await page.close();
    }
    console.log('4. Unreadable reading and unreadable list states');
    for (const mode of ['stale', 'no-observation', 'pending-incomplete']) {
      const { page, errors } = await open(browser, 390, mode);
      const card = page.locator('[data-stack-card="billsacct"]');
      const head = flat(await card.locator('summary').innerText());
      if (mode === 'pending-incomplete') {
        ok(/Bills account/.test(head) && /Bank reading Aug 20/.test(head) && /\$1,373\s*now/.test(head),
          'pending-incomplete: bank reading head stays intact', head);
      } else {
        ok(/^Bills account\s*—$/.test(head), mode + ': only the title and a dash in the head', head);
      }
      if (shots) await card.screenshot({ path: path.join(shots, 'bills-account-' + mode + '-390.png') });
      await card.locator('summary').click();
      ok(await card.locator('.sc-why').count() === 0, mode + ': no explanatory sentence on the open card');
      if (mode === 'stale' || mode === 'pending-incomplete') {
        ok(flat(await card.locator('.sc-unavailable').innerText()) === '—', mode + ': unreadable list renders only a dash');
      }
      ok(errors.length === 0, mode + ': no page errors', errors.join(' | '));
      await page.close();
    }
    console.log('5. An unpaired Bills transfer stays visible once on the open card');
    {
      const { page, errors } = await open(browser, 390, 'unpaired');
      const card = page.locator('[data-stack-card="billsacct"]');
      await card.locator('summary').click();
      const transferRows = card.locator('.sc-row').filter({ hasText: 'AB123 TFR-TO invented' });
      ok(await transferRows.count() === 1, '390: unpaired transfer appears once');
      ok(flat(await transferRows.first().innerText()) === 'AB123 TFR-TO invented Aug 18 $240.16',
        '390: unpaired transfer shows its Lunch Money payee, date and amount');
      ok(await card.locator('.sc-cap, .sc-why').count() === 0, '390: no captions or explanatory sentence on the unpaired card');
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '390: unpaired card fits the viewport');
      ok(errors.length === 0, '390: no page errors', errors.join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${checks} checks passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
