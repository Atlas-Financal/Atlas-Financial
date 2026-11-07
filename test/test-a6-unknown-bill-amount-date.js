'use strict';
/* A6 (#726): a bill with an unknown amount or an unknown date never
 * becomes $0 or a guessed date in a household figure.
 *
 * Invented plan (no household figure): as-of Wed 2026-10-14, biweekly
 * payroll 1,400 anchored Fri 2026-10-09, so This Pay Period is
 * Oct 9 - Oct 22 and Next Pay Period is Oct 23 - Nov 5. One dated bill,
 * 90 on the 12th, lands only in This Pay Period.
 *
 * Hand-derived expectations (written from the inputs, not from Atlas):
 *   baseline: this load 90, afterBills 1,400 - 90 = 1,310;
 *             next load 0, afterBills 1,400.
 *   + amount-less once bill on Oct 28 (next period): this period stays
 *     90 / 1,310; next period load and afterBills are unknown; the row is
 *     listed with a null amount; the forward walk is unavailable.
 *   + undated 80 bill: it could land in either period, so both loads and
 *     both afterBills are unknown; it is listed as undated with amount 80
 *     (never $0), and the forward walk is unavailable.
 *   + undated 80 bill whose firstDue is Nov 10 (after Nov 5): neither
 *     window can hold it, so both stay 90 / 1,310 and 0 / 1,400.
 *   + undated, amount-less bill: listed undated with a null amount.
 *
 * Also a source guard: only billNeedsDate reads a plan bill's needsDate.
 *
 * `node test/test-a6-unknown-bill-amount-date.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) { failures += 1; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  PASS  ${label}`);
};
const AS_OF = '2026-10-14';

function plan(extra) {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 2000 },
    opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: [] },
    income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
    bills: [{ id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 12, amount: 90, confidence: 'confirmed' }].concat(extra || []),
    obligations: [], commitments: [],
    budget: { categories: [] },
  };
}
function view(extra) {
  const p = plan(extra);
  const v = F.recommend(p, AS_OF, { targetBuffer: 0, debts: [] }).defaultView;
  const by = id => (v.calendarPeriods || []).find(x => x.id === id);
  return { p, v, cur: by('this-pay-period'), next: by('next-pay-period') };
}
const walkState = p => F.scheduledAmountState(p, AS_OF, '2027-01-12').status;

console.log('=== baseline (positive control) ===');
{
  const { p, cur, next } = view();
  ok(cur && cur.start === '2026-10-09' && next && next.start === '2026-10-23', 'two windows: Oct 9 and Oct 23');
  ok(cur.periodBillLoad === 90 && cur.afterBills === 1310, 'this period: load 90, after bills 1,310');
  ok(next.periodBillLoad === 0 && next.afterBills === 1400, 'next period: load 0, after bills 1,400');
  ok(walkState(p) === 'ready', 'forward walk is published');
}

console.log('=== unknown amount ===');
{
  const repair = { id: 'repair', label: 'Invented repair', frequency: 'once', date: '2026-10-28', confidence: 'estimated' };
  const { p, cur, next } = view([repair]);
  ok(cur.periodBillLoad === 90 && cur.afterBills === 1310, 'this period (does not hold it) stays 90 / 1,310');
  const row = (next.bills || []).find(r => r.id === 'repair');
  ok(row && row.date === '2026-10-28', 'the amount-less bill is listed on its date');
  ok(row && row.amount === null && row.planned === null && row.movement === null && row.remaining === null,
    'its amount, planned, movement and remaining are null, not 0');
  ok(next.periodBillLoad === null && next.afterBills === null, 'next period load and after bills are unknown');
  ok(next.totalBillsThisPeriod === null && next.remainingBills === null, 'next period bill totals are unknown');
  ok(walkState(p) === 'unavailable', 'forward walk is withheld');
}

console.log('=== unknown amount inside the opening stays settled ===');
{
  // An Oct 12 occurrence before the Oct 14 opening (no priorAsOf) is inside
  // the opening cash. A missing price must not make it outstanding.
  const view2 = amount => {
    const p = plan([{ id: 'gym', label: 'Invented gym', frequency: 'monthly', day: 12, amount, confidence: 'confirmed' }]);
    delete p.opening.priorAsOf;
    const v = F.recommend(p, AS_OF, { targetBuffer: 0, debts: [] }).defaultView;
    const cur = (v.calendarPeriods || []).find(x => x.id === 'this-pay-period');
    return { cur, row: (cur.bills || []).find(r => r.id === 'gym' && r.date === '2026-10-12') };
  };
  const known = view2(40);
  ok(known.row && known.row.status === 'PAID' && known.row.settlement === 'opening' && known.row.remaining === 0,
    'control: a priced Oct 12 occurrence is PAID inside the opening');
  const unknown = view2(undefined);
  ok(unknown.row && unknown.row.status === 'PAID' && unknown.row.settlement === 'opening' && unknown.row.remaining === 0,
    'an amount-less Oct 12 occurrence is still PAID inside the opening, not outstanding');
  ok(unknown.row && unknown.row.amount === null && unknown.row.actual === null, 'its amount stays unknown');
  ok(unknown.cur.paidBills === null, 'paid bills disclosure is unknown, not $0');
}

console.log('=== unknown date ===');
for (const [label, bill] of [
  ['once with no date', { id: 'licence', label: 'Invented licence', frequency: 'once', amount: 80, confidence: 'estimated' }],
  ['once with an invalid date', { id: 'licence', label: 'Invented licence', frequency: 'once', date: '2026-02-30', amount: 80, confidence: 'estimated' }],
  ['monthly with no day', { id: 'licence', label: 'Invented licence', frequency: 'monthly', amount: 80, confidence: 'estimated' }],
  ['yearly with only a month', { id: 'licence', label: 'Invented licence', frequency: 'yearly', month: 11, amount: 80, confidence: 'estimated' }],
  ['biweekly with no anchor', { id: 'licence', label: 'Invented licence', frequency: 'biweekly', amount: 80, confidence: 'estimated' }],
  ['authored needsDate flag', { id: 'licence', label: 'Invented licence', frequency: 'once', date: '2026-10-20', needsDate: true, amount: 80, confidence: 'estimated' }],
]) {
  const { p, v, cur, next } = view([bill]);
  ok(F.billNeedsDate(bill) === true, `${label}: billNeedsDate`);
  const u = (v.undatedBills || []).find(r => r.id === 'licence');
  ok(u && u.date === null && u.amount === 80 && u.needsDate === true, `${label}: listed undated with amount 80`);
  ok(![...(cur.bills || []), ...(next.bills || [])].some(r => r.id === 'licence'), `${label}: no guessed date in any period`);
  ok(cur.periodBillLoad === null && cur.afterBills === null && next.periodBillLoad === null && next.afterBills === null,
    `${label}: both periods' load and after bills are unknown`);
  ok(walkState(p) === 'unavailable', `${label}: forward walk is withheld`);
}

console.log('=== card-paid undated bills are classified by isCardPaidBill, not raw flags ===');
{
  // Pre-review blocker on 24b266c. data.json writes card-paid bills as
  // jointCash:false with no cardPaid flag. A dated one counts in the load
  // (main and head: next period 20 / 1,380), so an undated one cannot be $0.
  const loads = extra => { const { cur, next } = view([extra]); return [cur.periodBillLoad, cur.afterBills, next.periodBillLoad, next.afterBills]; };
  const dated = loads({ id: 'card', label: 'Invented card bill', frequency: 'monthly', day: 25, amount: 20, jointCash: false, confidence: 'estimated' });
  ok(dated[0] === 90 && dated[2] === 20 && dated[3] === 1380, 'control: a dated jointCash:false card bill counts in the next period load (20)', JSON.stringify(dated));
  for (const [label, bill] of [
    ['jointCash:false only', { id: 'card', label: 'Invented card bill', frequency: 'monthly', amount: 20, jointCash: false, confidence: 'estimated' }],
    ['cardPaid:true', { id: 'card', label: 'Invented card bill', frequency: 'monthly', amount: 20, jointCash: false, cardPaid: true, confidence: 'estimated' }],
  ]) {
    const r = loads(bill);
    ok(r.every(v => v === null), `undated card-paid (${label}): both loads and after bills are unknown`, JSON.stringify(r));
  }
  const outside = loads({ id: 'card', label: 'Invented non-household', frequency: 'monthly', amount: 20, householdObligation: false, confidence: 'estimated' });
  ok(outside[0] === 90 && outside[1] === 1310 && outside[2] === 0 && outside[3] === 1400,
    'undated non-household bill stays excluded: 90 / 1,310 and 0 / 1,400', JSON.stringify(outside));
  const amountless = loads({ id: 'card', label: 'Invented card bill', frequency: 'monthly', day: 25, jointCash: false, confidence: 'estimated' });
  ok(amountless[0] === 90 && amountless[2] === null && amountless[3] === null,
    'dated amount-less jointCash:false card bill leaves only its period unknown', JSON.stringify(amountless));
}

console.log('=== unknown date bounded by firstDue ===');
{
  const bill = { id: 'licence', label: 'Invented licence', frequency: 'once', amount: 80, firstDue: '2026-11-10', confidence: 'estimated' };
  const { cur, next } = view([bill]);
  ok(cur.periodBillLoad === 90 && cur.afterBills === 1310 && next.periodBillLoad === 0 && next.afterBills === 1400,
    'windows ending before its earliest possible date stay precise');
}

console.log('=== unknown date and amount ===');
{
  const { v } = view([{ id: 'both', label: 'Invented both', frequency: 'once', confidence: 'estimated' }]);
  const u = (v.undatedBills || []).find(r => r.id === 'both');
  ok(u && u.amount === null && u.planned === null && u.movement === null, 'undated amount-less bill keeps a null amount');
}

console.log('=== budget breakdown: an undated bill is not $0 in its category ===');
{
  const mk = extra => ({ windowDays: 91, commitments: [],
    bills: [Object.assign({ id: 'net', label: 'Invented net', frequency: 'monthly', amount: 80, budgetCategory: 'phones' }, extra)],
    budget: { basis: 'ytd', categories: [{ id: 'phones', label: 'Phones', class: 'essential', from: ['Phones'], plannedMonthly: null, currentMonthly: 100 }] } });
  const periods = { periods: { ytd: { label: 'YTD', months: 4, spending: [{ label: 'Phones', total: 800 }] } } };
  const dated = F.budgetBreakdown(mk({ day: 5 }), periods, {}).categories[0];
  const undated = F.budgetBreakdown(mk({}), periods, {}).categories[0];
  const flagged = F.budgetBreakdown(mk({ day: 5, needsDate: true }), periods, {}).categories[0];
  ok(dated.dated === 80 && dated.gross === 180, 'control: dated 80, gross 100 + 80 = 180');
  ok(undated.dated === null && undated.gross === null, 'monthly bill with no day: dated and gross unknown, not 100');
  ok(flagged.dated === null && flagged.gross === null, 'flagged needsDate bill: dated and gross unknown, not 100');
}

console.log('=== Bills account period-end balance: an undated Bills bill is unknown ===');
{
  const fx = require('./fixtures/bills-period-end-balance-data');
  const control = fx.requirementsFixture();
  const known = F.billsAccountPeriodBalance(control.plan, control.asOf, control.opts);
  ok(known.status === 'ready' && typeof known.amount === 'number', 'control: the dated fixture publishes a number');
  const undated = fx.requirementsFixture();
  undated.plan.bills.push({ id: 'undated-a6', label: 'Invented undated', frequency: 'once', amount: 17.23,
    confidence: 'confirmed', payingAccount: 'chequing-a' });
  const r = F.billsAccountPeriodBalance(undated.plan, undated.asOf, undated.opts);
  ok(r.status === 'unavailable' && r.amount === null, 'an undated Bills-paid bill withholds the period-end balance');
}

console.log('=== dated bills are not undated ===');
for (const bill of [
  { frequency: 'once', date: '2026-10-20' }, { frequency: 'monthly', day: 12 }, { frequency: 'monthly', day: '12' },
  { frequency: 'quarterly', day: 5, anchor: '2026-01-05' }, { frequency: 'yearly', month: 3, day: 1 },
  { frequency: 'biweekly', anchor: '2026-10-09' },
]) ok(F.billNeedsDate(bill) === false, `dated ${bill.frequency} is not undated`);

console.log('=== malformed and dual-unknown dates never reach the date expanders ===');
{
  // Atlas findings on f264c4c. Each case runs in a child process with a
  // timeout, so a hang regression fails fast instead of hanging CI.
  const { spawnSync } = require('child_process');
  const probe = bill => {
    const script = `
      const F = require(${JSON.stringify(path.join(__dirname, '..', 'public', 'forecast.js'))});
      const plan = ${JSON.stringify(plan([bill]))};
      const v = F.recommend(plan, '${AS_OF}', { targetBuffer: 0, debts: [] }).defaultView;
      const p = id => v.calendarPeriods.find(x => x.id === id);
      const u = (v.undatedBills || []).find(r => r.id === ${JSON.stringify(bill.id)});
      process.stdout.write(JSON.stringify({ undated: F.billNeedsDate(plan.bills[1]),
        row: u ? { date: u.date, amount: u.amount } : null,
        loads: ['this-pay-period', 'next-pay-period'].map(id => [p(id).periodBillLoad, p(id).afterBills]),
        walk: F.scheduledAmountState(plan, '${AS_OF}', '2027-01-12').status }));`;
    const r = spawnSync(process.execPath, ['-e', script], { timeout: 15000, encoding: 'utf8' });
    if (r.error || r.signal || r.status !== 0) return { failed: r.signal || (r.error && r.error.code) || ('exit ' + r.status), stderr: String(r.stderr).split('\n')[0] };
    return JSON.parse(r.stdout);
  };
  const allUnknown = r => !r.failed && r.undated === true && r.row && r.row.date === null
    && r.loads.every(([load, after]) => load === null && after === null) && r.walk === 'unavailable';
  for (const [label, bill, amount] of [
    ['biweekly with neither amount nor anchor', { id: 'both', label: 'Invented both', frequency: 'biweekly', confidence: 'estimated' }, null],
    ['biweekly with no amount and a malformed anchor', { id: 'both', label: 'Invented both', frequency: 'biweekly', anchor: 'not-a-date', confidence: 'estimated' }, null],
    ['biweekly with no amount and an impossible anchor', { id: 'both', label: 'Invented both', frequency: 'biweekly', anchor: '2026-02-30', confidence: 'estimated' }, null],
    ['quarterly with a malformed anchor and a valid firstDue', { id: 'q', label: 'Invented quarterly', frequency: 'quarterly', day: 5, anchor: 'not-a-date', firstDue: '2026-10-05', amount: 80, confidence: 'estimated' }, 80],
  ]) {
    const r = probe(bill);
    ok(allUnknown(r) && r.row.amount === amount,
      `${label}: no throw or hang; listed undated (amount ${amount === null ? 'null' : amount}); loads, after bills and walk unknown`, JSON.stringify(r));
  }
  const control = { id: 'q', label: 'Invented quarterly', frequency: 'quarterly', day: 20, firstDue: '2026-10-20', amount: 80, confidence: 'estimated' };
  const c = probe(control);
  ok(!c.failed && c.undated === false && c.row === null && c.loads[0][0] === 170 && c.loads[0][1] === 1230,
    'control: a firstDue-only quarterly bill stays dated (this period 90 + 80 = 170 / 1,230)', JSON.stringify(c));
}

console.log('=== every plan-bill date-expander call site is behind the date authority ===');
{
  // A call to outflowDates/occurrences on a plan bill (b / bill) must have
  // billNeedsDate in its guard (within the 25 lines above it), or sit only in
  // the true branch of billHasAmountSchedule (false for every undated bill).
  // The schedule-only sites are named by enclosing function and each is
  // checked for that schedule guard, so a new unguarded site fails here.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8').split('\n');
  const SCHEDULE_ONLY = {
    billScheduleBlocksNormalization: /if \(!billHasAmountSchedule\(bill\)\) return false;/,
    firstEligibleYearlyCardPaidOccurrence: /if \(billHasAmountSchedule\(bill\)\) \{/,
    savingsDailyFunding: /billHasAmountSchedule\(b\)\s*$/,
  };
  const enclosing = (lines, i) => { for (let j = i; j >= 0; j--) { const m = /^  function ([A-Za-z0-9_]+)\(/.exec(lines[j]); if (m) return m[1]; } return null; };
  const window = (lines, i, span = 25) => lines.slice(Math.max(0, i - span), i + 1);
  const guarded = (lines, i) => window(lines, i).some(l => /billNeedsDate\(/.test(l))
    || (SCHEDULE_ONLY[enclosing(lines, i)] && window(lines, i, 12).some(l => SCHEDULE_ONLY[enclosing(lines, i)].test(l)));
  const sites = lines => lines.map((l, i) => [l, i])
    .filter(([l]) => /\b(?:outflowDates|occurrences)\((?:b|bill)\s*,/.test(l));
  const found = sites(src);
  const unguarded = found.filter(([, i]) => !guarded(src, i)).map(([, i]) => 'forecast.js:' + (i + 1));
  ok(found.length >= 12, `the guard sees the plan-bill expander call sites (${found.length})`);
  ok(unguarded.length === 0, 'every plan-bill expander call site is behind billNeedsDate or a billHasAmountSchedule true branch', unguarded.join(', '));
  // Negative controls: the checker rejects an unguarded call, and a schedule
  // guard does not excuse a call outside the three named functions.
  const bad = ['  function anyNewConsumer(plan) {', '    for (const b of plan.bills || []) {', '      for (const date of outflowDates(b, start, end)) {'];
  ok(sites(bad).length === 1 && !guarded(bad, 2), 'negative control: an unguarded call site is detected');
  const scheduleOnly = ['  function anyNewConsumer(plan) {', '    if (billHasAmountSchedule(b)) {', '      for (const date of outflowDates(b, start, end)) {'];
  ok(!guarded(scheduleOnly, 2), 'negative control: a schedule guard outside the named functions is not accepted');
}

console.log('=== one authority for the date state ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  const start = src.indexOf('function billNeedsDate(bill)');
  const end = src.indexOf('\n  }\n', start);
  const outside = (src.slice(0, start) + src.slice(end)).match(/\b(?:b|bill|item)\.needsDate\b/g) || [];
  ok(start > 0 && outside.length === 0, 'no plan-bill needsDate read outside billNeedsDate', outside.join(', '));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall A6 checks passed');
