'use strict';
/* Q2 (lead 2026-11-18; owner decision 6957060901, "pay too"): Amanda's pay
 * counts when it reaches Bills, per the settled rule (owner 2026-08-22 and
 * 2026-08-31: her salary lands in TENNIS INCOME first, and the household-
 * visible proof is the later transfer into BILLS). A salary rule that names
 * one reviewed Lunch Money recurring item and opts in with settlementFrom
 * 'lunchmoney-matched-occurrences' lets Lunch Money's own pairing decide which
 * payday a Bills arrival settles. There is then no same-day demand and no
 * exact-scheduled-amount demand, and the arrival settles at its actual amount.
 * The transfer identity is unchanged: a transfer row into Bills with its
 * same-day TENNIS INCOME leg. Without a consistent LM pairing, the incumbent
 * same-day exact rule applies unchanged (the fallback until the household's
 * items exist). FOUNDATION: no household rule names an item yet.
 *
 * Path: invented raw Lunch Money payload plus an invented LM recurring report
 * -> scripts/live-plan.js -> served data -> Forecast.recommend.
 *
 * Invented world (test/acceptance/harness.js): Dale's pay 1400 biweekly from
 * Friday 2026-10-09, so the pay period holding the plan date is Oct 9-22.
 * One invented Amanda salary stream, 2000 monthly on the 15th from 2026-09-15.
 * TENNIS INCOME is an invented household-external account (externalId
 * tennis-income). Hand-derived: this period's income is Dale's 1400 plus the
 * Oct 15 salary, at its actual amount once it is received, else at its
 * scheduled 2000 (unresolved).
 *
 * `node test/test-amanda-pay-lm-matched.js`
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

const ID = '7333015';
const OPT_IN = 'lunchmoney-matched-occurrences';
const TENNIS = 9010;
const EXPECTED = ['2026-09-15', '2026-10-15'];

let nextId = 700000;
// One Bills arrival: the transfer credit into Bills (linked to the LM item unless
// said otherwise) and, unless said otherwise, its same-day TENNIS INCOME leg.
function arrive(date, amount, { linked = true, leg = true, category = 'Transfer' } = {}) {
  const id = ++nextId;
  const rows = [H.lm({ id, date, amount: -amount, category, account: 'chequing-a', payee: 'Invented transfer',
    raw: linked ? { recurring_id: Number(ID) } : {} })];
  if (leg) rows.push(H.lm({ id: ++nextId, date, amount, category: 'Transfer', account: 'tennis', providerAccountId: TENNIS,
    payee: 'Invented transfer' }));
  rows.txId = id;
  rows.date = date;
  return rows;
}
// Lunch Money's invented report for the item.
const lmRead = ({ expected = EXPECTED, missing = [], found = [], status = 'reviewed' }) => ({
  status: 'read', read: { unexpectedPaginationEvidence: false, requestedWindow: { startDate: '2026-08-02', endDate: '2026-11-20' },
    items: [{ providerId: ID, status, unavailableFields: [],
      criteria: { startDate: '2026-09-15', endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-09-15',
        currency: 'CAD', plaidAccountId: '9001', manualAccountId: null },
      matches: { expectedOccurrenceDates: expected, missingTransactionDates: missing,
        foundTransactions: found.map(a => ({ date: a.date, transactionId: a.txId })) } }] } });

function serve({ asOf = '2026-10-20', arrivals = [], lm, optIn = true, named = true }) {
  const w = H.baseWorld(asOf);
  w.windowStart = '2026-08-02';
  w.accounts.push({ id: 'tennis', providerId: TENNIS, role: 'household-external', collection: 'cash',
    label: 'Invented tennis income', value: 0, held: true, externalId: 'tennis-income' });
  w.income.push({ id: 'amandaSalary15', label: 'Invented salary (15th)', frequency: 'monthly', day: 15,
    firstDue: '2026-09-15', amount: 2000, confidence: 'confirmed' });
  w.identityRules.push({ eventId: 'amandaSalary15', salaryReceiptPayeePatterns: ['Invented Tennis PAY'],
    transactionKind: 'transfer', atlasAccountId: 'chequing-a', direction: 'credit', counterpartExternalId: 'tennis-income',
    settlesWhen: 'exact-scheduled-amount', ...(named ? { lunchMoneyRecurringIds: [ID] } : {}),
    ...(optIn ? { settlementFrom: OPT_IN } : {}) });
  w.transactions = [H.lm({ id: 699999, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' }), ...arrivals.flat()];
  H.productionOpening(w);
  const payload = { ...H.rawPayload(w), ...(lm ? { recurringItems: lm } : {}) };
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload,
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (r.error) throw r.error;
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const current = adv.defaultView.calendarPeriods.find(p => p.start <= asOf && p.end >= asOf);
  const oct = (current.income || []).find(i => i.id === 'amandaSalary15' && i.date === '2026-10-15') || null;
  return {
    live: r.data.liveOverlay.operatingPlan === 'live',
    settled: (packet.representedActuals || []).filter(x => x.id === 'amandaSalary15')
      .map(x => x.date + ':' + Math.abs(x.actual)),
    received: !!oct && oct.status === 'received',
    oct,
    income: current.incomeTotal,
    otherIncome: current.otherIncome && current.otherIncome.amount,
    future: F.expandEvents(r.data.plan, asOf, '2026-12-31', {}).filter(e => e.id === 'amandaSalary15')
      .map(e => e.date + ':' + e.amount),
    served: r.data,
  };
}
const unresolved = s => !s.received && s.income === 3400 && JSON.stringify(s.settled) === JSON.stringify(['2026-09-15:2000']);

console.log('1. Late and short: LM paired an Oct 16 arrival of 1950 to Oct 15');
{
  const sep = arrive('2026-09-15', 2000), oct = arrive('2026-10-16', 1950);
  const s = serve({ arrivals: [sep, oct], lm: lmRead({ found: [sep, oct] }) });
  ok(s.live, 'the plan is live');
  ok(JSON.stringify(s.settled) === JSON.stringify(['2026-09-15:2000', '2026-10-15:1950']),
    'Sep 15 and Oct 15 are settled, Oct 15 at its actual 1950', JSON.stringify(s.settled));
  ok(s.received && s.oct.alreadyInCash === true, 'Oct 15 reads received and already in cash');
  ok(s.income === 3350, 'this period\'s income is 1400 + 1950 = 3350 (actual, once; never 2000 or 3950 extra)', String(s.income));
  ok(s.otherIncome === 0, 'the arrival is not also Other Income');
  ok(JSON.stringify(s.future) === JSON.stringify(['2026-11-15:2000', '2026-12-15:2000']),
    'later paydays are unchanged, once each: the arrival is never the next pay', JSON.stringify(s.future));
  const control = serve({ arrivals: [sep, oct], optIn: false, named: false });
  ok(unresolved(control), 'control (today\'s rule): a late, short transfer leaves Oct 15 unresolved at the scheduled 2000',
    JSON.stringify([control.settled, control.income]));
}

console.log('2. Early: LM paired an Oct 14 arrival to Oct 15');
for (const asOf of ['2026-10-20', '2026-10-14']) {
  const sep = arrive('2026-09-15', 2000), oct = arrive('2026-10-14', 2000);
  const s = serve({ asOf, arrivals: [sep, oct], lm: lmRead({ found: [sep, oct] }) });
  ok(s.live && s.received && s.income === 3400 && JSON.stringify(s.settled) === JSON.stringify(['2026-09-15:2000', '2026-10-15:2000']),
    `plan date ${asOf}: Oct 15 settles once at 2000, in its own period; income 3400`, JSON.stringify([s.settled, s.income]));
  ok(JSON.stringify(s.future) === JSON.stringify(['2026-11-15:2000', '2026-12-15:2000']), `plan date ${asOf}: the remaining paydays are Nov 15 and Dec 15 at 2000 once each (Oct 15 is not expected again, Nov 15 is not settled early)`);
}

console.log('3. A missing payday: LM lists Oct 15 as missing');
{
  const sep = arrive('2026-09-15', 2000);
  const s = serve({ arrivals: [sep], lm: lmRead({ missing: ['2026-10-15'], found: [sep] }) });
  ok(s.live && unresolved(s), 'Oct 15 is not received; it stays unresolved at the scheduled 2000', JSON.stringify([s.settled, s.income]));
}

console.log('4. Fail closed: anything LM did not pair consistently is not received');
{
  const sep = arrive('2026-09-15', 2000), a = arrive('2026-10-16', 2000), b = arrive('2026-10-17', 2000);
  const two = serve({ arrivals: [sep, a, b], lm: lmRead({ found: [sep, a, b] }) });
  ok(unresolved(two), 'two candidate arrivals for one payday (3 found, 2 matched dates): Oct 15 is not received');
  const lm = lmRead({ found: [sep, a] });
  lm.read.items[0].matches.foundTransactions.push({ date: a.date, transactionId: a.txId });
  const twice = serve({ arrivals: [sep, a], lm });
  ok(!twice.received && twice.settled.length === 0,
    'one arrival LM listed for two paydays settles neither payday (Grok\'s guard)', JSON.stringify(twice.settled));
  const noLeg = arrive('2026-10-16', 2000, { leg: false });
  ok(unresolved(serve({ arrivals: [sep, noLeg], lm: lmRead({ found: [sep, noLeg] }) })),
    'an arrival with no same-day TENNIS INCOME leg is not received (the transfer identity still holds)');
  const notTransfer = arrive('2026-10-16', 2000, { category: 'Payroll' });
  ok(unresolved(serve({ arrivals: [sep, notTransfer], lm: lmRead({ found: [sep, notTransfer] }) })),
    'an arrival that is not a transfer row is not received');
  const out = arrive('2026-10-16', -2000);
  ok(unresolved(serve({ arrivals: [sep, out], lm: lmRead({ found: [sep, out] }) })),
    'money out of Bills, even if LM listed it, is not received');
  const suggested = lmRead({ found: [sep, a] });
  suggested.read.items[0].status = 'suggested';
  ok(unresolved(serve({ arrivals: [sep, a], lm: suggested })), 'a suggested (unreviewed) LM item is not used');
}

console.log('5. The incumbent same-day exact rule is the fallback');
{
  const sep = arrive('2026-09-15', 2000), oct = arrive('2026-10-15', 2000);
  for (const [label, lm] of [['no recurring read', undefined], ['an unavailable read', { status: 'unavailable' }],
    ['a read without the item', { status: 'read', read: { unexpectedPaginationEvidence: false, items: [] } }]]) {
    const s = serve({ arrivals: [sep, oct], lm });
    ok(s.received && s.income === 3400, `with ${label}, a linked same-day exact transfer still settles Oct 15`, JSON.stringify(s.settled));
  }
  const short = arrive('2026-10-15', 1950);
  ok(unresolved(serve({ arrivals: [sep, short], lm: { status: 'unavailable' } })),
    'with no LM pairing, a same-day transfer of another amount stays unresolved, exactly as today');
  const unlinked = arrive('2026-10-15', 2000, { linked: false });
  ok(serve({ arrivals: [sep, unlinked], optIn: false, named: false }).received,
    'a rule that names no item (every household rule today) keeps today\'s behaviour');
  // Disclosed in the card: once a rule names its item, it identifies by the LM link only (as every LM-linked rule does).
  ok(!serve({ arrivals: [sep, unlinked], lm: { status: 'unavailable' } }).received,
    'once a rule names its item, an arrival without that link is not this salary');
}

console.log('6. A replay is idempotent');
{
  const sep = arrive('2026-09-15', 2000), oct = arrive('2026-10-16', 1950);
  const first = serve({ arrivals: [sep, oct], lm: lmRead({ found: [sep, oct] }) });
  const again = serve({ arrivals: [sep, oct], lm: lmRead({ found: [sep, oct] }) });
  ok(isDeepStrictEqual(first.served.liveOverlay, again.served.liveOverlay) && first.income === again.income,
    'the same observation twice gives the same served result');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Amanda pay LM-matched checks passed.');
