'use strict';
// Stored-XSS proof for the page renderers (external audit C2). Invented
// hostile strings — a label that closes a tag and opens <img onerror>, an id
// that closes a double-quoted attribute, a note carrying <script>, a category
// carrying </td><svg onload> — go into the invented household and through the
// REAL page renderers: renderBills, renderSubscriptions, renderCredit,
// renderRecords and renderDeepDive, plus the shared chart tooltips in app.js.
//
// Every HTML string those renderers assign is tokenised. The proof fails if
// any element outside the page's own vocabulary appears, if any attribute name
// is an event handler (on*), or if a hostile string does not survive as the
// exact same visible characters. Ordinary text with an apostrophe and an
// ampersand must display unchanged. The browser twin of this suite is
// test/browser-page-renderer-escaping.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const Forecast = require(path.join(root, 'public/forecast'));
const H = require('./fixtures/hostile-page-text');

const PAGES = {
  bills: 'renderBills',
  subscriptions: 'renderSubscriptions',
  credit: 'renderCredit',
};

// Elements these renderers legitimately build. An injected img, script, svg
// or anything else is outside it.
const ALLOWED_TAGS = new Set(['article', 'div', 'h2', 'h3', 'span', 'dl', 'dt', 'dd', 'small', 'b',
  'p', 'tr', 'td', 'strong', 'li', 'br', 'i']);

function render(page, data) {
  const elements = {};
  const created = [];
  const node = () => {
    const n = {
      innerHTML: '', textContent: '', hidden: true, dataset: {}, style: {}, children: [], listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      appendChild(c) { this.children.push(c); }, append() {}, replaceChildren(...c) { this.children = c; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { width: 1, height: 1 }; },
    };
    created.push(n);
    return n;
  };
  const document = {
    getElementById: id => elements[id] || (elements[id] = node()),
    createElement: node, createElementNS: node,
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {},
    documentElement: { dataset: {}, style: {} },
  };
  const ctx = vm.createContext({ Forecast, console, setTimeout, clearTimeout, addEventListener() {}, document,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' },
    innerWidth: 1000 });
  ctx.window = ctx;
  ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8')
    + ';App.boot=()=>{};App.once=()=>{};App.register=()=>{};', ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'public', page + '.js'), 'utf8'), ctx);
  ctx.D = data;
  vm.runInContext(PAGES[page] + '(D)', ctx);
  const sinks = Object.entries(elements).filter(([id, e]) => id !== 'tip' && e.innerHTML)
    .map(([id, e]) => ({ where: '#' + id, html: e.innerHTML }));
  // Fire every chart hover the page wired, and capture what the shared
  // tooltip was given.
  const tip = elements.tip;
  for (const n of created) {
    for (const fn of n.listeners.mousemove || []) {
      fn({ clientX: 1, clientY: 1 });
      sinks.push({ where: 'tooltip', html: tip.innerHTML });
    }
  }
  return sinks;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = s => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, k) => ENTITIES[k]);

// A strict tokeniser for the markup these renderers emit. Text may not hold a
// raw '<' that is not a tag; attribute values must be quoted. Anything else is
// reported as malformed rather than guessed at.
function tokenize(html) {
  const tags = [], attrs = [], text = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const end = lt < 0 ? html.length : lt;
    text.push(decode(html.slice(i, end)));
    if (lt < 0) break;
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt));
    if (!m) throw new Error(`raw "<" in text at ${lt}: ${html.slice(lt, lt + 40)}`);
    tags.push(m[1].toLowerCase());
    let j = lt + m[0].length;
    for (;;) {
      while (/\s/.test(html[j])) j++;
      if (html[j] === '>') { j++; break; }
      if (html.startsWith('/>', j)) { j += 2; break; }
      const a = /^([^\s"'>\/=]+)/.exec(html.slice(j));
      if (!a) throw new Error(`malformed tag at ${j}: ${html.slice(lt, j + 40)}`);
      const name = a[1].toLowerCase();
      j += a[0].length;
      let value = '';
      if (html[j] === '=') {
        const q = html[j + 1];
        if (q !== '"' && q !== "'") throw new Error(`unquoted attribute ${name}: ${html.slice(lt, j + 40)}`);
        const close = html.indexOf(q, j + 2);
        if (close < 0) throw new Error(`unterminated attribute ${name}`);
        value = decode(html.slice(j + 2, close));
        j = close + 1;
      }
      attrs.push({ tag: m[1].toLowerCase(), name, value });
    }
    i = j;
  }
  return { tags, attrs, text: text.join('') };
}

const all = Object.fromEntries(Object.keys(PAGES).map(page => [page, render(page, H.hostile())]));

for (const page of Object.keys(PAGES)) {
  test(`${page}: hostile strings render as inert text — no injected element or attribute`, () => {
    const sinks = all[page];
    assert.ok(sinks.length > 0, `${page} assigned no HTML`);
    for (const { where, html } of sinks) {
      const { tags, attrs } = tokenize(html);
      const foreign = tags.filter(t => !ALLOWED_TAGS.has(t));
      assert.deepEqual(foreign, [], `${page} ${where}: injected element(s)`);
      const handlers = attrs.filter(a => /^on/.test(a.name));
      assert.deepEqual(handlers, [], `${page} ${where}: injected event attribute(s)`);
      const strays = attrs.filter(a => !/^(class|data-[a-z0-9-]+)$/.test(a.name));
      assert.deepEqual(strays, [], `${page} ${where}: attribute outside the page vocabulary`);
    }
  });

  test(`${page}: the hostile label is shown as the same characters`, () => {
    const text = all[page].map(s => tokenize(s.html).text).join('\n');
    assert.ok(text.includes(H.LABEL), `${page}: ${H.LABEL} visible as text`);
  });
}

test('every hostile string reaches at least one renderer as visible text', () => {
  const text = Object.values(all).flat().map(s => tokenize(s.html).text).join('\n');
  // The crafted id and the note were shown as text only by the removed Records
  // and Deep Dive pages (#822). The remaining pages carry the id as an
  // attribute value, which the crafted-id test below checks, and do not
  // print notes.
  for (const p of [H.LABEL, H.CATEGORY]) assert.ok(text.includes(p), `not exercised: ${p}`);
});

test('a schedule label reaches Credit through Forecast as text', () => {
  for (const page of ['credit']) {
    const text = all[page].map(s => tokenize(s.html).text).join('\n');
    assert.ok(text.includes(H.CATEGORY), `${page}: the obligation label is visible as text`);
  }
});

test('ordinary text keeps its apostrophe and ampersand on every page that shows it', () => {
  for (const page of ['bills']) {
    const text = all[page].map(s => tokenize(s.html).text).join('\n');
    assert.ok(text.includes(H.ORDINARY), `${page}: ${H.ORDINARY} displays unchanged`);
    const html = all[page].map(s => s.html).join('\n');
    assert.ok(!html.includes('&amp;amp;'), `${page}: no double escaping`);
  }
});

test('a crafted id stays the exact attribute value, never a new attribute', () => {
  const ids = { bills: 'data-bill-id', subscriptions: 'data-subscription-id', credit: 'data-credit-id' };
  for (const [page, name] of Object.entries(ids)) {
    const attrs = all[page].flatMap(s => tokenize(s.html).attrs).filter(a => a.name === name);
    assert.ok(attrs.some(a => a.value.startsWith(H.ID)), `${page}: ${name} carries the crafted id verbatim`);
  }
});

test('the shared escape covers text and both attribute quote styles', () => {
  const ctx = vm.createContext({ document: { getElementById: () => null }, addEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }) });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8') + ';this.escapeHtml=escapeHtml;', ctx);
  assert.equal(ctx.escapeHtml(`<a href="x" title='y'>&`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
  assert.equal(ctx.escapeHtml(null), '');
  assert.equal(ctx.escapeHtml(undefined), '');
  assert.equal(ctx.escapeHtml(12.5), '12.5');
});

// Escaping must stay at the rendered value, never inside arithmetic: the
// Budget window arrows compute their bounds from the numeric index
// (a wrapped index made 2 + 1 the string "21" and disabled Next early).
test('Budget window arrows keep numeric bounds after escaping', () => {
  const planSrc = fs.readFileSync(path.join(root, 'public/plan.js'), 'utf8');
  const fn = /^function budgetWindowHeaderHtml\([\s\S]*?\n\}$/m.exec(planSrc);
  assert.ok(fn, 'budgetWindowHeaderHtml is readable');
  const render = index => vm.runInNewContext(`${fn[0]}\nbudgetWindowHeaderHtml({});`, {
    escapeHtml: require('./app-escape-html'),
    budgetWindowModel: () => ({ kind: 'pay-period', index, rows: new Array(8).fill({}), period: null, label: 'Invented window' }),
    budgetWindowProgressHtml: () => '', payPeriodNavigatorHtml: () => '',
  });
  const disabled = (html, label) => new RegExp(`aria-label="${label} pay period" aria-disabled="(true|false)"`).exec(html)[1];
  assert.equal(disabled(render(2), 'Next'), 'false', 'index 2 of 8: Next is enabled');
  assert.equal(disabled(render(2), 'Previous'), 'false', 'index 2 of 8: Previous is enabled');
  assert.equal(disabled(render(7), 'Next'), 'true', 'last window: Next is disabled');
  assert.equal(disabled(render(0), 'Previous'), 'true', 'first window: Previous is disabled');
});
