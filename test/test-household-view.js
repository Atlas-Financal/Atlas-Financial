'use strict';
/* Plain-language homepage acceptance.
 *
 * The underlying operating answer remains public/plan.js + Forecast. This
 * suite proves the household readability layer stays downstream of that
 * answer, does not become a planner, and groups repetitive diagnostics rather
 * than dumping them onto the default phone view.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const H = require('../public/household-view.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

console.log('=== default homepage speaks to the household first ===');
{
  const html = read('public/index.html');
  ok(!/<h1>This payday<\/h1>/.test(html),
    'the Budget operating surface does not open with a This payday heading');
  ok(!/Live Current Balance, then this payday/.test(html),
    'the Budget operating surface does not render the This payday lede');
  ok(/id="operating-surface-body"/.test(html),
    'the operating body is the Budget page content');
  const planAt = html.indexOf('<script src="/plan.js"></script>');
  const householdAt = html.indexOf('<script src="/household-view.js"></script>');
  ok(planAt >= 0 && householdAt > planAt,
    'plain-language presentation runs after the incumbent plan renderer');
  ok(/<link rel="stylesheet" href="\/household-view\.css">/.test(html),
    'the mobile household presentation stylesheet is loaded');
  ok(!/View full current-period worksheet/.test(html)
    && !/Why \/ Road ahead/.test(html),
    'worksheet and Why / Road ahead disclosures are not on the default Plan page');
}

console.log('\n=== duplicate diagnostics are grouped and translated ===');
{
  const grouped = H.aggregateTexts([
    'A material observation could not be safely classified.',
    'A material observation could not be safely classified.',
    'Category allocation is incomplete, so named remaining is not an exact claim.',
    'A material observation could not be safely classified.',
  ]);
  ok(grouped.length === 2 && grouped[0].count === 3,
    'three identical diagnostics become one grouped row');
  ok(H.friendlyDiagnostic(grouped[0].text, grouped[0].count)
      === '3 observations still need classification.',
    'generic classification jargon becomes one human-readable count');
  ok(H.friendlyDiagnostic(grouped[1].text, grouped[1].count)
      === 'Some spending is still uncategorized, so category remaining amounts are not exact.',
    'category trust limitation keeps its meaning in ordinary language');
  ok(H.friendlyDiagnostic(
      '60 unmatched household cash movements were not classified into modeled items.', 1)
      === '60 cash movements still need review.',
    'unmatched-cash volume is summarized instead of repeated');
}

console.log('\n=== the readability layer does not become a financial authority ===');
{
  const src = read('public/household-view.js');
  ok(!/Forecast\s*\./.test(src), 'does not call Forecast');
  ok(!/data\.json|periods\.json|fetch\s*\(/.test(src),
    'does not read financial sources or fetch evidence');
  ok(!/paydayAllocation|currentPeriodAction|debtPriority|fundingSequence|projectDebts|simulate\s*\(/.test(src),
    'does not recreate an engine or allocation authority');
  ok(/querySelector|textContent|cloneNode|replaceChildren/.test(src),
    'works only from already-rendered presentation content');
  ok(!/See data quality details/.test(src) && !/See current-period details/.test(src),
    'the readability layer does not add leftover diagnostic disclosures to the default Plan');
  ok(/Hold this week's spend until/.test(src)
    && !/No payment or transfer is required today/.test(src),
    'the first-screen action language is one coherent next move');
  ok(/Current Balance/.test(src),
    'the compact cash prompt is Current Balance');
}

console.log('\n=== trust caveats are translated, not deleted ===');
{
  const normal = H.friendlySpendingNote(
    "This week's spend until the next payday. Everyday costs come out of it first."
  );
  ok(normal === "This week's spend until the next payday. Everyday costs come out of it first.",
    'everyday-cost ordering survives the plain-language rewrite');
  const limited = H.friendlySpendingNote(
    "This week's spend until the next payday. What is left to spend this week is not confirmed yet."
  );
  ok(limited === "This week's spend until the next payday. What is left to spend this week is not confirmed yet.",
    'an unavailable remaining-spend claim stays visible in ordinary language');
}

console.log('\n=== current values are copied, not recalculated ===');
{
  ok(H.cashValueFromNote('Current spendable cash: $123.45 · Spendable cash. Not credit.') === '$123.45',
    'cash display copies a synthetic already-rendered value');
  ok(H.cashValueFromNote('No cash value here') === null,
    'missing rendered cash does not invent one');
}

console.log('\n=== Q6 keeps the incumbent current-period card under a disclosure ===');
{
  const renderer = loadBetweenPaydaysRenderer();
  const input = {
    mode: 'between-paydays',
    asOf: '2026-09-08',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-14',
    nextPayday: '2026-09-15',
    coverage: {
      status: 'current', remainingClaim: 'precise', pendingStatus: 'complete',
      coverageStart: '2026-09-01', coverageThrough: '2026-09-08', reason: null,
    },
    bills: [
      {
        id: 'represented-bill', label: 'Represented bill', date: '2026-09-03',
        planned: 11.11, actual: 10.01, remaining: 0,
        settlement: 'represented', confidence: 'confirmed',
      },
      {
        id: 'upcoming-bill', label: 'Upcoming bill', date: '2026-09-12',
        planned: 22.22, actual: 0, remaining: 22.22,
        settlement: 'upcoming', confidence: 'estimated',
      },
      {
        id: 'unverified-bill', label: 'Unverified bill', date: '2026-09-05',
        planned: 33.33, actual: null, remaining: 33.33,
        settlement: 'unverified', confidence: 'confirmed',
      },
      {
        id: 'unresolved-bill', label: 'Unresolved bill', date: '2026-09-06',
        planned: 44.44, actual: null, remaining: 44.44,
        settlement: 'unknown-provider-state', confidence: 'unknown',
      },
    ],
    categories: [{
      id: 'synthetic-food', label: 'Synthetic food', class: 'essential',
      planned: 50, posted: 5, pending: 0, committed: 5, remaining: 45,
    }],
    unclassified: { posted: 0, pending: 0, count: 0 },
    weeklyCap: 321.45,
    spendPermission: 642.90,
    currentShortfall: true,
    todayActions: [], noMovementToday: true,
    remainingClaim: 'precise',
    categoryRemainingClaim: 'precise',
  };
  const cardHtml = renderer.betweenPaydaysOperatingHtml(input, {
    hasFeasibleCap: true, infeasible: false, reason: '',
  });
  const doc = parseDocument(`<div id="operating-surface-body">
    <div class="operating-question" data-operating-question="06">
      <h2 class="operating-prompt">The next move?</h2>
      <div class="operating-answer">
        ${cardHtml}
        <p class="operating-note">Current spendable cash: $123.45 · Spendable cash. Not credit.</p>
      </div>
    </div>
  </div>`);
  const body = doc.getElementById('operating-surface-body');
  const cardBefore = body.querySelector('[data-current-period-action]');
  const coverageBefore = cleanText(cardBefore.querySelector('[data-current-period-coverage]'));
  const constraintBefore = Array.from(cardBefore.querySelectorAll('p')).some(el =>
    /Forecast reports a current-period constraint/.test(el.textContent));
  ok(cardBefore && coverageBefore && constraintBefore,
    'synthetic incumbent card has coverage, constraint, and bill/category state before enhance');

  H.enhance(doc);

  const q6 = body.querySelector('[data-operating-question="06"]');
  const answer = q6 && q6.querySelector('.operating-answer');
  const now = firstChildByClass(answer, 'household-now');
  const folded = Array.from((answer && answer.querySelectorAll('details')) || [])
    .find(el => /See current-period details/.test(cleanText(el.querySelector('summary'))));
  const cardAfter = body.querySelector('[data-current-period-action]');
  ok(now && /Hold this week's spend until September 15/.test(now.textContent),
    'plain-language Q6 summary leads with one hold instruction');
  ok(now && !/No payment or transfer is required today/.test(now.textContent),
    'next move does not also say no payment is required today');
  ok(cardAfter === cardBefore,
    'the original current-period card node is kept, not rebuilt');
  ok(!folded,
    'enhance does not fold the current-period card behind See current-period details');
  ok(cardAfter && cardAfter.closest('details') == null,
    'incumbent current-period details remain visible rather than nested in a disclosure');
  ok(now && now.closest('details') == null,
    'the compact household summary is not hidden inside a disclosure');
  ok(cleanText(cardAfter.querySelector('[data-current-period-coverage]')) === coverageBefore,
    'coverage status is preserved rather than rewritten');
  ok(Array.from(cardAfter.querySelectorAll('p')).some(el =>
      /Forecast reports a current-period constraint/.test(el.textContent)),
    'the current-period constraint warning remains accessible');
  ok(cardAfter.querySelector('[data-current-bill-group="represented"]')
      && cardAfter.querySelector('[data-current-bill-id="represented-bill"]'),
    'represented bill state remains accessible');
  ok(cardAfter.querySelector('[data-current-bill-group="upcoming"]')
      && cardAfter.querySelector('[data-current-bill-id="upcoming-bill"]'),
    'still-due bill state remains accessible');
  ok(cardAfter.querySelector('[data-current-bill-group="unverified"]')
      && cardAfter.querySelector('[data-current-bill-id="unverified-bill"]'),
    'unverified bill state remains accessible');
  ok(cardAfter.querySelector('[data-current-bill-group="unknown"]')
      && cardAfter.querySelector('[data-current-bill-id="unresolved-bill"]'),
    'unresolved bill state remains accessible');
  ok(cardAfter.querySelector('[data-current-category-block]')
      && cardAfter.querySelector('[data-current-category-id="synthetic-food"]'),
    'category-spending state remains accessible');
  ok(/Category spending this period/.test(cardAfter.textContent),
    'the category-spending heading remains on the kept card');
}

console.log('\n=== default-view prompts survive household-view enhance ===');
{
  const doc = parseDocument(`<div id="operating-surface-body">
    <div class="operating-question" data-operating-question="05">
      <h2 class="operating-prompt">Balance after household budget</h2>
      <div class="operating-answer"><div data-running-leftover>$1.00</div></div>
    </div>
    <div class="operating-question" data-operating-question="06">
      <h2 class="operating-prompt">Credit card to pay off first</h2>
      <div class="operating-answer"><div data-payday-first-card><p class="operating-lead">Card</p></div></div>
    </div>
  </div>`);
  H.enhance(doc);
  const q5 = doc.querySelector('[data-operating-question="05"]');
  const q6 = doc.querySelector('[data-operating-question="06"]');
  const p5 = q5 && q5.querySelector('.operating-prompt');
  const p6 = q6 && q6.querySelector('.operating-prompt');
  ok(p5 && p5.textContent === 'Balance after household budget',
    'Q05 stays Balance after household budget after enhance');
  ok(p6 && p6.textContent === 'Credit card to pay off first',
    'Q06 stays Credit card to pay off first after enhance');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');

function cleanText(node) {
  return String(node && node.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstChildByClass(parent, className) {
  return Array.from((parent && parent.children) || [])
    .find(el => String(el.className || '').split(/\s+/).includes(className)) || null;
}

function loadBetweenPaydaysRenderer() {
  const appSrc = sourceText(read('public/app.js'));
  const planSrc = sourceText(read('public/plan.js'));
  const grab = (src, re, label) => {
    const match = re.exec(src);
    if (!match) throw new Error('missing ' + label);
    return match[0];
  };
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function paydayCoverageNote\([\s\S]*?\n\}/m, 'paydayCoverageNote'),
    grab(planSrc, /^function paydayAmountCell\([\s\S]*?\n\}/m, 'paydayAmountCell'),
    grab(planSrc, /^function currentPeriodConfidence\([\s\S]*?\n\}/m, 'currentPeriodConfidence'),
    grab(planSrc, /^function currentPeriodBillGroup\([\s\S]*?\n\}/m, 'currentPeriodBillGroup'),
    grab(planSrc, /^function betweenPaydaysOperatingHtml\([\s\S]*?\n\}/m, 'betweenPaydaysOperatingHtml'),
  ].join('\n');
  return vm.runInNewContext(`${source}\n({ betweenPaydaysOperatingHtml, money2 });`);
}

function parseDocument(html) {
  const doc = createDocument();
  const roots = parseFragment(html, doc);
  for (const node of roots) doc.appendChild(node);
  return doc;
}

function createDocument() {
  const doc = {
    nodeType: 9,
    childNodes: [],
    get children() { return this.childNodes.filter(node => node.nodeType === 1); },
    createElement(tag) { return createElement(doc, tag); },
    createTextNode(value) { return createText(doc, value); },
    appendChild(node) { return appendChild(this, node); },
    getElementById(id) {
      return descendants(this).find(el => el.getAttribute('id') === id) || null;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return descendants(this).filter(el => el.matches(sel)); },
  };
  return doc;
}

function createElement(doc, tag) {
  const attrs = Object.create(null);
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    parentNode: null,
    childNodes: [],
    get children() { return this.childNodes.filter(node => node.nodeType === 1); },
    get className() { return attrs.class || ''; },
    set className(value) { attrs.class = String(value == null ? '' : value); },
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); },
    set textContent(value) {
      this.childNodes.slice().forEach(node => this.removeChild(node));
      if (value !== '' && value != null) this.appendChild(createText(doc, value));
    },
    classList: {
      add(name) {
        const parts = String(attrs.class || '').split(/\s+/).filter(Boolean);
        if (!parts.includes(name)) parts.push(name);
        attrs.class = parts.join(' ');
      },
      contains(name) {
        return String(attrs.class || '').split(/\s+/).includes(name);
      },
    },
    matches(sel) { return matchesSelector(el, sel); },
    closest(sel) {
      let node = el;
      while (node && node.nodeType === 1) {
        if (node.matches(sel)) return node;
        node = node.parentNode;
      }
      return null;
    },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    setAttribute(name, value) { attrs[name] = String(value); },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    appendChild(node) { return appendChild(el, node); },
    append(...nodes) { nodes.forEach(node => appendChild(el, node)); },
    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index < 0) throw new Error('not a child');
      this.childNodes.splice(index, 1);
      node.parentNode = null;
      return node;
    },
    replaceChildren(...nodes) {
      this.childNodes.slice().forEach(node => this.removeChild(node));
      nodes.forEach(node => this.appendChild(node));
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return descendants(this).filter(node => node.matches(sel)); },
    cloneNode(deep) {
      const copy = createElement(doc, el.tagName);
      Object.keys(attrs).forEach(name => copy.setAttribute(name, attrs[name]));
      if (deep) this.childNodes.forEach(node => copy.appendChild(node.cloneNode(true)));
      return copy;
    },
  };
  return el;
}

function createText(doc, value) {
  return {
    nodeType: 3,
    ownerDocument: doc,
    parentNode: null,
    textContent: String(value == null ? '' : value),
    cloneNode() { return createText(doc, this.textContent); },
  };
}

function appendChild(parent, node) {
  if (node.parentNode) node.parentNode.removeChild(node);
  parent.childNodes.push(node);
  node.parentNode = parent;
  return node;
}

function descendants(root) {
  const out = [];
  const walk = node => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 1) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

function matchesSelector(el, selector) {
  const sel = String(selector || '').trim();
  if (!sel || /[\s>+~]/.test(sel.replace(/\[[^\]]*]/g, ''))) return false;
  let rest = sel;
  const tag = /^[a-z][\w-]*/i.exec(rest);
  if (tag && rest[0] !== '.' && rest[0] !== '#' && rest[0] !== '[') {
    if (el.tagName !== tag[0].toUpperCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    if (rest[0] === '.') {
      const cls = /^\.([\w-]+)/.exec(rest);
      if (!cls || !el.classList.contains(cls[1])) return false;
      rest = rest.slice(cls[0].length);
      continue;
    }
    if (rest[0] === '#') {
      const id = /^#([\w-]+)/.exec(rest);
      if (!id || el.getAttribute('id') !== id[1]) return false;
      rest = rest.slice(id[0].length);
      continue;
    }
    if (rest[0] === '[') {
      const attr = /^\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/.exec(rest);
      if (!attr || !el.hasAttribute(attr[1].trim())) return false;
      if (attr[2] != null || attr[3] != null || attr[4] != null) {
        const expected = attr[2] != null ? attr[2] : attr[3] != null ? attr[3] : attr[4];
        if (el.getAttribute(attr[1].trim()) !== expected) return false;
      }
      rest = rest.slice(attr[0].length);
      continue;
    }
    return false;
  }
  return true;
}

function parseFragment(html, doc) {
  const host = createElement(doc, 'fragment');
  const stack = [host];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let i = 0;
  const src = String(html);
  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const text = src.slice(i, next < 0 ? src.length : next);
      i = next < 0 ? src.length : next;
      if (text) stack[stack.length - 1].appendChild(createText(doc, decodeEntities(text)));
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i);
      const tag = src.slice(i + 2, end).trim().toLowerCase();
      i = end < 0 ? src.length : end + 1;
      while (stack.length > 1 && stack[stack.length - 1].tagName !== tag.toUpperCase()) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const end = src.indexOf('>', i);
    if (end < 0) break;
    let raw = src.slice(i + 1, end).trim();
    i = end + 1;
    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1).trim();
    const space = raw.search(/\s/);
    const tag = (space < 0 ? raw : raw.slice(0, space)).toLowerCase();
    const el = doc.createElement(tag);
    const attrSrc = space < 0 ? '' : raw.slice(space);
    const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
    let match;
    while ((match = attrRe.exec(attrSrc))) {
      el.setAttribute(match[1], match[2] != null ? match[2] : match[3] != null ? match[3] : match[4] != null ? match[4] : '');
    }
    stack[stack.length - 1].appendChild(el);
    if (!selfClosing && !voidTags.has(tag)) stack.push(el);
  }
  return host.childNodes.slice();
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}
