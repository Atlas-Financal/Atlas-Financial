'use strict';
// Display only: the bill detail prints a negative amount with the minus before the dollar
// sign (U+2212, like every other Atlas page), never "$-250.00". Invented amounts; the
// numeric value and its sign are unchanged, and positive, zero and unavailable print as before.
const assert = require('node:assert/strict');
const Detail = require('../public/bill-detail');
const { fixture, cardObservation, publishedRow } = require('./test-bill-detail');
const clone = value => JSON.parse(JSON.stringify(value));
const MINUS = '−';

// A linked credit (negative transaction amount) and a positive debit, zero, and a cent-level credit.
const data = fixture(), row = publishedRow(data);
const printLinked = amount => {
  const signed = clone(data);
  signed.liveOverlay.currentPeriodActuals.transactions[0].amount = amount;
  return Detail.html(row, signed);
};
assert.ok(printLinked(-25.5).includes(`Transaction amount</dt><dd>${MINUS}$25.50 (credit)`), 'negative credit');
assert.ok(printLinked(-1234.5).includes(`${MINUS}$1,234.50 (credit)`), 'thousands separator kept after the sign');
assert.ok(printLinked(25.5).includes('Transaction amount</dt><dd>$25.50 (debit)'), 'positive unchanged');
assert.ok(printLinked(0).includes('Transaction amount</dt><dd>$0.00 (direction unavailable)'), 'zero unchanged');
for (const amount of [-25.5, -1234.5, 25.5, 0]) {
  assert.doesNotMatch(printLinked(amount), /\$-/, `no "$-" for ${amount}`);
}

// Forecast's signed Actual is the same number with the minus moved, not removed.
const card = cardObservation('posted'), cardRow = publishedRow(card);
const output = Detail.html(cardRow, card);
assert.ok(output.includes(`Actual</dt><dd>${MINUS}$250.00`), 'negative Actual keeps its minus, before the dollar sign');
assert.doesNotMatch(output, /\$-/);
assert.equal(Detail.evidence(cardRow, card).payments[0].amount, -250, 'numeric value and sign unchanged');

// Positive Actual unchanged.
assert.ok(Detail.html(row, data).includes('Actual</dt><dd>$97.50'), 'positive Actual unchanged');

// A value that rounds to zero prints unsigned rather than "−$0.00".
assert.ok(printLinked(-0.004).includes('$0.00 ('), 'rounds-to-zero credit prints unsigned');
assert.doesNotMatch(printLinked(-0.004), /\$-|−\$0\.00/);
console.log('PASS bill detail prints a negative amount as −$ (sign before the dollar sign); positive and zero unchanged');
