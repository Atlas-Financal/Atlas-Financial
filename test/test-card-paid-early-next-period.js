'use strict';
// H2-6 (Gemini hunt 2, #821 7091517953; scope (a), the Paid status only): a card-paid bill whose next occurrence posted
// early to the card, and which the ledger already ties to that occurrence, reads PAID in the next pay period. The
// Stack "confirmed paid" check stays pending (scope (b), a trust promotion, is parked for Dale). Grok Bot's four
// conditions (Plan #6, relayed by the lead 2026-11-23) each have a control below.
// `node test/test-card-paid-early-next-period.js`
//
// Failure it detects: an early-posted, represented card-paid occurrence shown unpaid next period (status planned,
// Stack paid 0); a represented row without posting proof, at a non-scheduled date, or posted after the start settling
// it; a joint-cash bill's prepaid behaviour changing. Release decision: any failure blocks.
//
// Invented input (from the hunt's repro, with invented amounts): periods 2026-10-09..10-22 and 10-23..11-05, viewed
// 2026-10-21. A monthly card-paid bill on day 28 for 23.47, payingAccount the card; it posts to the card on 10-20.
const assert = require('node:assert/strict');
const F = require('../public/forecast');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const AMOUNT = 23.47;
function world({ payingAccount = 'triangle', represented = { id: 'streaming', date: '2026-10-28', postedOn: '2026-10-20', effectiveAsOf: '2026-10-20' },
  account = 'triangle', role = 'revolving-credit', pending = false, txDate = '2026-10-20', tie = true, extraTx = [], extraTies = [], jointCash } = {}) {
  const plan = {
    opening: { asOf: '2026-10-21', paydaySnapshot: { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 1013.29 } },
    startingCash: { asOf: '2026-10-21', breakdown: [
      { id: 'chequing-a', value: 1013.29, confidence: 'confirmed', evidenceDate: '2026-10-21' },
      { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: '2026-10-21' },
    ] },
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-10-09', amount: 2011.37, confidence: 'confirmed' }],
    obligations: [{ id: 'tri-min', label: 'Invented card min', debtId: 'triangle', effect: 'payment', frequency: 'monthly', day: 15, amount: 51.13, confidence: 'confirmed' }],
    bills: [{ id: 'streaming', label: 'Invented streaming', frequency: 'monthly', day: 28, amount: AMOUNT, payingAccount, ...(jointCash === undefined ? {} : { jointCash }), confidence: 'confirmed' }],
    commitments: [], budget: { categories: [] },
  };
  const packet = { schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-10-21',
    coverageStart: '2026-10-09', coverageThrough: '2026-10-21', transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: [{ id: 'tx-s', date: txDate, amount: AMOUNT, currency: 'CAD', accountId: account, accountRole: role, pending }, ...extraTx],
    representedActuals: [...(represented && tie ? [{ id: 'streaming', date: represented.date, actual: AMOUNT, postedOn: represented.postedOn, transactionId: 'tx-s' }] : []), ...extraTies] };
  const opts = { weeklyVariable: 0, currentPeriodActuals: packet, representedEvents: represented ? [represented] : [],
    debts: [{ id: 'triangle', label: 'Invented card', structure: 'Revolving', secured: false, balance: 503.11, pending: 0, rate: 0.2, limit: 3000 }] };
  return { plan, opts };
}
const next = w => {
  const a = F.recommend(w.plan, '2026-10-21', w.opts);
  const view = a.payPeriodViews.find(v => v.start === '2026-10-23');
  return { row: view.bills.find(b => b.id === 'streaming'), paid: view.stackSummary.bills.paid };
};
const cents = v => Math.round(Number(v) * 100);

console.log('1. The early-posted, ledger-tied card-paid occurrence reads PAID next period; the Stack check stays pending');
{
  const w = world();
  ok(F.isCardPaidBill(w.plan.bills[0], w.plan) === true, 'the invented bill is card-paid');
  const { row, paid } = next(w);
  ok(row.status === 'PAID' && cents(row.remaining) === 0, 'next period: status PAID, remaining 0',
    JSON.stringify({ s: row.status, r: row.remaining }));
  ok(row.stackBillPaid === false && row.stackBillPaymentEvidence === 'pending' && cents(paid) === 0,
    'scope (a) only: the Stack "confirmed paid" check stays pending and Stack bills paid stays 0 (scope (b) is Dale\'s)',
    JSON.stringify({ p: row.stackBillPaid, e: row.stackBillPaymentEvidence, paid }));
}

console.log('2. What does not settle it (Grok Bot\'s four conditions, each with a control)');
const unpaid = (label, w) => {
  const { row } = next(w);
  ok(row.status !== 'PAID' && cents(row.remaining) === cents(AMOUNT), label + ' leaves the next occurrence unpaid',
    JSON.stringify({ s: row.status, r: row.remaining }));
};
// 1. Posted, not pending, and already tied to that bill in the ledger.
unpaid('condition 1: a pending card row', world({ pending: true }));
unpaid('condition 1: a posting the ledger has not tied to the occurrence', world({ tie: false }));
unpaid('condition 1: a represented row without posting proof (legacy id and date)', world({ represented: { id: 'streaming', date: '2026-10-28' } }));
unpaid('condition 1: a posting after this start', world({ represented: { id: 'streaming', date: '2026-10-28', postedOn: '2026-10-22', effectiveAsOf: '2026-10-22' } }));
unpaid('condition 1: a tie on another card than the one that pays the bill', world({ account: 'cashback' }));
{
  // A bill off joint cash on an account that is not a card: card-paid by its jointCash flag, but its posting is no card row.
  const w = world({ payingAccount: 'invented-loan', account: 'invented-loan', role: 'installment-loan', jointCash: false });
  ok(F.isCardPaidBill(w.plan.bills[0], w.plan) === true, 'control world: a jointCash:false bill on a non-card account is card-paid');
  unpaid('condition 1: a tied posting that is not a card row', w);
}
unpaid('condition 1: a tied card row dated after the as-of', world({ txDate: '2026-10-22' }));
// 2. One posting settles one occurrence; a later refund or reversal un-settles it.
unpaid('condition 2: one posting tied to two occurrences', world({ extraTies: [{ id: 'streaming', date: '2026-11-28', actual: AMOUNT, postedOn: '2026-10-20', transactionId: 'tx-s' }] }));
unpaid('condition 2: two postings tied to one occurrence', world({ extraTx: [{ id: 'tx-t', date: '2026-10-20', amount: AMOUNT, currency: 'CAD', accountId: 'triangle', accountRole: 'revolving-credit', pending: false }],
  extraTies: [{ id: 'streaming', date: '2026-10-28', actual: AMOUNT, postedOn: '2026-10-20', transactionId: 'tx-t' }] }));
unpaid('condition 2: a later posted refund of that charge on the card', world({ extraTx: [{ id: 'tx-r', date: '2026-10-21', amount: -AMOUNT, currency: 'CAD', accountId: 'triangle', accountRole: 'revolving-credit', pending: false }] }));
// 3. The card-payment transfer from chequing never settles the bill a second time.
unpaid('condition 3: a tie to a card-payment transfer out of chequing', world({ account: 'chequing-a', role: 'household-cash' }));
// 4. Exact means the occurrence's identity, not a matching date.
unpaid('condition 4: a tie at a date that is not the scheduled occurrence', world({ represented: { id: 'streaming', date: '2026-10-27', postedOn: '2026-10-20', effectiveAsOf: '2026-10-20' } }));
unpaid('control: no represented row at all', world({ represented: null }));
for (const [label, extra] of [['kindHint card-payment', { kindHint: 'card-payment' }], ['kindHint payment', { kindHint: 'payment' }],
  ['kindHint transfer', { kindHint: 'transfer' }], ['card-payment identity', { cardPaymentIdentity: true }], ['excluded from totals', { excludeFromTotals: true }]]) {
  const { row } = next(world({ extraTx: [{ id: 'tx-pay', date: '2026-10-21', amount: -AMOUNT, currency: 'CAD', accountId: 'triangle', accountRole: 'revolving-credit', pending: false, ...extra }] }));
  ok(row.status === 'PAID' && cents(row.remaining) === 0, 'control: a same-amount card payment (' + label + ') is not a reversal and does not un-settle it',
    JSON.stringify({ s: row.status, r: row.remaining }));
}
{
  const { row } = next(world({ extraTx: [{ id: 'tx-r', date: '2026-10-21', amount: -AMOUNT, currency: 'CAD', accountId: 'triangle', accountRole: 'revolving-credit', pending: false, kindHint: 'refund' }] }));
  ok(row.status !== 'PAID', 'condition 2: a credit the ledger marks as a refund still un-settles it', JSON.stringify({ s: row.status }));
}
{
  const { row } = next(world({ extraTx: [{ id: 'tx-other', date: '2026-10-21', amount: -11.02, currency: 'CAD', accountId: 'triangle', accountRole: 'revolving-credit', pending: false }] }));
  ok(row.status === 'PAID', 'control: an unrelated card credit of another amount does not un-settle it', JSON.stringify({ s: row.status }));
}

console.log('3. Control: a joint-cash bill keeps its incumbent prepaid behaviour');
{
  const { row } = next(world({ payingAccount: 'chequing-a', account: 'chequing-a', role: 'household-cash' }));
  ok(row.status === 'PAID' && cents(row.remaining) === 0, 'an early-posted joint-cash bill still reads PAID (prepaidJointCashOutflow)',
    JSON.stringify({ s: row.status, r: row.remaining }));
}

console.log('4. The production path: observer report -> live-plan overlay (applyLiveCutover) -> recommend');
{
  // The invented early-income ledger (test/fixtures/early-income-data, payroll, no receipt) gives a real observer
  // report. The observer's own matching is out of scope (rule 17), so one represented candidate for the card bill and
  // the ledger's tie are added to that report, exactly in the observer's output shapes; everything after that is the
  // production overlay and engine.
  const O = require('../scripts/provider-observe');
  const Live = require('../scripts/live-plan');
  const fixture = require('./fixtures/early-income-data');
  const clone = x => JSON.parse(JSON.stringify(x));
  const occurrence = '2027-01-03';
  const live = ({ postingDate, tie = true } = {}) => {
    const x = fixture('payroll', 'unpaid');
    x.data.plan.bills = [{ id: 'streaming', label: 'Invented streaming', frequency: 'monthly', day: 3, amount: AMOUNT,
      payingAccount: 'triangle', jointCash: false, confidence: 'confirmed' }];
    const report = O.observe({ provider: 'lunchmoney', ...x });
    const posted = postingDate || x.asOf;
    report.representedEventCandidates = [...(report.representedEventCandidates || []),
      { id: 'streaming', date: occurrence, postingDate: posted, observedAmount: AMOUNT, transactionIds: ['invented-card-posting'] }];
    const packet = clone(report.currentPeriodActuals || {});
    packet.transactions = [...(packet.transactions || []), { id: 'tx-live', date: posted, amount: AMOUNT, currency: 'CAD',
      accountId: 'triangle', accountRole: 'revolving-credit', pending: false }];
    packet.representedActuals = [...(packet.representedActuals || []),
      ...(tie ? [{ id: 'streaming', date: occurrence, actual: AMOUNT, postedOn: posted, transactionId: 'tx-live' }] : [])];
    report.currentPeriodActuals = packet;
    const out = Live.overlayLiveState({ data: x.data, report });
    const plan = out.data.plan;
    const rec = F.recommend(plan, plan.opening.asOf, { weeklyVariable: 0, currentPeriodActuals: out.data.liveOverlay.currentPeriodActuals });
    const view = rec.payPeriodViews.find(v => (v.bills || []).some(b => b.id === 'streaming' && b.date === occurrence));
    return { plan, row: view && view.bills.find(b => b.id === 'streaming' && b.date === occurrence) };
  };
  const carried = live();
  ok(carried.plan.opening.representedEvents.some(e => e.id === 'streaming' && e.date === occurrence && e.postedOn),
    'the overlay carries the early card posting to the engine with its posting date',
    JSON.stringify(carried.plan.opening.representedEvents));
  ok(carried.row && carried.row.status === 'PAID' && cents(carried.row.remaining) === 0 && carried.row.stackBillPaid === false,
    'live: the occurrence reads PAID, 0 remaining, and the Stack check stays pending', JSON.stringify(carried.row));
  const untied = live({ tie: false });
  ok(untied.row && untied.row.status !== 'PAID' && cents(untied.row.remaining) === cents(AMOUNT),
    'live control: carried without the ledger tie, the engine leaves it unpaid (the overlay settles nothing)',
    JSON.stringify(untied.row));
  const late = live({ postingDate: '2027-01-01' });
  ok(!late.plan.opening.representedEvents.some(e => e.id === 'streaming') && late.row && late.row.status !== 'PAID',
    'live control: a posting after the live as-of is not carried and the occurrence stays unpaid',
    JSON.stringify({ rep: late.plan.opening.representedEvents, row: late.row && late.row.status }));
}

console.log(`card-paid bill paid early, next period: ${checks} checks passed`);
