'use strict';
// Invented payer receipt. A posted $25 Bills debit proved under Credit Card Payment
// keeps Paid back, the minimum tick and still-owed after a category-only edit.
// The ledger note is not the authority: it can vanish, and a never-proved row stays unconfirmed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Memory = require('../scripts/server-observation-memory');
const { world } = require('./fixtures/card-coverage-aggregate-world');
const { loadStackPage } = require('./lib/budget-page-harness');

const DAY = '2026-09-20';
const PRIOR = '2026-09-18';

function ledger(editPayment) {
  const purchase = (amount, id, payee) => ['card', amount, amount === 80 ? PRIOR : DAY, 'purchase', {
    id, payee, original_name: payee,
  }];
  const rows = [
    purchase(80, 101, 'Invented grocer'),
    purchase(37, 103, 'Invented market'),
    ['bills', 25, DAY, 'cash', { id: 104, notes: 'card payment: Travel Visa', original_name: 'TFR-TO C/C' }],
  ];
  return world(rows, { edit(x) {
    x.payload.accounts.forEach(account => { account.last_fetch = DAY + 'T17:00:00Z'; });
    x.payload.pendingCoverage = { ...x.payload.pendingCoverage, truncated: false };
    if (editPayment) editPayment(x.payload.transactions.find(tx => tx.id === 104), x);
  }});
}

function proved(x, proofs) {
  return Live.fromObservation({ ...x, ...(proofs ? { provedPayerReceipts: proofs } : {}) });
}

async function publish(x, proofs) {
  const observed = proved(x, proofs);
  const page = await loadStackPage({ data: observed.data });
  assert.equal(page.status(), 'rendered');
  const ctx = page.context();
  const view = ctx.recommendation.payPeriodViews.find(item => item.start === page.selectedKey());
  const line = view.stackSummary.credit.lines.find(item => item.id === 'travelvisa');
  const water = page.sandbox.StackWaterfall.html(ctx, { creditOpen: true });
  const tile = page.blockHtml('credit');
  const row = tile.split('<li>').find(item => item.includes('data-stack-sheet="card:travelvisa"'));
  const drop = water.split('</li>').find(item => item.includes('data-debt-id="travelvisa"'));
  return { observed, view, line, water, tile, row, drop,
    payer: observed.data.liveOverlay.currentPeriodActuals.transactions.find(tx => tx.amount === 25
      && tx.atlasAccountId === 'chequing-a') };
}

function proofOf(observed) {
  const list = Forecast.nextProvedPayerReceipts(observed.data.liveOverlay.currentPeriodActuals.transactions, []);
  const proof = list.find(item => item.amountCents === 2500 && item.cardId === 'travelvisa');
  assert.ok(proof, 'the posted $25 receipt is proved for Travel Visa');
  assert.match(proof.coverageRef, /^pc-[a-f0-9]{24}$/);
  assert.equal(Object.hasOwn(proof, 'id'), false);
  assert.equal(proof.account, 'chequing-a');
  assert.equal(proof.trust, 'calculated');
  return proof;
}

function assertKeepsPayment(page) {
  assert.equal(page.line.target.amount, 117);
  assert.equal(page.line.paidBack.amount, 25);
  assert.equal(page.line.paidToward.amount, 25);
  assert.equal(page.line.stillToPayBack.amount, 92);
  assert.equal(page.line.minimumCovered.value, true);
  assert.equal(page.row.includes('aria-label="Minimum covered'), true);
  assert.match(page.row, /\$25/);
  assert.ok(page.drop, 'the waterfall lists the card');
  assert.match(page.drop, /data-source="stackSummary\.creditBreakdown\.rows\.\d+\.amount">\$92<\/span>/);
}

test('a proved $25 payment keeps Paid back, the minimum tick and $92 still owed after the category changes', async () => {
  const control = await publish(ledger());
  const proof = proofOf(control.observed);
  assert.equal(control.payer.provedPayerReceipt, undefined);
  assertKeepsPayment(control);
  const edited = await publish(ledger(tx => { tx.category_name = 'Groceries'; }), [proof]);
  assertKeepsPayment(edited);
  assert.equal(edited.payer.categoryLabel, 'Groceries');
  assert.equal(edited.payer.cardPaymentNoteDestination, 'travelvisa');
  assert.equal(edited.payer.provedPayerReceipt.coverageRef, proof.coverageRef);
  assert.equal(edited.view.stackSummary.surplus.amount, control.view.stackSummary.surplus.amount);
  assert.equal(edited.view.stackSummary.surplus.terms.budget, control.view.stackSummary.surplus.terms.budget);
});

test('removing the note after the receipt was proved still counts it', async () => {
  const proof = proofOf(proved(ledger()));
  const kept = await publish(ledger(tx => { tx.notes = null; }), [proof]);
  assertKeepsPayment(kept);
  assert.equal(kept.payer.cardPaymentNoteDestination, undefined);
  assert.equal(kept.payer.categoryLabel, 'Credit Card Payment');
  const both = await publish(ledger(tx => { tx.notes = null; tx.category_name = 'Groceries'; }), [proof]);
  assertKeepsPayment(both);
  assert.equal(both.payer.cardPaymentNoteDestination, undefined);
  assert.equal(both.payer.categoryLabel, 'Groceries');
});

test('a never-proved recategorized row stays unconfirmed, and a provider-supplied list does not count', async () => {
  const proof = proofOf(proved(ledger()));
  const never = await publish(ledger(tx => { tx.category_name = 'Groceries'; }));
  assert.equal(never.line.paidBack.amount, 0);
  assert.equal(never.line.stillToPayBack.amount, 117);
  assert.equal(never.line.minimumCovered.value, false);
  assert.equal(never.row.includes('aria-label="Minimum covered'), false);
  assert.equal(never.payer.cardPaymentNoteDestination, 'travelvisa');
  assert.equal(never.payer.provedPayerReceipt, undefined);
  const injected = ledger(tx => { tx.category_name = 'Groceries'; });
  injected.payload.provedPayerReceipts = [proof];
  const ignored = await publish(injected);
  assert.equal(ignored.line.paidBack.amount, 0);
  assert.equal(ignored.payer.provedPayerReceipt, undefined);
  const moved = await publish(ledger(tx => { tx.category_name = 'Groceries'; tx.amount = 26; }), [proof]);
  const shifted = moved.observed.data.liveOverlay.currentPeriodActuals.transactions.find(tx => tx.amount === 26);
  assert.equal(moved.line.paidBack.amount, 0);
  assert.equal(shifted.provedPayerReceipt, undefined);
});

test('a conflicting second card counts the proved receipt toward nothing', async () => {
  const proof = proofOf(proved(ledger()));
  const page = await publish(ledger(tx => { tx.notes = 'card payment: TD Cash Back Visa'; }), [proof]);
  assert.equal(page.line.paidBack.amount, 0);
  assert.equal(page.view.stackSummary.credit.lines.find(item => item.id === 'cashback').paidBack.amount, 0);
  assert.equal(page.payer.provedPayerReceipt.cardId, 'travelvisa');
  assert.equal(page.line.stillToPayBack.amount, 117);
  assert.equal(page.line.minimumCovered.value, false);
});

test('a reversal still removes the proved payment', async () => {
  const proof = proofOf(proved(ledger()));
  const page = await publish(ledger((tx, source) => {
    tx.category_name = 'Groceries';
    source.payload.transactions.push({ ...tx, id: 109, amount: -25, category_name: 'Credit Card Payment',
      notes: 'card payment: Travel Visa' });
  }), [proof]);
  assert.equal(page.line.paidBack.amount, null);
  assert.equal(page.line.paidBack.trust, 'unavailable');
  assert.ok(page.line.paidBack.reasons.includes('payment-direction-unresolved'));
  assert.equal(page.line.stillToPayBack.amount, null);
  assert.equal(page.line.minimumCovered.value, 'unknown');
});

test('restoring the category return ahead of the proved receipt drops Paid back', async () => {
  const proof = proofOf(proved(ledger()));
  const file = path.join(__dirname, '..', 'public', 'forecast.js');
  const source = fs.readFileSync(file, 'utf8');
  const anchor = '    const proof = provedPayerReceiptMatches(tx);\n    if (proof) {\n      if (provedPayerReceiptDisagrees(tx, proof)) {';
  assert.equal(source.split(anchor).length, 2);
  const read = fs.readFileSync;
  fs.readFileSync = function (target, ...rest) {
    if (path.resolve(String(target)) !== path.resolve(file)) return read.call(this, target, ...rest);
    return source.replace(anchor,
      'if ((!payment && !transfer) || [tx.atlasAccountId, tx.account, tx.accountId].some(isStackCreditLine)) return null;\n    ' + anchor);
  };
  try {
    const page = await publish(ledger(tx => { tx.category_name = 'Groceries'; }), [proof]);
    assert.equal(page.line.paidBack.amount, 0);
    assert.equal(page.line.stillToPayBack.amount, 117);
    assert.equal(page.line.minimumCovered.value, false);
    assert.equal(page.row.includes('aria-label="Minimum covered'), false);
  } finally {
    fs.readFileSync = read;
  }
});

test('observation memory keeps a proved receipt and rejects a note stuffed into one', () => {
  const proof = proofOf(proved(ledger()));
  const x = ledger();
  const payload = { ...x.payload, categories: x.payload.categories || [], tags: x.payload.tags || [],
    provedPayerReceipts: [proof] };
  const projected = Memory.sourceInputs(payload);
  assert.deepEqual(projected.provedPayerReceipts, [proof]);
  const without = { ...x.payload, categories: [], tags: [] };
  assert.equal(Object.hasOwn(Memory.sourceInputs(without), 'provedPayerReceipts'), false);
  assert.throws(() => Memory.sourceInputs({ ...without, provedPayerReceipts: [{ ...proof, notes: 'card payment: Travel Visa' }] }),
    /observation-input-invalid/);
  assert.throws(() => Memory.sourceInputs({ ...without, provedPayerReceipts: [{ ...proof, coverageRef: 'tx-1' }] }),
    /observation-input-invalid/);
  const again = proved(ledger(tx => { tx.category_name = 'Groceries'; tx.notes = null; }), projected.provedPayerReceipts);
  const kept = Forecast.nextProvedPayerReceipts(again.data.liveOverlay.currentPeriodActuals.transactions, projected.provedPayerReceipts);
  assert.equal(kept.find(item => item.amountCents === 2500).cardId, 'travelvisa');
});
