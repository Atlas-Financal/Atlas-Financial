'use strict';
/* B4, the Stack Credit card and bottom sheet, in a real browser: real App.boot, the real public/ files, invented data
 * only (test/fixtures/budget-surface-data.js served for /data.json by route interception; no server, no household data).
 *
 * Until A6b (Forecast.stackCreditLines) is on main, the served forecast.js gains an invented stackCreditLines that
 * returns a hand-written publication; once A6b lands, the real function is used and only the shape checks apply.
 *
 *   1. ?view=stack: the Credit card prints "Credit" and the published paid / spent only for a complete total (a partial
 *      or missing total prints no figure and no bar; owner, 2026-11-20).
 *   2. Tapping the card opens the list: one row per line, HELOC minimum only.
 *   3. Tapping a row opens the sheet with that line; Escape closes it and focus returns to the row.
 *   4. No ratio or percent text and no explanatory word in the page or any sheet; no page errors.
 *
 * Optional: STACK_CREDIT_SHOTS=<dir> writes screenshots (390 and 1440, light and dark: closed, open, sheet).
 * `node test/browser-stack-credit.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
const shots = process.env.STACK_CREDIT_SHOTS || null;
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

// Invented, hand-written: names and amounts made up for the proof.
const STUB = `;(function (F) {
  if (!F || typeof F.stackCreditLines === 'function') return;
  window.__stackCreditStub = true;
  const fig = (amount, trust) => ({ amount, trust: trust || 'calculated', reasons: [] });
  const covered = value => ({ value, trust: value === 'unknown' ? 'unknown' : 'calculated', reasons: [] });
  F.stackCreditLines = () => ({
    lines: [
      { id: 'travelvisa', label: 'Blue Visa', paid: fig(400), spent: fig(400), net: fig(0), minimum: fig(25), toGo: fig(0),
        status: 'paid-back', minimumCovered: covered(true), transactions: [
          { date: '2026-08-11', name: 'Corner Grocer', amount: 150, kind: 'purchase', payment: false, pending: false },
          { date: '2026-08-14', name: 'Hardware Shop', amount: 250, kind: 'purchase', payment: false, pending: false },
          { date: '2026-08-18', name: 'Payment thank you', amount: -400, kind: 'payment', payment: true, pending: false },
          { date: '2026-08-19', name: 'Pending Cafe', amount: 12.5, kind: 'purchase', payment: false, pending: true }] },
      { id: 'cashback', label: 'Green Card', paid: fig(100), spent: fig(260, 'estimated'), net: fig(160, 'estimated'), minimum: fig(30), toGo: fig(160, 'estimated'),
        status: 'to-go', minimumCovered: covered(false), transactions: [] },
      { id: 'tdcc', label: 'Red Card', paid: fig(null, 'unknown'), spent: fig(null, 'unknown'), net: fig(null, 'unknown'),
        minimum: fig(15), toGo: fig(null, 'unknown'), status: null, minimumCovered: covered('unknown'), transactions: [] },
      { id: 'mbna', label: 'Gold Card', paid: fig(0), spent: fig(0), net: fig(0), minimum: fig(10), toGo: fig(null),
        status: 'upcoming', minimumCovered: covered('unknown'), transactions: [] },
      { id: 'heloc', label: 'Line of credit', paid: null, spent: null, net: null, minimum: fig(210), toGo: fig(null),
        state: 'not-a-spend-card', status: null, minimumCovered: covered('unknown'), transactions: [] },
    ],
    totals: { paid: 500, spent: 660, trust: 'calculated', completeness: 'partial', excluded: ['tdcc'], reasons: [],
      minimumsDue: { amount: 60, trust: 'calculated', reasons: [] }, minimumsDueCount: 4, minimumsCoveredCount: 2, minimumsCoveredTrust: 'calculated' },
  });
})(window.Forecast);\n`;

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' };
async function open(browser, { width = 390, theme = 'light', force = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://stack.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: fx.served() });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    let body = fs.readFileSync(file);
    if (u.pathname === '/forecast.js') body = body.toString('utf8') + (force ? STUB.replace("if (!F || typeof F.stackCreditLines === 'function') return;", 'if (!F) return;') : STUB);
    return route.fulfill({ body, contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://stack.test/?view=stack');
  await page.waitForSelector('#stack-root [data-stack-credit]', { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const textOf = (page, sel) => page.$eval(sel, el => el.innerText.replace(/\s+/g, ' ').trim());

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const { page, errors } = await open(browser);
    const stub = await page.evaluate(() => window.__stackCreditStub === true);
    console.log(stub ? '(invented stackCreditLines: A6b not on this tree)' : '(real Forecast.stackCreditLines)');

    console.log('1. closed card');
    const head = await textOf(page, '[data-stack-credit-toggle]');
    ok(/^Credit/.test(head), 'the card is titled Credit', head);
    if (stub) {
      ok(/^Credit paid \/ card minimums due \u2014 \/ \$[\d,.]+$/.test(head) && !!(await page.$('.stack-credit-bar')),
        'a partial paid total prints a soft dash over the published minimums due, with an empty track', head);
    } else {
      const complete = await page.evaluate(() => !!document.querySelector('[data-stack-credit-total]'));
      ok(/^Credit paid \/ card minimums due (\u2014|\$[\d,.]+)( \/ (\$[\d,.]+|\u2014))?$/.test(head),
        'the head is "Credit", its subtitle and the total paid over the minimums due (a dash when withheld)', head);
    }
    ok(!(await page.$('[data-stack-credit-excludes]')), 'no "excludes" line');

    console.log('2. open list');
    await page.click('[data-stack-credit-toggle]');
    await settle(page);
    const expanded = await page.$eval('[data-stack-credit-toggle]', el => el.getAttribute('aria-expanded'));
    ok(expanded === 'true' && !(await page.$eval('.stack-credit-exp', el => el.hasAttribute('inert'))), 'the list opens');
    const rows = await page.$$eval('.stack-credit-line', els => els.map(el => el.innerText.replace(/\s+/g, ' ').trim()));
    if (stub) {
      ok(JSON.stringify(rows) === JSON.stringify(['Blue Visa +$400 / $25',
        'Green Card −$160 / $30', 'Red Card \u2014 / $15', 'Gold Card $0 / $10',
        'Line of credit \u2014 / $210']), 'one row per published line, each "X / minimum"', JSON.stringify(rows));
      const coral = await page.$eval('.stack-credit-x.is-bad', el => getComputedStyle(el).color);
      ok(coral === 'rgb(200, 55, 45)', 'a card behind (spending above payments) is red', coral);
      const green = await page.$eval('.stack-credit-x.is-good', el => getComputedStyle(el).color);
      ok(green === 'rgb(15, 122, 67)', 'a card whose minimum is covered is green', green);
      const tick = await page.$eval('.stack-credit-tick.is-on', el => ({ bg: getComputedStyle(el).backgroundColor, w: el.getBoundingClientRect().width }));
      ok(tick.w === 24 && tick.bg !== 'rgba(0, 0, 0, 0)', 'the covered ✓ is a filled 24px circle', JSON.stringify(tick));
    } else ok(rows.length === 6, 'six lines', String(rows.length));
    // Row layout (the shell's bare button reset must not zero a row's divider or padding), and the text keeps its lines at the
    // design's card width (a 414px viewport gives the 358px card the mock uses; the page gutter itself is DISPLAY's).
    const layout = await page.$$eval('.stack-credit-line', els => els.map(el => { const cs = getComputedStyle(el);
      return { border: parseFloat(cs.borderTopWidth), pad: parseFloat(cs.paddingTop) }; }));
    ok(layout.length === rows.length && layout.every(l => l.border > 0 && l.pad >= 10), 'every row has its divider and its padding', JSON.stringify(layout));
    await page.setViewportSize({ width: 414, height: 1000 });
    await settle(page);
    const wrapped = await page.$$eval('.stack-credit-name small', els => els.filter(el => {
      const r = document.createRange(); r.selectNodeContents(el);
      return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size > 1; }).map(el => el.textContent));
    ok(wrapped.length === 0, 'at the design\'s 358px card width no row line wraps', wrapped.join(' | '));
    await page.setViewportSize({ width: 390, height: 1000 });
    await settle(page);

    console.log('3. sheet');
    await page.click('[data-stack-sheet="card:travelvisa"]');
    await page.waitForSelector('.stack-sheet');
    const sheet = await textOf(page, '.stack-sheet');
    if (stub) ok(/Blue Visa \+\$400 \/ \$25 Paid onto it \$400 Spent on it \$400 Minimum \$25 ✓/.test(sheet) && /Payment thank you \+\$400/.test(sheet) && !/estimated|calculated|≈/i.test(sheet),
      'the sheet prints the line\'s "X / minimum", its rows, payments with +, no tag', sheet);
    if (stub) {
      const big = await page.$eval('.stack-sheet-big', el => ({ size: getComputedStyle(el).fontSize, x: getComputedStyle(el.querySelector('.stack-credit-x')).color }));
      ok(big.size === '64px' && big.x === 'rgb(15, 122, 67)', 'the sheet\'s big figure is 64px and green for a covered card', JSON.stringify(big));
    }
    await page.keyboard.press('Escape');
    ok(!(await page.$('.stack-sheet')), 'Escape closes the sheet');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-stack-sheet') === 'card:travelvisa'),
      'focus returns to the row');

    console.log('3b. the designed figures, always against the invented lines (Dale, 2026-11-20: green when covered, red when behind)');
    {
      const forced = await open(browser, { force: true });
      const fp = forced.page;
      await fp.click('[data-stack-credit-toggle]');
      await settle(fp);
      const frows = await fp.$$eval('.stack-credit-line', els => els.map(el => el.innerText.replace(/\s+/g, ' ').trim()));
      ok(JSON.stringify(frows) === JSON.stringify(['Blue Visa +$400 / $25', 'Green Card −$160 / $30',
        'Red Card \u2014 / $15', 'Gold Card $0 / $10', 'Line of credit \u2014 / $210']), 'each row reads "X / minimum"', JSON.stringify(frows));
      const colour = sel => fp.$eval(sel, el => getComputedStyle(el).color);
      ok((await colour('.stack-credit-x.is-bad')) === 'rgb(200, 55, 45)' && (await colour('.stack-credit-x.is-good')) === 'rgb(15, 122, 67)',
        'a card behind is red and a card whose minimum is covered is green');
      const plain = await fp.$$eval('.stack-credit-fig', els => els.map(el => { const x = el.querySelector('.stack-credit-x'); return (x.classList.contains('is-good') ? 'is-good' : x.classList.contains('is-bad') ? 'is-bad' : 'plain'); }));
      ok(JSON.stringify(plain) === JSON.stringify(['is-good', 'is-bad', 'plain', 'plain', 'plain']), 'only the covered and the behind cards are coloured', plain.join());
      const ticks = await fp.$$eval('.stack-credit-tick', els => els.map(el => el.classList.contains('is-on')));
      ok(JSON.stringify(ticks) === JSON.stringify([true, false, false, false, false]), 'only the covered card has the filled ✓', ticks.join());
      const tick = await fp.$eval('.stack-credit-tick.is-on', el => ({ bg: getComputedStyle(el).backgroundColor, w: el.getBoundingClientRect().width }));
      ok(tick.w === 24 && tick.bg !== 'rgba(0, 0, 0, 0)', 'the covered ✓ is a filled 24px circle', JSON.stringify(tick));
      const mutedOf = await fp.$eval('.stack-credit-of', el => getComputedStyle(el).fontWeight);
      ok(mutedOf === '500', 'the "/ min" is the lighter weight');
      await fp.click('[data-stack-sheet="card:travelvisa"]');
      await fp.waitForSelector('.stack-sheet');
      const big = await fp.$eval('.stack-sheet-big', el => ({ size: getComputedStyle(el).fontSize, x: getComputedStyle(el.querySelector('.stack-credit-x')).color, t: el.innerText.replace(/\s+/g, ' ').trim() }));
      ok(big.size === '64px' && big.x === 'rgb(15, 122, 67)' && big.t === '+$400 / $25', 'the sheet\'s big figure is the same "X / min", 64px and green', JSON.stringify(big));
      const sh = await textOf(fp, '.stack-sheet');
      ok(/Paid onto it \$400 Spent on it \$400 Minimum \$25 ✓/.test(sh), 'the sheet rows: Paid onto it, Spent on it, Minimum with its ✓', sh);
      await fp.keyboard.press('Escape');
      await fp.click('[data-stack-sheet="card:tdcc"]');
      await fp.waitForSelector('.stack-sheet');
      ok(/Red Card \u2014 \/ \$15 .*Minimum \$15/.test(await textOf(fp, '.stack-sheet')), 'an unpublished paid and spent: "— / $15" and the minimum');
      ok(forced.errors.length === 0, 'no page errors', forced.errors.join('; '));
      await fp.close();
    }

    console.log('4. no ratio text, no explanatory words, no errors');
    // The whole Stack page with the waterfall's Credit row, the Credit card and every sheet opened in turn (owner,
    // 2026-11-20: names, numbers, bars and the ✓ only).
    // The design's Credit wording (Paid back, $X to go, covered / not yet, the sheet's Spent on it / Paid onto it) is allowed now (Dale,
    // 2026-11-20); every other explanatory word still fails.
    const FORBIDDEN = /Upcoming|excludes|\bDue\b|Comes out|unavailable|withheld|estimated|projected|≈/i;
    const seen = [];
    const wfToggle = await page.$('[data-wf-toggle="credit"]:not([disabled])');
    if (wfToggle) await wfToggle.click();
    seen.push(await page.$eval('#stack-root', el => el.innerText));
    for (const key of await page.$$eval('[data-stack-sheet]', els => [...new Set(els.map(el => el.getAttribute('data-stack-sheet')))])) {
      const target = await page.$(`[data-stack-sheet="${key}"]`);
      if (!target || !(await target.isVisible())) continue;
      await target.click();
      await page.waitForSelector('.stack-sheet');
      seen.push(await textOf(page, '.stack-sheet'));
      await page.keyboard.press('Escape');
    }
    // the Credit head's subtitle from the approved design, exactly, is the one allowed wording
    const clean = t => t.split('paid / card minimums due').join(' ').split('Not due this period').join(' ');
    const hits = seen.filter(t => FORBIDDEN.test(clean(t))).map(t => clean(t).match(FORBIDDEN)[0]);
    ok(seen.length > 3 && hits.length === 0, `no explanatory word on the page or in ${seen.length - 1} sheets`, hits.join(', '));
    ok(FORBIDDEN.test('Upcoming $5') && FORBIDDEN.test('Due Mar 5') && !FORBIDDEN.test('Paid back $5 to go Minimum $5 covered ✓'),
      'control: the word check catches the removed words and passes the page names');
    const all = await page.$eval('#stack-root', el => el.innerText);
    ok(!/%/.test(all), 'no percent text on the page');
    ok(errors.length === 0, 'no page errors', errors.join('; '));
    await page.close();

    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
        const p = (await open(browser, { width, theme })).page;
        const card = await p.$('[data-stack-credit]');
        await card.scrollIntoViewIfNeeded();
        await settle(p);
        await p.screenshot({ path: path.join(shots, `credit-closed-${width}-${theme}.png`) });
        await p.click('[data-stack-credit-toggle]');
        await p.waitForTimeout(50); await settle(p);
        await (await p.$('[data-stack-credit]')).screenshot({ path: path.join(shots, `credit-open-${width}-${theme}.png`) });
        await p.click('[data-stack-sheet="card:travelvisa"]');
        await settle(p);
        await p.screenshot({ path: path.join(shots, `sheet-card-${width}-${theme}.png`) });
        await p.close();
      }
      console.log('  screenshots written to ' + shots);
    }
  } finally {
    await browser.close();
  }
  console.log(`\nPASS Stack credit card and sheet in a browser (${checks})`);
})().catch(error => { console.error(error); process.exit(1); });
