'use strict';
/* Calendar / Budget bill rows reprint Forecast Paid from representedActuals.
 *
 * Schedule-trust writes id@date into currentPeriodActuals.representedActuals.
 * representedKeySet does not consult that packet, so a past-due same-period
 * occurrence can sit in actuals while calendarBillRowFromEvent still prints
 * unverified / still due. This suite proves the calendar Paid reprint, not
 * a new identity rule and not a settle-amount invention.
 *
 * Synthetic cents and direct fixture arithmetic (L-002 / L-006).
 *
 * `node test/test-calendar-represented-actuals-paid.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const polish = require('../public/budget-polish.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const PAYDAY = '2026-09-11';
const AS_OF = '2026-09-19';
const PRIOR = '2026-08-19';
const SPOTIFY_ID = 'spotify';
const SPOTIFY_DUE = '2026-09-17';
const SPOTIFY_AMT = 11.11;
const DALE_ID = 'chatgpt-plus-dale';
const DALE_DUE = '2026-09-14';
const DALE_AMT = 22.22;
const AMANDA_ID = 'chatgpt-plus-amanda';
const AMANDA_DUE = '2026-09-14';
const AMANDA_AMT = 33.33;
const NETFLIX_ID = 'netflix';
const NETFLIX_DUE = '2026-09-17';
const NETFLIX_AMT = 44.44;
const ICLOUD_ID = 'icloud-storage';
const ICLOUD_DUE = '2026-09-16';
const ICLOUD_AMT = 55.55;
const UNPAID_TOTAL = roundCent(
  SPOTIFY_AMT + DALE_AMT + AMANDA_AMT + NETFLIX_AMT + ICLOUD_AMT);
const AFTER_TRUST_REMAINING = roundCent(AMANDA_AMT + NETFLIX_AMT + ICLOUD_AMT);
const TRUST_PAID = roundCent(SPOTIFY_AMT + DALE_AMT);

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function periodBillLine\([\s\S]*?\n\}$/m, 'periodBillLine'),
    grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ periodBillLine, calendarPeriodBillsHtml, money2 });`,
    { Forecast: F }
  );
}

function syntheticPlan(opening) {
  return {
    windowDays: 40,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 4000 },
    opening: opening || {
      asOf: AS_OF,
      priorAsOf: PRIOR,
      representedEvents: [],
    },
    income: [{
      id: 'payroll', label: 'Payroll', frequency: 'biweekly',
      anchor: PAYDAY, amount: 2000, confidence: 'confirmed',
    }],
    obligations: [],
    commitments: [],
    bills: [
      {
        id: SPOTIFY_ID, label: 'Spotify', frequency: 'monthly',
        day: 17, amount: SPOTIFY_AMT, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: DALE_ID, label: 'ChatGPT Plus — Dale', frequency: 'monthly',
        day: 14, amount: DALE_AMT, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: AMANDA_ID, label: 'ChatGPT Plus — Amanda', frequency: 'monthly',
        day: 14, amount: AMANDA_AMT, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: NETFLIX_ID, label: 'Netflix', frequency: 'monthly',
        day: 17, amount: NETFLIX_AMT, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: ICLOUD_ID, label: 'iCloud Storage', frequency: 'monthly',
        day: 16, amount: ICLOUD_AMT, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
    ],
  };
}

function actualsPacket(rows) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: AS_OF,
    coverageStart: PRIOR,
    coverageThrough: AS_OF,
    pendingCoverage: 'complete',
    representedActuals: rows || [],
    transactions: [],
  };
}

function trustActuals() {
  return [
    { id: SPOTIFY_ID, date: SPOTIFY_DUE, actual: SPOTIFY_AMT },
    { id: DALE_ID, date: DALE_DUE, actual: DALE_AMT },
  ];
}

function recommend(plan, extra) {
  return F.recommend(plan, AS_OF, Object.assign({
    targetBuffer: 0,
    debts: [],
  }, extra || {}));
}

function calendarBill(advice, id, date) {
  const periods = (((advice && advice.defaultView) || {}).calendarPeriods) || [];
  for (const period of periods) {
    const hit = ((period && period.bills) || []).find(row =>
      row && row.id === id && (!date || row.date === date));
    if (hit) return { period, row: hit };
  }
  return { period: null, row: null };
}

function remainingOf(advice) {
  const active = (((advice && advice.defaultView) || {}).calendarPeriods || [])
    .find(p => p && p.role === 'active');
  if (!active) return null;
  if (active.remainingBills != null) return roundCent(active.remainingBills);
  return roundCent(((active.bills) || []).reduce((sum, row) => {
    if (!row || row.status === 'PAID' || row.needsDate) return sum;
    return sum + Math.abs(Number(row.remaining != null ? row.remaining : row.amount) || 0);
  }, 0));
}

function paidDisclosureOf(advice) {
  const active = (((advice && advice.defaultView) || {}).calendarPeriods || [])
    .find(p => p && p.role === 'active');
  return active && active.paidBills != null ? roundCent(active.paidBills) : null;
}

function isPaid(row) {
  return !!(row && row.settlement === 'represented' && row.status === 'PAID'
    && near(row.remaining, 0));
}

function isUnpaid(row) {
  return !!(row && row.settlement !== 'represented' && row.status !== 'PAID'
    && Number(row.remaining) > 0);
}

const page = loadComposer();

console.log('=== 1. representedActuals alone reprints Spotify / Dale ChatGPT as PAID ===');
{
  const unpaid = recommend(syntheticPlan(), {
    currentPeriodActuals: actualsPacket([]),
  });
  const paid = recommend(syntheticPlan(), {
    currentPeriodActuals: actualsPacket(trustActuals()),
  });
  const unpaidSpotify = calendarBill(unpaid, SPOTIFY_ID, SPOTIFY_DUE).row;
  const unpaidDale = calendarBill(unpaid, DALE_ID, DALE_DUE).row;
  ok(isUnpaid(unpaidSpotify) && isUnpaid(unpaidDale),
    'without representedActuals and without qualifying representedEvents, Spotify and Dale ChatGPT stay unpaid');
  ok(near(remainingOf(unpaid), UNPAID_TOTAL) && near(paidDisclosureOf(unpaid), 0),
    'independent unpaid remaining is 11.11+22.22+33.33+44.44+55.55 = 166.65; paid disclosure $0',
    `${remainingOf(unpaid)} remaining / ${paidDisclosureOf(unpaid)} paid`);

  const spotify = calendarBill(paid, SPOTIFY_ID, SPOTIFY_DUE).row;
  const dale = calendarBill(paid, DALE_ID, DALE_DUE).row;
  ok(isPaid(spotify) && near(spotify.actual, SPOTIFY_AMT),
    'spotify@due with representedActuals is settlement represented / status PAID at the packet amount');
  ok(isPaid(dale) && near(dale.actual, DALE_AMT),
    'chatgpt-plus-dale@due with representedActuals is settlement represented / status PAID at the packet amount');
  ok(near(remainingOf(paid), AFTER_TRUST_REMAINING)
      && near(roundCent(remainingOf(unpaid) - remainingOf(paid)), TRUST_PAID),
    'remaining bills drop independently by 11.11+22.22 = 33.33',
    `${remainingOf(unpaid)} → ${remainingOf(paid)}`);
  ok(near(paidDisclosureOf(paid), TRUST_PAID),
    'paid-bills disclosure reprints the two packet amounts, not an invented settle');

  const html = page.calendarPeriodBillsHtml(calendarBill(paid, SPOTIFY_ID).period);
  ok(html.includes(`data-period-bill="${SPOTIFY_ID}" data-bill-status="PAID"`)
      && html.includes(`data-period-bill="${DALE_ID}" data-bill-status="PAID"`),
    'periodBillLine reprints Forecast PAID for both representedActuals rows');
  ok(polish.planningBillChrome('PAID', SPOTIFY_DUE, AS_OF).label === 'Paid'
      && polish.planningBillChrome('PAID', DALE_DUE, AS_OF).label === 'Paid',
    'Budget polish reprints confirmed Paid regardless of schedule dates');
}

console.log('\n=== 2. Amanda ChatGPT, iCloud, and Netflix stay unpaid without their own actuals ===');
{
  const paid = recommend(syntheticPlan(), {
    currentPeriodActuals: actualsPacket(trustActuals()),
  });
  ok(isUnpaid(calendarBill(paid, AMANDA_ID, AMANDA_DUE).row),
    'chatgpt-plus-amanda is unchanged: no representedActuals row, still unpaid');
  ok(isUnpaid(calendarBill(paid, ICLOUD_ID, ICLOUD_DUE).row),
    'icloud-storage is unchanged: Dale/Spotify actuals do not settle it');
  ok(isUnpaid(calendarBill(paid, NETFLIX_ID, NETFLIX_DUE).row),
    'Netflix identity-plus-evidence is unchanged: empty actuals do not mark Netflix PAID');
  const html = page.calendarPeriodBillsHtml(calendarBill(paid, AMANDA_ID).period);
  ok([AMANDA_ID, ICLOUD_ID, NETFLIX_ID].every(id => calendarBill(paid, id).row.settlement === 'unverified'),
    'each unmatched occurrence retains Forecast unverified settlement');
  ok(html.includes(`data-period-bill="${AMANDA_ID}" data-bill-status="to confirm"`)
      && html.includes(`data-period-bill="${ICLOUD_ID}" data-bill-status="to confirm"`)
      && html.includes(`data-period-bill="${NETFLIX_ID}" data-bill-status="to confirm"`),
    'page labels each unmatched occurrence to confirm rather than claiming confirmed unpaid');
}

console.log('\n=== 3. Netflix identity-plus-evidence still pays only from its own actual ===');
{
  const withNetflix = recommend(syntheticPlan(), {
    currentPeriodActuals: actualsPacket(trustActuals().concat([{
      id: NETFLIX_ID, date: NETFLIX_DUE, actual: NETFLIX_AMT,
    }])),
  });
  ok(isPaid(calendarBill(withNetflix, NETFLIX_ID, NETFLIX_DUE).row),
    'a Netflix representedActuals row still reprints Netflix as PAID');
  ok(isPaid(calendarBill(withNetflix, SPOTIFY_ID, SPOTIFY_DUE).row)
      && isPaid(calendarBill(withNetflix, DALE_ID, DALE_DUE).row),
    'adding Netflix evidence does not drop Spotify or Dale ChatGPT Paid');
  ok(isUnpaid(calendarBill(withNetflix, AMANDA_ID, AMANDA_DUE).row)
      && isUnpaid(calendarBill(withNetflix, ICLOUD_ID, ICLOUD_DUE).row),
    'Netflix evidence does not settle Amanda ChatGPT or iCloud');
  ok(near(remainingOf(withNetflix), roundCent(AMANDA_AMT + ICLOUD_AMT)),
    'remaining after Netflix evidence is independently 33.33+55.55 = 88.88',
    String(remainingOf(withNetflix)));
}

console.log('\n=== 4. qualifying representedEvents still pay without representedActuals ===');
{
  const byEvents = recommend(syntheticPlan({
    asOf: AS_OF,
    priorAsOf: PRIOR,
    representedEvents: [
      { id: SPOTIFY_ID, date: SPOTIFY_DUE },
      { id: DALE_ID, date: DALE_DUE },
    ],
  }), { currentPeriodActuals: actualsPacket([]) });
  ok(isPaid(calendarBill(byEvents, SPOTIFY_ID, SPOTIFY_DUE).row)
      && isPaid(calendarBill(byEvents, DALE_ID, DALE_DUE).row),
    'existing representedKeySet Paid path is unchanged when the opening names the occurrence');
  ok(isUnpaid(calendarBill(byEvents, AMANDA_ID, AMANDA_DUE).row)
      && isUnpaid(calendarBill(byEvents, NETFLIX_ID, NETFLIX_DUE).row),
    'named representedEvents do not settle Amanda ChatGPT or Netflix');
}

console.log('\n=== 5. past-due representedEvents that fail prepaid still reprint from actuals ===');
{
  const staleOpening = syntheticPlan({
    asOf: PRIOR,
    representedEvents: [],
  });
  const droppedEvents = recommend(staleOpening, {
    representedEvents: [
      { id: SPOTIFY_ID, date: SPOTIFY_DUE },
      { id: DALE_ID, date: DALE_DUE },
    ],
    currentPeriodActuals: actualsPacket([]),
  });
  ok(isUnpaid(calendarBill(droppedEvents, SPOTIFY_ID, SPOTIFY_DUE).row)
      && isUnpaid(calendarBill(droppedEvents, DALE_ID, DALE_DUE).row),
    'past-due representedEvents without a matching opening asOf fail prepaid and stay unpaid');
  const rescued = recommend(staleOpening, {
    representedEvents: [
      { id: SPOTIFY_ID, date: SPOTIFY_DUE },
      { id: DALE_ID, date: DALE_DUE },
    ],
    currentPeriodActuals: actualsPacket(trustActuals()),
  });
  ok(isPaid(calendarBill(rescued, SPOTIFY_ID, SPOTIFY_DUE).row)
      && isPaid(calendarBill(rescued, DALE_ID, DALE_DUE).row),
    'the same dropped events still reprint PAID once representedActuals names id@date');
  ok(isUnpaid(calendarBill(rescued, AMANDA_ID, AMANDA_DUE).row)
      && isUnpaid(calendarBill(rescued, ICLOUD_ID, ICLOUD_DUE).row)
      && isUnpaid(calendarBill(rescued, NETFLIX_ID, NETFLIX_DUE).row),
    'rescue via representedActuals does not invent Amanda, iCloud, or Netflix Paid');
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nCalendar representedActuals Paid reprint checks passed.');
