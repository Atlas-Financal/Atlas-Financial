'use strict';
// Missing current-period paycheque (audit finding 5b; Dale set N = 2 business days; Grok Bot's rule).
// A scheduled income of the CURRENT pay period with no posted deposit reads "To confirm" once N
// business days (Monday to Friday, the household's America/Vancouver dates) have passed since its date:
// its amount stays the planned figure, tagged estimated (never calculated or received), and it goes
// back to calculated when the posted deposit is seen. A pending deposit shows as pending instead.
// The repository has no BC holiday calendar, so a statutory holiday counts as a business day.
// Invented data only: the Budget surface household with the payroll anchor and the observation day
// moved; every expectation is a hand-counted date (Fri Aug 14, Mon Aug 17, Tue Aug 18, ...).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/budget-surface-data');
const Live = require('../scripts/live-plan');

let failures = 0;
function ok(cond, msg, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}${!cond && detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}

// The payroll (2,600, confirmed, biweekly from `anchor`) is the only income; the partner pay is made
// confirmed so nothing else can make the income an estimate. `post`: one deposit of the payroll on that
// date; `pending`: that deposit is not yet posted.
function world(asOf, anchor, { post, pending } = {}) {
  const data = fx.canonical();
  const payload = fx.payload();
  data.plan.income.find(row => row.id === 'payroll').anchor = anchor;
  data.plan.income.find(row => row.id === 'partner').confidence = 'confirmed';
  payload.transactions = payload.transactions.filter(row => row.id !== 92001); // the fixture's own Aug 14 pay
  payload.fetchedAt = asOf + 'T18:00:00.000Z';
  payload.transactionWindow.endDate = asOf;
  for (const account of payload.accounts) { account.updated_at = asOf + 'T17:55:00.000Z'; account.balance_last_update = asOf + 'T17:55:00.000Z'; }
  if (post) {
    payload.transactions.push({ id: 95001, account_id: 1001, date: post, amount: -2600, currency: 'cad', payee: 'Synthetic payroll',
      category_id: 15, is_pending: pending === true, status: pending ? 'pending' : 'cleared' });
    if (!pending) payload.accounts.find(account => account.id === 1001).balance += 2600;
  }
  const served = Live.fromObservation({ data, payload, accountMap: fx.map, identity: fx.identity }).data;
  const advice = F.recommend(served.plan, asOf, { ...served.plan.defaults, debts: served.debts || [],
    currentPeriodActuals: served.liveOverlay && served.liveOverlay.currentPeriodActuals,
    representedEvents: served.liveOverlay && served.liveOverlay.representedEvents });
  const period = advice.payPeriodViews.find(view => view.timelineRole === 'current');
  return { period, pay: (period.income || []).find(row => row.id === 'payroll'), served };
}

console.log('\n=== two business days with no posted deposit: To confirm, estimated ===');
{
  // Payday Fri Aug 14, nothing posted. Mon Aug 17 is business day 1 (the weekend does not count).
  const day1 = world('2026-08-17', '2026-08-14');
  ok(day1.pay && day1.pay.date === '2026-08-14' && !day1.pay.depositStatus && day1.period.incomeTrust === 'calculated',
    'Mon Aug 17 (business day 1 after Fri Aug 14): not held, income still calculated', JSON.stringify([day1.pay && day1.pay.depositStatus, day1.period.incomeTrust]));
  const day2 = world('2026-08-18', '2026-08-14');
  ok(day2.pay.depositStatus === 'to-confirm' && day2.pay.businessDaysLate === 2 && day2.period.incomeTrust === 'estimated',
    'Tue Aug 18 (business day 2): To confirm, and the period income reads estimated', JSON.stringify([day2.pay.depositStatus, day2.pay.businessDaysLate, day2.period.incomeTrust]));
  ok(day2.pay.amount === 2600 && day2.pay.planned === 2600 && day2.pay.actual == null && day2.pay.status !== 'received',
    'its amount is the planned 2,600, never received');
  ok(Math.round(day2.period.incomeTotal * 100) === Math.round(day1.period.incomeTotal * 100),
    'the planned amount is counted as before (only its tag changes)', String(day1.period.incomeTotal) + ' vs ' + String(day2.period.incomeTotal));
  ok(['estimated', 'unavailable'].includes(day2.period.afterBillsTrust) || day2.period.afterBillsTrust === 'estimated',
    'the figures built on it read estimated too', String(day2.period.afterBillsTrust));
  // Midweek: payday Tue Aug 18, Wed Aug 19 is day 1, Thu Aug 20 is day 2.
  ok(!world('2026-08-19', '2026-08-18').pay.depositStatus, 'Wed Aug 19 (day 1 after Tue Aug 18): not held');
  ok(world('2026-08-20', '2026-08-18').pay.depositStatus === 'to-confirm', 'Thu Aug 20 (day 2 after Tue Aug 18): To confirm');
}

console.log('\n=== the posted deposit flips it back; a pending deposit shows pending ===');
{
  const posted = world('2026-08-20', '2026-08-18', { post: '2026-08-18' });
  ok(!posted.pay.depositStatus && posted.pay.status !== 'arriving' && posted.period.incomeTrust === 'calculated',
    'a posted deposit on Aug 18: no hold, income calculated again', JSON.stringify([posted.pay.depositStatus, posted.pay.status, posted.period.incomeTrust]));
  const pend = world('2026-08-20', '2026-08-18', { post: '2026-08-19', pending: true });
  ok(pend.pay.depositStatus === 'pending', 'a pending deposit shows as pending, not To confirm', String(pend.pay.depositStatus));
  // On the scheduled day itself (Tue Aug 18, observed Aug 18) a pending deposit already shows pending; nothing is held yet.
  const sameDay = world('2026-08-18', '2026-08-18', { post: '2026-08-18', pending: true });
  ok(sameDay.pay.depositStatus === 'pending', 'a pending deposit on its scheduled day shows pending', String(sameDay.pay.depositStatus));
  const sameDayNone = world('2026-08-18', '2026-08-18');
  ok(!sameDayNone.pay.depositStatus, 'the scheduled day itself, nothing posted yet: not held');
}

console.log('\n=== Other income is outside the rule ===');
{
  // An expected one-off gift (Other income) scheduled Aug 18 with an exact posted receipt, observed Aug 20: it is
  // received, never to confirm (its receipt reconciliation runs after the row is built).
  const data = fx.canonical();
  const payload = fx.payload();
  data.plan.income.push({ id: 'gift', label: 'Invented gift', frequency: 'once', date: '2026-08-18', amount: 500, confidence: 'confirmed', incomeClass: 'other' });
  payload.transactions.push({ id: 95002, account_id: 1001, date: '2026-08-18', amount: -500, currency: 'cad', payee: 'Invented gift',
    category_id: 15, is_pending: false, status: 'cleared' });
  payload.accounts.find(account => account.id === 1001).balance += 500;
  const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [...fx.identity.rules,
    { eventId: 'gift', payeePattern: 'Invented gift', atlasAccountId: 'chequing-a', direction: 'credit' }] };
  const served = Live.fromObservation({ data, payload, accountMap: fx.map, identity }).data;
  const advice = F.recommend(served.plan, '2026-08-20', { ...served.plan.defaults, debts: served.debts || [],
    currentPeriodActuals: served.liveOverlay && served.liveOverlay.currentPeriodActuals, representedEvents: served.liveOverlay && served.liveOverlay.representedEvents });
  const rows = JSON.stringify(advice.payPeriodViews.find(view => view.timelineRole === 'current'));
  ok(!/"depositStatus"/.test(rows), 'no Other income row carries a deposit status, received or not');
}

console.log('\n=== the page says so ===');
{
  const scripts = ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan'];
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
  for (const name of scripts) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8'), context);
    if (name === 'app') vm.runInContext('App.boot=()=>{};', context);
  }
  const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const html = period => { context.period = period; return vm.runInContext('calendarIncomeHtml(period)', context); };
  const held = html(world('2026-08-18', '2026-08-14').period);
  ok(/data-income-status="to-confirm"/.test(held) && /to confirm/i.test(text(held)) && /≈ estimated/.test(text(held)) && /2,600\.00/.test(text(held)),
    'the Income sheet prints the payroll as to confirm, estimated, with its planned 2,600.00', (text(held).match(/Dale salary[^]{0,120}/) || [''])[0]);
  ok(!/to confirm/i.test(text(html(world('2026-08-17', '2026-08-14').period))), 'day 1: nothing about to confirm');
  ok(/data-income-status="pending"/.test(html(world('2026-08-20', '2026-08-18', { post: '2026-08-19', pending: true }).period)), 'a pending deposit prints pending');
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
