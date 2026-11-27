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

async function render(rows, { Forecast, kindHint, editObservation, paymentAmount = 25, periodStart } = {}) {
  const x = world([grocery, ...rows, ['bills', paymentAmount, null, 'cash', { notes: 'card payment: Travel Visa' }]], {
    edit(x) {
      x.data.plan.budget.excluded = [{ from: 'Invented business' }];
      for (const account of x.payload.accounts) account.last_fetch = x.asOf + 'T17:00:00Z';
      editObservation?.(x.payload, x.data);
    },
  });
  const { data } = Live.fromObservation(x);
  const { transactions } = data.liveOverlay.currentPeriodActuals;
  if (kindHint) transactions.find(tx => tx.displayedPayee === 'Invented merchant').kindHint = kindHint;
  const page = await loadStackPage({ data, Forecast });
  assert.equal(page.status(), 'rendered');
  if (periodStart) assert.equal(page.selectPeriod(periodStart), periodStart);
  const ctx = page.context();
  const { stackSummary, role } = ctx.recommendation.payPeriodViews.find(view => view.start === page.selectedKey());
  const credit = page.blockHtml('credit');
  const waterfall = page.sandbox.StackWaterfall.html(ctx, { creditOpen: true });
  return {
    summary: stackSummary,
    role,
    transactions,
    line: stackSummary.credit.lines.find(line => line.id === cardId),
    sheet: page.sandbox.StackSheet.html(ctx, `card:${cardId}`),
    credit,
    tile: credit.match(/<li><button[^>]*data-stack-sheet="card:travelvisa"[\s\S]*?<\/li>/)[0],
    waterfall: waterfall.match(/<li[^>]*data-debt-id="travelvisa"[\s\S]*?<\/li>/)?.[0],
  };
}

function assertChargesWithheld({ line, sheet, tile }) {
  assert.equal(line.spent.amount, null);
  assert.equal(line.targetCovered.value, 'unknown');
  assert.equal(line.targetCovered.trust, 'unavailable');
  assert.ok(line.targetCovered.reasons.includes('new-charges-unavailable'));
  assert.doesNotMatch(tile, /stack-credit-x is-good/);
  assert.doesNotMatch(sheet, /<dt>New charges<\/dt>/);
  assert.match(sheet, /<dt>Target<\/dt>/);
}

function assertUnknownRepayment(page) {
  assertChargesWithheld(page);
  assert.equal(page.line.stillToPayBack.amount, null);
  assert.equal(page.line.stillToPayBack.trust, 'unavailable');
  assert.ok(page.line.stillToPayBack.reasons.includes('new-charges-unavailable'));
  assert.match(page.sheet, /Repayment coverage<\/dt><dd[^>]*>Not yet known/);
}

function assertPublishedRemainder(page, amount, displayed) {
  assertChargesWithheld(page);
  assert.equal(page.line.stillToPayBack.amount, amount);
  assert.equal(page.line.stillToPayBack.trust, 'estimated');
  assert.deepEqual(Array.from(page.line.stillToPayBack.reasons), []);
  assert.equal(page.summary.creditBreakdown.rows.find(row => row.debtId === cardId).amount, amount);
  assert.match(page.waterfall, new RegExp(`data-source="stackSummary\\.creditBreakdown\\.rows\\.\\d+\\.amount">\\$${displayed}</span>`));
  assert.doesNotMatch(page.waterfall + page.sheet, /Not yet known|At least|As of/i);
}

function assertPaidMinimum({ summary, line, sheet, tile, credit, waterfall }, paid, target = 25) {
  assert.equal(line.minimumCovered.value, true);
  assert.match(tile, /stack-credit-tick is-on"[^>]*aria-label="Minimum covered"/);
  assert.match(tile, new RegExp(`>\\+\\$${paid}</span><i class="stack-credit-of"> / \\$${target}</i>`));
  assert.match(sheet, /<dt>Minimum<\/dt><dd[^>]*><span[^>]*>\$25<\/span> <span[^>]*>✓<\/span>/);
  assert.equal(summary.credit.totals.minimumsDueCount, 1);
  assert.equal(summary.credit.totals.minimumsCoveredCount, 1);
  // OD-052 (BUILD 7): the head and its bar are total paid back over total target, here this card's (the only one with
  // something to pay back): full only when the target is paid back, not when the minimum is.
  const { paidBack, target: total } = summary.credit.totals;
  assert.equal(Math.round(paidBack.amount), paid);
  assert.equal(Math.round(total.amount), target);
  assert.equal(total.amount, line.target.amount, 'the head target is this card\'s target');
  assert.match(credit, new RegExp(`data-stack-credit-total><span class="stack-credit-x[^"]*">\\$${paid}</span><i> / \\$${target}</i>`));
  assert.match(credit, new RegExp(`stack-credit-bar"[^>]*><i style="width:${(Math.min(1, paidBack.amount / total.amount) * 100).toFixed(1)}%">`));
  assert.match(waterfall, /aria-label="Minimum paid">✓<\/span>/);
}

function assertUnknownRemainderWithPaidMinimum({ summary, waterfall }) {
  assert.equal(summary.creditBreakdown.rows.find(row => row.debtId === cardId).amount, null);
  assert.match(waterfall, /Not yet known<br><span class="wf-check"[^>]*aria-label="Minimum paid">✓<\/span> <span[^>]*>Minimum paid<\/span>/);
  assert.doesNotMatch(waterfall, /\$0\b/);
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
  assertCharge(await render([candidate(null)]));
  assertCharge(await render([candidate('Invented business')]), false);
  assertCharge(await render([candidate('Invented unmapped category')]));

  // The served packet still has both IDs. Forecast's existing pairing removes
  // the pending copy from Spent and the Other spending hold.
  const pending = candidate(null, { is_pending: true });
  const pendingOnly = await render([pending]);
  assertCharge(pendingOnly);
  assert.ok(pendingOnly.line.spent.reasons.includes('includes-pending'));
  const pair = await render([pending, candidate(null)]);
  const copies = pair.transactions.filter(tx => tx.displayedPayee === 'Invented merchant');
  assert.equal(new Set(copies.map(tx => tx.id)).size, 2, 'both distinct provider IDs reach Forecast');
  assert.equal(copies.filter(tx => tx.pending).length, 1);
  assertCharge(pair);
  assert.ok(!pair.line.spent.reasons.includes('includes-pending'), 'the pending copy adds nothing');

  // A native payment receipt is a credit and stays out of new charges.
  const payment = await render([candidate(null), ['card', -25, null, 'credit', { kind: 'payment' }]]);
  assertCharge(payment);
  assert.equal(payment.line.paid.amount, 25);
  // An unidentified credit retains the existing fail-closed refund treatment.
  const refund = await render([candidate(null), ['card', -12, null, 'refund', { kind: 'refund' }]]);
  assert.equal(refund.line.spent.amount, null);
  assert.ok(refund.line.spent.reasons.includes('card-credit-purpose-unconfirmed'));
  assertUnknownRepayment(refund);

  for (const [scenario, reason, editObservation] of [
    ['stale coverage', 'posted-coverage-incomplete', payload => {
      payload.transactionWindow.endDate = '2026-09-19';
      payload.transactions.forEach(tx => { tx.date = '2026-09-19'; });
      payload.accounts[3].last_fetch = '2026-09-19T17:00:00Z';
    }],
    ['manual balance update', 'account-transaction-evidence-unavailable', payload => {
      // A fresh balance date alone provides no evidence that the ledger synced.
      delete payload.accounts[3].last_fetch;
    }],
  ]) {
    const page = await render([candidate(null)], { editObservation });
    const { line, tile } = page;
    assert.equal(line.spent.amount, null, scenario);
    assert.equal(line.spent.trust, 'unavailable', scenario);
    assert.ok(line.spent.reasons.includes(reason), `${scenario}: ${line.spent.reasons.join(', ')}`);
    assertUnknownRepayment(page);
    if (scenario === 'manual balance update') {
      assert.equal(line.paidBack.amount, 25, 'the Bills payment remains visible');
      assertPaidMinimum(page, 25);
      assertUnknownRemainderWithPaidMinimum(page);
    } else {
      assert.doesNotMatch(tile, /stack-credit-tick is-on/, 'the stale coverage leaves the payment unconfirmed too');
    }
  }

  for (const [row, options] of [
    [candidate('Transfer')],
    [candidate(null), { kindHint: 'refund' }],
    [candidate(null, { is_income: true })],
  ]) {
    const page = await render([row], options);
    const { line } = page;
    assert.equal(line.spent.amount, null);
    assert.ok(line.spent.reasons.includes('card-movement-unconfirmed'));
    assert.equal(line.paidBack.amount, 25);
    assert.equal(line.target.amount, 25, 'the known lower bound is still available');
    assert.equal(line.target.newCharges, null);
    assertUnknownRepayment(page);
    assertPaidMinimum(page, 25);
    assertUnknownRemainderWithPaidMinimum(page);
  }

  function useOverLimitCard(payload, data) {
    payload.accounts[3].credit_limit = 400;
    data.debts.find(debt => debt.id === cardId).limit = 400;
  }
  const aboveMinimum = await render([candidate('Transfer')], { paymentAmount: 41, editObservation: useOverLimitCard });
  assert.equal(aboveMinimum.line.target.amount, 117, 'the over-limit lower bound stays available to Forecast');
  assertPublishedRemainder(aboveMinimum, 76, 76);
  assertPaidMinimum(aboveMinimum, 41, 117);
  assert.match(aboveMinimum.sheet, /<dt>Target<\/dt><dd[^>]*><span[^>]*>\$117<\/span>/);
  const shownTarget = Number(aboveMinimum.tile.match(/<i class="stack-credit-of"> \/ \$(\d+)<\/i>/)[1]);
  const shownRemainder = Number(aboveMinimum.waterfall.match(/data-source="stackSummary\.creditBreakdown\.rows\.\d+\.amount">\$(\d+)<\/span>/)[1]);
  assert.equal(shownTarget, shownRemainder + aboveMinimum.line.paidBack.amount,
    'the Credit row target uses the same basis as the waterfall remainder on an over-limit card');

  const nearlyCovered = await render([candidate('Transfer')], { paymentAmount: 116.60, editObservation: useOverLimitCard });
  assert.equal(nearlyCovered.line.paidBack.amount, 116.60);
  assertUnknownRepayment(nearlyCovered);
  assertPaidMinimum(nearlyCovered, 117, 117);
  assertUnknownRemainderWithPaidMinimum(nearlyCovered);

  const belowMinimum = await render([candidate('Transfer')], { paymentAmount: 12 });
  assertPublishedRemainder(belowMinimum, 13, 13);
  assert.equal(belowMinimum.line.minimumCovered.value, false);
  assert.doesNotMatch(belowMinimum.tile, /stack-credit-tick is-on/);
  // OD-052 (BUILD 7): the head bar is paid back over target, 12 / 25 by hand, not covered minimums over due ones.
  assert.match(belowMinimum.credit, /data-stack-credit-total><span class="stack-credit-x">\$12<\/span><i> \/ \$25<\/i>/);
  assert.match(belowMinimum.credit, /stack-credit-bar"[^>]*><i style="width:48\.0%">/);
  assert.doesNotMatch(belowMinimum.waterfall, /Minimum paid|\$0\b/);

  const roundsToZero = await render([candidate('Transfer')], { paymentAmount: 24.51 });
  assert.equal(roundsToZero.line.paidBack.amount, 24.51);
  assert.equal(roundsToZero.line.target.amount, 25);
  assertUnknownRepayment(roundsToZero);
  assert.match(roundsToZero.waterfall, /Not yet known/);
  assert.doesNotMatch(roundsToZero.waterfall, /Minimum paid|\$0\b/);
  const halfDollar = await render([candidate('Transfer')], { paymentAmount: 24.50 });
  assertPublishedRemainder(halfDollar, 0.50, 1);

  const periodStart = '2026-10-02';
  const noFutureMinimum = await render([], { periodStart });
  assert.equal(noFutureMinimum.role, 'future');
  assert.equal(noFutureMinimum.line.target.amount, 0);
  assert.ok(noFutureMinimum.line.minimum.reasons.includes('no-minimum-due-in-period'));
  assertUnknownRepayment(noFutureMinimum);
  assert.equal(noFutureMinimum.waterfall, undefined, 'the dropdown omits cards with no scheduled amount');
  assert.doesNotMatch(noFutureMinimum.tile, /stack-credit-tick is-on/);

  const futureMinimum = await render([], { periodStart, editObservation(_payload, data) {
    const [minimum] = data.plan.obligations;
    data.plan.obligations.push({ ...minimum, id: 'invented-future-minimum', date: '2026-10-05', amount: 32 });
  } });
  assert.equal(futureMinimum.role, 'future');
  assert.equal(futureMinimum.line.minimum.amount, 32);
  assertPublishedRemainder(futureMinimum, 32, 32);
  assert.doesNotMatch(futureMinimum.waterfall, /Minimum paid/);
  assert.doesNotMatch(futureMinimum.tile, /stack-credit-tick is-on/);

  const mutant = await render([candidate(null)], { Forecast: withOldChargeWithhold() });
  assert.throws(() => assertCharge(mutant), /the card sheet shows both charges/);
  assert.equal(mutant.line.spent.amount, null);
  assert.equal(mutant.line.target.amount, 25);
  console.log('Stack card charges, deduction, pending replacement, credit rows, coverage and old-withhold mutant passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
