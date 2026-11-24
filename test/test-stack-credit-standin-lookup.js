'use strict';
/* The Credit stand-in (test/lib/stack-credit-target.js publishCredit) finds the selected pay-period view the way Forecast
 * publishes it and fails loudly when none matches (bug-hunt F7, #1607): a mismatched selectedPeriodKey throws instead of
 * silently skipping publication; with no key the current view is found by Forecast's real marker (timelineRole 'current',
 * role 'active', never role 'current'); a matching key still publishes. Invented data only. `node test/test-stack-credit-standin-lookup.js`
 */
const assert = require('node:assert/strict');
const { publishCredit } = require('./lib/stack-credit-target');
let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks++; console.log('  PASS  ' + label); };
const mk = key => {
  const views = [
    { start: '2030-01-01', end: '2030-01-14', role: 'lookback', timelineRole: 'past' },
    { start: '2030-01-15', end: '2030-01-28', role: 'active', timelineRole: 'current' },
    { start: '2030-01-29', end: '2030-02-11', role: 'future', timelineRole: 'next' }];
  const Forecast = { cardPeriodMovements: () => ({}), stackCreditLines: () => ({ lines: [{ id: 'invented-card' }] }) };
  return { views, ctx: { selectedPeriodKey: key, recommendation: { payPeriodViews: views }, Forecast, plan: {}, data: { debts: [], meta: { asOf: '2030-01-20' } } } };
};
const published = v => !!(v.stackSummary && v.stackSummary.credit);

let a = mk('2099-01-01');
assert.throws(() => publishCredit(a.ctx), /2099-01-01/);
ok(true, '1. a selectedPeriodKey matching no view throws, naming the key');
ok(a.views.every(v => !published(v)), '1. nothing was published on the mismatch');

let b = mk(undefined);
publishCredit(b.ctx);
ok(published(b.views[1]) && !published(b.views[0]) && !published(b.views[2]), '2. no key selects the current view by timelineRole/role active');
let b2 = mk(undefined); b2.views[1].timelineRole = undefined; b2.views[1].role = 'active';
publishCredit(b2.ctx);
ok(published(b2.views[1]), '2. role active alone also marks the current view');
let b3 = mk(undefined); b3.views.forEach(v => { v.role = 'future'; v.timelineRole = 'future'; });
assert.throws(() => publishCredit(b3.ctx), /current view/);
ok(true, '2. views with no current marker throw rather than skip');

let c = mk('2030-01-29');
publishCredit(c.ctx);
ok(published(c.views[2]) && !published(c.views[1]), '3. a matching key still publishes on that view');

ok(publishCredit({ recommendation: { payPeriodViews: [] }, selectedPeriodKey: 'x' }) === undefined && publishCredit({}) === undefined, 'nothing to publish (no views) stays a no-op');
console.log('\nPASS Credit stand-in lookup (' + checks + ')');