'use strict';
/* U6 (lead dispatch 2026-11-18, boundary (ii); BACKLOG "A plain early income credit is projected again on
 * its payday"). A posted credit into Bills that could be Amanda's pay (it passes every exclusion of the owner's
 * near-amount rule, #821 6967081727) but posts before that rule's window settles nothing, so the cash walk counts
 * it as Other Income while the payday is still projected: her pay twice. It now holds the next occurrence (To
 * confirm, plan withheld, posted-income-occurrence-unresolved) when, after the previous occurrence, it is within
 * $5 of that next occurrence's scheduled amount on any date, or within 3 business days before that payday at no
 * less than half the scheduled amount. A credit the near-amount rule placed under any occurrence is never held.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance harness) -> served data ->
 * Forecast.recommend, with the repository's own two salary rules.
 *
 * Invented world (as in test-amanda-pay-near-amount): Dale 1400 biweekly from Fri Oct 9; Amanda 2000 on the 15th
 * and 2200 at month-end. Hand-derived calendar: Oct 31 is a Saturday, so Tue Oct 27 is 3 business days before it
 * (Oct 28, 29, 30) and Mon Oct 26 is 4; Wed Oct 28 is 2. Oct 15 is a Thursday, so Thu Oct 8 is 5 business days
 * before it (Oct 9, 12, 13, 14, 15). Half of 2200 is 1100.
 *
 * `node test/test-amanda-pay-early-plain-credit.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const IDENTITY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'connectivity', 'transaction-identity.json'), 'utf8'));
const RULES = IDENTITY.rules.filter(rule => ['amandaSalary15', 'amandaSalaryMonthEnd'].includes(rule.eventId));
ok(RULES.length === 2 && RULES.every(rule => rule.settlesWhen === 'near-scheduled-amount-and-payday'
  && rule.amountToleranceDollars === 5 && rule.postingBusinessDays === 3), 'the shipped rules are the owner\'s: $5, 3 business days');

const TENNIS = 9010;
let nextId = 800000;
// A deposit into Bills: by default a direct deposit in the invented salary category (Payroll), not a transfer.
const bills = (date, amount, extra = {}) => H.lm({ id: ++nextId, date, amount: -amount, category: extra.category || 'Payroll',
  account: 'chequing-a', payee: extra.payee || 'Invented deposit', pending: extra.pending, raw: extra.raw,
  notes: extra.notes, tagIds: extra.tagIds });

function serve({ asOf = '2026-10-22', txs = [], monthEndDay = 31, monthEndAmount = 2200, categories = [], tags = [] }) {
  const w = H.baseWorld(asOf);
  w.categories = w.categories.concat(categories);
  w.tags = tags;
  w.windowStart = '2026-08-02';
  w.accounts.push({ id: 'tennis', providerId: TENNIS, role: 'household-external', collection: 'cash',
    label: 'Invented tennis income', value: 0, held: true, externalId: 'tennis-income' });
  w.income.push(
    { id: 'amandaSalary15', label: 'Invented salary (15th)', frequency: 'monthly', day: 15, firstDue: '2026-08-15', amount: 2000, confidence: 'confirmed' },
    { id: 'amandaSalaryMonthEnd', label: 'Invented salary (month-end)', frequency: 'monthly', day: monthEndDay, amount: monthEndAmount, confidence: 'confirmed' });
  // The shipped rules, with an invented employer alias for the early-receipt hold's salary source.
  w.identityRules = w.identityRules.concat(JSON.parse(JSON.stringify(RULES))
    .map(rule => ({ ...rule, salaryReceiptPayeePatterns: ['Invented Tennis PAY'] })));
  w.transactions = [H.lm({ id: 799999, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' }), ...txs];
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (r.error) throw r.error;
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const current = adv.defaultView.calendarPeriods.find(p => p.start <= asOf && p.end >= asOf);
  const rowOf = (id, date) => adv.defaultView.calendarPeriods.flatMap(p => p.income || [])
    .find(row => row.id === id && row.date === date) || null;
  return {
    live: r.data.liveOverlay.operatingPlan === 'live',
    held: r.data.liveOverlay.operatingPlan === 'unavailable',
    settled: (packet.representedActuals || []).filter(x => /^amandaSalary/.test(x.id))
      .map(x => x.id.replace('amandaSalary', '') + '@' + x.date + ':' + Math.abs(x.actual)).sort(),
    rowOf,
    income: current.incomeTotal,
    incomeTrust: current.incomeTrust,
    otherIncome: current.otherIncome && current.otherIncome.amount,
    future: F.expandEvents(r.data.plan, asOf, '2026-12-31', {}).filter(e => /^amandaSalary/.test(e.id)).map(e => e.date + ':' + e.amount),
    served: r.data,
  };
}
// Oct 15 already received on its day, so only the month-end run-up is in question.
const oct15 = () => bills('2026-10-15', 2000);
const heldOct31 = s => s.held && !s.settled.some(x => x.startsWith('MonthEnd@'));
const issuesOf = s => ((s.served.liveOverlay.incomeUncertainty || {}).issues || []).map(i => i.id + '@' + i.date + ':' + i.reason);

console.log('1. The reproduced case: a plain 2200 Bills credit on Mon Oct 26, as of Wed Oct 28');
{
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), bills('2026-10-26', 2200)] });
  ok(heldOct31(s), 'Oct 31 is held, not projected beside the credit already in cash', JSON.stringify([s.held, s.settled]));
  ok(JSON.stringify(s.settled) === JSON.stringify(['15@2026-10-15:2000']), 'Oct 15 stays received once at 2000', JSON.stringify(s.settled));
}

console.log('2. Boundary (ii): within $5 on any date in the run-up, or 3 business days before at half or more');
for (const [date, amount, held, why] of [
  ['2026-10-16', 2200, true, 'Fri Oct 16, the day after the previous payday, exact'],
  ['2026-10-22', 2195, true, 'Thu Oct 22, exactly $5 under'],
  ['2026-10-23', 2205, true, 'Fri Oct 23, exactly $5 over'],
  ['2026-10-26', 2194.99, false, 'Mon Oct 26, $5.01 under and 4 business days before'],
  ['2026-10-26', 1500, false, 'Mon Oct 26, off-amount and 4 business days before'],
  ['2026-10-27', 1500, true, 'Tue Oct 27, off-amount, 3 business days before'],
  ['2026-10-27', 1100, true, 'Tue Oct 27, exactly half'],
  ['2026-10-27', 1099.99, false, 'Tue Oct 27, a cent under half'],
  ['2026-10-27', 5000, true, 'Tue Oct 27, an oversized credit (fails closed)'],
]) {
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), bills(date, amount)] });
  ok(held ? heldOct31(s) : s.live, `${why}: ${held ? 'held' : 'stays live'}`, JSON.stringify([s.held, s.settled]));
}

console.log('3. The other stream: a plain 2000 credit 5 business days before the 15th holds Oct 15');
{
  const s = serve({ asOf: '2026-10-12', txs: [bills('2026-10-08', 2000)] });
  ok(s.held && s.settled.length === 0, 'Thu Oct 8 holds Oct 15 as of Mon Oct 12', JSON.stringify([s.held, s.settled]));
}

console.log('4. Every exclusion of the owner\'s rule still applies: none of these holds');
for (const [why, tx, extra] of [
  ['a pending credit', () => bills('2026-10-26', 2200, { pending: true }), []],
  ['a refund payee', () => bills('2026-10-26', 2200, { payee: 'Invented REFUND' }), []],
  ['a reimbursement note', () => bills('2026-10-26', 2200, { notes: 'reimbursement' }), []],
  ['a coaching payee', () => bills('2026-10-26', 2200, { payee: 'Invented coaching client' }), []],
  ['a credit into another account', () => H.lm({ id: ++nextId, date: '2026-10-26', amount: -2200, category: 'Payroll',
    account: 'chequing-b', payee: 'Invented deposit' }), []],
  ['an internal move from Weekly the same day', () => bills('2026-10-26', 2200, { category: 'Transfer', payee: 'Invented transfer' }),
    [() => H.lm({ id: ++nextId, date: '2026-10-26', amount: 2200, category: 'Transfer', account: 'chequing-b', payee: 'Invented transfer' })]],
  ['a Bills transfer with no TENNIS INCOME leg', () => bills('2026-10-26', 2200, { category: 'Transfer', payee: 'Invented transfer' }), []],
]) {
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), tx(), ...extra.map(make => make())] });
  ok(s.live, `${why}: stays live`, JSON.stringify([s.held, s.settled, issuesOf(s)]));
}

console.log('5. A credit the near-amount rule placed is never held a second time');
{
  const early = serve({ asOf: '2026-10-28', txs: [oct15(), bills('2026-10-28', 2200)] });
  ok(early.live && JSON.stringify(early.settled) === JSON.stringify(['15@2026-10-15:2000', 'MonthEnd@2026-10-31:2200']),
    'Wed Oct 28 (2 business days before) settles Oct 31 once and stays live', JSON.stringify([early.held, early.settled]));
  // Equal amounts, so a late credit for Oct 15 is also within $5 of Oct 31: the matcher placed it, so it explains itself.
  const late = serve({ asOf: '2026-10-28', monthEndAmount: 2000, txs: [bills('2026-10-19', 2000)] });
  ok(late.live && JSON.stringify(late.settled) === JSON.stringify(['15@2026-10-15:2000']),
    'with equal amounts, a Mon Oct 19 credit settles Oct 15 late and does not hold Oct 31', JSON.stringify([late.held, late.settled]));
}

console.log('6. Once the payday passes, the credit is before the previous occurrence and holds nothing');
{
  const s = serve({ asOf: '2026-11-02', txs: [oct15(), bills('2026-10-26', 2200)] });
  ok(s.live, 'as of Mon Nov 2 the plan is live again', JSON.stringify([s.held, s.settled]));
  const row = s.rowOf('amandaSalaryMonthEnd', '2026-10-31');
  ok(!!row && row.status !== 'received' && row.alreadyInCash !== true, 'Oct 31 is not received (To confirm, not relied on)',
    JSON.stringify(row && { status: row.status, alreadyInCash: row.alreadyInCash }));
}

console.log('7. Replay: the same observation twice gives the same result');
{
  const txs = [oct15(), bills('2026-10-26', 2200)];
  const a = serve({ asOf: '2026-10-28', txs }), b = serve({ asOf: '2026-10-28', txs });
  ok(a.held === b.held && JSON.stringify(a.settled) === JSON.stringify(b.settled) && JSON.stringify(issuesOf(a)) === JSON.stringify(issuesOf(b)),
    'identical held state, settlements and issues');
}

if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll early plain-credit hold checks passed.');
