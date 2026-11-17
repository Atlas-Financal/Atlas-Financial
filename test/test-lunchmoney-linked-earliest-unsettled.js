'use strict';
/* S3, rebuilt (Grok Bot, rule 17, Plan #6 LM thread 2026-11-17: "B, one at a
 * time, with one guard"; lead-agreed rule steps 1-5, 2026-11-17; opt-in per
 * rule). A rule identified by its Lunch Money recurring link that opts in with
 * postingDateRule 'lunchmoney-linked-earliest-unsettled' matches its linked
 * posted payments to bill occurrences oldest first, one payment each:
 *   1. it sees the last two occurrences due on or before the observation and
 *      every later one;
 *   2. the transaction read reaches back to the day after the occurrence
 *      before the oldest of those (same read, wider date range), else nothing
 *      is assigned;
 *   3. a payment can belong to an occurrence when it posts after the previous
 *      occurrence's due date and no more than 62 days after its own; an
 *      occurrence Atlas already counts as paid (the opening names it, or it is
 *      before the opening) still takes its one payment, so that payment is
 *      never reused (Codex P1 on #1282);
 *   4. Grok's guard: a second payment in a cycle reads To confirm and settles
 *      nothing; a missing earlier payment is filled first (bill stays reserved);
 *   5. once a reviewed item moves the bill's day, an opening row under the old
 *      date names the nearest scheduled occurrence (within 14 days, one
 *      nearest), so a day move cannot strand a paid occurrence.
 * "To confirm" is the incumbent meaning for a link-identified bill
 * (test-bill-link-cross-date-conflict): the payment is represented by no bill.
 *
 * Invented world (test/acceptance/harness.js): payday anchor 2026-10-09,
 * biweekly; the opening is dated 2026-10-09 (Sep 1 and Oct 1 sit inside the
 * opening cash). Pay periods: Oct 9-22, Oct 23-Nov 5, Nov 6-19, Nov 20-Dec 3.
 * An invented $80 band-room bill, monthly on the 1st, firstDue 2026-07-01,
 * paid from Bills (chequing-a), identified by the Lunch Money recurring link
 * 7123457 alone. Each case states its hand-derived answer.
 *
 * `node test/test-lunchmoney-linked-earliest-unsettled.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe.js');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const ID = '7123457';
const RULE = 'lunchmoney-linked-earliest-unsettled';
const BILL = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 1, firstDue: '2026-07-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
const ruleOf = (postingDateRule = RULE) => ({ eventId: 'band', lunchMoneyRecurringIds: [ID], atlasAccountId: 'chequing-a',
  direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted', postingDateRule });

let nextId = 640000;
const pay = (date, amount = 80, extra = {}) => H.lm({ id: ++nextId, date, amount, account: 'chequing-a',
  payee: 'Invented e-transfer', raw: { recurring_id: Number(ID), ...extra } });

function serve({ asOf = '2026-10-14', payments = [], rule = RULE, represented = [], windowStart = '2026-08-02',
  recurringItems, periodStart }) {
  const w = H.baseWorld(asOf);
  w.windowStart = windowStart;
  w.bills = [{ ...BILL }];
  w.identityRules = w.identityRules.concat([ruleOf(rule)]);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' }), ...payments];
  if (represented.length) w.planPatch = plan => {
    plan.opening = { ...(plan.opening || {}), representedEvents: represented.map(date => ({ id: 'band', date })) };
  };
  H.productionOpening(w);
  const payload = { ...H.rawPayload(w), ...(recurringItems === undefined ? {} : { recurringItems }) };
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload,
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const periods = adv.defaultView.calendarPeriods;
  const bills = periods.flatMap(p => (p.bills || []).filter(b => b.id === 'band').map(b => ({ ...b, period: p.start })));
  const at = date => bills.find(b => b.date === date) || null;
  const paidOn = new Set((packet.representedActuals || []).filter(row => row.id === 'band').map(row => row.date));
  const row = date => packet.transactions.find(t => t.date === date && t.amount === 80) || null;
  const opening = (r.data.plan.opening.representedEvents || []).filter(row => row.id === 'band').map(row => row.date);
  return { applied: r.data.liveOverlay.applied, at, paidOn, row, opening, report: r.report, plan: r.data.plan,
    period: start => periods.find(p => p.start === (start || periodStart)) || null };
}
const due = b => !!b && /still due/i.test(b.status);
const list = s => JSON.stringify([...s.paidOn]);

console.log('1. Paid 20 days early, earlier payments visible: Nov 1 is paid');
{
  // Sep 1 and Oct 1 (inside the opening) take their own payments; Oct 12 is
  // left over once every earlier occurrence has one, so it settles Nov 1.
  const s = serve({ payments: [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-12')] });
  ok(s.applied === true, 'the overlay applies');
  ok(s.paidOn.has('2026-11-01') && s.paidOn.size === 1, 'exactly Nov 1 is represented', list(s));
  ok(s.at('2026-11-01') && !due(s.at('2026-11-01')), 'Nov 1 no longer reads still due', s.at('2026-11-01') && s.at('2026-11-01').status);
  ok(s.row('2026-10-12') && s.row('2026-10-12').representedBill === true, 'the payment is the bill, not spending');
  const control = serve({ payments: [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-12')],
    rule: 'covers-early-or-due-on-or-before-posting' });
  ok(due(control.at('2026-11-01')) && !control.paidOn.has('2026-11-01'),
    'control: the incumbent 7-day rule leaves Nov 1 still due', control.at('2026-11-01') && control.at('2026-11-01').status);
  // Without the Sep 1 and Oct 1 payments, Oct 12 could be Sep 1's late
  // payment (posted after Aug 1, within 62 days of Sep 1): it is taken by Sep 1
  // and Nov 1 stays reserved.
  const blind = serve({ payments: [pay('2026-10-12')] });
  ok(!blind.paidOn.has('2026-11-01') && due(blind.at('2026-11-01')),
    'earlier payments not seen: Oct 12 fills Sep 1 first, Nov 1 still due', list(blind));
}

console.log('2. A second linked payment in the cycle reads To confirm and settles nothing (Grok\'s guard)');
{
  const s = serve({ payments: [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-10'), pay('2026-10-12')] });
  ok(s.paidOn.has('2026-11-01') && !s.paidOn.has('2026-12-01') && s.paidOn.size === 1,
    'Oct 10 settles Nov 1; Dec 1 is not settled', list(s));
  const second = s.row('2026-10-12');
  ok(second && second.representedBill === false, 'Oct 12 is represented by no bill (To confirm)');
}

console.log('3. Refund then repay: the repay is the second payment in the cycle, To confirm');
{
  const s = serve({ payments: [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-10'), pay('2026-10-11', -80),
    pay('2026-10-12')] });
  ok(s.paidOn.has('2026-11-01') && !s.paidOn.has('2026-12-01') && s.paidOn.size === 1,
    'Nov 1 settled once; the repay does not settle Dec 1', list(s));
  ok(s.row('2026-10-12') && s.row('2026-10-12').representedBill === false, 'the repay is To confirm');
}

console.log('4. Paid late: the overdue occurrence is settled; a second payment never settles the next one');
{
  // As of Nov 10 the ledger sees Oct 1, Nov 1 and later; the read reaches
  // Sep 2. Oct 1 takes its own payment; Nov 5 settles Nov 1 (late).
  const late = serve({ asOf: '2026-11-10', payments: [pay('2026-10-01'), pay('2026-11-05')] });
  ok(late.paidOn.has('2026-11-01') && late.paidOn.size === 1, 'paid Nov 5: Nov 1 is represented', list(late));
  const twice = serve({ asOf: '2026-11-10', payments: [pay('2026-10-01'), pay('2026-11-05'), pay('2026-11-08')] });
  ok(twice.paidOn.has('2026-11-01') && !twice.paidOn.has('2026-12-01'), 'Nov 8 does not settle Dec 1', list(twice));
  ok(twice.row('2026-11-08') && twice.row('2026-11-08').representedBill === false, 'Nov 8 is To confirm');
  ok(due(twice.at('2026-12-01')), 'Dec 1 still due', twice.at('2026-12-01') && twice.at('2026-12-01').status);
}

console.log('5. Codex P1: a payment the opening already used is never reused');
{
  // As of Dec 2 the ledger sees Nov 1, Dec 1 and later. The opening names
  // Nov 1 paid; the Nov 5 payment belongs to Nov 1 (posted after Oct 1), so
  // it settles nothing new, and Dec 1 stays still due with its $80 reserved.
  const s = serve({ asOf: '2026-12-02', represented: ['2026-11-01'], payments: [pay('2026-10-01'), pay('2026-11-05')] });
  ok(!s.paidOn.has('2026-12-01'), 'Dec 1 is not settled by the Nov 5 payment', list(s));
  ok(due(s.at('2026-12-01')) && s.at('2026-12-01').amount === 80, 'Dec 1 still due, $80',
    s.at('2026-12-01') && [s.at('2026-12-01').status, s.at('2026-12-01').amount].join(' '));
  // Control: without the opening's name, Nov 5 settles Nov 1 (late); Dec 1
  // is still due either way.
  const plain = serve({ asOf: '2026-12-02', payments: [pay('2026-10-01'), pay('2026-11-05')] });
  ok(!plain.paidOn.has('2026-12-01') && due(plain.at('2026-12-01')), 'control: Dec 1 still due', list(plain));
}

console.log('6. Dale\'s case: a bill due next pay period, paid this period, is paid');
{
  // As of Nov 18 (period Nov 6-19). Dec 1 is due in the next period
  // (Nov 20-Dec 3). Oct 1 and Nov 1 take their own payments; Nov 18 settles
  // Dec 1. Ledger: Oct 1, Nov 1, Dec 1...; the read must reach Sep 2.
  const pays = () => [pay('2026-10-01'), pay('2026-11-01'), pay('2026-11-18')];
  const s = serve({ asOf: '2026-11-18', payments: pays() });
  ok(s.paidOn.has('2026-12-01'), 'Dec 1 is represented', list(s));
  ok(s.row('2026-11-18') && s.row('2026-11-18').representedBill === true, 'the Nov 18 payment is the bill, not spending');
  // The read stops at Sep 3, one day short: nothing is assigned (fail closed).
  const short = serve({ asOf: '2026-11-18', payments: pays(), windowStart: '2026-09-03' });
  ok(!short.paidOn.has('2026-12-01'), 'a read starting Sep 3 assigns nothing; Dec 1 not settled', list(short));
  // Same read, wider date range: as of Nov 18 the opt-in rule asks for history
  // back to Sep 2, 77 days (Sep 2-30: 28, Oct: 31, Nov 1-18: 18). Without it
  // the incumbent span is shorter.
  const w = H.baseWorld('2026-11-18');
  w.bills = [{ ...BILL }];
  const plan = H.planOf(w);
  const now = '2026-11-18T18:00:00.000Z';
  const withRule = O.postedHistoryDaysForCarriedSettlement({ now, plan, identity: { rules: [ruleOf()] } });
  const without = O.postedHistoryDaysForCarriedSettlement({ now, plan, identity: { rules: [ruleOf('covers-early-or-due-on-or-before-posting')] } });
  ok(withRule === 77, 'history days for the opt-in rule: 77', String(withRule));
  ok(without < 77, 'without it: fewer days', String(without));
}

console.log('7. A day move cannot strand a paid occurrence (lead note 1)');
{
  // A reviewed item anchored on the 4th moves the bill to the 4th. The
  // opening names Nov 1 (the old date): it is the Nov 4 occurrence (3 days
  // away, nothing else within 14), so Nov 4 reads paid, not still due.
  const criteria = { startDate: '2026-01-04', endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-01-04',
    currency: 'CAD', plaidAccountId: '9001', manualAccountId: null };
  const items = { status: 'read', read: { unexpectedPaginationEvidence: false,
    requestedWindow: { startDate: '2026-08-02', endDate: '2026-10-14' },
    items: [{ providerId: ID, status: 'reviewed', unavailableFields: [], criteria,
      matches: { expectedOccurrenceDates: ['2026-09-04', '2026-10-04'], foundTransactions: [] } }] } };
  const moved = serve({ represented: ['2026-11-01'], recurringItems: items, rule: 'covers-early-or-due-on-or-before-posting' });
  ok(moved.plan.bills.find(b => b.id === 'band').day === 4, 'the served day is the 4th');
  ok(moved.opening.includes('2026-11-04') && !moved.opening.includes('2026-11-01'), 'the opening row is re-dated to Nov 4',
    JSON.stringify(moved.opening));
  ok(moved.at('2026-11-04') && !due(moved.at('2026-11-04')), 'Nov 4 is not still due',
    moved.at('2026-11-04') && moved.at('2026-11-04').status);
  const rekey = O.rekeyRepresentedToSchedule;
  const plan4 = { ...moved.plan };
  // Nov 19 is 15 days from both Nov 4 and Dec 4: none within 14, stays as dated.
  ok(JSON.stringify(rekey(plan4, [{ id: 'band', date: '2026-11-19' }], new Set(['band']))) === JSON.stringify([{ id: 'band', date: '2026-11-19' }]),
    'a row 15 days from either occurrence stays as dated');
  // Nov 18 is 14 from Nov 4 and 16 from Dec 4: it re-dates to Nov 4.
  ok(rekey(plan4, [{ id: 'band', date: '2026-11-18' }], new Set(['band']))[0].date === '2026-11-04',
    'a row 14 days away re-dates to the one nearest occurrence');
  ok(JSON.stringify(rekey(plan4, [{ id: 'other', date: '2026-11-01' }], new Set(['band']))) === JSON.stringify([{ id: 'other', date: '2026-11-01' }]),
    'another bill\'s row is untouched');
  ok(rekey(plan4, [{ id: 'band', date: '2026-11-01' }, { id: 'band', date: '2026-11-04' }], new Set(['band'])).length === 1,
    'a re-dated row that duplicates one already there is kept once');
  // Control: the same opening with no read keeps day 1 and Nov 1 paid.
  const control = serve({ represented: ['2026-11-01'], rule: 'covers-early-or-due-on-or-before-posting' });
  ok(control.opening.includes('2026-11-01') && control.at('2026-11-01') && !due(control.at('2026-11-01')),
    'control: no read, Nov 1 stays named and not still due', JSON.stringify(control.opening));
}

console.log('8. Unchanged gates: an inconsistent amount, an unlinked payment and a pending one settle nothing');
{
  const base = () => [pay('2026-09-01'), pay('2026-10-01')];
  const odd = serve({ payments: [...base(), pay('2026-10-12', 800)] });
  ok(!odd.paidOn.has('2026-11-01'), 'ten times the bill amount does not settle it', list(odd));
  const unlinked = serve({ payments: [...base(), H.lm({ id: ++nextId, date: '2026-10-12', amount: 80, account: 'chequing-a',
    payee: 'Invented e-transfer' })] });
  ok(!unlinked.paidOn.has('2026-11-01'), 'an unlinked payment does not settle it');
  const pending = serve({ payments: [...base(), pay('2026-10-12', 80, { is_pending: true, status: 'pending' })] });
  ok(!pending.paidOn.has('2026-11-01'), 'a pending linked payment does not settle it');
  // $800 on Oct 10 fails the amount bound and does not count; Oct 12 is then
  // the first payment of the cycle and settles Nov 1.
  const mixed = serve({ payments: [...base(), pay('2026-10-10', 800), pay('2026-10-12')] });
  ok(mixed.paidOn.has('2026-11-01') && mixed.paidOn.size === 1, 'the $80 after an $800 still settles Nov 1', list(mixed));
  // Never more than one ahead: the opening names Nov 1, so Oct 12 belongs to
  // it and does not reach Dec 1.
  const ahead = serve({ payments: [...base(), pay('2026-10-12')], represented: ['2026-11-01'] });
  ok(!ahead.paidOn.has('2026-12-01'), 'with Nov 1 already named, Oct 12 does not settle Dec 1', list(ahead));
}

console.log('9. The assignment never reaches the served packet');
{
  const s = serve({ payments: [pay('2026-09-01'), pay('2026-10-01'), pay('2026-10-10'), pay('2026-10-12')] });
  const blob = JSON.stringify(s.row('2026-10-10')) + JSON.stringify(s.row('2026-10-12'));
  ok(!/lmLinkedAssignment|linkedSecondInCycle/.test(blob), 'no assignment field on the packet rows');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Lunch Money linked earliest-unsettled checks passed.');
