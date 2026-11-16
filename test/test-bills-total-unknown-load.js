'use strict';
/* An open period whose bill load is unknown publishes no known bill total.
 *
 * Invented case. A monthly obligation with no known amount is due in a later
 * pay period. It has no bill row of its own, so before this fix the period's
 * bill load was withheld (null, unavailable) while "Total bills this period"
 * and "Remaining bills" still summed the known rows (0 for a period holding
 * only that obligation) and the Budget page's bill evidence printed them as
 * dollar figures. The oracle is the rule itself: when the load is unknown,
 * neither total may be a number; when the load is known, both stay as before.
 *
 * `node test/test-bills-total-unknown-load.js`
 */
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('../public/forecast.js');
const Detail = require('../public/bill-detail');
const fx = require('./fixtures/budget-surface-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const page = (() => {
  const context = vm.createContext({ Forecast: F, BillDetail: Detail, console,
    addEventListener() {}, document: { addEventListener() {}, querySelectorAll() { return []; },
      getElementById() { return null; }, documentElement: { dataset: {}, style: {} } },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' } });
  vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {};', context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/plan.js'), 'utf8'), context);
  return (fn, ...args) => { context.__args = args; return vm.runInContext(`${fn}(...__args)`, context); };
})();

function advise(unknownObligation) {
  const d = fx.served();
  if (unknownObligation) {
    d.plan.obligations = (d.plan.obligations || []).concat([{ id: 'invented-unknown', label: 'Invented obligation',
      amount: null, frequency: 'monthly', day: 5, confidence: 'estimated', payingAccount: 'chequing-a' }]);
  }
  return { d, advice: F.recommend(d.plan, d.meta.asOf, { debts: d.debts, ...d.liveOverlay }) };
}
const open = advice => (advice.payPeriodViews || []).filter(v => v.lookback !== true && v.timelineRole !== 'past');

const control = advise(false);
const unknown = advise(true);
const controlOpen = open(control.advice);
const unknownOpen = open(unknown.advice);

console.log('=== 1. control: a known load keeps its totals ===');
ok(controlOpen.length > 3 && controlOpen.every(v => typeof v.periodBillLoad === 'number'
    && typeof v.totalBillsThisPeriod === 'number' && typeof v.remainingBills === 'number'),
  'every open period publishes a load, a total and a remainder');

console.log('\n=== 2. an unknown load withholds the total and the remainder ===');
const hit = unknownOpen.filter(v => v.periodBillLoad === null);
ok(hit.length >= 2, 'the unknown obligation withholds the load in at least two open periods',
  hit.map(v => v.start).join(', '));
ok(hit.every(v => v.periodBillLoadTrust === 'unavailable'), 'each such load is unavailable');
ok(hit.every(v => v.totalBillsThisPeriod === null && v.remainingBills === null),
  'no such period publishes a known bill total or remainder',
  JSON.stringify(hit.map(v => [v.start, v.totalBillsThisPeriod, v.remainingBills])));
const unaffected = unknownOpen.filter(v => v.periodBillLoad !== null);
ok(unaffected.length > 0 && unaffected.every(v => {
  const c = controlOpen.find(x => x.start === v.start);
  return c && v.totalBillsThisPeriod === c.totalBillsThisPeriod && v.remainingBills === c.remainingBills;
}), 'periods the obligation does not reach keep their control totals');

console.log('\n=== 3. the Budget page prints no dollar total over the unknown load ===');
for (const v of hit.slice(0, 2)) {
  const html = page('budgetBillsSectionHtml', v, { asOf: unknown.d.meta.asOf, advice: unknown.advice });
  const evidence = (html.match(/<div class="budget-bills-figures">[\s\S]*?<\/div>/) || [''])[0];
  ok(/Unavailable<\/span> this period/.test(evidence), `${v.start}: "this period" reads Unavailable`, evidence);
  ok(!/\$[\d,]+\.\d\d<\/span> this period/.test(evidence) && !/\$[\d,]+\.\d\d this period/.test(evidence),
    `${v.start}: no dollar figure is printed for the period total`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
