'use strict';
/* Owner 2026-09-19 Bell Mobility amounts on Forecast bill authority.
 *
 * September 2026 is the once row bell-sep15-2026 $283.94 due 2026-09-15
 * (owner 2026-09-19 catch-up / wife payment-mess total; supersedes $265.65).
 * Standing recurring bell is $160/month from firstDue 2026-10-15 so Sep
 * is not 283.94+160. The September once stays travelvisa / jointCash false.
 * Standing Bell from October is a BILLS ACCOUNT joint-cash withdrawal.
 * Amount encoding does not invent settledOn / representedEvents on the
 * bill rows. Travel Visa settlement identity is a separate outcome.
 *
 * Independent proof (L-002 / L-006): hand-listed 15ths from firstDue,
 * owner amounts as literals, not a second expandEvents call as the spec.
 *
 * `node test/test-bell-sep15-2026.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const { independentlyBillOccurrenceAmount, cardPaidReservedTotal } = require('./test-helpers');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const ONCE_ID = 'bell-sep15-2026';
const STANDING_ID = 'bell';
const ONCE_AMT = 283.94;
const STANDING_AMT = 160;
const HISTORICAL = 121;
const ONCE_DUE = '2026-09-15';
const FIRST_DUE = '2026-10-15';
const DAY = 15;
const PAYER = 'travelvisa';
const HORIZON_END = '2026-12-31';
const OPENING = 20000;

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function independentMonthlyDates(day, start, end, firstDue) {
  const out = [];
  let [y, m] = start.split('-').map(Number);
  for (;;) {
    const d = Math.min(day, daysInMonth(y, m));
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (iso > end) break;
    if (iso >= start && (!firstDue || iso >= firstDue)) out.push(iso);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function fixturePlan() {
  return {
    windowDays: 120,
    defaults: { targetBuffer: 0 },
    startingCash: {
      amount: OPENING,
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: OPENING }],
    },
    income: [{
      id: 'payroll',
      label: 'Payroll — Seaspan',
      frequency: 'biweekly',
      anchor: '2026-08-14',
      amount: 4000,
      confidence: 'confirmed',
    }],
    obligations: [],
    bills: [
      {
        id: ONCE_ID,
        label: 'Bell Mobility — 15 September 2026',
        frequency: 'once',
        date: ONCE_DUE,
        amount: ONCE_AMT,
        confidence: 'confirmed',
        budgetCategory: 'telecom',
        payingAccount: PAYER,
        jointCash: false,
      },
      {
        id: STANDING_ID,
        label: 'Bell Mobility',
        frequency: 'monthly',
        day: DAY,
        firstDue: FIRST_DUE,
        amount: STANDING_AMT,
        confidence: 'confirmed',
        budgetCategory: 'telecom',
        payingAccount: 'chequing-a',
      },
    ],
    commitments: [],
  };
}

function liveData() {
  return load('data.json');
}

function bellRows(plan) {
  return ((plan && plan.bills) || []).filter(b =>
    b && (b.id === ONCE_ID || b.id === STANDING_ID
      || /bell/i.test(String(b.id || ''))
      || /bell mobility/i.test(String(b.label || ''))));
}

function bellEvents(events) {
  return (events || []).filter(e =>
    e && (e.id === ONCE_ID || e.id === STANDING_ID
      || /bell/i.test(String(e.id || ''))
      || /bell mobility/i.test(String(e.label || ''))));
}

console.log('=== 1. independent Sep once vs Oct+ standing dates ===');
{
  const expected = independentMonthlyDates(DAY, '2026-09-01', HORIZON_END, FIRST_DUE);
  ok(expected.join(',') === '2026-10-15,2026-11-15,2026-12-15',
    'hand list is 15 Oct, 15 Nov, 15 Dec — no September standing date',
    expected.join(','));
  ok(expected.every(d => d >= FIRST_DUE) && !expected.includes(ONCE_DUE),
    'firstDue 2026-10-15 excludes a 15 September standing occurrence');
  ok(near(ONCE_AMT, 283.94) && !near(ONCE_AMT, STANDING_AMT)
      && !near(ONCE_AMT, HISTORICAL) && !near(ONCE_AMT, 265.65)
      && !near(ONCE_AMT, ONCE_AMT + STANDING_AMT),
    'owner Sep total is $283.94, not $160, not $121, not superseded $265.65, and not 283.94+160');
  ok(near(STANDING_AMT, 160) && !near(STANDING_AMT, HISTORICAL),
    'owner standing is $160, not the retired $121 reconstruction');
  const onceBill = fixturePlan().bills.find(b => b.id === ONCE_ID);
  const standingBill = fixturePlan().bills.find(b => b.id === STANDING_ID);
  ok(near(independentlyBillOccurrenceAmount(onceBill, ONCE_DUE), ONCE_AMT),
    'independent helper keeps the Sep once at $283.94');
  ok(near(independentlyBillOccurrenceAmount(standingBill, FIRST_DUE), STANDING_AMT)
      && near(independentlyBillOccurrenceAmount(standingBill, '2026-11-15'), STANDING_AMT),
    'independent helper keeps Oct+ standing at $160');
}

console.log('\n=== 2. synthetic expandEvents: Sep is the once only ===');
{
  const plan = fixturePlan();
  const sep = bellEvents(F.expandEvents(plan, '2026-09-01', '2026-09-30', {}));
  const once = sep.filter(e => e.id === ONCE_ID);
  const standing = sep.filter(e => e.id === STANDING_ID);
  ok(sep.length === 1 && once.length === 1 && standing.length === 0,
    'September expands exactly one Bell cash obligation');
  ok(once[0].date === ONCE_DUE && near(-once[0].amount, ONCE_AMT)
      && once[0].cardPaid === true && once[0].jointCash === false
      && once[0].payingAccount === PAYER && once[0].confidence === 'confirmed',
    'that one September obligation is the $283.94 once on travelvisa');
  ok(!near(Math.abs(once[0].amount), ONCE_AMT + STANDING_AMT)
      && !near(Math.abs(once[0].amount), STANDING_AMT),
    'September is not 283.94+160 and not the standing $160');

  const later = bellEvents(F.expandEvents(plan, '2026-10-01', HORIZON_END, {}));
  const laterOnce = later.filter(e => e.id === ONCE_ID);
  const laterStanding = later.filter(e => e.id === STANDING_ID)
    .sort((a, b) => a.date.localeCompare(b.date));
  const expected = independentMonthlyDates(DAY, '2026-10-01', HORIZON_END, FIRST_DUE);
  ok(laterStanding.map(e => e.date).join(',') === expected.join(','),
    'October–December standing dates match the independent hand list',
    laterStanding.map(e => e.date).join(','));
  ok(laterStanding.length === 3 && laterStanding.every(e =>
      near(-e.amount, STANDING_AMT) && e.cardPaid !== true
      && e.jointCash !== false && e.payingAccount === 'chequing-a'),
    'Oct+ standing events are $160 joint-cash withdrawals from BILLS ACCOUNT');
  ok(laterOnce.length === 1 && laterOnce[0].date === ONCE_DUE
      && near(-laterOnce[0].amount, ONCE_AMT),
    'unpaid Sep once remains a single carried $283.94 event, not rewritten as $160');
  const engineSum = roundCent(laterStanding.reduce((s, e) => s + (-e.amount), 0));
  ok(near(engineSum, 480) && near(engineSum, STANDING_AMT * 3),
    'expandEvents standing total agrees with 3 × $160',
    String(engineSum));
}

console.log('\n=== 3. recommend on a window covering Sep 15 ===');
{
  const plan = fixturePlan();
  const rec = F.recommend(plan, '2026-09-10', {
    weeklyVariable: 0, targetBuffer: 0,
  });
  const listed = (rec.defaultView.bills || []).concat(
    (rec.defaultView.calendarPeriods || []).reduce((all, p) => all.concat(p.bills || []), []));
  const sepBell = listed.filter(r => r && (r.id === ONCE_ID || r.id === STANDING_ID)
    && r.date && r.date.startsWith('2026-09'));
  ok(sepBell.length >= 1 && sepBell.every(r => r.id === ONCE_ID
      && r.date === ONCE_DUE && near(r.amount, ONCE_AMT) && r.cardPaid === true),
    'as-of 10 Sep prints September Bell as the $283.94 once, not standing $160');
  ok(!sepBell.some(r => r.id === STANDING_ID || near(r.amount, STANDING_AMT)
      || near(r.amount, ONCE_AMT + STANDING_AMT)),
    'recommend does not also print $160 or 283.94+160 in September');
  ok(sepBell.every(r => !/BILLS ACCOUNT/i.test(r.payerLabel || '')
      && r.payingAccount === PAYER),
    'printed September Bell stays travelvisa, not a BILLS invent');
}

console.log('\n=== 4. travelvisa path; still-due without invented settle ===');
{
  const plan = fixturePlan();
  const reserved = F.expandEvents(plan, ONCE_DUE, '2026-09-30', {});
  const reservedHit = reserved.find(e => e.id === ONCE_ID && e.date === ONCE_DUE);
  ok(reservedHit && near(-reservedHit.amount, ONCE_AMT) && reservedHit.cardPaid === true,
    'without settlement evidence the Sep once stays reserved at $283.94');
  ok(!plan.bills.some(b => b.settledOn || (b.representedEvents && b.representedEvents.length)),
    'fixture does not invent settledOn or representedEvents on the Bell rows');
  const identity = load('docs/connectivity/transaction-identity.json');
  const onceRule = (identity.rules || []).find(r => r && r.eventId === ONCE_ID);
  const standingRule = (identity.rules || []).find(r => r && r.eventId === STANDING_ID
    && r.atlasAccountId === PAYER);
  ok(onceRule && standingRule
      && onceRule.atlasAccountId === 'chequing-a'
      && onceRule.direction === 'debit'
      && onceRule.settlesWhen === 'two-leg-sum'
      && onceRule.sameAccountSplitLegs === true
      && onceRule.settlesWhen !== 'schedule-trust-on-due'
      && standingRule.atlasAccountId === PAYER
      && standingRule.direction === 'debit'
      && !standingRule.settlesWhen
      && !standingRule.sameAccountSplitLegs,
    'September settlement is the explicit chequing-a split; the Travel Visa standing rule remains a single debit and neither invents schedule-trust');
  ok(near(ONCE_AMT, 283.94) && near(STANDING_AMT, 160),
    'amount-encoding literals stay $283.94 once and $160 standing');
  const sim = F.simulate(plan, '2026-09-10', { weeklyVariable: 0, horizonDays: 40 });
  ok(near(sim.totals.bills, STANDING_AMT) && near(sim.totals.reserved, ONCE_AMT),
    'standing Bell withdraws from joint cash; the September once stays reserved',
    `${sim.totals.reserved} reserved / ${sim.totals.bills} bills`);
}

console.log('\n=== 5. live plan encodes the owner amounts without a second planner ===');
{
  const live = liveData();
  const rows = bellRows(live.plan);
  const once = rows.find(b => b.id === ONCE_ID);
  const standing = rows.find(b => b.id === STANDING_ID);
  ok(once && once.frequency === 'once' && once.date === ONCE_DUE
      && near(once.amount, ONCE_AMT) && once.payingAccount === PAYER
      && once.jointCash === false && once.confidence === 'confirmed'
      && once.budgetCategory === 'telecom',
    'live bell-sep15-2026 is the confirmed $283.94 once on travelvisa / telecom');
  ok(standing && standing.frequency === 'monthly' && standing.day === DAY
      && standing.firstDue === FIRST_DUE && near(standing.amount, STANDING_AMT)
      && standing.payingAccount === 'chequing-a' && standing.jointCash !== false
      && standing.confidence === 'confirmed' && standing.budgetCategory === 'telecom',
    'live bell is confirmed $160 monthly from 2026-10-15 on BILLS ACCOUNT');
  ok(!rows.some(b => b.id !== ONCE_ID && b.id !== STANDING_ID),
    'live Bell bills are exactly the Sep once and the standing series',
    rows.map(b => b.id).join(','));
  ok(!near(standing.amount, HISTORICAL) && !rows.some(b => near(b.amount, HISTORICAL)),
    'retired $121 is not a live Bell bill amount');

  const facts = fs.readFileSync(path.join(__dirname, '..', 'docs/ACCOUNT_FACTS.md'), 'utf8');
  ok(/\$160\/month/.test(facts) && /\$265\.65/.test(facts)
      && /2026-09-15/.test(facts) && /2026-10-15/.test(facts)
      && /Travel Visa/.test(facts),
    'ACCOUNT_FACTS records standing $160, Sep once $283.94, and the travelvisa path');
  ok(/\$104\.20 \+ \$16\.80 = \$121\.00/.test(facts)
      && /retired as the forward baseline/i.test(facts),
    'ACCOUNT_FACTS keeps $121 as historical context only');
}

console.log('\n=== 6. live expandEvents / recommend: no Sep double-count ===');
{
  const live = liveData();
  const expected = independentMonthlyDates(DAY, '2026-10-01', HORIZON_END, FIRST_DUE);
  const sep = bellEvents(F.expandEvents(live.plan, '2026-09-01', '2026-09-30', {}));
  const later = bellEvents(F.expandEvents(live.plan, '2026-10-01', HORIZON_END, {}));
  const standing = later.filter(e => e.id === STANDING_ID)
    .sort((a, b) => a.date.localeCompare(b.date));
  ok(sep.length === 1 && sep[0].id === ONCE_ID && sep[0].date === ONCE_DUE
      && near(-sep[0].amount, ONCE_AMT) && sep[0].cardPaid === true
      && sep[0].jointCash === false && sep[0].payingAccount === PAYER,
    'live September expands exactly one Bell obligation of $283.94');
  ok(!sep.some(e => e.id === STANDING_ID || near(-e.amount, STANDING_AMT)
      || near(-e.amount, ONCE_AMT + STANDING_AMT)),
    'live September is not 283.94+160');
  ok(standing.map(e => e.date).join(',') === expected.join(','),
    'live October–December standing dates match the independent hand list');
  ok(standing.every(e => near(-e.amount, STANDING_AMT) && e.cardPaid !== true
      && e.jointCash !== false && e.payingAccount === 'chequing-a'),
    'live Oct+ standing is $160 from BILLS ACCOUNT');

  const rec = F.recommend(live.plan, '2026-09-10', {
    debts: live.debts, targetBuffer: 0, periods: load('public/periods.json'),
  });
  const listed = (rec.defaultView.bills || []).concat(
    (rec.defaultView.calendarPeriods || []).reduce((all, p) => all.concat(p.bills || []), []));
  const sepBell = listed.filter(r => r && (r.id === ONCE_ID || r.id === STANDING_ID)
    && r.date && r.date.startsWith('2026-09'));
  ok(sepBell.length >= 1 && sepBell.every(r => r.id === ONCE_ID
      && near(r.amount, ONCE_AMT) && r.cardPaid === true),
    'live as-of 10 Sep prints the $283.94 once in the owning payday window');
  ok(!sepBell.some(r => r.id === STANDING_ID || near(r.amount, STANDING_AMT)),
    'live recommend does not also print standing $160 in September');

  const asOf = live.meta.asOf;
  const windowEnd = F.addDays(asOf, live.plan.windowDays - 1);
  const independent = cardPaidReservedTotal(live.plan, asOf, windowEnd, F.occurrences);
  const sim = F.simulate(live.plan, asOf, {
    scenario: 'expected', weeklyVariable: 0, targetBuffer: live.plan.defaults.targetBuffer,
  });
  const standingBill = live.plan.bills.find(b => b.id === STANDING_ID);
  ok(F.billAffectsJointCash(standingBill, live.plan) === true
      && F.isCardPaidBill(standingBill, live.plan) === false,
    'live standing Bell is joint cash and is outside the card-paid reserved total');
  ok(near(sim.totals.reserved, independent)
      || Math.abs(sim.totals.reserved - independent) < 0.02,
    'live reserved ledger agrees with the independent card-paid reconstruction',
    `${sim.totals.reserved} vs ${independent}`);
}

console.log('\n=== 7. the Sep once id is an occurrence stub of the standing bell id ===');
{
  const live = liveData();
  const once = (live.plan.bills || []).find(b => b.id === ONCE_ID);
  const standing = (live.plan.bills || []).find(b => b.id === STANDING_ID);
  ok(once && standing && String(once.id).startsWith(standing.id + '-'),
    'Sep once id is the BCAA-style occurrence stub of recurring bell');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll Bell Sep 2026 once / standing $160 checks passed.');
