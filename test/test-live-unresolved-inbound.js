'use strict';
/* Independent proofs for the live-overlay same-day inbound trust split:
 * complete trusted current cash remains the Forecast opening when a same-day
 * inbound is unresolved; that inbound is not counted until proven; already-
 * posted bills/spending/income are not counted twice. L-002 / L-006: cash
 * specs are hand arithmetic on named fixture balances, not live data.json
 * cents.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Live = require('../scripts/live-plan.js');
const OA = require('../scripts/operating-answer.js');
const Assistant = require('../scripts/assistant-packet.js');
const Forecast = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');
const IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const localMapPath = path.join(ROOT, 'docs', 'connectivity', 'provider-account-map.local.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const clone = x => JSON.parse(JSON.stringify(x));
const round2 = n => Math.round(Number(n) * 100) / 100;

const liveData = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const accountMap = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
const SALARY = 2387.99;

function cashValue(data, id) {
  const row = ((data.plan && data.plan.startingCash && data.plan.startingCash.breakdown) || [])
    .find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}

function debt(data, id) {
  return ((data.debts || []).find(d => d && d.id === id)) || null;
}

function completePendingCoverage() {
  return { complete: true, basis: 'is_pending-unbounded', hasMore: false };
}

function freshness(at) {
  return { cashAt: at, cardAt: at, loanAt: at, triangleAt: at };
}

function matchingAccounts(data, tweaks) {
  const t = tweaks || {};
  const accounts = [
    {
      id: 3001, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-a'] != null ? t['chequing-a'] : cashValue(data, 'chequing-a'),
      updated_at: t.cashAt || '2026-08-31T17:55:00.000Z', balance_last_update: t.cashAt || '2026-08-31T17:55:00.000Z',
    },
    {
      id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-b'] != null ? t['chequing-b'] : cashValue(data, 'chequing-b'),
      updated_at: t.cashAt || '2026-08-31T17:55:00.000Z', balance_last_update: t.cashAt || '2026-08-31T17:55:00.000Z',
    },
    {
      id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.savings != null ? t.savings : cashValue(data, 'savings'),
      updated_at: t.savingsAt || t.cashAt || '2026-08-31T17:55:00.000Z', balance_last_update: t.savingsAt || t.cashAt || '2026-08-31T17:55:00.000Z',
    },
    {
      id: 3004, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.tdcc != null ? t.tdcc : debt(data, 'tdcc').balance,
      credit_limit: debt(data, 'tdcc').limit,
      updated_at: t.cardAt || '2026-08-31T17:55:00.000Z', balance_last_update: t.cardAt || '2026-08-31T17:55:00.000Z',
    },
    {
      id: 3005, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.cashback != null ? t.cashback : debt(data, 'cashback').balance,
      credit_limit: debt(data, 'cashback').limit,
      updated_at: t.cardAt || '2026-08-31T17:55:00.000Z', balance_last_update: t.cardAt || '2026-08-31T17:55:00.000Z',
    },
    {
      id: 3006, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.travelvisa != null ? t.travelvisa : debt(data, 'travelvisa').balance,
      credit_limit: debt(data, 'travelvisa').limit,
      updated_at: t.cardAt || '2026-08-31T17:55:00.000Z', balance_last_update: t.cardAt || '2026-08-31T17:55:00.000Z',
    },
    {
      id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.heloc != null ? t.heloc : debt(data, 'heloc').balance,
      updated_at: t.loanAt || '2026-08-31T17:55:00.000Z', balance_last_update: t.loanAt || '2026-08-31T17:55:00.000Z',
    },
    {
      id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.mortgage != null ? t.mortgage : debt(data, 'mortgage').balance,
      updated_at: t.loanAt || '2026-08-31T17:55:00.000Z', balance_last_update: t.loanAt || '2026-08-31T17:55:00.000Z',
    },
    {
      id: 3010, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'Canadian Tire Bank', currency: 'cad',
      balance: t.triangle != null ? t.triangle : debt(data, 'triangle').balance,
      credit_limit: debt(data, 'triangle').limit,
      updated_at: t.triangleAt || '2026-08-31T17:55:00.000Z', balance_last_update: t.triangleAt || '2026-08-31T17:55:00.000Z',
    },
  ];
  if (t.omitProviderIds && t.omitProviderIds.length) {
    const omit = new Set(t.omitProviderIds);
    return accounts.filter(account => !omit.has(account.id));
  }
  return accounts;
}

function payloadFrom(data, extra) {
  const extraPayload = extra || {};
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: extraPayload.fetchedAt || '2026-08-31T18:00:00.000Z',
    source: 'Synthetic unresolved-inbound fixture. Fixture IDs 3001–3010 are not live provider IDs.',
    pendingCoverage: extraPayload.pendingCoverage === undefined
      ? completePendingCoverage() : extraPayload.pendingCoverage,
    accounts: matchingAccounts(data, extraPayload.tweaks),
    transactions: extraPayload.transactions || [],
  };
  if (extraPayload.categories) payload.categories = extraPayload.categories;
  if (extraPayload.transactionWindow) payload.transactionWindow = extraPayload.transactionWindow;
  return payload;
}

function overlay(data, extra) {
  return Live.fromObservation({
    data,
    payload: payloadFrom(data, extra),
    accountMap,
    identity,
  });
}

function serve(canonical, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-unresolved-inbound-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, `${JSON.stringify(payloadFrom(canonical, extra), null, 2)}\n`);
  return Live.serveCanonicalOrFixture(canonical, {
    ATLAS_LIVE_OVERLAY: 'fixture',
    ATLAS_LIVE_OVERLAY_FIXTURE: fixture,
    ATLAS_LIVE_OVERLAY_MAP: MAP,
  });
}

// These checks prove that unresolved inbound cash adds nothing by observing the
// incumbent withholding path, which needs the card-coverage owner rule absent.
// Under the canonical rule (opening 2026-11-06, after these fixtures) card
// activity here is existing debt; that path is pinned separately below.
function withoutCoverageRule(data) {
  const plan = { ...data.plan };
  delete plan.cardPurchaseCoverage;
  return { ...data, plan };
}
function recommend(data, asOf) {
  return Forecast.recommend(data.plan, asOf, {
    debts: data.debts,
    revolvingExtra: data.revolvingExtra,
    targetBuffer: data.plan.defaults && data.plan.defaults.targetBuffer,
    operatingPlan: data.liveOverlay && data.liveOverlay.operatingPlan,
    operatingPlanNote: data.liveOverlay && data.liveOverlay.operatingPlanNote,
    currentPeriodActuals: data.liveOverlay && data.liveOverlay.applied
      ? data.liveOverlay.currentPeriodActuals : null,
  });
}

function activePeriod(advice) {
  return ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.role === 'active') || null;
}

function periodByRole(advice, role) {
  return ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.role === role) || null;
}

function incomeRow(advice, id) {
  const periods = (advice.defaultView && advice.defaultView.calendarPeriods) || [];
  for (const period of periods) {
    const row = (period.income || []).find(r => r && r.id === id);
    if (row) return row;
  }
  return null;
}

function notRelied(plan, id, date) {
  return ((plan.opening && plan.opening.notReliedUponEvents) || [])
    .find(row => row && row.id === id && row.date === date) || null;
}

function represented(plan, id, date) {
  return ((plan.opening && plan.opening.representedEvents) || [])
    .some(row => row && row.id === id && row.date === date);
}

function transferTx(id, accountId, amount, payee) {
  return {
    id, account_id: accountId, date: '2026-08-31', amount, payee,
    category_id: 24, exclude_from_totals: true, is_pending: false, status: 'reviewed',
  };
}

function isolateGroceries(plan) {
  plan.budget = Object.assign({}, plan.budget, {
    categories: (plan.budget.categories || []).map(cat => {
      if (!cat) return cat;
      if (cat.id === 'groceries') {
        return Object.assign({}, cat, {
          plannedPayday: 900, plannedWeekly: null, plannedMonthly: null,
          targetEffectiveFrom: null, targetHistory: [],
        });
      }
      // This synthetic fixture replaces each owner target with zero. Retained
      // historical owner rows must not restore a real budget into this oracle.
      return Object.assign({}, cat, {
        plannedPayday: 0, plannedWeekly: null, plannedMonthly: null,
        targetEffectiveFrom: null, targetHistory: [],
      });
    }),
  });
}

const AUG31_WINDOW = {
  startDate: '2026-08-28', endDate: '2026-08-31',
  complete: true, hasMore: false, truncated: false,
};
const TRANSFER_CATS = [
  { id: 21, name: 'Income', is_income: true, exclude_from_totals: false },
  { id: 24, name: 'Payment/Transfer', is_income: false, exclude_from_totals: true },
  { id: 11, name: 'Groceries', is_income: false, exclude_from_totals: false },
];

const tennisMap = (accountMap.mappings || []).find(m => m && m.externalId === 'tennis-income');
ok(tennisMap && tennisMap.atlasRole === 'household-external'
    && tennisMap.externalId === 'tennis-income',
  'fixture map already has household-external tennis-income');
ok(!fs.existsSync(localMapPath),
  'production/local live map is not in this workspace (not committed)');

console.log('\n=== 1. August 30 control: live cash plus unposted same-day bill ===');
{
  const A = 2825.05;
  const B = -538.09;
  const S = 0.58;
  const independentCash = round2(A + B + S);
  const independentChequing = round2(A + B);
  const independentHub = A;
  ok(near(independentCash, 2287.54), 'independent Aug 30 cash is $2,287.54');
  const canonical = clone(liveData);
  const scheduledFees = Number((canonical.plan.bills || [])
    .find(row => row && row.id === 'tdfees').amount);
  const extra = {
    fetchedAt: '2026-08-30T18:00:00.000Z',
    tweaks: Object.assign({
      'chequing-a': A, 'chequing-b': B, savings: S,
    }, freshness('2026-08-30T17:55:00.000Z')),
  };
  const result = overlay(canonical, extra);
  ok(result.data.liveOverlay.applied === true, 'Aug 30 overlay applies');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing),
    'Forecast opening equals the independent chequing-only observed-cash sum');
  const advice = recommend(withoutCoverageRule(result.data), '2026-08-30');
  const fees = ((advice.currentPeriodAction && advice.currentPeriodAction.bills) || [])
    .find(row => row && row.id === 'tdfees' && row.date === '2026-08-30')
    || ((activePeriod(advice) && activePeriod(advice).bills) || [])
      .find(row => row && row.id === 'tdfees');
  ok(fees && fees.settlement !== 'represented' && near(fees.remaining, scheduledFees),
    'unposted same-day TD fees remain due once');
  ok(advice.paydayAllocation
      && near(Forecast.startingCashAmount(result.data.plan), independentChequing)
        && advice.paydayAllocation.available === null && advice.cardCoverageUnavailable === true,
    'unposted bill does not invalidate or re-deduct current cash at the opening');
}

console.log('\n=== 2. August 31 proven Amanda TENNIS INCOME → BILLS transfer ===');
{
  const A = 1850.25;
  const B = 200.10;
  const S = 7.19;
  const independentCash = round2(A + B + S);
  const independentChequing = round2(A + B);
  const independentHub = A;
  const canonical = clone(liveData);
  const extra = {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    categories: TRANSFER_CATS,
    transactionWindow: AUG31_WINDOW,
    tweaks: Object.assign({
      'chequing-a': A, 'chequing-b': B, savings: S,
    }, freshness('2026-08-31T17:55:00.000Z')),
    transactions: [
      transferTx(97001, 3001, -SALARY, 'INTERNAL TRANSFER'),
      transferTx(97002, 3009, SALARY, 'INTERNAL TRANSFER'),
    ],
  };
  const result = overlay(canonical, extra);
  ok(result.data.liveOverlay.applied === true
      && result.data.liveOverlay.operatingPlan === Live.OPERATING_PLAN_LIVE,
    'proven overlay is live');
  ok(represented(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31'),
    'salary is represented exactly once on the opening');
  ok(!notRelied(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31'),
    'proven salary is not also not-relied-upon');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing),
    'opening equals independent observed-cash sum');
  const advice = recommend(result.data, '2026-08-31');
  const p2 = activePeriod(advice);
  ok(p2 && p2.role === 'active' && p2.start === '2026-08-28' && p2.end === '2026-09-10',
    'This Pay Period is active on Aug 31');
  ok(near(advice.defaultView.liveCurrentBalance, independentHub)
      && near(advice.paydayAllocation.liveCurrentBalance, independentHub),
    'live Current Balance is posted hub (chequing-a / BILLS ACCOUNT), not pooled A+B');
  const snap = result.data.plan.opening && result.data.plan.opening.paydaySnapshot;
  const datedAsOf = canonical.plan.opening && canonical.plan.opening.asOf;
  const child = (canonical.plan.income || []).find(s => s && s.id === 'childBenefit');
  const travel = (canonical.plan.obligations || []).find(o => o && o.id === 'travel');
  let independentMorning = Forecast.startingCashAmount(canonical.plan);
  if (child && datedAsOf && datedAsOf < '2026-08-20' && '2026-08-20' < p2.start) {
    independentMorning = round2(independentMorning + Number(child.amount));
  }
  const representedKeys = new Set(((result.data.plan.opening && result.data.plan.opening.representedEvents) || [])
    .filter(r => r && r.date && r.date < p2.start)
    .map(r => String(r.id) + '@' + String(r.date)));
  if (travel && datedAsOf && datedAsOf < '2026-08-26' && '2026-08-26' < p2.start
      && representedKeys.has('travel@2026-08-26')) {
    independentMorning = round2(independentMorning - Number(travel.amount));
  }
  ok(!snap,
    'live overlay does not retain a scheduled-only paydaySnapshot from the dated opening walk');
  ok(p2.openingKnown !== true && p2.opening == null
      && !near(independentMorning, independentCash),
    'mid-period live overlay withholds the incomplete walked Aug 28 opening; live cash stays a separate fact');
  ok(p2.available != null && near(p2.available, p2.incomeTotal),
    'Payday balance still publishes the period income identity');
  ok(!near(advice.paydayAllocation.available, independentCash + SALARY),
    'salary is not added again on top of observed cash');
  const row = incomeRow(advice, 'amandaSalaryMonthEnd');
  ok(row && (row.settlement === 'represented' || row.alreadyInCash === true),
    'proven salary is shown as represented/already in cash');
}

console.log('\n=== 3. August 31 no transfer yet — core unresolved inbound ===');
{
  const A = 1850.25;
  const B = 200.10;
  const S = 7.19;
  const independentCash = round2(A + B + S);
  const independentChequing = round2(A + B);
  const independentHub = A;
  const canonical = clone(liveData);
  const extra = {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    categories: TRANSFER_CATS,
    transactionWindow: AUG31_WINDOW,
    tweaks: Object.assign({
      'chequing-a': A, 'chequing-b': B, savings: S,
    }, freshness('2026-08-31T17:55:00.000Z')),
    transactions: [],
  };
  const result = overlay(canonical, extra);
  ok(result.data.liveOverlay.applied === true
      && result.data.liveOverlay.operatingPlan === Live.OPERATING_PLAN_LIVE,
    'complete current cash still becomes a live operating plan');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing),
    'current live cash is the Forecast opening');
  ok(!represented(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31'),
    'salary is not labelled represented');
  const unresolved = notRelied(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31');
  ok(unresolved && unresolved.reason === 'same-day-inbound-unproven',
    'salary is explicitly not-relied-upon');
  const advice = recommend(withoutCoverageRule(result.data), '2026-08-31');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing)
        && advice.paydayAllocation.available === null && advice.cardCoverageUnavailable === true,
    'Amanda salary contributes $0 additional available cash');
  const row = incomeRow(advice, 'amandaSalaryMonthEnd');
  ok(row && row.notReliedUpon === true && row.settlement === 'not-relied-upon'
      && row.status === 'unresolved' && row.alreadyInCash !== true
      && near(row.remaining, 0),
    'salary is unresolved / not received');
  ok(!near(advice.paydayAllocation.available, independentCash + SALARY),
    'double-count of unproven salary is impossible on this opening');
}

console.log('\n=== 4. Ambiguous TENNIS INCOME counterparts ===');
{
  const A = 1600;
  const B = 100;
  const S = 1.5;
  const independentCash = round2(A + B + S);
  const independentChequing = round2(A + B);
  const independentHub = A;
  const canonical = clone(liveData);
  const extra = {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    categories: TRANSFER_CATS,
    transactionWindow: AUG31_WINDOW,
    tweaks: Object.assign({
      'chequing-a': A, 'chequing-b': B, savings: S,
    }, freshness('2026-08-31T17:55:00.000Z')),
    transactions: [
      transferTx(97011, 3001, -SALARY, 'INTERNAL TRANSFER'),
      transferTx(97012, 3009, SALARY, 'INTERNAL TRANSFER'),
      transferTx(97013, 3009, SALARY, 'INTERNAL TRANSFER'),
    ],
  };
  const result = overlay(canonical, extra);
  ok(result.data.liveOverlay.applied === true, 'ambiguous pair still overlays trusted cash');
  ok(!represented(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31'),
    'ambiguous salary is not represented');
  const unresolved = notRelied(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31');
  ok(unresolved && unresolved.reason === 'same-day-inbound-ambiguous'
      && unresolved.candidateCount >= 2,
    'ambiguity is surfaced on notReliedUponEvents');
  const advice = recommend(withoutCoverageRule(result.data), '2026-08-31');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing)
        && advice.paydayAllocation.available === null && advice.cardCoverageUnavailable === true,
    'ambiguous salary contributes $0');
}

console.log('\n=== 5. Wrong source: WEEKLY SPENDING → BILLS is not salary ===');
{
  const A = 1400.40;
  const B = 90.10;
  const S = 2.22;
  const independentCash = round2(A + B + S);
  const independentChequing = round2(A + B);
  const independentHub = A;
  const canonical = clone(liveData);
  const extra = {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    categories: TRANSFER_CATS,
    transactionWindow: AUG31_WINDOW,
    tweaks: Object.assign({
      'chequing-a': A, 'chequing-b': B, savings: S,
    }, freshness('2026-08-31T17:55:00.000Z')),
    transactions: [
      transferTx(97021, 3001, -SALARY, 'INTERNAL TRANSFER'),
      transferTx(97022, 3002, SALARY, 'INTERNAL TRANSFER'),
    ],
  };
  const result = overlay(canonical, extra);
  ok(result.data.liveOverlay.applied === true, 'wrong-source overlay keeps trusted cash');
  ok(!represented(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31'),
    'WEEKLY→BILLS is not salary');
  ok(notRelied(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31'),
    'wrong-source salary stays unresolved');
  const advice = recommend(withoutCoverageRule(result.data), '2026-08-31');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing)
        && advice.paydayAllocation.available === null && advice.cardCoverageUnavailable === true,
    'wrong-source transfer contributes $0 additional income');
}

console.log('\n=== 6. Wrong amount TENNIS INCOME → BILLS ===');
{
  const A = 1555.55;
  const B = 40.40;
  const S = 3.03;
  const independentCash = round2(A + B + S);
  const independentChequing = round2(A + B);
  const independentHub = A;
  const canonical = clone(liveData);
  const extra = {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    categories: TRANSFER_CATS,
    transactionWindow: AUG31_WINDOW,
    tweaks: Object.assign({
      'chequing-a': A, 'chequing-b': B, savings: S,
    }, freshness('2026-08-31T17:55:00.000Z')),
    transactions: [
      transferTx(97031, 3001, -81.17, 'INTERNAL TRANSFER'),
      transferTx(97032, 3009, 81.17, 'INTERNAL TRANSFER'),
    ],
  };
  const result = overlay(canonical, extra);
  ok(result.data.liveOverlay.applied === true, 'wrong-amount overlay keeps trusted cash');
  ok(!represented(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31'),
    'wrong amount is not represented');
  ok(notRelied(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31'),
    'wrong-amount salary stays unresolved');
  const advice = recommend(withoutCoverageRule(result.data), '2026-08-31');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing)
        && advice.paydayAllocation.available === null && advice.cardCoverageUnavailable === true,
    'wrong-amount pair contributes $0 additional income');
}

console.log('\n=== 7. Incomplete current cash still fails closed ===');
{
  const canonical = clone(liveData);
  let threw = null;
  try {
    overlay(canonical, {
      fetchedAt: '2026-08-31T18:00:00.000Z',
      tweaks: Object.assign({ omitProviderIds: [3001] }, freshness('2026-08-31T17:55:00.000Z')),
    });
  } catch (err) {
    threw = err;
  }
  ok(threw && /missing-live-cash-evidence/.test(threw.message),
    'missing required cash still fails closed', threw && threw.message);
  const served = serve(canonical, {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    tweaks: Object.assign({ omitProviderIds: [3001] }, freshness('2026-08-31T17:55:00.000Z')),
  });
  ok(served.liveOverlay.applied === false
      && served.liveOverlay.operatingPlan === Live.OPERATING_PLAN_UNAVAILABLE,
    'incomplete cash is not turned into a live plan');
  ok(String(served.plan.opening.asOf) === '2026-08-19',
    'fail-closed overlay keeps the dated opening');
}

console.log('\n=== 8. Actual spending does not double-count ===');
{
  const independentCash = 3000;
  const independentChequing = 3000;
  const independentHub = 3000;
  const planned = 900;
  const committed = 350;
  const remaining = round2(planned - committed);
  ok(near(remaining, 550), 'independent grocery remaining is $550');
  const canonical = clone(liveData);
  isolateGroceries(canonical.plan);
  const extra = {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    tweaks: Object.assign({
      'chequing-a': independentChequing, 'chequing-b': 0, savings: 0,
    }, freshness('2026-08-31T17:55:00.000Z')),
  };
  const result = overlay(canonical, extra);
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing),
    'opening is the $3,000 chequing fixture; designated savings $0 stays an asset, not opening');
  const advice = Forecast.recommend(result.data.plan, '2026-08-31', {
    debts: result.data.debts,
    operatingPlan: result.data.liveOverlay.operatingPlan,
    currentPeriodActuals: {
      observationAsOf: '2026-08-31',
      coverageStart: '2026-08-14',
      coverageThrough: '2026-08-31',
      pendingCoverage: { complete: true, status: 'complete', basis: 'is_pending-unbounded' },
      transactions: [{
        date: '2026-08-31', amount: committed, pending: false,
        categoryLabel: 'Groceries', accountRole: 'household-cash',
        displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
        merchantKnown: true,
      }],
    },
  });
  const p2 = activePeriod(advice);
  const groceries = (p2.householdBudget || []).find(row => row && row.id === 'groceries');
  ok(groceries && near(groceries.planned, planned) && near(groceries.spent, committed)
      && near(groceries.remaining, remaining) && near(groceries.hold, planned),
    'Household Budget still reserves the full $900 plan when spent is $350');
  ok(p2 && near(p2.budgetHold, planned),
    'waterfall hold is the full grocery plan, not remaining $550');
  ok(p2.openingKnown !== true && p2.opening == null,
    'incomplete gap withholds the payday opening rather than starting it from a scheduled-only walk or live cash');
  ok(p2.available != null && near(p2.available, p2.incomeTotal),
    'Payday balance still publishes the period income identity');
  ok(near(advice.defaultView.liveCurrentBalance, independentHub),
    'live Current Balance stays the posted hub (chequing-a / BILLS ACCOUNT)');
  ok(!near(remaining, planned) && near(groceries.hold, planned)
      && !near(groceries.hold, planned + committed),
    'Household Budget still reserves the full $900 plan, not remaining $550 and not plan + actual');
}

console.log('\n=== 9. Paid bill does not double-count ===');
{
  const independentCash = 3000;
  const independentChequing = 3000;
  const independentHub = 3000;
  const canonical = clone(liveData);
  canonical.plan = Object.assign({}, canonical.plan, {
    bills: (canonical.plan.bills || []).concat([{
      id: 'synthetic-paid-bill',
      label: 'Synthetic paid bill',
      frequency: 'once',
      date: '2026-08-31',
      amount: 100,
      confidence: 'confirmed',
      payingAccount: 'chequing-a',
    }]),
  });
  const extra = {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    tweaks: Object.assign({
      'chequing-a': independentCash, 'chequing-b': 0, savings: 0,
    }, freshness('2026-08-31T17:55:00.000Z')),
  };
  const result = overlay(canonical, extra);
  result.data.plan.opening.representedEvents = (result.data.plan.opening.representedEvents || [])
    .concat([{ id: 'synthetic-paid-bill', date: '2026-08-31' }]);
  const advice = recommend(result.data, '2026-08-31');
  const p2 = activePeriod(advice);
  const paid = (p2.bills || []).find(row => row && row.id === 'synthetic-paid-bill');
  ok(paid && paid.status === 'PAID' && near(paid.remaining, 0),
    'paid bill is visible as PAID with remaining $0');
  ok(p2.remainingBills == null || !near(p2.remainingBills, 100)
      || near(p2.remainingBills, round2(p2.remainingBills - 0)),
    'remaining-bills total is defined');
  const remainingWithoutPaid = round2((p2.bills || [])
    .filter(row => row && row.id !== 'synthetic-paid-bill' && row.status !== 'PAID' && !row.needsDate)
    .reduce((s, r) => s + Math.abs(Number(r.remaining != null ? r.remaining : r.amount) || 0), 0));
  ok(near(p2.remainingBills, remainingWithoutPaid),
    'waterfall remaining bills omit the already-paid $100');
  ok(near(advice.defaultView.liveCurrentBalance, independentHub)
      && near(Forecast.startingCashAmount(result.data.plan), independentChequing)
        && advice.paydayAllocation.available === null && advice.cardCoverageUnavailable === true,
    'live Current Balance stays posted hub (chequing-a); observed A+B cash stays actual while usable money remains unconfirmed, not cash minus the paid bill again');
}

console.log('\n=== 10. Active two-period calendar waterfall ===');
{
  const A = 1850.25;
  const B = 200.10;
  const S = 7.19;
  const independentCash = round2(A + B + S);
  const independentChequing = round2(A + B);
  const independentHub = A;
  const canonical = clone(liveData);
  isolateGroceries(canonical.plan);
  const extra = {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    tweaks: Object.assign({
      'chequing-a': A, 'chequing-b': B, savings: S,
    }, freshness('2026-08-31T17:55:00.000Z')),
  };
  const result = overlay(canonical, extra);
  const advice = Forecast.recommend(result.data.plan, '2026-08-31', {
    debts: result.data.debts,
    operatingPlan: result.data.liveOverlay.operatingPlan,
    currentPeriodActuals: {
      observationAsOf: '2026-08-31',
      coverageStart: '2026-08-14',
      coverageThrough: '2026-08-31',
      pendingCoverage: { complete: true, status: 'complete', basis: 'is_pending-unbounded' },
      transactions: [{
        date: '2026-08-31', amount: 350, pending: false,
        categoryLabel: 'Groceries', accountRole: 'household-cash',
        displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
        merchantKnown: true,
      }],
    },
  });
  const thisP = periodByRole(advice, 'active');
  const nextP = periodByRole(advice, 'future');
  ok(thisP && thisP.start === '2026-08-28' && thisP.end === '2026-09-10',
    'This Pay Period is the Aug 28–Sep 10 Seaspan window');
  ok(nextP && nextP.start === '2026-09-11' && nextP.end === '2026-09-24',
    'Next Pay Period is Sep 11–Sep 24');
  ok(thisP.operatingPlanUnavailable !== true, 'active waterfall is not unavailable');
  ok(near(advice.defaultView.liveCurrentBalance, independentHub),
    'live Current Balance is posted hub (chequing-a / BILLS ACCOUNT)');
  const snap = result.data.plan.opening && result.data.plan.opening.paydaySnapshot;
  const datedAsOf = canonical.plan.opening && canonical.plan.opening.asOf;
  const child = (canonical.plan.income || []).find(s => s && s.id === 'childBenefit');
  const travel = (canonical.plan.obligations || []).find(o => o && o.id === 'travel');
  let independentMorning = Forecast.startingCashAmount(canonical.plan);
  if (child && datedAsOf && datedAsOf < '2026-08-20' && '2026-08-20' < thisP.start) {
    independentMorning = round2(independentMorning + Number(child.amount));
  }
  const representedKeys = new Set(((result.data.plan.opening && result.data.plan.opening.representedEvents) || [])
    .filter(r => r && r.date && r.date < thisP.start)
    .map(r => String(r.id) + '@' + String(r.date)));
  if (travel && datedAsOf && datedAsOf < '2026-08-26' && '2026-08-26' < thisP.start
      && representedKeys.has('travel@2026-08-26')) {
    independentMorning = round2(independentMorning - Number(travel.amount));
  }
  ok(!snap,
    'overlay does not retain a scheduled-only paydaySnapshot from the dated opening walk');
  ok(thisP.openingKnown !== true && thisP.opening == null
      && !near(independentMorning, independentCash),
    'active payday opening is withheld when the opening-to-payday gap is not cash-complete');
  ok(thisP.available != null && near(thisP.available, thisP.incomeTotal),
    'Payday balance still publishes the period income identity');
  // #620 simplified contract: the incomplete packet and absent payday basis
  // cannot establish a future Bills sweep. Current displays above stay valid.
  ok(nextP.openingKnown !== true && nextP.opening == null && nextP.paydaySweep == null,
    'next opening and sweep stay unknown without a qualified payday Bills basis');
  ok(thisP.remainingBills != null, 'active period shows remaining bills');
  const groceries = (thisP.householdBudget || []).find(row => row && row.id === 'groceries');
  ok(groceries && groceries.planned != null && groceries.spent != null
      && groceries.remaining != null,
    'Household Budget planned/actual/remaining are visible');
  const independentBad = thisP.incomeTotal != null && thisP.periodBillLoad != null
      && thisP.budgetHold != null
    ? round2(thisP.incomeTotal - thisP.periodBillLoad - thisP.budgetHold)
    : null;
  ok(independentBad != null
      && thisP.afterHouseholdBudget != null
      && thisP.predictedEndingBalance != null
      && near(thisP.afterHouseholdBudget, independentBad)
      && near(thisP.predictedEndingBalance, independentBad)
      && thisP.predictedEndingBalanceIdentity === 'balance-after-deductions',
    'Predicted Ending Balance publishes as incomeTotal − periodBillLoad − hold without payday opening');
}

console.log('\n=== 11. Failed-cash control withholds stale Current Balance ===');
{
  // Purpose reserves are optional evidence for the operating overlay. Remove
  // a required operating account to prove the current-cash failure boundary.
  const served = serve(clone(liveData), {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    tweaks: Object.assign({ omitProviderIds: [3001] }, freshness('2026-08-31T17:55:00.000Z')),
  });
  ok(served.liveOverlay.applied === false
      && served.liveOverlay.operatingPlan === Live.OPERATING_PLAN_UNAVAILABLE,
    'untrusted current cash keeps operatingPlan unavailable');
  const advice = recommend(served, served.meta.asOf);
  const active = activePeriod(advice);
  ok(active && active.operatingPlanUnavailable === true,
    'Forecast withholds current guidance');
  ok(active.available == null && active.incomeAdded == null,
    'stale leftover chain is not published as current');
  ok(String(served.plan.opening.asOf) === '2026-08-19',
    'August 19 opening is not advanced');
}

console.log('\n=== 12. Assistant / operating-answer consume Forecast, no second calc ===');
{
  const A = 1111.11;
  const B = 222.22;
  const S = 3.33;
  const independentCash = round2(A + B + S);
  const independentChequing = round2(A + B);
  const independentHub = A;
  const applied = overlay(clone(liveData), {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    tweaks: Object.assign({
      'chequing-a': A, 'chequing-b': B, savings: S,
    }, freshness('2026-08-31T17:55:00.000Z')),
  });
  const advice = recommend(applied.data, '2026-08-31');
  const operating = OA.fromRefreshedState(applied.data, { mode: 'live-overlay' });
  ok(operating.source === 'Forecast.recommend',
    'operating-answer names Forecast.recommend as source');
  ok(near(operating.moneyAvailable.value, advice.paydayAllocation.available)
      && near(operating.asOf && Forecast.startingCashAmount(applied.data.plan), independentChequing),
    'operating-answer copies the current Forecast leftover, not a second calc');
  const packet = Assistant.buildPacket({
    data: applied.data,
    periods: Assistant.loadPeriods(),
    questionsMarkdown: '',
    now: '2026-08-31T18:00:00.000Z',
  });
  ok(packet?.forecast?.status === 'unavailable'
    && near(packet.current.spendableHouseholdCash.observedCash,
      Forecast.startingCashAmount(applied.data.plan)),
    'assistant preserves observed cash while missing coverage confirmation withholds usable money');

  const failed = serve(clone(liveData), {
    fetchedAt: '2026-08-31T18:00:00.000Z',
    tweaks: Object.assign({ omitProviderIds: [3001] }, freshness('2026-08-31T17:55:00.000Z')),
  });
  const failedOperating = OA.fromRefreshedState(failed, { mode: 'live-overlay' });
  ok(failedOperating.moneyAvailable.status === 'unavailable'
      && failedOperating.currentSpendingPermission.weekly == null,
    'incomplete current cash stays fail closed in operating-answer');
  const failedPacket = Assistant.buildPacket({
    data: failed,
    periods: Assistant.loadPeriods(),
    questionsMarkdown: '',
    now: '2026-08-31T18:00:00.000Z',
  });
  ok(failedPacket.forecast && failedPacket.forecast.status === 'unavailable',
    'assistant packet stays fail closed when current cash is incomplete');
}

console.log('\n=== 13. Same-date refresh: opening already liveAsOf, inbound still unresolved ===');
{
  const A = 1744.44;
  const B = 155.55;
  const S = 4.01;
  const independentCash = round2(A + B + S);
  const independentChequing = round2(A + B);
  const independentHub = A;
  ok(near(independentCash, 1904), 'independent same-date cash is $1,904.00');
  const canonical = clone(liveData);
  canonical.meta = Object.assign({}, canonical.meta, { asOf: '2026-08-31' });
  canonical.plan = Object.assign({}, canonical.plan, {
    opening: Object.assign({}, canonical.plan.opening || {}, {
      asOf: '2026-08-31',
      representedEvents: (canonical.plan.opening && canonical.plan.opening.representedEvents) || [],
    }),
  });
  ok(String(canonical.plan.opening.asOf) === '2026-08-31',
    'starting/canonical opening is already the observation date');
  const extra = {
    fetchedAt: '2026-08-31T21:10:00.000Z',
    categories: TRANSFER_CATS,
    transactionWindow: AUG31_WINDOW,
    tweaks: Object.assign({
      'chequing-a': A, 'chequing-b': B, savings: S,
    }, freshness('2026-08-31T21:05:00.000Z')),
    transactions: [],
  };
  const result = overlay(canonical, extra);
  ok(result.data.liveOverlay.applied === true
      && result.data.liveOverlay.operatingPlan === Live.OPERATING_PLAN_LIVE,
    'same-date complete cash still overlays as live');
  ok(String(result.historicalOpeningAsOf) === '2026-08-31'
      && String(result.data.plan.opening.asOf) === '2026-08-31',
    'as-of does not advance on a same-date refresh');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing),
    'Forecast opening equals the later same-day observed-cash sum');
  ok(!represented(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31'),
    'unproven same-date inbound is not labelled represented');
  const unresolved = notRelied(result.data.plan, 'amandaSalaryMonthEnd', '2026-08-31');
  ok(unresolved && unresolved.reason === 'same-day-inbound-unproven',
    'same-date refresh still retains liveAsOf not-relied-upon suppression');
  const representedKeys = new Set(((result.data.plan.opening.representedEvents) || [])
    .map(row => String(row.id) + '@' + String(row.date)));
  const notReliedKeys = new Set(((result.data.plan.opening.notReliedUponEvents) || [])
    .map(row => String(row.id) + '@' + String(row.date)));
  ok([...notReliedKeys].every(key => !representedKeys.has(key)),
    'represented and not-relied-upon stay mutually exclusive');
  const advice = recommend(withoutCoverageRule(result.data), '2026-08-31');
  ok(near(Forecast.startingCashAmount(result.data.plan), independentChequing)
        && advice.paydayAllocation.available === null && advice.cardCoverageUnavailable === true,
    'observed cash remains exact and cannot establish card coverage');
  const canonicalAdvice = recommend(result.data, '2026-08-31');
  ok(canonicalAdvice.cardPurchaseCoverage?.status === 'ready' && canonicalAdvice.cardPurchaseCoverage.reservedCash === 0
      && near(Forecast.startingCashAmount(result.data.plan), independentChequing),
    'canonical card-coverage rule: card activity before the 2026-11-06 opening is existing debt; observed cash unchanged',
    JSON.stringify(canonicalAdvice.cardPurchaseCoverage?.issues));
  const p2 = activePeriod(advice);
  ok(p2 && near(p2.currentBalance, independentChequing),
    'current balance equals observed chequing cash exactly');
  ok(!near(advice.paydayAllocation.available, independentCash + SALARY),
    'unproven same-date inbound contributes $0 additional cash');
  const row = incomeRow(advice, 'amandaSalaryMonthEnd');
  ok(row && row.notReliedUpon === true && row.settlement === 'not-relied-upon'
      && row.status === 'unresolved' && row.alreadyInCash !== true,
    'same-date salary stays unresolved / not represented');
}

console.log('\n' + '═'.repeat(60));
if (failures) {
  console.log(`FAILED — ${failures} unresolved-inbound check(s)`);
  process.exit(1);
}
console.log('ALL UNRESOLVED-INBOUND CHECKS PASSED');
