'use strict';
// Independent invented ledger: $1,000 cash and $800 debt, one $49.37
// payment against a $43.19 minimum. Close at $950.63/$750.63, once.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const Live = require('../scripts/live-plan');
const Category = require('../scripts/card-minimum-category');
const crypto = require('node:crypto');
const source = require('./fixtures/card-backfill-data');
const clone = x => JSON.parse(JSON.stringify(x));
const NOW = '2035-10-06', ORIGINAL = '2035-10-07', DUE = '2035-10-08';
const cases = [], root = path.join(__dirname, '..');
const disk = fs.readFileSync(path.join(root, 'data.json'), 'utf8');
function check(name, fn) { try { fn(); cases.push({ name, pass: true }); }
  catch (e) { cases.push({ name, pass: false, error: e.stack }); } }

function fixture(card = 'triangle', id = card === 'travelvisa' ? 'travel' : card) {
  const x = source(card, id), name = Object.keys(Category.CATEGORIES).find(k => Category.CATEGORIES[k] === card);
  x.data.meta.asOf = x.data.plan.opening.asOf = '2035-10-01';
  x.data.plan.opening.representedEvents = [];
  x.data.plan.income[0].anchor = '2035-10-01'; x.data.plan.income[0].amount = 0;
  x.data.plan.budget = { categories: [] };
  x.data.plan.obligations = [{ id, debtId: card, effect: 'payment', frequency: 'monthly', day: 7,
    firstDue: ORIGINAL, payingAccount: 'chequing-a', amount: 41.13, confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: ORIGINAL, dueDate: DUE, minimum: 43.19,
      currency: 'cad', confidence: 'confirmed' }] }];
  x.data.plan.startingCash.breakdown[0].value = 1000;
  x.data.debts[0].balance = 800;
  x.payload.accounts[0].balance = 950.63; x.payload.accounts[3].balance = 750.63;
  x.payload.accounts.forEach(a => { a.updated_at = NOW + 'T17:00:00Z'; a.balance_last_update = NOW + 'T17:00:00Z'; });
  x.payload.fetchedAt = NOW + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2035-10-01', endDate: NOW, complete: true, hasMore: false, truncated: false };
  x.payload.categories = [{ id: 9001, name, is_income: false, is_group: false,
    exclude_from_totals: true, exclude_from_budget: true }];
  const payee = card === 'triangle' ? 'CAN TIRE MC' : card === 'mbna' ? 'MBNA M/C' : 'TFR-TO C/C';
  x.payload.transactions = [{ id: 98001, account_id: 3001, date: '2035-10-05', amount: 49.37,
    currency: 'cad', payee, category_id: 9001, is_pending: false, status: 'reviewed' }];
  x.asOf = NOW;
  return x;
}
function payment(live) { return F.cardMinimumState(live.data.plan, NOW); }
function packet(x) { return O.observe({ ...x, provider: 'lunchmoney' }).cardMinimumCategoryEvidence; }
function zero(x) { assert.equal(packet(x).payments.length, 0); }
function headerActual(live, bill) {
  return F.budgetPeriodProgress(live.data.plan, NOW,
    { start: '2035-10-01', end: '2035-10-14', bills: [bill], income: [], householdBudget: [] },
    { currentPeriodActuals: live.report.currentPeriodActuals }).bills.actual.amount;
}

for (const card of Object.values(Category.CATEGORIES)) check(`${card}: actual consumer, amount and conservation`, () => {
  const x = fixture(card), before = JSON.stringify(x), live = Live.fromObservation(x);
  assert.equal(JSON.stringify(x), before);
  const s = payment(live); assert.equal(s.status, 'ready'); assert.equal(s.payments.length, 1);
  assert.equal(s.payments[0].cashPaid, 49.37); assert.equal(s.payments[0].additionalCashRequired, 0);
  assert.equal(s.payments[0].minimumConfirmationSource, 'household-category');
  assert.equal(s.payments[0].scheduledDate, ORIGINAL); assert.equal(s.payments[0].date, DUE);
  assert.equal(F.startingCashAmount(live.data.plan), 950.63);
  assert.equal(live.data.debts[0].balance, 750.63);
  assert.deepEqual(live.data.plan.obligations, x.data.plan.obligations);
  const simulated = F.simulate(live.data.plan, NOW, { horizonDays: 5, weeklyVariable: 0 });
  assert.equal(simulated.ending, 950.63);
  const debt = F.projectDebts(live.data.plan, live.data.debts, NOW, { debtHorizonDays: 5 });
  assert.equal(debt.marks.at(-1).debts.find(d => d.id === card).balance, 750.63);
  const advice = F.recommend(live.data.plan, NOW, { debts: live.data.debts,
    currentPeriodActuals: live.report.currentPeriodActuals });
  assert.equal(advice.cardMinimumPayments.status, 'ready');
  assert.equal(advice.defaultView.balanceAfterDeductions, -43.19);
  const row = advice.defaultView.bills.find(b => b.id === x.eventId && b.date === DUE);
  assert.ok(row); assert.equal(row.householdPaymentStatus, 'paid'); assert.equal(row.cashPaid, 49.37);
  assert.equal(headerActual(live, row), 49.37, 'header uses posted category payment, not the 43.19 requirement');
  assert.equal(F.cardMinimumState(live.data.plan, '2035-10-04').payments.length, 0);
  const classification = F.classifyCurrentPeriodTransaction(live.report.currentPeriodActuals.transactions[0], live.data.plan);
  assert.equal(classification.kind, 'card-payment'); assert.equal(classification.householdSpending, false);
});

const negatives = {
  'generic transfer': x => { x.payload.categories[0].name = 'Payment, Transfer'; },
  'generic card payment': x => { x.payload.categories[0].name = 'Credit card payment'; },
  'wrong target card': x => { x.payload.categories[0].name = 'Minimum payment - TD Travel Visa'; },
  'unresolved category ID': x => { x.payload.categories = []; },
  'raw label alone': x => { x.payload.transactions[0].category_name = x.payload.categories[0].name; delete x.payload.transactions[0].category_id; },
  'contradictory category name': x => { x.payload.transactions[0].category_name = 'Payment, Transfer'; },
  'budget inclusion': x => { x.payload.categories[0].exclude_from_budget = false; },
  'totals inclusion': x => { x.payload.categories[0].exclude_from_totals = false; },
  'income category': x => { x.payload.categories[0].is_income = true; },
  'group category': x => { x.payload.categories[0].is_group = true; },
  'archived category': x => { x.payload.categories[0].archived = true; },
  'wrong funding account': x => { x.payload.transactions[0].account_id = 3002; },
  'external funding': x => { x.accountMap.mappings[0].atlasRole = 'household-external'; },
  'receiving card alone': x => { x.payload.transactions[0].account_id = 3004; x.payload.transactions[0].amount = -49.37; },
  'unknown account': x => { x.payload.transactions[0].account_id = 9999; },
  'pending': x => { x.payload.transactions[0].is_pending = true; },
  'unknown posting status': x => { delete x.payload.transactions[0].is_pending; },
  'foreign units': x => { x.payload.transactions[0].currency = 'usd'; },
  'missing units': x => { delete x.payload.transactions[0].currency; },
  'fractional cents': x => { x.payload.transactions[0].amount = 49.371; },
  'refund direction': x => { x.payload.transactions[0].amount = -49.37; },
  'refund payee': x => { x.payload.transactions[0].payee = 'CAN TIRE MC REFUND'; },
  'unrelated merchant': x => { x.payload.transactions[0].payee = 'Invented shopping'; },
  'split child': x => { x.payload.transactions[0].parent_id = 999; },
  'group transaction': x => { x.payload.transactions[0].is_group = true; },
  'conflicting evidence': x => { x.payload.transactions[0].contradictoryEvidence = true; },
  'future posting': x => { x.payload.transactions[0].date = '2035-10-09'; },
  'before statement creation': x => { x.payload.transactions[0].date = '2035-09-10'; x.payload.transactionWindow.startDate = '2035-09-01'; },
  'incomplete posted window': x => { x.payload.transactionWindow.complete = false; },
  'incomplete pending universe': x => { x.payload.pendingCoverage.complete = false; },
  'reused stable debit': x => { x.payload.transactions.push(clone(x.payload.transactions[0])); },
  'two payments one cycle': x => { x.payload.transactions.push({ ...x.payload.transactions[0], id: 98002 }); },
  'two obligations one card': x => { x.data.plan.obligations.push({ ...clone(x.data.plan.obligations[0]), id: 'triangle-twin' }); x.identity = clone(x.identity); x.identity.rules.push(...x.identity.rules.filter(r => r.eventId === 'triangle').map(r => ({ ...r, eventId: 'triangle-twin' }))); },
  'posted reversal': x => { x.payload.transactions.push({ ...x.payload.transactions[0], id: 98003, amount: -49.37, date: NOW }); },
  'card payment reversal': x => { x.payload.transactions.push({ id: 98003, account_id: 3004, date: NOW, amount: 49.37, currency: 'cad', payee: 'PAYMENT REVERSAL', is_pending: false }); },
  'owner-allocated purchase backfill': x => { const tx = O.normalizeLunchMoneyTransaction(x.payload.transactions[0]);
    x.data.plan.cardPurchaseCoverage = { payments: [{ confirmed: true, debitRef: O.cardCoverageReference(tx) }] }; },
};
for (const [name, mutate] of Object.entries(negatives)) check(name, () => { const x = fixture(); mutate(x); zero(x); });

for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf',
  'Credit card payment', 'Payment, Transfer', 'Unknown minimum label', 'Minimum payment - Unknown card'])
  check(`unapproved category cannot confirm or shield a reversal: ${name}`, () => {
    assert.equal(Category.categoryDebt({ name, isIncome: false, isGroup: false, archived: false,
      excludeFromBudget: true, excludeFromTotals: true }), null);
    const unapproved = fixture(); unapproved.payload.categories[0].name = name; zero(unapproved);
    const x = fixture();
    x.payload.categories.push({ id: 9002, name, is_income: false, is_group: false,
      exclude_from_totals: true, exclude_from_budget: true });
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 98003, date: NOW,
      amount: -49.37, payee: 'CAN TIRE MC PAYMENT REVERSAL', category_id: 9002 });
    x.payload.accounts[0].balance = 1000; x.payload.accounts[3].balance = 800;
    const live = Live.fromObservation(x), plan = live.data.plan;
    assert.equal(live.report.cardMinimumCategoryEvidence.payments.length, 0);
    assert.equal(F.representedOccurrence(plan, 'triangle', ORIGINAL, NOW), false);
    const advice = F.recommend(plan, NOW, { debts: live.data.debts,
      currentPeriodActuals: live.report.currentPeriodActuals });
    const bill = advice.defaultView.bills.find(b => b.id === 'triangle' && b.date === DUE);
    assert.ok(bill); assert.notEqual(bill.status, 'PAID'); assert.equal(bill.remaining, 43.19);
    assert.equal(headerActual(live, bill), 0, 'reversal-withdrawn category proof cannot become header money sent');
  });

for (const payee of ['CAN TIRE MC PAYMENT REVERSAL', 'CAN TIRE MC REVERSAL'])
  check(`posted funding reversal in generic category: ${payee}`, () => {
    const x = fixture();
    x.payload.categories.push({ id: 9002, name: 'Credit card payment', is_income: false,
      is_group: false, exclude_from_totals: true, exclude_from_budget: true });
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 98003, date: NOW,
      amount: -49.37, payee, category_id: 9002 });
    x.payload.accounts[0].balance = 1000; x.payload.accounts[3].balance = 800;
    const live = Live.fromObservation(x), plan = live.data.plan;
    assert.equal(live.report.cardMinimumCategoryEvidence.payments.length, 0);
    assert.equal(F.representedOccurrence(plan, 'triangle', ORIGINAL, NOW), false);
    const advice = F.recommend(plan, NOW, { debts: live.data.debts,
      currentPeriodActuals: live.report.currentPeriodActuals });
    const bill = advice.defaultView.bills.find(b => b.id === 'triangle' && b.date === DUE);
    assert.ok(bill); assert.notEqual(bill.status, 'PAID'); assert.equal(bill.remaining, 43.19);
    assert.equal(headerActual(live, bill), 0, 'generic-category funding reversal withdraws derived header proof');
    assert.equal(F.startingCashAmount(plan), 1000); assert.equal(live.data.debts[0].balance, 800);
  });
check('equal credit alone and unrelated reversal cannot withdraw minimum proof', () => {
  for (const payee of ['Invented grocery refund', 'UNRELATED CARD PAYMENT REVERSAL']) {
    const x = fixture();
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 98003, date: NOW,
      amount: -49.37, payee, category_id: null,
      account_id: payee.includes('UNRELATED') ? 3002 : 3001 });
    assert.equal(packet(x).payments.length, 1);
  }
});
check('funding reversal uses incumbent card aliases including excluded TD reversal text', () => {
  for (const card of Object.values(Category.CATEGORIES)) {
    const x = fixture(card);
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 98003, date: NOW,
      amount: -12.19, payee: x.payload.transactions[0].payee + ' REVERSAL', category_id: null });
    // Identity, rather than equal amounts or a confirming reversal category,
    // makes unresolved returned-payment evidence withhold derived proof.
    assert.equal(packet(x).payments.length, 0);
  }
});
for (const [card, otherCard] of [['tdcc', 'travelvisa'], ['cashback', 'tdcc'], ['travelvisa', 'cashback']])
  check(`explicit other-card return preserves confirmation: ${card}/${otherCard}`, () => {
    const x = fixture(card), name = Object.keys(Category.CATEGORIES).find(k => Category.CATEGORIES[k] === otherCard);
    x.payload.categories.push({ id: 9002, name, is_income: false, is_group: false,
      exclude_from_totals: true, exclude_from_budget: true });
    x.data.debts.push({ ...clone(x.data.debts[0]), id: otherCard, balance: 200 });
    x.accountMap.mappings.push({ providerAccountId: '3005',
      canonical: { collection: 'debts', id: otherCard }, atlasRole: 'revolving-credit' });
    x.payload.accounts.push({ ...clone(x.payload.accounts[3]), id: 3005, balance: 212.19 });
    x.payload.accounts[0].balance = 962.82;
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 98003, date: NOW,
      amount: -12.19, payee: 'TFR-TO C/C REVERSAL', category_id: 9002 },
      { ...x.payload.transactions[0], id: 98004, date: NOW, account_id: 3005,
        amount: 12.19, payee: 'PAYMENT REVERSAL', category_id: 9002 });
    // Independently balanced stocks: 1000 - 49.37 + 12.19 = 962.82;
    // target debt 800 - 49.37 = 750.63; other debt 200 + 12.19 = 212.19.
    const live = Live.fromObservation(x), plan = live.data.plan;
    assert.equal(live.report.cardMinimumCategoryEvidence.payments.length, 1);
    assert.equal(F.representedOccurrence(plan, x.eventId, ORIGINAL, NOW), true);
    const advice = F.recommend(plan, NOW, { debts: live.data.debts,
      currentPeriodActuals: live.report.currentPeriodActuals });
    const bill = advice.defaultView.bills.find(b => b.id === x.eventId && b.date === DUE);
    assert.ok(bill); assert.equal(bill.status, 'PAID'); assert.equal(bill.remaining, 0);
    assert.equal(F.startingCashAmount(plan), 962.82);
    assert.equal(F.simulate(plan, NOW, { horizonDays: 5, weeklyVariable: 0 }).ending, 962.82);
    assert.equal(live.data.debts.find(d => d.id === card).balance, 750.63);
    assert.equal(live.data.debts.find(d => d.id === otherCard).balance, 212.19);
  });
check('pending reversal leaves posted evidence while independent owner receipt survives reversal', () => {
  const x = fixture();
  x.payload.transactions.push({ ...x.payload.transactions[0], id: 98003, date: NOW,
    amount: -49.37, payee: 'CAN TIRE MC REVERSAL', category_id: null, is_pending: true });
  assert.equal(packet(x).payments.length, 1);
  x.payload.transactions[1].is_pending = false;
  const row = x.data.plan.obligations[0];
  row.sentPayments = [{ scheduledDate: ORIGINAL, confirmed: true, intent: 'minimum',
    debitId: 'independent-owner', postedOn: '2035-10-05', amount: 49.37, currency: 'cad',
    fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: NOW }];
  x.data.plan.opening.representedEvents = [{ id: 'triangle', date: ORIGINAL, effectiveAsOf: NOW }];
  const live = Live.fromObservation(x);
  assert.equal(live.report.cardMinimumCategoryEvidence.payments.length, 0);
  assert.equal(F.representedOccurrence(live.data.plan, 'triangle', ORIGINAL, NOW), true);
  assert.equal(payment(live).payments[0].issuerMinimumStatus, 'satisfied');
});
check('owner-allocated stable debit cannot manufacture another cycle or obligation receipt', () => {
  for (const otherObligation of [false, true]) for (const namespace of ['protocol-hash', 'human-label', 'linked-human-label']) {
    const x = fixture(), row = x.data.plan.obligations[0];
    const prior = '2035-09-07';
    row.firstDue = prior;
    row.statementOccurrences.unshift({ scheduledDate: prior, dueDate: prior,
      minimum: 29.31, currency: 'cad', confidence: 'confirmed' });
    const owner = otherObligation ? { ...clone(row), id: 'triangle-owner' } : row;
    if (otherObligation) x.data.plan.obligations.push(owner);
    owner.sentPayments = [{ scheduledDate: prior, confirmed: true, intent: 'minimum',
      debitId: namespace === 'protocol-hash'
        ? crypto.createHash('sha256').update('lunchmoney-minimum-category:98001').digest('hex')
        : 'triangle-2026-10-bank-sent',
      postedOn: '2035-10-05', amount: 49.37, currency: 'cad', fundingAccountId: 'chequing-a',
      pending: false, cashIncludedAsOf: NOW }];
    if (namespace === 'linked-human-label') owner.sentPayments[0].movementIdentity = {
      source: Category.SOURCE,
      debitId: crypto.createHash('sha256').update('lunchmoney-minimum-category:98001').digest('hex'),
    };
    x.data.plan.opening.representedEvents = [{ id: owner.id, date: prior, effectiveAsOf: NOW }];
    const live = Live.fromObservation(x), plan = live.data.plan;
    assert.equal(live.report.cardMinimumCategoryEvidence.payments.length, 0);
    assert.equal(F.representedOccurrence(plan, 'triangle', ORIGINAL, NOW), false);
    assert.ok(plan.opening.representedEvents.some(p => p.id === owner.id && p.date === prior));
    assert.equal(F.cardMinimumState(plan, NOW).payments.find(p => p.id === owner.id
      && p.scheduledDate === prior)?.issuerMinimumStatus, 'satisfied');
    const advice = F.recommend(plan, NOW, { debts: live.data.debts,
      currentPeriodActuals: live.report.currentPeriodActuals });
    const bill = advice.defaultView.bills.find(b => b.id === 'triangle' && b.date === DUE);
    assert.ok(bill); assert.notEqual(bill.status, 'PAID'); assert.equal(bill.remaining, 43.19);
    // Defense at Forecast's publication boundary, even if an old/forged packet
    // bypasses observation. The original owner's receipt remains authoritative.
    const valid = Live.fromObservation(fixture()).data.plan.cardMinimumCategoryEvidence;
    plan.cardMinimumCategoryEvidence = clone(valid);
    delete plan.cardMinimumCategoryEvidence.payments[0].movementIdentity;
    assert.equal(F.representedOccurrence(plan, 'triangle', ORIGINAL, NOW), false);
    assert.ok(plan.opening.representedEvents.some(p => p.id === owner.id && p.date === prior));
    assert.equal(F.cardMinimumState(plan, NOW).payments.find(p => p.id === owner.id
      && p.scheduledDate === prior)?.issuerMinimumStatus, 'satisfied');
    assert.equal(F.cardMinimumState(plan, NOW).payments.filter(p => p.minimumConfirmationSource === 'household-category').length, 0);
  }
});

check('partial payment and estimated minimum withhold satisfaction', () => {
  for (const estimated of [false, true]) {
    const x = fixture();
    if (estimated) delete x.data.plan.obligations[0].statementOccurrences;
    else x.payload.transactions[0].amount = 18.12;
    const live = Live.fromObservation(x), s = payment(live);
    assert.equal(s.status, 'unavailable'); assert.equal(s.payments.length, 1);
    assert.equal(s.payments[0].additionalCashRequired, null);
    assert.equal(s.payments[0].issuerMinimumStatus, 'unconfirmed');
  }
});
const allocationControls = {
  'human label ambiguous': { accept: false },
  'unknown hash namespace ambiguous': { accept: false, change(x, owner) {
    owner.debitId = crypto.createHash('sha256').update('unrelated-owner-label').digest('hex');
  } },
  'partial sender already owner allocated': { accept: false, change(x, owner) {
    x.payload.transactions[0].amount = owner.amount = 18.12;
  } },
  'malformed explicit namespace is not independence': { accept: false, change(x, owner) {
    owner.movementIdentity = { source: 'owner-note', debitId: 'a'.repeat(64) };
  } },
  'different card is not the same movement': { accept: true, change(x, owner, row) { row.debtId = 'travelvisa'; } },
  'different posted date is not the same sender': { accept: true, change(x, owner) { owner.postedOn = '2035-10-04'; } },
  'different full sent amount is not the same sender': { accept: true, change(x, owner) { owner.amount = 31.17; } },
  'different funding account is not the same sender': { accept: true, change(x, owner) { owner.fundingAccountId = 'chequing-b'; } },
  'two observed senders do not identify an unlinked human label': { accept: false, change(x) {
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 98000, category_id: null });
  } },
  'explicitly linked independent human sender': { accept: true, change(x, owner) {
    owner.movementIdentity = { source: Category.SOURCE,
      debitId: crypto.createHash('sha256').update(Category.SOURCE + ':98000').digest('hex') };
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 98000, category_id: null });
  } },
  'legacy hash verified against a distinct posted sender': { accept: true, needsEvidence: true, change(x, owner) {
    owner.debitId = crypto.createHash('sha256').update(Category.SOURCE + ':98000').digest('hex');
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 98000, category_id: null });
  } },
  'legacy hash with unknown posting state is not independence': { accept: false, change(x, owner) {
    owner.debitId = crypto.createHash('sha256').update(Category.SOURCE + ':98000').digest('hex');
    const old = { ...x.payload.transactions[0], id: 98000, category_id: null };
    delete old.is_pending; x.payload.transactions.push(old);
  } },
  'legacy hash with pending sender is not independence': { accept: false, change(x, owner) {
    owner.debitId = crypto.createHash('sha256').update(Category.SOURCE + ':98000').digest('hex');
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 98000, category_id: null, is_pending: true });
  } },
  'legacy hash with duplicate posted sender is not independence': { accept: false, change(x, owner) {
    owner.debitId = crypto.createHash('sha256').update(Category.SOURCE + ':98000').digest('hex');
    const old = { ...x.payload.transactions[0], id: 98000, category_id: null };
    x.payload.transactions.push(old, clone(old));
  } },
  'duplicate provider sender remains ambiguous': { accept: false, change(x, owner) {
    owner.movementIdentity = { source: Category.SOURCE, debitId: 'a'.repeat(64) };
    x.payload.transactions.push(clone(x.payload.transactions[0]));
  } },
};
for (const [name, control] of Object.entries(allocationControls)) check(`owner namespace: ${name}`, () => {
  const x = fixture(), prior = '2035-09-07';
  const row = { ...clone(x.data.plan.obligations[0]), id: 'prior-owner', firstDue: prior,
    statementOccurrences: [{ scheduledDate: prior, dueDate: prior, minimum: 17.31,
      currency: 'cad', confidence: 'confirmed' }] };
  const owner = { scheduledDate: prior, confirmed: true, intent: 'minimum',
    debitId: 'triangle-2026-10-bank-sent', postedOn: '2035-10-05', amount: 49.37,
    currency: 'cad', fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: NOW };
  row.sentPayments = [owner]; x.data.plan.obligations.push(row);
  x.data.plan.opening.representedEvents = [{ id: row.id, date: prior, effectiveAsOf: NOW }];
  control.change?.(x, owner, row);
  // Source stocks include all observed sends once; no inferred settlement may
  // change those stocks or manufacture another allocation from their values.
  const sent = [...new Map(x.payload.transactions.map(t => [t.id, t])).values()]
    .reduce((sum, t) => sum + t.amount, 0);
  x.payload.accounts[0].balance = 1000 - sent; x.payload.accounts[3].balance = 800 - sent;
  const before = JSON.stringify(x), live = Live.fromObservation(x), plan = live.data.plan;
  assert.equal(JSON.stringify(x), before);
  assert.equal(live.report.cardMinimumCategoryEvidence.payments.length, control.accept ? 1 : 0);
  assert.equal(F.representedOccurrence(plan, 'triangle', ORIGINAL, NOW), control.accept);
  assert.equal(F.startingCashAmount(plan), 1000 - sent); assert.equal(live.data.debts[0].balance, 800 - sent);
  assert.deepEqual(plan.obligations.find(r => r.id === row.id).sentPayments, [owner]);
  assert.ok(plan.opening.representedEvents.some(p => p.id === row.id && p.date === prior));
  const direct = clone(Live.fromObservation(fixture()).data.plan.cardMinimumCategoryEvidence);
  direct.payments[0].amount = x.payload.transactions[0].amount;
  if (control.needsEvidence) direct.payments[0].verifiedIndependentOwnerDebitIds =
    live.report.cardMinimumCategoryEvidence.payments[0].verifiedIndependentOwnerDebitIds;
  plan.cardMinimumCategoryEvidence = direct;
  // Duplicate detection is observation-owned; Forecast independently rejects
  // allocation namespace conflicts before it can publish any receipt.
  if (name !== 'duplicate provider sender remains ambiguous') {
    assert.equal(F.representedOccurrence(plan, 'triangle', ORIGINAL, NOW), control.accept);
    assert.equal(F.cardMinimumState(plan, NOW).payments.some(p => p.minimumConfirmationSource === 'household-category'), control.accept);
    if (control.needsEvidence) {
      delete direct.payments[0].verifiedIndependentOwnerDebitIds;
      assert.equal(F.representedOccurrence(plan, 'triangle', ORIGINAL, NOW), false);
    }
  }
});
check('refresh is idempotent and changed category revokes only derived confirmation', () => {
  const x = fixture(), one = Live.fromObservation(x);
  const two = Live.fromObservation({ ...x, data: one.data });
  assert.deepEqual(payment(one), payment(two));
  assert.equal(F.startingCashAmount(two.data.plan), 950.63); assert.equal(two.data.debts[0].balance, 750.63);
  x.payload.categories[0].name = 'Payment, Transfer';
  const revoked = Live.fromObservation({ ...x, data: two.data });
  assert.equal(payment(revoked).payments.length, 0);
  assert.equal(revoked.data.plan.cardMinimumCategoryEvidence.payments.length, 0);
  assert.equal(F.startingCashAmount(revoked.data.plan), 950.63); assert.equal(revoked.data.debts[0].balance, 750.63);
  assert.deepEqual(revoked.data.plan.opening.representedEvents, []);
});
check('owner confirmation has precedence through category removal', () => {
  const x = fixture(), row = x.data.plan.obligations[0];
  row.sentPayments = [{ scheduledDate: ORIGINAL, confirmed: true, intent: 'minimum', debitId: 'invented-owner',
    postedOn: '2035-10-05', amount: 49.37, currency: 'cad', fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: NOW }];
  x.data.plan.opening.representedEvents = [{ id: 'triangle', date: ORIGINAL, effectiveAsOf: NOW }];
  for (const changed of [false, true]) {
    if (changed) x.payload.categories[0].name = 'Payment, Transfer';
    const live = Live.fromObservation(x);
    assert.equal(payment(live).status, 'ready'); assert.equal(payment(live).payments.length, 1);
    assert.equal(packet(x).payments.length, 0);
  }
});
check('pending replacement requires current posted categorization', () => {
  const x = fixture(), pending = { ...x.payload.transactions[0], is_pending: true };
  x.payload.transactions.push(pending); assert.equal(packet(x).payments.length, 1);
  x.payload.transactions[0].category_id = null; assert.equal(packet(x).payments.length, 0);
});
check('advancing refreshes retain current evidence without claiming future or duplicate expense', () => {
  const x = fixture(); let data = Live.fromObservation(x).data;
  for (const day of ['2035-10-07', '2035-10-08', '2035-10-09']) {
    x.payload.fetchedAt = day + 'T18:00:00Z'; x.payload.transactionWindow.endDate = day;
    x.payload.accounts.forEach(a => { a.updated_at = day + 'T17:00:00Z'; a.balance_last_update = day + 'T17:00:00Z'; });
    const live = Live.fromObservation({ ...x, data }); data = live.data;
    const s = F.cardMinimumState(data.plan, day); assert.equal(s.status, 'ready'); assert.equal(s.payments.length, 1);
    assert.equal(s.payments[0].cashPaid, 49.37); assert.equal(F.startingCashAmount(data.plan), 950.63);
    const advice = F.recommend(data.plan, day, { debts: data.debts, currentPeriodActuals: live.report.currentPeriodActuals });
    assert.equal(advice.defaultView.balanceAfterDeductions, -43.19);
    const row = advice.defaultView.bills.find(b => b.id === 'triangle' && b.date === DUE);
    assert.ok(row); assert.equal(row.status, 'PAID'); assert.equal(row.remaining, 0);
    assert.deepEqual(data.plan.opening.representedEvents, []);
  }
});
check('query and observer preserve canonical file', () => {
  assert.equal(fs.readFileSync(path.join(root, 'data.json'), 'utf8'), disk);
});
check('next pay-period remains Planned with separate early payment evidence', () => {
  const x = fixture(), r = x.data.plan.obligations[0];
  r.day = 17; r.firstDue = '2035-10-17';
  r.statementOccurrences[0].scheduledDate = r.statementOccurrences[0].dueDate = '2035-10-17';
  x.data.debts[0].statementCloseDay = 2;
  const live = Live.fromObservation(x);
  const advice = F.recommend(live.data.plan, NOW, { debts: live.data.debts,
    currentPeriodActuals: live.report.currentPeriodActuals });
  const future = advice.payPeriodViews.find(p => p.bills.some(b => b.id === 'triangle' && b.date === '2035-10-17'));
  assert.ok(future); const row = future.bills.find(b => b.id === 'triangle');
  assert.deepEqual([future.timelineRole, row.status, row.settlement, future.paidBills, row.remaining],
    ['next', 'planned', 'upcoming', 0, 43.19]);
  assert.equal(row.cashPaid, 49.37); assert.equal(row.householdPaymentStatus, 'paid');
});
check('Forecast refuses malformed derived evidence at its publication boundary', () => {
  const x = fixture(), live = Live.fromObservation(x);
  for (const mutate of [p => { p.currency = 'usd'; }, p => { p.pending = true; },
    p => { p.confirmed = false; }, p => { p.fundingAccountId = 'savings'; },
    p => { p.amount = 49.371; }, p => { p.postedOn = '2035-10-09'; }]) {
    const plan = clone(live.data.plan); mutate(plan.cardMinimumCategoryEvidence.payments[0]);
    assert.equal(F.cardMinimumState(plan, NOW).payments.length, 0);
    assert.ok(F.expandEvents(plan, NOW, '2035-10-10').some(e => e.id === 'triangle'));
  }
});
for (const c of cases) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.error ? '\n' + c.error : ''}`);
console.log(`${cases.filter(c => c.pass).length}/${cases.length} category protocol cases passed`);
process.exitCode = cases.every(c => c.pass) ? 0 : 1;
