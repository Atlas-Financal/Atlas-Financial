'use strict';
// Escaping proof for the live Budget page's shared escape (external audit C2).
//
// This suite used to drive invented hostile strings through the real
// renderBills, renderSubscriptions and renderCredit page renderers and
// tokenise every HTML string they assigned. Those pages were deleted on
// 2026-11-16 (Dale's direction), so that behavioural half went with them.
// What guards the live renderers now: the static template guard
// (test/test-page-renderer-escape-static.js, over every script index.html
// loads), the browser twin (test/browser-page-renderer-escaping.js, which
// pushes the hostile fixture through the Budget page at /), and the two
// checks below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');

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
