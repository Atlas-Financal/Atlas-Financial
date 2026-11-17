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

function advise(unknownObligation, periodHistory) {
  const d = fx.served();
  if (unknownObligation) {
    d.plan.obligations = (d.plan.obligations || []).concat([{ id: 'invented-unknown', label: 'Invented obligation',
      amount: null, frequency: 'monthly', day: 5, confidence: 'estimated', payingAccount: 'chequing-a' }]);
  }
  return { d, advice: F.recommend(d.plan, d.meta.asOf, { debts: d.debts, ...d.liveOverlay,
    ...(periodHistory ? { periodHistory } : {}) }) };
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
// Independent oracle: the open periods that contain a day-5 date (the
// obligation's due day), counted from the calendar, not from the engine.
const holdsDay5 = v => {
  for (let d = new Date(v.start + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= v.end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDate() === 5) return true;
  }
  return false;
};
const expected = unknownOpen.filter(holdsDay5).map(v => v.start);
const hit = unknownOpen.filter(v => v.periodBillLoad === null);
ok(expected.length >= 2 && JSON.stringify(hit.map(v => v.start)) === JSON.stringify(expected),
  'the load is withheld in exactly the open periods holding the obligation\'s due day',
  JSON.stringify({ expected, hit: hit.map(v => v.start) }));
ok(hit.every(v => v.periodBillLoadTrust === 'unavailable'), 'each such load is unavailable');
ok(hit.every(v => v.totalBillsThisPeriod === null && v.remainingBills === null),
  'no such period publishes a known bill total or remainder',
  JSON.stringify(hit.map(v => [v.start, v.totalBillsThisPeriod, v.remainingBills])));
ok(hit.every(v => JSON.stringify(v.billLoadUnknownFrom) === JSON.stringify([{ carrier: 'obligation', id: 'invented-unknown' }])),
  'each withheld period names the unknown obligation as the reason', JSON.stringify(hit.map(v => v.billLoadUnknownFrom)));
ok(hit.every(v => (v.bills || []).every(row => row.amount == null || typeof row.amount === 'number')),
  'the known bill rows still publish one by one');
const unaffected = unknownOpen.filter(v => !holdsDay5(v));
ok(unaffected.every(v => v.billLoadUnknownFrom === undefined), 'a period with a known load names nothing');
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

console.log('\n=== 4. a completed period with the unknown obligation: no number over its Unknown total ===');
{
  const closed = advice => (advice.payPeriodViews || []).filter(v => v.lookback === true);
  const controlClosed = closed(control.advice);
  const unknownClosed = closed(unknown.advice);
  const hitClosed = unknownClosed.filter(holdsDay5);
  const missClosed = unknownClosed.filter(v => !holdsDay5(v));
  ok(controlClosed.length > 2 && controlClosed.every(v => typeof v.periodBillLoad === 'number'
      && typeof v.totalBillsThisPeriod === 'number' && typeof v.remainingBills === 'number'),
    'control: every completed period publishes a load, a total and a remainder');
  ok(hitClosed.length >= 2, 'the obligation falls in at least two completed periods (calendar)', hitClosed.map(v => v.start).join(', '));
  ok(hitClosed.every(v => v.totalBillsThisPeriod === null && v.unconfirmedBills === null),
    'precondition: those periods already withhold the total and the unconfirmed bills');
  ok(hitClosed.every(v => v.periodBillLoad === null && v.periodBillLoadTrust === 'unavailable'),
    'their load is Unknown too, never a number beside the Unknown total',
    JSON.stringify(hitClosed.map(v => [v.start, v.periodBillLoad])));
  ok(hitClosed.every(v => v.remainingBills === 0),
    'the completed-period remainder keeps its #931 contract (settlement evidence, 0); the unknown is carried by unconfirmedBills');
  ok(hitClosed.every(v => v.afterBills === null && v.balanceAfterDeductions === null),
    'after bills and Balance After Deductions built on that load are Unknown',
    JSON.stringify(hitClosed.map(v => [v.start, v.afterBills, v.balanceAfterDeductions])));
  ok(hitClosed.every(v => JSON.stringify(v.billLoadUnknownFrom) === JSON.stringify([{ carrier: 'obligation', id: 'invented-unknown' }])),
    'each names the unknown obligation as the reason');
  ok(missClosed.length > 0 && missClosed.every(v => {
    const c = controlClosed.find(x => x.start === v.start);
    return c && v.periodBillLoad === c.periodBillLoad && v.remainingBills === c.remainingBills
      && v.totalBillsThisPeriod === c.totalBillsThisPeriod && v.balanceAfterDeductions === c.balanceAfterDeductions;
  }), 'completed periods the obligation does not reach keep their control figures');
  for (const v of hitClosed.slice(0, 1)) {
    const html = page('budgetBillsSectionHtml', v, { asOf: unknown.d.meta.asOf, advice: unknown.advice });
    const footer = (html.match(/<footer>[\s\S]*?<\/footer>/) || [''])[0];
    ok(/Unavailable/.test(footer) && !/\$[\d,]+\.\d\d/.test(footer),
      `${v.start}: the Budget page's "The plan deducts" reads Unavailable, no dollar figure`, footer.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));
  }
}

console.log('\n=== 5. a saved close is never overwritten (Grok Bot condition, Plan #6) ===');
{
  // A close saved before this rule shows numeric figures. Applying it keeps
  // them exactly; only billLoadUnknownFrom (not part of the saved
  // projection) names the payment beside them, as #1215 discloses a carry.
  const SAVED_KEYS = ['totalBillsThisPeriod', 'paidBills', 'remainingBills', 'periodBillLoad', 'periodBillLoadTrust',
    'afterBills', 'afterBillsTrust', 'balanceAfterDeductions', 'balanceAfterDeductionsTrust', 'incomeTotal', 'budgetHold'];
  const target = (control.advice.payPeriodViews || []).filter(v => v.lookback === true).find(holdsDay5);
  ok(!!target, 'a completed period the obligation reaches exists', target && target.start);
  const publication = { start: target.start, end: target.end,
    ...Object.fromEntries(SAVED_KEYS.filter(k => typeof target[k] === 'number' || typeof target[k] === 'string').map(k => [k, target[k]])) };
  const saved = [{ schema: 'atlas-private-period-history-projection/v1', capturedAt: target.end + 'T23:00:00.000Z',
    content: { period: { start: target.start, end: target.end, timezone: 'America/Vancouver' }, kind: 'closing',
      asOf: target.end, closingState: 'provisional', planBasis: 'see-baseline-revision',
      provenance: { policyFingerprint: null }, publication } }];
  const withSaved = advise(true, saved);
  const v = withSaved.advice.payPeriodViews.find(x => x.start === target.start && x.end === target.end);
  ok(v && v.capturedClose && v.capturedClose.kind === 'closing', 'the period prints as its saved close');
  ok(v && typeof publication.periodBillLoad === 'number' && typeof publication.balanceAfterDeductions === 'number'
      && SAVED_KEYS.every(k => !Object.hasOwn(publication, k) || v[k] === publication[k]),
    'every saved figure and tag stays exactly as saved (load, after bills, Balance After Deductions included)',
    JSON.stringify(SAVED_KEYS.filter(k => Object.hasOwn(publication, k) && v[k] !== publication[k])));
  ok(v && JSON.stringify(v.billLoadUnknownFrom) === JSON.stringify([{ carrier: 'obligation', id: 'invented-unknown' }]),
    'the saved close names the payment that has no known amount, beside its saved figures');
  const unsavedRow = withSaved.advice.payPeriodViews.filter(x => x.lookback === true && holdsDay5(x) && x !== v);
  ok(unsavedRow.length > 0 && unsavedRow.every(x => !x.capturedClose && x.periodBillLoad === null),
    'completed periods with no saved close still withhold (the rule applies only where nothing was saved)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
