'use strict';
// The real Budget page renderer for tests: public/app.js and public/plan.js
// loaded whole in a sandbox, composed exactly as the live surface composes
// them (budgetSurfaceParts: the unavailable surface, or the Today card plus
// the compact pay-period content). Replaces suite-local copies of plan.js
// functions and the retired operatingSurfaceHtml composer. Invented data only.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const element = () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {},
  removeAttribute() {}, appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: { setProperty() {} }, dataset: {}, hidden: false, innerHTML: '', textContent: '' });

function loadBudgetPage({ Forecast = require(path.join(ROOT, 'public', 'forecast.js')), state = null, globals = {} } = {}) {
  const context = vm.createContext(Object.assign({
    Forecast, console, setTimeout, clearTimeout,
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      getElementById() { return null; }, createElement: element, body: element(),
      documentElement: { dataset: {}, style: { setProperty() {} } } },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; },
      requestAnimationFrame() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { pathname: '/', search: '', hash: '' }, history: { replaceState() {} },
    navigator: { userAgent: 'node' },
  }, globals));
  for (const file of ['app.js', 'plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'), context, { filename: file });
    if (file === 'app.js') vm.runInContext('App.boot = () => {};', context);
  }
  if (state) { context.__state = state; vm.runInContext('Object.assign(state, __state)', context); }
  const get = name => vm.runInContext(name, context);
  return {
    context, get,
    // The live Budget composition (budgetSurfaceHtml's parts), minus the
    // header, detail sheet and interactive sections that need a browser.
    surfaceHtml(ctx) {
      const parts = get('budgetSurfaceParts')();
      return parts.planUnavailable(ctx) ? parts.unavailableHtml(ctx) : parts.todayHtml(ctx) + parts.periodHtml(ctx);
    },
  };
}
// Source text of the live Budget composer: budgetSurfaceParts (the one
// unavailable branch and the part wiring), the Today card and the selected
// pay-period content. Static "the page is a renderer" checks read this.
// Returns [text] like RegExp#exec, or null when any part is missing.
const LIVE_COMPOSER = ['budgetSurfaceParts', 'budgetTodayCashCardHtml', 'budgetPayPeriodContentHtml'];
function liveBudgetComposerSource(planSrc) {
  const bodies = LIVE_COMPOSER.map(name => new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}').exec(planSrc));
  return bodies.every(Boolean) ? [bodies.map(body => body[0]).join('\n')] : null;
}
module.exports = { loadBudgetPage, liveBudgetComposerSource, LIVE_COMPOSER };
