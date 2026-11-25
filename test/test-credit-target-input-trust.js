'use strict';
// #1607, hunt 3 findings 1–3 and hunt 2 finding 3. Hand-worked targets and remaining repayments
// in one active period, using only invented fixtures. Run with node test/test-credit-target-input-trust.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Forecast = require('../public/forecast');
const { fixture } = require('./fixtures/stack-card-week');

function runCardCase({ id = 'cashback', debt = {}, minimum = 0, payments = false, absent = false,
  payerOnly = false, cardOnly = false, payerUnavailable = false }, engine = Forecast) {
  const x = fixture();
  // The other cards have a proven zero exposure and complete coverage so only the test card
  // can weaken the waterfall. Income is 1000. The payment cases reserve 200 for groceries.
  for (const card of x.debts) Object.assign(card, { balance: 0, limit: 1000, pending: 0, evidenceDate: x.asOf });
  Object.assign(x.debts.find(c => c.id === id), { balance: 800, limit: 700 }, debt);
  x.overlay.overlays = x.debts.map(c => ({ locator: 'debts:' + c.id, field: 'balance',
    proposedValue: c.balance, evidenceDate: c.evidenceDate }));
  for (const account of x.packet.syncEvidence) Object.assign(account, { syncEvidence: 'proven', fields: { last_fetch: true } });
  if (payerUnavailable) x.packet.syncEvidence = x.packet.syncEvidence.filter(account => account.role !== 'household-cash');
  x.plan.opening = { asOf: x.asOf, priorAsOf: '2026-08-13', representedEvents: [{ id: 'payroll', date: x.window.start }] };
  x.plan.income = [{ id: 'payroll', label: 'Invented income', frequency: 'biweekly',
    anchor: x.window.start, amount: 1000, confidence: 'confirmed' }];
  x.packet.representedActuals = [{ id: 'payroll', date: x.window.start, actual: -1000 }];
  x.plan.bills = [];
  x.plan.commitments = [];
  x.plan.budget.categories = payments ? [{ ...x.plan.budget.categories[0], plannedPayday: 200 }] : [];
  x.plan.obligations = minimum ? [{ ...x.plan.obligations[0], debtId: id, amount: minimum }] : [];
  // The fixture links a 250 payer debit to this card; it also records 114.20 in purchases.
  x.packet.transactions = x.packet.transactions.filter(tx => (payments && tx.account === id)
    || ((payerOnly || payments) && tx.id === 'cash-leg-b') || (cardOnly && tx.id === 'cashback-charge'));
  const debts = absent ? x.debts.filter(card => card.id !== id) : x.debts;
  const recommendation = engine.recommend(x.plan, x.asOf, { debts, currentPeriodActuals: x.packet,
    cardLiveOverlay: x.overlay, weeklyVariable: 0 });
  const view = recommendation.payPeriodViews.find(v => v.role === 'active');
  const line = view.stackSummary.credit.lines.find(l => l.id === id);
  const ctx = { recommendation, selectedPeriodKey: view.start, plan: x.plan, Forecast: engine,
    data: { debts, meta: { asOf: x.asOf } } };
  return { id, view, line, ctx, input: x };
}

function loadRenderers(replacements = {}) {
  const win = { URLSearchParams, Intl, location: { search: '?view=classic' },
    document: { addEventListener() {}, getElementById() { return null; } } };
  win.window = win;
  vm.createContext(win);
  const load = name => vm.runInContext(replacements[name] ?? fs.readFileSync(path.join(__dirname, '../public', name + '.js'), 'utf8'), win);
  load('stack-shell');
  const blocks = {};
  win.StackBlocks.register = (name, fn) => { blocks[name] = fn; };
  load('stack-credit');
  load('stack-sheet');
  load('stack-waterfall');
  return { blocks, sheet: win.StackSheet };
}
const renderers = loadRenderers();
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function rowWith(html, attribute) {
  return (html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) || []).find(row => row.includes(attribute)) || '';
}

// Each expected amount is independent of Forecast's implementation. With 300 known pending, 800 + 300 − 700
// leaves 400 to repay. With 600 pending on the card that received 250, 2264.20 + 600 − 2500 leaves 364.20
// over limit; 114.20 remains to pay back. Its 114.20 purchase is already counted above the Credit line.
const paymentWorld = { payments: true, debt: { balance: 2264.20, limit: 2500 } };
const cases = {
  'unknown-pending': { ...paymentWorld, debt: { ...paymentWorld.debt, pending: null, pendingUnknown: true },
    target: 114.20, over: null, reason: 'over-limit-unknown', credit: 0 },
  'pending-minimum-partial': { payments: true, minimum: 300, debt: { balance: 2914.20, limit: 2500, pending: null, pendingUnknown: true },
    target: 414.20, over: 414.20, reason: 'over-limit-pending-unknown', credit: 300, minimumOwed: 50 },
  'stale-minimum-met': { payments: true, minimum: 200, debt: { balance: 4000, limit: 3700, evidenceDate: '2026-08-18' },
    target: 300, over: 300, reason: 'over-limit-balance-estimated', credit: 185.80, minimumOwed: 0 },
  'missing-limit-minimum': { payments: true, minimum: 75, debt: { balance: 500, limit: null },
    target: 114.20, over: null, reason: 'over-limit-unknown', credit: 0, minimumOwed: 0 },
  'unavailable-minimum': { payments: true, minimum: 'unqualified', debt: { limit: null }, chargesUnpublished: true,
    target: null, over: null, reason: 'minimum-unavailable', credit: null, minimumOwed: null },
  'unavailable-payer-minimum': { payerUnavailable: true, minimum: 40, debt: { limit: null },
    target: 40, over: null, reason: 'over-limit-unknown', credit: 40, minimumOwed: 40, upperBound: true },
  'manual-unobserved-minimum': { id: 'mbna', payerUnavailable: true, countedZero: true, minimum: 65, debt: { limit: null },
    target: 65, over: null, reason: 'over-limit-unknown', credit: 65, minimumOwed: 65, upperBound: true },
  'resolved-minimum-control': { payments: true, minimum: 300, debt: { balance: 2914.20, limit: 2500 },
    target: 414.20, over: 414.20, still: 164.20, credit: 300, targetTrust: 'estimated', creditTrust: 'estimated' },
  'pending-bound': { debt: { pending: null, pendingUnknown: true }, target: 100, over: 100, reason: 'over-limit-pending-unknown', credit: 100 },
  // The same observed 800 balance and 700 limit deduct 100 in each case. Only the fresh control
  // establishes today's overage; older and estimated observations leave repayment progress open.
  'fresh-observed-overage': { target: 100, over: 100, still: 100, credit: 100 },
  'stale-balance': { debt: { evidenceDate: '2026-08-18' }, target: 100, over: 100, reason: 'over-limit-balance-estimated', credit: 100 },
  'statement-stale-overage': { debt: { statementCloseDay: 18, balanceAsOf: '2026-07-01', evidenceDate: '2026-07-01' },
    target: 100, over: 100, reason: 'over-limit-balance-estimated', credit: 100 },
  'estimated-balance': { debt: { balanceTrust: 'estimated' }, target: 100, over: 100, reason: 'over-limit-balance-estimated', credit: 100 },
  'stale-zero-overage': { debt: { balance: 700, evidenceDate: '2026-08-18' }, target: 0, over: null, reason: 'over-limit-balance-estimated', credit: 0 },
  // A 250 named debit exceeds the observed 150 overage. Only a current balance can give credit
  // for reaching the target. In both cases the waterfall deducts 150 less 114.20 of charges.
  'stale-overage-paid': { payments: true, debt: { balance: 2650, limit: 2500, evidenceDate: '2026-08-18' },
    target: 150, over: 150, reason: 'over-limit-balance-estimated', credit: 35.80 },
  'fresh-overage-paid': { payments: true, debt: { balance: 2650, limit: 2500 },
    target: 150, over: 150, still: 0, covered: true, credit: 35.80, targetTrust: 'estimated', creditTrust: 'estimated' },
  'missing-balance': { ...paymentWorld, debt: { ...paymentWorld.debt, balance: null }, minimum: 40, chargesUnpublished: true,
    target: 40, over: null, reason: 'over-limit-unknown', credit: 40 },
  'absent-with-activity': { ...paymentWorld, absent: true, minimum: 40, chargesUnpublished: true,
    target: 40, over: null, reason: 'over-limit-unknown', credit: 40 },
  'card-only': { absent: true, cardOnly: true, chargesUnpublished: true,
    target: 0, over: null, reason: 'over-limit-unknown', credit: 0 },
  'payer-only': { absent: true, payerOnly: true, chargesUnpublished: true,
    target: 0, over: null, reason: 'over-limit-unknown', credit: 0 },
  'unheld-control': { absent: true, chargesUnpublished: true, target: 0, over: 0, still: 0, credit: 0,
    targetTrust: 'estimated', creditTrust: 'estimated', surplusTrust: 'calculated' },
  'stale-with-minimum': { debt: { evidenceDate: '2026-08-18' }, minimum: 140,
    target: 140, over: 100, reason: 'over-limit-balance-estimated', credit: 140 },
  'util-stale': { debt: { statementCloseDay: 18, balanceAsOf: '2026-07-01' },
    target: 100, over: 100, reason: 'over-limit-balance-estimated', credit: 100 },
  // This held manual card has no scheduled minimum. Its dropdown reports the known zero
  // minimum remaining even though the target, Credit deduction and Surplus are estimated.
  'zero-pending-bound': { id: 'mbna', debt: { balance: 100, pending: null, pendingUnknown: true },
    target: 0, over: null, reason: 'over-limit-unknown', credit: 0 },
  'unknown-limit': { debt: { limit: null }, minimum: 40, target: 40, over: null, reason: 'over-limit-unknown', credit: 40 },
  'known-control': { debt: { pending: 300 }, target: 400, over: 400, still: 400, credit: 400 },
  'zero-control': { debt: { limit: 1000 }, target: 0, over: 0, still: 0, credit: 0 },
  'covered-control': { ...paymentWorld, debt: { ...paymentWorld.debt, limit: 4000 }, target: 114.20,
    over: 0, still: 0, covered: true, credit: 0 },
  'positive-pending-control': { ...paymentWorld, debt: { ...paymentWorld.debt, pending: 600 },
    target: 364.20, over: 364.20, still: 114.20, credit: 250, targetTrust: 'estimated', creditTrust: 'estimated' },
};

function verifyCase(name, engine = Forecast, ui = renderers) {
  const c = cases[name];
  assert.ok(c, 'unknown case ' + name);
  const { id, view, line, ctx, input } = runCardCase(c, engine);
  const { creditBreakdown, surplus } = view.stackSummary;
  const targetTrust = c.target === null ? 'unavailable' : c.reason ? 'estimated' : c.targetTrust || 'calculated';
  const creditTrust = c.reason ? 'estimated' : c.creditTrust || 'calculated';
  assert.deepEqual([line.target.amount, line.target.overLimitBy, line.target.trust], [c.target, c.over, targetTrust], name + ' target');
  const household = c.payments ? 200 : c.cardOnly ? 114.20 : 0;
  if (c.credit === null) {
    assert.deepEqual([creditBreakdown, surplus.amount, surplus.terms, surplus.trust],
      [null, null, null, 'unavailable'], name + ' waterfall deductions and Surplus');
  } else {
    assert.deepEqual([creditBreakdown.total, creditBreakdown.trust, surplus.amount, surplus.trust],
      [c.credit, creditTrust, 1000 - household - c.credit, c.surplusTrust || creditTrust], name + ' waterfall deductions and Surplus');
  }

  if (['util-stale', 'absent-with-activity', 'zero-pending-bound'].includes(name)) {
    const pub = engine.cardPeriodMovements(input.plan, input.debts, input.asOf, input.window,
      { currentPeriodActuals: input.packet, liveOverlay: input.overlay });
    if (name === 'util-stale') {
      // The snapshot is fresh and the facility balance predates the cycle.
      const direct = engine.stackCreditLines(pub, view.stackSummary.bills, { debts: input.debts, plan: input.plan });
      const card = direct.lines.find(l => l.id === id);
      assert.deepEqual([card.balance.trust, card.target.trust, card.target.overLimitBy, card.stillToPayBack.amount],
        ['calculated', 'estimated', 100, 0], name + ' target (utilisation only)');
    } else if (name === 'zero-pending-bound') {
      const unassigned = { ...pub, unconfirmedPayments: [{ amount: 42, date: input.asOf }] };
      const direct = engine.stackCreditLines(unassigned, view.stackSummary.bills, { debts: input.debts, plan: input.plan });
      const card = direct.lines.find(l => l.id === id);
      assert.ok(card.paidBack.reasons.includes('card-payment-destination-unconfirmed'), name + ' qualifies unassigned');
    } else {
      // A caller can supply an empty roster or omit facilities. Neither proves a zero over-limit term
      // for a card that the movement publication actually saw. Its known charges still set a floor.
      for (const facilities of [{ debts: [], plan: input.plan }, undefined]) {
        const direct = engine.stackCreditLines(pub, view.stackSummary.bills, facilities);
        const card = direct.lines.find(l => l.id === id);
        assert.deepEqual([card.balance.amount, card.paidBack.amount, card.target.newCharges, card.target.minimum],
          [2264.20, 250, 114.20, 40], name + ' direct evidence');
        assert.deepEqual([card.target.trust, card.target.amount, card.target.overLimitBy, card.targetCovered.value, card.stillToPayBack.amount],
          ['estimated', 114.20, null, 'unknown', 0], name + ' target (direct missing facilities)');
      }
    }
  }

  const credit = {}, waterfall = {};
  ui.blocks.credit(credit, ctx);
  ui.blocks.waterfall(waterfall, ctx);
  const row = rowWith(credit.innerHTML, 'data-stack-sheet="card:' + id + '"');
  const sheet = ui.sheet.html(ctx, 'card:' + id);
  const dropdown = rowWith(waterfall.innerHTML, 'data-debt-id="' + id + '"');
  assert.ok(row, name + ' has a card row');
  assert.ok(sheet, name + ' has a sheet');
  const paid = c.payerUnavailable && !c.countedZero ? null : c.payments || c.payerOnly ? 250 : 0;
  assert.equal(line.paidBack.amount, paid, name + ' named repayment');
  if (c.countedZero) assert.ok(line.paidBack.reasons.includes('paid-unavailable-counted-as-zero'), name + ' keeps the manual paid figure');
  assert.equal(line.target.newCharges, c.chargesUnpublished ? null : c.payments ? 114.20 : 0, name + ' posted charges');
  const printed = amount => amount === null ? '—' : '$' + Math.round(amount);
  assert.ok(text(sheet).includes('Target ' + printed(c.target)), name + ' sheet prints the target');
  if (c.over > 0) assert.ok(text(sheet).includes('Over the limit by $' + Math.round(c.over)), name + ' sheet prints positive over-limit');
  else assert.doesNotMatch(text(sheet), /Over the limit by/, name + ' sheet omits absent or zero over-limit');

  if (c.reason) {
    assert.ok(line.target.reasons.includes(c.reason), name + ' explains its uncertainty');
    assert.deepEqual([line.targetCovered.value, line.targetCovered.trust], ['unknown', 'unavailable'], name + ' withholds repayment progress');
    assert.ok(line.targetCovered.reasons.includes(c.reason), name + ' explains withheld progress');
    assert.doesNotMatch(row + sheet, /is-good/, name + ' prints no green target');
    const minimum = c.target === null ? null : c.minimum || 0;
    const owed = Object.hasOwn(c, 'minimumOwed') ? c.minimumOwed : c.payments ? 0 : minimum;
    const still = line.stillToPayBack;
    assert.deepEqual([still.basis, still.amount], ['minimum', owed], name + ' publishes minimum remaining');
    assert.equal(still.trust, owed === null || paid === null ? 'unavailable' : 'estimated', name + ' publishes minimum remaining trust');
    assert.equal(still.upperBound === true, c.upperBound === true, name + ' qualifies unknown payment');
    if (c.upperBound) assert.equal(line.minimumCovered.value, 'unknown', name + ' withholds unknown minimum check');
    assert.equal(row.includes('aria-label="Minimum covered'), minimum > 0 && owed === 0, name + ' minimum check');
    const rowText = text(row);
    const pair = (paid > 0 ? '+' : '') + printed(paid) + ' / ' + printed(minimum);
    assert.ok(/paid back \/ minimum payment/i.test(rowText) && rowText.includes(pair), name + ' row labels its minimum');
    const owedLabel = (c.upperBound ? 'Up to ' : '') + printed(owed);
    assert.ok(text(sheet).includes('Minimum still owed ' + owedLabel), name + ' sheet shows minimum remaining');
    if (creditBreakdown) {
      const breakdownRow = creditBreakdown.rows.find(r => r.debtId === id);
      assert.deepEqual([breakdownRow?.basis, breakdownRow?.amount, breakdownRow?.trust, breakdownRow?.upperBound === true],
        ['minimum', owed, still.trust, c.upperBound === true],
        name + ' dropdown shows minimum remaining publication');
      assert.ok(/minimum still owed/i.test(text(dropdown)) && text(dropdown).includes(owedLabel),
        name + ' dropdown shows minimum remaining');
    } else {
      assert.equal(dropdown, '', name + ' dropdown withholds unavailable breakdown');
    }
  } else {
    assert.deepEqual([line.targetCovered.value, line.stillToPayBack.amount, line.stillToPayBack.trust],
      [!!c.covered, c.still, 'estimated'], name + ' reports repayment progress');
    assert.equal(row.includes('is-good'), !!c.covered, name + ' covered row colour');
    assert.doesNotMatch(text(row), /minimum payment/i, name + ' keeps the resolved target label');
    if (c.target > 0) assert.ok(text(row).includes('/ ' + printed(c.target)), name + ' row prints the target');
    if (c.target > 0) assert.ok(text(dropdown).includes('$' + Math.round(c.still)), name + ' dropdown prints the remainder');
    else assert.equal(dropdown, '', name + ' has no target in the dropdown');
  }
}

function verifyInputTrust(engine = Forecast) {
  for (const name of Object.keys(cases)) verifyCase(name, engine);
}

module.exports = { runCardCase, verifyCase, verifyInputTrust, loadRenderers };
if (require.main === module) {
  verifyInputTrust();
  require('./lib/credit-target-input-mutants')(verifyCase, loadRenderers);
  console.log('Credit target input trust and repayment display passed.');
}
