'use strict';
// A saved close never shows today's figures as its own (bug hunt, saved
// closed-period fixes, PR 1). applyCapturedPeriodHistory overwrites a completed
// period with the figures the archive saved. A top-level field the archive does
// not keep used to survive from TODAY's rebuild, and print as the close's own
// beside saved rows it can contradict. Invented data only
// (test/fixtures/private-period-history-input.js; cycle Feb 1-14 2030).
//
//   S1 a close saved with a $30 bill, replayed under a plan that now says $45:
//      "Not confirmed paid" is Unknown, never today's $45, on the page
//   S2 the same rebuild's other plan-derived figures that the archive does not
//      keep (leftover, extra-debt allocation, card and purchase lines) read
//      as unavailable, not today's numbers
//   S3 an uncaptured period still publishes today's figure (control)
//   S4 the field audit: every top-level field that still comes from today's
//      rebuild is named here with a reason, so a new one fails until classified
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, END, NEXT, input } = require('./fixtures/private-period-history-input');

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const withPlan = (raw, bill) => {
  raw.data.plan.bills = [{ id: 'invented-bill', label: 'Invented bill', frequency: 'monthly', day: 10, amount: bill,
    confidence: 'confirmed', payingAccount: 'chequing-a' }];
  return raw;
};
const at = raw => { const clean = JSON.parse(JSON.stringify(raw)); const time = clean.capturedAt; delete clean.capturedAt; return [clean, () => new Date(time)]; };

// The close is saved on Feb 16 under a $30 bill.
const closeRaw = withPlan(input({ day: '2030-02-16', kind: 'closing', periodStart: START }), 30);
delete closeRaw.kind; delete closeRaw.periodStart;
const [late, lateNow] = at(closeRaw);
const closing = History.captureClosing(late, { now: lateNow });
const record = Pg.project(closing);
const saved = record.content.publication;
ok(saved.bills.length === 1 && saved.bills[0].remaining === 30 && saved.bills[0].status === 'planned',
  'the saved close holds the $30 bill, unconfirmed');
ok(!Object.hasOwn(saved, 'unconfirmedBills') && !Object.hasOwn(saved, 'leftover'),
  'the archive does not keep unconfirmedBills or leftover');

// Today (Feb 20) the plan says the bill is $45. A payday opening is recorded.
const todayPlan = () => {
  const raw = withPlan(input({ day: '2030-02-20', kind: 'first-observed', periodStart: NEXT }), 45);
  raw.data.plan.opening.paydaySnapshot = { periodStart: NEXT, asOf: NEXT, opening: 777 };
  return raw.data.plan;
};
const view = (history) => F.recommend(todayPlan(), '2030-02-20', { debts: [], periods: [], ...(history ? { periodHistory: history } : {}) })
  .payPeriodViews.find(row => row.start === START && row.end === END);
const past = view([record]);
const plain = view(null);

// S3 control: an uncaptured period is today's rebuild and still says so.
ok(!plain.capturedClose && plain.unconfirmedBills === 45 && plain.unconfirmedBillsTrust === 'calculated',
  "an uncaptured completed period still publishes today's Not confirmed paid (45)");

// S1 engine fields.
ok(past.capturedClose && past.lookback === true, 'the period is a saved close');
ok(past.bills.length === 1 && past.bills[0].remaining === 30, 'its bill row is the saved $30, not today\'s $45');
ok(past.unconfirmedBills === null && past.unconfirmedBillsTrust === 'unavailable',
  "Not confirmed paid is unavailable on a saved close, not today's 45");
ok(past.totalBillsThisPeriod === saved.totalBillsThisPeriod && past.paidBills === saved.paidBills
  && past.remainingBills === saved.remainingBills, 'the saved bill totals are the close\'s own');

// S2 the other plan-derived figures the archive does not keep.
ok(past.leftover === null, "leftover is withdrawn (today's would sit beside the saved afterBills)");
ok(past.afterBills === saved.afterBills, 'the saved afterBills is the close\'s own');
ok(plain.leftover && plain.leftover.afterBills !== saved.afterBills,
  "control: today's leftover really differs from the saved afterBills, so showing it would contradict");
ok(past.extraDebt && past.extraDebt.status === 'unavailable' && past.extraDebt.allocated === null && past.extraDebt.target === null,
  'the extra-debt allocation reads unavailable');
ok(past.firstCard === null && past.otherCards === null && past.bigPurchases === null,
  'the card and purchase lines are withdrawn');
// A figure the capture itself carries is never overwritten by the withdrawal.
const carrying = JSON.parse(JSON.stringify(record));
carrying.content.publication.leftover = { afterBills: 1.5 };
ok(view([carrying]).leftover.afterBills === 1.5, 'a key the capture carries stands');

// S1 page: the closed-period page path.
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
const render = period => { context.p = period; return vm.runInContext('historicalPeriodHtml(p)', context); };
const savedHtml = render(past), plainHtml = render(plain);
ok(/data-historical-period/.test(savedHtml) && /data-unconfirmed-bills data-unconfirmed-bills-trust="unavailable"/.test(savedHtml)
  && /Not confirmed paid<\/span><span>Unknown<\/span>/.test(savedHtml),
  'the closed-period page prints Not confirmed paid as Unknown');
ok(!/45\.00/.test(savedHtml), "today's $45.00 appears nowhere on the saved close's page");
ok(!/Remaining bills to pay/.test(savedHtml), 'the page does not fall back to a remainder line');
ok(/30\.00/.test(savedHtml), 'the saved $30.00 bill is on the page');
ok(/data-unconfirmed-bills-trust="calculated"/.test(plainHtml) && /45\.00/.test(plainHtml),
  'control: the uncaptured period page prints today\'s 45.00');

// S4 the field audit. Everything on a saved close either is carried by the
// capture, is identity, is withdrawn above, or is listed here as kept on
// purpose. A new today-only field fails this until someone classifies it.
const IDENTITY = new Set(['id', 'label', 'rangeLabel', 'start', 'end', 'role', 'projected', 'lookback', 'timelineRole',
  'timelineOffset', 'evidenceState']);
const WITHDRAWN = new Set(['unconfirmedBills', 'unconfirmedBillsTrust', 'leftover', 'extraDebt', 'firstCard', 'otherCards', 'bigPurchases']);
const SET_BY_REPLAY = new Set(['budgetProgress', 'capturedClose']);
const KEPT_FROM_TODAY = {
  spendingCycle: 'the cycle window dates, not a figure',
  spendingCycleLabel: 'the cycle window label, not a figure',
  operatingPlanNote: 'a null note on a completed period (only a current plan can be unavailable)',
  paydaySweep: 'null on a completed period: only a future period has a payday sweep',
  extraLabel: 'the static label "Extra"',
  cashNote: 'the static note "Lookback. Not today\'s balance."',
  plannedPeriodCloseReason: 'static reason text; a completed period has no planned close',
  paydayCarryoverKnown: 'the recorded payday opening observation, dated at the next payday; contradicts no saved field',
  paydayCarryover: 'same observation',
  paydayCarryoverAsOf: 'same observation',
  paydayCarryoverSource: 'same observation',
  paydayCarryoverPayday: 'the next payday date',
  plannedCostFunding: 'already unavailable for a completed period; status and reason only',
};
const carried = new Set(Object.keys(saved));
const rowKeys = new Set(['householdBudget', 'income', 'bills']);
const survivors = Object.keys(past).filter(key => !IDENTITY.has(key) && !carried.has(key) && !rowKeys.has(key)
  && !WITHDRAWN.has(key) && !SET_BY_REPLAY.has(key));
const unclassified = survivors.filter(key => !Object.hasOwn(KEPT_FROM_TODAY, key));
ok(unclassified.length === 0, 'every field still from today\'s rebuild is classified: ' + unclassified.join(', '));
const stale = Object.keys(KEPT_FROM_TODAY).filter(key => !survivors.includes(key));
ok(stale.length === 0, 'every classified kept field is really present (no dead entries): ' + stale.join(', '));
ok(past.paydayCarryoverKnown === true && past.paydayCarryover === 777, 'the kept payday carryover observation is as recorded');

console.log('PASS saved close never shows today\'s figures: ' + checks + ' checks');
