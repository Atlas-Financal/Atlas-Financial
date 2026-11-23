'use strict';
// H2-6 (Gemini hunt 2, #821 7091517953; scope (a), the Paid status only): a card-paid bill whose next occurrence posted
// early to the card, and which the ledger already ties to that occurrence, reads PAID in the next pay period. The
// Stack "confirmed paid" check stays pending (scope (b), a trust promotion, is parked for Dale). Grok Bot's four
// conditions (Plan #6, relayed by the lead 2026-11-23) each have a control below.
// `node test/test-card-paid-early-next-period.js`
//
// Failure it detects: an early-posted card-paid occurrence that the ledger ties to one posted card charge shown unpaid
// next period (status planned); anything short of that tie settling it (pending or unknown posting, another card, a
// non-card row, a tie without posting proof or posted after the start, a shared or doubled tie, a stale opening); an
// amount-matched credit un-settling a tied occurrence; the Stack check moving; a joint-cash bill's prepaid behaviour
// changing. Release decision: any failure blocks.
//
// Invented input (from the hunt's repro, with invented amounts): periods 2026-10-09..10-22 and 10-23..11-05, viewed
// 2026-10-21. A monthly card-paid bill on day 28 for 23.47, payingAccount the card; it posts to the card on 10-20.
const assert = require('node:assert/strict');
const F = require('../public/forecast');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const AMOUNT = 23.47;
function world({ payingAccount = 'triangle', represented = { id: 'streaming', date: '2026-10-28', postedOn: '2026-10-20', effectiveAsOf: '2026-10-20' },
  account = 'triangle', role = 'revolving-credit', pending = false, evidence = 'posted', txDate = '2026-10-20', link = 'provider-matched', tie = true, extraTx = [], extraTies = [], jointCash } = {}) {
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
    transactions: [{ id: 'tx-s', date: txDate, amount: AMOUNT, currency: 'CAD', accountId: account, accountRole: role, pending,
      savingsPostingEvidence: evidence }, ...extraTx],
    representedActuals: [...(represented && tie ? [{ id: 'streaming', date: represented.date, actual: AMOUNT, postedOn: represented.postedOn, transactionId: 'tx-s', ...(link ? { occurrenceLink: link } : {}) }] : []), ...extraTies] };
  // The ledger's tie is the only settlement input: no plan receipt (representedEvents) is given.
  const opts = { weeklyVariable: 0, currentPeriodActuals: packet, representedEvents: [],
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
// The tie must be the provider's own matched occurrence (desk adoption, Grok Bot 2026-11-23): the same row shape from
// an Atlas payee or early-date inference, or with any other label, never settles it.
unpaid('condition 1: a tie that is not the provider\'s own matched occurrence (no occurrenceLink)', world({ link: null }));
unpaid('condition 1: a tie with any other provenance label', world({ link: 'payee-inferred' }));
unpaid('condition 1: a card row whose native posting evidence is unknown', world({ evidence: 'unknown' }));
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
unpaid('condition 2: one posting tied to two occurrences', world({ extraTies: [{ id: 'streaming', date: '2026-11-28', actual: AMOUNT, postedOn: '2026-10-20', transactionId: 'tx-s', occurrenceLink: 'provider-matched' }] }));
unpaid('condition 2: two postings tied to one occurrence', world({ extraTx: [{ id: 'tx-t', date: '2026-10-20', amount: AMOUNT, currency: 'CAD', accountId: 'triangle', accountRole: 'revolving-credit', pending: false, savingsPostingEvidence: 'posted' }],
  extraTies: [{ id: 'streaming', date: '2026-10-28', actual: AMOUNT, postedOn: '2026-10-20', transactionId: 'tx-t', occurrenceLink: 'provider-matched' }] }));
// A refund un-settles it through the ledger: once the ledger removes (or moves) the tie, nothing settles it.
unpaid('condition 2: a refund the ledger has untied from the occurrence', world({ tie: false,
  extraTx: [{ id: 'tx-r', date: '2026-10-21', amount: -AMOUNT, currency: 'CAD', accountId: 'triangle', accountRole: 'revolving-credit', pending: false, savingsPostingEvidence: 'posted' }] }));
unpaid('condition 2: a refund after which the ledger re-tied the occurrence to a posting after this start', world({ tie: false,
  extraTx: [{ id: 'tx-other-bill', date: '2026-10-22', amount: AMOUNT, currency: 'CAD', accountId: 'triangle', accountRole: 'revolving-credit', pending: false, savingsPostingEvidence: 'posted' }],
  extraTies: [{ id: 'streaming', date: '2026-10-28', actual: AMOUNT, postedOn: '2026-10-22', transactionId: 'tx-other-bill', occurrenceLink: 'provider-matched' }] }));
// 3. The card-payment transfer from chequing never settles the bill a second time.
unpaid('condition 3: a tie to a card-payment transfer out of chequing', world({ account: 'chequing-a', role: 'household-cash' }));
// 4. Exact means the occurrence's identity, not a matching date.
unpaid('condition 4: a tie at a date that is not the scheduled occurrence', world({ represented: { id: 'streaming', date: '2026-10-27', postedOn: '2026-10-20', effectiveAsOf: '2026-10-20' } }));
unpaid('control: no represented row at all', world({ represented: null }));
{
  // The tie counts only against the current opening, the one proven to include the posting.
  const w = world();
  w.plan.opening = { ...w.plan.opening, asOf: '2026-10-20' };
  unpaid('control: a stale opening (dated before this start)', w);
  const m = world();
  delete m.plan.opening.asOf;
  unpaid('control: an opening with no date', m);
}
// Atlas never infers a refund of this charge from an amount (ChatGPT review 7094928044): with the tie still in
// place, none of these credits un-settles it.
for (const [label, credit] of [
  ['an equal-value refund from another merchant', { id: 'tx-r1', date: '2026-10-21', payee: 'Invented other merchant', kindHint: 'refund' }],
  ['an equal-value credit whose native posting evidence is unknown', { id: 'tx-r2', date: '2026-10-21', savingsPostingEvidence: 'unknown' }],
  ['an equal-value credit dated after the as-of', { id: 'tx-r3', date: '2026-10-25' }],
  ['a same-amount card payment', { id: 'tx-r4', date: '2026-10-21', kindHint: 'card-payment' }]]) {
  const { row } = next(world({ extraTx: [{ amount: -AMOUNT, currency: 'CAD', accountId: 'triangle', accountRole: 'revolving-credit',
    pending: false, savingsPostingEvidence: 'posted', ...credit }] }));
  ok(row.status === 'PAID' && cents(row.remaining) === 0, 'control: ' + label + ' does not un-settle a tied occurrence',
    JSON.stringify({ s: row.status, r: row.remaining }));
}

console.log('3. Control: a joint-cash bill keeps its incumbent prepaid behaviour');
{
  // A joint-cash bill keeps its incumbent path: a plan receipt with posting proof (prepaidJointCashOutflow).
  const w = world({ payingAccount: 'chequing-a', account: 'chequing-a', role: 'household-cash' });
  w.opts.representedEvents = [{ id: 'streaming', date: '2026-10-28', postedOn: '2026-10-20', effectiveAsOf: '2026-10-20' }];
  const { row } = next(w);
  ok(row.status === 'PAID' && cents(row.remaining) === 0, 'an early-posted joint-cash bill still reads PAID (prepaidJointCashOutflow)',
    JSON.stringify({ s: row.status, r: row.remaining }));
}

console.log('4. The production path: observer report -> live-plan overlay -> recommend, settled from the ledger tie alone');
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
      accountId: 'triangle', accountRole: 'revolving-credit', pending: false, savingsPostingEvidence: 'posted' }];
    packet.representedActuals = [...(packet.representedActuals || []),
      ...(tie ? [{ id: 'streaming', date: occurrence, actual: AMOUNT, postedOn: posted, transactionId: 'tx-live', occurrenceLink: 'provider-matched' }] : [])];
    report.currentPeriodActuals = packet;
    const out = Live.overlayLiveState({ data: x.data, report });
    const plan = out.data.plan;
    const rec = F.recommend(plan, plan.opening.asOf, { weeklyVariable: 0, currentPeriodActuals: out.data.liveOverlay.currentPeriodActuals });
    const view = rec.payPeriodViews.find(v => (v.bills || []).some(b => b.id === 'streaming' && b.date === occurrence));
    return { plan, row: view && view.bills.find(b => b.id === 'streaming' && b.date === occurrence) };
  };
  const carried = live();
  ok(!(carried.plan.opening.representedEvents || []).some(e => e.id === 'streaming'),
    'the overlay adds no plan receipt for the future card purchase (test-card-bill-protection-lifecycle)',
    JSON.stringify(carried.plan.opening.representedEvents));
  ok(carried.row && carried.row.status === 'PAID' && cents(carried.row.remaining) === 0 && carried.row.stackBillPaid === false,
    'live: the occurrence reads PAID, 0 remaining, and the Stack check stays pending', JSON.stringify(carried.row));
  const untied = live({ tie: false });
  ok(untied.row && untied.row.status !== 'PAID' && cents(untied.row.remaining) === cents(AMOUNT),
    'live control: without the ledger tie, the occurrence stays unpaid',
    JSON.stringify(untied.row));
  const late = live({ postingDate: '2027-01-01' });
  ok(late.row && late.row.status !== 'PAID',
    'live control: a tie posted after the live as-of leaves the occurrence unpaid',
    JSON.stringify({ rep: late.plan.opening.representedEvents, row: late.row && late.row.status }));
}

console.log('5. Raw Lunch Money rows through the real observer, overlay and Forecast: only the provider\'s own match settles it');
{
  // Nothing is injected: invented raw Lunch Money transactions and an invented recurring-item read (the shape
  // test-lunchmoney-matched-occurrences uses) go through Live.fromObservation and Forecast.recommend. An invented
  // card-paid bill (jointCash false, on an invented card), monthly on the 7th, 23.47; viewed 2026-11-03, so the
  // Nov 7 occurrence falls in the next pay period (Nov 6-19). Its card charge posted early, on Nov 2.
  const H = require('./acceptance/harness.js');
  const Live = require('../scripts/live-plan');
  const ID = '7123499';
  let nextId = 760000;
  const pay = date => {
    const row = H.lm({ id: ++nextId, date, amount: AMOUNT, account: 'travelvisa', providerAccountId: 9004,
      payee: 'Invented streaming', raw: { recurring_id: Number(ID) } });
    row.txId = nextId;
    return row;
  };
  const lmRead = ({ expected, missing = [], found = [] }) => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
    requestedWindow: { startDate: '2026-09-01', endDate: '2027-01-10' },
    items: [{ providerId: ID, status: 'reviewed', unavailableFields: [],
      criteria: { startDate: '2026-01-07', endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-01-07',
        currency: 'CAD', plaidAccountId: '9004', manualAccountId: null },
      matches: { expectedOccurrenceDates: expected, missingTransactionDates: missing,
        foundTransactions: found.map(tx => ({ date: tx.date, transactionId: tx.txId })) } }] } });
  const serve = ({ payments, lm, optIn = true }) => {
    const w = H.baseWorld('2026-11-03');
    w.windowStart = '2026-09-01';
    w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 200 });
    w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 200, pending: 0, rate: 0.2, limit: 3000 }];
    w.bills = [{ id: 'streaming', label: 'Invented streaming', amount: AMOUNT, frequency: 'monthly', day: 7, firstDue: '2026-09-07',
      confidence: 'confirmed', payingAccount: 'travelvisa', householdObligation: true, jointCash: false }];
    w.identityRules = w.identityRules.concat([{ eventId: 'streaming', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID],
      atlasAccountId: 'travelvisa', direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
      postingDateRule: 'covers-early-or-due-on-or-before-posting', ...(optIn ? { settlementFrom: 'lunchmoney-matched-occurrences' } : {}) }]);
    w.transactions = [H.lm({ id: 759999, date: '2026-10-23', amount: -1400, category: 'Payroll', account: 'chequing-a',
      payee: 'Invented employer' }), ...payments];
    H.productionOpening(w);
    const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: { ...H.rawPayload(w), ...(lm ? { recurringItems: lm } : {}) },
      accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
    const packet = r.data.liveOverlay.currentPeriodActuals;
    const adv = F.recommend(r.data.plan, '2026-11-03', { currentPeriodActuals: packet, debts: r.data.debts, weeklyVariable: 0 });
    const view = adv.payPeriodViews.find(v => v.start === '2026-11-06');
    return { r, packet, view, row: view && view.bills.find(b => b.id === 'streaming' && b.date === '2026-11-07'),
      ties: (packet.representedActuals || []).filter(t => t.id === 'streaming' && t.date === '2026-11-07') };
  };
  const both = () => [pay('2026-10-07'), pay('2026-11-02')];
  const st = row => row && JSON.stringify({ s: row.status, r: row.remaining, p: row.stackBillPaid, e: row.stackBillPaymentEvidence });
  {
    const p = both();
    const s = serve({ payments: p, lm: lmRead({ expected: ['2026-10-07', '2026-11-07'], found: p }) });
    ok(F.isCardPaidBill(s.r.data.plan.bills.find(b => b.id === 'streaming'), s.r.data.plan) === true, 'raw: the invented bill is card-paid');
    ok(s.ties.length === 1 && s.ties[0].occurrenceLink === 'provider-matched',
      'raw: the observer labels Lunch Money\'s own matched occurrence provider-matched', JSON.stringify(s.ties));
    ok(s.row && s.row.status === 'PAID' && cents(s.row.remaining) === 0, 'raw, native match: Nov 7 reads PAID, 0 remaining, in Nov 6-19', st(s.row));
    ok(s.row.stackBillPaid === false && s.row.stackBillPaymentEvidence === 'pending' && cents(s.view.stackSummary.bills.paid) === 0,
      'raw, native match: the Stack "confirmed paid" check stays pending (scope (b) is Dale\'s)', st(s.row));
    ok(!(s.r.data.plan.opening.representedEvents || []).some(e => e.id === 'streaming'),
      'raw, native match: the overlay adds no plan receipt for the future card purchase', JSON.stringify(s.r.data.plan.opening.representedEvents));
  }
  {
    // Atlas's own payee and early-date rule (no Lunch Money read, not opted in) ties Nov 2 to Nov 7 in the same row
    // shape, but it is an inference, not the ledger's link.
    const s = serve({ payments: both(), optIn: false });
    ok(s.ties.length === 1 && !s.ties[0].occurrenceLink, 'raw, payee/early-date inference: a tie exists but carries no provider label', JSON.stringify(s.ties));
    ok(s.row && s.row.status !== 'PAID' && cents(s.row.remaining) === cents(AMOUNT), 'raw, payee/early-date inference: Nov 7 stays due', st(s.row));
  }
  {
    // Lunch Money reports Nov 7 missing (no link, or the link removed after a refund): it stays due.
    const p = both();
    const s = serve({ payments: p, lm: lmRead({ expected: ['2026-10-07', '2026-11-07'], missing: ['2026-11-07'], found: [p[0]] }) });
    ok(s.row && s.row.status !== 'PAID' && cents(s.row.remaining) === cents(AMOUNT), 'raw, missing or removed link: Nov 7 stays due', st(s.row));
  }
  {
    // Lunch Money lists the Nov 2 payment twice (a reused, ambiguous link): Grok Bot's guard settles nothing.
    const p = both();
    const s = serve({ payments: p, lm: lmRead({ expected: ['2026-10-07', '2026-11-07'], found: [p[0], p[1], p[1]] }) });
    ok(s.row && s.row.status !== 'PAID' && cents(s.row.remaining) === cents(AMOUNT), 'raw, reused or ambiguous link: Nov 7 stays due', st(s.row));
  }
}

console.log(`card-paid bill paid early, next period: ${checks} checks passed`);
