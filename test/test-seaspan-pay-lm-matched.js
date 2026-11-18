'use strict';
/* Q1 (lead 2026-11-18; owner decision 6957060901, "pay too"): Dale's pay
 * settles from Lunch Money's own recurring match. A payroll rule that names
 * one reviewed Lunch Money recurring item and opts in with settlementFrom
 * 'lunchmoney-matched-occurrences' lets Lunch Money's pairing decide which
 * payday a linked deposit settles: early, on time or late, once, at its actual
 * amount, and never also as the next pay. Atlas pairs nothing itself (rule 17):
 * it orders LM's matched dates and found deposits only when their counts agree.
 * Anything inconsistent leaves the incumbent payee matcher, and #1290's
 * one-business-day stopgap, exactly as today. FOUNDATION: the household
 * payroll rule names no item yet (BACKLOG names the closure step).
 *
 * Path: invented raw Lunch Money payload plus an invented LM recurring report
 * -> scripts/live-plan.js -> served data -> Forecast.recommend.
 *
 * Invented world (test/acceptance/harness.js): pay 1400 every two weeks from
 * Fri 2026-10-09 (then Oct 23, Nov 6); pay periods Oct 9-22 and Oct 23-Nov 5;
 * plan date Wed 2026-10-14 unless stated. Every expected value is hand-derived.
 *
 * `node test/test-seaspan-pay-lm-matched.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');
const { isDeepStrictEqual } = require('node:util');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const ID = '7400009';
const OPT_IN = 'lunchmoney-matched-occurrences';
let nextId = 900000;
// A Seaspan deposit into Bills, linked to the LM item unless said otherwise.
function pay(date, amount = 1400, { linked = true, payee = 'Invented employer' } = {}) {
  const id = ++nextId;
  const row = H.lm({ id, date, amount: -amount, category: 'Payroll', account: 'chequing-a', payee,
    raw: linked ? { recurring_id: Number(ID) } : {} });
  row.txId = id;
  return row;
}
const lmRead = ({ expected, missing = [], found = [], status = 'reviewed' }) => ({
  status: 'read', read: { unexpectedPaginationEvidence: false, requestedWindow: { startDate: '2026-10-01', endDate: '2026-11-30' },
    items: [{ providerId: ID, status, unavailableFields: [],
      criteria: { startDate: '2026-10-09', endDate: null, granularity: 'week', quantity: 2, anchorDate: '2026-10-09',
        amount: '1400.0000', currency: 'CAD', plaidAccountId: '9001', manualAccountId: null },
      matches: { expectedOccurrenceDates: expected, missingTransactionDates: missing,
        foundTransactions: found.map(tx => ({ date: tx.date, transactionId: tx.txId })) } }] } });

function serve({ asOf = '2026-10-14', txs = [], lm, optIn = true, extraRules = [], bills = [], income = [] }) {
  const w = H.baseWorld(asOf);
  w.windowStart = '2026-10-01';
  w.bills = bills;
  w.income = w.income.concat(income);
  w.identityRules = [{ eventId: 'payroll', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit',
    ...(optIn ? { lunchMoneyRecurringIds: [ID], settlementFrom: OPT_IN } : {}) }].concat(extraRules);
  w.transactions = txs;
  H.productionOpening(w);
  const payload = { ...H.rawPayload(w), ...(lm ? { recurringItems: lm } : {}) };
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload,
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (r.error) throw r.error;
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const current = adv.defaultView.calendarPeriods.find(p => p.start <= asOf && p.end >= asOf);
  return {
    live: r.data.liveOverlay.operatingPlan === 'live',
    held: r.data.liveOverlay.operatingPlan === 'unavailable',
    settled: (packet.representedActuals || []).filter(x => x.id === 'payroll').map(x => x.date + ':' + Math.abs(x.actual)).sort(),
    billPaid: (packet.representedActuals || []).filter(x => x.id !== 'payroll').map(x => x.id + '@' + x.date),
    income: current && current.incomeTotal,
    future: F.expandEvents(r.data.plan, asOf, '2026-11-30', {}).filter(e => e.id === 'payroll').map(e => e.date + ':' + e.amount),
    served: r.data,
  };
}
const E = ['2026-10-09', '2026-10-23'];
const FUTURE = ['2026-10-23:1400', '2026-11-06:1400', '2026-11-20:1400'];

console.log('1. Late and short: LM paired a Mon Oct 12 deposit of 1350 to Fri Oct 9');
{
  const d = pay('2026-10-12', 1350);
  const s = serve({ txs: [d], lm: lmRead({ expected: E, missing: ['2026-10-23'], found: [d] }) });
  ok(s.live, 'the plan is live');
  ok(JSON.stringify(s.settled) === JSON.stringify(['2026-10-09:1350']), 'Oct 9 settles once, at its actual 1350', JSON.stringify(s.settled));
  ok(s.income === 1350, 'this period\'s income is the actual 1350: never the scheduled 1400, never 2750', String(s.income));
  ok(JSON.stringify(s.future) === JSON.stringify(FUTURE), 'the next paydays are 1400 once each: the deposit is never the next pay', JSON.stringify(s.future));
  const control = serve({ txs: [pay('2026-10-12', 1350)], optIn: false });
  // Lead dispatch 2026-11-18: one business day late settles at the actual amount without the opt-in too.
  ok(control.live && JSON.stringify(control.settled) === JSON.stringify(['2026-10-09:1350']) && control.income === 1350,
    'control (no opt-in): the late, short deposit settles Oct 9 once at 1350', JSON.stringify([control.live, control.settled, control.income]));
}

console.log('2. Late by two business days: LM paired a Tue Oct 13 deposit to Oct 9');
{
  const d = pay('2026-10-13');
  const s = serve({ txs: [d], lm: lmRead({ expected: E, missing: ['2026-10-23'], found: [d] }) });
  ok(s.live && JSON.stringify(s.settled) === JSON.stringify(['2026-10-09:1400']) && s.income === 1400,
    'Oct 9 settles once at 1400 (the stopgap alone allows one business day only)', JSON.stringify([s.live, s.settled, s.income]));
  const control = serve({ txs: [pay('2026-10-13')], optIn: false });
  ok(control.held, 'control (no opt-in): two business days late holds the plan, as on main');
}

console.log('3. Early: LM paired a Thu Oct 22 deposit to Fri Oct 23');
{
  const a = pay('2026-10-09'), b = pay('2026-10-22');
  const s = serve({ asOf: '2026-10-22', txs: [a, b], lm: lmRead({ expected: E, found: [a, b] }) });
  ok(s.live && JSON.stringify(s.settled) === JSON.stringify(['2026-10-09:1400', '2026-10-23:1400']),
    'Oct 9 and Oct 23 each settle once', JSON.stringify(s.settled));
  ok(JSON.stringify(s.future) === JSON.stringify(['2026-11-06:1400', '2026-11-20:1400']),
    'Oct 23 is not expected again, and Nov 6 is not settled early', JSON.stringify(s.future));
}

console.log('4. Fail closed: anything LM did not pair consistently settles nothing');
{
  const d = pay('2026-10-12');
  const missing = serve({ txs: [d], lm: lmRead({ expected: E, missing: E, found: [] }) });
  ok(missing.held && missing.settled.length === 0, 'LM lists Oct 9 missing: the linked deposit settles nothing and the plan holds');
  const a = pay('2026-10-12'), b = pay('2026-10-13');
  const two = serve({ txs: [a, b], lm: lmRead({ expected: E, missing: ['2026-10-23'], found: [a, b] }) });
  ok(two.held && two.settled.length === 0, 'two found deposits for one matched date: nothing settles, the plan holds');
  const lm = lmRead({ expected: E, found: [d] });
  lm.read.items[0].matches.foundTransactions.push({ date: d.date, transactionId: d.txId });
  const twice = serve({ txs: [d], lm });
  ok(twice.held && twice.settled.length === 0, 'one deposit LM listed for two paydays settles neither (Grok\'s guard)');
  const out = H.lm({ id: ++nextId, date: '2026-10-12', amount: 1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer', raw: { recurring_id: Number(ID) } });
  out.txId = nextId;
  const debit = serve({ txs: [out], lm: lmRead({ expected: E, missing: ['2026-10-23'], found: [out] }) });
  ok(debit.settled.length === 0, 'money out of Bills, even if LM listed it, is never pay');
}

console.log('5. The incumbent matcher and #1290\'s stopgap are the fallback');
{
  for (const [label, lm] of [['no recurring read', undefined], ['an unavailable read', { status: 'unavailable' }],
    ['a read without the item', { status: 'read', read: { unexpectedPaginationEvidence: false, items: [] } }]]) {
    const late = serve({ txs: [pay('2026-10-12')], lm });
    // Lead dispatch 2026-11-18: one business day late at the exact pay now settles the payday once.
    ok(late.live && JSON.stringify(late.settled) === JSON.stringify(['2026-10-09:1400']) && late.income === 1400,
      `with ${label}, a linked Monday deposit of 1400 settles Oct 9 once: live, never 2800`, JSON.stringify([late.live, late.settled, late.income]));
  }
  const suggested = lmRead({ expected: E, missing: ['2026-10-23'], found: [pay('2026-10-12')] });
  suggested.read.items[0].status = 'suggested';
  const sug = serve({ txs: [pay('2026-10-12')], lm: suggested });
  ok(sug.live && sug.income === 1400, 'a suggested (unreviewed) item is not used: the stopgap still applies');
  const onTime = serve({ txs: [pay('2026-10-09', 1400, { linked: false })], optIn: false });
  ok(onTime.live && JSON.stringify(onTime.settled) === JSON.stringify(['2026-10-09:1400']),
    'a rule naming no item (the household rule today): the on-time deposit settles exactly as on main');
}

console.log('6. A bill keeps its exact-amount guard even when LM paired the payment (Codex P2 on #1292)');
{
  const BILL = '7400111';
  const one = H.lm({ id: ++nextId, date: '2026-10-01', amount: 1, account: 'chequing-a', payee: 'Invented transfer',
    raw: { recurring_id: Number(BILL) } });
  const billLm = { status: 'read', read: { unexpectedPaginationEvidence: false, items: [{ providerId: BILL, status: 'reviewed',
    unavailableFields: [], criteria: { startDate: '2026-10-01', endDate: null, granularity: 'month', quantity: 1,
      anchorDate: '2026-10-01', currency: 'CAD', plaidAccountId: '9001', manualAccountId: null },
    matches: { expectedOccurrenceDates: ['2026-10-01'], missingTransactionDates: [], foundTransactions: [{ date: '2026-10-01', transactionId: nextId }] } }] } };
  const s = serve({ optIn: false, txs: [pay('2026-10-09', 1400, { linked: false }), one], lm: billLm,
    bills: [{ id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 1, firstDue: '2026-10-01',
      confidence: 'confirmed', payingAccount: 'chequing-a', householdObligation: true }],
    extraRules: [{ eventId: 'band', lunchMoneyRecurringIds: [BILL], atlasAccountId: 'chequing-a', direction: 'debit',
      settlesWhen: 'exact-scheduled-amount', settlementFrom: OPT_IN }] });
  ok(!s.billPaid.includes('band@2026-10-01'), 'an exact-amount bill paired by LM to a $1 payment is not paid', JSON.stringify(s.billPaid));
}

console.log('7. A rule with its own salary-receipt matcher never takes LM\'s pairing (Codex P2 on #1292)');
{
  // An invented salary rule shaped like Amanda's (a salary-receipt alias) that also names an LM item and opts in.
  // LM pairs a Tue Oct 13 credit to Oct 15; the rule's incumbent same-day guard would not. Hand-derived: since the
  // rule never takes LM's pairing, Oct 15 is not settled from that credit.
  const SAL = '7400222';
  const credit = H.lm({ id: ++nextId, date: '2026-10-13', amount: -2000, category: 'Transfer', account: 'chequing-a',
    payee: 'Invented transfer', raw: { recurring_id: Number(SAL) } });
  const salLm = { status: 'read', read: { unexpectedPaginationEvidence: false, items: [{ providerId: SAL, status: 'reviewed',
    unavailableFields: [], criteria: { startDate: '2026-10-15', endDate: null, granularity: 'month', quantity: 1,
      anchorDate: '2026-10-15', currency: 'CAD', plaidAccountId: '9001', manualAccountId: null },
    matches: { expectedOccurrenceDates: ['2026-10-15'], missingTransactionDates: [], foundTransactions: [{ date: '2026-10-13', transactionId: nextId }] } }] } };
  const w = { optIn: false, txs: [pay('2026-10-09', 1400, { linked: false }), credit], lm: salLm, asOf: '2026-10-16',
    extraRules: [{ eventId: 'invented-salary', lunchMoneyRecurringIds: [SAL], salaryReceiptPayeePatterns: ['Invented Tennis PAY'],
      payeePattern: 'Invented transfer', atlasAccountId: 'chequing-a', direction: 'credit', settlesWhen: 'exact-scheduled-amount',
      settlementFrom: OPT_IN }] };
  const s = serve({ ...w, income: [{ id: 'invented-salary', label: 'Invented salary', frequency: 'monthly', day: 15,
    firstDue: '2026-10-15', amount: 2000, confidence: 'confirmed' }] });
  ok(!s.billPaid.includes('invented-salary@2026-10-15'), 'the salary-receipt rule is not settled by LM\'s pairing', JSON.stringify(s.billPaid));
}

console.log('8. A replay is idempotent');
{
  const d = pay('2026-10-12', 1350);
  const lm = lmRead({ expected: E, missing: ['2026-10-23'], found: [d] });
  const first = serve({ txs: [d], lm }), again = serve({ txs: [d], lm });
  ok(isDeepStrictEqual(first.served.liveOverlay, again.served.liveOverlay), 'the same observation twice gives the same served result');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Seaspan pay LM-matched checks passed.');
