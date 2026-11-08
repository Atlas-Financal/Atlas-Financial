'use strict';
/* Amazon Prime membership is one Forecast subscription.
 * Amount, day, and payer are the repeated Travel Visa evidence:
 * Amazon Prime / Amazon.ca Prime $11.19, most recently on the 19th.
 * The separate $24.63 charge and ordinary Amazon shopping do not settle it.
 *
 * `node test/test-amazon-prime-membership.js`
 *
 * Synthetic observe fixtures and independent arithmetic (L-002 / L-006).
 * Live cents are the household row under test, not a copied behaviour spec.
 */
const fs = require('fs');
const path = require('path');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const Live = require('../scripts/live-plan.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const ID = 'amazon-prime';
const AMOUNT = 11.19;
const OTHER_PRIME_LIKE = 24.63;
const SHOPPING = 18.4;
const AS_OF = '2026-08-19';
const VIEW_END = '2026-11-17';
const DUE = '2026-09-19';
const NEXT = '2026-10-19';
const LIVE_AFTER = '2026-09-22';
const HAND_DATES = [DUE, NEXT];
const HAND_RESERVE = roundCent(AMOUNT + AMOUNT);
const AMANDA_SHOPPING = roundCent(SHOPPING + OTHER_PRIME_LIKE);
const TRAVEL_PROVIDER_ID = 2004;
const MBNA_PROVIDER_ID = 2005;
const EXACT = 'exact-scheduled-amount';

function liveData() {
  return load('data.json');
}

function identityDoc() {
  return load('docs/connectivity/transaction-identity.json');
}

function fixtureMap() {
  const map = load('docs/connectivity/fixtures/provider-account-map.json');
  map.mappings = (map.mappings || []).concat([
    {
      providerAccountId: String(TRAVEL_PROVIDER_ID),
      canonical: { collection: 'debts', id: 'travelvisa' },
      atlasRole: 'revolving-credit',
    },
    {
      providerAccountId: String(MBNA_PROVIDER_ID),
      canonical: { collection: 'debts', id: 'mbna' },
      atlasRole: 'revolving-credit',
    },
  ]);
  return map;
}

function liveAccountMap() {
  return load('docs/connectivity/fixtures/b81-account-map.json');
}

function cashValue(data, id) {
  const rows = ((data.plan && data.plan.startingCash && data.plan.startingCash.breakdown) || []);
  const row = rows.find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}

function debtRow(data, id) {
  return ((data.debts || []).find(d => d && d.id === id)) || null;
}

function liveOverlayAccounts(data, asOf) {
  const observed = asOf + 'T17:55:00.000Z';
  const card = id => {
    const row = debtRow(data, id);
    return {
      balance: row && row.balance != null ? Number(row.balance) : 0,
      credit_limit: row && row.limit != null ? Number(row.limit) : undefined,
    };
  };
  return [
    {
      id: 3001, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: cashValue(data, 'chequing-a'), updated_at: observed, balance_last_update: observed,
    },
    {
      id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: cashValue(data, 'chequing-b'), updated_at: observed, balance_last_update: observed,
    },
    {
      id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: cashValue(data, 'savings'), updated_at: observed, balance_last_update: observed,
    },
    {
      id: 3004, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: card('tdcc').balance, credit_limit: card('tdcc').credit_limit,
      updated_at: observed, balance_last_update: observed,
    },
    {
      id: 3005, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: card('cashback').balance, credit_limit: card('cashback').credit_limit,
      updated_at: observed, balance_last_update: observed,
    },
    {
      id: 3006, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: card('travelvisa').balance, credit_limit: card('travelvisa').credit_limit,
      updated_at: observed, balance_last_update: observed,
    },
    {
      id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: card('heloc').balance, updated_at: observed, balance_last_update: observed,
    },
    {
      id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: card('mortgage').balance, updated_at: observed, balance_last_update: observed,
    },
    {
      id: 3010, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'Canadian Tire Bank', currency: 'cad',
      balance: card('triangle').balance, credit_limit: card('triangle').credit_limit,
      updated_at: observed, balance_last_update: observed,
    },
  ];
}

function liveOverlay(asOf, txs) {
  const data = liveData();
  return Live.fromObservation({
    data,
    accountMap: liveAccountMap(),
    identity: identityDoc(),
    payload: {
      provider: 'lunchmoney',
      fetchedAt: asOf + 'T18:00:00.000Z',
      source: 'Synthetic Amazon Prime live-cutover fixture. Not a live institution pull.',
      pendingCoverage: {
        complete: true,
        basis: O.PENDING_COVERAGE_BASIS,
        hasMore: false,
        truncated: false,
      },
      transactionWindow: {
        startDate: AS_OF,
        endDate: asOf,
        complete: true,
        hasMore: false,
        truncated: false,
      },
      accounts: liveOverlayAccounts(data, asOf),
      categories: [
        { id: 11, name: 'Shopping', is_income: false, exclude_from_totals: false },
      ],
      transactions: txs || [],
    },
  });
}

function liveTx(id, date, amount, payee, extra) {
  return tx(id, date, amount, payee, 3006, extra);
}

function oneDayReservedDelta(planWith, planWithout, start) {
  const opts = { weeklyVariable: 0, viewDays: 1, horizonDays: 1, targetBuffer: 0 };
  const withRow = F.simulate(planWith, start, opts);
  const withoutRow = F.simulate(planWithout, start, opts);
  return roundCent((withRow.totals.reserved || 0) - (withoutRow.totals.reserved || 0));
}

function planWithoutPrime(plan) {
  const next = JSON.parse(JSON.stringify(plan));
  next.bills = (next.bills || []).filter(b => b && b.id !== ID);
  return next;
}

function payload(asOf, txs) {
  return {
    provider: 'lunchmoney',
    fetchedAt: asOf + 'T18:00:00.000Z',
    transactionWindow: {
      startDate: AS_OF,
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
        updated_at: asOf + 'T17:55:00.000Z', balance_last_update: asOf + 'T17:55:00.000Z',
      },
      {
        id: TRAVEL_PROVIDER_ID, name: 'Fixture Travel Visa', type: 'credit',
        balance: 500, credit_limit: 5000,
        updated_at: asOf + 'T17:55:00.000Z', balance_last_update: asOf + 'T17:55:00.000Z',
      },
      {
        id: MBNA_PROVIDER_ID, name: 'Fixture MBNA', type: 'credit',
        balance: 200, credit_limit: 5000,
        updated_at: asOf + 'T17:55:00.000Z', balance_last_update: asOf + 'T17:55:00.000Z',
      },
    ],
    categories: [
      { id: 11, name: 'Shopping', is_income: false, exclude_from_totals: false },
    ],
    transactions: txs || [],
  };
}

function tx(id, date, amount, payee, accountId, extra) {
  return Object.assign({
    id,
    account_id: accountId,
    currency: 'cad',
    date,
    amount,
    is_pending: false,
    payee,
    original_name: payee,
    category_id: 11,
  }, extra || {});
}

function observe(asOf, txs) {
  return O.observe({
    provider: 'lunchmoney',
    payload: payload(asOf, txs),
    accountMap: fixtureMap(),
    data: liveData(),
    identity: identityDoc(),
  });
}

function primeHits(report) {
  return ((report && report.representedEventCandidates) || [])
    .filter(c => c && c.id === ID);
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function budgetRow(p, id) {
  return ((p && p.householdBudget) || []).find(r => r && r.id === id) || null;
}
function otherRow(p) {
  return ((p && p.householdBudget) || []).find(r => r && r.otherSpending) || null;
}
function reconAmounts(row) {
  return ((row && row.recon) || []).map(item => Number(item && item.amount));
}
function allReconAmounts(p) {
  const out = [];
  for (const row of (p && p.householdBudget) || []) {
    for (const item of (row && row.recon) || []) {
      if (item && item.amount != null) out.push(Number(item.amount));
    }
  }
  return out;
}

console.log('=== one planned membership from the repeated $11.19 evidence ===');
{
  ok(roundCent(AMOUNT * 2) === 22.38 && HAND_RESERVE === 22.38,
    'two membership occurrences are independently $22.38');
  ok(roundCent(SHOPPING + OTHER_PRIME_LIKE) === 43.03 && AMANDA_SHOPPING === 43.03,
    'shopping $18.40 plus the separate $24.63 is independently $43.03');
  const data = liveData();
  const rows = (data.plan.bills || []).filter(b => b && b.id === ID);
  ok(rows.length === 1, 'plan.bills has one amazon-prime row');
  const row = rows[0];
  ok(row && row.label === 'Amazon Prime membership'
      && row.frequency === 'monthly' && row.day === 19
      && row.firstDue === '2026-09-19'
      && row.amount === AMOUNT && row.confidence === 'confirmed'
      && row.budgetCategory == null && row.subscription === true
      && row.payingAccount === 'travelvisa' && row.jointCash === false,
    'the row is $11.19 monthly on the 19th from 2026-09-19, card-paid Travel Visa');
  ok(!(data.plan.bills || []).some(b => b && b.id !== ID && /amazon.?prime/i.test(`${b.id} ${b.label}`)),
    'ordinary Amazon shopping is not a second subscription');
  const subs = F.householdSubscriptions(data.plan, AS_OF);
  const subRows = (subs.subscriptions || []).filter(r => r && r.id === ID);
  ok(subRows.length === 1 && subRows[0].frequency === 'monthly'
      && near(subRows[0].amount, AMOUNT)
      && near(subRows[0].monthlyEquivalent, AMOUNT)
      && subRows[0].nextDate === DUE,
    'Subscriptions shows the membership once, next 2026-09-19, monthly equivalent $11.19',
    subRows.map(r => `${r.nextDate} ${r.monthlyEquivalent}`).join(','));
  const bills = F.householdBills(data.plan, AS_OF);
  ok(!(bills.bills || []).some(r => r && r.id === ID),
    'the membership stays off the household Bills roster');
  const events = F.expandEvents(data.plan, AS_OF, VIEW_END).filter(e => e && e.id === ID);
  ok(events.map(e => e.date).join(',') === HAND_DATES.join(',')
      && events.every(e => e.kind === 'bill' && e.cardPaid === true && e.jointCash === false
        && near(-e.amount, AMOUNT)),
    '91-day walk reserves 19 Sep and 19 Oct only, each card-paid −$11.19',
    events.map(e => `${e.date}:${e.amount}:card=${e.cardPaid}`).join(','));
  ok(!F.expandEvents(data.plan, AS_OF, VIEW_END).some(e => e && e.id === ID && e.date === AS_OF),
    '19 August is not reserved again on the opening');
  const without = JSON.parse(JSON.stringify(data.plan));
  without.bills = (without.bills || []).filter(b => b.id !== ID);
  const simWith = F.simulate(data.plan, AS_OF);
  const simWithout = F.simulate(without, AS_OF);
  ok(near(simWith.totals.reserved - simWithout.totals.reserved, HAND_RESERVE)
      && near(simWith.totals.bills, simWithout.totals.bills),
    'reserved gravity is $22.38 and joint-cash bills do not move',
    `Δreserved=${(simWith.totals.reserved - simWithout.totals.reserved).toFixed(2)} `
      + `Δbills=${(simWith.totals.bills - simWithout.totals.bills).toFixed(2)}`);
}

console.log('\n=== identity settles one evidenced membership charge ===');
{
  const identity = identityDoc();
  const rules = (identity.rules || []).filter(r => r && r.eventId === ID);
  ok(rules.length === 1 && rules[0].payeeMatchMode === 'exact'
      && rules[0].atlasAccountId === 'travelvisa' && rules[0].direction === 'debit'
      && rules[0].settlesWhen === EXACT && !rules[0].postingDateRule
      && (rules[0].payeePatterns || []).includes('Amazon Prime')
      && (rules[0].payeePatterns || []).includes('Amazon.ca Prime')
      && (rules[0].payeeExcludePatterns || []).includes('Prime Video'),
    'settlement is exact Prime alias + Travel Visa + debit + same day + exact amount');
  ok(/Named amazon-prime is the exact payee aliases/.test(identity.owns || '')
      && /Do not use schedule-trust for amazon-prime/.test(identity.owns || ''),
    'the identity contract names this guard and refuses schedule-trust');
  const forecastSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public/forecast.js'), 'utf8'));
  ok(!/isAmazonPrimeMerchant|amazon-prime-bill|amazon-owner-card/.test(forecastSrc),
    'Forecast does not grow a second Prime classifier');

  const settled = observe(DUE, [
    tx(9101, DUE, AMOUNT, 'Amazon Prime', TRAVEL_PROVIDER_ID),
    tx(9102, DUE, SHOPPING, 'Amazon', TRAVEL_PROVIDER_ID),
    tx(9103, DUE, SHOPPING, 'AMZN Mktp CA', TRAVEL_PROVIDER_ID),
  ]);
  const hits = primeHits(settled);
  ok(hits.length === 1 && hits[0].date === DUE
      && near(Math.abs(hits[0].observedAmount), AMOUNT)
      && String(hits[0].providerTransactionId) === '9101',
    'one $11.19 Amazon Prime Travel Visa debit settles 2026-09-19 once',
    hits.map(h => `${h.date}:${h.providerTransactionId}:${h.observedAmount}`).join(','));
  const dot = observe(DUE, [
    tx(9111, DUE, AMOUNT, 'Amazon.ca Prime', TRAVEL_PROVIDER_ID),
  ]);
  const dotHits = primeHits(dot);
  ok(dotHits.length === 1 && dotHits[0].date === DUE
      && String(dotHits[0].providerTransactionId) === '9111',
    'Amazon.ca Prime at $11.19 on the 19th is the same membership');

  const bothMonths = observe(NEXT, [
    tx(9121, DUE, AMOUNT, 'Amazon Prime', TRAVEL_PROVIDER_ID),
    tx(9122, NEXT, AMOUNT, 'Amazon.ca Prime', TRAVEL_PROVIDER_ID),
  ]);
  const monthHits = primeHits(bothMonths);
  const monthKeys = monthHits.map(h => `${h.date}@${h.providerTransactionId}`).sort();
  ok(monthHits.length === 2 && monthKeys.join(',') === `${DUE}@9121,${NEXT}@9122`,
    'each month settles once from its own charge',
    monthKeys.join(','));
}

console.log('\n=== shopping, $24.63, and a second charge do not settle it ===');
{
  const shopping = observe(DUE, [
    tx(9201, DUE, AMOUNT, 'Amazon', TRAVEL_PROVIDER_ID),
    tx(9202, DUE, AMOUNT, 'AMZN Mktp CA', TRAVEL_PROVIDER_ID),
    tx(9203, DUE, AMOUNT, 'Amazon Prime Video', TRAVEL_PROVIDER_ID),
    tx(9204, DUE, OTHER_PRIME_LIKE, 'Amazon Prime', TRAVEL_PROVIDER_ID),
    tx(9205, DUE, AMOUNT, 'Amazon Prime', MBNA_PROVIDER_ID),
    tx(9206, '2026-09-18', AMOUNT, 'Amazon Prime', TRAVEL_PROVIDER_ID),
    tx(9207, '2026-09-20', AMOUNT, 'Amazon Prime', TRAVEL_PROVIDER_ID),
    tx(9208, DUE, 11.2, 'Amazon Prime', TRAVEL_PROVIDER_ID),
    tx(9209, DUE, AMOUNT, 'Amazon Prime', TRAVEL_PROVIDER_ID, { is_pending: true }),
  ]);
  ok(primeHits(shopping).length === 0,
    'shopping, Prime Video, $24.63, MBNA, the wrong day, $11.20, and pending do not settle',
    primeHits(shopping).map(h => h.providerTransactionId).join(','));
  const twice = observe(DUE, [
    tx(9211, DUE, AMOUNT, 'Amazon Prime', TRAVEL_PROVIDER_ID),
    tx(9212, DUE, AMOUNT, 'Amazon Prime', TRAVEL_PROVIDER_ID),
  ]);
  ok(primeHits(twice).length === 0,
    'two same-day $11.19 membership charges do not settle twice or pick one');
  const ambiguous = (twice.sameDayInboundAmbiguity || [])
    .filter(g => g && g.id === ID && g.date === DUE);
  ok(ambiguous.length === 1 && ambiguous[0].candidateCount === 2,
    'two compatible membership charges stay ambiguous instead of settling',
    JSON.stringify(twice.sameDayInboundAmbiguity || []));
}

console.log('\n=== represented membership is not also guilt-free or Other ===');
{
  const report = observe(DUE, [
    tx(9301, DUE, AMOUNT, 'Amazon Prime', TRAVEL_PROVIDER_ID),
    tx(9302, DUE, SHOPPING, 'Amazon', TRAVEL_PROVIDER_ID),
    tx(9303, DUE, OTHER_PRIME_LIKE, 'Amazon Prime', TRAVEL_PROVIDER_ID),
  ]);
  const packet = report.currentPeriodActuals;
  const plan = liveData().plan;
  ok(packet && O.currentPeriodActualsLooksSanitized(packet),
    'current-period packet stays sanitized');
  const represented = (packet.representedActuals || []).filter(r => r && r.id === ID);
  ok(represented.length === 1 && represented[0].date === DUE
      && near(represented[0].actual, AMOUNT),
    'representedActuals names the membership once at $11.19');
  const byAmount = amount => (packet.transactions || []).find(row =>
    row && near(row.amount, amount));
  const memberTx = (packet.transactions || []).find(row => row && near(row.amount, AMOUNT));
  const shopTx = byAmount(SHOPPING);
  const otherPrimeTx = byAmount(OTHER_PRIME_LIKE);
  const memberCls = F.classifyCurrentPeriodTransaction(memberTx, plan, {
    currentPeriodActuals: packet,
  });
  const shopCls = F.classifyCurrentPeriodTransaction(shopTx, plan, {
    currentPeriodActuals: packet,
  });
  const otherCls = F.classifyCurrentPeriodTransaction(otherPrimeTx, plan, {
    currentPeriodActuals: packet,
  });
  ok(memberCls.kind === 'bill' && memberCls.householdSpending === false
      && memberCls.reason === 'represented-bill',
    'the settled membership charge is a represented bill, not spending',
    JSON.stringify(memberCls));
  ok(shopCls.kind === 'spend' && shopCls.categoryId === 'amanda-guilt-free'
      && shopCls.includeReason === 'owner-evidence-amanda' && shopCls.kind !== 'bill', // H1: Shopping label wins; owner evidence names Amanda
    'ordinary Amazon shopping on Travel Visa stays Amanda guilt-free',
    JSON.stringify(shopCls));
  ok(otherCls.kind === 'spend' && otherCls.categoryId === 'amanda-guilt-free'
      && otherCls.kind !== 'bill' && otherCls.includeReason === 'owner-evidence-amanda', // H1
    'the $24.63 Prime-like charge stays guilt-free shopping and does not settle',
    JSON.stringify(otherCls));

  const representedEvents = primeHits(report).map(c => ({ id: c.id, date: c.date }));
  const opened = JSON.parse(JSON.stringify(plan));
  opened.opening = Object.assign({}, opened.opening, {
    asOf: DUE,
    priorAsOf: AS_OF,
    representedEvents,
  });
  const advice = F.recommend(opened, DUE, {
    debts: liveData().debts,
    currentPeriodActuals: packet,
    representedEvents,
    preservePaydayPeriodOrigin: true,
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const amanda = budgetRow(active, 'amanda-guilt-free');
  const other = otherRow(active);
  const recon = allReconAmounts(active);
  ok(amanda && near(amanda.spent, AMANDA_SHOPPING)
      && !reconAmounts(amanda).some(amount => near(amount, AMOUNT)),
    'Amanda guilt-free keeps shopping and $24.63, not the settled $11.19',
    `spent=${amanda && amanda.spent} recon=${reconAmounts(amanda).join(',')}`);
  ok(!other || !reconAmounts(other).some(amount => near(amount, AMOUNT) || near(amount, SHOPPING)
      || near(amount, OTHER_PRIME_LIKE)),
    'Other spending does not receive the membership, the shopping, or the $24.63',
    other ? `spent=${other.spent} recon=${reconAmounts(other).join(',')}` : 'no Other row');
  ok(!recon.some(amount => near(amount, AMOUNT)),
    'no Household Budget recon row repeats the settled membership',
    recon.join(','));
  const joint = F.expandEvents(opened, DUE, DUE, { representedEvents })
    .filter(e => e && e.id === ID && e.jointCash !== false && !e.cardPaid);
  ok(joint.length === 0,
    'representing the card charge does not also deduct a joint-cash bill');
}

console.log('\n=== unmatched membership stays reserved across a live cutover ===');
{
  ok(AS_OF < DUE && DUE < LIVE_AFTER && LIVE_AFTER < NEXT,
    'hand dates: opening 19 Aug, membership 19 Sep, live 22 Sep, next 19 Oct');
  ok(roundCent(AMOUNT) === 11.19, 'one unmatched membership occurrence is independently $11.19');

  const unmatched = liveOverlay(LIVE_AFTER, [
    liveTx(9401, DUE, SHOPPING, 'Amazon'),
    liveTx(9402, DUE, OTHER_PRIME_LIKE, 'Amazon Prime'),
    liveTx(9403, DUE, AMOUNT, 'Amazon Prime Video'),
  ]);
  ok(unmatched.data && unmatched.data.liveOverlay && unmatched.data.liveOverlay.applied === true,
    'freshness-qualified live overlay applies');
  const livePlan = unmatched.data.plan;
  ok(livePlan.opening && livePlan.opening.asOf === LIVE_AFTER
      && livePlan.opening.priorAsOf === AS_OF,
    'live opening advances past 19 Sep and records priorAsOf 19 Aug',
    JSON.stringify(livePlan.opening && {
      asOf: livePlan.opening.asOf,
      priorAsOf: livePlan.opening.priorAsOf,
    }));
  ok(!(livePlan.opening.representedEvents || []).some(e => e && e.id === ID && e.date === DUE),
    'shopping, $24.63, and Prime Video do not represent the membership');

  const liveEvents = F.expandEvents(livePlan, LIVE_AFTER, NEXT)
    .filter(e => e && e.id === ID);
  const dueEvents = liveEvents.filter(e => e.date === DUE);
  ok(dueEvents.length === 1 && dueEvents[0].cardPaid === true
      && dueEvents[0].jointCash === false && near(-dueEvents[0].amount, AMOUNT)
      && dueEvents[0].carriedUnresolved === true,
    'exactly one unmatched $11.19 19 Sep occurrence stays due after the live cutover',
    liveEvents.map(e => `${e.date}:${e.amount}:card=${e.cardPaid}`).join(','));
  ok(liveEvents.some(e => e.date === NEXT && near(-e.amount, AMOUNT)),
    '19 Oct remains the next scheduled occurrence');

  const reserved = oneDayReservedDelta(livePlan, planWithoutPrime(livePlan), LIVE_AFTER);
  ok(near(reserved, AMOUNT),
    '1-day reserved gravity on 22 Sep is independently the unmatched $11.19',
    `Δreserved=${reserved}`);

  const noPrior = JSON.parse(JSON.stringify(livePlan));
  delete noPrior.opening.priorAsOf;
  const dropped = F.expandEvents(noPrior, LIVE_AFTER, LIVE_AFTER)
    .filter(e => e && e.id === ID && e.date === DUE);
  ok(dropped.length === 0,
    'without priorAsOf the 19 Sep occurrence disappears — the live-cutover bug');
  ok(near(oneDayReservedDelta(noPrior, planWithoutPrime(noPrior), LIVE_AFTER), 0),
    'without priorAsOf the unmatched $11.19 is not reserved');

  const settled = liveOverlay(LIVE_AFTER, [
    liveTx(9411, DUE, AMOUNT, 'Amazon Prime'),
    liveTx(9412, DUE, SHOPPING, 'Amazon'),
    liveTx(9413, DUE, OTHER_PRIME_LIKE, 'Amazon Prime'),
  ]);
  const settledPlan = settled.data.plan;
  ok((settledPlan.opening.representedEvents || []).some(e => e && e.id === ID && e.date === DUE),
    'a matching $11.19 Amazon Prime Travel Visa debit is represented once');
  const settledDue = F.expandEvents(settledPlan, LIVE_AFTER, NEXT)
    .filter(e => e && e.id === ID && e.date === DUE);
  ok(settledDue.length === 0,
    'the represented matching debit removes the 19 Sep occurrence once');
  ok(near(oneDayReservedDelta(settledPlan, planWithoutPrime(settledPlan), LIVE_AFTER), 0),
    'represented membership is not reserved again on the live opening');
  const alias = liveOverlay(LIVE_AFTER, [
    liveTx(9421, DUE, AMOUNT, 'Amazon.ca Prime'),
  ]);
  ok((alias.data.plan.opening.representedEvents || [])
      .some(e => e && e.id === ID && e.date === DUE)
    && !F.expandEvents(alias.data.plan, LIVE_AFTER, LIVE_AFTER)
      .some(e => e && e.id === ID && e.date === DUE),
    'Amazon.ca Prime at $11.19 also settles the carried 19 Sep occurrence once');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll proofs passed.');
