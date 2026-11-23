'use strict';
// Missing current-period paycheque (audit finding 5b; Dale set N = 2 business days; Grok Bot's rule).
// A scheduled income of the CURRENT pay period with no posted deposit reads "To confirm" once N
// business days (Monday to Friday, the household's America/Vancouver dates) have passed since its date:
// its amount stays the planned figure, tagged estimated (never calculated or received), and it goes
// back to calculated when the posted deposit is seen. A pending credit near it only adds the hint "Possible pending deposit"; the row still reads To confirm and estimated.
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
function world(asOf, anchor, { post, pending, amount = 2600, extraIncome } = {}) {
  const data = fx.canonical();
  const payload = fx.payload();
  data.plan.income.find(row => row.id === 'payroll').anchor = anchor;
  data.plan.income.find(row => row.id === 'partner').confidence = 'confirmed';
  if (extraIncome) data.plan.income.push(extraIncome);
  payload.transactions = payload.transactions.filter(row => row.id !== 92001); // the fixture's own Aug 14 pay
  payload.fetchedAt = asOf + 'T18:00:00.000Z';
  payload.transactionWindow.endDate = asOf;
  for (const account of payload.accounts) { account.updated_at = asOf + 'T17:55:00.000Z'; account.balance_last_update = asOf + 'T17:55:00.000Z'; }
  if (post) {
    payload.transactions.push({ id: 95001, account_id: 1001, date: post, amount: -amount, currency: 'cad', payee: 'Synthetic payroll',
      category_id: 15, is_pending: pending === true, status: pending ? 'pending' : 'cleared' });
    if (!pending) payload.accounts.find(account => account.id === 1001).balance += 2600;
  }
  const served = Live.fromObservation({ data, payload, accountMap: fx.map, identity: fx.identity }).data;
  const advice = F.recommend(served.plan, asOf, { ...served.plan.defaults, debts: served.debts || [],
    currentPeriodActuals: served.liveOverlay && served.liveOverlay.currentPeriodActuals,
    representedEvents: served.liveOverlay && served.liveOverlay.representedEvents });
  const period = advice.payPeriodViews.find(view => view.timelineRole === 'current');
  return { period, pay: (period.income || []).find(row => row.id === 'payroll'), served, row: id => (period.income || []).find(r => r.id === id) };
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
  // A pending credit is only a HINT (Grok Bot's ruling): "Possible pending deposit". The row still reads To confirm,
  // estimated, whatever the hint says; a hint alone never settles or clears anything.
  const pend = world('2026-08-20', '2026-08-18', { post: '2026-08-19', pending: true });
  ok(pend.pay.depositStatus === 'to-confirm' && pend.pay.pendingDepositHint === true && pend.period.incomeTrust === 'estimated',
    'a pending credit near a paycheque two business days late is a hint; the row still reads To confirm and estimated',
    JSON.stringify([pend.pay.depositStatus, pend.pay.pendingDepositHint, pend.period.incomeTrust]));
  // On the scheduled day itself (Tue Aug 18, observed Aug 18) a pending credit already gives the hint; nothing is held yet.
  const sameDay = world('2026-08-18', '2026-08-18', { post: '2026-08-18', pending: true });
  ok(sameDay.pay.pendingDepositHint === true && !sameDay.pay.depositStatus, 'a pending deposit on its scheduled day gives the hint and no hold', JSON.stringify([sameDay.pay.pendingDepositHint, sameDay.pay.depositStatus]));
  const sameDayNone = world('2026-08-18', '2026-08-18');
  ok(!sameDayNone.pay.depositStatus && !sameDayNone.pay.pendingDepositHint, 'the scheduled day itself, nothing posted yet: not held, no hint');
  // An unrelated nearby credit gives no hint: a pending 40.00 near the payday does not reach half of the planned 2,600.
  const small = world('2026-08-20', '2026-08-18', { post: '2026-08-19', pending: true, amount: 40 });
  ok(!small.pay.pendingDepositHint && small.pay.depositStatus === 'to-confirm', 'a small unrelated pending credit gives no hint; the row still reads To confirm', JSON.stringify([small.pay.pendingDepositHint, small.pay.depositStatus]));
  // One pending credit sits next to at most ONE expected income. Payroll Tue Aug 18 and a second confirmed income on
  // Wed Aug 19 (the engine does not rely on that later one yet, so it carries no deposit state itself). The credit is
  // assigned to the NEAREST income only; it never also hints the other.
  const second = { id: 'benefit', label: 'Invented benefit', frequency: 'biweekly', anchor: '2026-08-19', amount: 2600, confidence: 'confirmed' };
  const hinted = w => (w.period.income || []).filter(r => r.pendingDepositHint).map(r => r.id);
  const nearLater = world('2026-08-20', '2026-08-18', { post: '2026-08-19', pending: true, extraIncome: second });
  ok(hinted(nearLater).length === 0 && nearLater.row('payroll').depositStatus === 'to-confirm',
    'a credit nearer the second income than the paycheque does not hint the paycheque; it still reads To confirm', JSON.stringify(hinted(nearLater)));
  const nearEarlier = world('2026-08-20', '2026-08-18', { post: '2026-08-18', pending: true, extraIncome: second });
  ok(JSON.stringify(hinted(nearEarlier)) === '["payroll"]', 'a credit nearer the paycheque hints the paycheque, and only it', JSON.stringify(hinted(nearEarlier)));
  const tied = world('2026-08-20', '2026-08-18', { post: '2026-08-19', pending: true, extraIncome: { ...second, anchor: '2026-08-20' } });
  ok(hinted(tied).length === 0, 'a credit equidistant from two incomes hints neither', JSON.stringify(hinted(tied)));
  // The hint never changes the hinted row itself. The fixture's pending credit is dated BEFORE the spending cycle (Mon Aug 17, the
  // cycle starts Tue Aug 18), so it hints the Aug 18 paycheque without also becoming an estimated Other-income row, and the partner
  // pay is confirmed: the paycheque row is the ONLY thing in the period that can make the income an estimate.
  const alone = world('2026-08-20', '2026-08-18', { post: '2026-08-17', pending: true });
  const others = (alone.period.income || []).filter(r => r.id !== 'payroll');
  ok(others.length > 0 && others.every(r => r.confidence === 'confirmed' && !r.depositStatus && r.status !== 'estimated' && r.settlement !== 'estimated'),
    'fixture: no other income row is an estimate or to confirm, so the paycheque row alone decides the period tag', JSON.stringify(others.map(r => [r.id, r.confidence, r.status])));
  ok(alone.pay.pendingDepositHint === true && alone.pay.depositStatus === 'to-confirm' && alone.pay.status !== 'pending' && alone.pay.status !== 'received'
    && alone.pay.businessDaysLate === 2 && alone.pay.actual == null && alone.pay.amount === 2600,
    'the hinted paycheque row itself: hint true, still to-confirm with its planned 2,600, never pending or received', JSON.stringify([alone.pay.pendingDepositHint, alone.pay.depositStatus, alone.pay.status]));
  ok(alone.period.incomeTrust === 'estimated',
    'with the hint present and nothing else estimated, the period income still reads estimated (the row decides it)', String(alone.period.incomeTrust));
  const noHint = world('2026-08-20', '2026-08-18');
  ok(!noHint.pay.pendingDepositHint && noHint.pay.depositStatus === 'to-confirm' && noHint.period.incomeTrust === alone.period.incomeTrust,
    'the same paycheque with no pending credit reads the same: the hint changes neither the status nor the tag');
}

console.log('\n=== Other income is outside the rule ===');
{
  // An expected one-off gift (Other income) scheduled Aug 18 with an exact posted receipt, observed Aug 20: it is
  // received, never to confirm (its receipt reconciliation runs after the row is built).
  const data = fx.canonical();
  const payload = fx.payload();
  data.plan.income.push({ id: 'other-income:gift', label: 'Invented gift', frequency: 'once', date: '2026-08-18', amount: 500, confidence: 'confirmed', incomeClass: 'other' });
  payload.transactions.push({ id: 95002, account_id: 1001, date: '2026-08-18', amount: -500, currency: 'cad', payee: 'Invented gift',
    category_id: 15, is_pending: false, status: 'cleared' });
  payload.accounts.find(account => account.id === 1001).balance += 500;
  const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [...fx.identity.rules,
    { eventId: 'other-income:gift', payeePattern: 'Invented gift', atlasAccountId: 'chequing-a', direction: 'credit' }] };
  const served = Live.fromObservation({ data, payload, accountMap: fx.map, identity }).data;
  const advice = F.recommend(served.plan, '2026-08-20', { ...served.plan.defaults, debts: served.debts || [],
    currentPeriodActuals: served.liveOverlay && served.liveOverlay.currentPeriodActuals, representedEvents: served.liveOverlay && served.liveOverlay.representedEvents });
  const rows = JSON.stringify(advice.payPeriodViews.find(view => view.timelineRole === 'current'));
  ok(!/"depositStatus"/.test(rows), 'no Other income row carries a deposit status, received or not');

  // The reviewer's non-blocking case: an Other-income row that was NEVER received (scheduled Aug 18, no receipt,
  // observed Aug 20, two business days on) is still outside the rule: no To confirm and no hint. Without the Other
  // guard in missingDepositState this row would read To confirm, so deleting the guard fails this check.
  const data2 = fx.canonical();
  const payload2 = fx.payload();
  data2.plan.income.push({ id: 'other-income:gift', label: 'Invented gift', frequency: 'once', date: '2026-08-18', amount: 500, confidence: 'confirmed', incomeClass: 'other' });
  payload2.fetchedAt = '2026-08-20T18:00:00.000Z';
  payload2.transactionWindow.endDate = '2026-08-20';
  const served2 = Live.fromObservation({ data: data2, payload: payload2, accountMap: fx.map, identity: fx.identity }).data;
  const advice2 = F.recommend(served2.plan, '2026-08-20', { ...served2.plan.defaults, debts: served2.debts || [],
    currentPeriodActuals: served2.liveOverlay && served2.liveOverlay.currentPeriodActuals, representedEvents: served2.liveOverlay && served2.liveOverlay.representedEvents });
  const period2 = advice2.payPeriodViews.find(view => view.timelineRole === 'current');
  const gift = (period2.income || []).find(row => row.id === 'other-income:gift');
  ok(!!gift && !gift.depositStatus && !gift.pendingDepositHint && gift.status !== 'received',
    'an unreceived Other-income row is outside the rule: no deposit status, no hint', JSON.stringify(gift && [gift.status, gift.depositStatus, gift.pendingDepositHint]));
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
  ok(/data-income-status="to-confirm"/.test(held) && /to confirm/i.test(text(held)) && !/≈|estimated/i.test(text(held)) && /2,600\.00/.test(text(held)),
    'the Income sheet prints the payroll as to confirm, estimated, with its planned 2,600.00', (text(held).match(/Dale salary[^]{0,120}/) || [''])[0]);
  ok(!/to confirm/i.test(text(html(world('2026-08-17', '2026-08-14').period))), 'day 1: nothing about to confirm');
  const hinted = text(html(world('2026-08-20', '2026-08-18', { post: '2026-08-19', pending: true }).period));
  ok(/Possible pending deposit/.test(hinted) && /data-income-status="to-confirm"/.test(html(world('2026-08-20', '2026-08-18', { post: '2026-08-19', pending: true }).period)),
    'a pending hint prints exactly "Possible pending deposit" beside a row that still reads to confirm');
  ok(/Possible pending deposit/.test(text(html(world('2026-08-18', '2026-08-18', { post: '2026-08-18', pending: true }).period))) && !/to confirm/i.test((text(html(world('2026-08-18', '2026-08-18', { post: '2026-08-18', pending: true }).period)).match(/Dale salary[^+]*\+/) || [''])[0]),
    'on the scheduled day the hint prints beside the paycheque row, which does not read to confirm');
  // The hinted paycheque row, printed: its own status, its own estimate mark and its own amount, with the hint beside it. Nothing
  // else on the sheet is an estimate here (the pending credit is dated before the cycle), so the mark can only come from this row.
  const rowHtml = (period, id) => (html(period).match(new RegExp('<div class="operating-line" data-period-income="' + id + '"[^>]*>[\\s\\S]*?</div>')) || [''])[0];
  const hintedRow = rowHtml(world('2026-08-20', '2026-08-18', { post: '2026-08-17', pending: true }).period, 'payroll');
  const sheetHtml = html(world('2026-08-20', '2026-08-18', { post: '2026-08-17', pending: true }).period);
  ok(/data-income-status="to-confirm"/.test(hintedRow) && !/data-income-status="pending"/.test(sheetHtml),
    'the hinted paycheque row prints its own status as to confirm, never pending', hintedRow.slice(0, 160));
  ok(/data-income-pending-hint>Possible pending deposit</.test(hintedRow), 'and the hint "Possible pending deposit" beside it');
  ok(!/≈|estimated/i.test(text(hintedRow)) && /2,600\.00/.test(text(hintedRow)),
    'the hinted row itself prints its plain planned 2,600.00', text(hintedRow));
  // The payday balance printed beside it carries the estimate derived from this same row (the rule: the figures built on a held
  // paycheque read estimated too), so it is the one other mark, and it names itself (data-payday-balance-trust).
  const otherRows = sheetHtml.replace(hintedRow, '').replace(/<span class="est" data-payday-balance-trust>[^<]*<\/span>/g, '');
  ok(!/class="est"/.test(otherRows) && !/data-income-status="estimated"/.test(otherRows),
    'no other row on the sheet is an estimate, so the mark is this row\'s own', text(otherRows).slice(0, 200));

}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
