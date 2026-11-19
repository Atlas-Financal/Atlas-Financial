'use strict';
/* #1355 NEXT PR (e): period-history capture applies the derived amountFixed the way the live page does.
 *
 * A bill's amountFixed comes only from its Lunch Money payment history (provider-observe derivedAmountFixedBills).
 * Live reads that history as `amountHistory`; observation memory keeps only the outcome record
 * (`amountFixedDerivation`: source, status, window, bill ids), never the rows. Capture used to drop both, so a
 * captured period re-ran Forecast with no bill fixed: a fixed bill paid in part read PAID / "Partly paid" in the
 * capture where the live page held its remainder as still due.
 *
 * Invented world: test/acceptance/harness.js base world as of 2026-10-14 (current pay period Oct 9-22, the closed
 * one Sep 25-Oct 8), one invented hydro bill of $90, confirmed, identified by its own payee rule. Three earlier
 * posted $90 payments derive it fixed. By hand:
 *   - current period, $40 paid on Oct 12: the live page holds the bill still due, remaining 90 - 40 = 50;
 *   - closed period, $40 paid on Oct 2: the live close keeps the payment as paid and flags the partly paid
 *     remainder (partlyPaidRemainder: true).
 * A captured record must equal the live publication of the same period, whichever form the caller holds:
 *   1. raw history (the operator CLI and the acceptance harness): capture derives the record, keeps only it;
 *   2. the memory record (the capture-on-refresh writer and the period-close auto-capture pass memory evidence);
 *   3. neither: no bill is fixed (the old result, which differs from live);
 *   4. a forged or malformed record fixes nothing; a record naming an extra bill id fixes only the plan's bills.
 * The stored payload never holds the history rows.
 *
 * `node test/test-period-history-amount-fixed.js`
 */
const History = require('../scripts/private-period-history');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');
const Memory = require('../scripts/server-observation-memory');
const F = require('../public/forecast');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const HISTORY_DAYS = { 2: ['2026-07-02', '2026-08-02', '2026-09-02'], 12: ['2026-07-12', '2026-08-12', '2026-09-12'] };
const pay = (amount, date) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' });

function worldInput(day) {
  const w = H.baseWorld();
  w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day, confidence: 'confirmed',
    payee: 'Invented hydro' }];
  w.transactions = [pay(40, '2026-10-' + String(day).padStart(2, '0'))];
  // As in production, the 200-day read also carries the period's own (partial) payment.
  w.amountHistory = { transactions: HISTORY_DAYS[day].map(d => pay(90, d)).concat(w.transactions) };
  H.productionOpening(w);
  return { data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w, { captureCash: true }),
    accountMap: H.accountMapOf(w, { captureCash: true }), identity: H.identityOf(w), periods: [] };
}
const withoutHistory = payload => { const out = { ...payload }; delete out.amountHistory; return out; };
const now = input => () => new Date(Date.parse(input.payload.fetchedAt) + 60000);

// The live publication of one period: the served path (Live.fromObservation over the raw payload, history
// included) and the recommend options the server builds, exactly as the closing-capture suite reprints it.
// The live period less each bill row's derived Stack Wallet paidState, which
// is set at publication from the row's own fields and never saved.
const withoutBillPaidState = row => {
  const copy = JSON.parse(JSON.stringify(row));
  const bills = copy && Array.isArray(copy.bills) ? copy.bills : [];
  if (!bills.every(b => b && Object.hasOwn(b, 'paidState'))) throw new Error('every live bill row publishes paidState');
  for (const b of bills) delete b.paidState;
  return copy;
};
function livePeriod(input, start) {
  const refreshed = Live.fromObservation(input);
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = input.periods;
  const asOf = Operating.asOfFrom(refreshed.data, {});
  return { report: refreshed.report,
    row: withoutBillPaidState(F.recommend(refreshed.data.plan, asOf, options).payPeriodViews.find(p => p.start === start)) };
}
const hydro = row => (row && row.bills || []).find(b => b.id === 'hydro') || {};
function capture(kind, input) {
  return kind === 'closing' ? History.captureClosing(input, { now: now(input) })
    : History.capture({ ...input, kind }, { now: now(input) });
}
function deepKeys(value, out = new Set()) {
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); deepKeys(v, out); }
  return out;
}

for (const [label, day, kind, start] of [['current period (first-observed)', 12, 'first-observed', '2026-10-09'],
  ['closed period (closing)', 2, 'closing', '2026-09-25']]) {
  console.log(label);
  const input = worldInput(day);
  const live = livePeriod(input, start);
  const record = live.report.derivedAmountFixed;
  ok(record && record.status === 'complete' && same(record.billIds, ['hydro']), 'live: the history derives the invented hydro bill fixed',
    JSON.stringify(record));
  if (kind === 'first-observed') {
    ok(hydro(live.row).status === 'still due' && hydro(live.row).remaining === 50 && hydro(live.row).actual === 40,
      'live: the part-paid fixed bill is still due for 90 - 40 = 50', JSON.stringify(hydro(live.row)));
  } else {
    ok(hydro(live.row).status === 'PAID' && hydro(live.row).partlyPaidRemainder === true,
      'live close: the payment reads paid and the partly paid remainder is flagged', JSON.stringify(hydro(live.row)));
  }

  // 1. Raw history in the caller's payload: capture derives the record and keeps only it.
  const fromRaw = capture(kind, input);
  ok(same(fromRaw.content.publication, live.row), 'raw history: the captured publication equals the live one');
  const stored = fromRaw.content.evidence.input.payload;
  ok(!deepKeys(fromRaw).has('amountHistory') && same(stored.amountFixedDerivation, Memory.amountFixedDerivation(record)),
    'raw history: the stored payload keeps the clean record and no amountHistory', JSON.stringify(stored.amountFixedDerivation));
  // The bill sheet's payment series (Dale, 2026-11-18) is a page view, never period history.
  ok(!deepKeys(fromRaw).has('billPaymentHistory'), 'raw history: the captured close keeps no bill payment series');
  ok(!JSON.stringify(fromRaw).includes(HISTORY_DAYS[day][0]) && !JSON.stringify(fromRaw).includes(HISTORY_DAYS[day][1]),
    'raw history: no history row (its July or August payment date) is stored anywhere in the record');
  ok(same(stored.transactions.map(t => t.id), input.payload.transactions.map(t => t.id)),
    'raw history: the stored transactions are the observation window rows only');

  // 2. The memory record (what both live writers pass): the same publication, the same stored record.
  const memoryInput = { ...input, payload: { ...withoutHistory(input.payload), amountFixedDerivation: record } };
  const fromMemory = capture(kind, memoryInput);
  ok(same(fromMemory.content.publication, live.row), 'memory record: the captured publication equals the live one');
  ok(same(fromMemory.content.evidence.input.payload.amountFixedDerivation, stored.amountFixedDerivation),
    'memory record: it stores the same clean record as the raw-history capture');

  // 3. Neither: no bill is fixed, so the capture differs from live (the result before this change).
  const bare = capture(kind, { ...input, payload: withoutHistory(input.payload) });
  ok(!same(bare.content.publication, live.row) && !Object.hasOwn(bare.content.evidence.input.payload, 'amountFixedDerivation'),
    'no history and no record: no bill is fixed and the capture differs from live', JSON.stringify(hydro(bare.content.publication)));
  if (kind === 'first-observed') {
    ok(hydro(bare.content.publication).status === 'PAID', 'no record: the part-paid bill reads PAID (the defect this closes)');
  }

  // 4. Only a clean record is trusted.
  for (const [what, forged] of [
    ['a malformed bill id', { ...record, billIds: ['hydro', 42] }],
    ['no window', { ...record, window: null }],
    ['an unavailable status', { ...record, status: 'unavailable' }],
    ['another source', { ...record, source: 'owner-mark' }],
    ['a bare array', ['hydro']]]) {
    const forgedCapture = capture(kind, { ...input, payload: { ...withoutHistory(input.payload), amountFixedDerivation: forged } });
    const kept = forgedCapture.content.evidence.input.payload.amountFixedDerivation || {};
    ok(same(forgedCapture.content.publication, bare.content.publication) && kept.status === 'unavailable' && same(kept.billIds, []),
      `a record with ${what} fixes nothing and is stored as unavailable`);
  }
  const extra = capture(kind, { ...input, payload: { ...withoutHistory(input.payload),
    amountFixedDerivation: { ...record, billIds: ['not-a-plan-bill', 'hydro'] } } });
  ok(same(extra.content.publication, live.row) && !(extra.content.publication.bills || []).some(b => b.id === 'not-a-plan-bill'),
    'a record naming an extra bill id fixes only the plan\'s own bill and adds none');
}

// #1369 landed after #1370: the record now also carries obligationIds. A part-paid fixed mortgage must round-trip.
// Invented: a biweekly $800 mortgage due Fri Oct 9 with three completed $800 payments (Aug 28, Sep 11, Sep 25), and
// $300 paid on Oct 9. By hand the live page holds it still due for 800 - 300 = 500; the capture must equal it.
console.log('obligation (mortgage) record round-trips');
{
  const mpay = (amount, date) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented mortgage co' });
  const w = H.baseWorld();
  w.bills = [];
  w.obligations = [{ id: 'mortgage', debtId: 'mortgage', effect: 'payment', label: 'Invented mortgage', frequency: 'biweekly',
    anchor: '2026-10-09', amount: 800, confidence: 'confirmed', payingAccount: 'chequing-a' }];
  w.debts = [{ id: 'mortgage', label: 'Invented mortgage', balance: 200000, rate: 5, payment: 800, confidence: 'confirmed' }];
  w.identityRules = (w.identityRules || []).concat([{ eventId: 'mortgage', payeePattern: 'Invented mortgage co',
    atlasAccountId: 'chequing-a', direction: 'debit' }]);
  w.transactions = [mpay(300, '2026-10-09')];
  w.amountHistory = { transactions: ['2026-08-28', '2026-09-11', '2026-09-25'].map(d => mpay(800, d)).concat(w.transactions) };
  H.productionOpening(w);
  const input = { data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w, { captureCash: true }),
    accountMap: H.accountMapOf(w, { captureCash: true }), identity: H.identityOf(w), periods: [] };
  const start = '2026-10-09';
  const live = livePeriod(input, start);
  const record = live.report.derivedAmountFixed;
  const mortgage = row => (row && row.bills || []).find(b => b.id === 'mortgage') || {};
  ok(record && same(record.obligationIds, ['mortgage']) && same(record.billIds, []), 'live: the history derives the invented mortgage fixed',
    JSON.stringify(record));
  ok(mortgage(live.row).status === 'still due' && mortgage(live.row).remaining === 500 && mortgage(live.row).actual === 300,
    'live: the part-paid fixed mortgage is still due for 800 - 300 = 500', JSON.stringify(mortgage(live.row)));
  const fromRaw = capture('first-observed', input);
  const stored = fromRaw.content.evidence.input.payload.amountFixedDerivation;
  ok(same(fromRaw.content.publication, live.row) && same(stored.obligationIds, ['mortgage']) && !deepKeys(fromRaw).has('amountHistory'),
    'raw history: the captured publication equals live, and the stored record keeps obligationIds and no history rows',
    JSON.stringify(stored));
  const fromMemory = capture('first-observed', { ...input, payload: { ...withoutHistory(input.payload), amountFixedDerivation: record } });
  ok(same(fromMemory.content.publication, live.row), 'memory record: the captured publication equals live');
  const legacy = capture('first-observed', { ...input, payload: { ...withoutHistory(input.payload),
    amountFixedDerivation: { source: record.source, status: record.status, window: record.window, billIds: [] } } });
  ok(mortgage(legacy.content.publication).status === 'PAID', 'a record without obligationIds (a #1370-era record) fixes no obligation: PAID');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll period-history amountFixed checks passed.');
