'use strict';
// Invented ledger rows through the served document, Forecast and the Stack renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Live = require('../scripts/live-plan');
const { world } = require('./fixtures/card-coverage-aggregate-world');
const { loadStackPage } = require('./lib/budget-page-harness');

const cardId = 'travelvisa';
const grocery = ['card', 80, null, 'purchase'];
const candidate = (label, extra = {}) => ['card', 37, null, 'purchase', {
  payee: 'Invented merchant', category_name: label, ...extra,
}];

async function render(row, { Forecast, kindHint } = {}) {
  const x = world([grocery, row, ['bills', 25, null, 'cash', { notes: 'card payment: Travel Visa' }]], {
    edit(x) {
      x.data.plan.budget.excluded = [{ from: 'Invented business' }];
      for (const account of x.payload.accounts) account.last_fetch = x.asOf + 'T17:00:00Z';
    },
  });
  const { data } = Live.fromObservation(x);
  if (kindHint) data.liveOverlay.currentPeriodActuals.transactions
    .find(tx => tx.displayedPayee === 'Invented merchant').kindHint = kindHint;
  const page = await loadStackPage({ data, Forecast });
  assert.equal(page.status(), 'rendered');
  const ctx = page.context();
  const { stackSummary } = ctx.recommendation.payPeriodViews.find(view => view.start === page.selectedKey());
  return {
    summary: stackSummary,
    line: stackSummary.credit.lines.find(line => line.id === cardId),
    sheet: page.sandbox.StackSheet.html(ctx, `card:${cardId}`),
    tile: page.blockHtml('credit').match(/<li><button[^>]*data-stack-sheet="card:travelvisa"[\s\S]*?<\/li>/)[0],
  };
}

function assertCharge({ summary, line, sheet, tile }, inOther = true) {
  assert.match(sheet, /<dt>New charges<\/dt><dd[^>]*><span[^>]*>\$117<\/span>/, 'the card sheet shows both charges');
  assert.match(tile, /class="stack-credit-of"> \/ \$117<\/i>/, 'the card row shows the full target');
  assert.equal(line.spent.amount, 117);
  assert.equal(line.spent.trust, 'estimated');
  assert.ok(line.spent.reasons.includes('charge-category-unconfirmed'));
  assert.equal(line.target.amount, 117);
  assert.equal(line.target.trust, 'estimated');
  assert.ok(line.target.reasons.includes('charge-category-unconfirmed'));
  assert.equal(line.paidBack.amount, 25);
  assert.equal(line.targetCovered.value, false);
  assert.doesNotMatch(tile, /stack-credit-x is-good/);
  // By hand: the $80 groceries are in the $150 grocery hold. The $37 is
  // held once in Other for unassigned purchases or once in Credit for business.
  assert.equal(line.deduction.alreadyCounted, inOther ? 117 : 80);
  assert.equal(line.deduction.countedOffset, inOther ? 117 : 80);
  assert.equal(line.deduction.beyondNetted, 0);
  assert.equal(line.deduction.amount, inOther ? 0 : 37);
  assert.equal(summary.surplus.terms.credit, inOther ? 0 : 37);
  assert.equal(summary.surplus.terms.household, inOther ? 187 : 150);
  assert.equal(summary.surplus.amount, 813, 'invented income $1,000 less the $150 grocery hold and one $37 charge');
}

function withOldChargeWithhold() {
  const read = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  const context = vm.createContext({ console });
  context.window = context;
  vm.runInContext(read('display-name.js'), context);
  const source = read('forecast-card-period.js');
  const mutant = source.replace('if (row.chargeCategoryUnconfirmed) {', 'if (false) {');
  assert.notEqual(mutant, source, 'the mutant removes estimated charges from Spent');
  vm.runInContext(mutant, context);
  vm.runInContext(read('forecast.js'), context);
  return context.Forecast;
}

(async () => {
  assertCharge(await render(candidate(null)));
  assertCharge(await render(candidate('Invented business')), false);
  assertCharge(await render(candidate('Invented unmapped category')));

  for (const [row, options] of [
    [candidate('Transfer')],
    [candidate(null), { kindHint: 'refund' }],
    [candidate(null, { is_income: true })],
  ]) {
    const { line, sheet, tile } = await render(row, options);
    assert.equal(line.spent.amount, null);
    assert.ok(line.spent.reasons.includes('card-movement-unconfirmed'));
    assert.equal(line.paidBack.amount, 25);
    assert.equal(line.minimumCovered.value, true);
    assert.equal(line.target.amount, 25, 'the known lower bound is still available');
    assert.equal(line.target.newCharges, null);
    assert.equal(line.targetCovered.value, 'unknown');
    assert.doesNotMatch(tile, /stack-credit-x is-good|stack-credit-tick is-on/);
    assert.match(sheet, /Repayment coverage<\/dt><dd[^>]*>Not yet known/);
  }

  const mutant = await render(candidate(null), { Forecast: withOldChargeWithhold() });
  assert.throws(() => assertCharge(mutant), /the card sheet shows both charges/);
  assert.equal(mutant.line.spent.amount, null);
  assert.equal(mutant.line.target.amount, 25);
  console.log('Stack card charges, deduction, unknown coverage and old-withhold mutant passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
