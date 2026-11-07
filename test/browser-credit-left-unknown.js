'use strict';
// "Credit left, everywhere" must read Unknown, never a precise sum, when any
// revolving facility has unpublished headroom (pending not observed). Before
// this, Forecast.utilisation summed that facility as $0 while the Credit page
// said "Not published" for it.
//
// Invented facilities, hand-computed (not from the code under test):
//   card-a  balance 1,000  pending 200  limit 5,000  → room 5,000 − 1,200 = 3,800
//   card-b  balance   500  pending unknown  limit 3,000 → room not published
//   Known case (card-b pending 0): 3,800 + (3,000 − 500) = 6,300
//
// CHROME_PATH=<Chromium> node test/browser-credit-left-unknown.js
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.join(__dirname, '..');
const CARD_A = { id: 'invented-card-a', label: 'Invented card A', structure: 'Revolving',
  secured: false, balance: 1000, pending: 200, limit: 5000, rate: 19.99 };
const CARD_B = { id: 'invented-card-b', label: 'Invented card B', structure: 'Revolving',
  secured: false, balance: 500, limit: 3000, rate: 19.99 };
const HAND_KNOWN_TOTAL = (5000 - (1000 + 200)) + (3000 - (500 + 0));

function withDebts(cardB) {
  const data = fx.served();
  // Keep the fixture's own facility untouched so its overlay mapping stays
  // valid, then add the two invented cards and remove any overdraft rows so
  // the hand total is exactly the cards below plus the fixture card.
  data.debts = (data.debts || []).concat([CARD_A, cardB]);
  data.revolvingExtra = [];
  // Deep Dive's historical sections read legacy analysis fields the Budget
  // fixture does not carry. Empty invented stand-ins let the page render; no
  // figure here feeds the credit tile.
  Object.assign(data.meta, { coverage: 'Invented coverage', transactions: 10, statements: 2, disclaimer: 'Invented' });
  Object.assign(data, {
    cashflow: [{ m: 'Jan', v: 100 }, { m: 'Feb', v: -50 }],
    income: [], counterparties: [], unexplained: [], questions: [],
    helocUse: [], helocChains: [], commitments: [], settled: [],
    paypal: { perMonth: 0, categories: [], crossCheck: '', note: '' },
    lacrosse: { sources: [], funding: [], perMonth: 0, note: '' },
  });
  return data;
}

async function capture(browser, data, route) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', intercepted => {
    const url = new URL(intercepted.request().url());
    if (url.origin !== 'http://budget.test') return intercepted.abort();
    if (url.pathname === '/data.json') return intercepted.fulfill({ json: data });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) {
      return intercepted.fulfill({ json: null });
    }
    if (url.pathname === '/talk/capability') return intercepted.fulfill({ json: { available: false } });
    if (url.pathname === '/talk/context') return intercepted.fulfill({ status: 404, body: '' });
    const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return intercepted.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css'
      : file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.woff2') ? 'font/woff2'
      : file.endsWith('.png') ? 'image/png'
      : 'text/html';
    return intercepted.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
  await page.goto('http://budget.test' + route);
  const container = route === '/deepdive.html' ? '#tiles' : '#snapshot-tiles';
  await page.waitForFunction(sel => {
    const el = document.querySelector(sel);
    return el && /Credit left, everywhere/.test(el.textContent || '');
  }, container, { timeout: 20000 });
  const tile = await page.evaluate(sel => {
    const tiles = Array.from(document.querySelectorAll(sel + ' .tile'));
    const hit = tiles.find(t => /Credit left, everywhere/.test(t.querySelector('.lab')?.textContent || ''));
    return hit ? { val: hit.querySelector('.val').textContent.trim(), note: hit.querySelector('.note').textContent.trim() } : null;
  }, container);
  await page.close();
  return { tile, errors };
}

(async () => {
  const failures = [];
  const ok = (cond, label, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!cond) failures.push(label);
  };
  const fixtureCard = fx.served().debts[0];
  const fixtureRoom = fixtureCard.limit - (fixtureCard.balance + (fixtureCard.pending || 0));
  const handKnown = HAND_KNOWN_TOTAL + fixtureRoom;
  const knownText = '$' + Math.round(handKnown).toLocaleString('en-CA');

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    const unknownData = withDebts(Object.assign({}, CARD_B, { pendingUnknown: true }));
    const knownData = withDebts(Object.assign({}, CARD_B, { pending: 0 }));
    for (const route of ['/index.html', '/deepdive.html']) {
      const unknown = await capture(browser, unknownData, route);
      ok(unknown.errors.length === 0, `${route} renders without page errors (unknown case)`, unknown.errors.join(' | '));
      ok(unknown.tile && unknown.tile.val === 'Unknown',
        `${route} Credit left reads Unknown when one card's pending is not observed`, unknown.tile && unknown.tile.val);
      ok(unknown.tile && !/\$\d/.test(unknown.tile.val + ' ' + unknown.tile.note),
        `${route} Credit left prints no dollar figure in the unknown case`, unknown.tile && unknown.tile.note);
      const known = await capture(browser, knownData, route);
      ok(known.errors.length === 0, `${route} renders without page errors (known case)`, known.errors.join(' | '));
      ok(known.tile && known.tile.val === knownText,
        `${route} Credit left is the hand total ${knownText} when every card is known`, known.tile && known.tile.val);
    }
  } finally {
    await browser.close();
  }
  console.log(failures.length ? `${failures.length} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
