'use strict';
/* Q2, owner decision (Dale, 2026-11-18, #821 6967081727): Amanda's pay counts
 * when it reaches Bills. A posted CAD credit into Bills (chequing-a) settles
 * amandaSalary15 or amandaSalaryMonthEnd once, at its actual amount, when it is
 * within $5 of THAT occurrence's scheduled amount and posts within 3 business
 * days (Monday to Friday, no holiday calendar) before or after the projected
 * payday. Two qualifying credits for one occurrence, or one credit qualifying
 * for two occurrences, settle nothing (To confirm); nothing qualifying is not
 * received. Pending rows, refunds, reversals, reimbursements, internal household
 * transfers and credits another rule identifies never qualify. The received
 * amount is the posted credit; the period's income stays calculated, never
 * verified.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> served data -> Forecast.recommend, with the repository's own
 * rules for the two streams (docs/connectivity/transaction-identity.json).
 *
 * Invented world: Dale 1400 biweekly from Fri 2026-10-09 (pay periods Oct 9-22,
 * Oct 23-Nov 5, Nov 6-19). Amanda: 2000 on the 15th, 2200 at month-end (the two
 * amounts differ and alternate). Hand-derived calendar: Oct 15 is a Thursday, so
 * 3 business days either side is Mon Oct 12 to Tue Oct 20; Fri Oct 9 and Wed Oct 21
 * are 4 away. Oct 31 is a Saturday: Wed Nov 4 is 3 business days after, Thu Nov 5 is 4.
 * Nov 15 is a Sunday: Tue Nov 17, after a long weekend, is 2 business days after.
 *
 * `node test/test-amanda-pay-near-amount.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');
const { isDeepStrictEqual } = require('node:util');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

// The repository's own two rules, so the test proves the shipped configuration.
const IDENTITY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'connectivity', 'transaction-identity.json'), 'utf8'));
const RULES = IDENTITY.rules.filter(rule => ['amandaSalary15', 'amandaSalaryMonthEnd'].includes(rule.eventId));
ok(RULES.length === 2 && RULES.every(rule => rule.settlesWhen === 'near-scheduled-amount-and-payday'
  && rule.amountToleranceDollars === 5 && rule.postingBusinessDays === 3 && rule.atlasAccountId === 'chequing-a'
  && rule.direction === 'credit'), 'the shipped rules are the owner\'s: $5, 3 business days, credits into Bills');

const TENNIS = 9010;
let nextId = 800000;
const bills = (date, amount, extra = {}) => H.lm({ id: ++nextId, date, amount: -amount, category: 'Transfer',
  account: 'chequing-a', payee: extra.payee || 'Invented transfer', pending: extra.pending, raw: extra.raw });

function serve({ asOf = '2026-10-22', txs = [], monthEndDay = 31, monthEndAmount = 2200 }) {
  const w = H.baseWorld(asOf);
  w.windowStart = '2026-08-02';
  w.accounts.push({ id: 'tennis', providerId: TENNIS, role: 'household-external', collection: 'cash',
    label: 'Invented tennis income', value: 0, held: true, externalId: 'tennis-income' });
  w.income.push(
    { id: 'amandaSalary15', label: 'Invented salary (15th)', frequency: 'monthly', day: 15, firstDue: '2026-08-15', amount: 2000, confidence: 'confirmed' },
    { id: 'amandaSalaryMonthEnd', label: 'Invented salary (month-end)', frequency: 'monthly', day: monthEndDay, amount: monthEndAmount, confidence: 'confirmed' });
  w.identityRules = w.identityRules.concat(JSON.parse(JSON.stringify(RULES)));
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
const settledOct15 = (s, amount) => JSON.stringify(s.settled) === JSON.stringify([`15@2026-10-15:${amount}`]);
const notReceived = s => s.settled.length === 0 && s.income === 3400 && !(s.rowOf('amandaSalary15', '2026-10-15') || {}).alreadyInCash;

console.log('1. In the window: within $5 and 3 business days settles the occurrence once, at its actual amount');
for (const [date, amount, why] of [
  ['2026-10-15', 2000, 'on the payday, exact'],
  ['2026-10-15', 1995, 'exactly $5 under'],
  ['2026-10-15', 2005, 'exactly $5 over'],
  ['2026-10-12', 2000, 'Mon Oct 12, 3 business days before'],
  ['2026-10-20', 1997.5, 'Tue Oct 20, 3 business days after, $2.50 short'],
]) {
  const s = serve({ txs: [bills(date, amount)] });
  ok(s.live && settledOct15(s, amount), `${why}: Oct 15 settles at ${amount}`, JSON.stringify(s.settled));
  ok(s.income === 1400 + amount, `${why}: this period's income is 1400 + ${amount} = ${1400 + amount}, once`, String(s.income));
  ok(s.rowOf('amandaSalary15', '2026-10-15').status === 'received' && s.rowOf('amandaSalary15', '2026-10-15').alreadyInCash === true,
    `${why}: the row reads received and already in cash`);
  ok(s.incomeTrust === 'calculated', `${why}: the period's income is calculated, never verified or confirmed`, s.incomeTrust);
}

console.log('2. Outside the window or the tolerance: not received');
for (const [date, amount, why] of [
  ['2026-10-15', 1994.99, '$5.01 under'],
  ['2026-10-15', 2005.01, '$5.01 over'],
  ['2026-10-09', 2000, 'Fri Oct 9, 4 business days before'],
  ['2026-10-21', 2000, 'Wed Oct 21, 4 business days after'],
  ['2026-10-15', 2200, 'the month-end amount on the 15th'],
]) {
  const s = serve({ txs: [bills(date, amount)] });
  ok(s.live && notReceived(s), `${why}: Oct 15 is not received (income stays 3400 at the scheduled 2000)`,
    JSON.stringify([s.settled, s.income]));
}

console.log('3. Weekend and holiday paydays (no holiday calendar: a holiday counts as a business day)');
{
  const end = serve({ asOf: '2026-11-05', txs: [bills('2026-11-04', 2200)] });
  ok(JSON.stringify(end.settled) === JSON.stringify(['MonthEnd@2026-10-31:2200']),
    'Sat Oct 31 month-end: a Wed Nov 4 credit (3 business days after) settles it', JSON.stringify(end.settled));
  const late = serve({ asOf: '2026-11-06', txs: [bills('2026-11-05', 2200)] });
  ok(late.settled.length === 0, 'Sat Oct 31 month-end: a Thu Nov 5 credit (4 business days after) does not', JSON.stringify(late.settled));
  const longWeekend = serve({ asOf: '2026-11-18', txs: [bills('2026-11-17', 2000)] });
  ok(JSON.stringify(longWeekend.settled) === JSON.stringify(['15@2026-11-15:2000']),
    'Sun Nov 15 then a Monday holiday: a Tue Nov 17 credit (2 business days) settles Nov 15', JSON.stringify(longWeekend.settled));
  const before = serve({ asOf: '2026-11-18', txs: [bills('2026-11-13', 2000)] });
  ok(JSON.stringify(before.settled) === JSON.stringify(['15@2026-11-15:2000']),
    'Sun Nov 15: a Fri Nov 13 credit (paid before the weekend) settles Nov 15', JSON.stringify(before.settled));
}

console.log('4. Fail closed');
{
  const two = serve({ txs: [bills('2026-10-15', 2000), bills('2026-10-16', 2001)] });
  ok(notReceived(two), 'two qualifying credits for Oct 15: neither settles (To confirm)', JSON.stringify(two.settled));
  // public/plan.js prints an unresolved, not-relied-upon income row as "To confirm $X".
  const toConfirm = row => !!row && row.status === 'unresolved' && row.notReliedUpon === true;
  ok(toConfirm(two.rowOf('amandaSalary15', '2026-10-15')), 'and Oct 15 reads unresolved, not relied upon: the page prints To confirm');
  // An invented schedule where the two streams' windows overlap: month-end moved to the 19th at the same 2000.
  const both = serve({ txs: [bills('2026-10-16', 2000)], monthEndDay: 19, monthEndAmount: 2000 });
  ok(both.settled.length === 0, 'one credit fitting both Oct 15 and Oct 19: neither settles (To confirm)', JSON.stringify(both.settled));
  ok(toConfirm(both.rowOf('amandaSalary15', '2026-10-15')) && toConfirm(both.rowOf('amandaSalaryMonthEnd', '2026-10-19')),
    'and both occurrences read To confirm');
  // Codex P2 on #1294 (r4608629127): Oct 15 also has a second candidate (Oct 12, 2001). The Oct 16 credit still
  // fits both paydays, so Oct 19 must not settle from it.
  const shared = serve({ txs: [bills('2026-10-16', 2000), bills('2026-10-12', 2001)], monthEndDay: 19, monthEndAmount: 2000 });
  ok(shared.settled.length === 0 && toConfirm(shared.rowOf('amandaSalaryMonthEnd', '2026-10-19')),
    'a shared credit leaves both paydays To confirm even when one also has a second candidate', JSON.stringify(shared.settled));
  const pending = serve({ txs: [bills('2026-10-15', 2000, { pending: true })] });
  ok(pending.settled.length === 0, 'a pending credit never qualifies');
  for (const payee of ['Invented REFUND', 'INVENTED REVERSAL', 'Invented reimbursement']) {
    ok(serve({ txs: [bills('2026-10-15', 2000, { payee })] }).settled.length === 0, `a "${payee}" credit never qualifies`);
  }
  const internal = serve({ txs: [bills('2026-10-15', 2000),
    H.lm({ id: ++nextId, date: '2026-10-15', amount: 2000, category: 'Transfer', account: 'chequing-b', payee: 'Invented transfer' })] });
  ok(internal.settled.length === 0, 'a move from another household account (same day, same amount) is not her pay');
  const payroll = serve({ txs: [H.lm({ id: ++nextId, date: '2026-10-15', amount: -2000, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' })] });
  ok(payroll.settled.length === 0, 'a credit another rule identifies (Dale\'s employer) is never her pay');
  const weekly = serve({ txs: [H.lm({ id: ++nextId, date: '2026-10-15', amount: -2000, category: 'Transfer', account: 'chequing-b',
    payee: 'Invented transfer' })] });
  ok(weekly.settled.length === 0, 'a credit into another account than Bills does not qualify');
}

console.log('5. The TENNIS INCOME source deposit and its transfer are one receipt');
{
  const source = [
    H.lm({ id: ++nextId, date: '2026-10-15', amount: -2000, category: 'Payroll', account: 'tennis', providerAccountId: TENNIS,
      payee: 'Invented Tennis PAY' }),
    H.lm({ id: ++nextId, date: '2026-10-16', amount: 2000, category: 'Transfer', account: 'tennis', providerAccountId: TENNIS,
      payee: 'Invented transfer' }),
    bills('2026-10-16', 2000),
  ];
  const s = serve({ txs: source });
  ok(settledOct15(s, 2000) && s.income === 3400 && s.otherIncome === 0,
    'source deposit + transfer + Bills credit: Oct 15 settles once at 2000; income 3400; no Other Income',
    JSON.stringify([s.settled, s.income, s.otherIncome]));
}

console.log('6. Zero second cash and replay');
{
  const s = serve({ txs: [bills('2026-10-19', 1998)] });
  ok(settledOct15(s, 1998) && JSON.stringify(s.future) === JSON.stringify(['2026-10-31:2200', '2026-11-15:2000', '2026-11-30:2200', '2026-12-15:2000', '2026-12-31:2200']),
    'a credit settling Oct 15 is never also a later payday: each remaining payday is once, at its scheduled amount', JSON.stringify(s.future));
  const again = serve({ txs: [bills('2026-10-19', 1998)] });
  ok(isDeepStrictEqual(s.served.liveOverlay.currentPeriodActuals.representedActuals, again.served.liveOverlay.currentPeriodActuals.representedActuals)
    && s.income === again.income, 'the same observation twice gives the same result');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Amanda pay near-amount checks passed.');
