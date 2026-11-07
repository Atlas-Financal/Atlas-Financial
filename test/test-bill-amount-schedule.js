'use strict';
/* ATLAS-075 — bounded promotional bill pricing with automatic regular-price
 * restoration (bill.amountSchedule), per the frozen prep contract and
 * Amendments 1–2 plus Atlas's GO correction (Slack 1792762006.860439).
 *
 * - bill.amount stays the REGULAR price. amountSchedule terms are
 *   { from, until, amount, confidence? }: from INCLUSIVE, until EXCLUSIVE.
 * - The ACTUAL occurrence date always selects the term; asOf never does.
 * - Gaps and dates on/after `until` use the regular price automatically.
 * - Normalizations (roster monthlyEquivalent, budgetBreakdown billMonthly)
 *   are unavailable when any relevant occurrence is in a term, the schedule
 *   is invalid, or asOf is null; otherwise incumbent. No averaging.
 * - A term never promotes confidence. Unscheduled bills are unchanged.
 * Malformed schedules (M01–M08) live in test-malformed-amounts-fail-closed.js.
 *
 * Synthetic fixtures only. `node test/test-bill-amount-schedule.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { buildHouseholdCalendar } = require('../scripts/calendar-ics.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const J = x => JSON.stringify(x);
const clone = x => JSON.parse(JSON.stringify(x));

const baseBill = patch => Object.assign({ id: 'sx', label: 'Synthetic Stream', amount: 20, day: 10,
  frequency: 'monthly', subscription: true, confidence: 'confirmed', budgetCategory: 'subs' }, patch || {});
const schedBill = (terms, patch) => baseBill(Object.assign({ amountSchedule: terms }, patch || {}));
const mkPlan = (bills, asOf) => ({
  windowDays: 91, opening: { asOf: asOf || '2027-01-01' },
  commitments: [], obligations: [], income: [], bills,
  budget: { basis: 'ytd', categories: [
    { id: 'subs', label: 'Subs', class: 'discretionary', from: ['Subs'] },
    { id: 'other', label: 'Other', class: 'discretionary', from: ['Other'] },
  ] },
});
const PERIODS = { periods: { ytd: { months: 6, spending: [{ label: 'Subs', total: 600 }, { label: 'Other', total: 300 }] } } };
const billEvents = (plan, s, e, id) => F.expandEvents(plan, s, e).filter(x => x.kind === 'bill' && x.id === (id || 'sx'));
const priced = evs => evs.map(e => [e.date, Math.round(-e.amount * 100) / 100]);
const subsRow = (plan, asOf, id) => (F.householdSubscriptions(plan, asOf).subscriptions || []).find(r => r.id === (id || 'sx'));
const cat = (bd, id) => bd && (bd.categories || []).find(c => c.id === id);
const W = ['2027-01-01', '2027-04-30'];

// ---------------------------------------------------------------- C1 walk
{
  const evs = billEvents(mkPlan([baseBill()]), ...W);
  ok(J(priced(evs)) === J([['2027-01-10', 20], ['2027-02-10', 20], ['2027-03-10', 20], ['2027-04-10', 20]])
    && evs.every(e => e.confidence === 'confirmed' && !('amountSource' in e)),
    'S01 no-schedule-control: an unscheduled bill keeps its incumbent events (no amountSource key)', J(priced(evs)));
}
{
  const evs = billEvents(mkPlan([schedBill([{ from: '2027-02-10', until: '2027-03-01', amount: 5 }])]), ...W);
  ok(J(priced(evs).map(p => p[1])) === J([20, 5, 20, 20]), 'S02 from-inclusive: an occurrence on `from` takes the term amount', J(priced(evs)));
}
{
  const evs = billEvents(mkPlan([schedBill([{ from: '2027-02-11', until: '2027-03-01', amount: 5 }])]), ...W);
  ok(priced(evs)[1][1] === 20, 'S03 day-before-from: an occurrence one day before `from` stays regular', J(priced(evs)));
}
{
  const evs = billEvents(mkPlan([schedBill([{ from: '2027-01-10', until: '2027-02-10', amount: 5 }])]), ...W);
  ok(J(priced(evs).map(p => p[1])) === J([5, 20, 20, 20]), 'S04 until-exclusive-restoration: an occurrence on `until` is regular again', J(priced(evs)));
}
{
  const evs = billEvents(mkPlan([schedBill([{ from: '2027-01-11', until: '2027-02-11', amount: 5 }])]), ...W);
  ok(J(priced(evs).map(p => p[1])) === J([20, 5, 20, 20]), 'S05 day-before-until: an occurrence one day before `until` takes the term', J(priced(evs)));
}
{
  const evs = billEvents(mkPlan([schedBill([{ from: '2027-02-01', until: '2027-04-01', amount: 5 }])]), ...W);
  ok(J(priced(evs).map(p => p[1])) === J([20, 5, 5, 20]), 'S06 multi-occurrence-walk: each occurrence priced once, regular restored after', J(priced(evs)));
}
{
  const evs = billEvents(mkPlan([schedBill([{ from: '2027-01-01', until: '2027-02-01', amount: 5 },
    { from: '2027-02-01', until: '2027-03-01', amount: 7 }])]), ...W);
  ok(J(priced(evs).map(p => p[1])) === J([5, 7, 20, 20]), 'S07 adjacent-terms: A.until == B.from is valid; each side its own term', J(priced(evs)));
}
{
  const plan = mkPlan([schedBill([{ from: '2027-01-01', until: '2027-02-01', amount: 5 }, { from: '2027-03-01', until: '2027-04-01', amount: 7 }])]);
  const evs = billEvents(plan, ...W);
  ok(priced(evs)[1] && priced(evs)[1][1] === 20, 'S08 gap-between-terms: an occurrence in the gap is regular', J(priced(evs)));
}
{
  const plan = mkPlan([schedBill([{ from: '2027-02-11', until: '2027-03-01', amount: 5 }])]);
  const evs = billEvents(plan, ...W);
  const state = F.scheduledAmountState(plan, ...W);
  ok(J(priced(evs).map(p => p[1])) === J([20, 20, 20, 20]) && state.status === 'ready',
    'S09 term-without-occurrence: no effect and no issue', J(priced(evs)) + ' ' + state.status);
}
{
  const plan = mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 0 }])]);
  const evs = billEvents(plan, ...W);
  const state = F.scheduledAmountState(plan, ...W);
  ok(J(evs.map(e => e.date)) === J(['2027-01-10', '2027-03-10', '2027-04-10']) && state.status === 'ready',
    'S10 zero-term-amount: a genuine known zero emits no cash event and is not unknown', J(priced(evs)) + ' ' + state.status);
}
{
  const evs = billEvents(mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5, confidence: 'estimated' }])]), ...W);
  const feb = evs.find(e => e.date === '2027-02-10'), jan = evs.find(e => e.date === '2027-01-10');
  ok(feb && feb.confidence === 'estimated' && feb.amountSource === 'schedule'
    && jan && jan.confidence === 'confirmed' && jan.amountSource === 'regular',
    'S11 confidence-min: an estimated term lowers its occurrence only; amountSource names the price', J({ feb, jan }));
}
{
  const evs = billEvents(mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5 }], { noPaymentRequiredOn: ['2027-02-10'] })]), ...W);
  ok(!evs.some(e => e.date === '2027-02-10') && evs.length === 3,
    'S12 noPaymentRequiredOn-precedence: a named no-pay date inside a term stays zero', J(priced(evs)));
}
{
  const evs = billEvents(mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5 }],
    { firstDue: '2027-02-10', utilityAccountCredit: 3 })]), '2027-02-01', '2027-04-30');
  ok(J(priced(evs).map(p => p[1])) === J([2, 20, 20]),
    'S13 utility-credit-order: the firstDue credit applies to the selected term amount', J(priced(evs)));
}
// ---------------------------------------------------------------- C3
{
  const once = { id: 'ob', label: 'Synthetic Once', frequency: 'once', date: '2027-01-05', amount: 0,
    amountSchedule: [{ from: '2027-01-01', until: '2027-02-01', amount: 5 }] };
  const plan = mkPlan([once]);
  const carried = F.carriedOnceJointCashOutflow(plan, 'ob', '2027-01-05', '2027-01-10');
  const futureOnce = { ...once, date: '2027-01-20' };
  const prepaid = F.prepaidJointCashOutflow(mkPlan([futureOnce]), 'ob', '2027-01-20', '2027-01-10');
  ok(carried === true && prepaid === true,
    'S14 once-bill-carried: carried/prepaid joint-cash predicates read the occurrence price', J({ carried, prepaid }));
}
// ---------------------------------------------------------------- C4
{
  const yearly = { id: 'yc', label: 'Synthetic Annual', frequency: 'yearly', month: 3, day: 15, amount: 120,
    jointCash: false, confidence: 'confirmed',
    amountSchedule: [{ from: '2027-03-01', until: '2027-04-01', amount: 60, confidence: 'estimated' }] };
  const row = F.fundingSequence(mkPlan([yearly]), '2027-01-01').find(r => r.id === 'yc' && r.source === 'yearly-card-paid-bill');
  ok(row && row.date === '2027-03-15' && row.need === 60 && row.confidence === 'estimated',
    'S15 yearly-card-paid-need: firstEligibleYearlyCardPaidOccurrence carries the term-priced need and confidence', J(row && { date: row.date, need: row.need, confidence: row.confidence }));
}
// ------------------------------------------------- C5–C7 (helper + site pins)
{
  const src = read('public/forecast.js');
  const body = name => {
    const i = src.indexOf('  function ' + name + '(');
    if (i < 0) return '';
    const j = src.indexOf('\n  function ', i + 10);
    return src.slice(i, j < 0 ? undefined : j);
  };
  const exported = typeof F.billOccurrenceAmount === 'function';
  const occ = exported ? F.billOccurrenceAmount(schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5 }], { amount: '1,900' }), '2027-02-10') : null;
  const out = exported ? F.billOccurrenceAmount(schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5 }], { amount: '1,900' }), '2027-03-10') : null;
  const helperOk = !!occ && occ.amount === 5 && occ.source === 'schedule' && !!out && out.amount === null;
  ok(helperOk && /billOccurrenceRequirementUnknown\(/.test(body('billsAccountPeriodBalance')),
    'S16 bills-account-period-balance: the remaining-cash gate is per occurrence (helper + site pin)', J({ occ, out }));
  ok(helperOk && (body('calendarPeriodWaterfalls').match(/billOccurrenceRequirementUnknown\(/g) || []).length >= 2,
    'S17 period-waterfalls-gate: annual-savings and bill-unknown gates are per occurrence (helper + site pins)');
  ok(helperOk && /billOccurrenceRequirementUnknown\(/.test(body('savingsDailyFunding')),
    'S18 savings-daily-funding-gate: a valid in-term occurrence on a malformed-regular bill is known (helper + site pin)');
}
// ---------------------------------------------------------------- C8 roster
{
  const plan = mkPlan([schedBill([{ from: '2027-02-01', until: '2027-04-01', amount: 5, confidence: 'estimated' }]),
    baseBill({ id: 'sy', label: 'Synthetic Other', amount: 9, day: 20 })], '2027-02-01');
  const view = F.householdSubscriptions(plan, '2027-02-01');
  const row = view.subscriptions.find(r => r.id === 'sx');
  ok(row && row.nextDate === '2027-02-10' && row.amount === 5 && row.amountSource === 'schedule' && row.confidence === 'estimated',
    'S19a roster-live-next-charge: nextDate, amount and confidence describe the same in-term occurrence', J(row));
  ok(row && row.monthlyEquivalent === null && view.monthlyEquivalentExcludedCount === 1 && view.monthlyEquivalentTotal === 9,
    'S19c roster-live-monthly-withheld: monthly is null, counted excluded, and out of the total', J({ m: row && row.monthlyEquivalent, ex: view.monthlyEquivalentExcludedCount, total: view.monthlyEquivalentTotal }));
}
{
  const row = subsRow(mkPlan([schedBill([{ from: '2027-01-01', until: '2027-02-10', amount: 5 }])], '2027-02-01'), '2027-02-01');
  ok(row && row.nextDate === '2027-02-10' && row.amount === 20 && row.amountSource === 'regular',
    'S19b roster-live-restoration-next: nextDate == until shows the regular price', J(row));
}
{
  const asOf = '2027-06-01';
  const plain = subsRow(mkPlan([baseBill()], asOf), asOf);
  const past = subsRow(mkPlan([schedBill([{ from: '2027-01-01', until: '2027-04-01', amount: 5 }])], asOf), asOf);
  const beyond = subsRow(mkPlan([schedBill([{ from: '2029-01-01', until: '2029-02-01', amount: 5 }])], asOf), asOf);
  const strip = r => { const c = { ...r }; delete c.amountSource; return c; };
  ok(J(strip(past)) === J(plain) && J(strip(beyond)) === J(plain),
    'S19d roster-terms-outside-horizon: a valid schedule with no horizon occurrence in a term matches the unscheduled row', J({ plain, past, beyond }));
}
{
  const row = subsRow(mkPlan([schedBill([{ from: '2027-03-01', until: '2027-04-01', amount: 5 }])]), '2027-01-01');
  ok(row && row.nextDate === '2027-01-10' && row.amount === 20 && row.amountSource === 'regular' && row.monthlyEquivalent === null,
    'S19f roster-future-term-in-horizon: next charge regular, monthly withheld for the future term', J(row));
}
{
  const row = subsRow(mkPlan([schedBill([{ from: '2027-01-01', until: '2027-01-05', amount: 5 },
    { from: '2027-02-01', until: '2027-03-01', amount: 7, confidence: 'estimated' }])]), '2027-01-01');
  ok(row && row.nextDate === '2027-01-10' && row.amount === 20 && row.confidence === 'confirmed',
    'S19g roster-nextdate-in-gap: a gap occurrence carries the regular amount and bill confidence', J(row));
}
// S19e: the real renderers consume the same occurrence without edits.
function loadPage(script) {
  const appSrc = read('public/app.js');
  const grab = re => { const m = re.exec(appSrc); if (!m) throw new Error('missing ' + re); return m[0]; };
  const helpers = [grab(/^const money = .*$/m), grab(/^const money2 = .*$/m), grab(/^const pct = .*$/m),
    grab(/^const fmtDate = .*$/m), grab(/^const fmtDateLong = .*$/m), grab(/^const fmtDateFull = .*$/m)].join('\n');
  const elements = {};
  const ctx = { Forecast: F, console, elements,
    App: { hooks: [], register(fn) { this.hooks.push(fn); }, boot() {} } };
  vm.runInNewContext(`${helpers}\nconst $ = id => elements[id] || (elements[id] = { innerHTML: '', textContent: '' });\n${read(script)}\n;this.__fmt = { money2, fmtDateFull };`,
    ctx, { filename: script });
  return { ctx, render(d) { for (const k of Object.keys(elements)) delete elements[k]; for (const fn of ctx.App.hooks) fn(d, null, null); return elements; } };
}
{
  const stripHtml = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const term = [{ from: '2027-02-01', until: '2027-04-01', amount: 5 }];
  const checks = [];
  for (const [script, listId, attr, factAttr, sub] of [
    ['public/bills.js', 'bills-list', 'data-bill-id', 'data-bills-fact', false],
    ['public/subscriptions.js', 'subscriptions-list', 'data-subscription-id', 'data-subscriptions-fact', true]]) {
    const page = loadPage(script);
    const d = { meta: { asOf: '2027-02-01' }, plan: mkPlan([schedBill(clone(term), { subscription: sub })], '2027-02-01') };
    const html = page.render(d)[listId].innerHTML;
    const card = (new RegExp(`<article[^>]*${attr}="sx"[\\s\\S]*?<\\/article>`).exec(html) || [''])[0];
    const fact = name => stripHtml((new RegExp(`<div[^>]*${factAttr}="${name}"[^>]*>[\\s\\S]*?<\\/div>`).exec(card) || [''])[0]);
    const { money2, fmtDateFull } = page.ctx.__fmt;
    const occ = F.billOccurrenceAmount ? F.billOccurrenceAmount(d.plan.bills[0], '2027-02-10') : { amount: NaN };
    checks.push({ script, amount: fact('amount'), next: fact('next'), monthly: fact('monthly'),
      pass: fact('amount').includes(money2(occ.amount)) && fact('next').includes(fmtDateFull('2027-02-10'))
        && /Unknown/.test(fact('monthly')) });
  }
  ok(checks.every(c => c.pass), 'S19e ui-consumer-assertion: bills.js and subscriptions.js print the occurrence price beside its next date, monthly Unknown', J(checks));
}
// ---------------------------------------------------------------- C9 budget
{
  const control = F.budgetBreakdown(mkPlan([baseBill()]), PERIODS, { asOf: '2027-01-01', weeklyCap: 500 });
  const refused = F.budgetBreakdown(mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5 }])]), PERIODS, { asOf: '2027-01-01', weeklyCap: 500 });
  const s = cat(refused, 'subs'), cs = cat(control, 'subs');
  ok(s && s.dated === null && s.planned === null && refused.cap === null
    && s.datedItems.some(i => i.amount === null && i.reason === 'amount-schedule-unsupported') && cs.planned === 80
    && control.cap !== null,
    'S20a budget-live-refused: a scheduled bill with an in-window term withholds its category planned and the cap', J({ s: s && { dated: s.dated, planned: s.planned, items: s.datedItems }, cap: refused && refused.cap, controlCap: control && control.cap, control: cs && cs.planned }));
  ok(J(cat(refused, 'other')) === J(cat(control, 'other')),
    'S20c budget-other-categories-retained: other categories are unchanged by a refused category');
  ok(s && s.historical === cs.historical && s.gross === cs.gross && s.gross === 100 && refused.sinkingMonthly === control.sinkingMonthly,
    'S20g budget-category-facts-survive: window spending/historical and gross survive; sinking unchanged', J({ h: s && s.historical, g: s && s.gross }));
  const outside = F.budgetBreakdown(mkPlan([schedBill([{ from: '2026-01-01', until: '2026-12-01', amount: 5 }])]), PERIODS, { asOf: '2027-01-01' });
  ok(J(cat(outside, 'subs')) === J(cs), 'S20b budget-terms-outside-window: no window occurrence in a term equals the unscheduled control');
  const noCat = F.budgetBreakdown(mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5 }], { budgetCategory: undefined })]), PERIODS, { asOf: '2027-01-01' });
  const noCatControl = F.budgetBreakdown(mkPlan([baseBill({ budgetCategory: undefined })]), PERIODS, { asOf: '2027-01-01' });
  ok(J(noCat) === J(noCatControl), 'S20d budget-no-category-noop: a scheduled bill without budgetCategory leaves the breakdown identical');
  const noAsOf = F.budgetBreakdown(mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5 }])]), PERIODS, {});
  ok(cat(noAsOf, 'subs') && cat(noAsOf, 'subs').planned === null,
    'S20e budget-asof-null-fails-closed: no asOf/start with a schedule present refuses', J(cat(noAsOf, 'subs') && cat(noAsOf, 'subs').planned));
  const beyond = F.budgetBreakdown(mkPlan([schedBill([{ from: '2027-05-01', until: '2027-06-01', amount: 5 }])]), PERIODS, { asOf: '2027-01-01' });
  ok(cat(beyond, 'subs') && cat(beyond, 'subs').dated === 20 && cat(beyond, 'subs').planned === 80,
    'S20f budget-future-term-beyond-window: a term after the window keeps regular billMonthly', J(cat(beyond, 'subs') && cat(beyond, 'subs').dated));
}
// S20h: card-paid regime under refusal keeps the regime (current null,
// gross withheld) rather than falling back to a historical-labelled gross.
{
  const ctl = F.budgetBreakdown(mkPlan([baseBill({ jointCash: false })]), PERIODS, { asOf: '2027-01-01' });
  const ref = F.budgetBreakdown(mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5 }], { jointCash: false })]), PERIODS, { asOf: '2027-01-01' });
  const c = cat(ctl, 'subs'), r = cat(ref, 'subs');
  ok(c && c.current === 20 && c.gross === 20 && r && r.current === null && r.gross === null && r.planned === null
    && r.source === c.source,
    'S20h budget-card-paid-regime-refused: refused card-paid schedule keeps the regime with current/gross null and the same source label',
    J({ control: c && { current: c.current, gross: c.gross, source: c.source }, refused: r && { current: r.current, gross: r.gross, source: r.source } }));
}
// S29: windowDays interval [asOf, asOf + days), outflowDates inclusive end = asOf + days - 1.
{
  const lastIncluded = F.addDays('2027-01-01', 91 - 1), endpoint = F.addDays('2027-01-01', 91);
  const onLast = F.budgetBreakdown(mkPlan([schedBill([{ from: lastIncluded, until: F.addDays(lastIncluded, 20), amount: 5 }],
    { day: Number(lastIncluded.slice(8)) })]), PERIODS, { asOf: '2027-01-01' });
  const atEnd = F.budgetBreakdown(mkPlan([schedBill([{ from: endpoint, until: F.addDays(endpoint, 20), amount: 5 }],
    { day: Number(endpoint.slice(8)) })]), PERIODS, { asOf: '2027-01-01' });
  ok(lastIncluded === '2027-04-01' && endpoint === '2027-04-02'
    && cat(onLast, 'subs').planned === null && cat(atEnd, 'subs').planned === 80,
    'S29 window-last-included-day: an in-term occurrence on asOf+days-1 refuses; one exactly at asOf+days does not',
    J({ lastIncluded, endpoint, onLast: cat(onLast, 'subs').planned, atEnd: cat(atEnd, 'subs').planned }));
}
// ---------------------------------------------------------------- C1 downstream
{
  const plan = mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: 5, confidence: 'estimated' }])]);
  const ics = buildHouseholdCalendar(plan, '2027-01-01', '2027-04-30');
  const pays = ics.payments.filter(p => p.sourceId === 'sx').map(p => [p.start, p.amount]);
  ok(J(pays) === J(priced(billEvents(plan, ...W))) && J(pays.map(p => p[1])) === J([20, 5, 20, 20]),
    'S21 ics-and-expand-parity: calendar-ics payments equal expandEvents occurrence pricing', J(pays));
}
{
  const plan = mkPlan([schedBill([{ from: '2027-01-01', until: '2027-06-01', amount: 5 }], { needsDate: true })]);
  const row = subsRow(plan, '2027-01-01');
  // A6 (#726): an undated bill leaves the walk's scheduled amounts unknown
  // (bill-date-unknown); before A6 this read 'ready', as if it cost $0.
  const state = F.scheduledAmountState(plan, ...W);
  ok(billEvents(plan, ...W).length === 0 && state.status === 'unavailable'
      && state.unknowns.every(u => u.reason === 'bill-date-unknown') && row && row.amount === 20,
    'S22 needsDate-ignores-schedule: an undated bill keeps the incumbent regular treatment; the walk is unknown', J(row));
}
{
  const src = read('scripts/planned-input-contract.js');
  ok(/\[\s*'amountMin',\s*'amountMax',\s*'amountSchedule',\s*'dateWindow',\s*'paymentTiming'\s*\]/.test(src),
    'S23 planned-input-still-rejects-amountSchedule: the ATLAS-080 private correction contract still excludes schedules');
}
// ---------------------------------------------------------------- R1 / scope
{
  const terms = [{ from: '2027-02-01', until: '2027-04-01', amount: 5 }];
  const plan = mkPlan([schedBill(terms)], '2027-06-01');
  const hist = priced(billEvents(plan, ...W)).map(p => p[1]);
  const after = billEvents(plan, '2027-05-01', '2027-07-31');
  const afterPlain = billEvents(mkPlan([baseBill()], '2027-06-01'), '2027-05-01', '2027-07-31');
  const strip = evs => evs.map(e => { const c = { ...e }; delete c.amountSource; return c; });
  ok(J(hist) === J([20, 5, 5, 20]) && J(strip(after)) === J(afterPlain),
    'S24 historical-window-after-expiry: a past window prices in-term dates; a window after until equals unscheduled', J({ hist }));
}
{
  const one = priced(billEvents(mkPlan([schedBill([{ from: '2027-03-01', until: '2027-04-01', amount: 5 }])]), '2027-01-01', '2027-06-30')).map(p => p[1]);
  const two = priced(billEvents(mkPlan([schedBill([{ from: '2027-03-01', until: '2027-04-01', amount: 5 },
    { from: '2027-05-01', until: '2027-06-01', amount: 7 }])]), '2027-01-01', '2027-06-30')).map(p => p[1]);
  ok(J(one) === J([20, 20, 5, 20, 20, 20]) && J(two) === J([20, 20, 5, 20, 7, 20]),
    'S25 future-term-and-gap-walk: regular, term, regular by occurrence date', J({ one, two }));
}
{
  const cells = [];
  for (const billConf of ['confirmed', 'estimated', undefined]) {
    for (const termConf of ['confirmed', 'estimated', undefined]) {
      const term = { from: '2027-02-01', until: '2027-03-01', amount: 5 };
      if (termConf) term.confidence = termConf;
      const bill = schedBill([term]);
      if (billConf) bill.confidence = billConf; else delete bill.confidence;
      const plan = mkPlan([bill], '2027-02-01');
      const evs = billEvents(plan, ...W);
      const inTerm = termConf === 'estimated' ? 'estimated' : billConf;
      const feb = evs.find(e => e.date === '2027-02-10'), mar = evs.find(e => e.date === '2027-03-10');
      const row = subsRow(plan, '2027-02-01');
      const ics = buildHouseholdCalendar(plan, '2027-01-01', '2027-04-30').payments.find(p => p.sourceId === 'sx' && p.start === '2027-02-10');
      const pass = !!feb && feb.confidence === inTerm && !!mar && mar.confidence === billConf
        && row && row.confidence === (inTerm || null)
        && !!ics && ics.description.includes('Tagged ' + (inTerm || 'estimated') + '.');
      cells.push({ billConf: billConf || 'absent', termConf: termConf || 'omitted', pass });
    }
  }
  ok(cells.every(c => c.pass), 'S26 confidence-propagation-matrix: events, ics and roster carry the selected value; never promoted', J(cells.filter(c => !c.pass)));
}
{
  const y = baseBill({ id: 'sy', label: 'Synthetic Other', amount: 9, day: 20 });
  const bad = schedBill([{ from: '2027-01-01', until: '2027-03-01', amount: 5 }, { from: '2027-02-01', until: '2027-04-01', amount: 6 }]);
  const plan = mkPlan([bad, clone(y)]);
  const yOnly = billEvents(mkPlan([clone(y)]), ...W, 'sy');
  const state = F.scheduledAmountState(plan, ...W);
  const unk = mkPlan([schedBill([{ from: '2027-02-01', until: '2027-03-01', amount: '1,900' }])]);
  const unkState = F.scheduledAmountState(unk, ...W);
  ok(J(billEvents(plan, ...W, 'sy')) === J(yOnly) && state.unknowns.every(u => u.id === 'sx')
    && J(cat(F.budgetBreakdown(plan, PERIODS, { asOf: '2027-01-01' }), 'other')) === J(cat(F.budgetBreakdown(mkPlan([clone(y)]), PERIODS, { asOf: '2027-01-01' }), 'other'))
    && J(priced(billEvents(unk, ...W)).map(p => p[0])) === J(['2027-01-10', '2027-03-10', '2027-04-10'])
    && J(unkState.unknowns.map(u => u.date)) === J(['2027-02-10']),
    'S27 refusal-scope: an invalid schedule leaves other bills/categories identical; an unknown term amount leaves out-of-term occurrences known',
    J({ unknowns: state.unknowns, unk: unkState.unknowns }));
}
{
  // Hand-computed expectations for unscheduled incumbent rules.
  const plan = mkPlan([
    baseBill({ id: 'np', noPaymentRequiredOn: ['2027-02-10'] }),
    baseBill({ id: 'uc', firstDue: '2027-01-10', utilityAccountCredit: 3 }),
    { id: 'yc', label: 'Synthetic Annual', frequency: 'yearly', month: 3, day: 15, amount: 120, jointCash: false, confidence: 'confirmed' },
    baseBill({ id: 'nd', needsDate: true }),
  ]);
  const by = id => priced(billEvents(plan, ...W, id));
  const yc = F.fundingSequence(plan, '2027-01-01').find(r => r.id === 'yc' && r.source === 'yearly-card-paid-bill');
  const ycEvent = billEvents(plan, ...W, 'yc')[0];
  const row = (F.householdSubscriptions(plan, '2027-01-01').subscriptions || []).find(r => r.id === 'uc');
  ok(J(by('np').map(p => p[0])) === J(['2027-01-10', '2027-03-10', '2027-04-10'])
    && J(by('uc').map(p => p[1])) === J([17, 20, 20, 20])
    && yc && yc.need === 120 && ycEvent && ycEvent.cardPaid === true && ycEvent.jointCash === false
    && by('nd').length === 0 && row && !('amountSource' in row) && row.monthlyEquivalent === 20,
    'S28 incumbent-regression: no-pay, firstDue credit, card-paid yearly, jointCash and needsDate unchanged for unscheduled bills',
    J({ np: by('np'), uc: by('uc'), yc: yc && yc.need }));
}

// S30–S32 (ATLAS-075 HOLD 1792765825.698399): noPaymentRequiredOn keeps
// precedence over term selection in the REAL consumers. A waived occurrence
// inside a null-amount term is a known zero; the same term without the
// waiver stays unknown (guards). Driven through Forecast.recommend on the
// existing synthetic chronological-savings ledger, compared with an
// unscheduled waived control. Dates sit in that fixture's cycle.
{
  const { ledger } = require('./fixtures/chronological-savings-data');
  const { advance } = require('./fixtures/savings-daily-allocation-contract');
  const base = () => {
    const i = advance(ledger(), '2026-10-10');
    i.plan.income[0].anchor = '2026-08-14';
    i.plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 80 };
    i.plan.opening.representedEvents = [];
    i.opts.currentPeriodActuals.coverageStart = '2026-10-09';
    i.opts.currentPeriodActuals.savingsFetchCoverage.startDate = '2026-10-09';
    i.plan.bills = [{ id: 'annual', label: 'Invented annual premium', amount: 17.29,
      frequency: 'yearly', month: 10, day: 25, firstDue: '2026-10-25', jointCash: false, confidence: 'estimated' }];
    i.plan.savingsEarmarks.pools[1].goalRefs = [{ kind: 'yearly-bill', id: 'annual' }];
    return i;
  };
  const NULLTERM = [{ from: '2026-10-01', until: '2026-11-01', amount: null }];
  const monthly = (waive, sched) => Object.assign({ id: 'promo', label: 'Invented promo', amount: 20, day: 15,
    frequency: 'monthly', confidence: 'confirmed' }, waive ? { noPaymentRequiredOn: ['2026-10-15'] } : {},
    sched ? { amountSchedule: NULLTERM } : {});
  const run = i => F.recommend(i.plan, i.asOf, { ...i.opts, debts: i.debts || [], weeklyVariable: 0 });
  const fig = a => { const p = a.payPeriodViews.find(p => p.start === '2026-10-09') || {};
    return { periodBillLoad: p.periodBillLoad, afterBills: p.afterBills, bad: p.balanceAfterDeductions,
      extraDebtReason: p.extraDebt && p.extraDebt.reason || null }; };
  const sav = a => { const t = a.savingsFunding && a.savingsFunding.timeline;
    return { status: t && t.status, reason: t && t.reason || null }; };
  const mk = f => { const i = base(); f(i); return run(i); };
  const wCtl = mk(i => i.plan.bills.push(monthly(true, false)));
  const wNew = mk(i => i.plan.bills.push(monthly(true, true)));
  const wGuard = mk(i => i.plan.bills.push(monthly(false, true)));
  ok(fig(wCtl).periodBillLoad === 0 && J(fig(wNew)) === J(fig(wCtl)) && J(sav(wNew)) === J(sav(wCtl)),
    'S30 waived-in-null-term-waterfall: a waived occurrence in a null-amount term keeps known-zero periodBillLoad/afterBills/BAD (control parity)',
    J({ control: fig(wCtl), candidate: fig(wNew), savings: sav(wNew) }));
  ok(fig(wGuard).periodBillLoad === null && fig(wGuard).afterBills === null && fig(wGuard).bad === null && sav(wGuard).status === 'unavailable',
    'S30g guard: the same null term without the waiver still withholds the waterfall', J(fig(wGuard)));
  const aCtl = mk(i => { i.plan.bills[0].noPaymentRequiredOn = ['2026-10-25']; });
  const aNew = mk(i => { i.plan.bills[0].noPaymentRequiredOn = ['2026-10-25']; i.plan.bills[0].amountSchedule = NULLTERM; });
  const aGuard = mk(i => { i.plan.bills[0].amountSchedule = NULLTERM; });
  const annualMsg = 'An annual planned savings cost has unknown amount or timing.';
  ok(fig(aNew).extraDebtReason !== annualMsg && J(fig(aNew)) === J(fig(aCtl)),
    'S31 waived-in-null-term-annual-savings: a waived annual savings occurrence in a null term is not an unknown annual savings cost',
    J({ control: fig(aCtl), candidate: fig(aNew) }));
  ok(fig(aGuard).extraDebtReason === annualMsg,
    'S31g guard: the same annual null term without the waiver stays an unknown annual savings cost', J(fig(aGuard)));
  ok(sav(aCtl).status === 'ready' && J(sav(aNew)) === J(sav(aCtl)),
    'S32 waived-in-null-term-daily-funding: savings daily funding stays ready (control parity) for a waived null-term occurrence',
    J({ control: sav(aCtl), candidate: sav(aNew) }));
  ok(sav(aGuard).status === 'unavailable',
    'S32g guard: without the waiver daily funding stays unavailable', J(sav(aGuard)));
}

// S33–S35 (Atlas 1792766201.177409 / 1792766321.556569): remaining HOLD
// regression pins through actual consumers. S33 billsAccountPeriodBalance
// (direct and as published by recommend().defaultView); S34 a MALFORMED
// schedule with a waived occurrence; S35 a mixed waived/non-waived window,
// where the non-waived unknown must still withhold.
{
  const fx = require('./fixtures/bills-period-end-balance-data');
  const NULLTERM_AUG = [{ from: '2026-08-01', until: '2026-09-01', amount: null }];
  const OVERLAP_AUG = [{ from: '2026-08-01', until: '2026-08-26', amount: 5 }, { from: '2026-08-20', until: '2026-09-01', amount: 6 }];
  const bab = change => { const x = fx.requirementsFixture(); change(x);
    const d = F.billsAccountPeriodBalance(x.plan, x.asOf, x.opts);
    const pub = F.recommend(x.plan, x.asOf, x.opts).defaultView.billsAccountPeriodBalance;
    return [d, pub].map(r => ({ amount: r.amount, status: r.status, codes: (r.issues || []).map(i => i.code) })); };
  const svc = x => x.plan.bills[0]; // once bill dated 2026-08-24 inside the fixture's 08-14..08-27 period
  const waive = x => { svc(x).noPaymentRequiredOn = [svc(x).date]; };
  // Incumbent oracle from test-bills-period-end-native-requirements.js:
  // 'native named no-pay unknown bill' => 976.85; unknown bill => null.
  const known = rows => rows.every(r => r.amount === 976.85 && r.status === 'ready');
  const withheld = rows => rows.every(r => r.amount === null && r.status === 'unavailable' && r.codes.includes('remaining-cash-unknown'));
  const s33 = bab(x => { waive(x); svc(x).amountSchedule = NULLTERM_AUG; });
  ok(known(s33), 'S33 bills-account-waived-null-term: waived occurrence in a null-amount term is a known zero in billsAccountPeriodBalance (direct and published)', J(s33));
  const s33g = bab(x => { svc(x).amountSchedule = NULLTERM_AUG; });
  ok(withheld(s33g), 'S33g guard: the same null term without the waiver withholds billsAccountPeriodBalance with remaining-cash-unknown', J(s33g));
  const s34 = bab(x => { waive(x); svc(x).amountSchedule = OVERLAP_AUG; });
  ok(known(s34), 'S34 bills-account-malformed-waived: a waived occurrence of a malformed (overlapping) schedule is a known zero', J(s34));
  const s34g = bab(x => { svc(x).amountSchedule = OVERLAP_AUG; });
  ok(withheld(s34g), 'S34g guard: the malformed schedule without the waiver withholds billsAccountPeriodBalance', J(s34g));
  const s35 = bab(x => { waive(x); svc(x).amountSchedule = NULLTERM_AUG;
    x.plan.bills.push({ id: 'service-2', label: 'Invented second service', frequency: 'once', date: '2026-08-25',
      amount: 9, confidence: 'confirmed', payingAccount: 'chequing-a', amountSchedule: NULLTERM_AUG }); });
  ok(withheld(s35), 'S35a bills-account-mixed: a waived null-term occurrence cannot hide a non-waived null-term occurrence in the same period', J(s35));

  // Waterfall / annual Savings / daily funding on the same chronological
  // ledger as S30–S32.
  const { ledger } = require('./fixtures/chronological-savings-data');
  const { advance } = require('./fixtures/savings-daily-allocation-contract');
  const base = () => {
    const i = advance(ledger(), '2026-10-10');
    i.plan.income[0].anchor = '2026-08-14';
    i.plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 80 };
    i.plan.opening.representedEvents = [];
    i.opts.currentPeriodActuals.coverageStart = '2026-10-09';
    i.opts.currentPeriodActuals.savingsFetchCoverage.startDate = '2026-10-09';
    i.plan.bills = [{ id: 'annual', label: 'Invented annual premium', amount: 17.29,
      frequency: 'yearly', month: 10, day: 25, firstDue: '2026-10-25', jointCash: false, confidence: 'estimated' }];
    i.plan.savingsEarmarks.pools[1].goalRefs = [{ kind: 'yearly-bill', id: 'annual' }];
    return i;
  };
  const run = i => F.recommend(i.plan, i.asOf, { ...i.opts, debts: i.debts || [], weeklyVariable: 0 });
  const fig = a => { const p = a.payPeriodViews.find(p => p.start === '2026-10-09') || {};
    return { periodBillLoad: p.periodBillLoad, afterBills: p.afterBills, bad: p.balanceAfterDeductions,
      extraDebtReason: p.extraDebt && p.extraDebt.reason || null }; };
  const sav = a => { const t = a.savingsFunding && a.savingsFunding.timeline; return { status: t && t.status, reason: t && t.reason || null }; };
  const mk = f => { const i = base(); f(i); return run(i); };
  const NULLTERM = [{ from: '2026-10-01', until: '2026-11-01', amount: null }];
  const OVERLAP = [{ from: '2026-10-01', until: '2026-10-20', amount: 5 }, { from: '2026-10-10', until: '2026-11-01', amount: 6 }];
  const monthly = (id, day, extra) => Object.assign({ id, label: 'Invented ' + id, amount: 20, day,
    frequency: 'monthly', confidence: 'confirmed' }, extra);
  const annualMsg = 'An annual planned savings cost has unknown amount or timing.';
  const wCtl = mk(i => i.plan.bills.push(monthly('promo', 15, { noPaymentRequiredOn: ['2026-10-15'] })));
  // S34 malformed + waived through the waterfall: only the waived occurrence
  // falls in the 10-09 period, so it keeps control parity.
  const s34w = mk(i => i.plan.bills.push(monthly('promo', 15, { noPaymentRequiredOn: ['2026-10-15'], amountSchedule: OVERLAP })));
  ok(fig(wCtl).periodBillLoad === 0 && J(fig(s34w)) === J(fig(wCtl)),
    'S34w waterfall-malformed-waived: the waived occurrence of a malformed schedule keeps the period known-zero (control parity)',
    J({ control: fig(wCtl), candidate: fig(s34w) }));
  const s34wg = mk(i => i.plan.bills.push(monthly('promo', 15, { amountSchedule: OVERLAP })));
  ok(fig(s34wg).periodBillLoad === null && fig(s34wg).bad === null,
    'S34wg guard: the malformed schedule without the waiver withholds the period', J(fig(s34wg)));
  // S35 mixed waived / non-waived.
  const s35w = mk(i => { i.plan.bills.push(monthly('promo', 15, { noPaymentRequiredOn: ['2026-10-15'], amountSchedule: NULLTERM }));
    i.plan.bills.push(monthly('promo-2', 20, { amountSchedule: NULLTERM })); });
  ok(fig(s35w).periodBillLoad === null && fig(s35w).afterBills === null && fig(s35w).bad === null,
    'S35b waterfall-mixed: a waived null-term occurrence cannot hide a non-waived null-term occurrence in the same period', J(fig(s35w)));
  const s35a = mk(i => { i.plan.bills[0].noPaymentRequiredOn = ['2026-10-25']; i.plan.bills[0].amountSchedule = NULLTERM;
    i.plan.bills.push({ id: 'annual-2', label: 'Invented second annual', amount: 11, frequency: 'yearly', month: 10, day: 27,
      firstDue: '2026-10-27', jointCash: false, confidence: 'estimated', amountSchedule: NULLTERM });
    i.plan.savingsEarmarks.pools[1].goalRefs.push({ kind: 'yearly-bill', id: 'annual-2' }); });
  ok(fig(s35a).extraDebtReason === annualMsg && sav(s35a).status === 'unavailable',
    'S35c annual-savings-and-daily-mixed: a waived annual null-term occurrence cannot hide a second, non-waived one',
    J({ fig: fig(s35a), savings: sav(s35a) }));
  const s35d = mk(i => { i.plan.bills[0].noPaymentRequiredOn = ['2026-10-25'];
    i.plan.bills[0].amountSchedule = [{ from: '2026-10-01', until: '2028-01-01', amount: null }]; });
  const s35dCtl = mk(i => { i.plan.bills[0].noPaymentRequiredOn = ['2026-10-25'];
    i.plan.bills[0].amountSchedule = [{ from: '2026-10-01', until: '2028-01-01', amount: 5 }]; });
  ok(sav(s35d).status === 'unavailable' && sav(s35dCtl).status === 'ready',
    'S35d daily-funding-mixed-same-bill: waiving one occurrence of a long null term does not clear a later non-waived occurrence in the funding timeline',
    J({ candidate: sav(s35d), knownTermControl: sav(s35dCtl) }));
}

// S36 (Atlas HOLD at 92efcfb5, residual C7): the daily-funding consumer must
// apply noPaymentRequiredOn precedence before the schedule-validity check.
// Atlas's fixture: a once bill dated 2026-10-15, amount 20, that sole date
// waived, with overlapping (malformed) terms Oct1-Oct20 amount 5 and
// Oct10-Nov1 amount 6. Driven through Forecast.recommend on the S32 ledger.
// Guards: the same malformed schedule NOT waived stays unavailable, and a
// malformed schedule whose occurrence timing is missing stays unavailable.
{
  const { ledger } = require('./fixtures/chronological-savings-data');
  const { advance } = require('./fixtures/savings-daily-allocation-contract');
  const base = () => {
    const i = advance(ledger(), '2026-10-10');
    i.plan.income[0].anchor = '2026-08-14';
    i.plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 80 };
    i.plan.opening.representedEvents = [];
    i.opts.currentPeriodActuals.coverageStart = '2026-10-09';
    i.opts.currentPeriodActuals.savingsFetchCoverage.startDate = '2026-10-09';
    i.plan.bills = [{ id: 'annual', label: 'Invented annual premium', amount: 17.29,
      frequency: 'yearly', month: 10, day: 25, firstDue: '2026-10-25', jointCash: false, confidence: 'estimated',
      noPaymentRequiredOn: ['2026-10-25'] }];
    i.plan.savingsEarmarks.pools[1].goalRefs = [{ kind: 'yearly-bill', id: 'annual' }];
    return i;
  };
  const run = i => F.recommend(i.plan, i.asOf, { ...i.opts, debts: i.debts || [], weeklyVariable: 0 });
  const sav = a => { const t = a.savingsFunding && a.savingsFunding.timeline; return { status: t && t.status, reason: t && t.reason || null }; };
  const mk = f => { const i = base(); f(i); return run(i); };
  const OVERLAP = [{ from: '2026-10-01', until: '2026-10-20', amount: 5 }, { from: '2026-10-10', until: '2026-11-01', amount: 6 }];
  const once = extra => Object.assign({ id: 'once-promo', label: 'Invented once promo', frequency: 'once',
    date: '2026-10-15', amount: 20, confidence: 'confirmed' }, extra);
  const ctl = mk(i => i.plan.bills.push(once({ noPaymentRequiredOn: ['2026-10-15'] })));
  const s36 = mk(i => i.plan.bills.push(once({ noPaymentRequiredOn: ['2026-10-15'], amountSchedule: OVERLAP })));
  ok(ctl.savingsFunding && sav(ctl).status === 'ready' && J(sav(s36)) === J(sav(ctl)),
    'S36 daily-funding-malformed-waived: an entirely waived once bill with a malformed (overlapping) schedule keeps daily funding ready (known-zero control parity)',
    J({ control: sav(ctl), candidate: sav(s36) }));
  const s36g = mk(i => i.plan.bills.push(once({ amountSchedule: OVERLAP })));
  ok(sav(s36g).status === 'unavailable',
    'S36g guard: the same malformed schedule without the waiver keeps daily funding unavailable', J(sav(s36g)));
  const s36t = mk(i => { const b = once({ amountSchedule: OVERLAP }); delete b.date; i.plan.bills.push(b); });
  ok(sav(s36t).status === 'unavailable',
    'S36t guard: a malformed schedule on a bill with no resolvable occurrence timing stays unavailable (missing timing not hidden)', J(sav(s36t)));
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All ATLAS-075 bill amount schedule checks passed'));
process.exit(failures === 0 ? 0 : 1);
