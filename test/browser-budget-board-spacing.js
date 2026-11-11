'use strict';
/* Budget card board: no dead page gap under a card (Dale, 2026-11-11).
 * `node test/browser-budget-board-spacing.js`  (CHROME_PATH=<Chromium> optional)
 *
 * The #1057 board is a CSS grid whose rows are as tall as their tallest
 * card. With every card at its content height, the shorter cards of a row
 * left a band of empty page under them (on main 23d214e, invented fixture
 * at 1440px: 51px, 66px and 174px). The board now stretches each card to
 * its grid area.
 *
 * For each width (desktop 1440 / six columns, tablet 1024 / four, phone 390
 * / two) and for the default and a saved layout, this measures every card's
 * dead space: from its bottom edge to the top of the next card below it
 * that shares a column, or to the board's end, minus the board's row gap.
 * Above GAP_LIMIT fails. A card spanning one row beside two-row cards may
 * leave one empty grid track (one row gap, 18px) at the board's end; that
 * is the board's gutter, not a dead band, and sits under the limit.
 *
 * Safeguards:
 *   - figures stay top-aligned: each card's content sits at the same
 *     offset from the card's top edge as it does with the old content-
 *     height board (align-items: start), so the spare height is below the
 *     content, never above it (no vertical centring);
 *   - no text moves: the board's text is identical either way;
 *   - the saved layout is honoured: card order and sizes follow it.
 *
 * Invented fixture only (test/fixtures/budget-surface-data.js). Nothing
 * rendered is printed: failures name the card and the width, and report
 * pixel distances only.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
const GAP_LIMIT = 24;
const WIDTHS = [
  { width: 1440, cols: '6' },
  { width: 1024, cols: '4' },
  { width: 390, cols: '2' },
];
// A saved layout per width (the board's own storage shape): a different
// order and mixed sizes, so the check is not only about the defaults.
const SAVED = {
  narrow: { order: ['balance', 'house', 'bills', 'goals', 'cards'], sizes: { balance: 'XL', bills: 'L', house: 'L', cards: 'M', goals: 'M' } },
  mid: { order: ['balance', 'goals', 'cards', 'house', 'bills'], sizes: { balance: 'XL', bills: 'L', house: 'L', cards: 'L', goals: 'L' } },
  wide: { order: ['balance', 'bills', 'house', 'cards', 'goals'], sizes: { balance: 'XL', bills: 'L', house: 'L', cards: 'L', goals: 'L' } },
};
const widthKey = w => (w <= 759 ? 'narrow' : w <= 1199 ? 'mid' : 'wide');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

async function open(browser, width, saved) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  if (saved) {
    await page.addInitScript(layout => {
      try { localStorage.setItem('atlas-budget-board-v1', JSON.stringify(layout)); } catch (e) { /* default layout */ }
    }, saved);
  }
  const data = fx.served({});
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://budget.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: data });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.png') ? 'image/png' : file.endsWith('.woff2') ? 'font/woff2'
      : file.endsWith('.woff') ? 'font/woff' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
  await page.goto('http://budget.test/');
  await page.locator('[data-budget-surface]').waitFor();
  await page.locator('.blend-board > .blend-w').first().waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return { page, errors };
}

// Geometry of the board as rendered: card boxes, dead space under each,
// each card's content offset from its top edge, and the board's text.
function measure() {
  const board = document.querySelector('.blend-board');
  if (!board) return null;
  const gap = parseFloat(getComputedStyle(board).rowGap) || 0;
  const boardBox = board.getBoundingClientRect();
  const cards = [...board.querySelectorAll(':scope > .blend-w')].map(w => {
    const r = w.getBoundingClientRect();
    // The first rendered text inside the card's own content (not the
    // hidden layout controls): its top edge relative to the card's.
    let contentTop = null;
    const walker = document.createTreeWalker(w, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.textContent.trim() && !n.parentElement.closest('.blend-w-ctl')
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(n);
      const box = range.getBoundingClientRect();
      if (box.width && box.height) { contentTop = box.top - r.top; break; }
    }
    return { id: w.dataset.wId, size: w.dataset.size, left: r.left, right: r.right, top: r.top, bottom: r.bottom, contentTop };
  });
  for (const a of cards) {
    const below = cards.filter(c => c !== a && c.top >= a.bottom - 1 && c.left < a.right - 1 && c.right > a.left + 1)
      .sort((x, y) => x.top - y.top)[0];
    a.dead = Math.round((below ? below.top : boardBox.bottom + gap) - a.bottom - gap);
  }
  return { cols: board.dataset.cols, cards, text: board.innerText };
}

// The same board with the old content-height rule, for the top-alignment
// and no-text-change safeguards. Measured on the live page, then restored.
async function measureContentHeight(page) {
  return page.evaluate(async fn => {
    const board = document.querySelector('.blend-board');
    const before = board.style.alignItems;
    board.style.alignItems = 'start';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // eslint-disable-next-line no-new-func
    const out = new Function('return (' + fn + ')()')();
    board.style.alignItems = before;
    return out;
  }, measure.toString());
}

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    for (const { width, cols } of WIDTHS) {
      for (const [label, saved] of [['default layout', null], ['saved layout', { [widthKey(width)]: SAVED[widthKey(width)] }]]) {
        console.log(`\n=== ${width}px, ${label} ===`);
        const { page, errors } = await open(browser, width, saved);
        const now = await page.evaluate(measure);
        ok(!!now && now.cards.length === 5, 'the board renders its five cards');
        if (!now) { await page.close(); continue; }
        ok(now.cols === cols, `the board uses ${cols} columns`, String(now.cols));
        if (saved) {
          const want = SAVED[widthKey(width)];
          ok(now.cards.map(c => c.id).join() === want.order.join(), 'the saved card order is honoured');
          ok(now.cards.every(c => c.size === want.sizes[c.id]), 'the saved card sizes are honoured');
        }
        for (const card of now.cards) {
          ok(card.dead <= GAP_LIMIT, `no dead gap under ${card.id} (${card.size})`, `${card.dead}px, limit ${GAP_LIMIT}px`);
        }
        const old = await measureContentHeight(page);
        ok(old.text === now.text, 'no text changes on the board');
        for (const card of now.cards) {
          const was = old.cards.find(c => c.id === card.id);
          ok(card.contentTop != null && was && Math.abs(card.contentTop - was.contentTop) <= 1,
            `${card.id}: content stays top-aligned`,
            was ? `offset ${Math.round(card.contentTop)}px vs ${Math.round(was.contentTop)}px at content height` : 'missing');
        }
        ok(errors.length === 0, 'no page errors', errors.length ? String(errors.length) + ' error(s)' : '');
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('No dead gaps on the Budget card board.');
})().catch(err => { console.error(err); process.exit(1); });
