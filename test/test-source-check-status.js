'use strict';
// Run the actual shared boot, not a duplicate of its status formatter.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { cases, dataFor } = require('./fixtures/source-check-status');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function boot(testCase) {
  const elements = [], input = testCase.data || dataFor(testCase), before = JSON.stringify(input);
  class Element {
    constructor() { this.children = []; this.attributes = {}; elements.push(this); }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || ''; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    querySelectorAll() { return []; }
    prepend(child) { this.children.unshift(child); child.parent = this; }
    append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener() {}
  }
  const wrap = new Element(), head = new Element();
  const document = { body: new Element(), documentElement: new Element(), getElementById: () => null,
    querySelectorAll: () => [], createElement: () => new Element(),
    querySelector: selector => selector === '.wrap' ? wrap : selector === '.site-head-inner' ? head : null };
  const context = { document, console, AbortController, Intl, addEventListener() {}, location: { href: '' },
    // No pending operation. Other storage retains the old unavailable behavior.
    localStorage: { getItem(key) { if (key === 'atlas-settlement-pending-v1') return null; throw Error('synthetic non-marker storage unavailable'); },
      setItem() { throw Error('storage write forbidden'); }, removeItem() { throw Error('storage removal forbidden'); } },
    matchMedia: () => ({ addEventListener() {} }), setTimeout, clearTimeout,
    fetch: async () => ({ status: 200, ok: true, headers: { get: name => testCase.headers[name] || null }, json: async () => input }) };
  vm.createContext(context); vm.runInContext(source + '\nglobalThis.app = App;', context);
  let renders = 0; context.app.register(() => renders++); context.app.boot(); await flush(); await flush();
  assert.equal(renders, 1, testCase.name + ': admitted response still renders');
  assert.equal(JSON.stringify(input), before, testCase.name + ': status cannot change data, dates, amounts or trust');
  return elements.find(element => Object.hasOwn(element.attributes, 'data-observation-check')).textContent;
}
(async () => {
  for (const testCase of [...cases, { name: 'malformed-state', headers: {},
    trust: { displayState: 'constructor', exactFiguresAvailable: true },
    includes: ['Provider check details unavailable.', 'Financial coverage details unavailable.'] },
    { name: 'malformed-limits', headers: {}, trust: { exactFiguresAvailable: false, remainingClaim: 'precise', coverageLimits: {} },
      includes: ['Financial figures unavailable; details not provided.'] },
    { name: 'non-withheld', headers: {}, trust: { displayState: 'partially-current', exactFiguresAvailable: true,
      remainingClaim: 'unavailable', coverageLimits: [{ id: 'card-purchase-coverage-unconfirmed' }] },
      includes: ['Financial coverage: partial.'] }]) {
    const text = await boot(testCase);
    for (const expected of testCase.includes) assert.ok(text.includes(expected), testCase.name + ': expected ' + expected + '; got ' + text);
    if (testCase.trust.exactFiguresAvailable !== false) assert.ok(!text.includes('Unavailable figures:'), 'preserve incumbent aggregate gate');
    assert.ok(!text.includes('Do not display this external prose') && !text.includes('<unrecognised>'), 'unknown diagnostic prose is never displayed');
    assert.ok(!text.includes('Provider check unavailable'), testCase.name + ': qualification is not provider failure');
  }
  // Real incumbent publications, not just renderer doubles. Unknown card
  // payment purpose withholds its reserve; incomplete posted coverage withholds
  // remaining spending. The source receipt is successful in both worlds.
  const Live = require('../scripts/live-plan'), Trust = require('../scripts/refresh-trust');
  const cardFixture = require('./fixtures/card-purchase-coverage-data');
  for (const missingPostedCoverage of [false, true]) {
    const input = cardFixture('backfill');
    if (missingPostedCoverage) input.payload.transactionWindow.complete = false;
    const data = Live.fromObservation(input).data;
    data.refreshTrust = Trust.fromIncumbent({ data, mode: 'live-overlay' });
    assert.equal(data.refreshTrust.exactFiguresAvailable, false);
    assert.equal(data.refreshTrust.remainingClaim, missingPostedCoverage ? 'unavailable' : 'precise');
    const text = await boot({ name: 'incumbent-' + missingPostedCoverage, data, headers: cases[0].headers });
    assert.ok(text.includes(missingPostedCoverage
      ? 'Unavailable figures: remaining spending; cash reserved for card purchases.'
      : 'Unavailable figures: cash reserved for card purchases.'));
  }
  console.log('PASS source-check status: shared boot names incumbent unavailable claims; source status stays separate and data is unchanged');
})().catch(error => { console.error(error); process.exitCode = 1; });
