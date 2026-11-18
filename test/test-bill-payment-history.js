'use strict';
/* Dale (2026-11-18, via the lead): the bill sheet's "Last 6 months" box shows each bill's and plain obligation's
 * identified posted payments for the last six calendar months, one bar per month, with the average and range, every
 * value calculated from Lunch Money with the read date. Built from the existing 200-day history read with the same
 * identification derivedAmountFixedBills uses; no new GET, no new matching.
 *
 * Path: invented raw Lunch Money payloads (the live window plus the 200-day history read) -> scripts/provider-observe.js
 * billPaymentHistory -> scripts/live-plan.js (acceptance harness, as server.js serves /data.json)
 * -> liveOverlay.billPaymentHistory -> Forecast.billPaymentHistorySummary -> BillDetail.historyHtml (the page's box).
 *
 * Invented world: the acceptance harness base world as of Wed 2026-10-14, so the six months are May to Oct 2026 and
 * the read date is 2026-10-14. All rows are paid from chequing-a and identified by payee. By hand:
 *   internet, monthly on the 12th: 80 (Apr 12, before the six months), then May 80, Jun 80, Jul 85.50, Aug 80,
 *     Sep 80, Oct 80. Six payments in the box; sum 485.50, average 485.50 / 6 = 80.9166.. = $80.92;
 *     range $80.00 - $85.50.
 *   insurance, quarterly on the 20th: Jun 20 300, Sep 20 310.25. Two payments; average 610.25 / 2 = 305.125 =
 *     $305.13 (half a cent rounds up); range $300.00 - $310.25; May, Jul, Aug, Oct empty.
 *   phone, monthly on the 5th: 50 in May, Jun, Aug, Sep, Oct; nothing in Jul. Jul is an empty bar, never $0;
 *     average $50.00, range $50.00 - $50.00.
 *   gym, monthly on the 3rd: one payment, Oct 3 40. The box shows it; average and range are "not enough history".
 *   water and sewer, two bills whose rules both identify the same payee: every such row is left out of both, and
 *     each says how many (three in the six months, Aug, Sep and Oct).
 *
 * `node test/test-bill-payment-history.js`
 */
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');
const Detail = require('../public/bill-detail.js');
const Observer = require('../scripts/provider-observe.js');
const Memory = require('../scripts/server-observation-memory.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const pay = (payee, date, amount) => H.lm({ date, amount, account: 'chequing-a', payee, category: 'Utilities' });
const bill = (id, label, payee, frequency, day, amount, extra = {}) => ({ id, label, amount, frequency, day,
  confidence: 'confirmed', payee, ...extra });
const BILLS = [
  bill('internet', 'Invented internet', 'Invented internet co', 'monthly', 12, 80),
  bill('insurance', 'Invented insurance', 'Invented insurer', 'quarterly', 20, 300, { anchor: '2026-06-20' }),
  bill('phone', 'Invented phone', 'Invented phone co', 'monthly', 5, 50),
  bill('gym', 'Invented gym', 'Invented gym co', 'monthly', 3, 40),
  bill('water', 'Invented water', 'Invented utility', 'monthly', 25, 30),
  bill('sewer', 'Invented sewer', 'Invented utility', 'monthly', 25, 30),
];
const HISTORY = [
  pay('Invented internet co', '2026-04-12', 80), pay('Invented internet co', '2026-05-12', 80),
  pay('Invented internet co', '2026-06-12', 80), pay('Invented internet co', '2026-07-12', 85.5),
  pay('Invented internet co', '2026-08-12', 80), pay('Invented internet co', '2026-09-12', 80),
  pay('Invented internet co', '2026-10-12', 80),
  pay('Invented insurer', '2026-06-20', 300), pay('Invented insurer', '2026-09-20', 310.25),
  ...['2026-05-05', '2026-06-05', '2026-08-05', '2026-09-05', '2026-10-05'].map(d => pay('Invented phone co', d, 50)),
  pay('Invented gym co', '2026-10-03', 40),
  ...['2026-08-25', '2026-09-25'].map(d => pay('Invented utility', d, 30)),
];
const PAYEES = ['Invented internet co', 'Invented insurer', 'Invented phone co', 'Invented gym co', 'Invented utility'];

function serve({ history = { transactions: HISTORY }, bills = BILLS, patch } = {}) {
  const w = H.baseWorld();
  w.bills = bills;
  w.transactions = [pay('Invented utility', '2026-10-13', 30)];
  // As in production, the 200-day read overlaps the live window, so it also carries the live window's rows.
  if (history) w.amountHistory = { ...history, transactions: (history.transactions || []).concat(w.transactions) };
  const r = H.dataOf(w);
  if (r.error) throw r.error;
  if (patch) patch(r.data);
  const box = id => Detail.historyHtml({ id }, r.data);
  return { data: r.data, series: r.data.liveOverlay.billPaymentHistory, box, w };
}
// The box, read back: each month's paid flag, amount and dates, and the stats line.
function read(html) {
  const months = [...html.matchAll(/<li data-bill-history-month="([^"]+)" data-bill-history-paid="(true|false)"[^>]*>.*?<span class="bill-history-amount">([^<]*)<\/span><span class="bill-history-dates">([^<]*)<\/span><\/li>/g)]
    .map(m => ({ month: m[1], paid: m[2] === 'true', amount: m[3], dates: m[4] }));
  const stats = (html.match(/<p data-bill-history-stats>([^<]*)<\/p>/) || [])[1] || '';
  const status = (html.match(/data-bill-history-status="([^"]+)"/) || [])[1];
  const reason = (html.match(/data-bill-history-reason="([^"]+)"/) || [])[1];
  return { months, stats, status, reason };
}

const s = serve();
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];

console.log('1. The published series: dates and amounts only, the six months, the read date');
{
  ok(s.series && s.series.status === 'complete' && s.series.asOf === '2026-10-14'
    && JSON.stringify(s.series.months) === JSON.stringify(MONTHS), 'complete, read 2026-10-14, months May to Oct 2026',
  JSON.stringify(s.series && { status: s.series.status, asOf: s.series.asOf, months: s.series.months }));
  const entry = id => (s.series.bills || []).find(b => b.billId === id);
  ok(JSON.stringify(entry('internet').payments) === JSON.stringify([['2026-05-12', 80], ['2026-06-12', 80], ['2026-07-12', 85.5],
    ['2026-08-12', 80], ['2026-09-12', 80], ['2026-10-12', 80]].map(([date, amount]) => ({ date, amount }))),
  'internet: the six payments in the six months, the April one left out', JSON.stringify(entry('internet').payments));
  ok(JSON.stringify(entry('insurance').payments) === JSON.stringify([{ date: '2026-06-20', amount: 300 }, { date: '2026-09-20', amount: 310.25 }]),
    'insurance: its two quarterly payments');
  ok(entry('water').payments.length === 0 && entry('water').excludedAmbiguous === 3
    && entry('sewer').payments.length === 0 && entry('sewer').excludedAmbiguous === 3,
  'water and sewer: the three rows both rules identify are left out of both, and counted',
  JSON.stringify([entry('water'), entry('sewer')]));
  const blob = JSON.stringify(s.series);
  ok(PAYEES.every(p => !blob.includes(p)), 'no payee text reaches the published series');
  const keys = new Set();
  for (const b of s.series.bills) { Object.keys(b).forEach(k => keys.add('bill.' + k)); b.payments.forEach(p => Object.keys(p).forEach(k => keys.add('payment.' + k))); }
  ok([...keys].sort().join() === ['bill.billId', 'bill.excludedAmbiguous', 'bill.payments', 'bill.status', 'payment.amount', 'payment.date'].join(),
    'each row publishes only its id, status, payments (date, amount) and the left-out count', [...keys].sort().join());
  ok(!blob.includes('"id"') && !blob.includes('note') && !blob.includes('category'), 'no provider id, note or category');
}

console.log('2. The box, against the hand values');
{
  const internet = read(s.box('internet'));
  ok(internet.status === 'complete' && internet.months.length === 6 && internet.months.every(m => m.paid)
    && JSON.stringify(internet.months.map(m => m.amount)) === JSON.stringify(['$80.00', '$80.00', '$85.50', '$80.00', '$80.00', '$80.00']),
  'internet: six paid bars, $85.50 in July', JSON.stringify(internet.months.map(m => m.amount)));
  ok(internet.months[2].dates === '2026-07-12' && internet.months[2].amount === '$85.50', 'each bar names its payment\'s date and amount',
    internet.months[2].dates);
  // A month with two payments (an invented biweekly row) lists each date and amount; the bar is their total.
  const twice = Detail.historyHtml({ id: 'twice' }, { ...s.data, liveOverlay: { ...s.data.liveOverlay, billPaymentHistory: { ...s.series,
    bills: [{ billId: 'twice', status: 'complete', payments: [{ date: '2026-10-01', amount: 20 }, { date: '2026-10-13', amount: 25.5 }] }] } } });
  const oct = read(twice).months[5];
  ok(oct.paid && oct.amount === '$45.50' && oct.dates === '2026-10-01 $20.00, 2026-10-13 $25.50',
    'two payments in a month: the bar is 20 + 25.50 = $45.50 and each date and amount is listed', JSON.stringify(oct));
  ok(internet.stats.startsWith('Average payment: $80.92 · Range: $80.00 – $85.50 · calculated · Lunch Money, read 2026-10-14'),
    'internet: average $80.92, range $80.00 – $85.50, calculated, read 2026-10-14', internet.stats);
  const insurance = read(s.box('insurance'));
  ok(JSON.stringify(insurance.months.map(m => m.paid)) === JSON.stringify([false, true, false, false, true, false])
    && insurance.months[1].amount === '$300.00' && insurance.months[4].amount === '$310.25',
  'insurance: Jun and Sep paid, the other four empty', JSON.stringify(insurance.months));
  ok(insurance.stats.startsWith('Average payment: $305.13 · Range: $300.00 – $310.25'), 'insurance: average $305.13, range $300.00 – $310.25', insurance.stats);
  const phone = read(s.box('phone'));
  const july = phone.months.find(m => m.month === '2026-07');
  ok(july && !july.paid && july.amount === '—' && july.dates === 'No payment identified' && !/\$0\.00/.test(s.box('phone')),
    'phone: July is an empty bar reading "No payment identified", never $0', JSON.stringify(july));
  ok(phone.stats.startsWith('Average payment: $50.00 · Range: $50.00 – $50.00'), 'phone: average $50.00 over the five payments', phone.stats);
  const gym = read(s.box('gym'));
  ok(gym.months.filter(m => m.paid).length === 1 && gym.months[5].amount === '$40.00'
    && gym.stats.startsWith('Average: not enough history · Range: not enough history'),
  'gym: its one payment shows, and average and range say not enough history', gym.stats);
  const water = s.box('water');
  ok(read(water).months.every(m => !m.paid) && /3 payments matched another bill too and are left out\./.test(water),
    'water: no bar, and the box says three payments were left out');
  ok(/Calculated · source: Lunch Money posted payments · read 2026-10-14/.test(s.box('internet')), 'the box is tagged calculated, source Lunch Money, with the read date');
  // The page's own summary: Forecast owns the arithmetic, BillDetail only prints it.
  const sum = F.billPaymentHistorySummary(s.series.bills.find(b => b.billId === 'insurance'), s.series.months);
  ok(sum && sum.average === 305.13 && sum.min === 300 && sum.max === 310.25 && sum.count === 2
    && sum.months.filter(m => m.total === null).length === 4, 'Forecast.billPaymentHistorySummary: the same values, empty months null');
}

console.log('3. Unavailable keeps "Unavailable" with a reason');
{
  const incomplete = serve({ history: { transactions: HISTORY, coverage: { complete: false } } });
  const a = read(incomplete.box('internet'));
  ok(incomplete.series.status === 'unavailable' && a.status === 'unavailable' && a.reason === 'history-incomplete'
    && /Unavailable · the Lunch Money payment history read was incomplete\./.test(incomplete.box('internet'))
    && /Average: Unavailable · Range: Unavailable\./.test(incomplete.box('internet')), 'an incomplete history read: Unavailable, read incomplete');
  const truncated = serve({ history: { transactions: HISTORY, coverage: { truncated: true } } });
  ok(read(truncated.box('internet')).reason === 'history-incomplete', 'a truncated history read: Unavailable, read incomplete');
  const none = serve({ history: null });
  ok(none.series === undefined && read(none.box('internet')).reason === 'history-unavailable',
    'no history read (a browser read without it): Unavailable, history could not be read');
  const short = serve({ history: { transactions: HISTORY, startDate: '2026-05-02' } });
  ok(read(short.box('internet')).reason === 'history-too-short', 'a read that does not reach May 1: Unavailable, too short');
  const stale = serve({ patch: data => { data.liveOverlay.observedAsOf = '2026-10-13'; } });
  ok(read(stale.box('internet')).reason === 'observation', 'a stale overlay: Unavailable, the live read is not current');
  ok(read(s.box('not-a-bill')).reason === 'no-identity', 'a row with no payment identity: Unavailable, no identity');
  const parts = serve({ bills: BILLS.map(b => (b.id === 'internet' ? { ...b, rule: { settlesWhen: 'two-leg-sum' } } : b)) });
  ok(read(parts.box('internet')).reason === 'paid-in-parts', 'a two-leg rule: Unavailable, paid in parts');
  // Codex P1 on #1379: the read delivering one posted row twice (same provider id). By hand that is one $80 payment,
  // never $160, so the row has no single identity: the box is Unavailable, and the bill is not derived fixed.
  const sep = HISTORY.find(t => t.date === '2026-09-05');
  const dup = serve({ history: { transactions: HISTORY.concat([{ ...sep }]) } });
  const dupEntry = dup.series.bills.find(b => b.billId === 'phone');
  ok(dupEntry && dupEntry.status === 'unavailable' && dupEntry.reason === 'duplicate-record' && dupEntry.payments.length === 0
    && read(dup.box('phone')).reason === 'duplicate-record' && !/\$100\.00/.test(dup.box('phone')),
  'a posted row delivered twice: Unavailable, never counted twice', JSON.stringify(dupEntry));
  ok(dup.data.plan.bills.find(b => b.id === 'phone').amountFixed !== true, 'the same duplicate leaves the bill not derived fixed');
  ok(read(dup.box('internet')).status === 'complete', 'other bills keep their history');
}

console.log('4. Replay equals live; memory keeps the clean series only');
{
  const cleaned = Memory.billPaymentHistory(s.series);
  ok(JSON.stringify(cleaned) === JSON.stringify(s.series), 'the memory cleaner returns the live series unchanged');
  // The observer fed the clean record (a warm read) builds the same series as the live read.
  // The observer fed the clean record in place of the rows (the warm read's input; the full memory round trip through
  // applyForServer is test-derived-amount-fixed-replay.js) builds the same served data as the live read.
  const w = H.baseWorld();
  w.bills = BILLS;
  w.transactions = [pay('Invented utility', '2026-10-13', 30)];
  w.amountHistory = { transactions: HISTORY.concat(w.transactions) };
  H.productionOpening(w);
  const input = { data: H.canonicalOf(w, H.planOf(w)), accountMap: H.accountMapOf(w), identity: H.identityOf(w) };
  const Live = require('../scripts/live-plan');
  const { amountHistory, ...rest } = H.rawPayload(w);
  const live = Live.fromObservation({ ...input, payload: { ...rest, amountHistory } });
  const warm = Live.fromObservation({ ...input, payload: { ...rest,
    amountFixedDerivation: Memory.amountFixedDerivation(live.report.derivedAmountFixed),
    billPaymentHistory: Memory.billPaymentHistory(live.report.billPaymentHistory) } });
  ok(live.data.liveOverlay.billPaymentHistory.bills.length === 6
    && JSON.stringify(warm.data) === JSON.stringify(live.data), 'a replay from the memory record serves exactly the live data, series included');
  const forged = Memory.billPaymentHistory({ ...s.series, bills: [{ billId: 'internet', status: 'complete',
    payments: [{ date: '2026-07-12', amount: 85.5, payee: 'Invented internet co' }] }] });
  ok(!JSON.stringify(forged).includes('Invented internet co'), 'a record carrying a payee keeps only date and amount');
  const bad = Memory.billPaymentHistory({ ...s.series, bills: [{ billId: 'internet', status: 'complete', payments: [{ date: '2026-03-12', amount: 80 }] }] });
  ok(bad.status === 'unavailable' && bad.bills.length === 0, 'a payment outside the six months: the record replays as unavailable');
  const hostile = Memory.billPaymentHistory({ ...s.series, bills: [{ billId: 'internet', status: 'complete', payments: [{ date: '2026-07-<b>', amount: 80 }] }] });
  ok(hostile.status === 'unavailable', 'a malformed date: the record replays as unavailable');
  // Escaping: even a hostile series served past the cleaner prints no markup.
  const page = Detail.historyHtml({ id: 'internet' }, { ...s.data, liveOverlay: { ...s.data.liveOverlay,
    billPaymentHistory: { ...s.series, bills: [{ billId: 'internet', status: 'complete', payments: [{ date: '2026-07-<b>', amount: 80 }] }] } } });
  ok(!page.includes('<b>') && read(page).status === 'unavailable', 'a hostile date never reaches the page as markup');
}

console.log('5. No new GET, and the flag is unchanged');
{
  ok(typeof Observer.billPaymentHistory === 'function' && Observer.AMOUNT_HISTORY_DAYS === 200, 'the series reads the existing 200-day read');
  const internetFixed = s.data.plan.bills.find(b => b.id === 'internet').amountFixed;
  ok(internetFixed !== true, 'internet (85.50 once in its last six) is not derived fixed: the derivation is unchanged');
  const phoneFixed = s.data.plan.bills.find(b => b.id === 'phone').amountFixed;
  ok(phoneFixed === true, 'phone (five completed $50 payments) is still derived fixed');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll bill payment history checks passed.');
