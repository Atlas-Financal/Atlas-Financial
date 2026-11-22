'use strict';
/* S3 by Lunch Money's own pairing (lead ruling 2026-11-17, after #1284; the
 * merge waits for Grok Bot's yes, rule 17). A rule that names exactly one
 * reviewed Lunch Money recurring item opts in with settlementFrom
 * 'lunchmoney-matched-occurrences'. Lunch Money reports, for the read range,
 * matches.expected_occurrence_dates, found_transactions ({date,
 * transaction_id}) and missing_transaction_dates ("expected but none was
 * found"). An expected date not in missing is LM-matched. When everything
 * agrees, the matched dates and the found payments pair in date order and
 * LM's pairing decides the occurrence each linked payment settles, in that
 * occurrence's planned pay period (Dale's rule). Atlas adds no matching of
 * its own (it only orders LM's sets when their counts agree)
 * and widens no transaction fetch. Any inconsistency leaves the rule's
 * incumbent early-or-due relation unchanged (fail closed to today).
 *
 * Invented world (test/acceptance/harness.js): payday anchor 2026-10-09,
 * biweekly; the opening is dated 2026-10-09. Pay periods: Oct 9-22,
 * Oct 23-Nov 5, Nov 6-19, Nov 20-Dec 3, Dec 4-17. An invented $80 band-room
 * bill, monthly on the 1st, paid from Bills (chequing-a, LM account 9001),
 * identified by the Lunch Money recurring link 7123457 alone. Each case
 * states LM's invented report and the hand-derived answer.
 *
 * `node test/test-lunchmoney-matched-occurrences.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');
const ObservationMemory = require('../scripts/server-observation-memory.js');
const { isDeepStrictEqual } = require('node:util');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const ID = '7123457';
const OPT_IN = 'lunchmoney-matched-occurrences';

let nextId = 650000;
const pay = (date, amount = 80, extra = {}) => {
  const row = H.lm({ id: ++nextId, date, amount, account: 'chequing-a', payee: 'Invented e-transfer',
    raw: { recurring_id: Number(ID), ...extra } });
  row.txId = nextId;
  return row;
};
// LM's invented report for the item: expected dates, missing dates, and the
// payments it matched (by transaction id).
const lmRead = ({ expected, missing = [], found = [], anchor = '2026-01-01', status = 'reviewed' }) => ({
  status: 'read', read: { unexpectedPaginationEvidence: false, requestedWindow: { startDate: '2026-08-02', endDate: '2027-01-10' },
    items: [{ providerId: ID, status, unavailableFields: [],
      criteria: { startDate: anchor, endDate: null, granularity: 'month', quantity: 1, anchorDate: anchor,
        currency: 'CAD', plaidAccountId: '9001', manualAccountId: null },
      matches: { expectedOccurrenceDates: expected, missingTransactionDates: missing,
        foundTransactions: found.map(tx => ({ date: tx.date, transactionId: tx.txId })) } }] } });

function serve({ asOf = '2026-10-14', payments = [], lm, optIn = true, firstDue = '2026-07-01', represented = [], replay = false }) {
  const w = H.baseWorld(asOf);
  w.windowStart = '2026-08-02';
  w.bills = [{ id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 1, firstDue,
    confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true }];
  w.identityRules = w.identityRules.concat([{ eventId: 'band', linkedFrom: '2026-01-01', lunchMoneyRecurringIds: [ID], atlasAccountId: 'chequing-a',
    direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
    postingDateRule: 'covers-early-or-due-on-or-before-posting', ...(optIn ? { settlementFrom: OPT_IN } : {}) }]);
  w.transactions = [H.lm({ id: 649999, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' }), ...payments];
  if (represented.length) w.planPatch = plan => {
    plan.opening = { ...(plan.opening || {}), representedEvents: represented.map(date => ({ id: 'band', date })) };
  };
  H.productionOpening(w);
  const original = { ...H.rawPayload(w), ...(lm ? { recurringItems: lm } : {}) };
  // replay: the recurring read as replay memory retains it (the projection
  // live-plan re-evaluates; the harness rows are not the live fetch's shape,
  // so only the recurring read is projected here).
  const payload = replay && lm ? { ...original, recurringItems: ObservationMemory.sourceInputs({
    provider: 'lunchmoney', fetchedAt: original.fetchedAt, accounts: [], categories: [], tags: [], transactions: [],
    transactionWindow: { startDate: '2026-08-02', endDate: asOf, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, hasMore: false, truncated: false, basis: 'is_pending-unbounded' },
    recurringItems: lm }).recurringItems } : original;
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload,
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const bills = adv.defaultView.calendarPeriods.flatMap(p => (p.bills || []).filter(b => b.id === 'band')
    .map(b => ({ ...b, period: p.start })));
  const pairs = {};
  const dates = [];
  for (const c of (r.report.representedEventCandidates || []).filter(c => c.id === 'band')) {
    (pairs[c.postingDate + '#' + c.providerTransactionId] = pairs[c.postingDate + '#' + c.providerTransactionId] || []).push(c.date);
    dates.push(c.date);
  }
  return {
    applied: r.data.liveOverlay.applied,
    at: date => bills.find(b => b.date === date) || null,
    paidOn: new Set((packet.representedActuals || []).filter(row => row.id === 'band').map(row => row.date)),
    row: tx => packet.transactions.find(t => t.date === tx.date && t.amount === lunchAmount(tx)) || null,
    pairs, once: Object.values(pairs).every(list => list.length === 1) && new Set(dates).size === dates.length,
    blob: JSON.stringify(r.data) + JSON.stringify(r.report),
    data: r.data,
    payload,
  };
}
const lunchAmount = tx => Number(tx.amount);
const due = b => !!b && /still due/i.test(b.status);
// Grok (b): each payment settles at most one due date, each due date has at
// most one payment, and the pairing is exactly the hand-derived one.
const pairsAre = (s, want, label) => {
  const got = Object.fromEntries(Object.entries(s.pairs).map(([key, list]) => [key.split('#')[0], list.join(',')]));
  ok(s.once && JSON.stringify(got) === JSON.stringify(want), label + ': each payment settles exactly one due date',
    JSON.stringify(got));
};

console.log('1. Early: LM matched an Oct 12 payment to Nov 1, so Nov 1 is paid in its own period');
{
  // LM: expected Sep 1, Oct 1, Nov 1; none missing; found the Sep 1, Oct 1 and
  // Oct 12 payments. Date order pairs Oct 12 with Nov 1 (Oct 23-Nov 5).
  const p = [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-12')];
  const s = serve({ payments: p, lm: lmRead({ expected: ['2026-09-01', '2026-10-01', '2026-11-01'], found: p }) });
  ok(s.applied === true, 'the overlay applies');
  ok(s.paidOn.has('2026-11-01'), 'Nov 1 is represented', JSON.stringify([...s.paidOn]));
  ok(s.at('2026-11-01') && !due(s.at('2026-11-01')) && s.at('2026-11-01').period === '2026-10-23',
    'Nov 1 is not still due, in Oct 23-Nov 5', s.at('2026-11-01') && [s.at('2026-11-01').status, s.at('2026-11-01').period].join(' '));
  ok(s.row(p[2]) && s.row(p[2]).representedBill === true, 'the Oct 12 payment is the bill, not spending');
  pairsAre(s, { '2026-09-01': '2026-09-01', '2026-10-01': '2026-10-01', '2026-10-12': '2026-11-01' }, 'early');
  // Control: no LM read, the incumbent 7-day rule leaves Nov 1 still due.
  const control = serve({ payments: [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-12')] });
  ok(due(control.at('2026-11-01')) && !control.paidOn.has('2026-11-01'), 'control: no read, Nov 1 still due',
    control.at('2026-11-01') && control.at('2026-11-01').status);
  // Control: the same read on a rule that does not opt in changes nothing.
  const off = serve({ payments: p.map(tx => ({ ...tx })), optIn: false,
    lm: lmRead({ expected: ['2026-09-01', '2026-10-01', '2026-11-01'], found: p }) });
  ok(due(off.at('2026-11-01')), 'control: not opted in, Nov 1 still due', off.at('2026-11-01') && off.at('2026-11-01').status);
}

console.log('2. Late: LM matched Nov 5 to Nov 1; Dec 1 stays due');
{
  const p = [pay('2026-10-01'), pay('2026-11-05')];
  const s = serve({ asOf: '2026-11-10', payments: p,
    lm: lmRead({ expected: ['2026-10-01', '2026-11-01', '2026-12-01'], missing: ['2026-12-01'], found: p }) });
  pairsAre(s, { '2026-10-01': '2026-10-01', '2026-11-05': '2026-11-01' }, 'late');
  ok(due(s.at('2026-12-01')), 'Dec 1 still due', s.at('2026-12-01') && s.at('2026-12-01').status);
}

console.log('3. Duplicate: LM matched one of two Nov 1 payments; the other settles nothing');
{
  const p = [pay('2026-10-01'), pay('2026-11-01'), pay('2026-11-01')];
  const s = serve({ asOf: '2026-11-10', payments: p,
    lm: lmRead({ expected: ['2026-10-01', '2026-11-01', '2026-12-01'], missing: ['2026-12-01'], found: [p[0], p[1]] }) });
  pairsAre(s, { '2026-10-01': '2026-10-01', '2026-11-01': '2026-11-01' }, 'duplicate');
  ok(!s.paidOn.has('2026-12-01') && due(s.at('2026-12-01')), 'Dec 1 is not settled by the second', JSON.stringify([...s.paidOn]));
}

console.log('4. Refund then repay: LM matched the repay; the first payment and the refund settle nothing');
{
  const p = [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-10'), pay('2026-10-11', -80), pay('2026-10-12')];
  const s = serve({ payments: p,
    lm: lmRead({ expected: ['2026-09-01', '2026-10-01', '2026-11-01'], found: [p[0], p[1], p[4]] }) });
  pairsAre(s, { '2026-09-01': '2026-09-01', '2026-10-01': '2026-10-01', '2026-10-12': '2026-11-01' }, 'refund then repay');
  ok(s.row(p[2]) && s.row(p[2]).representedBill !== true, 'the Oct 10 payment is not the bill');
}

console.log('5. Gap month: LM says Nov 1 missing and matched a Dec 1 payment to Dec 1');
{
  const p = [pay('2026-12-01')];
  const s = serve({ asOf: '2026-12-10', payments: p,
    lm: lmRead({ expected: ['2026-11-01', '2026-12-01', '2027-01-01'], missing: ['2026-11-01', '2027-01-01'], found: p }) });
  pairsAre(s, { '2026-12-01': '2026-12-01' }, 'gap month');
  ok(!s.paidOn.has('2026-11-01'), 'Nov 1 is not settled', JSON.stringify([...s.paidOn]));
}

console.log('6. Any inconsistency leaves today\'s behaviour (the incumbent 7-day rule)');
{
  const p = () => [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-12')];
  const expected = ['2026-09-01', '2026-10-01', '2026-11-01'];
  const cases = [
    ['found count differs from matched dates', ps => lmRead({ expected, found: ps.slice(0, 2) })],
    // Two matched dates, one found: date order alone would pair Oct 12 with
    // Nov 1, but the counts disagree, so nothing is taken from LM.
    ['one found for two matched dates', ps => lmRead({ expected: ['2026-11-01', '2026-12-01'], found: [ps[2]] })],
    ['a missing date LM did not expect', ps => lmRead({ expected, missing: ['2026-12-01'], found: ps })],
    ['a found payment not in this observation', ps => lmRead({ expected, found: [ps[0], ps[1], { date: '2026-10-12', txId: 1 }] })],
    ['the item is not reviewed', ps => lmRead({ expected, found: ps, status: 'suggested' })],
    ['a matched date that is no scheduled occurrence', ps => lmRead({ expected: ['2026-09-01', '2026-10-01', '2026-11-03'], found: ps })],
  ];
  for (const [label, read] of cases) {
    const ps = p();
    const s = serve({ payments: ps, lm: read(ps) });
    ok(!s.paidOn.has('2026-11-01') && due(s.at('2026-11-01')), label + ': Nov 1 still due', JSON.stringify([...s.paidOn]));
  }
  // A found payment on another account, or at ten times the amount, is not
  // accepted either.
  const wrongAcct = [pay('2026-09-01'), pay('2026-10-01'), H.lm({ id: ++nextId, date: '2026-10-12', amount: 80,
    account: 'chequing-b', payee: 'Invented e-transfer', raw: { recurring_id: Number(ID) } })];
  wrongAcct[2].txId = nextId;
  const a = serve({ payments: wrongAcct, lm: lmRead({ expected, found: wrongAcct }) });
  ok(!a.paidOn.has('2026-11-01'), 'a found payment on another account: Nov 1 not settled', JSON.stringify([...a.paidOn]));
  const big = [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-12', 800)];
  const b = serve({ payments: big, lm: lmRead({ expected, found: big }) });
  ok(!b.paidOn.has('2026-11-01'), 'a found payment ten times the amount: Nov 1 not settled', JSON.stringify([...b.paidOn]));
}

console.log('7. Window roll (Codex P1 on #1284): the same LM report gives the same answer on Nov 30 and Dec 1');
{
  // The opening names Nov 1. LM matched Oct 12 to Oct 1 and Nov 5 to Nov 1;
  // Dec 1 missing. Atlas carries no pairing between refreshes, so Dec 1 stays
  // due on both days with no new payment.
  for (const asOf of ['2026-11-30', '2026-12-01']) {
    const p = [pay('2026-10-12'), pay('2026-11-05')];
    const s = serve({ asOf, payments: p, represented: ['2026-11-01'],
      lm: lmRead({ expected: ['2026-10-01', '2026-11-01', '2026-12-01'], missing: ['2026-12-01'], found: p }) });
    ok(!s.paidOn.has('2026-12-01') && due(s.at('2026-12-01')), 'as of ' + asOf + ': Dec 1 still due',
      s.at('2026-12-01') && s.at('2026-12-01').status);
    ok(s.once, 'as of ' + asOf + ': each payment settles at most one due date', JSON.stringify(s.pairs));
  }
}

console.log('8. Before the first due date (Codex P2 on #1284): an early first payment LM matched settles it');
{
  // firstDue Nov 1; as of Oct 29 (period Oct 23-Nov 5); paid Oct 28. LM
  // expected Nov 1 (the read reaches 31 days past Oct 29), none missing.
  const p = [pay('2026-10-28')];
  const s = serve({ asOf: '2026-10-29', firstDue: '2026-11-01', payments: p, lm: lmRead({ expected: ['2026-11-01'], found: p }) });
  pairsAre(s, { '2026-10-28': '2026-11-01' }, 'first payment');
  ok(s.at('2026-11-01') && !due(s.at('2026-11-01')), 'Nov 1 is not still due', s.at('2026-11-01') && s.at('2026-11-01').status);
}

console.log('9. A day move cannot strand a paid occurrence: LM anchored on the 4th matched Nov 3 to Nov 4');
{
  // The reviewed item moves the bill to the 4th (#1283); LM expected Oct 4,
  // Nov 4, Dec 4 (Dec 4 missing) and matched Oct 3 and Nov 3.
  const p = [pay('2026-10-03'), pay('2026-11-03')];
  const s = serve({ asOf: '2026-11-10', payments: p, lm: lmRead({ anchor: '2026-01-04',
    expected: ['2026-10-04', '2026-11-04', '2026-12-04'], missing: ['2026-12-04'], found: p }) });
  pairsAre(s, { '2026-10-03': '2026-10-04', '2026-11-03': '2026-11-04' }, 'day move');
  ok(s.paidOn.has('2026-11-04') && !s.paidOn.has('2026-11-01'), 'Nov 4 is represented, not Nov 1', JSON.stringify([...s.paidOn]));
}

console.log('9b. Grok\'s guard: LM matched one transaction to two due dates, so neither reads Paid');
{
  // As of Nov 3 (period Oct 23-Nov 5). LM lists the Oct 28 payment for both
  // Nov 1 and Dec 1, nothing missing. Neither occurrence is settled, the
  // payment is the bill of no occurrence (To confirm). The incumbent 7-day
  // rule alone would have settled Nov 1 (control).
  const p = [pay('2026-10-28')];
  const s = serve({ asOf: '2026-11-03', payments: p,
    lm: lmRead({ expected: ['2026-11-01', '2026-12-01'], found: [p[0], p[0]] }) });
  ok(!s.paidOn.has('2026-11-01') && !s.paidOn.has('2026-12-01'), 'neither Nov 1 nor Dec 1 is settled', JSON.stringify([...s.paidOn]));
  ok(Object.keys(s.pairs).length === 0, 'no payment settles any due date', JSON.stringify(s.pairs));
  ok(s.row(p[0]) && s.row(p[0]).representedBill === false, 'the Oct 28 payment is represented by no bill (To confirm)');
  // To confirm, the incumbent meaning (test-bill-link-cross-date-conflict):
  // the payment is the bill of no occurrence, and Nov 1 stays due, reserved.
  ok(due(s.at('2026-11-01')) && s.at('2026-11-01').remaining === 80, 'Nov 1 still due, $80 reserved',
    s.at('2026-11-01') && s.at('2026-11-01').status);
  ok(s.row(p[0]).linkedBillMisfit && s.row(p[0]).linkedBillMisfit.id === 'band', 'its line names the band-room bill to confirm',
    JSON.stringify(s.row(p[0]).linkedBillMisfit));
  const control = serve({ asOf: '2026-11-03', payments: [pay('2026-10-28')] });
  ok(control.paidOn.has('2026-11-01'), 'control: with no read, the incumbent rule settles Nov 1', JSON.stringify([...control.paidOn]));
}

console.log('9c. LM omits a future date from missing: the counts disagree and the bill falls back');
{
  // As of Oct 14 the read reaches Nov 14, so Nov 1 is expected. LM lists
  // Sep 1, Oct 1 and Nov 1 as expected and none missing, but found only Sep 1
  // and Oct 1. Matched 3 is not found 2, so nothing comes from LM; the incumbent
  // rule leaves the Oct 12 payment (20 days early) unsettled.
  const p = [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-12')];
  const s = serve({ payments: p, lm: lmRead({ expected: ['2026-09-01', '2026-10-01', '2026-11-01'], found: [p[0], p[1]] }) });
  ok(!s.paidOn.has('2026-11-01') && due(s.at('2026-11-01')), 'Nov 1 still due (fallback)', JSON.stringify([...s.paidOn]));
}

console.log('9d. Replay memory: an LM-settled refresh replays from its retained projection to the same served data');
{
  // live-plan keeps replay memory only when the projection re-evaluates to a
  // deep-equal document (OD-008 retained display). Same world, same LM report.
  const mk = () => [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-12')];
  const p = mk();
  const read = () => lmRead({ expected: ['2026-09-01', '2026-10-01', '2026-11-01'], found: p });
  nextId -= 3;
  const live = serve({ payments: mk(), lm: read() });
  nextId -= 3;
  const replayed = serve({ payments: mk(), lm: read(), replay: true });
  ok(live.paidOn.has('2026-11-01') && replayed.paidOn.has('2026-11-01'), 'both settle Nov 1 through LM');
  const diff = (a, b, path = '') => { if (isDeepStrictEqual(a, b)) return null; if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = diff(a[k], b[k], path + '.' + k); if (d) return d; } } return path + ' ' + JSON.stringify(a).slice(0, 200) + ' | ' + JSON.stringify(b).slice(0, 200); };
  ok(isDeepStrictEqual(live.data, replayed.data), 'the replayed served data is deep-equal (memory would be stored)', diff(live.data, replayed.data));
  const m = replayed.payload.recurringItems.read.items[0].matches;
  ok(JSON.stringify(Object.keys(m).sort()) === JSON.stringify(['expectedOccurrenceDates', 'foundTransactions', 'missingTransactionDates'])
    && m.foundTransactions.every(f => JSON.stringify(Object.keys(f).sort()) === JSON.stringify(['date', 'transactionId'])),
    'the projection keeps dates and ids only', JSON.stringify(m));
}

console.log('10. The pairing marker never reaches the served document or the report');
{
  const p = [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-12')];
  const s = serve({ payments: p, lm: lmRead({ expected: ['2026-09-01', '2026-10-01', '2026-11-01'], found: p }) });
  ok(s.paidOn.has('2026-11-01'), 'positive control: Nov 1 is represented');
  ok(!/lmMatched/.test(s.blob), 'no lmMatched field anywhere in the served data or report');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Lunch Money matched-occurrence checks passed.');
