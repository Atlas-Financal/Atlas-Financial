'use strict';
/* BC Hydro equal monthly payments $199 from the next bill forward.
 *
 * Owner 2026-09-09 annual-adjustment notice: equal monthly payments
 * become $199.00 on the next bill. The $199 amount and monthly cadence
 * are confirmed. The notice does not establish a payment/due day, so
 * timing is estimated at the start of the next-bill month
 * (firstDue 2026-10-01). Same notice: −$53.08 still on the Hydro
 * account, so the next cash hit nets to $145.92; later months are
 * full $199. The 1 September once due (hydro-due-sep1, $237.45)
 * stays for settlement identity.
 *
 * Independent proof (L-002 / L-006): hand-listed monthly dates at day 1
 * from firstDue 2026-10-01, plus 199 − 53.08 = 145.92 arithmetic, not a
 * second call that merely re-runs expandEvents.
 *
 * `node test/test-hydro-equal-payment.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const R = require('../scripts/reconcile.js');
const O = require('../scripts/provider-observe.js');
const { streamTotal, independentlyBillOccurrenceAmount } = require('./test-helpers');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const EQUAL_ID = 'hydro-equal-payment';
const SEP_ID = 'hydro-due-sep1';
const EQUAL_AMT = 199;
const SEP_AMT = 237.45;
const CREDIT = 53.08;
const FIRST_CASH = 145.92;
const DAY = 30; // owner bill 2026-10-08 evidences a due by 2026-10-30 (estimated: varies a day or two)
const FIRST_DUE = '2026-10-30';
const SEP_DUE = '2026-09-01';
const JOINT = 'chequing-a';
const HORIZON_END = '2026-12-31';

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

function hydroBills(plan) {
  return ((plan && plan.bills) || []).filter(b =>
    b && (/hydro/i.test(String(b.id || '')) || /bc hydro/i.test(String(b.label || ''))));
}

function fixturePlan() {
  return {
    windowDays: 120,
    defaults: { targetBuffer: 0 },
    startingCash: { breakdown: [{ id: JOINT, value: 5000 }] },
    income: [],
    obligations: [],
    bills: [
      {
        id: SEP_ID,
        label: 'BC Hydro due 1 September',
        frequency: 'once',
        date: SEP_DUE,
        amount: SEP_AMT,
        confidence: 'confirmed',
        householdObligation: true,
        payingAccount: JOINT,
      },
      {
        id: EQUAL_ID,
        label: 'BC Hydro equal payment',
        frequency: 'monthly',
        day: DAY,
        firstDue: FIRST_DUE,
        amount: EQUAL_AMT,
        confidence: 'estimated',
        householdObligation: true,
        payingAccount: JOINT,
        utilityAccountCredit: { amount: CREDIT, asOf: '2026-09-09' },
      },
    ],
    commitments: [],
  };
}

function liveData() {
  return load('data.json');
}

function identityDoc() {
  return load('docs/connectivity/transaction-identity.json');
}

function fixtureMap() {
  return load('docs/connectivity/fixtures/provider-account-map.json');
}

function observeAt(asOf, txs) {
  return O.observe({
    provider: 'lunchmoney',
    payload: {
      provider: 'lunchmoney',
      fetchedAt: asOf + 'T18:00:00.000Z',
      transactionWindow: {
        startDate: '2026-08-19',
        endDate: asOf,
        complete: true,
        hasMore: false,
        truncated: false,
      },
      pendingCoverage: {
        complete: true,
        basis: O.PENDING_COVERAGE_BASIS,
        hasMore: false,
        truncated: false,
      },
      accounts: [
        {
          id: 1001, name: 'Fixture Chequing A', type: 'cash', balance: 1000,
          updated_at: asOf + 'T17:55:00.000Z',
        },
        {
          id: 1002, name: 'Fixture Chequing B', type: 'cash', balance: 400,
          updated_at: asOf + 'T17:55:00.000Z',
        },
      ],
      categories: [
        { id: 11, name: 'Shopping', is_income: false, exclude_from_totals: false },
      ],
      // Legacy invented native CAD rows declare units; explicit overrides survive.
      transactions: txs.map(tx => ({ currency: 'cad', ...tx })),
    },
    accountMap: fixtureMap(),
    data: liveData(),
    identity: identityDoc(),
  });
}

console.log('=== 1. independent October–December $199 dates ===');
{
  const expected = independentMonthlyDates(DAY, '2026-09-01', HORIZON_END, FIRST_DUE);
  ok(expected.join(',') === '2026-10-30,2026-11-30,2026-12-30',
    'hand list is 30 Oct, 30 Nov, 30 Dec — no September equal-payment date',
    expected.join(','));
  ok(expected.every(d => d >= FIRST_DUE) && !expected.includes('2026-09-01'),
    'firstDue 2026-10-30 excludes a September equal-payment occurrence');
  ok(near(roundCent(EQUAL_AMT - CREDIT), FIRST_CASH) && near(FIRST_CASH, 145.92),
    'independent $199 − $53.08 = $145.92',
    String(roundCent(EQUAL_AMT - CREDIT)));
  const independentTotal = roundCent(FIRST_CASH + EQUAL_AMT + EQUAL_AMT);
  ok(near(independentTotal, 543.92) && near(independentTotal, roundCent(597 - CREDIT)),
    'independent 3 × $199.00 − $53.08 = $543.92',
    String(independentTotal));
  const equalBill = fixturePlan().bills.find(b => b.id === EQUAL_ID);
  ok(near(independentlyBillOccurrenceAmount(equalBill, FIRST_DUE), FIRST_CASH),
    'independent helper nets only the firstDue occurrence to $145.92');
  ok(near(independentlyBillOccurrenceAmount(equalBill, '2026-11-01'), EQUAL_AMT)
      && near(independentlyBillOccurrenceAmount(equalBill, '2026-12-01'), EQUAL_AMT),
    'independent helper leaves later months at full $199');
  const reconstructed = streamTotal(fixturePlan().bills, '2026-09-01', HORIZON_END, F.occurrences, {
    plan: fixturePlan(), onceOutflowsBind: true,
  });
  ok(near(reconstructed, roundCent(SEP_AMT + independentTotal)),
    'streamTotal independently reconstructs $237.45 + $145.92 + 2×$199, not 3×$199',
    String(reconstructed));
}

console.log('\n=== 2. synthetic expandEvents: Sep once preserved; first cash is netted ===');
{
  const plan = fixturePlan();
  const sepEvents = F.expandEvents(plan, '2026-09-01', '2026-09-30', {});
  const sepOnce = sepEvents.filter(e => e.id === SEP_ID);
  const sepEqual = sepEvents.filter(e => e.id === EQUAL_ID);
  const sepIncome = sepEvents.filter(e => e.kind === 'income' && near(e.amount, CREDIT));
  ok(sepOnce.length === 1 && sepOnce[0].date === SEP_DUE
      && near(-sepOnce[0].amount, SEP_AMT)
      && sepOnce[0].jointCash !== false,
    'September still expands the $237.45 once due on 1 September');
  ok(sepEqual.length === 0,
    'September does not expand a $199 equal-payment occurrence');
  ok(sepIncome.length === 0,
    'the Hydro-account credit is not +$53.08 joint cash on 9 September');

  const later = F.expandEvents(plan, '2026-10-01', HORIZON_END, {});
  const equal = later.filter(e => e.id === EQUAL_ID).sort((a, b) => a.date.localeCompare(b.date));
  const sepLater = later.filter(e => e.id === SEP_ID);
  const expected = independentMonthlyDates(DAY, '2026-10-01', HORIZON_END, FIRST_DUE);
  ok(equal.map(e => e.date).join(',') === expected.join(','),
    'October–December equal-payment dates match the independent hand list',
    equal.map(e => e.date).join(','));
  ok(equal[0] && equal[0].date === FIRST_DUE && near(-equal[0].amount, FIRST_CASH)
      && equal[0].kind === 'bill' && equal[0].jointCash !== false
      && equal[0].payingAccount === JOINT && equal[0].confidence === 'estimated',
    'first equal-payment cash hit is the netted $145.92, estimated timing');
  ok(equal.slice(1).every(e => near(-e.amount, EQUAL_AMT) && e.kind === 'bill'
      && e.jointCash !== false && e.payingAccount === JOINT),
    'later equal-payment events are full $199 joint-cash BILLS ACCOUNT bills');
  ok(sepLater.length === 1 && sepLater[0].date === SEP_DUE
      && near(-sepLater[0].amount, SEP_AMT),
    'unpaid Sep. 1 once due remains a single carried $237.45 event, not rewritten as $199');
  const independentSum = roundCent(FIRST_CASH + EQUAL_AMT + EQUAL_AMT);
  const engineSum = roundCent(equal.reduce((s, e) => s + (-e.amount), 0));
  ok(near(engineSum, independentSum) && near(engineSum, 543.92),
    'expandEvents equal-payment total agrees with 3 × $199 − $53.08',
    `${engineSum} vs ${independentSum}`);
}

console.log('\n=== 3. credit is not Sep. 9 income; later months stay $199 ===');
{
  const withCredit = fixturePlan();
  const withoutCredit = fixturePlan();
  delete withoutCredit.bills.find(b => b.id === EQUAL_ID).utilityAccountCredit;
  const start = '2026-09-01';
  const withSim = F.simulate(withCredit, start, { weeklyVariable: 0, horizonDays: 100 });
  const withoutSim = F.simulate(withoutCredit, start, { weeklyVariable: 0, horizonDays: 100 });
  const bal = (sim, date) => {
    const row = (sim.daily || []).find(d => d.date === date);
    return row ? Number(row.balance) : null;
  };
  ok(near(bal(withSim, '2026-09-09'), bal(withoutSim, '2026-09-09')),
    'Sep. 9 cash is unchanged by the Hydro-account credit (not chequing income)');
  ok(near(bal(withSim, '2026-09-30'), bal(withoutSim, '2026-09-30')),
    'cash before the first equal-payment date is unchanged by the credit');
  ok(near(bal(withSim, FIRST_DUE) - bal(withoutSim, FIRST_DUE), CREDIT),
    'on the first planned occurrence, credit reduces the cash outflow by $53.08',
    `${bal(withSim, FIRST_DUE)} vs ${bal(withoutSim, FIRST_DUE)}`);
  ok(near(bal(withSim, '2026-11-01') - bal(withoutSim, '2026-11-01'), CREDIT),
    'November still pays full $199; the $53.08 delta does not recur');
}

console.log('\n=== 4. occurrence-stub coupling does not hide the Sep. 1 once due ===');
{
  const plan = fixturePlan();
  const sep = plan.bills.find(b => b.id === SEP_ID);
  const monthly = plan.bills.find(b => b.id === EQUAL_ID);
  ok(sep && monthly && !String(sep.id).startsWith(monthly.id + '-'),
    'Sep. 1 once id is not a prefix-stub of hydro-equal-payment');
  const roster = F.householdBills(plan, '2026-08-19');
  const ids = (roster.bills || []).map(r => r.id);
  ok(ids.includes(SEP_ID) && ids.includes(EQUAL_ID),
    'Bills roster keeps both the dated due and the monthly equal-payment row');
  const equalRow = roster.bills.find(r => r.id === EQUAL_ID);
  ok(equalRow && equalRow.frequency === 'monthly' && equalRow.nextDate === FIRST_DUE
      && equalRow.confidence === 'estimated'
      && near(equalRow.monthlyEquivalent, EQUAL_AMT),
    'equal-payment next date is estimated firstDue 2026-10-01 with monthly equivalent $199');
}

console.log('\n=== 4. live plan encodes the owner $199 series without rewriting Sep. 1 ===');
{
  const live = liveData();
  const bills = hydroBills(live.plan);
  const sep = bills.find(b => b.id === SEP_ID);
  const equal = bills.find(b => b.id === EQUAL_ID);
  ok(sep && sep.frequency === 'once' && sep.date === SEP_DUE
      && near(sep.amount, SEP_AMT) && sep.payingAccount === JOINT
      && sep.householdObligation === true,
    'live hydro-due-sep1 remains the $237.45 once due on BILLS ACCOUNT');
  ok(equal && equal.frequency === 'monthly' && equal.day === DAY
      && equal.firstDue === FIRST_DUE && near(equal.amount, EQUAL_AMT)
      && equal.payingAccount === JOINT && equal.householdObligation === true
      && equal.budgetCategory == null && equal.confidence === 'estimated'
      && near(equal.utilityAccountCredit && equal.utilityAccountCredit.amount, CREDIT),
    'live hydro-equal-payment is estimated-timing $199 monthly from 2026-10-01 with $53.08 account credit');
  ok(equal && equal.day !== 9 && equal.firstDue !== '2026-10-09'
      && equal.confidence !== 'confirmed',
    'live encoding does not publish a confirmed 9 October payment/due date');
  ok(!bills.some(b => b.id === 'hydro-due-now'),
    'the settled 14 August Hydro due is still absent');
  ok(bills.length === 2,
    'live Hydro bills are exactly the Sep. 1 once due and the equal-payment series',
    bills.map(b => b.id).join(','));
  ok(!bills.some(b => near(b.amount, 234) || near(b.amount, 207)),
    'historical $234 / $207 equal-payment steps are not scheduled as live bills');
}

console.log('\n=== 5. live expandEvents / trajectory October includes $199 Hydro ===');
{
  const live = liveData();
  const expected = independentMonthlyDates(DAY, '2026-10-01', HORIZON_END, FIRST_DUE);
  const events = F.expandEvents(live.plan, '2026-09-01', HORIZON_END, {});
  const sep = events.filter(e => e.id === SEP_ID);
  const equal = events.filter(e => e.id === EQUAL_ID)
    .sort((a, b) => a.date.localeCompare(b.date));
  const septEqual = equal.filter(e => e.date < FIRST_DUE || e.date.startsWith('2026-09'));
  ok(sep.length === 1 && sep[0].date === SEP_DUE && near(-sep[0].amount, SEP_AMT),
    'live September still expands hydro-due-sep1 at $237.45');
  ok(septEqual.length === 0,
    'live September has no $199 equal-payment event');
  ok(!events.some(e => e.kind === 'income' && e.date === '2026-09-09' && near(e.amount, CREDIT)),
    'live September does not invent +$53.08 income on 9 September');
  ok(equal.map(e => e.date).join(',') === expected.join(','),
    'live October–December equal-payment dates match the independent hand list');
  ok(equal[0] && near(-equal[0].amount, FIRST_CASH),
    'live first equal-payment cash hit is $145.92');
  ok(equal.slice(1).every(e => near(-e.amount, EQUAL_AMT)),
    'live later equal-payment events are $199, not a metered amount');

  const periods = load('public/periods.json');
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods,
    extraFacilities: live.revolvingExtra,
  });
  // Trajectory months are payday-to-payday windows; locate each occurrence by its date.
  const hydroLine = date => {
    for (const m of traj.months || []) {
      const line = ((m.stage1 && m.stage1.bills && m.stage1.bills.lines) || [])
        .find(x => x && x.id === EQUAL_ID && x.date === date);
      if (line) return line;
    }
    return null;
  };
  ok(traj.status === 'ready' && (traj.months || []).some(m => m.stage1 && m.stage1.status !== 'unavailable'),
    'live trajectory Stage 1 is published');
  const octLine = hydroLine('2026-10-30');
  ok(octLine && near(octLine.amount, FIRST_CASH) && octLine.status === 'estimated',
    'the 30 October trajectory bill is the netted $145.92 Hydro equal payment as estimated',
    octLine ? `${octLine.label} ${octLine.amount} ${octLine.status}` : 'missing');
  const novLine = hydroLine('2026-11-30');
  ok(novLine && near(novLine.amount, EQUAL_AMT),
    'the 30 November trajectory bill is the full $199 equal payment',
    novLine ? `${novLine.label} ${novLine.amount}` : 'missing');
  const asOf = live.meta.asOf;
  const windowEnd = F.addDays(asOf, live.plan.windowDays - 1);
  const wantBills = streamTotal(live.plan.bills, asOf, windowEnd, F.occurrences, {
    plan: live.plan, onceOutflowsBind: true, omitRepresented: true,
  });
  const sim = F.simulate(live.plan, asOf, {
    scenario: 'expected', weeklyVariable: 0, targetBuffer: live.plan.defaults.targetBuffer,
  });
  ok(near(sim.totals.bills, wantBills),
    'live 90-day named bills independently reconstruct the firstDue credit net',
    sim.totals.bills.toFixed(2));
  const sepMonth = (traj.months || []).find(m => m.month === '2026-09');
  const sepEqualLine = ((sepMonth && sepMonth.stage1 && sepMonth.stage1.bills
    && sepMonth.stage1.bills.lines) || [])
    .find(r => r && /equal payment/i.test(String(r.label || '')));
  ok(!sepEqualLine,
    'September trajectory bills do not include the $199 equal-payment line');
}

console.log('\n=== 6. settlement identity: Sep. 4 still once; Oct. 1 settles the series ===');
{
  const identity = identityDoc();
  const onceRule = (identity.rules || []).find(r => r && r.eventId === SEP_ID);
  const equalRule = (identity.rules || []).find(r => r && r.eventId === EQUAL_ID);
  ok(onceRule && onceRule.atlasAccountId === JOINT
      && onceRule.postingDateRule === 'covers-due-on-or-before-posting'
      && (onceRule.payeePatterns || []).includes('BC Hydro'),
    'hydro-due-sep1 identity is unchanged: payee + BILLS + covers-due');
  ok(equalRule && equalRule.atlasAccountId === JOINT
      && equalRule.direction === 'debit'
      && equalRule.postingDateRule === 'covers-due-on-or-before-posting'
      && (equalRule.payeePatterns || []).includes('BC Hydro')
      && (equalRule.payeePatterns || []).includes('BCHYDRO')
      && !equalRule.settlesWhen,
    'hydro-equal-payment identity is payee + BILLS + covers-due; amount is not identity');

  const sep4 = observeAt('2026-09-04', [{
    id: 9401, account_id: 1001, date: '2026-09-04', amount: 232,
    is_pending: false, payee: 'BC Hydro', original_name: 'BC Hydro',
  }]);
  const sepHits = sep4.representedEventCandidates || [];
  ok(sepHits.some(c => c && c.id === SEP_ID && c.date === SEP_DUE)
      && !sepHits.some(c => c && c.id === EQUAL_ID),
    'Sep. 4 Chequing A BC Hydro still settles hydro-due-sep1 only');

  const sep15 = observeAt('2026-09-15', [{
    id: 9415, account_id: 1001, date: '2026-09-15', amount: 199,
    is_pending: false, payee: 'BC Hydro', original_name: 'BC Hydro',
  }]);
  const sep15Hits = sep15.representedEventCandidates || [];
  ok(!sep15Hits.some(c => c && (c.id === SEP_ID || c.id === EQUAL_ID)),
    'a mid-September debit does not reuse the once due or settle the next-bill series');

  const oct1 = observeAt('2026-10-30', [{
    id: 9501, account_id: 1001, date: '2026-10-30', amount: FIRST_CASH,
    is_pending: false, payee: 'BC Hydro', original_name: 'BC Hydro',
  }]);
  const oct1Hits = oct1.representedEventCandidates || [];
  const oct1Hit = oct1Hits.find(c => c && c.id === EQUAL_ID && c.date === FIRST_DUE);
  ok(oct1Hit && near(oct1Hit.observedAmount, FIRST_CASH) && oct1Hit.amountNotUsed === true
      && !oct1Hits.some(c => c && c.id === SEP_ID),
    'Oct. 1 Chequing A BC Hydro settles hydro-equal-payment, not the Sep. 1 once due');

  const oct1Full = observeAt('2026-10-30', [{
    id: 9502, account_id: 1001, date: '2026-10-30', amount: EQUAL_AMT,
    is_pending: false, payee: 'BC Hydro', original_name: 'BC Hydro',
  }]);
  const oct1FullHits = oct1Full.representedEventCandidates || [];
  ok(oct1FullHits.some(c => c && c.id === EQUAL_ID && c.date === FIRST_DUE && c.amountNotUsed === true)
      && !oct1FullHits.some(c => c && c.id === SEP_ID),
    'a $199 Oct. 1 debit still settles the series — amount is not identity');

  const packet = oct1.currentPeriodActuals;
  const hydroTx = (packet && packet.transactions || []).find(tx =>
    tx && Number(tx.amount) === FIRST_CASH);
  ok(hydroTx && hydroTx.representedBill === true,
    'the Oct. 1 Hydro debit is flagged representedBill, not leftover Other spending');
  const cls = F.classifyCurrentPeriodTransaction(hydroTx, liveData().plan, {
    currentPeriodActuals: packet,
  });
  ok(cls && cls.kind === 'bill' && cls.reason === 'represented-bill'
      && cls.householdSpending === false,
    'Forecast classifies the Oct. 1 debit as the represented equal-payment bill');

  const oct9 = observeAt('2026-11-03', [{
    id: 9601, account_id: 1001, date: '2026-11-03', amount: 199,
    is_pending: false, payee: 'BCHYDRO', original_name: 'BCHYDRO',
  }]);
  const octHits = oct9.representedEventCandidates || [];
  const octHit = octHits.find(c => c && c.id === EQUAL_ID && c.date === FIRST_DUE);
  ok(octHit && near(octHit.observedAmount, EQUAL_AMT) && octHit.amountNotUsed === true
      && !octHits.some(c => c && c.id === SEP_ID),
    'Oct. 9 Chequing A BCHYDRO still covers the estimated October occurrence');
}

console.log('\n=== 7. prepaid settlement: represented Oct. 1 debit cannot double-count ===');
{
  const plan = fixturePlan();
  const asOf = FIRST_DUE;
  const reserved = F.expandEvents(plan, asOf, '2026-10-31', {});
  const reservedHit = reserved.find(e => e.id === EQUAL_ID && e.date === FIRST_DUE);
  ok(reservedHit && near(-reservedHit.amount, FIRST_CASH),
    'without settlement evidence the first cash hit stays reserved at $145.92');
  const settled = F.expandEvents(plan, asOf, '2026-10-31', {
    representedEvents: [{ id: EQUAL_ID, date: FIRST_DUE }],
  });
  ok(!settled.some(e => e.id === EQUAL_ID && e.date === FIRST_DUE),
    'represented Oct. 1 debit omits the planned equal-payment cash reservation');
  const unpaid = F.simulate(plan, asOf, { weeklyVariable: 0, horizonDays: 31 });
  const paid = F.simulate(plan, asOf, {
    weeklyVariable: 0,
    horizonDays: 31,
    representedEvents: [{ id: EQUAL_ID, date: FIRST_DUE }],
  });
  const unpaidBal = (unpaid.daily || []).find(d => d.date === FIRST_DUE);
  const paidBal = (paid.daily || []).find(d => d.date === FIRST_DUE);
  ok(unpaidBal && paidBal && near(paidBal.balance - unpaidBal.balance, FIRST_CASH),
    'settlement leaves Oct. 1 cash $145.92 higher — the reserved hit is not deducted again',
    `${paidBal && paidBal.balance} vs ${unpaidBal && unpaidBal.balance}`);
}

console.log('\n=== 8. utility observation MATCHES firstDue; Fortis/Shaw untouched ===');
{
  const live = liveData();
  const utility = load('docs/reconciliation/utility-observations.json');
  const result = R.reconcile({
    data: live,
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [] },
    utility,
  });
  const sepRow = result.rows.find(r => r.observationId === 'payday-hydro-due-sep1');
  const equalRow = result.rows.find(r => r.observationId === 'owner-hydro-equal-payment-199');
  ok(sepRow && sepRow.status === 'MATCH' && near(sepRow.canonicalValue, SEP_AMT)
      && sepRow.canonicalDate === SEP_DUE,
    'Sep. 1 dated-due observation still MATCHES hydro-due-sep1');
  ok(equalRow && equalRow.status === 'MATCH' && near(equalRow.canonicalValue, EQUAL_AMT)
      && equalRow.canonicalDate === FIRST_DUE,
    'equal-payment observation MATCHES hydro-equal-payment estimated firstDue 2026-10-30');
  const creditRow = result.rows.find(r => r.observationId === 'owner-hydro-account-credit-53-08');
  ok(creditRow && creditRow.fact === 'account-balance' && creditRow.status === 'MATCH'
      && creditRow.scheduled === false && near(creditRow.evidenceValue, CREDIT),
    'MyHydro $53.08 Credit is informational account state, not a scheduled cash bill');

  const fortis = (live.plan.bills || []).find(b => b.id === 'fortis');
  const shaw = (live.plan.bills || []).find(b => b.id === 'shaw');
  ok(fortis && fortis.frequency === 'monthly' && fortis.day === 3 && near(fortis.amount, 124),
    'Fortis is unchanged');
  ok(shaw && shaw.frequency === 'monthly' && shaw.day === 14 && near(shaw.amount, 78.4),
    'Shaw is unchanged');
}

console.log('\n=== 9. MyHydro screenshot corroborates credit; period is not a due ===');
{
  const intakePath = path.join(__dirname, '..',
    'docs/source_intake/BC_HYDRO_MYHYDRO_CREDIT_2026-09-18.md');
  const intake = fs.readFileSync(intakePath, 'utf8');
  ok(/BILL-HYD-006/.test(intake) && /\$53\.08 Credit/.test(intake)
      && /−\$53\.08/.test(intake),
    'MyHydro intake records $53.08 Credit and the 9 September bill amount −$53.08');
  ok(/5 September – 6 October 2026/.test(intake)
      && /period window only/.test(intake)
      && /not payment-date evidence/.test(intake),
    'MyHydro billing period is documented as a period window, not a due');
  ok(!/confirmed cash-calendar/.test(intake)
      || /Not a confirmed cash-calendar/.test(intake),
    'MyHydro intake does not promote a confirmed cash-calendar due');
  const register = load('docs/evidence_use/register.json');
  const row = (register.items || []).find(r => r && r.id === 'BILL-HYD-006');
  ok(row && row.disposition === 'CONSUMED'
      && row.routed_to && row.routed_to.path === 'data.json'
      && row.routed_to.json_pointer === '/plan/bills/11/utilityAccountCredit',
    'BILL-HYD-006 is routed to the equal-payment utilityAccountCredit');
  const live = liveData();
  const equal = (live.plan.bills || []).find(b => b.id === EQUAL_ID);
  const sepEvents = F.expandEvents(live.plan, '2026-09-05', '2026-09-09', {});
  ok(equal && near(equal.utilityAccountCredit.amount, CREDIT)
      && equal.utilityAccountCredit.asOf === '2026-09-09',
    'live credit encoding is unchanged at $53.08 as-of 9 September');
  ok(!sepEvents.some(e => e.kind === 'income' && near(e.amount, CREDIT)),
    'MyHydro credit still does not invent +$53.08 joint cash on 9 September');
  ok(!sepEvents.some(e => e.id === EQUAL_ID),
    'the 5 September–6 October period window does not emit an equal-payment cash hit in September');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll BC Hydro equal-payment timing-repair and credit checks passed.');
