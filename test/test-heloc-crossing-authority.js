'use strict';
/* Independent proof that Forecast.projectDebts is the sole HELOC
 * limit-crossing date. `node test/test-heloc-crossing-authority.js`
 *
 * The monthly ledger is last-day-of-month calendar arithmetic plus the
 * posted opening and the capitalising charge. It does not call
 * projectDebts, expandEvents, or occurrences — those are the code under
 * test. Live cents here are a deliberately live reconciliation of the
 * 2026-08-19 opening (L-006), not a behaviour specification for other
 * households.
 */
const fs = require('fs');
const { sourceText } = require('./test-source-text');
const {
  findCrossingDateClaims,
  storedCrossingClaims,
} = require('./test-heloc-crossing-guard');
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const clone = x => JSON.parse(JSON.stringify(x));
const read = p => sourceText(fs.readFileSync(p, 'utf8'));
const cents = n => Math.round(Number(n) * 100);
const sameCents = (a, b) => cents(a) === cents(b);
const money2 = n => '$' + Number(n).toFixed(2);

function lastDayOfMonth(year, month /* 1-indexed */) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function monthEndsFrom(asOf, count) {
  const [y, m] = asOf.split('-').map(Number);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const abs = m + i;
    const year = y + Math.floor((abs - 1) / 12);
    const month = ((abs - 1) % 12) + 1;
    rows.push(lastDayOfMonth(year, month));
  }
  return rows;
}

function capitaliseLedger(opening, charge, asOf, months) {
  let balance = opening;
  return monthEndsFrom(asOf, months).map(date => {
    balance = Math.round((balance + charge) * 100) / 100;
    return { date, balance };
  });
}

function cashAndCapitaliseLedger(opening, charge, cashPayment, cashDay, cashFirstDue, asOf, months) {
  let balance = opening;
  return monthEndsFrom(asOf, months).map(date => {
    const [y, m] = date.split('-').map(Number);
    const cashDate = `${y}-${String(m).padStart(2, '0')}-${String(cashDay).padStart(2, '0')}`;
    if (cashDate >= asOf && cashDate >= cashFirstDue && cashDate <= date) {
      balance = Math.round((balance - cashPayment) * 100) / 100;
    }
    balance = Math.round((balance + charge) * 100) / 100;
    return { date, balance };
  });
}

function firstOver(ledger, limit) {
  return ledger.find(row => row.balance > limit) || null;
}

function projectHeloc(plan, debts, asOf) {
  return F.projectDebts(plan, debts, asOf, {
    scenario: 'expected',
    extraDebtMonthly: 0,
    weeklyVariable: 0,
    targetBuffer: 0,
    incomeOverrides: {},
    disabled: [],
  });
}

function helocCrossing(proj) {
  return ((proj && proj.crossings) || [])
    .find(c => c.id === 'heloc' && !c.alreadyOver) || null;
}

const plan = data.plan;
const asOf = data.meta.asOf;
const helocDebt = data.debts.find(d => d.id === 'heloc');
const helocObl = plan.obligations.find(o => o.id === 'heloc');

console.log('=== live opening still matches the 2026-08-19 HELOC facts ===');
ok(asOf === '2026-08-19', 'canonical opening is 2026-08-19', asOf);
ok(helocDebt && sameCents(helocDebt.balance, 200486.16),
  'HELOC opening is $200,486.16', money2(helocDebt && helocDebt.balance));
ok(helocDebt && sameCents(helocDebt.limit, 202654),
  'HELOC limit is $202,654', money2(helocDebt && helocDebt.limit));
ok(helocObl && sameCents(helocObl.amount, 814.18) && helocObl.nonCash === true
  && helocObl.effect === 'capitalise',
  'monthly capitalisation is still the $814.18 non-cash charge',
  money2(helocObl && helocObl.amount));
ok(helocDebt.cashPayment === 0 && helocDebt.interestTreatment === 'capitalised',
  'payment semantics: interest is still capitalised; debt-record cashPayment stays $0');

console.log('\n=== independent month-end ledger, without projectDebts ===');
const interestOnly = capitaliseLedger(helocDebt.balance, helocObl.amount, asOf, 3);
ok(interestOnly[0].date === '2026-08-31' && sameCents(interestOnly[0].balance, 201300.34),
  'interest-only 31 August → $201,300.34', `${interestOnly[0].date} ${money2(interestOnly[0].balance)}`);
ok(interestOnly[2].date === '2026-10-31' && sameCents(interestOnly[2].balance, 202928.70),
  'interest-only 31 October would exceed the limit',
  `${interestOnly[2].date} ${money2(interestOnly[2].balance)}`);
ok(interestOnly[2].balance > helocDebt.limit,
  'without the cash minimum the line would cross on capitalised interest alone',
  money2(interestOnly[2].balance - helocDebt.limit));

const ledger = cashAndCapitaliseLedger(
  helocDebt.balance, helocObl.amount, helocObl.cashPayment, helocObl.cashDay,
  helocObl.cashFirstDue, asOf, 3);
ok(ledger[0].date === '2026-08-31' && sameCents(ledger[0].balance, 201300.34),
  'with cashFirstDue 2026-09-21, August still capitalises only',
  `${ledger[0].date} ${money2(ledger[0].balance)}`);
ok(ledger[1].date === '2026-09-30' && sameCents(ledger[1].balance, 201300.34),
  'September cash minimum offsets that month\'s capitalise',
  `${ledger[1].date} ${money2(ledger[1].balance)}`);
ok(ledger[2].date === '2026-10-31' && sameCents(ledger[2].balance, 201300.34),
  'October stays under the limit at the same net',
  `${ledger[2].date} ${money2(ledger[2].balance)}`);
ok(ledger.every(row => row.balance < helocDebt.limit),
  'the cash-minimum ledger does not cross $202,654 in these three months');
const independent = firstOver(ledger, helocDebt.limit);
ok(!independent, 'independent cash-minimum ledger has no first-over day');

console.log('\n=== Forecast first crossing equals that ledger ===');
const proj = projectHeloc(plan, data.debts, asOf);
const cross = helocCrossing(proj);
ok(!cross,
  "Forecast's first HELOC crossing is absent once the cash minimum is on the walk",
  cross && cross.date);
ok(!cross && !independent,
  'engine and independent cash-minimum ledger agree: no crossing');

const advice = F.recommend(plan, asOf, {
  scenario: plan.defaults.scenario,
  targetBuffer: plan.defaults.targetBuffer,
  extraDebtMonthly: 0, incomeOverrides: {}, disabled: [],
  debts: data.debts, extraDebtTarget: plan.nextDollar && plan.nextDollar.target,
  fundingSources: plan.funding.options,
});
const liveDebt = F.projectDebts(plan, data.debts, asOf, Object.assign({},
  advice.simOptions, { weeklyVariable: advice.weekly,
    extraFacilities: data.revolvingExtra,
    extraDebtTarget: plan.nextDollar && plan.nextDollar.target }));
const liveMission = F.mission(advice, liveDebt, { sim: advice.sim });
const liveHelocPart = (liveMission.parts || []).find(p => p.id === 'helocLimit');
ok(!liveHelocPart,
  'the household-facing mission has no HELOC-crossing instruction on this walk');
ok(near((advice.funding && advice.funding.borrowed) || 0, 0),
  'available HELOC credit is not borrowed cash on this opening');
ok(advice.plannedDebt && advice.plannedDebt.permitted === false,
  'no borrowing permission is added');

console.log('\n=== stored narrative has no exact crossing day to update ===');
const stored = storedCrossingClaims(plan);
ok(stored.length === 0,
  'assumptions, nextDollar and actions do not store an exact HELOC crossing day',
  stored.join(' | ') || 'none');
// Every page script, the Stack page included, not plan.js alone (C1 S4 B3, test/lib/page-scripts.js).
const { pageScripts } = require('./lib/page-scripts');
const scannedPages = pageScripts();
const pageSourceClaims = scannedPages.flatMap(s => findCrossingDateClaims(s.source).map(claim => s.file + ': ' + String(claim).slice(0, 120)));
ok(scannedPages.some(s => s.file === 'public/plan.js') && scannedPages.some(s => s.file === 'public/stack-waterfall.js'),
  'the page scan covers the classic page and the Stack page');
ok(pageSourceClaims.length === 0,
  'No page script (classic or Stack) hardcodes a HELOC crossing calendar day',
  pageSourceClaims.join(' | ') || 'none');
const forecastSourceClaims = findCrossingDateClaims(read('public/forecast.js'));
ok(forecastSourceClaims.length === 0,
  'Forecast source does not hardcode a HELOC crossing calendar day',
  forecastSourceClaims.join(' | ') || 'none');

console.log('\n=== stored-date guard fails closed on any calendar day ===');
{
  const november = storedCrossingClaims({
    assumptions: ['The HELOC crosses its own limit on 30 November'],
  });
  ok(november.length > 0,
    'a stored 30 November crossing claim fails closed',
    november.join(' | '));
  const novemberIso = storedCrossingClaims({
    assumptions: ['The HELOC crosses its own limit on 2026-11-30'],
  });
  ok(novemberIso.length > 0,
    'a stored ISO November crossing claim fails closed',
    novemberIso.join(' | '));
  const pageNovember = findCrossingDateClaims(
    'The HELOC passes its own limit on 30 November with no new borrowing');
  ok(pageNovember.length > 0,
    'page copy that hardcodes 30 November fails closed',
    pageNovember.join(' | '));
  ok(storedCrossingClaims({
    assumptions: ['The HELOC passes its own limit inside this window with no new borrowing.'],
  }).length === 0,
    'a crossing claim with no calendar day is still allowed');
}

console.log('\n=== mutating cash minimum or opening moves the derived crossing ===');
{
  const mutated = clone(data);
  mutated.plan.obligations.find(o => o.id === 'heloc').cashPayment = 0;
  const mLedger = capitaliseLedger(helocDebt.balance, helocObl.amount, asOf, 3);
  const mIndependent = firstOver(mLedger, helocDebt.limit);
  const mProj = projectHeloc(mutated.plan, mutated.debts, asOf);
  const mCross = helocCrossing(mProj);
  ok(mIndependent && mIndependent.date === '2026-10-31',
    'independent interest-only ledger crosses 31 October when cashPayment is $0',
    mIndependent && `${mIndependent.date} ${money2(mIndependent.balance)}`);
  ok(mCross && mCross.date === mIndependent.date,
    'Forecast follows that no-cash ledger without a prose update',
    mCross && mCross.date);
  ok(!!mCross !== !!cross,
    'removing the cash minimum restores a crossing the live walk no longer has');
  ok(storedCrossingClaims(data.plan).length === 0,
    'live stored narrative still has no exact date that needed editing');
}
{
  const mutated = clone(data);
  const mDebt = mutated.debts.find(d => d.id === 'heloc');
  mDebt.balance = helocDebt.limit - 100;
  const mLedger = cashAndCapitaliseLedger(
    mDebt.balance, helocObl.amount, helocObl.cashPayment, helocObl.cashDay,
    helocObl.cashFirstDue, asOf, 3);
  const mIndependent = firstOver(mLedger, mDebt.limit);
  const mProj = projectHeloc(mutated.plan, mutated.debts, asOf);
  const mCross = helocCrossing(mProj);
  ok(mIndependent && mIndependent.date === '2026-08-31',
    'independent cash ledger crosses 31 August when opening is $100 under the limit',
    mIndependent && `${mIndependent.date} ${money2(mIndependent.balance)}`);
  ok(mCross && mCross.date === mIndependent.date,
    'Forecast follows the mutated opening without a stored-date update',
    mCross && mCross.date);
  ok(near(data.plan.obligations.find(o => o.id === 'heloc').amount, 814.18),
    'the live $814.18 capitalisation is unchanged by the fixture');
}

console.log('\n=== next-dollar ordering remains separate from crossing authority ===');
const priority = F.debtPriority(plan, data.debts);
ok(plan.nextDollar && plan.nextDollar.policy === 'true-surplus-highest-interest',
  'owner-stated true-surplus policy is recorded');
ok(priority.target && priority.target.id === 'cashback',
  'Forecast independently selects the Cash Back Visa from current rates');
ok(priority.order.some(row => row.id === 'heloc'),
  'the HELOC is eligible in the same Forecast rate order');
ok(!JSON.stringify(plan.nextDollar).includes('2026-10-31'),
  'the debt policy still stores no HELOC crossing date');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
