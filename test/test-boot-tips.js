'use strict';
// Loading-screen tips and household facts (Dale, 2026-11-18). While the
// boot notice is loading, a card under the status line shows one short line
// at a time: a plain tip, or (on a Manual Refresh, when the page already
// holds its last published spending history) a fact about that history.
//   1  the card renders inside the loading notice, aria-hidden, with one
//      line and one dot per line, the current dot on; Cancel stays the
//      notice's first child and the status text is unchanged;
//   2  it moves on by itself after ~6s, and on a tap;
//   3  a cold first load shows tips only; every line has no money pattern;
//      the list is the same on every load, and two loads on the same day
//      start on the same line (a boot is reproducible);
//   4  under prefers-reduced-motion nothing animates, but the line changes;
//   5  the crit (cancelled) surface carries no card and no drift;
//   6  /data.json is requested before the card exists;
//   7  facts come only from the history already in memory: a Manual Refresh
//      after a load with an invented history shows exactly the facts
//      hand-derived below, with no amount; facts read only an unbroken run
//      of fully covered months, so a gap, an uncovered month or a partial
//      first month changes them exactly as hand-derived; a history not
//      marked complete, or none at all, gives tips only;
//   8  the committed tip and fact copy in public/app.js has no digit or
//      currency sign (templates use placeholders).
// Served from public/ through page.route; every figure served is invented.
//
//   node test/test-boot-tips.js
//   BOOT_TIPS_SHOTS=1 node test/test-boot-tips.js   (also writes the
//   390px phone screenshots of the refresh screen with invented data,
//   light and dark, to docs/proof/boot-tips/)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Skip guard (test-suites-playwright-reach.js): the hosted npm test jobs
// install no browser library, so Playwright is loaded only when present.
let hasPlaywright = true;
try { require.resolve('playwright'); } catch { hasPlaywright = false; }
if (!hasPlaywright || process.env.ATLAS_SKIP_BROWSER === '1') {
  console.log('  SKIP  loading-tips browser cases: Playwright Chromium is not available here');
  process.exit(0);
}
const { chromium } = require('playwright');

const MONEY = /[\d$€£¢]/;
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

// served: { data, periods } answers the FIRST /data.json and /periods.json;
// every later /data.json (the Manual Refresh) is held. Without it, every
// /data.json is held and the page never leaves its first loading screen.
async function open(browser, contextOpts = {}, served = null) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...contextOpts });
  const page = await context.newPage();
  const order = [];
  let dataCalls = 0, periodCalls = 0;
  await page.route('**/*', async r => {
    const url = new URL(r.request().url());
    if (url.origin !== 'http://boot.test') return r.abort();
    if (url.pathname === '/data.json') {
      order.push('data');
      if (served && dataCalls++ === 0) return r.fulfill({ json: served.data });
      return; // held: never answered
    }
    if (url.pathname === '/periods.json') {
      return r.fulfill({ json: served && periodCalls++ === 0 ? served.periods : null });
    }
    if (['/balance-history.json', '/running-build.json'].includes(url.pathname)) return r.fulfill({ json: null });
    if (url.pathname === '/talk/capability') return r.fulfill({ json: { available: false } });
    if (url.pathname.startsWith('/talk/')) return r.fulfill({ status: 404, body: '' });
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(root, 'public', rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return r.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.png') ? 'image/png' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html';
    return r.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
  await page.exposeFunction('__tipsSeen', () => order.push('tips'));
  await page.addInitScript(() => {
    new MutationObserver((_, obs) => {
      if (document.querySelector('[data-boot-tips]')) { window.__tipsSeen(); obs.disconnect(); }
    }).observe(document, { childList: true, subtree: true });
  });
  return { context, page, order };
}

const state = page => page.evaluate(() => {
  const n = document.querySelector('[data-boot-notice]');
  const card = document.querySelector('[data-boot-tips]');
  const tip = card && card.querySelector('[data-boot-tip]');
  return {
    noticeClass: n && n.className,
    firstChild: n && n.children[0] && n.children[0].textContent,
    noticeLead: n && n.firstChild && n.firstChild.nodeType === 3 ? n.firstChild.textContent : null,
    card: !!card,
    hidden: card && card.getAttribute('aria-hidden'),
    insideNotice: !!(n && card && n.contains(card)),
    text: tip && tip.textContent,
    kind: card && card.getAttribute('data-boot-item-kind'),
    label: card && (card.querySelector('.boot-tips-label') || {}).textContent,
    index: card && Number(card.getAttribute('data-boot-tip-index')),
    dots: card ? card.querySelectorAll('.boot-tip-dots i').length : 0,
    on: card ? [...card.querySelectorAll('.boot-tip-dots i')].findIndex(d => d.classList.contains('is-on')) : -1,
    tipAnim: tip ? getComputedStyle(tip).animationName : null,
    driftAnim: n ? getComputedStyle(n, '::before').animationName : null,
    driftContent: n ? getComputedStyle(n, '::before').content : null,
  };
});
const waitLoading = page => page.waitForSelector('[data-boot-notice].is-loading [data-boot-tips]', { timeout: 15000 });

// Every line in one lap, by tapping through.
async function lap(page) {
  const first = await state(page);
  const lines = [];
  for (let k = 0; k < first.dots; k++) {
    const s = await state(page);
    lines.push({ kind: s.kind, label: s.label, text: s.text });
    await page.click('[data-boot-tips]');
  }
  return lines;
}

// An invented published history in the periods.json shape. Closed months
// Jan-Oct 2026; November is the current, partial month and is never used.
//   monthly spending: Jan 500, Feb 520, Mar 900, Apr 610, May 600, Jun 650,
//                     Jul 640, Aug 300, Sep 450, Oct 420 (Nov 100 current)
// Facts read an unbroken run of fully covered months counting back from
// October. Hand-derived for each variant:
//   full history (coverage from Jan 1): run Jan-Oct, 10 months
//     biggest March (900), lightest August (300)
//     last six = May 600, Jun 650, Jul 640, Aug 300, Sep 450, Oct 420;
//     less than the month before: Jun no, Jul yes, Aug yes, Sep no, Oct yes
//     -> 3 of the last 5
//     top category this year (essential/discretionary; business excluded):
//     Invented groceries (900 > 400)
//   July missing: run Aug-Oct, 3 months -> biggest September (450),
//     lightest August (300); too short for the month-on-month fact; the year
//     is not fully covered, so no category fact
//   September cards not covered: run Oct only -> no month facts; year not
//     covered -> tips only
//   fetch window starts Jan 15: January is partial, run Feb-Oct, 9 months ->
//     biggest March, lightest August, 3 of 5; the year is not covered from
//     its first day, so no category fact
//   uncategorised spending (categoryClaim incomplete), or the publisher's
//     year-to-date coverage false: the three month facts stay, the
//     category fact is withheld (the winner could change)
//   page clock in December (the history's November has ended): tips only
//   (coverageStart, the first transaction's date, is Jan 2 throughout and
//     never decides coverage: the fetch window's start does)
const MONTHLY = [['2026-01', 500], ['2026-02', 520], ['2026-03', 900], ['2026-04', 610], ['2026-05', 600],
  ['2026-06', 650], ['2026-07', 640], ['2026-08', 300], ['2026-09', 450], ['2026-10', 420], ['2026-11', 100]];
const EXPECTED_FACTS = [
  'Of the last 10 months, your biggest spending month was March.',
  'Of the last 10 months, your lightest spending month was August.',
  'In 3 of the last 5 months, you spent less than the month before.',
  'So far this year, your biggest spending category is Invented groceries.',
];
const EXPECTED_GAP = [
  'Of the last 3 months, your biggest spending month was September.',
  'Of the last 3 months, your lightest spending month was August.',
];
const EXPECTED_PARTIAL_START = [
  'Of the last 9 months, your biggest spending month was March.',
  'Of the last 9 months, your lightest spending month was August.',
  'In 3 of the last 5 months, you spent less than the month before.',
];
function inventedPeriods({ complete = true, queryWindowStart = '2026-01-01', drop = [], uncovered = [],
  categoryClaim = 'precise', ytdCoverageComplete = true } = {}) {
  const block = (label, months, coverageComplete = true) => ({ label, months, coverageComplete,
    spending: [
      { label: 'Invented groceries', total: 900, type: 'essential' },
      { label: 'Invented takeaway', total: 400, type: 'discretionary' },
      { label: 'Invented coaching costs', total: 5000, type: 'business' },
    ],
    spendingTotal: 6300, fees: [], feesTotal: 0, interest: [], interestTotal: 0 });
  return {
    asOf: '2026-11-14', thisMonth: '2026-11', lastMonth: '2026-10',
    source: { basis: 'invented', complete, categoryClaim, queryWindowStart,
      coverageStart: '2026-01-02', coverageThrough: '2026-11-14' },
    periods: { thisMonth: block('This month', 1), lastMonth: block('Last month', 1),
      ytd: block('Year to date', 11, ytdCoverageComplete), all: block('All', 11) },
    monthly: MONTHLY.filter(([m]) => !drop.includes(m))
      .map(([m, spending]) => ({ m, spending, interest: 0, fees: 0, cardsCovered: !uncovered.includes(m) })),
  };
}
const inventedData = () => require('./fixtures/budget-surface-data').served();

// First load completes with the given history; then Manual Refresh, whose
// /data.json is held, so the "Checking Lunch Money" screen stays up.
// The page's clock is fixed inside the invented history's own month
// (November 2026), unless a test moves it.
async function refreshScreen(browser, periods, contextOpts = {}, now = '2026-11-14T12:00:00') {
  const opened = await open(browser, contextOpts, { data: inventedData(), periods });
  await opened.context.clock.setFixedTime(new Date(now));
  await opened.page.goto('http://boot.test/?view=classic', { waitUntil: 'commit' });
  await opened.page.waitForSelector('[data-boot-notice]', { state: 'detached', timeout: 30000 });
  await opened.page.click('[data-manual-refresh]');
  await waitLoading(opened.page);
  return opened;
}

(async () => {
  const browser = await chromium.launch();
  try {
    console.log('1-3, 6: renders, rotates on time and on tap, static copy');
    {
      const { context, page, order } = await open(browser);
      await context.clock.install();
      await page.goto('http://boot.test/?view=classic', { waitUntil: 'commit' });
      await waitLoading(page);
      const s = await state(page);
      ok(s.card && s.insideNotice && s.hidden === 'true', 'the tips card is inside the loading notice and aria-hidden', JSON.stringify(s));
      ok(s.firstChild === 'Cancel', 'Cancel is still the notice\'s first child', s.firstChild);
      ok(s.noticeLead === 'Loading current data... This can take a couple of minutes. ', 'the status line is unchanged', JSON.stringify(s.noticeLead));
      ok(typeof s.text === 'string' && s.text.length > 10 && s.dots >= 5 && s.on === s.index,
        'one tip shown, one dot per tip, the current dot on', `${s.dots} dots, on ${s.on}, index ${s.index}`);
      ok(s.tipAnim === 'boot-tip-in' && s.driftAnim === 'boot-drift', 'the tip entrance and the background drift animate', `${s.tipAnim} / ${s.driftAnim}`);
      ok(order.indexOf('data') >= 0 && order.indexOf('data') < order.indexOf('tips'),
        '/data.json is requested before the tips card exists', order.join(' > '));

      await context.clock.runFor(5500);
      ok((await state(page)).index === s.index, 'the tip holds before ~6s');
      await context.clock.runFor(700);
      const t = await state(page);
      ok(t.index === (s.index + 1) % s.dots && t.text !== s.text && t.on === t.index, 'it moves to the next tip after ~6s', `${s.index} -> ${t.index}`);

      await page.click('[data-boot-tips]');
      const u = await state(page);
      ok(u.index === (t.index + 1) % s.dots, 'a tap skips to the next tip', `${t.index} -> ${u.index}`);
      await context.clock.runFor(5500);
      ok((await state(page)).index === u.index, 'a tap restarts the ~6s wait');

      const coldLines = await lap(page);
      const all = new Set(coldLines.map(x => x.text));
      ok(all.size === s.dots, 'a full lap shows every tip once', `${all.size} of ${s.dots}`);
      ok(coldLines.every(x => x.kind === 'tip' && x.label === 'Tip'), 'a cold first load holds no history: tips only',
        JSON.stringify(coldLines.filter(x => x.kind !== 'tip')));
      const money = [...all].filter(x => MONEY.test(x));
      ok(money.length === 0, 'no tip carries a digit or currency sign (no figures)', money.join(' | '));
      const again = await open(browser);
      await again.page.goto('http://boot.test/?view=classic', { waitUntil: 'commit' });
      await waitLoading(again.page);
      const s2 = await state(again.page);
      ok(s2.dots === s.dots && all.has(s2.text), 'the tip list is the same fixed copy on every load', s2.text);
      ok(s2.index === s.index, 'two loads on the same day start on the same tip', `${s.index} / ${s2.index}`);
      await again.context.close();

      console.log('5: the cancelled (crit) surface');
      await page.click('[data-boot-notice] button');
      await page.waitForSelector('[data-boot-notice].crit', { timeout: 10000 });
      const c = await state(page);
      ok(!c.card, 'no tips card on the crit surface');
      ok(c.driftContent === 'none' || c.driftAnim === 'none', 'no background drift on the crit surface', `${c.driftContent} / ${c.driftAnim}`);
      await context.clock.runFor(13000);
      ok(!(await state(page)).card, 'the stopped timer never brings the card back');
      await context.close();
    }

    console.log('4: prefers-reduced-motion');
    {
      const { context, page } = await open(browser, { reducedMotion: 'reduce' });
      await context.clock.install();
      await page.goto('http://boot.test/?view=classic', { waitUntil: 'commit' });
      await waitLoading(page);
      const s = await state(page);
      ok(s.tipAnim === 'none' && s.driftAnim === 'none', 'nothing animates under reduced motion', `${s.tipAnim} / ${s.driftAnim}`);
      await context.clock.runFor(6200);
      const t = await state(page);
      ok(t.index !== s.index && t.text !== s.text, 'the tip text still changes', `${s.index} -> ${t.index}`);
      await context.close();
    }

    console.log('7: facts come only from the history already in memory');
    {
      const { context, page } = await refreshScreen(browser, inventedPeriods());
      const s = await state(page);
      ok(/^Checking Lunch Money/.test(s.noticeLead || ''), 'the Manual Refresh loading screen is up', JSON.stringify(s.noticeLead));
      const lines = await lap(page);
      const facts = lines.filter(x => x.kind === 'fact');
      ok(JSON.stringify(facts.map(x => x.text).sort()) === JSON.stringify(EXPECTED_FACTS.slice().sort()),
        'exactly the hand-derived facts appear', JSON.stringify(facts.map(x => x.text)));
      ok(facts.every(x => x.label === 'Did you know?'), 'facts are labelled as facts');
      ok(lines.filter(x => x.kind === 'tip').length === 9, 'every tip still appears alongside the facts');
      ok(facts.every(x => !/[$€£¢]/.test(x.text) && !/\b(900|300|420|5000|6300)\b/.test(x.text)),
        'no fact shows an amount or currency sign');
      ok(!fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8').includes('Invented groceries'),
        'the category named in a fact comes from the served history, not the source');
      await context.close();
    }
    const factsFor = async (periods, now) => {
      const { context, page } = await refreshScreen(browser, periods, {}, now);
      const lines = await lap(page);
      await context.close();
      return lines.filter(x => x.kind === 'fact').map(x => x.text).sort();
    };
    const gap = await factsFor(inventedPeriods({ drop: ['2026-07'] }));
    ok(JSON.stringify(gap) === JSON.stringify(EXPECTED_GAP.slice().sort()),
      'a missing month ends the run: never compares non-adjacent months', JSON.stringify(gap));
    const uncov = await factsFor(inventedPeriods({ uncovered: ['2026-09'] }));
    ok(uncov.length === 0, 'a month with cards not covered ends the run: tips only here', JSON.stringify(uncov));
    const partial = await factsFor(inventedPeriods({ queryWindowStart: '2026-01-15' }));
    ok(JSON.stringify(partial) === JSON.stringify(EXPECTED_PARTIAL_START.slice().sort()),
      'a fetch window starting mid-month: that month is never used, and no year fact', JSON.stringify(partial));
    const stale = await factsFor(inventedPeriods(), '2026-12-02T12:00:00');
    ok(stale.length === 0, 'a history from a month that has ended (tab left open) gives tips only', JSON.stringify(stale));
    const monthsOnly = EXPECTED_FACTS.slice(0, 3).sort();
    const claim = await factsFor(inventedPeriods({ categoryClaim: 'incomplete' }));
    ok(JSON.stringify(claim) === JSON.stringify(monthsOnly),
      'uncategorised spending withholds the category fact', JSON.stringify(claim));
    const ytdCov = await factsFor(inventedPeriods({ ytdCoverageComplete: false }));
    ok(JSON.stringify(ytdCov) === JSON.stringify(monthsOnly),
      'the publisher\'s year-to-date coverage false withholds the category fact', JSON.stringify(ytdCov));
    {
      const { context, page } = await refreshScreen(browser, inventedPeriods({ complete: false }));
      const lines = await lap(page);
      ok(lines.every(x => x.kind === 'tip'), 'a history not marked complete gives tips only', JSON.stringify(lines.filter(x => x.kind !== 'tip')));
      await context.close();
    }
    {
      const { context, page } = await refreshScreen(browser, null);
      const lines = await lap(page);
      ok(lines.every(x => x.kind === 'tip'), 'no history in memory gives tips only');
      await context.close();
    }

    console.log('8: the committed tip and fact copy has no figure');
    {
      const src = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
      const block = (startText, endText) => { const a = src.indexOf(startText); const b = src.indexOf(endText, a); return a >= 0 && b > a ? src.slice(a, b) : ''; };
      const tipsSrc = block('const BOOT_TIPS = Object.freeze([', ']);');
      const factsSrc = block('const BOOT_FACT_TEMPLATES = Object.freeze({', '});');
      const strings = (tipsSrc + factsSrc).match(/'(?:[^'\\]|\\.)*'/g) || [];
      ok(tipsSrc && factsSrc && strings.length >= 13, 'the tip and fact copy blocks are found', String(strings.length));
      const bad = strings.filter(x => /[\d$€£¢]/.test(x.replace(/\\u[0-9a-fA-F]{4}/g, '')));
      ok(bad.length === 0, 'no digit or currency sign in any committed tip or fact string', bad.join(' | '));
      const holders = new Set((factsSrc.match(/\{(\w+)\}/g) || []));
      ok([...holders].every(h => ['{month}', '{category}', '{count}', '{total}'].includes(h)), 'fact templates use only placeholders', [...holders].join(','));
    }

    if (process.env.BOOT_TIPS_SHOTS === '1') {
      const outDir = path.join(root, 'docs', 'proof', 'boot-tips');
      fs.mkdirSync(outDir, { recursive: true });
      for (const scheme of ['light', 'dark']) {
        const { context, page } = await refreshScreen(browser, inventedPeriods(),
          { deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce' });
        for (let k = 0; k < 20 && (await state(page)).kind !== 'fact'; k++) await page.click('[data-boot-tips]');
        await page.screenshot({ path: path.join(outDir, `loading-facts-${scheme}-390.png`) });
        await context.close();
      }
      console.log('  wrote docs/proof/boot-tips/loading-facts-{light,dark}-390.png (invented data)');
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
