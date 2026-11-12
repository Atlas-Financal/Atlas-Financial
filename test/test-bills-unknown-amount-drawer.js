'use strict';
// A pay period with a bill of unknown amount shows its Bills drawer lines
// instead of a bare "Unavailable." (Budget waterfall step wrapper in
// public/plan.js: the Bills step passes discloseUnknown). Runs in the VM, so it
// runs in CI where the browser suites do not. Invented data only
// (test/fixtures/private-period-history-input.js; cycle Feb 1-14 2030).
//
//   U1 a live-replayed completed period with an unknown bill: the drawer prints
//      the bill rows, Total bills this period Unknown, Not confirmed paid
//      Unknown; never $0.00, never a remainder line, never the bare step
//   U2 a current period with an unknown bill: the rows print, the total stays
//      unprinted (never a guessed or $0.00 total), no completed-period lines
//   U3 a SAVED close with an unknown bill (Grok Bot, #1113): no "Not confirmed
//      paid" line and no today's figures, exactly as before
//   U4 controls: a known bill still prints its known total and Not confirmed paid
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
const known = { id: 'invented-known', label: 'Invented known bill', frequency: 'monthly', day: 10, amount: 30,
  confidence: 'confirmed', payingAccount: 'chequing-a' };
const unknown = { id: 'invented-unknown', label: 'Invented unknown bill', frequency: 'monthly', day: 12, amount: null,
  confidence: 'confirmed', payingAccount: 'chequing-a' };
const withBills = (raw, bills) => { raw.data.plan.bills = bills; return raw; };
const at = raw => { const clean = JSON.parse(JSON.stringify(raw)); const time = clean.capturedAt; delete clean.capturedAt; return [clean, () => new Date(time)]; };

// A close saved on Feb 16 while one bill's amount was unknown.
const closeRaw = withBills(input({ day: '2030-02-16', kind: 'closing', periodStart: START }), [known, unknown]);
delete closeRaw.kind; delete closeRaw.periodStart;
const [late, lateNow] = at(closeRaw);
const record = Pg.project(History.captureClosing(late, { now: lateNow }));

const todayPlan = (day, periodStart, bills) => {
  const raw = withBills(input({ day, kind: 'first-observed', periodStart }), bills);
  raw.data.plan.opening.paydaySnapshot = { periodStart, asOf: periodStart, opening: 777 };
  return raw.data.plan;
};
const views = (day, periodStart, bills, history) => F.recommend(todayPlan(day, periodStart, bills), day,
  { debts: [], periods: [], ...(history ? { periodHistory: history } : {}) }).payPeriodViews;

const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
// The Budget waterfall (the real page path, with the step wrapper) for one period.
const waterfall = (period, plan) => { context.p = period; context.pl = plan || null;
  return vm.runInContext('calendarWaterfallHtml(p,null,null,pl)', context); };
const billsStep = html => { const m = /data-operating-question="04"[\s\S]*?(?=data-operating-question="05"|data-operating-question="06"|$)/.exec(html); return m ? m[0] : ''; };
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// U1 live-replayed completed period, unknown bill.
const liveClosed = views('2030-02-20', NEXT, [known, unknown]).find(row => row.start === START && row.end === END);
ok(liveClosed && liveClosed.lookback === true && !liveClosed.capturedClose, 'the period is a live-replayed completed period');
ok(liveClosed.totalBillsThisPeriod == null && liveClosed.unconfirmedBills == null, 'Forecast publishes the total and Not confirmed paid as unknown');
const liveHtml = billsStep(waterfall(liveClosed));
const liveText = text(liveHtml);
// Forecast emits no row for an unknown in-window amount on a completed period (it is the Unknown total below).
ok(/Invented known bill/.test(liveText) && /Planned \$30\.00/.test(liveText), 'U1 the paid/unpaid rows Forecast publishes print instead of a bare Unavailable');
ok(/Total bills this period Unknown/.test(liveText), 'U1 the total reads Unknown');
ok(/Not confirmed paid Unknown/.test(liveText) && /data-unconfirmed-bills-trust="unavailable"/.test(liveHtml), 'U1 Not confirmed paid reads Unknown, trust unavailable');
ok(!/Remaining bills to pay|Remaining bill reserve/.test(liveText), 'U1 no remainder line');
ok(!/Total bills this period \$|Not confirmed paid \$/.test(liveText), 'U1 no number stands in for the unknown totals');

// U2 current period, unknown bill (Feb 15-28; the unknown bill is due Feb 12 each month so use day 20).
const unknownLater = { ...unknown, day: 20 }, knownLater = { ...known, day: 18 };
const current = views('2030-02-16', NEXT, [knownLater, unknownLater]).find(row => row.role === 'current' || row.start === NEXT);
ok(current && !current.lookback && current.bills.length >= 1, 'a current period with a bill of unknown amount');
const currentText = text(billsStep(waterfall(current)));
ok(/Invented unknown bill/.test(currentText), 'U2 the current period rows print');
ok(!/Total bills this period/.test(currentText) && !/Not confirmed paid/.test(currentText), 'U2 no total and no completed-period line');

// U3 saved close, unknown bill.
const savedClosed = views('2030-02-20', NEXT, [{ ...known, amount: 45 }, unknown], [record]).find(row => row.start === START && row.end === END);
ok(savedClosed.capturedClose && savedClosed.lookback === true, 'U3 the period is a saved close');
for (const [label, html] of [['waterfall', waterfall(savedClosed)], ['historical page', (context.p = savedClosed, vm.runInContext('historicalPeriodHtml(p)', context))]]) {
  const t = text(billsStep(html));
  ok(!/Not confirmed paid/.test(html) && !/data-unconfirmed-bills/.test(html), 'U3 ' + label + ': a saved close prints no Not confirmed paid line');
  ok(!/Remaining bills to pay|Remaining bill reserve/.test(t), 'U3 ' + label + ': no remainder line');
  ok(!/45\.00/.test(t) && /30\.00/.test(t), 'U3 ' + label + ": the saved $30.00 bill prints, today's $45.00 appears nowhere in the Bills step");
}

// U4 controls: a known bill keeps its known total and Not confirmed paid.
const knownClosed = views('2030-02-20', NEXT, [known]).find(row => row.start === START && row.end === END);
const knownText = text(billsStep(waterfall(knownClosed)));
ok(/Total bills this period \$30\.00/.test(knownText) && /Not confirmed paid \$30\.00/.test(knownText), 'U4 a known bill prints $30.00 total and Not confirmed paid');
ok(!/Total bills this period Unknown/.test(knownText), 'U4 a known total never reads Unknown');

// U5 a bill with a finite amount but unknown confidence: Forecast's period bill
// load is unavailable, so no total, remainder or unconfirmed figure prints as a
// number (the step headline says Unavailable and the drawer must not read more
// certain than it), for a current period and for a live-replayed closed one.
const lowConfidence = { ...unknown, amount: 30, confidence: 'unknown' };
const lowCurrent = views('2030-02-16', NEXT, [{ ...known, day: 18 }, { ...lowConfidence, day: 20 }]).find(row => row.role === 'current' || row.start === NEXT);
ok(lowCurrent && lowCurrent.periodBillLoadTrust === 'unavailable' && lowCurrent.totalBillsThisPeriod != null, 'U5 Forecast publishes a finite total with an unavailable bill load');
const lowText = text(billsStep(waterfall(lowCurrent)));
ok(/Invented unknown bill/.test(lowText), 'U5 the current period rows print');
ok(!/Total bills this period \$|Remaining bills to pay \$|Remaining bill reserve \$/.test(lowText), 'U5 no total or remainder prints as a number with an unavailable bill load');
const lowClosed = views('2030-02-20', NEXT, [known, lowConfidence]).find(row => row.start === START && row.end === END);
const lowClosedText = text(billsStep(waterfall(lowClosed)));
ok(lowClosed.periodBillLoadTrust === 'unavailable', 'U5 the closed period bill load is unavailable');
ok(!/Total bills this period \$|Not confirmed paid \$|Remaining bills to pay \$/.test(lowClosedText), 'U5 a closed period prints no total or unconfirmed number either');
ok(/Not confirmed paid Unknown/.test(lowClosedText), 'U5 a closed live-replayed period prints Not confirmed paid Unknown');
ok(!/Paid bills this period \$/.test(lowText) && !/Paid bills this period \$/.test(lowClosedText), 'U5 no bare Paid bills total prints under an unavailable bill load either (the rows carry their own paid state)');

console.log('PASS bills of unknown amount show their drawer lines: ' + checks + ' checks');
