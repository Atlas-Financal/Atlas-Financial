'use strict';
// A captured close whose Other income was unobserved never replays as a
// confident $0.00 (#1077 reviewer residual). Invented household only
// (test/fixtures/private-period-history-input.js; cycle Feb 1-14).
//
// The history projection keeps otherIncome.amount (a native null stays null,
// never 0) but not the `unavailable` stamp, and drops the items. The replayed
// period therefore reaches the page as { amount: null }. The page reads a
// null amount (or an explicitly null Other income) as unobserved: Unavailable
// with a note, and never "No income in this period". A captured number,
// including a true 0, still prints as money.
//
// Path: History.captureClosing -> (Forecast's unobserved shape set on the
// captured publication, resealed) -> Pg.project (the served projection) ->
// Forecast.recommend periodHistory replay -> plan.js calendarIncomeHtml.
// `node test/test-replayed-other-income-unobserved.js`
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
const at = raw => { const clean = JSON.parse(JSON.stringify(raw)); const time = clean.capturedAt; delete clean.capturedAt; return [clean, () => new Date(time)]; };
const { digest } = History.contract;
const reseal = candidate => {
  const body = { schema: candidate.schema, capturedAt: candidate.capturedAt, content: candidate.content };
  return { ...body, captureId: digest(body) };
};

// A closing for Feb 1-14, captured on Feb 16.
const lateRaw = input({ day: '2030-02-16', kind: 'closing', periodStart: START });
delete lateRaw.kind; delete lateRaw.periodStart;
const [late, lateNow] = at(lateRaw);
const closing = History.captureClosing(late, { now: lateNow });
ok(closing.content.kind === 'closing' && closing.content.period.start === START, 'a closing is captured for Feb 1-14');
const withOther = otherIncome => {
  const copy = JSON.parse(JSON.stringify(closing));
  copy.content.publication.otherIncome = otherIncome;
  return Pg.project(reseal(copy));
};

const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
const incomeHtml = period => { context.p = period; return vm.runInContext('calendarIncomeHtml(p)', context); };
const otherLine = html => { const at = html.indexOf('data-other-income'); return at < 0 ? '' : html.slice(at, at + 600); };

const today = input({ day: '2030-02-20', kind: 'first-observed', periodStart: NEXT });
const replay = record => F.recommend(today.data.plan, '2030-02-20', { debts: [], periods: [], periodHistory: [record] })
  .payPeriodViews.find(row => row.start === START && row.end === END);

// Forecast's unobserved shape, as #1077 publishes it, through the projection.
const unobserved = withOther({ amount: null, items: [], unavailable: true });
ok(unobserved.content.publication.otherIncome.amount === null
  && !Object.hasOwn(unobserved.content.publication.otherIncome, 'unavailable'),
'the projection keeps the null amount but drops the stamp (the residual this test covers)');
const past = replay(unobserved);
ok(past && past.capturedClose && past.timelineRole === 'past', 'Feb 1-14 replays as a captured close');
ok(past.otherIncome && past.otherIncome.amount === null && past.otherIncome.unavailable === undefined,
  'the replayed period reaches the page as { amount: null }, with no stamp');
const html = incomeHtml(past);
ok(/Unavailable/.test(otherLine(html)) && !/\$0\.00/.test(otherLine(html)), 'the replayed Other income reads Unavailable, never $0.00');
ok(/data-other-income-unobserved/.test(html), 'the page says why');

// With nothing named either, the replay never claims "No income in this period".
const bare = { ...past, income: [] };
ok(!/No income in this period/.test(incomeHtml(bare)) && /Unavailable/.test(otherLine(incomeHtml(bare))),
  'an unobserved replay with nothing named does not say "No income in this period"');

// An explicitly null Other income publication is unknown the same way.
const nullPub = replay(withOther(null));
ok(nullPub.otherIncome === null, 'an explicitly null Other income replays as null');
ok(/Unavailable/.test(otherLine(incomeHtml(nullPub))) && !/\$0\.00/.test(otherLine(incomeHtml(nullPub))),
  'an explicitly null Other income reads Unavailable, never $0.00');

// Controls: a captured number prints as money, a true zero included.
for (const [amount, text] of [[0, '$0.00'], [25, '$25.00']]) {
  const row = replay(withOther({ amount, items: [] }));
  ok(row.otherIncome.amount === amount, `a captured ${amount} replays as ${amount}`);
  const line = otherLine(incomeHtml(row));
  ok(line.includes(text) && !/Unavailable/.test(line), `a captured ${amount} still prints ${text}`);
}
const covered = { ...replay(withOther({ amount: 0, items: [] })), income: [] };
ok(/No income in this period/.test(incomeHtml(covered)), 'control: a captured true zero with nothing named still says so');

console.log(`All replayed Other income checks passed (${checks}).`);
