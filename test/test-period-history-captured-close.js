'use strict';
// #818 production semantic for a captured close. Invented household only
// (test/fixtures/private-period-history-input.js; cycles Feb 1-14, Feb 15-28).
//   S1 the plan changes after the period's first capture and before the
//      first post-period refresh: the closing records the plan in force at
//      its capture, and its policy differs from the earlier capture
//   S2 Forecast reprints that close for the completed period (not today's
//      plan) and flags the plan change; the page shows the note
//   S3 a later refresh cannot overwrite the closing
//   S4 acceptance-harness captures belong to one scenario
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, END, NEXT, input } = require('./fixtures/private-period-history-input');

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const withPlan = (raw, groceries, bill = 30) => {
  raw.data.plan.budget.categories.find(row => row.id === 'groceries').plannedPayday = groceries;
  raw.data.plan.bills = [{ id: 'invented-bill', label: 'Invented bill', frequency: 'monthly', day: 10, amount: bill,
    confidence: 'confirmed', payingAccount: 'chequing-a' }];
  return raw;
};
const at = raw => { const clean = JSON.parse(JSON.stringify(raw)); const time = clean.capturedAt; delete clean.capturedAt; return [clean, () => new Date(time)]; };

// S1: first capture on Feb 5 under groceries 40.
const [early, earlyNow] = at(withPlan(input({ day: '2030-02-05', kind: 'first-observed', periodStart: START }), 40));
const baseline = History.capture(early, { now: earlyNow });
// The owner raises groceries to 60 on Feb 15; the first post-period refresh is Feb 16.
const lateRaw = withPlan(input({ day: '2030-02-16', kind: 'closing', periodStart: START }), 60);
delete lateRaw.kind; delete lateRaw.periodStart;
const [late, lateNow] = at(lateRaw);
const closing = History.captureClosing(late, { now: lateNow });
ok(closing.content.kind === 'closing' && closing.content.period.start === START && closing.content.period.end === END,
  'the first post-period refresh captures the closing for Feb 1-14');
const groceries = record => record.content.publication.householdBudget.find(row => row.id === 'groceries');
ok(groceries(closing).plannedPayday === 60 && groceries(baseline).plannedPayday === 40,
  'the closing records the plan in force at its capture (60), not the earlier 40');
ok(closing.content.planBasis === 'see-baseline-revision'
  && closing.content.provenance.policyFingerprint !== baseline.content.provenance.policyFingerprint,
  'the closing policy differs from the earlier capture');

// S2: Forecast on Feb 20 under today's groceries 80 reprints the captured close.
const today = withPlan(input({ day: '2030-02-20', kind: 'first-observed', periodStart: NEXT }), 80, 45);
const records = [Pg.project(baseline), Pg.project(closing)];
const advice = F.recommend(today.data.plan, '2030-02-20', { debts: [], periods: [], periodHistory: records });
const past = advice.payPeriodViews.find(row => row.start === START && row.end === END);
ok(past && past.timelineRole === 'past', 'Feb 1-14 is a completed period on Feb 20');
ok(past.householdBudget.find(row => row.id === 'groceries').plannedPayday === 60,
  'the completed period shows its captured plan (60), not today\'s 80');
ok(past.capturedClose && past.capturedClose.planChangedSinceEarlierCapture === true
  && past.capturedClose.capturedAt === closing.capturedAt, 'Forecast flags the plan change since the earlier capture');
const plain = F.recommend(today.data.plan, '2030-02-20', { debts: [], periods: [] })
  .payPeriodViews.find(row => row.start === START);
ok(!plain.capturedClose && plain.householdBudget.find(row => row.id === 'groceries').plannedPayday === 80,
  'without history the completed period is today\'s rebuild, unflagged');
for (const bad of [[{}], [{ ...records[1], schema: 'other' }], [{ ...records[1], content: { ...records[1].content, period: { start: START, end: '2030-02-13' } } }], 'x']) {
  const row = F.recommend(today.data.plan, '2030-02-20', { debts: [], periods: [], periodHistory: bad }).payPeriodViews.find(r => r.start === START);
  ok(!row.capturedClose, 'a malformed or unmatched record changes nothing');
}
const same = F.recommend(today.data.plan, '2030-02-20', { debts: [], periods: [], periodHistory: [records[1]] })
  .payPeriodViews.find(row => row.start === START);
ok(same.capturedClose.planChangedSinceEarlierCapture === null, 'no earlier capture: the change is unknown, not asserted');

// The page shows the note beside the captured figure.
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
context.p = past; context.plan = today.data.plan;
const html = vm.runInContext('calendarWaterfallHtml(p,null,null,plan,false)', context);
ok(/data-budget-captured-close data-budget-captured-plan-changed/.test(html)
  && html.includes('close captured 2030-02-16'), 'the page says the plan changed and when the close was captured');
// Only a close complete at capture is its own qualification (Codex P1 on #867).
ok(past.capturedClose.closingState !== 'complete-at-capture' && /data-bad-historical-withheld/.test(html)
  && /data-budget-result-trust="unavailable"/.test(html),
  'a provisional captured close stays under the whole-period evidence rule');
const completeRecord = JSON.parse(JSON.stringify(records[1]));
completeRecord.content.closingState = 'complete-at-capture';
const complete = F.recommend(today.data.plan, '2030-02-20', { debts: [], periods: [], periodHistory: [records[0], completeRecord] })
  .payPeriodViews.find(row => row.start === START);
context.p = complete;
const completeHtml = vm.runInContext('calendarWaterfallHtml(p,null,null,plan,false)', context);
ok(!/data-bad-historical-withheld|data-bad-historical-reconstructed/.test(completeHtml),
  'a close complete at capture is neither withheld nor relabelled');
// No figure from today's rebuild survives under a captured row or aggregate (Codex P2 on #867).
ok(past.budgetProgress === null, "today's period progress is withdrawn for a captured close");
const todayRow = plain.householdBudget.find(row => row.id === 'groceries');
const capturedRow = past.householdBudget.find(row => row.id === 'groceries');
const kept = new Set(Object.keys(groceries(closing)));
ok(todayRow && Object.entries(capturedRow).every(([key, value]) => typeof value !== 'number' || kept.has(key)),
  'every number on a captured budget row is a captured number');
for (const key of ['householdBudget', 'income', 'bills']) {
  const capturedRows = closing.content.publication[key] || [];
  for (const row of past[key] || []) {
    const source = capturedRows.find(item => item.id === row.id) || {};
    ok(Object.entries(row).every(([field, value]) => typeof value !== 'number' || Object.hasOwn(source, field)),
      key + ' ' + row.id + ': no number from today\'s rebuild survives (e.g. a bill movement)');
  }
}
context.p = same;
ok(/data-budget-captured-close>/.test(vm.runInContext('calendarWaterfallHtml(p,null,null,plan,false)', context)),
  'an unflagged captured close says only that it was captured');

// S3: a later refresh cannot overwrite the closing.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-captured-close-test-'));
fs.chmodSync(dir, 0o700);
try {
  History.append({ destination: dir, enabled: true, candidate: baseline });
  History.append({ destination: dir, enabled: true, candidate: closing });
  const laterRaw = withPlan(input({ day: '2030-02-20', kind: 'closing', periodStart: START }), 80);
  delete laterRaw.kind; delete laterRaw.periodStart;
  const [later, laterNow] = at(laterRaw);
  const again = History.appendClosing({ destination: dir, enabled: true, input: later, now: laterNow });
  ok(again.status === 'already-captured' && again.revisionId === History.read({ destination: dir })
    .find(row => row.kind === 'closing').revisionId, 'a later refresh is a no-op against the existing closing');
  const kept = History.read({ destination: dir, revisionId: again.revisionId });
  ok(groceries(kept).plannedPayday === 60, 'the stored closing still carries the plan at its capture');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// S4: acceptance-harness captures are scenario-scoped.
const H = require('./acceptance/harness');
const world = () => { const w = H.baseWorld(); w.transactions = [H.lm({ date: '2026-10-03', amount: 70, category: 'Groceries' })]; return w; };
H.resetCaptures();
H.dataOf(world());
ok(H.capturedRecords().some(record => record.content.kind === 'closing'), 'a served world is captured like a production refresh');
const seen = H.dataOf(world()).data.periodHistory;
ok(Array.isArray(seen) && seen.length >= 1, 'a later world in the same scenario sees earlier captures');
H.resetCaptures();
const fresh = H.dataOf(world()).data.periodHistory;
ok(Array.isArray(fresh) && fresh.length === 0, 'a new scenario sees none of another scenario\'s captures');

console.log('PASS captured close semantics: ' + checks + ' checks');
