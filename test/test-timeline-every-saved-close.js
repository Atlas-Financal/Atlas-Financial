'use strict';
// Every saved close stays on the timeline (owner direction, Dale, 2026-11-18:
// saved periods are kept, and the household scrolls back through all of them).
// Invented household only (test/fixtures/private-period-history-input.js;
// biweekly cycles from 2030-02-01).
//
//   T1 a closing record older than the rebuilt lookback (6 completed periods)
//      becomes its own historical view, oldest first, before the rebuilt ones;
//      the timeline's current index and count follow
//   T2 that view holds stored figures only: every number on it, and on each of
//      its rows, is a number the record kept; progress stays withdrawn; no
//      trust word is invented for a category row
//   T3 only closing records qualify; a malformed, overlapping or in-window
//      unmatched record adds nothing; no history changes nothing
//   T4 the page prints the period on the timeline and opens it as a saved
//      close, without throwing
//   T5 in an acceptance world with a savings pool, adding the old saved close
//      changes no other view and no savings figure
//   T6 (browser, skipped without Playwright) the real Budget page lists it as
//      the first timeline period and opens it as a saved close
//
// `node test/test-timeline-every-saved-close.js`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, END, input } = require('./fixtures/private-period-history-input');

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const at = raw => { const c = JSON.parse(JSON.stringify(raw)); const t = c.capturedAt; delete c.capturedAt; return [c, () => new Date(t)]; };
const closingFor = (day, periodStart) => {
  const raw = input({ day, kind: 'closing', periodStart });
  delete raw.kind; delete raw.periodStart;
  const [clean, now] = at(raw);
  return Pg.project(History.captureClosing(clean, { now }));
};
const AS_OF = '2030-06-10';
const today = input({ day: AS_OF, kind: 'first-observed', periodStart: AS_OF });
const run = history => F.recommend(today.data.plan, AS_OF, { debts: [], periods: [], periodHistory: history });
const shift = (record, start, end) => {
  const copy = JSON.parse(JSON.stringify(record));
  copy.content.period.start = start; copy.content.period.end = end;
  return copy;
};

const feb = closingFor('2030-02-16', START); // Feb 1-14, well before the lookback
const control = run(undefined);
const controlPast = control.payPeriodViews.filter(view => view.timelineRole === 'past');
ok(controlPast.length === 6 && controlPast[0].start === '2030-03-15',
  'control: the rebuilt lookback is the 6 completed periods from Mar 15');

// T1
{
  const advice = run([feb]);
  const views = advice.payPeriodViews;
  const first = views[0];
  ok(first.start === START && first.end === END && first.id === 'past:' + START,
    'the saved Feb 1-14 close is the first (oldest) view');
  ok(first.timelineRole === 'past' && first.evidenceState === 'historical' && first.lookback === true,
    'it is a historical past view');
  ok(views.length === control.payPeriodViews.length + 1, 'exactly one view is added');
  ok(advice.payPeriodTimeline.count === views.length
    && views[advice.payPeriodTimeline.currentIndex].timelineRole === 'current',
    'the timeline count and current index follow the added view');
  ok(views.every((view, i) => view.timelineOffset === i - advice.payPeriodTimeline.currentIndex),
    'every offset is measured from the current period');
  ok(first.timelineOffset === -7 && views[1].timelineOffset === -6, 'the saved close sits one step before the rebuilt lookback');
  ok(first.capturedClose && first.capturedClose.savedOnly === true && first.capturedClose.kind === 'closing'
    && first.capturedClose.capturedAt === feb.capturedAt, 'it is marked as a saved close composed from the record alone');
  ok(views.slice(1).every((view, i) => JSON.stringify({ ...view, timelineOffset: 0 })
    === JSON.stringify({ ...control.payPeriodViews[i], timelineOffset: 0 })),
  'every other view is unchanged apart from its offset');
}

// T2
{
  const view = run([feb]).payPeriodViews[0];
  const pub = feb.content.publication;
  const numericOwn = Object.entries(view).filter(([, value]) => typeof value === 'number').map(([key]) => key);
  ok(numericOwn.every(key => key === 'timelineOffset' || Object.hasOwn(pub, key)),
    'every top-level number is a stored number: ' + numericOwn.filter(key => key !== 'timelineOffset' && !Object.hasOwn(pub, key)).join(','));
  for (const key of ['householdBudget', 'income', 'bills']) {
    const stored = pub[key] || [];
    ok(Array.isArray(view[key]) && view[key].length === stored.length, key + ': exactly the stored rows');
    for (const row of view[key] || []) {
      const source = stored.find(item => item.id === row.id) || {};
      ok(Object.entries(row).every(([field, value]) => typeof value !== 'number' || source[field] === value),
        key + ' ' + row.id + ': every number is the stored number');
    }
  }
  ok(view.budgetProgress === null, 'period progress is withdrawn, as for every saved close');
  ok((view.householdBudget || []).every(row => !Object.hasOwn(row, 'trust') && !Object.hasOwn(row, 'confidence')),
    'no trust word is invented for a category row');
  ok(view.balanceAfterDeductions === pub.balanceAfterDeductions
    && view.balanceAfterDeductionsTrust === pub.balanceAfterDeductionsTrust,
  'Balance After Deductions and its trust are the stored ones');
}

// T3
{
  const base = control.payPeriodViews.length;
  ok(run([]).payPeriodViews.length === base && run('x').payPeriodViews.length === base, 'no history: nothing added');
  const notClosing = JSON.parse(JSON.stringify(feb)); notClosing.content.kind = 'reconstructed';
  ok(run([notClosing]).payPeriodViews.length === base, 'a reconstructed record is not a saved close: nothing added');
  ok(run([{ ...feb, schema: 'other' }]).payPeriodViews.length === base, 'a malformed record adds nothing');
  const overlap = shift(feb, '2030-02-08', '2030-02-21');
  ok(run([feb, overlap]).payPeriodViews.length === base, 'two saved periods that overlap are both skipped');
  const inWindow = shift(feb, '2030-03-16', '2030-03-29');
  ok(run([inWindow]).payPeriodViews.length === base, 'a record inside the rebuilt range that matches no window adds nothing');
  const jan = shift(feb, '2030-01-18', '2030-01-31');
  const two = run([feb, jan]).payPeriodViews;
  ok(two.length === base + 2 && two[0].start === '2030-01-18' && two[1].start === START,
    'two older saved closes are both listed, oldest first');
  const twice = JSON.parse(JSON.stringify(feb)); twice.capturedAt = '2030-02-17T18:01:00Z'; twice.content.publication.balanceAfterDeductions = 1;
  ok(run([twice, feb]).payPeriodViews[0].capturedClose.capturedAt === feb.capturedAt,
    'one view per period: the first closing, as in the reprint');
}

// T4: the page.
{
  const advice = run([feb]);
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
  const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
  vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
  context.a = advice; context.p = advice.payPeriodViews[0]; context.plan = today.data.plan;
  const timeline = vm.runInContext('badTimelineHtml(a)', context);
  ok(timeline.includes('data-bad-timeline-period="past:' + START + '"')
    && timeline.indexOf('past:' + START) < timeline.indexOf('past:2030-03-15'),
  'the timeline prints the saved period first');
  let html = null, error = null;
  try { html = vm.runInContext('calendarWaterfallHtml(p,null,null,plan,false)', context); } catch (e) { error = e; }
  ok(error === null && typeof html === 'string' && html.length > 0, 'the period sheet renders: ' + (error && error.message));
  ok(/data-budget-captured-close/.test(html), 'it reads as a saved close');
}

// T5: an acceptance world with a savings pool. The old close is moved into
// 2026, before that world's rebuilt lookback.
const H = require('./acceptance/harness');
const oldClose = shift(feb, '2026-06-05', '2026-06-18');
const savingsWorld = () => {
  const w = H.baseWorld();
  w.accounts.find(a => a.id === 'savings').value = 1000;
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true }];
  w.savingsPool = {};
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
};
{
  H.resetCaptures();
  const w = savingsWorld();
  const { data } = H.dataOf(w);
  const recommend = history => F.recommend(data.plan, w.asOf, F.budgetRecommendInputs({ ...data, periodHistory: history }, {}));
  const base = recommend(data.periodHistory || []);
  const withOld = recommend([...(data.periodHistory || []), oldClose]);
  ok(data.plan.savingsEarmarks?.allocationPolicy != null, 'the world runs the savings allocation path');
  ok(withOld.payPeriodViews[0].start === '2026-06-05' && withOld.payPeriodViews[0].capturedClose?.savedOnly === true,
    'the old close leads the timeline in a savings world');
  const rest = a => JSON.stringify({ savings: { ...a.savingsFunding, periodViews: undefined },
    views: a.payPeriodViews.filter(v => v.start !== '2026-06-05').map(v => ({ ...v, timelineOffset: 0 })) });
  ok(rest(base) === rest(withOld), 'no other view and no savings figure changes');
  H.resetCaptures();
}

function hasBrowser() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}
(async () => {
  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('  SKIP  T6 page case: Playwright Chromium is not available here');
  } else {
    // T6: the real Budget page.
    H.resetCaptures();
    const w = H.baseWorld();
    w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
    const { data } = H.dataOf(w);
    data.periodHistory = [...(data.periodHistory || []), oldClose];
    const p = await H.openBudget([data], { width: 1280 });
    try {
      const beads = await p.page.evaluate(() => [...document.querySelectorAll('[data-bad-timeline] li')]
        .map(li => li.getAttribute('data-bad-timeline-period')));
      ok(beads[0] === 'past:2026-06-05', 'the page timeline starts at the saved period: ' + beads.slice(0, 2).join(' '));
      await p.page.evaluate(() => sessionStorage.setItem('atlas.planSelection.v1',
        JSON.stringify({ look: null, periodId: 'past:2026-06-05' })));
      await p.reload();
      ok(/Jun 5–Jun 18/.test(await p.text('body')), 'selecting it shows its range');
      ok(await p.page.evaluate(() => !!document.querySelector('[data-budget-captured-close]')), 'and reads as a saved close');
    } finally { await p.close(); await H.closeBrowser(); H.resetCaptures(); }
  }
  console.log(`All ${checks} saved-close timeline checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
