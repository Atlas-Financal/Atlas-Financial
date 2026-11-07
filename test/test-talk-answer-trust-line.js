'use strict';
/* Talk keeps the trust line on every answer shape.
 * `node test/test-talk-answer-trust-line.js`
 *
 * A plain answer prints "source · as of · trust · freshness" under the
 * bubble. A card answer and a decision-summary answer reprint the same
 * figures, so they carry the same line. The real public/talk.js runs in a
 * vm with a minimal DOM; every answer here is invented. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

function element(tag) {
  return {
    tagName: tag, className: '', children: [], textContent: '', hidden: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter(row => row !== child); return child; },
    get firstChild() { return this.children[0] || null; },
    closest() { return null; },
  };
}
const sandbox = {
  App: { boot() {} },
  document: { querySelector() { return null; }, createElement: element },
  fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
  $(id) {
    if (id === 'talk-send') return { disabled: true, setAttribute() {} };
    if (id === 'talk-input') return { value: '', setAttribute() {} };
    if (id === 'talk-seam') return { textContent: '' };
    if (id === 'talk-context') return { textContent: '', dataset: {} };
    if (id === 'talk-thread') return { insertAdjacentHTML() {}, appendChild() {} };
    if (id === 'talk-empty') return { hidden: false };
    if (id === 'talk-composer' || id === 'talk-prompts') return { addEventListener() {} };
    return null;
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'talk.js'), 'utf8')
  + '\nthis.__api = { talkAnswerNode };', sandbox);
const { talkAnswerNode } = sandbox.__api;

const metaLines = node => (node.children || []).filter(child => child.className === 'talk-answer-meta');
const base = {
  answer: 'Invented: about $120.00 is left this pay period.',
  source: 'Forecast', trust: 'estimated', asOf: '2026-03-01', freshness: 'live',
};
const EXPECTED = 'Forecast · as of 2026-03-01 · estimated · live';

const plain = talkAnswerNode(base);
ok(metaLines(plain).length === 1 && metaLines(plain)[0].textContent === EXPECTED,
  'a plain answer prints its trust line', metaLines(plain).map(n => n.textContent).join('|'));

const cards = talkAnswerNode(Object.assign({}, base, {
  cards: { version: 1, items: [{ kind: 'answer', title: 'Answer', body: base.answer }] },
}));
ok(/talk-bubble-cards/.test(cards.className), 'the invented card answer renders as cards');
ok(metaLines(cards).length === 1 && metaLines(cards)[0].textContent === EXPECTED,
  'a card answer keeps the same trust line', metaLines(cards).map(n => n.textContent).join('|'));

const sections = ['knows', 'changes', 'unchanged', 'risk', 'unknown'];
const titles = { knows: 'What Atlas knows', changes: 'What changes', unchanged: 'What does not change',
  risk: 'Risk / uncertainty', unknown: 'What Atlas cannot determine yet' };
const summary = talkAnswerNode(Object.assign({}, base, {
  summary: { version: 1, sections: sections.map(key => ({ key, title: titles[key], items: [{ body: 'Invented ' + key }] })) },
}));
ok(/talk-bubble-summary/.test(summary.className), 'the invented summary answer renders as a summary');
ok(metaLines(summary).length === 1 && metaLines(summary)[0].textContent === EXPECTED,
  'a summary answer keeps the same trust line', metaLines(summary).map(n => n.textContent).join('|'));

const noTrust = talkAnswerNode({ answer: 'Invented.', cards: { version: 1, items: [{ kind: 'answer', title: 'Answer', body: 'Invented.' }] } });
ok(metaLines(noTrust).length === 0, 'an answer with no trust fields prints no empty trust line');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
