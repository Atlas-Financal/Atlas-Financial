'use strict';
/* Balance After Deductions deducts the FULL assigned period bill load
 * (Bills audit of main 57cb421, lead dispatch).
 *
 * Defect: a recurring bill dated before the plan's settlement opening date
 * (opening.priorAsOf on the live plan, otherwise opening.asOf) was stamped
 * settlement 'opening', printed PAID with no payment evidence, and left
 * out of the bill load — while the period income that paid it stayed in.
 * BAD = income − bills − Household Budget has no opening term, so it came
 * out over-optimistic, and it rose as days passed with no new evidence.
 *
 * Contract proved here, all with invented numbers:
 *  1. BAD = period income − every assigned period bill − Household Budget,
 *     for every opening shape (live priorAsOf, plain dated opening, payday
 *     snapshot, mid-period cutover) and every viewing day.
 *  2. Paying a bill never changes BAD, for every opening shape.
 *  3. The cash close keeps an opening exclusion, measured against ITS OWN
 *     opening date: a payday-morning snapshot still deducts bills dated
 *     after it, even when the plan's settlement date is later.
 *  4. A completed period keeps the full load.
 *  5. An 'opening' settlement never prints PAID: Budget page shows
 *     "To confirm · Inside opening balance"; the legacy calendar line says
 *     "in opening balance · to confirm".
 *  6. Talk's figure (assistant packet forecast.predictedEndingBalance)
 *     carries the corrected BAD.
 *
 * Expected values are hand arithmetic on the constants below; nothing is
 * read back from Forecast to build an expectation.
 *
 * `node test/test-bad-full-period-bill-load.js`
 */
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('../public/forecast.js');
const Detail = require('../public/bill-detail');
const Assistant = require('../scripts/assistant-packet');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 0.005;

// Invented household.
const PAYDAY = '2026-08-28';            // biweekly payday; period 08-28 … 09-10
const PAY = 5000;
const INTERNET = 100;                    // monthly, day 30 → 2026-08-30
const PHONE = 80;                        // monthly, day 1  → 2026-09-01
const HYDRO = 200;                       // monthly, day 8  → 2026-09-08
const WEEKLY_HOUSEHOLD = 200;            // two weeks → 400 per period
const HOUSEHOLD = 400;
const BILLS = INTERNET + PHONE + HYDRO;  // 380
const BAD = PAY - BILLS - HOUSEHOLD;     // 4220
const SNAPSHOT = 6000;
const SNAPSHOT_CLOSE = SNAPSHOT + PAY - BILLS - HOUSEHOLD; // 10220

function plan(opening, overrides) {
  return Object.assign({
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 3000 },
    opening,
    income: [{ id: 'payroll', label: 'Pay', frequency: 'biweekly', anchor: PAYDAY,
      amount: PAY, confidence: 'confirmed' }],
    bills: [
      { id: 'internet', label: 'Internet', frequency: 'monthly', day: 30, amount: INTERNET,
        confidence: 'confirmed', payingAccount: 'chequing-a' },
      { id: 'phone', label: 'Phone', frequency: 'monthly', day: 1, amount: PHONE,
        confidence: 'confirmed', payingAccount: 'chequing-a' },
      { id: 'hydro', label: 'Hydro', frequency: 'monthly', day: 8, amount: HYDRO,
        confidence: 'confirmed', payingAccount: 'chequing-a' },
    ],
    obligations: [],
    commitments: [],
    budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential',
      plannedWeekly: WEEKLY_HOUSEHOLD }] },
  }, overrides || {});
}
const advise = (p, asOf, extra) => F.recommend(p, asOf, Object.assign({ targetBuffer: 0, debts: [] }, extra || {}));
const active = advice => (advice.defaultView.calendarPeriods || []).find(p => p.id === 'this-pay-period');
const row = (period, id) => (period.bills || []).find(r => r.id === id);

const SHAPES = [
  ['live overlay, priorAsOf 09-02', { asOf: '2026-09-06', priorAsOf: '2026-09-02' }, '2026-09-06'],
  ['live overlay, priorAsOf 08-20', { asOf: '2026-09-06', priorAsOf: '2026-08-20' }, '2026-09-06'],
  ['dated opening on 08-29', { asOf: '2026-08-29' }, '2026-08-29'],
  ['dated opening on 09-02', { asOf: '2026-09-02' }, '2026-09-02'],
  ['dated opening on 09-09', { asOf: '2026-09-09' }, '2026-09-09'],
  ['payday snapshot 08-28, priorAsOf 09-02', { asOf: '2026-09-06', priorAsOf: '2026-09-02',
    paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: SNAPSHOT } }, '2026-09-06'],
];

console.log('=== 1. BAD deducts every assigned bill, for every opening shape and viewing day ===');
for (const [label, opening, asOf] of SHAPES) {
  const period = active(advise(plan(opening), asOf));
  ok(near(period.periodBillLoad, BILLS) && near(period.totalBillsThisPeriod, BILLS),
    `${label}: bill load $${BILLS} equals total bills this period`, `load ${period.periodBillLoad}`);
  ok(near(period.afterBills, PAY - BILLS) && near(period.balanceAfterDeductions, BAD)
      && near(period.predictedEndingBalance, BAD),
    `${label}: BAD $${BAD}`, `BAD ${period.balanceAfterDeductions}`);
}

console.log('\n=== 2. Paying a bill never changes BAD, for every opening shape ===');
for (const [label, opening, asOf] of SHAPES) {
  const unpaid = active(advise(plan(opening), asOf));
  // Posted payment evidence for Phone (invented $80 debit on 09-01).
  const paid = active(advise(plan(opening), asOf, { currentPeriodActuals: {
    schema: 'atlas-current-period-actuals/v1', observationAsOf: asOf, coverageStart: PAYDAY,
    coverageThrough: asOf, pendingCoverage: 'complete', transactionCoverage: 'complete',
    representedActuals: [{ id: 'phone', date: '2026-09-01', actual: PHONE, postedOn: '2026-09-01' }],
    transactions: [] } }));
  ok(row(paid, 'phone') && row(paid, 'phone').status === 'PAID',
    `${label}: Phone with a represented payment prints PAID`);
  ok(near(unpaid.balanceAfterDeductions, BAD) && near(paid.balanceAfterDeductions, BAD),
    `${label}: BAD is $${BAD} before and after paying Phone`,
    `${unpaid.balanceAfterDeductions} / ${paid.balanceAfterDeductions}`);
}
{
  // A $1,000 one-off bill paid before a mid-period opening, plus $500 due.
  const once = (represented) => plan({ asOf: '2026-09-04', representedEvents: represented }, {
    bills: [
      { id: 'big', label: 'Big bill', frequency: 'once', date: '2026-09-01', amount: 1000,
        confidence: 'confirmed', payingAccount: 'chequing-a' },
      { id: 'later', label: 'Later bill', frequency: 'once', date: '2026-09-08', amount: 500,
        confidence: 'confirmed', payingAccount: 'chequing-a' },
    ],
    budget: { categories: [] },
  });
  const unpaid = active(advise(once([]), '2026-09-04'));
  const paid = active(advise(once([{ id: 'big', date: '2026-09-01' }]), '2026-09-04'));
  const expected = PAY - 1000 - 500; // 3500
  ok(near(unpaid.balanceAfterDeductions, expected) && near(paid.balanceAfterDeductions, expected),
    'mid-period opening: paying the $1,000 bill keeps BAD at $3,500 (not $4,500)',
    `${unpaid.balanceAfterDeductions} / ${paid.balanceAfterDeductions}`);
}

{
  // Lead-forwarded case: a next-period bill (Internet 60, due 10-28) paid
  // early on 10-20, viewed 10-21. BAD is a per-period identity: the 60 is
  // the next period's assigned bill, so that period deducts it whether paid
  // early or not (1000 − 60 = 940), and this period never does (1000).
  // Counted once across the two BADs. The next period's cash close
  // (posting date vs due date) belongs to the early-paid-bill lane.
  const early = { defaults: { targetBuffer: 0 }, startingCash: { amount: 500 }, opening: { asOf: '2026-10-21' },
    income: [{ id: 'payroll', label: 'Pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1000,
      confidence: 'confirmed' }],
    bills: [{ id: 'internet', label: 'Internet', frequency: 'monthly', day: 28, amount: 60,
      confidence: 'confirmed', payingAccount: 'chequing-a' }],
    obligations: [], commitments: [], budget: { categories: [] } };
  const run = represented => advise(early, '2026-10-21', { currentPeriodActuals: {
    schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-10-21', coverageStart: '2026-10-09',
    coverageThrough: '2026-10-21', pendingCoverage: 'complete', transactionCoverage: 'complete',
    transactions: [], representedActuals: represented } }).defaultView.calendarPeriods;
  const unpaid = run([]);
  const paid = run([{ id: 'internet', date: '2026-10-28', actual: 60, postedOn: '2026-10-20' }]);
  const next = ps => ps.find(p => p.start === '2026-10-23');
  ok(near(active({ defaultView: { calendarPeriods: paid } }).balanceAfterDeductions, 1000)
      && near(next(unpaid).balanceAfterDeductions, 940) && near(next(paid).balanceAfterDeductions, 940),
    'early-paid next-period bill: this period BAD $1,000; next period BAD $940 paid early or not');
}

console.log('\n=== 3. The cash close is measured against its own opening ===');
{
  const advice = advise(plan(SHAPES[5][1]), '2026-09-06');
  const period = active(advice);
  ok(period.openingSource === 'snapshot' && period.openingAsOf === PAYDAY && near(period.opening, SNAPSHOT),
    'opens from the payday-morning snapshot');
  const close = period.plannedPeriodCloseTerms;
  ok(close && near(close.periodBillLoad, BILLS),
    `close deducts all $${BILLS}: Internet and Phone are after the 08-28 snapshot`,
    close ? `close bills ${close.periodBillLoad}` : 'no close terms');
  const next = (advice.defaultView.calendarPeriods || []).find(p => p.role === 'future');
  ok(next && near(next.opening, SNAPSHOT_CLOSE),
    `next period opens from close $${SNAPSHOT_CLOSE} (not $${SNAPSHOT_CLOSE + INTERNET + PHONE})`,
    next ? `next opening ${next.opening}` : '');
}
{
  // Mid-period dated opening: the $1,000 paid on 09-01 is inside the 09-04
  // cash, so the close (opening + income added − bills) must not repeat it.
  const p = plan({ asOf: '2026-09-04', representedEvents: [{ id: 'big', date: '2026-09-01' }] }, {
    bills: [{ id: 'big', label: 'Big bill', frequency: 'once', date: '2026-09-01', amount: 1000,
      confidence: 'confirmed', payingAccount: 'chequing-a' },
    { id: 'later', label: 'Later bill', frequency: 'once', date: '2026-09-08', amount: 500,
      confidence: 'confirmed', payingAccount: 'chequing-a' }],
    budget: { categories: [] },
  });
  const period = active(advise(p, '2026-09-04'));
  const close = period.plannedPeriodCloseTerms;
  ok(period.openingSource === 'cutover-opening' && near(period.periodBillLoad, 1500)
      && (!close || close.periodBillLoad == null || near(close.periodBillLoad, 500)),
    'mid-period cutover: BAD load $1,500; any close bill term excludes the $1,000 already in cash',
    close ? `close bills ${close.periodBillLoad}` : 'close withheld');
}

console.log('\n=== 4. A completed period keeps the full load ===');
{
  const advice = advise(plan({ asOf: '2026-09-15' }), '2026-09-15');
  const done = (advice.payPeriodViews || []).find(p => p.lookback === true && p.start === PAYDAY);
  ok(done && near(done.periodBillLoad, BILLS),
    `completed 08-28 period deducts all $${BILLS}`, done ? `load ${done.periodBillLoad}` : 'no lookback');
  ok(done && ['internet', 'phone', 'hydro'].every(id => row(done, id) && row(done, id).status !== 'PAID'),
    'completed period rows without evidence are not PAID');
}

console.log('\n=== 5. An opening settlement never prints PAID ===');
const page = (() => {
  const context = vm.createContext({ Forecast: F, BillDetail: Detail, console,
    addEventListener() {}, document: { addEventListener() {}, querySelectorAll() { return []; },
      getElementById() { return null; }, documentElement: { dataset: {}, style: {} } },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' } });
  vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {};', context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/plan.js'), 'utf8'), context);
  return (fn, ...args) => { context.__args = args; return vm.runInContext(`${fn}(...__args)`, context); };
})();
{
  const asOf = '2026-09-06';
  const advice = advise(plan(SHAPES[0][1]), asOf);
  const period = active(advice);
  for (const id of ['internet', 'phone']) {
    const r = row(period, id);
    ok(r && r.settlement === 'opening' && r.status !== 'PAID' && r.glanceKind !== 'paid',
      `${id}: opening settlement is not PAID`, r ? `${r.status}/${r.settlement}` : '');
  }
  ok(near(period.paidBills, 0) && near(period.remainingBills, BILLS),
    'no evidence: $0 confirmed paid; all $380 still to pay or confirm');
  const view = advice.payPeriodViews.find(p => p.timelineRole === 'current');
  const billsHtml = page('budgetBillsSectionHtml', view, { asOf, advice });
  const internetRow = (billsHtml.match(/<button[^>]*data-budget-bill-open="internet"[\s\S]*?<\/button>/) || [''])[0];
  ok(/To confirm · Inside opening balance/.test(internetRow) && !/>Paid</.test(internetRow)
      && /is-check/.test(internetRow),
    'Budget page: Internet reads "To confirm · Inside opening balance", not Paid');
  ok(/data-budget-bill-bucket="check"[\s\S]*data-budget-bill-open="internet"/.test(billsHtml)
      && !/data-budget-bill-bucket="paid"/.test(billsHtml),
    'Budget page: no Paid bucket; Internet sits under To confirm');
  ok(billsHtml.includes('$380.00'),
    'Budget page: the plan deducts $380.00 (full assigned load)');
  const waterfall = page('calendarWaterfallHtml', view, { applied: true, operatingPlan: 'live',
    observedAsOf: asOf }, advice.paydayAllocation, plan(SHAPES[0][1]));
  ok(waterfall.includes('$4,220.00') && !waterfall.includes('$4,400.00'),
    'Budget page waterfall prints BAD $4,220.00, never $4,400.00');
  const line = page('periodBillLine', row(period, 'phone'));
  ok(/in opening balance · to confirm/.test(line) && !/PAID/.test(line.replace(/data-[a-z-]+="[^"]*"/g, '')),
    'legacy calendar line: Phone reads "in opening balance · to confirm"');
  // The calendar Bills note describes the same full-load rule the figure follows.
  const note = page('calendarPeriodBillsHtml', period);
  ok(/The Bills deduction uses the assigned amounts of every bill in this period, paid or not\./.test(note)
      && !/excluding bills already settled in the opening/.test(note),
    'legacy calendar Bills note states the full-load rule, not the old opening exclusion');
}

console.log('\n=== 6. Talk carries the corrected figure ===');
{
  const p = plan(SHAPES[0][1]);
  const packet = Assistant.buildPacket({ data: { plan: p, debts: [] }, periods: Assistant.loadPeriods(),
    now: '2026-09-06T18:00:00.000Z', env: {}, questionsMarkdown: '' });
  const peb = packet.forecast && packet.forecast.predictedEndingBalance;
  ok(peb && peb.status === 'ok' && near(Number(peb.amount), BAD) && peb.trust === 'calculated',
    `Talk packet balance-after-deductions is $${BAD}, calculated`, peb ? JSON.stringify(peb) : '');
}

console.log('\n=== 7. Talk never qualifies BAD more strongly than Forecast (Atlas #923 finding 1) ===');
{
  // Internet (08-30) is now a BAD dependency even though it sits inside the
  // opening. Its confidence must reach Talk: estimated stays estimated;
  // unknown makes Forecast's BAD unavailable, so Talk withholds the amount.
  // Real path: Assistant.buildPacket -> TalkWhy.publishablePaths ->
  // TalkPresentation.presentVerifiedClaims.
  const TalkWhy = require('../scripts/talk-why');
  const TalkSession = require('../scripts/talk-session');
  const TalkPresentation = require('../scripts/talk-presentation');
  const talk = confidence => {
    const p = plan(SHAPES[0][1]);
    p.bills.find(b => b.id === 'internet').confidence = confidence;
    const view = active(advise(p, '2026-09-06'));
    const packet = Assistant.buildPacket({ data: { plan: p, debts: [] }, periods: Assistant.loadPeriods(),
      now: '2026-09-06T18:00:00.000Z', env: {}, questionsMarkdown: '' });
    const claims = TalkWhy.publishablePaths([TalkSession.LEFTOVER_PATH], packet);
    const out = TalkPresentation.presentVerifiedClaims({ status: 'explained', claims }, packet);
    return { view, peb: packet.forecast.predictedEndingBalance, out };
  };
  const shown = out => !!(out && out.answer && out.answer.includes(TalkPresentation.formatCurrency(BAD)));
  const cites = out => ((out && out.citations) || []).map(c => c.trust).filter(Boolean);
  const confirmed = talk('confirmed');
  ok(confirmed.view.balanceAfterDeductionsTrust == null && shown(confirmed.out)
      && confirmed.out.trust === 'calculated' && cites(confirmed.out).every(t => t === 'calculated'),
    'confirmed opening bill: Forecast calculated; Talk prints $4,220.00 as calculated');
  const estimated = talk('estimated');
  ok(estimated.view.balanceAfterDeductionsTrust === 'estimated' && estimated.peb.trust === 'estimated'
      && shown(estimated.out) && estimated.out.trust === 'estimated'
      && cites(estimated.out).includes('estimated') && !cites(estimated.out).includes('calculated'),
    'estimated opening bill: Forecast estimated; packet, Talk answer and citation all say estimated');
  const unknown = talk('unknown');
  ok(unknown.view.balanceAfterDeductionsTrust === 'unavailable' && unknown.peb.status === 'unavailable'
      && unknown.peb.amount === undefined && !shown(unknown.out) && unknown.out.trust === 'unavailable',
    'unknown opening bill: Forecast unavailable; the packet withholds the amount and Talk does not print it');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll full-period BAD bill-load checks passed.');
