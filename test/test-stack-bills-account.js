'use strict';
/* The Bills account stack card (lead dispatch, ATLAS LEAD 12, 2026-11-24). Forecast publishes, per active pay period,
 * stackSummary.billsAccount: the Bills bank reading now (billsAccountPeriodBalance.observedCash and its date), and the
 * named, dated lines that the period-end Bills close already counts (income coming in, Bills bills and other Bills
 * outflows coming out, the Household budget still to move) plus the Bills bills already settled this period. The page
 * prints them as given.
 *
 *   1. An invented world where only some bills pay from Bills: the card's lists are exactly the Bills lines, a bill paid
 *      from another account is excluded, a past-due unsettled bill reads 'late', and each list reconciles to the close's
 *      own published terms (independently worked by hand below). The close itself is byte-equal to main.
 *   2. A stale, misaligned or missing reading: no amount, Forecast's reason, no lists.
 *   3. End to end through recommend and the real stack-cards.js: the closed card, the open card, the sheets.
 *   4. Mutants: the account scope, the late word and the reading guard, each removed, are caught.
 *
 * Invented data only (test/fixtures/bills-period-end-balance-data.js plus three invented bills).
 * `node test/test-stack-bills-account.js`
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/bills-period-end-balance-data');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const BASE = 'b2a821ebd356a91deea07f586a49bf5fbaefc933'; // main before this change (#1617 merged)
const show = file => cp.execFileSync('git', ['show', BASE + ':' + file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
function engine(sources) {
  const c = { console };
  c.window = c;
  vm.createContext(c);
  for (const file of ['public/display-name.js', 'public/forecast-card-period.js', 'public/forecast.js']) vm.runInContext(sources(file), c);
  return c.Forecast;
}

// The invented world. The fixture's Bills week (as of 2026-08-20, period 2026-08-14..2026-08-27) plus:
//   paid-bills   45.12 from Bills on 08-16, settled (a represented actual): Already out.
//   weekly-bill  51.30 from Weekly (chequing-b) on 08-22: not a Bills line, on no list.
//   late-bill    62.40 from Bills on 08-18, unpaid and past due: Coming out, 'late'.
// Hand-worked lists:
//   Coming in:  the partner salary 643.17 on 08-25 (the fixture's only income still to land in Bills).
//   Coming out: late-bill 62.40 (08-18, late), the commitment 27.19 (08-23), the service 93.41 (08-24).
//     Bills bills 62.40 + 93.41 = 155.81; other Bills outflows 27.19.
//   Household budget still to move: 520.37 − 359.86 = 160.51 (the fixture's own working).
//   Now: 1373.29, read 2026-08-20.
function world(mode) {
  const d = fx.served(), p = d.plan, pk = d.liveOverlay.currentPeriodActuals;
  p.bills.push({ id: 'paid-bills', label: 'Invented paid utility', frequency: 'once', date: '2026-08-16', amount: 45.12, confidence: 'confirmed', payingAccount: 'chequing-a' });
  p.bills.push({ id: 'weekly-bill', label: 'Invented weekly-paid bill', frequency: 'once', date: '2026-08-22', amount: 51.30, confidence: 'confirmed', payingAccount: 'chequing-b' });
  p.bills.push({ id: 'late-bill', label: 'Invented late bill', frequency: 'once', date: '2026-08-18', amount: 62.40, confidence: 'confirmed', payingAccount: 'chequing-a' });
  pk.representedActuals.push({ id: 'paid-bills', date: '2026-08-16', actual: 45.12 });
  if (mode === 'stale') d.liveOverlay.operatingPlan = 'unavailable';
  if (mode === 'misaligned') d.liveOverlay.observedCash.accounts[0].value = 1400.01;
  if (mode === 'missing') {
    p.startingCash.breakdown = p.startingCash.breakdown.filter(r => r.id !== 'chequing-a');
    d.liveOverlay.observedCash.accounts = d.liveOverlay.observedCash.accounts.filter(r => r.id !== 'chequing-a');
  }
  d.meta = { ...(d.meta || {}), asOf: fx.AS_OF };
  return d;
}
const advise = (E, d) => E.recommend(d.plan, fx.AS_OF, E.budgetRecommendInputs(d, {}));
const activeOf = advice => advice.payPeriodViews.find(v => v.role === 'active');

console.log('1. Only some bills pay from Bills: the lists are exactly the Bills lines');
const advice = advise(F, world());
const view = activeOf(advice);
const ba = view.stackSummary.billsAccount;
const close = view.billsAccountPeriodBalance;
ok(ba && ba.status === 'ready' && ba.reason === null, 'the card is published, ready, for the active pay period', JSON.stringify(ba && ba.status));
ok(cents(ba.now.amount) === 137329 && ba.now.asOf === '2026-08-20' && ba.now.trust === 'estimated' && ba.now.reason === null,
  'now: 1373.29, read 2026-08-20 (the close\'s observedCash and its date), tagged estimated', JSON.stringify(ba.now));
ok(JSON.stringify(ba.comingIn.map(r => [r.id, r.date, cents(r.amount)])) === JSON.stringify([['partner', '2026-08-25', 64317]]),
  'coming in: the partner salary 643.17 on 08-25, nothing else', JSON.stringify(ba.comingIn));
ok(JSON.stringify(ba.comingOut.map(r => [r.id, r.date, cents(r.amount), r.status])) === JSON.stringify([
  ['late-bill', '2026-08-18', 6240, 'late'], ['cost', '2026-08-23', 2719, 'due'], ['service', '2026-08-24', 9341, 'due']]),
  'coming out, in date order: late-bill 62.40 late, the commitment 27.19, the service 93.41', JSON.stringify(ba.comingOut));
ok(![...ba.comingIn, ...ba.comingOut, ...ba.alreadyOut].some(r => r.id === 'weekly-bill')
  && view.bills.some(r => r.id === 'weekly-bill'), 'the bill paid from Weekly is on the period\'s bills but on no Bills account list');
ok(cents(ba.householdToMove.amount) === 16051 && ba.householdToMove.trust === 'estimated',
  'Household budget still to move: 160.51 (520.37 − 359.86)', JSON.stringify(ba.householdToMove));
const paidRow = view.bills.find(r => r.id === 'paid-bills');
ok(ba.alreadyOut.length === 1 && ba.alreadyOut[0].id === 'paid-bills' && cents(ba.alreadyOut[0].amount) === 4512
  && ba.alreadyOut[0].paid === (paidRow.stackBillPaid === true) && ba.alreadyOut[0].trust === paidRow.stackBillAmountTrust,
  'already out: the settled 45.12 Bills bill, with the bill row\'s own amount, trust and paid check', JSON.stringify(ba.alreadyOut));
// Each list reconciles to the close's own published terms (no term moved, nothing counted twice or left out).
const sum = rows => rows.reduce((t, r) => t + cents(r.amount), 0);
ok(sum(ba.comingIn) === cents(close.futureIncome) && sum(ba.comingOut.filter(r => r.billRow)) === cents(close.remainingBills)
  && sum(ba.comingOut.filter(r => !r.billRow)) === cents(close.otherOutflows) && cents(close.remainingBills) === 15581,
  'the lists add up to the close\'s futureIncome, remainingBills (155.81 by hand) and otherOutflows',
  JSON.stringify([close.futureIncome, close.remainingBills, close.otherOutflows]));
ok(ba.comingOut.filter(r => r.billRow).map(r => r.id).join() === 'late-bill,service' && !ba.comingIn[0].billRow,
  'bill lines carry billRow (they open the bill sheet); income and the commitment do not');
ok(advice.payPeriodViews.filter(v => v.role !== 'active').every(v => !v.stackSummary || v.stackSummary.billsAccount === null),
  'no other pay period carries the card');
// The close itself (every published field but the new display list) is byte-equal to main.
const OLD = engine(show);
const oldClose = activeOf(advise(OLD, world())).billsAccountPeriodBalance;
ok(JSON.stringify(close) === JSON.stringify(oldClose),
  'billsAccountPeriodBalance is byte-equal to main: the lines are kept beside it, never on it (its saved records stay exact)');
ok(JSON.stringify(advice.defaultView.billsAccountPeriodBalance) === JSON.stringify(close),
  'the default view publishes the same close');

{
  // The figures snapshot (the private diff's source) carries each card figure as published.
  const snap = require('../scripts/figures-snapshot').buildFiguresSnapshot(world(), null);
  const k = 'period.' + view.start + '.';
  const want = { stackBillsAccountNow: ba.now.amount, stackBillsAccountNowAsOf: ba.now.asOf, stackBillsAccountHousehold: ba.householdToMove.amount,
    'stackBillsAccountOut.late-bill@2026-08-18.status': 'late', 'stackBillsAccountOut.service@2026-08-24.amount': 93.41,
    'stackBillsAccountIn.partner@2026-08-25.amount': 643.17, 'stackBillsAccountSettled.paid-bills@2026-08-16.paid': ba.alreadyOut[0].paid };
  const bad = Object.entries(want).filter(([key, value]) => snap[k + key] !== value);
  ok(!bad.length && !Object.keys(snap).some(key => key.includes('weekly-bill') && key.includes('stackBillsAccount')),
    'the figures snapshot captures the card\'s figures as published, and no Weekly-paid line', JSON.stringify(bad));
}

console.log('2. A stale, misaligned or missing reading: a dash, Forecast\'s reason, no lists');
for (const [mode, code] of [['stale', 'operating-plan-unavailable'], ['misaligned', 'cash-observation-misaligned'],
  ['missing', 'bills-cash-unavailable']]) {
  const v = activeOf(advise(F, world(mode)));
  const b = v.stackSummary.billsAccount, issue = v.billsAccountPeriodBalance.issues.find(i => i.code === code);
  ok(b && b.now.amount === null && b.now.asOf === null && b.now.trust === 'unavailable' && issue && b.now.reason === issue.message,
    mode + ': no amount, no date, the reason is the close\'s own (' + code + ')', JSON.stringify(b && b.now));
  ok(b.status === 'unavailable' && b.comingIn === null && b.comingOut === null && b.alreadyOut === null
    && b.householdToMove.amount === null, mode + ': the lists are withheld with the close', JSON.stringify(b.status));
}

console.log('3. Through the real stack-cards.js');
const shellBox = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
vm.runInNewContext(read('public/stack-shell.js'), shellBox);
const shell = shellBox.window.StackBlocks;
const STACK = { register: () => {}, isEstimated: shell.isEstimated, estClass: shell.estClass, budgetTrust: shell.budgetTrust,
  barWidth: shell.barWidth, money: shell.money, billName: shell.billName };
function loadCards(source) {
  const box = { module: { exports: {} }, window: { StackBlocks: STACK }, StackBlocks: STACK, Intl, Date };
  box.exports = box.module.exports;
  vm.runInNewContext(source, box);
  return box.module.exports;
}
const CARDS = loadCards(read('public/stack-cards.js'));
const cardOf = (v, cards = CARDS) => {
  const html = cards.buildCardsHTML({ data: {}, plan: {}, recommendation: { payPeriodViews: [v] }, selectedPeriodKey: v.start });
  const at = html.indexOf('data-stack-card="billsacct"');
  return at < 0 ? null : html.slice(html.lastIndexOf('<details', at), html.indexOf('</details>', at));
};
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const head = h => text(h.slice(h.indexOf('<summary'), h.indexOf('</summary>')));
const card = cardOf(view);
ok(card && head(card) === 'Bills account Bank reading Aug 20 $1,373 now', 'closed: "Bills account", "Bank reading Aug 20", "$1,373 now"', head(card || ''));
ok(!/sc-bar/.test(card), 'no bar on the card head');
const body = text(card.slice(card.indexOf('</summary>')));
ok(body === 'Coming in Invented partner salary Aug 25 $643 Coming out · this pay period Invented late bill Aug 18 · late $62 '
  + 'Invented commitment Aug 23 $27 Invented service Aug 24 $93 Household budget still to move $161 Already out Invented paid utility Aug 16 $45',
  'open: the three sections, in Forecast\'s order, with Forecast\'s words and amounts', body);
ok(!/weekly-paid/i.test(card), 'the Weekly-paid bill is not printed');
ok(/data-stack-sheet="bill:late-bill@2026-08-18"/.test(card) && /data-stack-sheet="bill:service@2026-08-24"/.test(card)
  && /data-stack-sheet="bill:paid-bills@2026-08-16"/.test(card) && (card.match(/data-stack-sheet=/g) || []).length === 3,
  'each bill line opens its bill sheet; income, the commitment and the household line do not');
ok(/sc-check/.test(card) === (paidRow.stackBillPaid === true), 'the paid check follows Forecast\'s paid check');
{
  const checked = JSON.parse(JSON.stringify(view));
  checked.stackSummary.billsAccount.alreadyOut[0].paid = true;
  ok((cardOf(checked).match(/sc-check/g) || []).length === 1, 'a paid settled bill is ticked, once');
}
for (const mode of ['stale', 'misaligned', 'missing']) {
  const v = activeOf(advise(F, world(mode))), h = cardOf(v), b = v.stackSummary.billsAccount;
  ok(h && head(h) === 'Bills account ' + b.now.reason + ' —' && !/\$/.test(h), mode + ': the head is a dash with the reason; no amount anywhere', head(h || ''));
}
{
  const other = advice.payPeriodViews.find(v => v.role !== 'active' && v.stackSummary);
  ok(other && cardOf(other) === null, 'no card on another pay period');
}
ok(!/estimat/i.test(card) && !/sc-est|est-/i.test(card), 'no estimate styling and no estimate words on the card');

console.log('4. Mutants');
const mutant = (label, file, from, to, check) => {
  const src = read(file);
  assert.ok(src.includes(from), 'mutant anchor missing: ' + label);
  const sources = f => f === file ? src.replace(from, to) : read(f);
  let caught = false;
  try { caught = !check(sources); } catch (e) { caught = true; }
  ok(caught, 'mutant caught: ' + label);
};
const fresh = sources => activeOf(advise(engine(sources), world())).stackSummary.billsAccount;
mutant('a settled bill from another account listed', 'public/forecast.js',
  "if (row.settlement === 'represented' && row.id && row.date && billsCashScope(row))",
  "if (row.settlement === 'represented' && row.id && row.date)",
  sources => { const d = world(); d.liveOverlay.currentPeriodActuals.representedActuals.push({ id: 'weekly-bill', date: '2026-08-22', actual: 51.30 });
    const b = activeOf(advise(engine(sources), d)).stackSummary.billsAccount;
    return !b.alreadyOut.some(r => r.id === 'weekly-bill'); });
mutant('the late word dropped', 'public/forecast.js', "item.date && item.date < day ? 'late' : 'due'", "'due'",
  sources => fresh(sources).comingOut.find(r => r.id === 'late-bill').status === 'late');
mutant('the reading guard dropped', 'public/forecast.js', 'const now = !readingIssue && finite(pub.observedCash)', 'const now = finite(pub.observedCash)',
  sources => activeOf(advise(engine(sources), world('misaligned'))).stackSummary.billsAccount.now.amount === null);
mutant('the lists published with a withheld close', 'public/forecast.js', "const ready = pub.status === 'ready' && Array.isArray(pubItems);",
  'const ready = Array.isArray(pubItems);',
  sources => activeOf(advise(engine(sources), world('stale'))).stackSummary.billsAccount.comingOut === null);
{
  const src = read('public/stack-cards.js');
  const from = "accountRow(r, r.status === 'late' ? 'late' : null, false)";
  assert.ok(src.includes(from));
  ok(!/· late/.test(text(cardOf(view, loadCards(src.replace(from, 'accountRow(r, null, false)'))))), 'mutant caught: the page drops the late word');
}

console.log(`\n${checks} checks passed`);
