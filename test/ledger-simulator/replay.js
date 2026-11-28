'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const Live = require('../../scripts/live-plan');
const Observer = require('../../scripts/provider-observe');
const Memory = require('../../scripts/server-observation-memory');
const F = require('../../public/forecast');
const { world, date, offset } = require('./household');
const { fetchPayload, faults } = require('./transport');
const cents = (value) => (Number.isFinite(value) ? Math.round(value * 100) : null);
const activityCache = new WeakMap();
function activity(data) {
  if (!activityCache.has(data)) activityCache.set(data, F.cardActivityForDisplay(data));
  return activityCache.get(data);
}
const context = 'invented-ledger-simulator';

async function observation(seed, day, events, fault, input = world(seed, day, events)) {
  // Transport / fixture failures escape. Only exceptions from the application
  // refresh itself are product observations.
  input.payload = await fetchPayload(input.payload, day, fault, input.previousWeekly);
  faults[fault]?.plan?.(input.data.plan);
  let result,
    exception = null;
  try {
    result = Live.fromObservation(input);
  } catch (error) {
    exception = { code: error.code || error.name, message: error.message };
    result = { data: Live.failedOverlay(input.data, error.message) };
  }
  const data = result.data;
  const qualified =
    data.liveOverlay.applied === true &&
    result.report?.observationReceipt?.readyForReconciliation === true &&
    Memory.completeTransactionCohort(data) &&
    !Memory.planWithheld(data);
  let join = [];
  if (qualified) {
    // Row IDs printed in a list are local. Translate via the observer's actual
    // provenance only; the journal, never the crosswalk, supplies the amounts.
    const { acquisition } = Observer.observeWithSettlementCrosswalk({ ...input, provider: 'lunchmoney' });
    assert.ok(acquisition, 'qualified observation missing same-packet identity crosswalk');
    assert.deepEqual(
      acquisition.packet.transactions.map((r) => r.id),
      data.liveOverlay.currentPeriodActuals.transactions.map((r) => r.id)
    );
    join = acquisition.join;
  }
  return { day, data, qualified, join, exception, fault, payload: input.payload, inputDigest: digest(input) };
}
function remember(today, prior) {
  const history = prior?.history || [];
  const last = history.at(-1);
  // A refused refresh still displays the last qualified period's cohort.
  const periodDay = today.qualified ? today.day : (last?.day ?? today.day);
  const live = history.filter((r) => Math.floor(r.day / 14) === Math.floor(periodDay / 14));
  if (last && !live.includes(last)) live.unshift(last);
  if (today.qualified) live.push(today);
  return { ...today, history: live };
}
function display(today, prior) {
  // Each fork gets a new server memory slot. Feed it the preceding qualified
  // publications in period order, so a thin yesterday cannot erase an older
  // reading. The retained display follows the same two calls as the server.
  const history = prior?.history || [];
  const previous = history.at(-1);
  const stamp = today.payload.fetchedAt;
  const memory = Memory.create();
  const live = today.history;
  let data = today.data,
    source = today;
  if (previous) {
    for (const r of live) {
      memory.publish(
        context,
        { schema: Memory.SCHEMA, payload: r.payload },
        {
          context,
          householdAccountId: context,
          lastBudgetAccountId: context,
          credentialSource: 'env',
          data: r.data,
          checkedAt: r.payload.fetchedAt,
        },
        undefined,
        activity(r.data)
      );
    }
  }
  if (today.qualified && previous) data = memory.withLastKnownCardActivity(context, context, stamp, data);
  else if (!today.qualified && previous) {
    source = previous;
    const retained = memory.readDisplay(context);
    assert.ok(retained, 'qualified previous cohort was not retained');
    const display = Live.withLatestCompleteRefresh(retained, {
      source: 'provider',
      checkedAt: stamp,
      attemptedAt: stamp,
      reason: data.liveOverlay.reason,
    });
    data = memory.withLastKnownCardActivity(context, context, retained.checkedAt, display);
  } else if (!today.qualified) data = Live.withoutCompleteRefresh(data);
  const opts = F.budgetRecommendInputs(data, { periods: [], settlementEvidence: null });
  let advice;
  try {
    advice = F.recommend(data.plan, data.meta.asOf, opts);
  } catch (error) {
    return {
      qualified: false,
      sourceDay: source.day,
      retained: false,
      exception: { code: error.name, message: error.message, stage: 'Forecast.recommend' },
      amounts: {},
      unresolved: true,
      moves: [],
    };
  }
  const v = advice.payPeriodViews?.find((x) => x.role === 'active');
  if (source.qualified)
    assert.ok(v?.stackSummary, 'qualified observation did not reach the Stack publication');
  const s = v?.stackSummary,
    credit = s?.credit,
    tile = v?.billsAccountPeriodBalance;
  const card = credit?.lines?.find((l) => l.id === 'travelvisa'),
    line = credit?.lines?.find((l) => l.id === 'heloc');
  const ids = new Map(source.join.map((r) => [r.localId, Number(r.transactionId)]));
  const row = (r) => ({ id: ids.get(r.id), cents: cents(r.amount), date: r.date, reason: r.includeReason });
  const countedRows = (b) =>
    (b.recon || []).filter(
      (r) =>
        Number.isFinite(r.amount) && !(r.pending && r.pendingPostedDuplicate && !r.pendingAmountEstimated)
    );
  const budgets = (v?.householdBudget || []).map((b) => ({
    id: b.id,
    spent: cents(b.spent),
    listAvailable: b.reconMatchesSpent === true && !b.withheldReason && !b.projected,
    rows: countedRows(b).map(row),
  }));
  const purchases = [];
  for (const view of advice.payPeriodViews || []) {
    if (view.role === 'future') continue;
    for (const b of view.householdBudget || []) {
      for (const r of countedRows(b)) purchases.push({ ...row(r), owner: b.id, start: view.start });
    }
  }
  const goalLedger = F.savingsItemLedger(data.plan, data.meta.asOf, opts);
  const packet = data.liveOverlay.currentPeriodActuals;
  for (const item of goalLedger.items) {
    // A qualified tally is a second possible owner for a linked purchase. Only
    // rows inside the tally's actual cutoff belong to the published spent figure.
    if (item.spent?.cents == null) continue;
    for (const ev of item.evidence) {
      const r = packet?.transactions.find((x) => x.id === ev.transactionRef);
      if (r && r.date <= date(offset(item.needDate) + 14) && ev.direction === 'charge')
        purchases.push({ ...row(r), owner: item.goalKey });
    }
  }
  const spendingRows = budgets.flatMap((b) => b.rows);
  const bills = (v?.bills || []).map((b) => ({
    id: b.id,
    date: b.date,
    remaining: cents(b.remaining),
    amount: cents(b.stackBillAmount),
    paid: b.status === 'PAID',
    basis: b.settlementBasis,
    part: b.stackBillPart,
    checked: b.stackBillPaid,
  }));
  const action = advice.currentPeriodAction;
  const alloc = advice.paydayAllocation;
  const moves = (action?.todayActions || []).map((a) => ({ kind: a.kind, cents: cents(a.amount) }));
  if (action?.moneyMovementRequired === true) moves.push({ kind: 'moneyMovementRequired' });
  if (alloc?.extraDebt?.target && alloc.extraDebt.allocated > 0 && alloc.extraDebt.status === 'ready')
    moves.push({ kind: 'extra-debt', cents: cents(alloc.extraDebt.allocated) });
  for (const item of alloc?.optional || [])
    if (item.amount > 0 && item.actionRequired === true)
      moves.push({ kind: 'optional', cents: cents(item.amount) });
  const sourceDay = source.day;
  const withheldPurchases = goalLedger.items
    .filter((i) => i.spent?.cents == null)
    .flatMap((i) =>
      i.evidence
        .filter((e) => e.direction === 'charge')
        .map((e) => ({
          id: ids.get(e.transactionRef),
          goal: i.goalKey,
          needDate: i.needDate,
          reasons: i.reasons,
        }))
    );
  return {
    qualified: today.qualified,
    sourceDay,
    retained: source !== today,
    publishedAsOf: data.meta.asOf,
    retainedReceipt: data.liveOverlay.retainedRefresh || null,
    start: v?.start,
    end: v?.end,
    exception: today.exception,
    amounts: {
      income: cents(s?.income?.total?.amount),
      cash: cents(v?.liveCurrentBalance),
      groceries: budgets.find((b) => b.id === 'groceries')?.spent ?? null,
      spending:
        budgets.some((b) => b.spent === null) || !budgets.length
          ? null
          : budgets.reduce((n, b) => n + b.spent, 0),
      billLoad: cents(v?.periodBillLoad),
      billPaid: cents(s?.bills?.paid),
      bad: cents(v?.balanceAfterDeductions),
      surplus: cents(s?.surplus?.amount),
      billsEnd: cents(tile?.amount),
      householdHold: cents(v?.budgetHold),
      goalKiteSpent: goalLedger.items.find((i) => i.goalKey === 'commitment:kite')?.spent?.cents ?? null,
      goalLoomSpent: goalLedger.items.find((i) => i.goalKey === 'commitment:loom')?.spent?.cents ?? null,
      cardPaid: cents(card?.paidBack?.amount),
      cardMinimum: cents(card?.minimum?.amount),
      cardTarget: cents(card?.target?.amount),
      cardRemainder: cents(card?.stillToPayBack?.amount),
      cardSpent: cents(card?.spent?.amount),
      linePaid: cents(line?.paidBack?.amount),
      otherIncome: cents(s?.income?.other?.amount),
    },
    buys: purchases,
    withheldPurchases,
    coverageIssues: (advice.cardPurchaseCoverage?.issues || []).map((i) => i.code),
    budgets,
    bills,
    spendingRows,
    incomeRows: (v?.income || []).flatMap((i) => (i.recon || []).map(row)),
    tileIssues: tile?.issues?.map((i) => i.code) || [],
    trust: {
      bad: v?.balanceAfterDeductionsTrust,
      surplus: s?.surplus?.trust,
      billLoad: v?.periodBillLoadTrust,
      billsEnd: tile?.trust,
      cardPaid: card?.paidBack?.trust,
      cardTarget: card?.target?.trust,
      cardRemainder: card?.stillToPayBack?.trust,
      cardSpent: card?.spent?.trust,
      linePaid: line?.paidBack?.trust,
    },
    contradictoryPayment: (credit?.unconfirmedPayments || []).some(
      (p) => p.amount < 0 || p.reason === 'card-payment-destination-conflict'
    ),
    cardReasons: card?.paidBack?.reasons || [],
    cardTrust: card?.spent?.trust,
    cardObservedAt: card?.activityObservedAt || null,
    goalFigures: goalLedger.items.map((i) => ({
      id: i.goalKey,
      needDate: i.needDate,
      spent: i.spent?.cents ?? null,
      net: i.net?.cents ?? null,
      reasons: i.reasons,
    })),
    heldRows: (v?.heldOutflowsToConfirm?.recon || []).map(row),
    held: cents(v?.heldOutflowsToConfirm?.total) ?? 0,
    unresolved:
      !today.qualified ||
      Boolean(
        v?.heldOutflowsToConfirm?.recon?.length ||
          credit?.unconfirmedPayments?.length ||
          goalLedger.unresolved?.evidence?.length ||
          packet?.transactions?.some((t) => t.pendingPostedAmbiguous)
      ),
    moves,
  };
}
async function replay(seed, day, events, fault, prior) {
  return publish(await observation(seed, day, events, fault), prior);
}
function publish(observed, prior) {
  const raw = remember(observed, prior);
  const view = display(raw, prior);
  if (observed.fault === 'thin-payer' && observed.qualified && prior) {
    const cold = display(remember(observed, null), null);
    view.payerGap = {
      amounts: cold.amounts,
      reasons: cold.cardReasons,
      unconfirmed: cold.contradictoryPayment,
    };
  }
  return { raw, view };
}
module.exports = { observation, remember, publish, replay, cents, digest };
