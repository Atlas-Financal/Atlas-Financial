'use strict';
/* Pending Noble that uniquely matches noble-garbage must stay that one
 * economic bill when the provider replaces the pending row with its posted
 * form. Amount, merchant similarity, and a second matcher are not identity.
 *
 * Synthetic Lunch Money fixtures through the incumbent observer and live
 * overlay (L-006). Household Budget cents are read from Forecast.recommend,
 * not from the observer helper that stamps the hit.
 *
 * `node test/test-noble-pending-posted-identity.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const Live = require('../scripts/live-plan.js');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data.json');
const IDENTITY_PATH = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const MAP_PATH = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'provider-account-map.json');

const NOBLE = 'noble-garbage';
const DUE = '2026-09-18';
const POSTED_ON = '2026-09-19';
const NEXT_DUE = '2026-12-18';
const PLANNED = 95.85;
const PENDING_AMT = 90.11;
const POSTED_AMT = 95.85;
const CORNER_AMT = 12.34;
const DOUBLE = 191.7;
const AS_OF = '2026-09-23';
const FETCHED_AT = '2026-09-23T16:00:00.000Z';
const OPENING = '2026-08-19';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const clone = value => JSON.parse(JSON.stringify(value));
const load = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const canonicalFileBefore = fs.readFileSync(DATA_PATH, 'utf8');
const canonical = JSON.parse(canonicalFileBefore);
const identity = load(IDENTITY_PATH);
const fixtureMap = load(MAP_PATH);

ok(near(roundCent(POSTED_AMT + POSTED_AMT), DOUBLE)
    && near(roundCent(POSTED_AMT + CORNER_AMT), 108.19)
    && near(roundCent(DOUBLE + CORNER_AMT), 204.04)
    && !near(PENDING_AMT, POSTED_AMT),
  'independent cents: one Noble is $95.85, two would be $191.70, plus $12.34 corner is $108.19; pending $90.11 is not the posted amount');

function cashValue(data, id) {
  const rows = ((data.plan && data.plan.startingCash && data.plan.startingCash.breakdown) || []);
  const row = rows.find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}

function readyMap() {
  const map = clone(fixtureMap);
  map.mappings = (map.mappings || []).concat([{
    providerAccountId: '1003',
    canonical: { collection: 'cash', id: 'savings' },
    atlasRole: 'household-cash',
  }]);
  return map;
}

function accountsFor(data, balanceTweaks) {
  const rows = [
    { id: 1001, atlas: 'chequing-a', name: 'Fixture Chequing A' },
    { id: 1002, atlas: 'chequing-b', name: 'Fixture Chequing B' },
    { id: 1003, atlas: 'savings', name: 'Fixture Savings' },
  ];
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    type: 'cash',
    balance: balanceTweaks && Object.prototype.hasOwnProperty.call(balanceTweaks, row.id)
      ? balanceTweaks[row.id]
      : cashValue(data, row.atlas),
    updated_at: FETCHED_AT, balance_last_update: FETCHED_AT,
  }));
}

function withoutNobleGate(data) {
  const next = clone(data);
  const opening = next.plan.opening || {};
  opening.representedEvents = (opening.representedEvents || [])
    .filter(row => !(row && row.id === NOBLE && row.date === DUE));
  next.plan.opening = opening;
  return next;
}

function payload(txs, extra) {
  return Object.assign({
    provider: 'lunchmoney',
    fetchedAt: FETCHED_AT,
    transactionWindow: {
      startDate: OPENING,
      endDate: AS_OF,
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
    accounts: accountsFor(canonical),
    categories: [
      { id: 19, name: 'Uncategorised', is_income: false, exclude_from_totals: false },
    ],
    transactions: txs || [],
  }, extra || {});
}

function tx(id, fields) {
  return Object.assign({
    id,
    account_id: 1002,
    date: DUE,
    amount: POSTED_AMT,
    currency: 'cad',
    is_pending: false,
    payee: 'Noble Dispo',
    original_name: 'Noble Dispo',
    category_id: 19,
    status: 'cleared',
  }, fields || {});
}

function liveFrom(data, txs, extraPayload) {
  return Live.fromObservation({
    data,
    payload: payload(txs, extraPayload),
    accountMap: readyMap(),
    identity,
    fetchedAt: FETCHED_AT,
  });
}

function packetOf(live) {
  return (live.data && live.data.liveOverlay && live.data.liveOverlay.currentPeriodActuals)
    || (live.report && live.report.currentPeriodActuals)
    || null;
}

function nobleCandidates(report) {
  return ((report && report.representedEventCandidates) || [])
    .filter(row => row && row.id === NOBLE);
}

function nobleActuals(packet) {
  return ((packet && packet.representedActuals) || [])
    .filter(row => row && row.id === NOBLE);
}

function txByAmount(packet, amount, pred) {
  return ((packet && packet.transactions) || []).filter(row =>
    row && near(row.amount, amount) && (!pred || pred(row)));
}

function classify(row, plan, packet) {
  return F.classifyCurrentPeriodTransaction(row, plan, { currentPeriodActuals: packet });
}

function activePeriod(advice) {
  const periods = (advice && advice.defaultView && advice.defaultView.calendarPeriods) || [];
  return periods.find(p => p && p.role === 'active')
    || periods.find(p => p && p.id === 'this-pay-period')
    || null;
}

function householdSpent(period) {
  return roundCent(((period && period.householdBudget) || []).reduce((sum, row) => {
    return sum + (Number(row && row.spent) || 0);
  }, 0));
}

function otherRow(period) {
  return ((period && period.householdBudget) || []).find(row => row && row.otherSpending) || null;
}

function reconAmounts(row) {
  return ((row && row.recon) || []).map(item => Number(item && item.amount))
    .filter(amount => isFinite(amount));
}

function budgetOf(live) {
  const plan = live.data.plan;
  const packet = packetOf(live);
  const asOf = plan.opening && plan.opening.asOf;
  const advice = F.recommend(plan, asOf, {
    debts: live.data.debts,
    currentPeriodActuals: packet,
    representedEvents: (plan.opening && plan.opening.representedEvents) || [],
  });
  const period = activePeriod(advice);
  return { advice, period, spent: householdSpent(period), other: otherRow(period), packet, plan, asOf };
}

function actionBill(live) {
  const plan = live.data.plan;
  const packet = packetOf(live);
  const action = F.currentPeriodAction(plan, plan.opening.asOf, {
    currentPeriodActuals: packet,
  });
  return ((action && action.bills) || [])
    .find(bill => bill && bill.id === NOBLE && bill.date === DUE) || null;
}

console.log('\n=== A. pending Noble uniquely matching is that occurrence, not Other, and not cash-settled ===');
{
  const data = withoutNobleGate(canonical);
  const live = liveFrom(data, [
    tx(51001, { is_pending: true, amount: POSTED_AMT, status: 'pending' }),
    tx(51002, {
      date: '2026-09-20', amount: CORNER_AMT, payee: 'CORNER MARKET',
      original_name: 'CORNER MARKET',
    }),
  ]);
  const packet = packetOf(live);
  const actuals = nobleActuals(packet);
  const hits = nobleCandidates(live.report);
  ok(hits.length === 0, 'pending Noble does not become a representedEventCandidate');
  ok(actuals.length === 1 && actuals[0].date === DUE && near(actuals[0].actual, POSTED_AMT)
      && actuals[0].transactionId,
    'pending Noble is one representedActual for noble-garbage@2026-09-18',
    JSON.stringify(actuals));
  const linked = (packet.transactions || []).find(row => row && row.id === actuals[0].transactionId);
  const cls = classify(linked, live.data.plan, packet);
  ok(linked && linked.pending === true && linked.representedBill === true
      && cls && cls.kind === 'bill' && cls.householdSpending === false
      && near(linked.amount, POSTED_AMT),
    'the pending row stays in the packet as that bill, not household spending');
  const named = (live.data.plan.opening.representedEvents || [])
    .some(row => row && row.id === NOBLE && row.date === DUE);
  ok(!named, 'pending-only does not put noble-garbage on the cash-omit list');
  const bill = actionBill(live);
  ok(bill && bill.settlement !== 'represented' && near(bill.remaining, PLANNED),
    'while the debit is still pending the bill stays reserved',
    bill && `${bill.settlement}:${bill.remaining}`);
  const budget = budgetOf(live);
  ok(near(budget.spent, CORNER_AMT)
      && !reconAmounts(budget.other).some(amount => near(amount, POSTED_AMT)),
    'Household Budget spent is the $12.34 corner store, not also the pending Noble',
    `spent=${budget.spent} other=${budget.other && budget.other.spent}`);
}

console.log('\n=== B. provider-linked posted replacement remains one Noble settlement ===');
function postedReplacement(linkKind) {
  const pending = tx(linkKind === 'same-id' ? 777 : 52001, {
    is_pending: true,
    amount: PENDING_AMT,
    status: 'pending',
    plaid_metadata: { transaction_id: 'plaid-noble-pending' },
  });
  const posted = tx(linkKind === 'same-id' ? 777 : 52002, {
    is_pending: false,
    date: POSTED_ON,
    amount: POSTED_AMT,
    payee: 'POS DEBIT',
    original_name: 'NOBLE DISPOSAL',
    status: 'cleared',
    plaid_metadata: linkKind === 'same-id' ? null : {
      transaction_id: 'plaid-noble-posted',
      pending_transaction_id: 'plaid-noble-pending',
    },
  });
  const corner = tx(52003, {
    date: '2026-09-20', amount: CORNER_AMT, payee: 'CORNER MARKET',
    original_name: 'CORNER MARKET',
  });
  const data = withoutNobleGate(canonical);
  const reduced = roundCent(cashValue(data, 'chequing-b') - POSTED_AMT);
  const live = liveFrom(data, [pending, posted, corner], {
    accounts: accountsFor(data, { 1002: reduced }),
  });
  const packet = packetOf(live);
  const hits = nobleCandidates(live.report);
  const actuals = nobleActuals(packet);
  const nobleTxs = (packet.transactions || []).filter(row =>
    row && (near(row.amount, POSTED_AMT) || near(row.amount, PENDING_AMT))
    && row.id !== txByAmount(packet, CORNER_AMT)[0]?.id);
  ok(hits.length === 1 && hits[0].date === DUE
      && hits[0].postingDate === POSTED_ON
      && hits[0].postingDateRelation === 'inherited-pending-authorization'
      && hits[0].postingDateRelation !== 'same-day'
      && near(hits[0].observedAmount, POSTED_AMT)
      && hits[0].inheritedPendingReplacement === true,
    `${linkKind}: one inherited candidate, 18 Sep identity, posted provenance 19 Sep`,
    hits.map(hit => `${hit.date}:${hit.observedAmount}:${hit.postingDate}:${hit.postingDateRelation}`).join(','));
  ok(actuals.length === 1 && actuals[0].date === DUE && actuals[0].postedOn === POSTED_ON
      && near(actuals[0].actual, POSTED_AMT)
      && !actuals.some(row => row && row.date === NEXT_DUE),
    `${linkKind}: exactly one representedActual for 18 Sep, published postedOn is 19 Sep`);
  ok(nobleTxs.length === 1 && nobleTxs[0].pending !== true
      && nobleTxs[0].representedBill === true && near(nobleTxs[0].amount, POSTED_AMT),
    `${linkKind}: the posted replacement is the only Noble outflow and stays in the packet`,
    nobleTxs.map(row => `${row.pending}:${row.amount}:${row.representedBill}`).join(','));
  const cls = classify(nobleTxs[0], live.data.plan, packet);
  ok(cls && cls.kind === 'bill' && cls.householdSpending === false,
    `${linkKind}: posted replacement classifies as the bill, not Other`);
  const named = (live.data.plan.opening.representedEvents || [])
    .some(row => row && row.id === NOBLE && row.date === DUE);
  ok(named, `${linkKind}: live overlay names the occurrence from the posted survivor, not the static Dale gate`);
  const bill = actionBill(live);
  ok(bill && bill.settlement === 'represented' && near(bill.remaining, 0)
      && near(bill.planned, PLANNED)
      && bill.evidenceDate === POSTED_ON,
    `${linkKind}: the bill remains paid once and Forecast consumes posted date 19 Sep`,
    bill && `${bill.settlement}:${bill.remaining}:${bill.planned}:${bill.evidenceDate}`);
  const reserved = F.expandEvents(live.data.plan, OPENING, '2026-09-22', {
    representedEvents: (live.data.plan.opening && live.data.plan.opening.representedEvents) || [],
  }).filter(event => event && event.id === NOBLE && event.date === DUE);
  ok(reserved.length === 1,
    `${linkKind}: later posted evidence cannot erase the debit from the older opening`);
  const liveReserved = F.expandEvents(live.data.plan, live.data.plan.opening.asOf, '2026-09-22', {})
    .filter(event => event && event.id === NOBLE && event.date === DUE);
  ok(liveReserved.length === 0,
    `${linkKind}: fresh live cash already includes the posted debit and does not replay it`);
  const balance = cashValue(live.data, 'chequing-b');
  ok(near(balance, reduced),
    `${linkKind}: observed chequing-b still shows the posted debit`,
    `balance=${balance} expected=${reduced}`);
  const budget = budgetOf(live);
  ok(near(budget.spent, CORNER_AMT)
      && !reconAmounts(budget.other).some(amount => near(amount, POSTED_AMT) || near(amount, PENDING_AMT)),
    `${linkKind}: Household Budget spent is $12.34, not $108.19 or $204.04`,
    `spent=${budget.spent}`);
  // The control carries no Noble identity in either field. Its bank
  // descriptor is read through a displayed-payee rename, so a NOBLE DISPOSAL
  // descriptor would itself be identity (checked separately below).
  const control = liveFrom(withoutNobleGate(canonical), [
    tx(53001, {
      date: POSTED_ON, amount: POSTED_AMT, payee: 'POS DEBIT',
      original_name: 'POS DEBIT 0042',
    }),
    tx(53002, {
      date: '2026-09-20', amount: CORNER_AMT, payee: 'CORNER MARKET',
      original_name: 'CORNER MARKET',
    }),
  ]);
  const controlBudget = budgetOf(control);
  ok(nobleCandidates(control.report).length === 0
      && near(controlBudget.spent, roundCent(POSTED_AMT + CORNER_AMT))
      && near(roundCent(controlBudget.spent - budget.spent), POSTED_AMT),
    `${linkKind}: the same posted row without a provider link is Other Spending, $95.85 more`,
    `control=${controlBudget.spent} linked=${budget.spent}`);
  const unlinked = liveFrom(withoutNobleGate(canonical), [
    tx(53003, {
      date: POSTED_ON, amount: POSTED_AMT, payee: 'POS DEBIT',
      original_name: 'NOBLE DISPOSAL',
    }),
  ]);
  const unlinkedBill = actionBill(unlinked);
  ok(nobleCandidates(unlinked.report).length === 0
      && unlinkedBill && unlinkedBill.settlement !== 'represented',
    `${linkKind}: an unlinked next-day NOBLE DISPOSAL descriptor does not settle the 18 Sep occurrence`,
    unlinkedBill && unlinkedBill.settlement);
}

postedReplacement('plaid');
postedReplacement('same-id');

console.log('\n=== C. fail closed: no merchant/amount collapse, wrong account, wrong occurrence, unlinked pair ===');
{
  const distinct = liveFrom(withoutNobleGate(canonical), [
    tx(54001, { amount: POSTED_AMT }),
    tx(54002, {
      date: '2026-09-20', amount: POSTED_AMT, payee: 'Noble Dispo',
      original_name: 'Noble Dispo',
    }),
  ]);
  const distinctHits = nobleCandidates(distinct.report);
  const distinctBudget = budgetOf(distinct);
  ok(distinctHits.length === 1 && distinctHits[0].date === DUE
      && near(distinctHits[0].observedAmount, POSTED_AMT),
    'a same-day Noble Dispo settles the occurrence once');
  ok(near(distinctBudget.spent, POSTED_AMT)
      && reconAmounts(distinctBudget.other).filter(amount => near(amount, POSTED_AMT)).length === 1,
    'the 20 Sep Noble debit stays Other Spending and is not collapsed into the bill',
    `spent=${distinctBudget.spent}`);

  const wrongAccount = liveFrom(withoutNobleGate(canonical), [
    tx(55001, {
      is_pending: true, amount: PENDING_AMT, status: 'pending',
      plaid_metadata: { transaction_id: 'plaid-noble-pending' },
    }),
    tx(55002, {
      account_id: 1001, date: POSTED_ON, amount: POSTED_AMT,
      payee: 'POS DEBIT', original_name: 'NOBLE DISPOSAL',
      plaid_metadata: {
        transaction_id: 'plaid-noble-posted',
        pending_transaction_id: 'plaid-noble-pending',
      },
    }),
  ]);
  const wrongPacket = packetOf(wrongAccount);
  const wrongActuals = nobleActuals(wrongPacket);
  const wrongPosted = (wrongPacket.transactions || []).find(row =>
    row && row.pending !== true && near(row.amount, POSTED_AMT));
  const wrongCls = classify(wrongPosted, wrongAccount.data.plan, wrongPacket);
  ok(nobleCandidates(wrongAccount.report).length === 0
      && wrongActuals.every(row => row.transactionId !== (wrongPosted && wrongPosted.id))
      && wrongPosted && wrongPosted.representedBill !== true
      && wrongCls && wrongCls.householdSpending === true && wrongCls.kind !== 'bill',
    'a linked posted row on Chequing A does not inherit the WEEKLY bill',
    wrongCls && `${wrongCls.kind}:${wrongCls.householdSpending}`);

  const offDate = liveFrom(withoutNobleGate(canonical), [
    tx(56001, {
      date: '2026-09-20', is_pending: true, amount: POSTED_AMT, status: 'pending',
      plaid_metadata: { transaction_id: 'plaid-off-pending' },
    }),
    tx(56002, {
      date: '2026-09-21', amount: POSTED_AMT, payee: 'POS DEBIT',
      original_name: 'NOBLE DISPOSAL',
      plaid_metadata: {
        transaction_id: 'plaid-off-posted',
        pending_transaction_id: 'plaid-off-pending',
      },
    }),
  ]);
  ok(nobleCandidates(offDate.report).length === 0 && nobleActuals(packetOf(offDate)).length === 0,
    'a pending row that is not the 18 Sep occurrence does not lend settlement to its posted form');

  const nextDueExists = F.expandEvents(canonical.plan, NEXT_DUE, NEXT_DUE, { keepRepresented: true })
    .some(event => event && event.id === NOBLE && event.date === NEXT_DUE);
  ok(nextDueExists, 'quarterly noble-garbage has a 2026-12-18 occurrence');
  const splitOccurrence = liveFrom(withoutNobleGate(canonical), [
    tx(57001, {
      is_pending: true, amount: PENDING_AMT, status: 'pending',
      plaid_metadata: { transaction_id: 'plaid-span-pending' },
    }),
    tx(57002, {
      date: NEXT_DUE, amount: POSTED_AMT, payee: 'Noble Dispo',
      original_name: 'Noble Dispo',
      plaid_metadata: {
        transaction_id: 'plaid-span-posted',
        pending_transaction_id: 'plaid-span-pending',
      },
    }),
  ], {
    transactionWindow: {
      startDate: OPENING,
      endDate: NEXT_DUE,
      complete: true,
      hasMore: false,
      truncated: false,
    },
  });
  ok(nobleCandidates(splitOccurrence.report).length === 0
      && nobleActuals(packetOf(splitOccurrence)).length === 0,
    'one provider transaction that would cover two Noble occurrences settles neither');

  const lookalike = liveFrom(withoutNobleGate(canonical), [
    tx(58001, {
      is_pending: true, amount: POSTED_AMT, status: 'pending',
    }),
    tx(58002, { is_pending: false, amount: POSTED_AMT }),
  ]);
  const lookPacket = packetOf(lookalike);
  const lookActuals = nobleActuals(lookPacket);
  const lookPending = (lookPacket.transactions || []).find(row => row && row.pending === true);
  const lookPosted = (lookPacket.transactions || []).find(row => row && row.pending !== true
    && near(row.amount, POSTED_AMT));
  ok(nobleCandidates(lookalike.report).length === 1
      && lookActuals.length === 1
      && lookActuals[0].transactionId === (lookPosted && lookPosted.id)
      && lookPending && lookPending.pendingPostedDuplicate === true
      && lookPending.representedBill !== true
      && lookPosted && lookPosted.representedBill === true,
    'unlinked same-day lookalikes stay the incumbent unresolved pair: posted settles once, pending is not a second settlement');
  const lookBudget = budgetOf(lookalike);
  const confirmedOther = ((lookBudget.other && lookBudget.other.recon) || [])
    .filter(row => !(row && row.pendingPostedDuplicate === true && row.pending === true));
  ok(near(lookBudget.spent, 0)
      && !confirmedOther.some(row => near(row.amount, POSTED_AMT) || near(row.amount, DOUBLE)),
    'the unresolved pair does not add $95.85 or $191.70 of confirmed Household Budget spent',
    `spent=${lookBudget.spent} confirmed=${confirmedOther.map(row => row.amount).join(',')}`);
}

ok(fs.readFileSync(DATA_PATH, 'utf8') === canonicalFileBefore,
  'the fixture does not write canonical data.json');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll Noble pending→posted identity checks passed.');
