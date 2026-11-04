'use strict';
// Private verification only. All monetary inputs and provider IDs are invented.
const path = require('node:path');
const root = path.join(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));
const Live = require(path.join(root, 'scripts/live-plan'));
const R = require(path.join(root, 'scripts/reconcile'));
const source = require('./fixtures/card-backfill-data');
const results = [], details = [];
function check(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, error: error.message }); }
}
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ': ' + JSON.stringify(actual) + ' != ' + JSON.stringify(expected));
}
const cents = value => Math.round(value * 100), now = '2035-10-03';
function fixture(advanced, receiving, satisfied, amount) {
  const x = source('triangle', 'triangle'); x.asOf = now;
  x.data.meta.asOf = x.data.plan.opening.asOf = advanced ? '2035-10-01' : now;
  x.data.plan.opening.representedEvents = satisfied ? [{ id: 'triangle', date: '2035-10-07', effectiveAsOf: now }] : [];
  x.data.plan.income[0].anchor = '2035-10-01'; x.data.plan.income[0].amount = 0;
  x.data.plan.budget = { categories: [] };
  x.data.plan.obligations = [{ id: 'triangle', debtId: 'triangle', effect: 'payment', frequency: 'monthly', day: 7,
    firstDue: '2035-10-07', amount: 43.21, confidence: 'estimated', payingAccount: 'chequing-a',
    statementOccurrences: [{ scheduledDate: '2035-10-07', dueDate: '2035-10-09', minimum: 47.39, currency: 'cad', confidence: 'confirmed' }],
    sentPayments: [{ scheduledDate: '2035-10-07', confirmed: true, intent: 'minimum', debitId: 'invented-debit',
      postedOn: now, amount, currency: 'cad', fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: now }] }];
  x.data.plan.startingCash.breakdown[0].value = advanced ? (61327 + cents(amount)) / 100 : 613.27;
  x.data.plan.startingCash.breakdown[1].value = 0;
  x.data.debts[0].balance = advanced && receiving ? (82143 + cents(amount)) / 100 : 821.43;
  x.payload.fetchedAt = now + 'T18:00:00Z';
  x.payload.accounts.forEach(a => { a.updated_at = now + 'T17:00:00Z'; a.balance_last_update = now + 'T17:00:00Z'; });
  x.payload.accounts[0].balance = 613.27; x.payload.accounts[1].balance = 0; x.payload.accounts[3].balance = 821.43;
  x.payload.transactionWindow = { startDate: advanced ? '2035-10-01' : now, endDate: now, complete: true, hasMore: false, truncated: false };
  x.payload.transactions = [{ id: 97551, account_id: 3001, date: now, amount, currency: 'cad',
    payee: 'CAN TIRE MC', category_name: 'Credit Card Payment', status: 'reviewed', is_pending: false }];
  if (receiving) x.payload.transactions.push({ id: 97552, account_id: 3004, date: now, amount: -amount, currency: 'cad',
    payee: 'PAYMENT - THANK YOU', category_name: 'Credit Card Payment', status: 'reviewed', is_pending: false });
  return x;
}
for (const amount of [18.12, 47.39, 52.67]) for (const advanced of [false, true])
  for (const receiving of [false, true]) for (const satisfied of [false, true]) {
    check(`stock ${amount}/${advanced ? 'advance' : 'same'}/${receiving ? 'paired' : 'sender'}/${satisfied ? 'proof' : 'unknown'}`, () => {
      const x = fixture(advanced, receiving, satisfied, amount), before = JSON.stringify(x), live = Live.fromObservation(x);
      equal(JSON.stringify(x), before, 'fixture immutability');
      equal(live.data.liveOverlay.applied, true, 'live admission');
      const walk = F.projectDebts(live.data.plan, live.data.debts, now, { debtHorizonDays: 10 });
      const closing = walk.marks.at(-1).debts.find(d => d.id === 'triangle').balance;
      equal([cents(F.postedHouseholdChequingCash(live.data.plan)), cents(live.data.debts[0].balance), cents(closing)],
        [61327, 82143, 82143], 'observed stocks cannot receive another inferred principal payment');
    });
  }
const base = fixture(false, false, false, 52.67).data.plan;
check('one proof cannot satisfy two swapped identities', () => {
  const p = structuredClone(base), row = p.obligations[0];
  p.opening.representedEvents = [{ id: 'triangle', date: '2035-10-07', effectiveAsOf: now }];
  row.statementOccurrences = [{ scheduledDate: '2035-10-07', dueDate: '2035-11-07', minimum: 47.39, currency: 'cad', confidence: 'confirmed' },
    { scheduledDate: '2035-11-07', dueDate: '2035-10-07', minimum: 59.17, currency: 'cad', confidence: 'confirmed' }];
  row.sentPayments = ['2035-10-07', '2035-11-07'].map((date, i) => ({ ...row.sentPayments[0], scheduledDate: date, debitId: 'invented-' + i }));
  let state;
  try { state = F.cardMinimumState(p, now); }
  catch (error) { details.push({ ambiguousReplacementRejected: error.message }); return; }
  if (state.payments.filter(p => p.issuerMinimumStatus === 'satisfied').length > 1 || state.status === 'ready')
    throw new Error('one primary proof is reused across original occurrences');
  if (state.payments.some(p => p.issuerMinimumStatus === 'satisfied' && p.scheduledDate !== '2035-10-07'))
    throw new Error('original proof is assigned to another original identity');
});
check('later opening legacy proof cannot satisfy history', () => {
  const p = structuredClone(base); p.opening = { asOf: '2035-10-09', representedEvents: [{ id: 'triangle', date: '2035-10-07' }] };
  const state = F.cardMinimumState(p, now);
  if (state.status === 'ready' || state.payments.some(p => p.issuerMinimumStatus === 'satisfied' || p.additionalCashRequired === 0))
    throw new Error('later-opening legacy satisfaction leaks backward');
});
check('original posting and canonical paths preserve identity', () => {
  const p = structuredClone(base); p.opening = { asOf: '2035-10-09', representedEvents: [{ id: 'triangle', date: '2035-10-07', effectiveAsOf: now }] };
  p.obligations[0].sentPayments = [];
  const data = { meta: { asOf: '2035-10-09' }, plan: p };
  const posting = R.reconcile({ data, map: { mappings: [] }, observations: [], posting: { observations: [{ observationId: 'invented-original-key',
    fact: 'posting', eventId: 'triangle', scheduledDate: '2035-10-07', observedAsOf: '2035-10-09', posted: true }] } }).rows[0];
  const canonical = R.readCanonical(data, { collection: 'representedEvents', id: 'triangle', date: '2035-10-07' });
  equal([posting.scheduledExists, posting.represented, posting.status, canonical.found, !!canonical.value, canonical.represented],
    [true, true, 'MATCH', true, true, true], 'original identity must agree with Forecast and opening-qualified proof');
});
check('unknown cash withholds public funding feasibility', () => {
  const p = structuredClone(base); p.income[0].amount = 1000;
  p.commitments = [{ id: 'invented-trip', label: 'Invented trip', date: '2035-10-25', amount: 120, confidence: 'confirmed' }];
  const advice = F.recommend(p, now), standalone = F.majorPlans(p, now, { weeklyVariable: 0 });
  const trip = advice.majorPlans.find(r => r.id === 'invented-trip'), direct = standalone.find(r => r.id === 'invented-trip');
  for (const row of [trip, direct]) {
    if (row && (row.funded === true || row.verdict === 'ON TRACK' || typeof row.margin === 'number'
        || typeof row.fundingMargin === 'number' || typeof row.remaining === 'number'))
      throw new Error('unknown payment funding retains an actionable trip verdict/margin');
  }
});
check('unknown cash cannot become a legacy unallocated shortfall', () => {
  const p = structuredClone(base);
  const sim = F.simulate(p, now), free = F.unallocatedCash(sim, { reserveMonthly: 73.11 }, { windowDays: 91 });
  equal([free.ending, free.amount, free.negative], [null, null, null], 'legacy remainder cannot coerce unknown cash into a shortfall');
});
check('current and future periods cannot publish unknown remainders', () => {
  const p = structuredClone(base), r = F.recommend(p, now);
  for (const v of [r.defaultView, ...r.payPeriodViews]) {
    if (v.end < now) continue;
    equal([v.available, v.balanceAfterDeductions, v.predictedEndingBalance],
      [null, null, null], 'unconfirmed minimum cash path');
    if (v.leftover) equal([v.leftover.afterBills, v.leftover.afterHouseholdBudget,
      v.extraDebt.allocated], [null, null, null], 'no actionable period remainder');
  }
});
check('group cards retain prices and withhold feasibility', () => {
  const p = structuredClone(base);
  p.commitments = ['one', 'two'].map((id, i) => ({ id, label: id,
    date: '2035-10-25', amount: 120 + i, confidence: 'confirmed', group: 'trip',
    groupLabel: 'Invented trip', planSpendSummary: true }));
  const rows = F.majorPlans(p, now), cards = F.planSpendCards(rows);
  equal(rows.map(row => row.need), [120, 121], 'contractual prices survive');
  equal([cards[0].verdict, cards[0].scheduleRemaining], [null, null], 'no grouped feasibility');
});
check('provider posting and canonical preview retain the original key', () => {
  const O = require('../scripts/provider-observe'), C = require('../scripts/canonical-refresh');
  const p = structuredClone(base), due = '2035-10-09';
  p.obligations[0].sentPayments = [];
  p.opening = { asOf: due, representedEvents: [] };
  const data = { meta: { asOf: due }, plan: p, debts: [] };
  // Explicit invented primary posting evidence. It is not inferred from a debit.
  const candidate = { id: 'triangle', date: due, scheduledDate: '2035-10-07',
    providerTransactionId: 'invented-proof', observedAmount: 47.39 };
  const obs = O.postingObservationFromCandidate(candidate, due + 'T18:00:00Z');
  equal([obs.scheduledDate, obs.canonical.date], ['2035-10-07', '2035-10-07'], 'stable posting identity');
  const report = { writesCanonicalState: false, fetchedAt: due + 'T18:00:00Z',
    representedEventCandidates: [candidate], reconciliation: { rows: [] } };
  const cutover = C.buildOpeningCutover(data, report, due, { mappings: [] });
  equal(cutover.proposedOpening.representedEvents,
    [{ id: 'triangle', date: '2035-10-07' }], 'stable canonical proposal');
  const once = Live.overlayLiveState({ data, report }), twice = Live.overlayLiveState({ data: once.data, report });
  equal(once.data.plan.opening.representedEvents, [{ id: 'triangle', date: '2035-10-07', effectiveAsOf: due }], 'stable live proof');
  equal(twice.data.plan.opening.representedEvents, once.data.plan.opening.representedEvents, 'repeat refresh identity');
  equal(F.expandEvents(twice.data.plan, due, due).filter(row => row.id === 'triangle').length, 0, 'no replay');
});
check('Plan Spend reprints unavailable values without feasibility or NaN', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const p = structuredClone(base);
  p.commitments = [{ id: 'invented-trip', label: 'Invented trip', date: '2035-10-25',
    amount: 120, confidence: 'confirmed' }];
  const context = { Forecast: F, App: { register() {}, boot() {} },
    money2: n => '$' + Number(n).toFixed(2), fmtDateFull: date => date };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/plan-spend.js'), 'utf8'), context);
  const html = context.planSpendPageHtml(F.recommend(p, now), null);
  if (/FEASIBLE IN CURRENT PLAN|\$NaN|Still to fund in this plan<\/dt><dd>\$0/.test(html.list))
    throw Error('unknown funding rendered as an actionable amount');
  if (!html.list.includes('$120.00') || !html.list.includes('STATUS UNAVAILABLE')
      || !html.list.includes('Not established')) throw Error('price or unavailable rendering lost');
});
// Independent ledger: one posted 83.79 transfer is already inside 785.17
// Bills cash and 921.86 card stock. Moving the due date never moves that money.
for (const moved of [false, true]) for (const proof of ['qualified', 'legacy', 'future', 'invalid', 'wrong-cycle']) {
  check(`receipt lifecycle ${moved ? 'moved' : 'unmoved'}/${proof}`, () => {
    const x = fixture(false, true, true, 83.79), first = proof === 'legacy' ? '2035-10-05' : now;
    x.data.meta.asOf = x.data.plan.opening.asOf = first;
    const p = x.data.plan, row = p.obligations[0];
    row.amount = 61.93;
    row.statementOccurrences = moved ? [{ scheduledDate: '2035-10-07', dueDate: '2035-10-09',
      minimum: 67.43, currency: 'cad', confidence: 'confirmed' }] : undefined;
    p.opening.representedEvents = [{ id: 'triangle', date: proof === 'wrong-cycle' ? '2035-09-07' : '2035-10-07',
      ...(proof !== 'legacy' ? { effectiveAsOf: proof === 'future' ? '2035-10-20' : proof === 'invalid' ? '2035-10-99' : now } : {}) }];
    p.startingCash.breakdown[0].value = x.payload.accounts[0].balance = 785.17;
    x.data.debts[0].balance = x.payload.accounts[3].balance = 921.86;
    const known = proof === 'qualified' || proof === 'legacy';
    let data = x.data;
    for (const date of [...new Set([first, '2035-10-07', '2035-10-08', '2035-10-09', '2035-10-10'])]) {
      x.data = data; x.asOf = date; x.payload.fetchedAt = date + 'T18:00:00Z';
      x.payload.accounts.forEach(a => { a.updated_at = date + 'T17:00:00Z'; a.balance_last_update = date + 'T17:00:00Z'; });
      x.payload.transactionWindow = { startDate: '2035-10-01', endDate: date, complete: true, hasMore: false, truncated: false };
      const before = JSON.stringify(x), live = Live.fromObservation(x);
      equal(JSON.stringify(x), before, 'input remains immutable');
      equal(live.data.liveOverlay.applied, true, 'live admission');
      data = live.data;
      const state = F.cardMinimumState(data.plan, date);
      equal([state.status, state.payments[0].issuerMinimumStatus],
        [known ? 'ready' : 'unavailable', known ? 'satisfied' : 'unconfirmed'], 'durable issuer knowledge');
      const walk = F.projectDebts(data.plan, data.debts, date, { debtHorizonDays: 2 });
      equal([cents(F.postedHouseholdChequingCash(data.plan)), cents(data.debts[0].balance), cents(walk.byId.triangle.balance)],
        [78517, 92186, 92186], 'one transfer changes stocks once');
      equal(F.simulate(data.plan, date, { horizonDays: 2, weeklyVariable: 0 }).ending,
        known ? 785.17 : null, 'confirmed proof survives the due date');
      equal(F.cardMinimumState(Live.fromObservation({ ...x, data }).data.plan, date), state, 'same-day idempotence');
      // Forecast owns status. The actual disclosure must keep printing it on
      // both sides of the due date, while missing transaction links stay honest.
      const advice = F.recommend(data.plan, date, { debts: data.debts,
        liveOverlay: data.liveOverlay, currentPeriodActuals: data.liveOverlay.currentPeriodActuals });
      const bill = advice.defaultView.calendarPeriods.flatMap(period => period.bills)
        .find(bill => bill.id === 'triangle' && bill.date === (moved ? '2035-10-09' : '2035-10-07'));
      if (!bill) throw Error('minimum disappeared from rendered calendar');
      equal(bill.status, known ? 'PAID' : 'unconfirmed', 'calendar status');
      const html = require('../public/bill-detail').html(bill, data);
      if (!html.includes('Published status</dt><dd>' + (known ? 'PAID' : 'unconfirmed'))) throw Error('disclosure lost issuer status');
    }
    // A supported canonical proposal must carry the same durable knowledge;
    // its approval binds the qualifier as well as id/date. No real write.
    const C = require('../scripts/canonical-refresh'), nextDate = '2035-10-11';
    x.data = data; x.asOf = nextDate; x.payload.fetchedAt = nextDate + 'T18:00:00Z';
    x.payload.accounts.forEach(a => { a.updated_at = nextDate + 'T17:00:00Z'; a.balance_last_update = nextDate + 'T17:00:00Z'; });
    x.payload.transactionWindow.endDate = nextDate;
    const report = Live.fromObservation(x).report, cutover = C.buildOpeningCutover(data, report, nextDate, x.accountMap);
    equal(cutover.cutoverWriteSupported, true, 'synthetic canonical cutover admission');
    const nextData = structuredClone(data);
    nextData.meta.asOf = nextData.plan.opening.asOf = nextDate;
    nextData.plan.opening.representedEvents = cutover.proposedOpening.representedEvents;
    equal(F.cardMinimumState(nextData.plan, nextDate).payments[0].issuerMinimumStatus,
      known ? 'satisfied' : 'unconfirmed', 'canonical proposal preserves qualification');
    C.validateOpeningApplied(data, nextData, { openingCutover: cutover });
    if (proof !== 'wrong-cycle') {
      const changed = structuredClone(cutover);
      changed.proposedOpening.representedEvents[0].effectiveAsOf = '2035-10-12';
      if (C.openingApprovalIdFrom(changed, x.accountMap) === C.openingApprovalIdFrom(cutover, x.accountMap))
        throw Error('opening approval does not bind minimum proof qualification');
      const tampered = structuredClone(nextData);
      delete tampered.plan.opening.representedEvents[0].effectiveAsOf;
      let rejected = false;
      try { C.validateOpeningApplied(data, tampered, { openingCutover: cutover }); } catch { rejected = true; }
      if (!rejected) throw Error('canonical validation accepted stripped qualification');
    }
    if (known) {
      equal(F.cardMinimumState(data.plan, '2035-10-04').payments[0].issuerMinimumStatus,
        proof === 'legacy' ? 'unconfirmed' : 'satisfied', 'historical qualification');
      equal(F.cardMinimumState(data.plan, first).payments[0].issuerMinimumStatus, 'satisfied', 'earliest known opening retained');
      const next = F.expandEvents(data.plan, '2035-11-07', '2035-11-07').find(e => e.id === 'triangle');
      equal([next.date, next.amount, next.confidence], ['2035-11-07', -61.93, 'estimated'], 'next recurrence remains independent');
    }
  });
}
for (const intent of ['absent', 'purchase-backfill', 'minimum']) for (const qualified of [false, true])
  for (const advanced of [false, true]) for (const moved of [false, true]) {
    check(`receipt stock ${intent}/${qualified}/${advanced}/${moved}`, () => {
      const x = fixture(advanced, true, true, 52.67), p = x.data.plan, row = p.obligations[0];
      if (!qualified) delete p.opening.representedEvents[0].effectiveAsOf;
      if (!moved) row.statementOccurrences[0].dueDate = '2035-10-07';
      if (intent === 'absent') delete row.sentPayments;
      else row.sentPayments[0].intent = intent;
      const live = Live.fromObservation(x), data = live.data;
      const walk = F.projectDebts(data.plan, data.debts, now, { debtHorizonDays: 10 });
      equal([cents(F.postedHouseholdChequingCash(data.plan)), cents(data.debts[0].balance), cents(walk.byId.triangle.balance),
        cents(F.simulate(data.plan, now, { horizonDays: 10, weeklyVariable: 0 }).ending)],
        [61327, 82143, 82143, 61327], 'receipt annotation is no second principal payment');
    });
  }
const failures = results.filter(r => !r.pass);
for (const failure of failures) console.error(failure.name + ': ' + failure.error);
console.log('Card minimum repair conservation: ' + results.length + ' checks, ' + failures.length + ' failures');
process.exitCode = failures.length ? 1 : 0;
