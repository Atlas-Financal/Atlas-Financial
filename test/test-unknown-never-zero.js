'use strict';
/* An unknown figure prints Unknown, never $0.00, $NaN, null or undefined,
 * and one malformed row degrades only itself.  `node test/test-unknown-never-zero.js`
 *
 * Every input here is invented. Each page script runs in a vm with the real
 * public/app.js formatters lifted verbatim, and the test reads the HTML the
 * household would read. The expected strings are written by hand; nothing is
 * computed by the code under test. Forecast is stubbed where the page only
 * prints what Forecast returned, so the proof is about the page's printing,
 * independent of the engine. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const appSrc = read('public/app.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const grab = (src, re, label) => {
  const m = re.exec(src);
  if (!m) throw new Error('missing ' + label);
  return m[0];
};
const helpers = [
  grab(appSrc, /^const money = .*$/m, 'money'),
  grab(appSrc, /^const money2 = .*$/m, 'money2'),
  grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
  grab(appSrc, /^const pct = .*$/m, 'pct'),
  grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
  grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
  grab(appSrc, /^const fmtDateFull = .*$/m, 'fmtDateFull'),
].join('\n');
// No unknown may leak as a figure or a JavaScript word.
const LEAKS = /\$NaN|NaN%|\bnull\b|\bundefined\b|\[object Object\]/;
const leak = html => (LEAKS.exec(html) || [null])[0];
// A section that throws is one failure, and the next section still runs.
const section = (name, fn) => {
  console.log('\n' + name);
  try { fn(); } catch (e) { ok(false, `${name} section completes`, e.message); }
};

/* ------------------------------------------------------------ formatters */
console.log('\nShared formatters');
const fmt = vm.runInNewContext(`${helpers}\n({ money, money2, pct })`);
for (const [value, name] of [[null, 'null'], [undefined, 'undefined'], ['', 'an empty string'],
  ['  ', 'a blank string'], ['n/a', 'a word'], [NaN, 'NaN'], [Infinity, 'Infinity'],
  [true, 'a boolean'], [{}, 'an object'], [[5], 'an array']]) {
  const shown = f => { try { return f(value); } catch (e) { return 'threw ' + e.message; } };
  ok(shown(fmt.money2) === 'Unknown' && shown(fmt.money) === 'Unknown' && shown(fmt.pct) === 'Unknown',
    `${name} prints Unknown in money2, money and pct`, `${shown(fmt.money2)} / ${shown(fmt.money)} / ${shown(fmt.pct)}`);
}
ok(fmt.money2(0) === '$0.00' && fmt.money(0) === '$0', 'a published zero is still $0.00 / $0');
ok(fmt.money2(-1234.5) === '−$1,234.50' && fmt.money(987.6) === '$988', 'finite numbers format as before');
ok(fmt.money2('42.10') === '$42.10' && (() => { try { return fmt.pct('19.99'); } catch (e) { return e.message; } })() === '19.99%',
  'a numeric string formats as its number');
ok(fmt.pct(7.5) === '7.50%', 'a numeric rate formats as before');

/* -------------------------------------------------------------------- Plan */
section('Plan debt answer', () => {
  const planSrc = read('public/plan.js');
  const fn = grab(planSrc, /^function operatingDebtAnswerHtml\([\s\S]*?\n\}$/m, 'operatingDebtAnswerHtml');
  const plan = vm.runInNewContext(`${helpers}\n${fn}\n({ operatingDebtAnswerHtml })`);
  const html = plan.operatingDebtAnswerHtml({
    requiredDebtPayments: { items: [
      { label: 'Invented loan', date: '2026-03-10', amount: null, confidence: 'confirmed' },
      { label: 'Invented card', date: '2026-03-12', amount: 35, confidence: 'confirmed' },
    ] },
    extraDebt: { allocated: 0 },
  });
  const loan = html.slice(html.indexOf('Invented loan'), html.indexOf('Invented card'));
  ok(/Unknown/.test(loan) && !/\$0\.00/.test(loan), 'a null required debt payment prints Unknown, not $0.00');
  ok(/data-debt-payment-amount="unknown"/.test(html) && /\$35\.00/.test(html), 'the unknown row is marked and the known row is unchanged');
});

/* ------------------------------------------------------ Card movements */
section('Budget card movements', () => {
  const CM = require('../public/budget-card-movements.js');
  const fmtMoney = vm.runInNewContext(`${helpers}\n({ money: money2, date: fmtDate })`);
  const goodCard = {
    id: 'card-a', label: 'Invented Card A', reportedBalance: { amount: 321.5, date: '2026-03-01' },
    opening: { date: '2026-02-01', amount: 100 }, closing: { date: '2026-03-01', amount: 321.5 }, reasons: [],
    postedCoverage: 'complete-provider-response', pendingCoverage: 'complete-provider-response',
    posted: [
      { id: 't1', date: '2026-02-10', payee: 'Invented shop', kind: 'charge', direction: 'up', magnitude: 20 },
      null,
      { id: 't3', date: '2026-02-11', payee: 'Invented cafe', kind: 'charge', direction: 'up', magnitude: NaN },
    ],
    pending: [],
  };
  const brokenCard = { id: 'card-b', label: 'Invented Card B', reportedBalance: null, reasons: undefined, posted: undefined, pending: [] };
  const pub = { schema: 'atlas-card-period-movements/v1', source: 'Forecast.cardPeriodMovements', currency: 'CAD',
    start: '2026-02-01', end: '2026-03-01', through: '2026-03-01', cards: [goodCard, brokenCard] };
  let html = '', threw = null;
  try { html = CM.html(pub, fmtMoney); } catch (e) { threw = e; }
  ok(!threw, 'a null transaction and a card with no reasons do not crash the card strip', threw && threw.message);
  ok(/\$321\.50/.test(html) && /Invented shop/.test(html) && /\$20\.00/.test(html), 'the good card and its good row still render');
  ok(/data-card-movement-transaction="unavailable"/.test(html), 'the null transaction prints one Unavailable row');
  ok(/data-budget-card-panel="card-b"[^>]*data-card-movement-unavailable="true"/.test(html), 'the malformed card panel prints as Unavailable');
  ok(!/\$NaN/.test(html) && !leak(html.replace(/data-[a-z-]+="[^"]*"/g, '')), 'the card strip prints no $NaN, null or undefined');

  // Each list varies on its own, with every other field valid (reasons: []),
  // so a list-only defect cannot hide behind a card-level failure.
  const ABSENT = Symbol('absent');
  const panelOf = (markup, id) => {
    const start = markup.indexOf(`data-budget-card-panel="${id}"`);
    const end = markup.indexOf('</section>', start);
    return start < 0 ? '' : markup.slice(start, end);
  };
  const validCard = id => ({
    id, label: 'Invented ' + id, reportedBalance: { amount: 50, date: '2026-03-01' },
    opening: { date: '2026-02-01', amount: 40 }, closing: { date: '2026-03-01', amount: 50 }, reasons: [],
    postedCoverage: 'complete-provider-response', pendingCoverage: 'complete-provider-response',
    posted: [], pending: [],
  });
  const sibling = Object.assign(validCard('card-ok'), {
    posted: [{ id: 's1', date: '2026-02-12', payee: 'Invented grocer', kind: 'charge', direction: 'up', magnitude: 10 }],
  });
  const siblingAlone = panelOf(CM.html(Object.assign({}, pub, { cards: [sibling] }), fmtMoney), 'card-ok');
  const EMPTY = { posted: 'No posted movements returned', pending: 'No pending authorizations returned' };
  for (const list of ['posted', 'pending']) {
    const other = list === 'posted' ? 'pending' : 'posted';
    for (const [label, value] of [['null', null], ['absent', ABSENT], ['an object', {}], ['a string', 'x']]) {
      const card = validCard('card-x');
      if (value === ABSENT) delete card[list]; else card[list] = value;
      let out = '', err = null;
      try { out = CM.html(Object.assign({}, pub, { cards: [card, sibling] }), fmtMoney); } catch (e) { err = e; }
      const panel = panelOf(out, 'card-x');
      ok(!err && /data-card-movement-list="unavailable"/.test(panel),
        `${list} list ${label}: prints unavailable`, err ? err.message : '');
      ok(!panel.includes(EMPTY[list]), `${list} list ${label}: never reads as observed empty activity`);
      ok(panel.includes(EMPTY[other]), `${list} list ${label}: the valid ${other} list keeps its empty-state wording`);
      ok(panelOf(out, 'card-ok') === siblingAlone, `${list} list ${label}: the valid sibling card is unchanged`);
    }
  }
  // An observed empty list still reads as empty.
  const emptyPanel = panelOf(CM.html(Object.assign({}, pub, { cards: [validCard('card-e')] }), fmtMoney), 'card-e');
  ok(emptyPanel.includes(EMPTY.posted) && emptyPanel.includes(EMPTY.pending) && !/data-card-movement-list/.test(emptyPanel),
    'an observed empty list still reads as no movements returned');
});

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
