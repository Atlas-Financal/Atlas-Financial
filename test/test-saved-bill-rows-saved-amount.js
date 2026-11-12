'use strict';
// Saved bill rows print their saved amount, tagged as the close saved it (bug
// hunt, saved closed-period fixes, PR 2). The Bills list reads a row's display
// amount (`movement`) and its tag (`displayAmountTrust`). The archive keeps
// neither, so a saved bill row printed "Unavailable" for every amount. They are
// now derived from what the close saved, by the live builder's rule, and the
// tag is never more certain than the saved one (owner stop 2). Invented data
// only (test/fixtures/private-period-history-input.js; cycle Feb 1-14 2030).
//
//   S1 a saved scheduled bill prints its SAVED amount, not today's, and not
//      "Unavailable"; the tag follows the saved confidence word
//   S2 a saved paid bill prints its observed actual, never tagged calculated
//      (a saved row carries no posting evidence)
//   S3 an amount the close did not save stays Unavailable
//   S4 the tag is never more certain than the saved one, over every combination
//   S5 what the capture itself carries is never overwritten
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
const withPlan = (raw, bill, confidence) => {
  raw.data.plan.bills = [{ id: 'invented-bill', label: 'Invented bill', frequency: 'monthly', day: 10, amount: bill,
    confidence, payingAccount: 'chequing-a' }];
  return raw;
};
const at = raw => { const clean = JSON.parse(JSON.stringify(raw)); const time = clean.capturedAt; delete clean.capturedAt; return [clean, () => new Date(time)]; };
const saveClose = (bill, confidence) => {
  const raw = withPlan(input({ day: '2030-02-16', kind: 'closing', periodStart: START }), bill, confidence);
  delete raw.kind; delete raw.periodStart;
  const [late, now] = at(raw);
  return Pg.project(History.captureClosing(late, { now }));
};
// Today (Feb 20) the plan says the bill is $45.
const replay = (records) => {
  const raw = withPlan(input({ day: '2030-02-20', kind: 'first-observed', periodStart: NEXT }), 45, 'confirmed');
  return F.recommend(raw.data.plan, '2030-02-20', { debts: [], periods: [], periodHistory: records })
    .payPeriodViews.find(row => row.start === START && row.end === END);
};
const withRow = (record, patch) => {
  const copy = JSON.parse(JSON.stringify(record));
  copy.content.publication.bills[0] = { ...copy.content.publication.bills[0], ...patch };
  return copy;
};

// The Bills list page path.
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
const listAmount = row => {
  context.r = row;
  const html = vm.runInContext('budgetBillBrowseRowHtml(r)', context);
  return (html.match(/budget-bill-amount">([\s\S]*?)<\/span><span class="budget-bill-state"/) || [])[1] || '';
};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const billOf = view => view.bills[0];

// S1 scheduled, confirmed.
const confirmed = saveClose(30, 'confirmed');
ok(confirmed.content.publication.bills[0].planned === 30 && !Object.hasOwn(confirmed.content.publication.bills[0], 'movement')
  && !Object.hasOwn(confirmed.content.publication.bills[0], 'displayAmountTrust'),
  'the archive keeps the $30 planned amount but no display amount or tag');
const pastConfirmed = replay([confirmed]);
ok(pastConfirmed.capturedClose && billOf(pastConfirmed).planned === 30, 'the period is the saved close, with its $30 bill');
ok(billOf(pastConfirmed).movement === -30 && billOf(pastConfirmed).displayAmountBasis === 'schedule'
  && billOf(pastConfirmed).displayAmountTrust === 'calculated', 'the display amount is the saved 30, tagged calculated');
ok(text(listAmount(billOf(pastConfirmed))) === '$30.00', 'the Bills list prints the saved $30.00, not Unavailable, not today\'s $45.00');

// S1 scheduled, estimated: the saved word is estimated, so the print is marked.
const estimated = saveClose(30, 'estimated');
const pastEstimated = replay([estimated]);
ok(billOf(pastEstimated).displayAmountTrust === 'estimated'
  && /≈/.test(listAmount(billOf(pastEstimated))) && /30\.00/.test(listAmount(billOf(pastEstimated))),
  'an estimated saved bill prints its saved amount marked estimated');

// S1 a saved row is not today's row: today's plan amount (45) never prints.
for (const past of [pastConfirmed, pastEstimated]) ok(!/45\.00/.test(listAmount(billOf(past))), "today's $45.00 does not print on a saved bill");

// S2 a saved paid bill with an observed actual.
const paid = withRow(confirmed, { status: 'PAID', settlement: 'represented', actual: 52.67, remaining: 0, planned: 47.39, amount: 47.39 });
const pastPaid = replay([paid]);
ok(billOf(pastPaid).movement === -52.67 && billOf(pastPaid).displayAmountBasis === 'unconfirmed-actual'
  && billOf(pastPaid).displayAmountTrust === 'estimated', 'a paid saved row displays its observed actual, tagged estimated');
ok(/≈/.test(listAmount(billOf(pastPaid))) && /52\.67/.test(listAmount(billOf(pastPaid))),
  'the Bills list prints 52.67 marked estimated, never as a bare confirmed figure');
ok(billOf(pastPaid).displayAmountTrust !== 'calculated' && billOf(pastPaid).displayAmountBasis !== 'posted-actual',
  'a saved row is never claimed as a posted actual (it carries no posting evidence)');
// Paid with no observed actual displays the planned amount, as the live builder does.
const paidNoActual = replay([withRow(confirmed, { status: 'PAID', settlement: 'represented', actual: null, remaining: 0 })]);
ok(billOf(paidNoActual).movement === -30 && billOf(paidNoActual).displayAmountBasis === 'schedule', 'paid without an actual displays the planned amount');

// S3 no saved amount: Unavailable, never invented.
const noAmount = replay([withRow(confirmed, { planned: null, amount: null, remaining: null, actual: null })]);
ok(!Object.hasOwn(billOf(noAmount), 'movement') && /Unavailable/.test(listAmount(billOf(noAmount))),
  'a bill the close saved no amount for prints Unavailable');

// S3 an unrecognised saved confidence word is unknown, never a bare figure.
const guessed = replay([withRow(confirmed, { confidence: 'guessed' })]);
ok(billOf(guessed).displayAmountTrust === 'unknown' && /Unavailable/.test(listAmount(billOf(guessed))),
  'an unrecognised saved confidence word prints Unavailable, never a bare amount');

// S4 never more certain than the saved tag, over every saved combination.
// How certain a tag reads on the page: unknown prints Unavailable, estimated prints marked,
// and calculated or no word at all prints a bare figure.
const RANK = { unknown: 0, estimated: 2, calculated: 3, null: 3 };
const savedRank = row => row.confidence === 'confirmed' ? RANK.calculated : row.confidence === 'estimated' ? RANK.estimated
  : row.confidence == null ? RANK.null : RANK.unknown;
let combos = 0;
for (const confidence of ['confirmed', 'estimated', 'guessed', null]) {
  for (const [status, settlement, actual] of [['planned', 'unverified', null], ['PAID', 'represented', 52.67], ['PAID', 'represented', null],
    ['unconfirmed', 'unverified', null], ['PAID', 'opening', 10]]) {
    const past = replay([withRow(confirmed, { confidence, status, settlement, actual })]);
    const row = billOf(past);
    const trust = row.displayAmountTrust;
    ok(RANK[String(trust)] !== undefined, 'the tag is one of the known words: ' + trust);
    ok(RANK[String(trust)] <= savedRank({ confidence }), `never more certain than saved (${confidence}, ${status}/${settlement}/${actual}): ${trust}`);
    ok(trust !== 'calculated' || (confidence === 'confirmed' && !(status === 'PAID' && settlement === 'represented' && actual != null)),
      'calculated only for a confirmed scheduled amount');
    combos++;
  }
}
ok(combos === 20, 'every saved combination was checked');

// S5 what the capture carries stands.
const carrying = withRow(confirmed, { movement: -12.34, displayAmountTrust: 'estimated', displayAmountBasis: 'schedule' });
const pastCarrying = replay([carrying]);
ok(billOf(pastCarrying).movement === -12.34 && billOf(pastCarrying).displayAmountTrust === 'estimated',
  'a display amount or tag the capture itself carries is never overwritten');

console.log('PASS saved bill rows print their saved amount: ' + checks + ' checks');
