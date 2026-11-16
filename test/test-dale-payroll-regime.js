'use strict';
/* Independent historical reconciliation for the trajectory-local
 * estimated Dale/Seaspan payroll regime.
 *
 * Expected values are sanitized paystub figures (ChatGPT review of 70
 * stubs + bonuses) and CRA 2026 published statutory tables — not a
 * second call of Forecast as the specification. Forecast output is
 * compared to those independents. Variances are measured, then checked
 * against explicit tolerances taken from payroll rounding or the
 * demonstrated T4127-vs-Seaspan withholding gap — not chosen to pass.
 *
 * `node test/test-dale-payroll-regime.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const roundCent = n => Math.round(n * 100) / 100;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// CRA 2026 published (canada.ca CPP / EI / T4127 July 2026). Independent
// of Forecast constants.
const CRA_2026 = {
  ybe: 3500,
  ympe: 74600,
  yampe: 85000,
  cppRate: 0.0595,
  cppMax: 4230.45,
  cpp2Rate: 0.04,
  cpp2Max: 416,
  eiRate: 0.0163,
  eiMie: 68900,
  eiMax: 1123.07,
  p: 26,
};
const EXEMPT = CRA_2026.ybe / CRA_2026.p;

// Sanitized independent stubs. No employee number, address, bank, tax
// ID, or other private identifier.
const STUBS = {
  '2026-03-13': {
    kind: 'regular',
    gross: 6080.42,
    tax: 1441.14,
    cpp: 354.07,
    ei: 99.11,
    pension: 304.02,
    net: 3882.08,
    note: 'regular while CPP/EI active; first supplied regular entirely at $76.005',
  },
  '2026-03-27': {
    kind: 'regular',
    gross: 6080.42,
    cpp: 358.03,
    ei: 73.28,
    pension: 304.02,
    net: 3877.15,
    tax: roundCent(6080.42 - 3877.15 - 358.03 - 73.28 - 304.02),
    note: 'EI annual max transition (partial EI)',
  },
};
const BONUS_2026 = {
  date: '2026-02-25',
  gross: 29168.11,
  net: 15570.25,
};
const EXHAUSTION = {
  ei: '2026-03-27',
  cpp: '2026-04-10',
  cpp2: '2026-05-08',
  noneFrom: '2026-05-22',
};

// Demonstrated limitations from the independent walk vs stubs — not
// tolerances chosen after seeing Forecast.
const TOL = {
  cppRegular: 0.50,        // YBE/26 rounding: 353.78 vs stub 354.07 = $0.29
  eiFull: 0.02,            // 6080.42 * 1.63% rounds to stub 99.11
  eiMaxTransition: 1.10,   // wage-only YTD vs stub remaining; $1.02 on Mar 27
  cppMaxTransition: 4.30,  // Mar 27 stub 358.03 vs per-period 353.78 = $4.25
  taxRegular: 10.00,       // T4127 Option 1 (gross−RPP, CEA, max K2) vs stub $9.84
  bonusNet: 500.00,        // T4127 extra-pay vs Seaspan bonus withholding $484.50
  pension: 0.01,
  exhaustionDate: 0,       // exact deposit date
};

function independentCppEi(acc, gross, kind) {
  const exemption = kind === 'regular' ? EXEMPT : 0;
  const roomYmpe = Math.max(0, CRA_2026.ympe - acc.ytdPen);
  const firstCeiling = Math.min(gross, roomYmpe);
  let cpp = roundCent(Math.max(0, firstCeiling - Math.min(exemption, firstCeiling)) * CRA_2026.cppRate);
  cpp = Math.min(cpp, roundCent(Math.max(0, CRA_2026.cppMax - acc.cppPaid)));
  const ytdPenAfter = acc.ytdPen + gross;
  const cpp2Earn = Math.max(0, Math.min(ytdPenAfter, CRA_2026.yampe) - Math.max(acc.ytdPen, CRA_2026.ympe));
  let cpp2 = roundCent(cpp2Earn * CRA_2026.cpp2Rate);
  cpp2 = Math.min(cpp2, roundCent(Math.max(0, CRA_2026.cpp2Max - acc.cpp2Paid)));
  const roomMie = Math.max(0, CRA_2026.eiMie - acc.ytdIns);
  let ei = roundCent(Math.min(gross, roomMie) * CRA_2026.eiRate);
  ei = Math.min(ei, roundCent(Math.max(0, CRA_2026.eiMax - acc.eiPaid)));
  acc.ytdPen = ytdPenAfter;
  acc.ytdIns += gross;
  acc.cppPaid = roundCent(acc.cppPaid + cpp);
  acc.cpp2Paid = roundCent(acc.cpp2Paid + cpp2);
  acc.eiPaid = roundCent(acc.eiPaid + ei);
  return { cpp, cpp2, ei };
}

const OLD = roundCent(151283 / 26);
const NEW = roundCent(158091 / 26);
const INDEPENDENT_DEPOSITS = [
  { date: '2026-01-02', kind: 'regular', gross: OLD, pension: roundCent(OLD * 0.05) },
  { date: '2026-01-16', kind: 'regular', gross: OLD, pension: roundCent(OLD * 0.05) },
  { date: '2026-01-30', kind: 'regular', gross: OLD, pension: roundCent(OLD * 0.05) },
  { date: '2026-02-13', kind: 'regular', gross: OLD, pension: roundCent(OLD * 0.05) },
  { date: '2026-02-25', kind: 'bonus', gross: BONUS_2026.gross, pension: 0 },
  { date: '2026-02-27', kind: 'regular', gross: OLD, pension: roundCent(OLD * 0.05) },
  { date: '2026-03-13', kind: 'regular', gross: NEW, pension: 304.02 },
  { date: '2026-03-27', kind: 'regular', gross: NEW, pension: 304.02 },
  { date: '2026-04-10', kind: 'regular', gross: NEW, pension: 304.02 },
  { date: '2026-04-24', kind: 'regular', gross: NEW, pension: 304.02 },
  { date: '2026-05-08', kind: 'regular', gross: NEW, pension: 304.02 },
  { date: '2026-05-22', kind: 'regular', gross: NEW, pension: 304.02 },
];

function independentWalk() {
  const acc = { ytdPen: 0, ytdIns: 0, cppPaid: 0, cpp2Paid: 0, eiPaid: 0 };
  return INDEPENDENT_DEPOSITS.map(row => {
    const deds = independentCppEi(acc, row.gross, row.kind);
    return Object.assign({}, row, deds, {
      cppYtd: acc.cppPaid,
      cpp2Ytd: acc.cpp2Paid,
      eiYtd: acc.eiPaid,
    });
  });
}

    const seaspanPlan = {
      income: [{
        id: 'payroll',
        label: 'Payroll — Seaspan',
        frequency: 'biweekly',
        anchor: '2026-08-14',
        amount: 4264,
        confidence: 'estimated',
      }],
      payrollPlanningAssumptions: {
        salaryRaiseFactor: 1.04,
        bonusRate: 0.18,
        authorizedThroughYear: 2027,
        trust: 'estimated',
        provenance: 'owner-stated',
      },
      obligations: [],
      bills: [],
      commitments: [],
    };

console.log('=== 1. Independent biweekly convention (annual/26) ===');
{
  ok(NEW === 6080.42, 'current regular gross is 158091/26 = 6080.42, not a rounded 164415',
    String(NEW));
  ok(roundCent(158091 * 1.04) === 164414.64,
    'planning raise is 158091×1.04 = 164414.64, not a canonical $164,415');
  ok(roundCent(164414.64 / 26) === 6323.64,
    'raised biweekly is 164414.64/26 = 6323.64');
  ok(roundCent(158091 * 0.18) === 28456.38,
    '2027 bonus estimate is 18% of 158091 = 28456.38');
}

console.log('\n=== 2. Independent CRA walk vs sanitized stubs ===');
{
  const walk = independentWalk();
  const byDate = new Map(walk.map(r => [r.date, r]));

  const mar13 = byDate.get('2026-03-13');
  const stub13 = STUBS['2026-03-13'];
  ok(mar13.kind === 'regular' && mar13.gross === stub13.gross,
    'Mar 13 independent gross matches stub');
  const cpp13Var = roundCent(mar13.cpp - stub13.cpp);
  ok(near(mar13.cpp, stub13.cpp, TOL.cppRegular),
    `Mar 13 CPP: stub ${stub13.cpp}, independent ${mar13.cpp}, variance ${cpp13Var} (tol ${TOL.cppRegular} from YBE/26 rounding)`,
    `expected ${stub13.cpp} vs ${mar13.cpp}`);
  ok(near(mar13.ei, stub13.ei, TOL.eiFull),
    `Mar 13 EI: stub ${stub13.ei}, independent ${mar13.ei}, variance ${roundCent(mar13.ei - stub13.ei)} (tol ${TOL.eiFull})`);
  ok(near(mar13.pension, stub13.pension, TOL.pension),
    'Mar 13 required 5% pension matches stub 304.02');

  const mar27 = byDate.get('2026-03-27');
  const stub27 = STUBS['2026-03-27'];
  ok(mar27.ei > 0 && mar27.ei < stub13.ei,
    'Mar 27 independent EI is a partial max-transition, not a full 99.11');
  const ei27Var = roundCent(mar27.ei - stub27.ei);
  ok(near(mar27.ei, stub27.ei, TOL.eiMaxTransition),
    `Mar 27 EI: stub ${stub27.ei}, independent ${mar27.ei}, variance ${ei27Var} (tol ${TOL.eiMaxTransition} from wage-only YTD vs stub)`,
    `expected ${stub27.ei} vs ${mar27.ei}`);
  const cpp27Var = roundCent(mar27.cpp - stub27.cpp);
  ok(near(mar27.cpp, stub27.cpp, TOL.cppMaxTransition),
    `Mar 27 CPP: stub ${stub27.cpp}, independent ${mar27.cpp}, variance ${cpp27Var} (tol ${TOL.cppMaxTransition}; per-period vs stub true-up)`,
    `expected ${stub27.cpp} vs ${mar27.cpp}`);

  const eiLast = walk.filter(r => r.ei > 0).pop();
  const cppLast = walk.filter(r => r.cpp > 0).pop();
  const cpp2Last = walk.filter(r => r.cpp2 > 0).pop();
  const post = byDate.get('2026-05-22');
  ok(eiLast && eiLast.date === EXHAUSTION.ei,
    `EI exhaustion deposit is ${EXHAUSTION.ei} (observed stub outcome, not a calendar rule)`,
    eiLast && eiLast.date);
  ok(cppLast && cppLast.date === EXHAUSTION.cpp,
    `base CPP exhaustion deposit is ${EXHAUSTION.cpp}`,
    cppLast && cppLast.date);
  ok(cpp2Last && cpp2Last.date === EXHAUSTION.cpp2,
    `CPP2 exhaustion deposit is ${EXHAUSTION.cpp2}`,
    cpp2Last && cpp2Last.date);
  ok(post && post.cpp === 0 && post.cpp2 === 0 && post.ei === 0,
    'May 22 post-maximum regular has no CPP/CPP2/EI');

  const bonus = byDate.get('2026-02-25');
  ok(bonus && bonus.kind === 'bonus' && bonus.pension === 0,
    'Feb 25 bonus is a separate deposit with no DCPP');
  ok(bonus.ei > 400 && bonus.cpp > 1600,
    'bonus consumes material deposit-year CPP and EI room');
  const withoutBonusEiDone = (() => {
    const acc = { ytdPen: 0, ytdIns: 0, cppPaid: 0, cpp2Paid: 0, eiPaid: 0 };
    const noBonus = INDEPENDENT_DEPOSITS.filter(r => r.kind !== 'bonus');
    let last = null;
    for (const row of noBonus) {
      const deds = independentCppEi(acc, row.gross, row.kind);
      if (deds.ei > 0) last = row.date;
    }
    return last;
  })();
  ok(withoutBonusEiDone > EXHAUSTION.ei,
    'without the February bonus, EI would exhaust later — bonus accelerates the same accumulator',
    `salary-only last EI ${withoutBonusEiDone} vs with-bonus ${EXHAUSTION.ei}`);
}

console.log('\n=== 3. Forecast vs independent walk and stubs ===');
{
  const walk = independentWalk();
  const independent = new Map(walk.map(r => [r.date, r]));
  const forecast = F.daleEstimatedPayrollDeposits(seaspanPlan, '2026-01-01', '2026-05-31');
  ok(forecast.status === 'ready', 'Forecast Seaspan regime is ready on a labelled stream');
  const byDate = new Map((forecast.deposits || []).map(r => [r.date, r]));

  function compare(date, field, tol, label) {
    const ind = independent.get(date);
    const fc = byDate.get(date);
    const stub = STUBS[date];
    ok(!!ind && !!fc, `${date} exists on independent walk and Forecast`);
    if (!ind || !fc) return;
    const varInd = roundCent(fc[field] - ind[field]);
    ok(near(fc[field], ind[field], 0.01),
      `${date} Forecast ${field} matches independent CRA walk (variance ${varInd})`,
      `${fc[field]} vs ${ind[field]}`);
    if (stub && stub[field] != null) {
      const varStub = roundCent(fc[field] - stub[field]);
      ok(near(fc[field], stub[field], tol),
        `${date} ${label}: stub ${stub[field]}, Forecast ${fc[field]}, variance ${varStub} (tol ${tol})`,
        `${fc[field]} vs stub ${stub[field]}`);
    }
  }

  compare('2026-03-13', 'cpp', TOL.cppRegular, 'regular CPP while active');
  compare('2026-03-13', 'ei', TOL.eiFull, 'regular EI while active');
  compare('2026-03-13', 'pension', TOL.pension, 'required pension');
  compare('2026-03-27', 'ei', TOL.eiMaxTransition, 'EI annual max transition');
  compare('2026-03-27', 'cpp', TOL.cppMaxTransition, 'regular CPP on EI-max deposit');
  compare('2026-04-10', 'cpp', 0.01, 'base CPP max transition (independent date)');
  compare('2026-05-08', 'cpp2', 0.01, 'CPP2 exhaustion (independent date)');
  compare('2026-05-22', 'cpp', 0.01, 'post-maximum regular CPP');
  compare('2026-05-22', 'cpp2', 0.01, 'post-maximum regular CPP2');
  compare('2026-05-22', 'ei', 0.01, 'post-maximum regular EI');
  compare('2026-02-25', 'cpp', 0.01, 'February bonus CPP');
  compare('2026-02-25', 'ei', 0.01, 'February bonus EI');

  const fc13 = byDate.get('2026-03-13');
  const stub13 = STUBS['2026-03-13'];
  const tax13Var = roundCent(fc13.tax - stub13.tax);
  ok(near(fc13.tax, stub13.tax, TOL.taxRegular),
    `Mar 13 tax: stub ${stub13.tax}, Forecast ${fc13.tax}, variance ${tax13Var} (tol ${TOL.taxRegular} from T4127 vs Seaspan withholding)`,
    `${fc13.tax} vs ${stub13.tax}`);
  const net13Var = roundCent(fc13.net - stub13.net);
  ok(near(fc13.net, stub13.net, TOL.taxRegular + TOL.cppRegular),
    `Mar 13 net: stub ${stub13.net}, Forecast ${fc13.net}, variance ${net13Var} (tax+CPP demonstrated gaps)`,
    `${fc13.net} vs ${stub13.net}`);

  const fcBonus = byDate.get('2026-02-25');
  const bonusNetVar = roundCent(fcBonus.net - BONUS_2026.net);
  ok(near(fcBonus.net, BONUS_2026.net, TOL.bonusNet),
    `Feb 25 bonus net: stub ${BONUS_2026.net}, Forecast ${fcBonus.net}, variance ${bonusNetVar} (tol ${TOL.bonusNet}; T4127 extra-pay vs Seaspan, not a 53.4% net/gross model)`,
    `${fcBonus.net} vs ${BONUS_2026.net}`);
  ok(Math.abs(fcBonus.net / fcBonus.gross - 0.534) > 0.01,
    'Forecast bonus net is not hard-coded as ~53.4% of gross');

  const fcEiLast = (forecast.deposits || []).filter(d => d.ei > 0).pop();
  const fcCppLast = (forecast.deposits || []).filter(d => d.cpp > 0).pop();
  const fcCpp2Last = (forecast.deposits || []).filter(d => d.cpp2 > 0).pop();
  ok(fcEiLast && fcEiLast.date === EXHAUSTION.ei, 'Forecast EI last deposit matches observed 2026-03-27');
  ok(fcCppLast && fcCppLast.date === EXHAUSTION.cpp, 'Forecast base CPP last deposit matches observed 2026-04-10');
  ok(fcCpp2Last && fcCpp2Last.date === EXHAUSTION.cpp2, 'Forecast CPP2 last deposit matches observed 2026-05-08');
}

console.log('\n=== 4. 2027 estimated regime — trust, raise, bonus, no duplicate ===');
{
  const r = F.daleEstimatedPayrollDeposits(seaspanPlan, '2027-01-01', '2027-03-31');
  ok(r.status === 'ready', '2027 regime is ready');
  const jan1 = r.deposits.find(d => d.date === '2027-01-01' && d.kind === 'regular');
  ok(jan1 && jan1.trust === 'estimated' && jan1.confidence === 'estimated',
    'January 2027 regular is labelled estimated, not verified');
  ok(jan1 && jan1.cpp > 0 && jan1.ei > 0,
    'January 2027 restarts CPP/EI — not the 2026 post-max net');
  ok(jan1 && jan1.net < 4264,
    'January 2027 estimated net is below the incumbent post-max $4,264 modelled cheque',
    jan1 && String(jan1.net));
  ok(jan1 && jan1.statutorySource === 'cra-2027-published-contributions;tax-cra-2026-last-published-planning-assumption',
    '2027 contributions use the published 2027 CRA table; tax stays on the last-published 2026 table, not an invented increment');
  ok(jan1 && jan1.pension === roundCent(6080.42 * 0.06),
    '2027 regular still uses the current 6% employee election (5%+1%)');

  const raised = r.deposits.find(d => d.kind === 'regular' && d.salaryAnnual === 164414.64);
  ok(raised && raised.date === '2027-03-12' && raised.gross === 6323.64,
    'first new-rate regular is 2027-03-12 at 164414.64/26 — anniversary of 2026-02-22, not a hard-coded March 1',
    raised && `${raised.date} ${raised.gross}`);
  const feb26 = r.deposits.find(d => d.date === '2027-02-26' && d.kind === 'regular');
  ok(feb26 && feb26.salaryAnnual === 158091 && feb26.gross === 6080.42,
    '2027-02-26 pay period starts 2027-02-13, before the 2027-02-22 anniversary, so old rate');

  const bonus = r.deposits.find(d => d.kind === 'bonus');
  ok(bonus && bonus.date === '2027-02-25' && bonus.gross === 28456.38,
    '2027 bonus is 18% of 158091 on the last-observed Feb 25 cadence');
  ok(bonus && bonus.pension === 0, '2027 bonus still has no DCPP');
  ok(r.planningAssumptions && r.planningAssumptions.trust === 'estimated'
    && r.planningAssumptions.salaryRaiseDerivedFrom === '2026-02-22',
    'planning assumptions stay estimated and cite the last observed raise date');

  const defaultJan = F.expandEvents(seaspanPlan, '2027-01-01', '2027-01-31')
    .filter(e => e.kind === 'income' && e.id === 'payroll');
  ok(defaultJan.length === 3 && defaultJan.every(e => e.amount === 4264),
    'default expandEvents still emits the incumbent 2026 post-max net — trajectory-local only');

    function trajectoryAsk(asOf, extraPlan, extraOpts) {
    return F.baselineTrajectory(Object.assign({
      windowDays: 91,
      startingCash: { amount: 2500 },
      defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
      budget: {
        basis: 'ytd',
        categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 }],
      },
      obligations: [],
      bills: [],
      commitments: [],
      income: seaspanPlan.income,
      payrollPlanningAssumptions: seaspanPlan.payrollPlanningAssumptions,
    }, extraPlan || {}), [], asOf, Object.assign({
      periods: { periods: { ytd: { label: 'YTD', months: 1, spending: [{ label: 'Groceries', total: 1000 }] } } },
    }, extraOpts || {}));
  }
  const janPays = F.daleEstimatedPayrollDeposits(seaspanPlan, '2027-01-01', '2027-01-31')
    .deposits.filter(d => d.kind === 'regular');
  ok(janPays.length === 3, 'January 2027 has three Seaspan regulars');
  const allJan = janPays[0].net + janPays[1].net + janPays[2].net;
  const laterJan = janPays[1].net + janPays[2].net;

  const futureRepresented = trajectoryAsk('2026-08-19', {
    opening: { asOf: '2026-08-19', representedEvents: [{ id: 'payroll', date: '2027-01-01' }] },
  }, {
    representedEvents: [{ id: 'payroll', date: '2027-01-01' }],
  });
  const futureJan = futureRepresented.months.find(m => m.month === '2027-01');
  ok(futureJan && futureJan.income.status === 'estimated' && futureJan.income.amount !== 0,
    'future represented 2027-01-01 does not zero the month');
  ok(futureJan && near(futureJan.income.amount, allJan, 0.02),
    'future represented payroll@2027-01-01 cannot settle into a 2026-08-19 opening — all three January estimates remain',
    `${futureJan && futureJan.income.amount} vs ${allJan}`);
  ok(futureJan.income.amount !== laterJan,
    'January 2027 is not understated by the unsettled future represented cheque',
    `${futureJan.income.amount} vs later-two ${laterJan}`);

  const settledRepresented = trajectoryAsk('2027-01-01', {
    opening: { asOf: '2027-01-01', representedEvents: [{ id: 'payroll', date: '2027-01-01' }] },
  }, {
    representedEvents: [{ id: 'payroll', date: '2027-01-01' }],
  });
  const settledJan = settledRepresented.months.find(m => m.month === '2027-01');
  ok(settledJan && settledJan.income.status === 'estimated' && settledJan.income.amount !== 0,
    'opening-settled 2027-01-01 does not zero the remaining month');
  ok(settledJan && near(settledJan.income.amount, laterJan, 0.02),
    'same-day represented payroll@2027-01-01 replaces that estimate only — no duplicate third cheque',
    `${settledJan && settledJan.income.amount} vs ${laterJan}`);
}

console.log('\n=== 5. Non-Seaspan streams stay fail-closed ===');
{
  const synthetic = F.daleEstimatedPayrollDeposits({
    income: [{ id: 'payroll', label: 'Synthetic payroll', frequency: 'biweekly', anchor: '2026-06-12', amount: 2000 }],
  }, '2027-01-01', '2027-01-31');
  ok(synthetic.status === 'unavailable',
    'synthetic payroll without Seaspan evidence cannot mint a 2027 Dale net');
}

console.log('\n=== 6. Authorized 2027 regime fails closed after 2027-12-31 ===');
{
  const laterStart = '2027-06-01';
  const horizonDays = 365;
  const [hy, hm, hd] = laterStart.split('-').map(Number);
  const independentHorizonEnd = new Date(Date.UTC(hy, hm - 1, hd + (horizonDays - 1)))
    .toISOString().slice(0, 10);
  ok(independentHorizonEnd === '2028-05-30',
    'a 365-day horizon from 2027-06-01 independently ends 2028-05-30 (2028 leap day)',
    independentHorizonEnd);
  const fcHorizon = F.knowledgeHorizon(seaspanPlan, laterStart);
  ok(fcHorizon && fcHorizon.end >= '2028-02-25',
    'Forecast knowledgeHorizon from 2027-06-01 crosses the unauthorized 2028 bonus date',
    fcHorizon && fcHorizon.end);

  const unauthorizedBonus = roundCent(158091 * 0.18);
  const unauthorizedRaise = roundCent(158091 * 1.04);
  ok(unauthorizedBonus === 28456.38 && unauthorizedRaise === 164414.64,
    'independent 2027 planning amounts are 18% × 158091 and 4% × 158091');

  const r2028 = F.daleEstimatedPayrollDeposits(seaspanPlan, '2028-01-01', '2028-03-31');
  ok(r2028.status === 'ready', 'a 2028 window stays ready rather than inventing a later regime');
  ok((r2028.deposits || []).length === 0,
    'daleEstimatedPayrollDeposits emits no 2028 salary or bonus');

  const rCross = F.daleEstimatedPayrollDeposits(seaspanPlan, '2027-12-01', '2028-03-31');
  ok((rCross.deposits || []).length > 0
    && (rCross.deposits || []).every(d => d.date >= '2027-12-01' && d.date <= '2027-12-31'),
    'a walk that crosses 2028 still emits only authorized 2027 deposits');
  ok(!(rCross.deposits || []).some(d => d.kind === 'bonus' && d.date.startsWith('2028')),
    'no February 2028 bonus is minted from the 2027 18% rate');
  ok(!(rCross.deposits || []).some(d => d.salaryAnnual === unauthorizedRaise && d.date.startsWith('2028')),
    'the 2027 raise is not carried into a 2028 salary');

  const traj = F.baselineTrajectory(Object.assign({
    windowDays: 91,
    startingCash: { amount: 2500 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    budget: {
      basis: 'ytd',
      categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 }],
    },
    obligations: [],
    bills: [],
    commitments: [],
    income: seaspanPlan.income,
    payrollPlanningAssumptions: seaspanPlan.payrollPlanningAssumptions,
  }), [], laterStart, {
    periods: { periods: { ytd: { label: 'YTD', months: 1, spending: [{ label: 'Groceries', total: 1000 }] } } },
  });
  const feb2028 = traj.months.find(m => m.month === '2028-02');
  ok(feb2028 && feb2028.income.status === 'unavailable' && feb2028.cash.status === 'unavailable',
    'February 2028 Dale-containing income and cash stay unavailable');
  ok(!Object.prototype.hasOwnProperty.call(feb2028.income, 'amount')
    || feb2028.income.amount == null,
    'unavailable 2028 income omits an amount rather than publishing the 2027 bonus');
  ok(feb2028.income.amount !== unauthorizedBonus,
    'published 2028 income is not the unauthorized $28,456.38 2027-rate bonus');
  ok(feb2028.income.dalePayroll && feb2028.income.dalePayroll.status === 'unavailable'
    && feb2028.income.dalePayroll.from === '2028-01-01'
    && feb2028.income.dalePayroll.boundary === 'authorized-2027-regime-ends',
    'February 2028 names the authorized-2027-regime-ends boundary');

  const jun2027 = traj.months.find(m => m.month === '2027-06');
  ok(jun2027 && jun2027.income.status === 'estimated' && typeof jun2027.income.amount === 'number'
    && jun2027.income.amount !== 0,
    'June 2027 stays on the authorized estimated regime');

  const after = traj.incomeRegimes.find(r => r.id === 'after-2027-payroll-bonus');
  ok(after && after.status === 'unavailable' && after.from === '2028-01-01'
    && after.boundary === 'authorized-2027-regime-ends',
    'incomeRegimes names the post-2027 fail-closed regime');
  ok(traj.provenance.dalePayrollEstimatedThrough === '2027-12-31'
    && traj.provenance.dalePayrollUnavailableFrom === '2028-01-01',
    'provenance bounds the estimate through 2027-12-31 and withholds from 2028-01-01');
}

console.log('\n=== 7. Canonical owner-policy assumptions — one home, fail closed if absent ===');
{
  const ready = F.daleEstimatedPayrollDeposits(seaspanPlan, '2027-01-01', '2027-03-31');
  ok(ready.status === 'ready' && ready.planningAssumptions
    && ready.planningAssumptions.source === 'plan.payrollPlanningAssumptions'
    && ready.planningAssumptions.salaryRaiseFactor === 1.04
    && ready.planningAssumptions.bonusRate === 0.18
    && ready.planningAssumptions.authorizedThroughYear === 2027,
    'ready regime cites the canonical plan assumptions rather than engine constants');

  const missing = Object.assign({}, seaspanPlan);
  delete missing.payrollPlanningAssumptions;
  const withheld = F.daleEstimatedPayrollDeposits(missing, '2027-01-01', '2027-03-31');
  ok(withheld.status === 'unavailable' && (withheld.deposits || []).length === 0,
    'removing plan.payrollPlanningAssumptions withholds the 2027 estimate');

  const trajMissing = F.baselineTrajectory(Object.assign({
    windowDays: 91,
    startingCash: { amount: 2500 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    budget: {
      basis: 'ytd',
      categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 }],
    },
    obligations: [],
    bills: [],
    commitments: [],
    income: seaspanPlan.income,
  }), [], '2026-08-19', {
    periods: { periods: { ytd: { label: 'YTD', months: 1, spending: [{ label: 'Groceries', total: 1000 }] } } },
  });
  const missingJan = trajMissing.months.find(m => m.month === '2027-01');
  ok(missingJan && missingJan.income.status === 'unavailable'
    && missingJan.cash.status === 'unavailable',
    'trajectory withholds 2027 Dale income/cash when owner assumptions are absent');

  const bumpedRaise = roundCent(158091 * 1.05);
  const bumpedGross = roundCent(bumpedRaise / 26);
  const bumped = Object.assign({}, seaspanPlan, {
    payrollPlanningAssumptions: Object.assign({}, seaspanPlan.payrollPlanningAssumptions, {
      salaryRaiseFactor: 1.05,
    }),
  });
  const rBumped = F.daleEstimatedPayrollDeposits(bumped, '2027-01-01', '2027-03-31');
  const raisedBumped = (rBumped.deposits || []).find(d => d.kind === 'regular' && d.date === '2027-03-12');
  const raisedBase = F.daleEstimatedPayrollDeposits(seaspanPlan, '2027-01-01', '2027-03-31')
    .deposits.find(d => d.kind === 'regular' && d.date === '2027-03-12');
  ok(raisedBumped && raisedBumped.salaryAnnual === bumpedRaise && raisedBumped.gross === bumpedGross,
    'changing plan.payrollPlanningAssumptions.salaryRaiseFactor changes the estimated raise',
    raisedBumped && `${raisedBumped.salaryAnnual} / ${raisedBumped.gross}`);
  ok(raisedBase && raisedBase.salaryAnnual === 164414.64 && raisedBumped.salaryAnnual !== raisedBase.salaryAnnual,
    'the bumped raise is not the canonical 1.04 result');

  const bumpedBonusPlan = Object.assign({}, seaspanPlan, {
    payrollPlanningAssumptions: Object.assign({}, seaspanPlan.payrollPlanningAssumptions, {
      bonusRate: 0.20,
    }),
  });
  const rBonus = F.daleEstimatedPayrollDeposits(bumpedBonusPlan, '2027-02-01', '2027-02-28');
  const bonusBumped = (rBonus.deposits || []).find(d => d.kind === 'bonus');
  const bonusBase = F.daleEstimatedPayrollDeposits(seaspanPlan, '2027-02-01', '2027-02-28')
    .deposits.find(d => d.kind === 'bonus');
  ok(bonusBumped && bonusBumped.gross === roundCent(158091 * 0.20),
    'changing plan.payrollPlanningAssumptions.bonusRate changes the estimated bonus',
    bonusBumped && String(bonusBumped.gross));
  ok(bonusBase && bonusBase.gross === 28456.38 && bonusBumped.gross !== bonusBase.gross,
    'the bumped bonus is not the canonical 0.18 result');
}

console.log('\n' + '═'.repeat(60));
if (failures) {
  console.log(`FAILED — ${failures} dale-payroll-regime check(s)`);
  process.exit(1);
}
console.log('ALL DALE PAYROLL REGIME CHECKS PASSED');
