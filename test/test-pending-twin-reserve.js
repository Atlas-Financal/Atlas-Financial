'use strict';

// One unresolved pending/posted card purchase twin (standing rule, Dale,
// #821 7223690915). Invented receipts through the normal observer, the live
// plan and the Budget recommendation. Expected figures are written by hand
// from the invented world, never read back from the code under test:
// Bills 500, a 25 card minimum due today, a 150 grocery allowance, period
// income 1000, card posted balance 400 before this period.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const periodsPath = path.resolve(__dirname, '../public/periods.json');
const dataPath = path.resolve(__dirname, '../data.json');
const read = fs.readFileSync;
fs.readFileSync = function (file, ...opts) {
  const absolute = typeof file === 'string' ? path.resolve(file) : file;
  if (absolute === periodsPath) return '{"monthly":[]}';
  if (absolute === dataPath) throw new Error('This test uses invented observations');
  return read.call(this, file, ...opts);
};

try {
  const Forecast = require('../public/forecast');
  const Live = require('../scripts/live-plan');
  const Refresh = require('../scripts/refresh-trust');
  const History = require('../scripts/private-period-history');
  const Assistant = require('../scripts/assistant-packet');
  const OA = require('../scripts/operating-answer');
  const { world } = require('./fixtures/card-coverage-aggregate-world');

  const TWIN = 'card-purchase-replacement-unresolved';
  const SHORTFALL = 'card-bills-backing-shortfall';
  const PENDING = { is_pending: true, status: 'pending' };
  const purchase = (amount, extra) => ['card', amount, null, 'purchase', extra];
  const twin = (amount = 60) => [purchase(amount), purchase(amount, PENDING)];

  function scenario(rows, { bills = 500, twoCards = false, reserveSavings = false, editInput = () => {},
    editData = () => {} } = {}) {
    const input = world(rows, { twoCards, reserveSavings, edit(candidate) {
      candidate.identity = { rules: [], billPaymentPayees: [] };
      candidate.payload.accounts[0].balance = bills;
      // The issuer's posted balance holds posted rows only, never a pending copy.
      candidate.payload.accounts[3].balance = 400 + rows
        .filter(row => row[0] === 'card' && row[4]?.is_pending !== true).reduce((sum, row) => sum + row[1], 0);
      for (const account of candidate.payload.accounts) account.last_fetch = candidate.asOf + 'T17:00:00Z';
      editInput(candidate);
    } });
    const { data, report } = Live.fromObservation(input);
    editData(data);
    const advice = Forecast.recommend(data.plan, input.asOf, Forecast.budgetRecommendInputs(data));
    const active = advice.payPeriodViews.find(view => view.role === 'active');
    return { coverage: advice.cardPurchaseCoverage, active, advice, data, report, input };
  }
  const card = (s, id = 'travelvisa') => s.data.debts.find(row => row.id === id);
  const groceries = s => s.active.householdBudget.find(row => row.id === 'groceries');
  const history = s => History.sourceCompletenessFor({
    period: s.active, fetchedAt: s.input.payload.fetchedAt, transactionWindow: s.input.payload.transactionWindow,
    pendingCoverage: s.input.payload.pendingCoverage, report: s.report, publication: s.active,
  });
  const packetOf = s => Assistant.buildPacket({ data: s.data, periods: null, questionsMarkdown: '',
    env: {}, now: s.input.payload.fetchedAt });

  // Nothing that moves money, sets a weekly figure or proposes funding rests
  // on the twin: the shape the known Bills shortfall already publishes.
  function assertNoAdvice(s, label) {
    const { advice } = s;
    const action = advice.currentPeriodAction;
    assert.deepEqual(action.todayActions, [], label + ': no pay prompt');
    assert.equal(action.moneyMovementRequired, null, label + ': no money movement claim');
    assert.equal(action.noMovementToday, null, label + ': no no-movement claim either');
    assert.equal(action.spendPermission ?? null, null, label + ': no spend permission');
    assert.equal(advice.weekly, null, label + ': no weekly figure');
    const allocation = advice.paydayAllocation;
    const essentialsLine = allocation.lines.find(row => row.kind === 'essentials');
    for (const holder of [allocation, allocation.essentials, essentialsLine].filter(Boolean)) {
      assert.equal(holder.weeklyCap ?? null, null, label + ': no nested weekly cap');
      assert.equal(holder.spendPermission ?? null, null, label + ': no nested spend permission');
    }
    assert.equal(allocation.extraDebt.allocated, null, label + ': no extra debt');
    assert.equal(allocation.extraDebt.absorbable, null);
    assert.equal(advice.sim.endingSurplus ?? null, null, label + ': no ending surplus');
    assert.equal(advice.sim.extraDebtCapacity ?? null, null, label + ': no extra-debt capacity');
    assert.equal(advice.planSpendPaydayFunding.status, 'unavailable', label + ': no funding plan');
    assert.equal(advice.planSpendPaydayFunding.paydays?.length || 0, 0);
    const today = s.active.fromTodayFunding;
    assert.equal(today.contribution ?? null, null, label + ': no From today proposal');
    assert((today.periods || []).every(period => period.contribution == null), label + ': no later-period proposal');
    assert.notEqual(Forecast.planStatus(advice, { sim: advice.sim }).id, 'onPlan', label + ': no plan verdict on a withheld cap');
    const answer = OA.fromRefreshedState(s.data, { mode: 'live-overlay' });
    assert.equal(answer.currentSpendingPermission.weekly, null, label + ': operating answer has no weekly');
    assert.equal(answer.currentSpendingPermission.weeklyCap, null);
    assert.equal(answer.currentSpendingPermission.spendPermission, null);
    assert.equal(answer.currentSpendingPermission.noMovementToday, false, label + ': operating answer never says nothing moves');
    assert.equal(answer.extraDebtAllocation.allocated, null, label + ': operating answer has no extra debt');
  }

  // ── Controls: one posted 60 alone, and the same with Bills 5. ──
  const one = scenario([purchase(60)]);
  assert.equal(one.coverage.status, 'ready');
  assert.equal(one.coverage.reservedCash, 60);
  assert.equal(one.coverage.estimateBasis, undefined);
  assert.equal(one.active.fromTodayFunding.availableNow, 500 - 25 - (150 - 60) - 60, 'one-charge control From today');
  assert.deepEqual(one.advice.currentPeriodAction.todayActions.map(row => [row.kind, row.id, row.amount]),
    [['pay', 'travel', 25]], 'control: the minimum is a pay prompt when nothing is unresolved');
  assert.equal(card(one).balance, 460);
  assert.equal(card(one).pending, 0);

  // ── The witness: one posted and one pending 60, flagged by the observer. ──
  const witness = scenario(twin(60));
  {
    const { coverage, active, advice } = witness;
    const flagged = witness.data.liveOverlay.currentPeriodActuals.transactions
      .filter(tx => tx.pendingPostedDuplicate === true);
    assert.equal(flagged.length, 2, 'the observer flags exactly the posted and the pending copy');
    assert.equal(coverage.status, 'ready', 'one bounded twin no longer withholds card coverage');
    assert.equal(coverage.trust, 'estimated');
    assert.equal(coverage.estimateBasis, TWIN);
    assert.equal(coverage.estimateReason, Forecast.CARD_BILLS_SHORTFALL_ESTIMATE_REASON, 'the existing reason line, no new words');
    assert.deepEqual(coverage.issues, []);
    assert.equal(coverage.toConfirm, undefined, 'no new To-confirm row reaches the page');
    // Upper bound: both possible unpaid charges, never posted balance plus pending.
    assert.equal(coverage.reservedCash, 60 + 60);
    assert.equal(coverage.purchases.filter(row => row.replacementUnresolved === true).length, 2);
    // #1676 stands: the card keeps its posted balance and pending stays unknown.
    assert.equal(card(witness).balance, 460, 'posted card balance stays posted');
    assert.equal(card(witness).pendingUnknown, true, 'pending stays unknown');
    assert.notEqual(card(witness).pending, 60, 'the pending copy is never re-added as known pending');
    // Budget counts the posted copy once; neither copy is shown as a purchase still to cover.
    assert.equal(groceries(witness).spent, 60);
    for (const row of groceries(witness).recon) {
      assert.equal(row.cardPurchaseCoverage.status, 'unconfirmed');
      assert.equal(row.cardPurchaseCoverage.remaining, null);
    }
    // Independent facts stay visible: Bills stock, the due minimum, income, the Stack.
    assert.equal(active.liveCurrentBalance, 500);
    assert(advice.currentPeriodAction.bills.some(bill => bill.id === 'travel' && bill.remaining === 25),
      'the scheduled minimum is still an independent fact');
    assert.equal(active.stackSummary.surplus.terms.income, 1000);
    assert.equal(active.stackSummary.surplus.amount, 1000 - 150, 'either reading leaves groceries inside 150');
    assert.notEqual(active.stackSummary.surplus.trust, 'calculated');
    assert.equal(active.stackSummary.credit.lines.find(row => row.id === 'travelvisa').spent.amount, 60);
    // From today, when its own gates allow it, is never above the cautious bound.
    const bound = 500 - 25 - (150 - 60) - 120;
    const today = active.fromTodayFunding;
    assert(today.availableNow == null || today.availableNow <= bound, 'From today never exceeds the twin bound');
    // Bills period end keeps its own existing pending-identity hold.
    assert.equal(active.billsAccountPeriodBalance.status, 'unavailable');
    assert(active.billsAccountPeriodBalance.issues.some(row => row.code === 'cash-evidence-untrusted'));
    // Claims built on Balance After Deductions stay withheld, as before.
    assert.equal(active.operatingCashExplanation, null);
    assert.equal(active.extraDebt.allocated, null);
    assert.equal(active.afterDebtRepayment, null);
    assertNoAdvice(witness, 'witness');

    assert.equal(Refresh.fromIncumbent(witness).exactFiguresAvailable, false, 'refresh stays inexact');
    const closed = history(witness);
    assert.equal(closed.status, 'incomplete', 'the period history stays provisional');
    assert(closed.reasons.includes('publication:' + TWIN));
    for (const basis of Object.keys(Forecast.CARD_STRICT_ESTIMATE_REASONS)) {
      assert(History.REASONS.includes('publication:' + basis), basis + ' has a typed history reason');
    }

    const packet = packetOf(witness);
    assert.equal(packet.forecast.status, 'ok', 'the assistant Forecast block returns');
    assert.deepEqual(packet.forecast.cardCoverageEstimate, { basis: TWIN,
      reason: coverage.estimateReason, toConfirmCount: 0 });
    for (const key of ['predictedEndingBalance', 'payPeriodTotals', 'facilityCrossings']) {
      assert.equal(packet.forecast[key].status, 'unavailable', key + ' is withheld beside the twin');
    }
    assert.equal(packet.planning.trajectory.status, 'unavailable');
    assert.equal(packet.forecast.horizon.minBalance, null);
    assert.deepEqual(packet.forecast.currentPeriodAction.todayActions ?? [], []);

    // The page prints nothing new.
    const page = { URLSearchParams, location: { search: '?view=classic' },
      document: { addEventListener() {}, getElementById() { return null; } } };
    page.window = page;
    vm.createContext(page);
    for (const asset of ['stack-shell.js', 'stack-waterfall.js']) {
      vm.runInContext(read(path.join(__dirname, '../public', asset), 'utf8'), page);
    }
    const html = page.StackWaterfall.html({ data: witness.data, plan: witness.data.plan, recommendation: advice,
      selectedPeriodKey: active.start }, { creditOpen: true });
    assert(html.includes('$' + active.stackSummary.surplus.amount));
    assert(!html.includes(TWIN), 'the internal basis is not a page label');
  }

  // ── An unrelated sibling card and income stay exactly as they are. ──
  {
    const sibling = ['card2', 14, null, 'purchase'];
    const alone = scenario([sibling], { twoCards: true });
    const beside = scenario([...twin(60), sibling], { twoCards: true });
    assert.equal(beside.coverage.estimateBasis, TWIN);
    assert.equal(beside.coverage.reservedCash, 60 + 60 + 14);
    const siblingRow = s => s.coverage.purchases.find(row => row.accountLabel === 'Second invented card');
    assert.equal(siblingRow(beside).remaining, 14);
    assert.equal(siblingRow(beside).replacementUnresolved, undefined);
    const credit = s => s.active.stackSummary.credit.lines.find(row => row.id === 'mbna').spent;
    assert.deepEqual(credit(beside), credit(alone), 'the sibling card line is unchanged');
    assert.equal(beside.active.stackSummary.surplus.terms.income, alone.active.stackSummary.surplus.terms.income);
    assertNoAdvice(beside, 'sibling');
  }

  // ── A genuine link recovers the control and revokes only its own hold. ──
  {
    const linked = scenario([purchase(60, { id: 97001 }), purchase(60, { ...PENDING, id: 97001 })]);
    assert.equal(linked.coverage.status, 'ready');
    assert.equal(linked.coverage.estimateBasis, undefined, 'no twin once the provider links the copies');
    assert.equal(linked.coverage.reservedCash, 60, 'reserved once');
    assert.equal(linked.active.fromTodayFunding.availableNow, one.active.fromTodayFunding.availableNow);
    assert.deepEqual(linked.advice.currentPeriodAction.todayActions, one.advice.currentPeriodAction.todayActions);
    assert.equal(linked.advice.weekly, one.advice.weekly);
    assert.equal(Refresh.fromIncumbent(linked).exactFiguresAvailable, true);
  }

  // ── A verified Bills 5: the twin holds; once linked, the shortage remains. ──
  {
    const short = scenario(twin(60), { bills: 5 });
    assert.equal(short.coverage.status, 'ready');
    assert.equal(short.coverage.estimateBasis, TWIN, 'the twin basis wins beside a shortfall');
    assert.equal(short.coverage.reservedCash, 120);
    assert.equal(short.active.liveCurrentBalance, 5);
    assertNoAdvice(short, 'short Bills');
    const linked = scenario([purchase(60, { id: 97002 }), purchase(60, { ...PENDING, id: 97002 })], { bills: 5 });
    assert.equal(linked.coverage.estimateBasis, SHORTFALL, 'the known shortage is independent of the ambiguity');
    assert.equal(linked.coverage.reservedCash, 60);
    assert.equal(linked.active.fromTodayFunding.availableNow, 0);
    assertNoAdvice(linked, 'linked short Bills');
  }

  // ── A crossing pair: 100 + 100 against a 150 allowance. ──
  {
    const crossing = scenario(twin(100));
    assert.equal(crossing.coverage.estimateBasis, TWIN);
    assert.equal(crossing.coverage.reservedCash, 200);
    // Balance After Deductions depends on the reading here: 850 for one charge,
    // 800 for two. Neither is published from the twin, and nothing funds from it.
    const packet = packetOf(crossing);
    assert.equal(packet.forecast.predictedEndingBalance.status, 'unavailable');
    assert.equal(packet.forecast.payPeriodTotals.status, 'unavailable');
    assert.notEqual(crossing.active.stackSummary.surplus.trust, 'calculated', 'never certified');
    const bound = 500 - 25 - Math.max(0, 150 - 100) - 200;
    const today = crossing.active.fromTodayFunding;
    assert(today.availableNow == null || today.availableNow <= bound);
    assertNoAdvice(crossing, 'crossing');
  }

  // ── Anything without a complete independent bound stays withheld, and a
  // withheld replacement makes no pay prompt or dependent claim either. ──
  function assertHardReplacement(s, label) {
    assert.equal(s.coverage.status, 'unavailable', label + ': coverage stays withheld');
    assert.notEqual(s.coverage.estimateBasis, TWIN, label);
    assert(s.coverage.issues.some(row => row.code === 'coverage-replacement-ambiguous'), label + ': replacement named');
    assert.equal(s.coverage.reservedCash, null);
    assertNoAdvice(s, label);
  }
  const packetRows = s => s.data.liveOverlay.currentPeriodActuals.transactions;
  const twinRows = s => packetRows(s).filter(tx => tx.pendingPostedDuplicate === true);
  const observed = edit => data => { data.liveOverlay.observedCash = edit(data.liveOverlay.observedCash); };
  const billsRow = (edit) => observed(cash => cash && { ...cash,
    accounts: cash.accounts.map(row => row.id === 'chequing-a' ? edit(row) : row) });
  const hardCases = [
    ['stale Bills evidence', twin(60), { editData: billsRow(row => ({ ...row, evidenceDate: '2026-09-19' })) }],
    ['missing Bills evidence', twin(60), { editData: observed(() => null) }],
    ['incomplete Bills evidence', twin(60), { editData: observed(cash => ({ ...cash, complete: false })) }],
    ['estimated Bills evidence', twin(60), { editData: billsRow(row => ({ ...row, confidence: 'estimated' })) }],
    ['funded but conflicting Bills evidence', twin(60), { editData: billsRow(row => ({ ...row, value: 499 })) }],
    ['stale card balance', twin(60), { editData(data) { card({ data }).balanceAsOf = '2026-09-17'; } }],
    ['undated card balance', twin(60), { editData(data) {
      const row = card({ data }); delete row.balanceAsOf; row.balanceAsOfUnknown = true; } }],
    ['unknown unit', [purchase(60), purchase(60, { ...PENDING, currency: 'usd' })], {}],
    ['contradictory copy', twin(60), { editData(data) { twinRows({ data })[0].contradictoryEvidence = true; } }],
    ['flagged ambiguous', twin(60), { editData(data) { twinRows({ data })[1].pendingPostedAmbiguous = true; } }],
    ['named separate predecessor', twin(60), { editData(data) {
      const rows = twinRows({ data });
      rows.find(tx => tx.pending === false).distinctPendingId = String(rows.find(tx => tx.pending === true).id); } }],
    ['different card', twin(60), { twoCards: true, editData(data) {
      const pending = twinRows({ data }).find(tx => tx.pending === true);
      pending.atlasAccountId = pending.accountId = pending.account = 'mbna'; } }],
    ['unequal amount', twin(60), { editData(data) { twinRows({ data }).find(tx => tx.pending === true).amount = 61; } }],
    ['a second possible replacement', [...twin(60), purchase(25), purchase(25, PENDING)], {}],
    ['a payment touched the twin', [...twin(60), ['bills', 60, null, 'cash', { notes: 'travelvisa' }],
      ['card', -60, null, 'credit']], {}],
  ];
  for (const [label, rows, opts] of hardCases) assertHardReplacement(scenario(rows, opts), label);

  // Many-to-one and one-to-many copies are never one bounded twin: whatever
  // the existing rules decide for them, this admission adds nothing.
  for (const [label, rows] of [
    ['two pending, one posted', [purchase(60), purchase(60, PENDING), purchase(60, PENDING)]],
    ['two posted, one pending', [purchase(60), purchase(60), purchase(60, PENDING)]],
  ]) {
    const s = scenario(rows);
    assert.notEqual(s.coverage.estimateBasis, TWIN, label + ': not admitted');
    assert(!(s.coverage.purchases || []).some(row => row.replacementUnresolved), label + ': no twin marker');
    if (s.coverage.status === 'unavailable') assertNoAdvice(s, label);
  }

  // An older invalid pending row beside the twin never becomes a known pending:
  // the advancing live plan still refuses it (#1676), twin or not.
  {
    let threw = null, s = null;
    try { s = scenario([...twin(60), ['card', 'bad', '2026-09-10', 'purchase', PENDING]]); } catch (err) { threw = err; }
    if (threw) assert.match(threw.message, /pending-freshness-unproven/);
    else {
      assert.equal(card(s).pendingUnknown, true);
      assert.notEqual(card(s).pending, 0, 'never a proven zero');
    }
  }

  console.log('PASS one bounded pending twin holds its upper reserve and pauses every proposal');
} finally {
  fs.readFileSync = read;
}
