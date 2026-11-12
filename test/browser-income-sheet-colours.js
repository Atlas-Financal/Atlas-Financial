'use strict';
/* Income pop-up colours (owner decision, #821 6811913067): in the Income sheet
 * a RECEIVED row reads green and a row still ARRIVING reads grey, matching the
 * rest of the page, where green means done. Before this the page's base rule
 * greyed received / already-in-balance rows and made an arriving amount bold
 * green; the Income card switches that off for its own rows, but the pop-up
 * sheet sits outside the card, so the base rule applied there.
 *
 * Invented fixture only (test/fixtures/budget-income-receipts); every network
 * request is intercepted, no server and no credentials. The rows the fixture
 * cannot reach (already in balance, the other-income receipts) are injected into
 * the open sheet with exactly the attributes and classes plan.js prints.
 *
 * Proved here, in light and dark, at 390 and 1440:
 *   - received and already-in-balance rows (name, status text, amount) read
 *     --success-text; the arriving amount reads --text-secondary and its name
 *     stays primary text;
 *   - nothing else in the sheet moved: a relied-upon row stays primary, a
 *     not-relied-upon row (and any "To confirm" row, which is not-relied-upon)
 *     stays secondary with its struck-through amount, a "To confirm" receipt
 *     keeps its plain treatment, and the weights are the weights they were;
 *   - the Income card on the page keeps its own rows (primary, weight 600);
 *   - text carries the status ("received", "arriving", "Received"), so colour is
 *     never the only signal;
 *   - the colours meet WCAG AA (4.5:1) against the sheet background.
 *
 * ATLAS_INCOME_SHEET_SHOTS_DIR=<dir> also writes one screenshot of the open sheet
 * per width and scheme; nothing is written otherwise. With
 * ATLAS_INCOME_SHEET_SHOTS_ONLY=1 it only takes the screenshots (used to capture the
 * "before" images on a checkout that does not have the change yet).
 *
 *   node test/browser-income-sheet-colours.js
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-income-receipts'), provider = require('../scripts/provider-observe');
const root = path.join(__dirname, '..');
const shots = process.env.ATLAS_INCOME_SHEET_SHOTS_DIR || '';
if (shots) fs.mkdirSync(shots, { recursive: true });

// Dale's pay received, Amanda's still arriving (observed on the 26th).
const OBSERVED = '2026-06-26';

const REFERENCE_ROWS = `
<div data-reference-rows>
  <p class="operating-note">Reference rows, injected for this proof (same markup plan.js prints)</p>
  <div class="operating-line" data-income-status="already in balance"><span>Reference paycheque <time class="budget-receipt-date">Jun 27 · already in balance</time></span><span data-income-line-amount>+$100.00</span></div>
  <div class="operating-line" data-income-status="not-relied-upon"><span>Reference to confirm <time class="budget-receipt-date">Jun 28 · deposit not confirmed</time></span><span data-income-line-amount>To confirm $50.00</span></div>
  <ul class="other-income-txs">
    <li class="other-income-tx" data-income-status="received"><time datetime="2026-06-27">Jun 27</time><span class="other-income-tx-payee">Reference receipt<span class="other-income-tx-received">Received</span></span><span class="other-income-tx-amount" data-income-line-amount>$25.00</span></li>
    <li class="other-income-tx" data-income-status="arriving"><time datetime="2026-06-29">Jun 29</time><span class="other-income-tx-payee">Reference expected<span class="other-income-tx-pending">Expected</span></span><span class="other-income-tx-amount" data-income-line-amount>$30.00</span></li>
    <li class="other-income-tx" data-income-status="to-confirm"><time datetime="2026-06-28">Jun 28</time><span class="other-income-tx-payee">Reference held receipt</span><span class="other-income-tx-amount" data-income-line-amount>To confirm $40.00</span></li>
  </ul>
</div>`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const errors = [], external = [];
  try {
    for (const scheme of ['light', 'dark']) for (const width of [390, 1440]) {
      const fixture = fx.build(fx.transactions(), fx.rules, provider, OBSERVED);
      const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 400, hasTouch: width < 400, colorScheme: scheme, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: fixture.data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.locator('[data-budget-surface]').waitFor();
      const tag = `${scheme} ${width}`;

      // The Income card on the page itself: its rows keep the card's own treatment.
      const cardRows = await page.evaluate(() => [...document.querySelectorAll('.atlas-income-card .operating-line[data-income-status]')]
        .map(el => ({ status: el.dataset.incomeStatus, amount: getComputedStyle(el.querySelector('span:last-child')).color, weight: getComputedStyle(el.querySelector('span:last-child')).fontWeight })));
      const primary = await page.evaluate(() => { const p = document.createElement('i'); p.style.color = 'var(--text-primary)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
      for (const row of cardRows) {
        assert.equal(row.amount, primary, `${tag}: an Income card ${row.status} row keeps primary text`);
        assert.equal(row.weight, '600', `${tag}: an Income card ${row.status} row keeps its weight`);
      }

      const income = page.locator('[data-operating-question="02"] > details > summary');
      await income.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open);
      await page.evaluate(html => { document.querySelector('[data-budget-detail-body]').insertAdjacentHTML('beforeend', html); }, REFERENCE_ROWS);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });

      const read = await page.evaluate(() => {
        const token = name => { const p = document.createElement('i'); p.style.color = `var(--${name})`; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
        const bgOf = el => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return 'rgb(255, 255, 255)'; };
        const body = document.querySelector('[data-budget-detail-body]');
        const rows = [...body.querySelectorAll('[data-income-status]')].map(el => {
          const amt = el.querySelector('[data-income-line-amount]') || el.lastElementChild;
          const name = el.querySelector('span') || el;
          const na = getComputedStyle(name), aa = getComputedStyle(amt), ra = getComputedStyle(el);
          return { tag: el.tagName.toLowerCase(), status: el.dataset.incomeStatus, reference: !!el.closest('[data-reference-rows]'),
            text: el.innerText.replace(/\s+/g, ' ').trim(), rowColor: ra.color, nameColor: na.color,
            amtColor: aa.color, amtWeight: aa.fontWeight, amtDecoration: aa.textDecorationLine, bg: bgOf(amt) };
        });
        const notes = [...body.querySelectorAll('.operating-line [data-income-original-plan]')].map(el => getComputedStyle(el).color);
        const tags = [...body.querySelectorAll('.other-income-tx-received, .other-income-tx-pending')].map(el => ({
          cls: el.className, text: el.textContent.trim(), color: getComputedStyle(el).color }));
        return { rows, tags, notes, success: token('success-text'), secondary: token('text-secondary'), primary: token('text-primary') };
      });

      if (shots) {
        const dialog = page.locator('[data-budget-detail-sheet]');
        await dialog.screenshot({ path: path.join(shots, `${width}-${scheme}.png`), animations: 'disabled' });
      }

      if (process.env.ATLAS_INCOME_SHEET_SHOTS_ONLY) { await page.close(); continue; }

      const op = (status, ref) => read.rows.filter(r => r.tag === 'div' && r.status === status && r.reference === ref);
      const li = status => read.rows.filter(r => r.tag === 'li' && r.status === status);
      const one = (rows, label) => { assert.ok(rows.length >= 1, `${tag}: a ${label} row is in the sheet`); return rows[0]; };

      // 1. Received rows read green: name, status text and amount.
      const received = op('received', false);
      assert.ok(received.length >= 1, `${tag}: the fixture has a received paycheque row`);
      for (const r of received) {
        assert.equal(r.rowColor, read.success, `${tag}: a received row reads green (row)`);
        assert.equal(r.amtColor, read.success, `${tag}: a received row reads green (amount)`);
        assert.equal(r.amtWeight, '450', `${tag}: a received row keeps its weight`);
        assert.match(r.text, /received/i, `${tag}: a received row says "received"`);
      }
      const inBalance = one(op('already in balance', true), 'already in balance');
      assert.equal(inBalance.rowColor, read.success, `${tag}: an already-in-balance row reads green`);
      assert.equal(inBalance.amtColor, read.success, `${tag}: an already-in-balance amount reads green`);
      assert.match(inBalance.text, /already in balance/i);

      assert.ok(read.notes.length >= 1, `${tag}: the received row has its Original plan note`);
      for (const c of read.notes) assert.equal(c, read.secondary, `${tag}: the Original plan note stays grey (supporting text)`);

      // 2. A row still arriving reads grey; its name stays primary, its weight is unchanged.
      const arriving = one(op('arriving', false), 'arriving');
      assert.equal(arriving.amtColor, read.secondary, `${tag}: an arriving amount reads grey`);
      assert.equal(arriving.nameColor, read.primary, `${tag}: an arriving name stays primary text`);
      assert.equal(arriving.amtWeight, '650', `${tag}: an arriving amount keeps its weight`);
      assert.match(arriving.text, /arriving/i, `${tag}: an arriving row says "arriving"`);

      // 3. Everything else is as it was.
      const notRelied = one(op('not-relied-upon', true), 'not-relied-upon / to confirm');
      assert.equal(notRelied.amtColor, read.secondary, `${tag}: a not-relied-upon / To confirm row stays secondary`);
      assert.match(notRelied.amtDecoration, /line-through/, `${tag}: a not-relied-upon amount stays struck through`);
      assert.equal(notRelied.amtWeight, '450');
      const relied = op('relied-upon', false);
      for (const r of relied) assert.equal(r.amtColor, read.primary, `${tag}: a relied-upon row stays primary`);

      // 4. The other-income receipts follow the same rule; a To confirm receipt is untouched.
      const recvLi = one(li('received'), 'received other-income receipt');
      assert.equal(recvLi.amtColor, read.success, `${tag}: a received other-income receipt reads green`);
      assert.equal(read.tags.find(t => /received/.test(t.cls)).color, read.success, `${tag}: the "Received" tag reads green`);
      assert.match(recvLi.text, /Received/, `${tag}: the receipt says "Received"`);
      const arrLi = one(li('arriving'), 'arriving other-income receipt');
      assert.equal(arrLi.amtColor, read.secondary, `${tag}: an arriving other-income receipt reads grey`);
      assert.match(arrLi.text, /Expected/, `${tag}: the arriving receipt says "Expected"`);
      const confirmLi = one(li('to-confirm'), 'To confirm receipt');
      assert.equal(confirmLi.amtColor, confirmLi.rowColor, `${tag}: a To confirm receipt keeps its plain treatment (the colour it inherits, neither green nor grey)`);
      assert.notEqual(confirmLi.amtColor, read.success); assert.notEqual(confirmLi.amtColor, read.secondary);
      assert.match(confirmLi.text, /To confirm/);

      // 5. WCAG AA (4.5:1) for the two colours against the sheet background.
      const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (fg, bg) => { const a = lum(rgb(fg)), b = lum(rgb(bg)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
      for (const [what, fg, bg] of [['received green', read.success, inBalance.bg], ['arriving grey', read.secondary, arriving.bg]]) {
        const r = ratio(fg, bg);
        assert.ok(r >= 4.5, `${tag}: ${what} text on the sheet meets AA (${r.toFixed(2)}:1)`);
        console.log(`        ${tag}: ${what} ${r.toFixed(2)}:1`);
      }

      console.log(`  PASS  ${tag}: received green, arriving grey, nothing else moved, AA`);
      await page.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(external, [], 'no external requests');
  console.log(process.env.ATLAS_INCOME_SHEET_SHOTS_ONLY ? '\nScreenshots written (assertions skipped).' : '\nAll Income-sheet colour checks passed.');
})().catch(err => { console.error(err); process.exit(1); });
