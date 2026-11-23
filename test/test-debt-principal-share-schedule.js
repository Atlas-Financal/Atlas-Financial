'use strict';
/* Dated principal share: debts[].principalShareSchedule on an interestByEvent
 * (amortising, blended-payment) debt.
 *
 * Contract: terms { from, until, principalShare, confidence? } use the shared
 * interval validator (inclusive `from`, exclusive `until`, real dates,
 * non-overlap, 1..24 terms). The PAYMENT EVENT's date selects the term;
 * outside every term the regular `principalShare` applies. A malformed
 * schedule, a share outside [0, 1] or not a finite number, or a schedule on
 * a debt that is not interestByEvent fails closed: that debt's published
 * balance / paid / interest marks from the payment date, its byId figures
 * and the walk's unabsorbed total are WITHHELD (null), never computed with
 * the regular share. An estimated term lowers the walk's trust.
 *
 * Every figure is invented and hand-calculated, read through the published
 * Forecast.projectDebts output. No household value is used.
 *
 * `node test/test-debt-principal-share-schedule.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const show = x => JSON.stringify(x);

// Window 91 days from 2027-02-01 (end 2027-05-02). Marks: day 0 Feb 01,
// day 30 Mar 02, day 60 Apr 01, day 90 May 01, day 91 May 02.
// Invented mortgage: balance 10000, regular principalShare 0.4. Payment
// 1000 monthly on day 10 -> Feb 10, Mar 10, Apr 10. Regular: principal 400,
// interest 600 per payment.
const START = '2027-02-01';
function setup(schedule, debtExtra, rowExtra) {
  const debt = Object.assign({ id: 'mortgage', label: 'Invented mortgage', balance: 10000, pending: 0, rate: 5,
    secured: true, interestByEvent: true, principalShare: 0.4, confidence: 'confirmed' }, debtExtra || {});
  if (schedule !== undefined) debt.principalShareSchedule = schedule;
  const plan = { windowDays: 91, defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 9000 }, { id: 'chequing-b', value: 0 }] },
    opening: { asOf: START }, budget: { basis: 'ytd', categories: [] }, income: [], bills: [], commitments: [],
    obligations: [Object.assign({ id: 'mortgage-pay', debtId: 'mortgage', effect: 'payment',
      label: 'Invented mortgage payment', frequency: 'monthly', day: 10, amount: 1000, confidence: 'confirmed',
      payingAccount: 'chequing-a' }, rowExtra || {})] };
  return { plan, debts: [debt] };
}
function walk(schedule, debtExtra, rowExtra, asOf) {
  const { plan, debts } = setup(schedule, debtExtra, rowExtra);
  if (asOf) plan.opening = { asOf };
  return F.projectDebts(plan, debts, asOf || START, {});
}
const balances = r => r.marks.map(m => m.debts[0].balance);
const interests = r => r.marks.map(m => m.debts[0].interest);
const near = (a, b) => a.length === b.length && a.every((x, i) => (x == null && b[i] == null)
  || (x != null && b[i] != null && Math.abs(x - b[i]) < 1e-9));

console.log('=== 1. no schedule: the incumbent split ===');
{
  const r = walk(undefined);
  // 10000 -> Feb 10 9600 -> Mar 10 9200 -> Apr 10 8800.
  ok(near(balances(r), [10000, 9600, 9200, 8800, 8800]), 'regular 0.4 every payment', show(balances(r)));
  ok(near(interests(r), [0, 600, 1200, 1800, 1800]), 'interest share 600 each', show(interests(r)));
  ok(r.unabsorbed === 0 && r.trust === undefined && r.principalShareUnknownFrom === undefined, 'nothing withheld, no new fields');
}

console.log('\n=== 2. before / on from / inside / on until / after a term ===');
{
  // Term [Mar 10, Apr 10) share 0.7: Feb 10 before (400), Mar 10 on from (700,
  // interest 300), Apr 10 on until -> regular (400). 10000 -> 9600 -> 8900 -> 8500.
  const r = walk([{ from: '2027-03-10', until: '2027-04-10', principalShare: 0.7 }]);
  ok(near(balances(r), [10000, 9600, 8900, 8500, 8500]), 'on from takes the term; on until is regular', show(balances(r)));
  ok(near(interests(r), [0, 600, 900, 1500, 1500]), 'interest 600 / 300 / 600', show(interests(r)));
  // Inside: term [Mar 01, Mar 31) share 0.7 covers only Mar 10 -> same 8500.
  const inside = walk([{ from: '2027-03-01', until: '2027-03-31', principalShare: 0.7 }]);
  ok(near(balances(inside), [10000, 9600, 8900, 8500, 8500]), 'inside a term', show(balances(inside)));
  // Before: term [Jan 01, Feb 10) ends ON Feb 10 (exclusive) -> all regular 8800.
  const before = walk([{ from: '2027-01-01', until: '2027-02-10', principalShare: 0.9 }]);
  ok(near(balances(before), [10000, 9600, 9200, 8800, 8800]), 'a term ending on the payment date does not apply', show(balances(before)));
  // After: term [Apr 11, Jun 01) starts after the last payment -> all regular.
  const after = walk([{ from: '2027-04-11', until: '2027-06-01', principalShare: 0.9 }]);
  ok(near(balances(after), [10000, 9600, 9200, 8800, 8800]), 'payments before a later term stay regular', show(balances(after)));
  // Payment date, not asOf: term [Feb 01, Feb 05) share 1 contains asOf but no payment -> all regular.
  const asOfTerm = walk([{ from: '2027-02-01', until: '2027-02-05', principalShare: 1 }]);
  ok(near(balances(asOfTerm), [10000, 9600, 9200, 8800, 8800]), 'a term containing only asOf selects nothing', show(balances(asOfTerm)));
}

console.log('\n=== 3. share 0 and share 1 edges ===');
{
  // Mar term share 0: Mar 10 is all interest (balance unchanged): 9600, 9600, 9200; interest 600, 1600, 2200.
  const zero = walk([{ from: '2027-03-01', until: '2027-04-01', principalShare: 0 }]);
  ok(near(balances(zero), [10000, 9600, 9600, 9200, 9200]), 'share 0: no principal', show(balances(zero)));
  ok(near(interests(zero), [0, 600, 1600, 2200, 2200]), 'share 0: the whole payment is interest', show(interests(zero)));
  // Share 1: Mar 10 all principal: 9600, 8600, 8200; interest 600, 600, 1200.
  const one = walk([{ from: '2027-03-01', until: '2027-04-01', principalShare: 1 }]);
  ok(near(balances(one), [10000, 9600, 8600, 8200, 8200]), 'share 1: all principal', show(balances(one)));
  ok(near(interests(one), [0, 600, 600, 1200, 1200]), 'share 1: no interest', show(interests(one)));
}

console.log('\n=== 4. fail closed: dependent published outputs withheld ===');
{
  const t = extra => Object.assign({ from: '2027-03-01', until: '2027-04-01', principalShare: 0.7 }, extra);
  const cases = [
    ['bad date', [t({ from: '2027-02-30' })]],
    ['from not before until', [t({ until: '2027-03-01' })]],
    ['overlap', [t(), t({ from: '2027-03-15', until: '2027-04-15' })]],
    ['unknown key', [t({ amount: 5 })]],
    ['missing share key', [{ from: '2027-03-01', until: '2027-04-01' }]],
    ['empty schedule', []],
    ['not an array', { from: '2027-03-01' }],
    ['share 1.5', [t({ principalShare: 1.5 })]],
    ['share -0.1', [t({ principalShare: -0.1 })]],
    ['share string', [t({ principalShare: '0.7' })]],
    ['share NaN', [t({ principalShare: NaN })]],
    ['bad confidence', [t({ confidence: 'verified' })]],
  ];
  for (const [name, sched] of cases) {
    const r = walk(sched);
    // Malformed fails at the first payment (Feb 10); a bad share inside a
    // valid March term fails from Mar 10. Day 0 stays known either way.
    const from = /^share/.test(name) ? '2027-03-10' : '2027-02-10';
    const withheld = from === '2027-02-10' ? [10000, null, null, null, null] : [10000, 9600, null, null, null];
    ok(near(balances(r), withheld), `${name}: balance marks withheld from ${from}`, show(balances(r)));
    const late = r.marks.filter(m => m.date >= from);
    ok(late.every(m => m.secured === null && m.interestToDate === null && m.debts[0].paid === null
      && m.debts[0].interest === null), `${name}: secured total, interest and paid withheld`);
    ok(r.byId.mortgage.balance === null && r.byId.mortgage.interest === null && r.byId.mortgage.paid === null,
      `${name}: byId balance / interest / paid withheld`, show(r.byId.mortgage.balance));
    ok(r.unabsorbed === null, `${name}: unabsorbed not certified`, show(r.unabsorbed));
    ok(r.principalShareUnknownFrom && r.principalShareUnknownFrom.mortgage === from, `${name}: named from ${from}`,
      show(r.principalShareUnknownFrom));
  }
  // A schedule on a debt that is not interestByEvent fails closed too.
  const r = walk([t()], { interestByEvent: false });
  ok(r.marks[0].debts[0].balance === 10000 && r.marks.slice(1).every(m => m.debts[0].balance === null),
    'not interestByEvent: withheld from the first payment', show(balances(r)));
  ok(r.byId.mortgage.balance === null && r.unabsorbed === null, 'not interestByEvent: byId and unabsorbed withheld');
}

console.log('\n=== 5. an estimated term lowers trust; never promotes ===');
{
  const est = walk([{ from: '2027-03-01', until: '2027-04-01', principalShare: 0.7, confidence: 'estimated' }]);
  ok(est.trust === 'estimated' && show(est.principalShareEstimated) === show(['mortgage']), 'estimated term: walk trust estimated',
    show([est.trust, est.principalShareEstimated]));
  ok(near(balances(est), [10000, 9600, 8900, 8500, 8500]), 'estimated term still computes its split', show(balances(est)));
  const conf = walk([{ from: '2027-03-01', until: '2027-04-01', principalShare: 0.7, confidence: 'confirmed' }]);
  ok(conf.trust === undefined, 'confirmed term adds no trust claim', show(conf.trust));
  // An estimated term no payment selects lowers nothing.
  const unused = walk([{ from: '2027-06-01', until: '2027-07-01', principalShare: 0.7, confidence: 'estimated' }]);
  ok(unused.trust === undefined, 'unselected estimated term lowers nothing');
}

console.log('\n=== 6. a posted sent mortgage payment still settles as before ===');
{
  // Feb 10 payment sent and posted Feb 08 (confirmed, minimum intent). The
  // sent branch records the occurrence and moves no balance; a schedule
  // (valid or malformed) must not change that, because no split is applied.
  const now = '2027-02-08';
  const sent = { sentPayments: [{ scheduledDate: '2027-02-10', confirmed: true, intent: 'minimum', debitId: 'invented-debit',
    postedOn: now, amount: 1000, currency: 'cad', fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: now }] };
  const base = walk(undefined, null, sent, now);
  const termed = walk([{ from: '2027-02-01', until: '2027-03-01', principalShare: 0.9 }], null, sent, now);
  ok(show(base.obligationAbsorbed) === show(termed.obligationAbsorbed)
    && base.marks[1].debts[0].balance === termed.marks[1].debts[0].balance,
  'a term covering the sent payment changes nothing about it', show([base.obligationAbsorbed, balances(base), balances(termed)]));
}

console.log('\n=== 7. the one resolver ===');
{
  const d = { interestByEvent: true, principalShare: 0.4,
    principalShareSchedule: [{ from: '2027-03-01', until: '2027-04-01', principalShare: 0.7 }] };
  ok(show(F.debtPrincipalShareFor(d, '2027-03-10')) === show({ share: 0.7, estimated: false }), 'term share');
  ok(show(F.debtPrincipalShareFor(d, '2027-04-01')) === show({ share: 0.4, estimated: false }), 'until is regular');
  ok(show(F.debtPrincipalShareFor({ principalShare: 0.4 }, '2027-03-10')) === show({ share: 0.4, estimated: false }), 'unscheduled');
  ok(show(F.debtPrincipalShareFor({ rate: 6 }, '2027-03-10')) === show({ share: null, estimated: false }),
    'no share is inferred from a rate');
  ok(F.debtPrincipalShareFor(Object.assign({}, d, { interestByEvent: false }), '2027-03-10').unknown === true,
    'schedule on a non-interestByEvent debt is unknown');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
