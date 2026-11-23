'use strict';
/* Dated obligation amounts: plan.obligations[].amountSchedule.
 *
 * Desk ruling: reuse the bill interval contract (one validator, real dates,
 * bounded size, non-overlap, inclusive `from`, exclusive `until`). The row's
 * amount / cashPayment stay the regular values outside every term. The
 * ORIGINAL scheduled date selects the term; the cash minimum of a
 * capitalising row takes the term of the CYCLE it pays. A malformed schedule
 * fails closed (unknown, never the regular fallback).
 *
 * Every figure is invented and hand-calculated in the comments below,
 * through the published path (Forecast.expandEvents, scheduledAmountState,
 * planPhases). No household value is used. The savings operating-answer
 * scan (obligationAmountEvidenceUnavailable) sits behind a full live packet
 * and is not reached from this synthetic fixture.
 *
 * `node test/test-obligation-amount-schedule.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const show = x => JSON.stringify(x);
const clone = x => JSON.parse(JSON.stringify(x));

const START = '2027-02-01';
const END = '2027-07-31';

function plan(obligations) {
  return {
    windowDays: 60,
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 9000 }, { id: 'chequing-b', value: 0 }] },
    opening: { asOf: START },
    budget: { basis: 'ytd', categories: [] },
    income: [], bills: [], obligations, commitments: [],
  };
}
const loan = extra => Object.assign({ id: 'loan', debtId: 'loan', effect: 'payment', label: 'Invented loan',
  frequency: 'monthly', day: 10, amount: 100, confidence: 'confirmed', payingAccount: 'chequing-a' }, extra || {});
const line = extra => Object.assign({ id: 'line', debtId: 'line', effect: 'capitalise', label: 'Invented line interest',
  frequency: 'monthly', day: 28, amount: 80, confidence: 'confirmed', nonCash: true, payingAccount: 'chequing-a',
  cashPayment: 60, cashDay: 15, cashLabel: 'Invented line minimum', cashConfidence: 'confirmed' }, extra || {});

const events = (p, kind, id, start, end) => F.expandEvents(p, start || START, end || END, {})
  .filter(e => e.kind === kind && e.id === id && !e.cashMinimum === (kind !== 'cash'));
const cashEvents = (p, id, start, end) => F.expandEvents(p, start || START, end || END, {})
  .filter(e => e.kind === 'obligation' && e.id === id && e.cashMinimum === true);
const byDate = list => Object.fromEntries(list.map(e => [e.date, -e.amount]));
const unknownDates = (p, id, start, end) => F.scheduledAmountState(p, start || START, end || END, {}).unknowns
  .filter(u => u.carrier === 'obligation' && u.id === id).map(u => u.date);

console.log('=== 1. bounded term: before / on from / inside / on until / after, then regular ===');
{
  // Monthly day 10, regular 100 confirmed. Term [2027-03-10, 2027-05-10) at 150 estimated.
  // Feb 10 100 (before), Mar 10 150 (on from), Apr 10 150 (inside), May 10 100 (on until,
  // exclusive), Jun 10 100, Jul 10 100 (after: regular again with no data edit).
  const p = plan([loan({ amountSchedule: [{ from: '2027-03-10', until: '2027-05-10', amount: 150, confidence: 'estimated' }] })]);
  const ev = events(p, 'obligation', 'loan');
  ok(show(byDate(ev)) === show({ '2027-02-10': 100, '2027-03-10': 150, '2027-04-10': 150,
    '2027-05-10': 100, '2027-06-10': 100, '2027-07-10': 100 }), 'amounts follow the term exactly', show(byDate(ev)));
  ok(show(ev.map(e => e.confidence)) === show(['confirmed', 'estimated', 'estimated', 'confirmed', 'confirmed', 'confirmed']),
    'an estimated term lowers only its own occurrences', show(ev.map(e => e.confidence)));
  ok(unknownDates(p, 'loan').length === 0, 'no unknowns');
  // A confirmed term on an estimated row never raises the occurrence.
  const q = plan([loan({ confidence: 'estimated', amountSchedule: [{ from: '2027-03-10', until: '2027-04-10', amount: 150, confidence: 'confirmed' }] })]);
  ok(events(q, 'obligation', 'loan').every(e => e.confidence === 'estimated'), 'a confirmed term never promotes an estimated row');
  // The selector is keyed on the date it is given; asOf plays no part.
  const later = F.expandEvents(p, '2027-04-01', '2027-04-30', {}).filter(e => e.id === 'loan');
  ok(later.length === 1 && -later[0].amount === 150, 'a later start (asOf) does not move the selection', show(later));
}

console.log('\n=== 2. one cent, explicit zero, unknown term amounts ===');
{
  const t = amount => plan([loan({ amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount }] })]);
  const cent = byDate(events(t(0.01), 'obligation', 'loan'));
  ok(cent['2027-03-10'] === 0.01 && cent['2027-04-10'] === 100, 'one cent is one cent', show(cent));
  const zero = t(0);
  ok(!('2027-03-10' in byDate(events(zero, 'obligation', 'loan'))) && unknownDates(zero, 'loan').length === 0,
    'explicit zero: no payment that month, and it is known (not unknown)');
  const unk = t(null);
  ok(!('2027-03-10' in byDate(events(unk, 'obligation', 'loan'))), 'unknown term: no invented payment');
  ok(show(unknownDates(unk, 'loan')) === show(['2027-03-10']), 'unknown term: exactly that occurrence is unknown',
    show(unknownDates(unk, 'loan')));
  ok(byDate(events(unk, 'obligation', 'loan'))['2027-04-10'] === 100, 'other occurrences keep the regular amount');
}

console.log('\n=== 3. malformed schedules fail closed, never the regular fallback ===');
{
  const cases = {
    'impossible date': loan({ amountSchedule: [{ from: '2027-02-30', until: '2027-04-01', amount: 150 }] }),
    'from not before until': loan({ amountSchedule: [{ from: '2027-04-01', until: '2027-04-01', amount: 150 }] }),
    'overlap': loan({ amountSchedule: [{ from: '2027-03-01', until: '2027-05-01', amount: 150 },
      { from: '2027-04-01', until: '2027-06-01', amount: 120 }] }),
    'unknown key': loan({ amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount: 150, note: 'x' }] }),
    'missing amount': loan({ amountSchedule: [{ from: '2027-03-01', until: '2027-04-01' }] }),
    'bad confidence': loan({ amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount: 150, confidence: 'verified' }] }),
    'empty': loan({ amountSchedule: [] }),
    'too many terms': loan({ amountSchedule: Array.from({ length: 25 }, (_, i) => ({
      from: `2030-${String((i % 12) + 1).padStart(2, '0')}-01`.replace('2030', String(2030 + Math.floor(i / 12))),
      until: `2030-${String((i % 12) + 1).padStart(2, '0')}-02`.replace('2030', String(2030 + Math.floor(i / 12))), amount: 1 })) }),
    'fixedInterestMinimum combined': loan({ fixedInterestMinimum: { balance: 1200, rate: 12, asOf: '2027-01-01' },
      amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount: 150 }] }),
  };
  for (const [name, row] of Object.entries(cases)) {
    const p = plan([row]);
    const ev = events(p, 'obligation', 'loan');
    const unk = unknownDates(p, 'loan');
    ok(ev.length === 0 && unk.length === 6, `${name}: every occurrence unknown, no regular fallback`, show({ ev: ev.length, unk }));
  }
  // A once row: the schedule is not defined there.
  const once = plan([loan({ frequency: 'once', date: '2027-03-10', day: undefined,
    amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount: 150 }] })]);
  ok(events(once, 'obligation', 'loan').length === 0 && show(unknownDates(once, 'loan')) === show(['2027-03-10']),
    'once row: unknown, not 100 and not 150');
  F.obligationAmountScheduleSelect(loan(), '2027-03-10').regular === true
    ? ok(true, 'no schedule selects regular') : ok(false, 'no schedule selects regular');
}

console.log('\n=== 4. capitalising row: interest and cash minimum resolved independently ===');
{
  // Capitalise day 28 regular 80; cash day 15 regular 60. Term [2027-03-01, 2027-05-01):
  // interest 120, cash 90. Capitalise: Feb 28 80, Mar 28 120, Apr 28 120, May 28 80, Jun 28 80, Jul 28 80.
  // Cash pays the cycle before it: Feb 15 (cycle Jan 28) 60; Mar 15 (cycle Feb 28, BEFORE from,
  // although the cash date is after from) 60; Apr 15 (cycle Mar 28) 90; May 15 (cycle Apr 28, the
  // cash date is after until) 90; Jun 15 (cycle May 28) 60; Jul 15 60.
  const term = extra => plan([line({ amountSchedule: [Object.assign({ from: '2027-03-01', until: '2027-05-01', amount: 120 }, extra)] })]);
  const p = term({ cashPayment: 90 });
  ok(show(byDate(events(p, 'noncash', 'line'))) === show({ '2027-02-28': 80, '2027-03-28': 120, '2027-04-28': 120,
    '2027-05-28': 80, '2027-06-28': 80, '2027-07-28': 80 }), 'capitalised interest follows the term', show(byDate(events(p, 'noncash', 'line'))));
  ok(show(byDate(cashEvents(p, 'line'))) === show({ '2027-02-15': 60, '2027-03-15': 60, '2027-04-15': 90,
    '2027-05-15': 90, '2027-06-15': 60, '2027-07-15': 60 }), 'cash minimum follows the cycle it pays (Mar 15 keeps the OLD 60)',
  show(byDate(cashEvents(p, 'line'))));
  ok(show(Object.fromEntries(F.capitalisingCashMinimumOccurrences(p.obligations[0], START, END).map(o => [o.date, o.amount])))
    === show(byDate(cashEvents(p, 'line'))),
  'the Plan / Credit cash list is the same rule');
  const omitted = term({});
  ok(Object.values(byDate(cashEvents(omitted, 'line'))).every(a => a === 60)
    && byDate(events(omitted, 'noncash', 'line'))['2027-04-28'] === 120, 'omitted cashPayment inherits the regular 60; interest still 120');
  const zero = term({ cashPayment: 0 });
  ok(show(Object.keys(byDate(cashEvents(zero, 'line')))) === show(['2027-02-15', '2027-03-15', '2027-06-15', '2027-07-15'])
    && unknownDates(zero, 'line').length === 0, 'explicit zero cash: no payment on Apr 15 / May 15, and known');
  const unk = term({ cashPayment: null });
  ok(!('2027-04-15' in byDate(cashEvents(unk, 'line'))) && show(unknownDates(unk, 'line')) === show(['2027-04-15', '2027-05-15']),
    'unknown cash: those cash dates unknown, interest unaffected', show(unknownDates(unk, 'line')));
  // Regular cash 0, cash only inside the term.
  const only = plan([line({ cashPayment: 0, amountSchedule: [{ from: '2027-03-01', until: '2027-05-01', amount: 120, cashPayment: 90 }] })]);
  ok(show(byDate(cashEvents(only, 'line'))) === show({ '2027-04-15': 90, '2027-05-15': 90 }), 'a term cash minimum on a zero-regular row');
  const bad = plan([line({ amountSchedule: [{ from: '2027-03-01', until: '2027-02-01', amount: 120, cashPayment: 90 }] })]);
  ok(cashEvents(bad, 'line').length === 0 && events(bad, 'noncash', 'line').length === 0
    && unknownDates(bad, 'line').length > 0, 'invalid schedule: no interest, no cash, named unknown');
}

console.log('\n=== 5. statement precedence and original occurrence identity ===');
{
  // Card row day 28 regular 40. Feb 28 has a statement moved to Mar 2 at minimum 55.
  // Term [2027-03-01, 2027-04-01) amount null (unknown). The original date (Feb 28) is
  // before the term: selection by the moved date would wrongly land inside it.
  const card = extra => loan(Object.assign({ id: 'card', debtId: 'card', day: 28, amount: 40,
    statementOccurrences: [{ scheduledDate: '2027-02-28', dueDate: '2027-03-02', minimum: 55, currency: 'cad', confidence: 'confirmed' }] }, extra));
  ok(F.obligationAmountScheduleSelect(card({ amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount: 70 }] }), '2027-02-28').regular === true,
    'the selector reads the ORIGINAL date (Feb 28 is outside the term)');
  const p = plan([card({ amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount: null }] })]);
  const ev = byDate(events(p, 'obligation', 'card'));
  ok(ev['2027-03-02'] === 55 && !('2027-02-28' in ev), 'the moved occurrence keeps its statement minimum', show(ev));
  ok(show(unknownDates(p, 'card')) === show(['2027-03-28']), 'only the Mar 28 occurrence (inside the term) is unknown',
    show(unknownDates(p, 'card')));
  // A statement inside a term still replaces the term amount.
  const inside = plan([card({ statementOccurrences: [{ scheduledDate: '2027-03-28', dueDate: '2027-03-30', minimum: 33.33, currency: 'cad', confidence: 'confirmed' }],
    amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount: 70, confidence: 'estimated' }] })]);
  const ie = events(inside, 'obligation', 'card').find(e => e.date === '2027-03-30');
  ok(ie && -ie.amount === 33.33 && ie.confidence === 'confirmed', 'statement minimum wins inside a term', show(ie));
  // A moved due date that lands inside a term while its original is outside keeps the regular row
  // confidence (not the estimated term's): term [Mar 1, Apr 1) estimated; Feb 28 moved to Mar 2.
  const est = plan([card({ confidence: 'estimated', statementOccurrences: undefined,
    amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount: 70 }] })]);
  ok(byDate(events(est, 'obligation', 'card'))['2027-02-28'] === 40, 'Feb 28 (no statement) is regular 40');
}

console.log('\n=== 6. represented events still win inside a term ===');
{
  // Unknown term on Feb 10; opening on Feb 15 with Feb 10 represented: not unknown.
  const row = loan({ amountSchedule: [{ from: '2027-02-01', until: '2027-03-01', amount: null }] });
  const p = plan([row]);
  p.opening = { asOf: '2027-02-15', representedEvents: [{ id: 'loan', date: '2027-02-10' }] };
  const unk = F.scheduledAmountState(p, '2027-02-15', '2027-04-30', {}).unknowns.filter(u => u.id === 'loan');
  ok(unk.length === 0, 'a represented occurrence inside an unknown term is not unknown', show(unk));
}

console.log('\n=== 7. HELOC risk names the resolved cycle amount ===');
{
  // Line limit 1000, balance 950; capitalised interest Feb 28 crosses the limit.
  const debts = [{ id: 'heloc', label: 'Invented line', balance: 950, pending: 0, rate: 0, secured: true, limit: 1000 }];
  const helocRow = extra => line(Object.assign({ id: 'heloc', debtId: 'heloc', cashPayment: 0 }, extra));
  const risk = p => {
    const proj = F.projectDebts(p, debts, START, {});
    const advice = F.recommend(p, START, {});
    return (F.planPhases(p, advice, proj, { sim: advice.sim }).risks || []).find(r => r.id === 'helocDrawn' || r.id === 'helocNoDraw');
  };
  const regular = risk(plan([helocRow()]));
  ok(regular && regular.monthlyInterest === 80, 'regular row: 80 (incumbent)', show(regular && regular.monthlyInterest));
  const termed = risk(plan([helocRow({ amountSchedule: [{ from: '2027-02-01', until: '2027-03-01', amount: 95 }] })]));
  ok(termed && termed.monthlyInterest === 95, 'the cycle named (Feb 28) takes its term amount 95', show(termed && termed.monthlyInterest));
}

console.log('\n=== 7b. a posted sent payment still wins inside a term ===');
{
  // Card day 14, regular 40. A confirmed, posted minimum-intent debit of 25 on Feb 12.
  const now = '2027-02-12';
  const sentPlan = amount => {
    const p = plan([loan({ id: 'card', debtId: 'card', day: 14, amount: 40,
      amountSchedule: [{ from: '2027-02-01', until: '2027-03-01', amount }],
      sentPayments: [{ scheduledDate: '2027-02-14', confirmed: true, intent: 'minimum', debitId: 'invented-debit',
        postedOn: now, amount: 25, currency: 'cad', fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: now }] })]);
    p.opening = { asOf: now };
    return F.expandEvents(p, now, '2027-03-31', {}).filter(e => e.id === 'card');
  };
  const known = sentPlan(25);
  ok(known[0].date === '2027-02-14' && known[0].amount === 0 && known[0].minimumAmount === 25
    && known[0].minimumPayment.householdPaymentStatus === 'paid' && -known[1].amount === 40,
  'term 25 met by the posted 25: paid, cash already moved; Mar 14 back to regular 40', show(known.map(e => [e.date, e.amount])));
  const unknown = sentPlan(null);
  ok(unknown[0].amount === 0 && unknown[0].minimumPayment.householdPaymentStatus === 'sent',
    'unknown term: the posted payment records money sent, never paid against an unknown minimum',
    show(unknown[0].minimumPayment && unknown[0].minimumPayment.householdPaymentStatus));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
