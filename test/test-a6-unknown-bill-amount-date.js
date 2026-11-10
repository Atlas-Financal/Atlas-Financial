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
  ok(known.row && known.row.status !== 'PAID' && known.row.settlement === 'opening' && known.row.remaining === 40,
    'control: a priced Oct 12 occurrence is inside the opening, still to confirm');
  const unknown = view2(undefined);
  ok(unknown.row && unknown.row.status !== 'PAID' && unknown.row.settlement === 'opening' && unknown.row.remaining === null,
    'an amount-less Oct 12 occurrence stays to confirm, its remaining unknown');
  ok(unknown.row && unknown.row.amount === null && unknown.row.actual === null, 'its amount stays unknown');
  ok(unknown.cur.paidBills === 0, 'opening inclusion alone does not disclose a paid amount');
}

console.log('=== observed future-window amount-unknown row stays unknown ===');
{
  // An Oct 28 occurrence (next window, after as-of) with an observed actual
  // is reset to not-yet-paid. The priced control's remaining is its planned
  // 50. With no amount, remaining must be null, not 0.
  const futureObserved = amount => {
    const p = plan([{ id: 'repair', label: 'Invented repair', frequency: 'once', date: '2026-10-28', amount, confidence: 'estimated' }]);
    const v = F.recommend(p, AS_OF, { targetBuffer: 0, debts: [],
      currentPeriodActuals: { representedActuals: [{ id: 'repair', date: '2026-10-28', actual: 45 }] } }).defaultView;
    const next = (v.calendarPeriods || []).find(x => x.id === 'next-pay-period');
    return { next, row: (next.bills || []).find(r => r.id === 'repair') };
  };
  const known = futureObserved(50);
  ok(known.row && known.row.status === 'planned' && known.row.remaining === 50 && known.next.remainingBills === 50,
    'control: a priced observed Oct 28 occurrence reads planned, remaining 50');
  const unknown = futureObserved(undefined);
  ok(unknown.row && unknown.row.status === 'planned' && unknown.row.amountUnknown === true,
    'an amount-less observed Oct 28 occurrence is reset to planned');
  ok(unknown.row && unknown.row.remaining === null && unknown.row.amount === null,
    'its remaining is null, not 0');
  ok(unknown.next.remainingBills === null && unknown.next.periodBillLoad === null,
    'next period remaining bills and load stay unknown');
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
  ok(cur.remainingBills === null && cur.totalBillsThisPeriod === null && next.remainingBills === null && next.totalBillsThisPeriod === null, `${label}: dated section totals cannot omit an undated requirement`);
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

console.log('=== held-elsewhere bills never enter this account\'s bill load, priced or not ===');
{
  // Disclosed: main published an amount-less held-elsewhere bill's period as
  // Unknown only because its raw-flag gate kept the bill; the priced bill
  // was already excluded on main (90 / 1,310). One rule now decides both.
  const he = extra => {
    const p = plan([Object.assign({ id: 'he', label: 'Invented other-account bill', frequency: 'once', date: '2026-10-20',
      payingAccount: 'other-acct', confidence: 'confirmed' }, extra)]);
    p.startingCash.heldElsewhere = [{ id: 'other-acct', value: 500, class: 'purpose-reserve' }];
    const cur = F.recommend(p, AS_OF, { targetBuffer: 0, debts: [] }).defaultView.calendarPeriods
      .find(x => x.id === 'this-pay-period');
    return [cur.periodBillLoad, cur.afterBills, (cur.bills || []).some(r => r.id === 'he')];
  };
  const priced = he({ amount: 50 });
  ok(priced[0] === 90 && priced[1] === 1310 && priced[2] === false, 'control: a priced held-elsewhere bill is outside the load (90 / 1,310)', JSON.stringify(priced));
  const amountless = he({});
  ok(amountless[0] === 90 && amountless[1] === 1310 && amountless[2] === false,
    'an amount-less held-elsewhere bill is equally outside the load (90 / 1,310), not Unknown', JSON.stringify(amountless));
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

console.log('=== shared bill/commitment input boundary and independent cash oracle ===');
{
  const opening = '2027-02-01', end = '2027-03-01';
  const fixture = (carrier, change) => {
    const p = { startingCash: { amount: 1000 }, defaults: { targetBuffer: 0 },
      income: [{ id: 'income', frequency: 'once', date: '2027-02-10', amount: 200 }],
      bills: [], obligations: [], commitments: [], budget: { categories: [] } };
    p[carrier === 'bill' ? 'bills' : 'commitments'].push({ id: 'invalid', label: 'Invented requirement',
      frequency: 'once', date: '2027-02-15', amount: 100, confidence: 'estimated', ...change });
    return p;
  };
  for (const carrier of ['bill', 'commitment']) {
    const control = F.simulate(fixture(carrier, {}), opening, { horizonDays: 28, weeklyVariable: 0 });
    ok(control.ending === 1100 && control.totals.income === 200,
      `${carrier} control: opening 1000 + income 200 - valid requirement 100 = 1100`);
    const malformed = [undefined, null, '', ' ', 'garbage', true, [100], {}, NaN, Infinity, 0, -0, -40];
    for (const [index, amount] of malformed.entries()) {
      const p = fixture(carrier, { amount });
      const events = F.expandEvents(p, opening, end);
      const state = F.scheduledAmountState(p, opening, end);
      const sim = F.simulate(p, opening, { horizonDays: 28, weeklyVariable: 0 });
      ok(!events.some(e => e.id === 'invalid') && state.status === 'unavailable'
        && sim.ending === null && sim.totals[carrier === 'bill' ? 'bills' : 'commitments'] === null
        && sim.totals.income === 200,
      `${carrier} malformed amount ${index}: no event; affected total/ending unknown; independent income retained`);
      if (carrier === 'commitment') ok(F.commitmentNeed(p.commitments[0]) === null,
        `commitment malformed amount ${index}: point need is unknown, never zero or incoming cash`);
    }
    for (const date of [undefined, '', '2027-02-31', '2027-02-29', '2027-13-01', 'not-a-date', true]) {
      const p = fixture(carrier, { date });
      const state = F.scheduledAmountState(p, opening, end);
      ok(!F.expandEvents(p, opening, end).some(e => e.id === 'invalid')
        && state.status === 'unavailable' && state.unknowns[0].dateUnknown
        && state.unknowns[0].date === null,
      `${carrier} malformed date ${String(date)}: no cash event, no guessed date, Unknown`);
    }
  }
  const leap = fixture('commitment', { date: '2028-02-29' });
  ok(F.expandEvents(leap, '2028-02-01', '2028-03-01').some(e => e.id === 'invalid' && e.amount === -100),
    'Gregorian leap-day positive control retains the exact 100 outflow');
  const monthOnly = fixture('commitment', { date: undefined, when: 'by Feb 2027' });
  ok(F.expandEvents(monthOnly, opening, end).some(e => e.id === 'invalid' && e.date === '2027-02-15' && e.amount === -100),
    'owner month-only rule retains the 15th, not a newly guessed date');
  for (const change of [{ optional: true }, { settledOn: opening }]) {
    const p = fixture('commitment', { date: '2027-02-31', amount: -40, ...change });
    ok(F.scheduledAmountState(p, opening, end).status === 'ready', 'optional/settled requirements retain their exemption');
  }
  const disabled = fixture('commitment', { date: '2027-02-31', amount: -40 });
  ok(F.scheduledAmountState(disabled, opening, end, { disabled: ['invalid'] }).status === 'ready',
    'disabled commitment retains its exemption');
  const range = fixture('commitment', { amount: null, amountMin: 90, amountMax: 110 });
  ok(F.scheduledAmountState(range, opening, end).status === 'ready', 'valid dated range is not collapsed into a point price');
  for (const amount of [0, -40, 'invalid']) {
    const p = fixture('commitment', { amount, amountMin: 90, amountMax: 110 });
    ok(F.scheduledAmountState(p, opening, end).status === 'unavailable',
      'a range does not excuse a present invalid point price');
  }
  const badTerm = fixture('bill', { amount: 100, amountSchedule: [{ from: '2027-02-01', until: '2027-03-01', amount: undefined }] });
  ok(F.scheduledAmountState(badTerm, opening, end).status === 'unavailable'
    && !F.expandEvents(badTerm, opening, end).some(e => e.id === 'invalid'),
    'an explicitly undefined selected schedule price never falls back to the regular price');
  const monthly = fixture('bill', { frequency: 'monthly', date: undefined, amount: 120 });
  const roster = F.householdBills(monthly, opening).bills[0];
  ok(roster.amount === 120 && roster.nextDate === null && roster.monthlyEquivalent === 120,
    'independent monthly price survives an unknown due day; its next date is not invented');
  const waived = fixture('bill', { amount: 0, noPaymentRequiredOn: ['2027-02-15'] });
  ok(F.scheduledAmountState(waived, opening, end).status === 'ready'
    && F.simulate(waived, opening, { horizonDays: 28, weeklyVariable: 0 }).ending === 1200,
    'explicit no-payment evidence remains known zero: 1000 + 200 = 1200');
}

console.log('=== Savings consumers retain invalid requirements without reallocating their stock ===');
{
  const fx = require('./fixtures/savings-daily-allocation-contract');
  const input = mode => {
    const x = fx.advance(fx.fixture(), '2026-10-07');
    if (mode === 'combined') x.plan.savingsEarmarks.allocationPolicy = {
      order: 'due-date-first-combined-pool', effectiveFrom: '2026-10-05', source: 'Independent invented Savings policy' };
    return x;
  };
  const funding = (x, mode) => mode === 'combined'
    ? F.recommend(x.plan, x.asOf, { ...x.opts, debts: [] }).savingsFunding
    : F.savingsDailyFunding(x.plan, [], x.asOf, x.opts);
  for (const mode of ['combined', 'legacy']) {
    const control = funding(input(mode), mode);
    ok(control.stock.amount === 119 && control.backing.status === 'ready'
      && control.backing.items.find(i => i.id === 'near').saved === 60
      && control.backing.items.find(i => i.id === 'home-cost').saved === 24
      && control.backing.items.find(i => i.id === 'far').saved === 35,
    `${mode} control: 95 + 24 stock backs 60 + 24 + 35 exactly`);
    for (const carrier of ['bill', 'commitment']) for (const amount of [0, -40, 'invalid', null]) {
      const x = input(mode), id = carrier === 'bill' ? 'home-cost' : 'near';
      (carrier === 'bill' ? x.plan.bills : x.plan.commitments).find(r => r.id === id).amount = amount;
      const packet = funding(x, mode);
      const item = [...packet.backing.items, ...packet.unresolved].find(i => i.id === id);
      ok(packet.stock.amount === 119 && packet.stock.status === 'ready'
        && packet.backing.status === 'unavailable' && item && item.needed === null && item.saved === null,
      `${mode} ${carrier} invalid ${String(amount)}: known stock retained, requirement and backing unknown`);
      if (mode === 'combined') ok(packet.goalAllocation.status === 'unavailable'
        && packet.backing.items.every(i => i.saved === null),
      `combined ${carrier} invalid ${String(amount)}: no sibling receives a released share`);
      if (carrier === 'commitment') ok(item.commitmentCost.originalCost.amount === null,
        `${mode} invalid commitment cost is unknown, never authored zero`);
      const goal = F.savingsInventory(x.plan, x.asOf).pools
        .flatMap(p => p.plannedGoals).find(g => g.members.includes('goal:' + id));
      ok(goal && goal.target === null && goal.targetTrust === 'unknown',
        `${mode} ${carrier} invalid ${String(amount)}: manual goal target uses the same authority`);
    }
  }
  // A waiver/credit against a valid price removes just that occurrence.
  // The next payable yearly price remains 24, after both club dates, so
  // 119 backs 60 + 59 + 0 in the existing due-date order.
  for (const relief of [{ noPaymentRequiredOn: ['2026-10-25'] }, { utilityAccountCredit: 24 }]) {
    const x = input('combined');
    Object.assign(x.plan.bills.find(r => r.id === 'home-cost'), relief);
    const packet = funding(x, 'combined'), bill = packet.backing.items.find(i => i.id === 'home-cost');
    ok(packet.backing.status === 'ready' && bill.date === '2027-10-25' && bill.needed === 24
      && bill.saved === 0 && packet.backing.items.find(i => i.id === 'far').saved === 59,
    'annual waiver/credit derived zero preserves the next positive requirement and conserved shares');
  }
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall A6 checks passed');
