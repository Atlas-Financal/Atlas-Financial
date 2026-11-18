'use strict';
/* A "card payment: <card>" note may carry a trailing comment (lead, OD-021:
 * Grok Bot's edit tool only appends to notes). After the name, an optional
 * " ...NNNN" and then an optional comment starting " - " or " (" is ignored.
 * Still strict: the name must be an exact table entry (case-insensitive);
 * other words after the name with no separator, a comment naming a different
 * table card, or two segments naming different cards stay 'unknown'.
 *
 * Path case (test/fixtures/card-coverage-aggregate-world.js, invented): Bills
 * 500, Travel Visa debt 400, groceries allowance 150, a 25 card minimum due
 * on the as-of, one 80 card purchase, and a 105 TD "TFR-TO C/C" debit with no
 * card credit yet. Hand arithmetic:
 *   note names Travel Visa: the 105 pays the card (25 minimum, then the 80
 *     purchase): available now 500 - 105 - 70 (groceries left) = 325;
 *   no confirmed destination: the 105 pays nothing, so the 25 minimum and
 *     the 80 purchase are still owed: 395 - 25 - 70 - 80 = 220.
 *
 * `node test/test-card-payment-note-comment.js`
 */
const F = require('../public/forecast.js');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};
const dest = notes => F.cardPaymentNoteDestination({ notes });

console.log('1. The parser');
for (const [note, want, why] of [
  ['card payment: Travel Visa', 'travelvisa', 'exact name'],
  ['card payment: Travel Visa ...0870', 'travelvisa', 'name and ...NNNN'],
  ['card payment: Travel Visa ...0870 - owner decision 2026-11-18', 'travelvisa', '...NNNN then " - " comment'],
  ['card payment: Travel Visa - paid early', 'travelvisa', 'name then " - " comment'],
  ['card payment: Travel Visa (paid from Bills)', 'travelvisa', 'name then " (" comment'],
  ['card payment: Travel Visa ...0870 (owner decision)', 'travelvisa', '...NNNN then " (" comment'],
  ['CARD PAYMENT: td personal credit card - Invented memo', 'tdcc', 'case-insensitive, with a comment'],
  ['card payment: MBNA (Invented memo)', 'mbna', 'a short table name with a comment'],
  ['card payment: Travel Visa - travel visa top-up', 'travelvisa', 'a comment naming the same card'],
  ['card payment: Travel Visa extra', 'unknown', 'other words, no separator'],
  ['card payment: Travel Visa ...0870 extra', 'unknown', 'other words after ...NNNN, no separator'],
  ['card payment: Travel Visa-extra', 'unknown', 'a hyphen with no spaces is no separator'],
  ['card payment: Travel Visa(Invented)', 'unknown', 'a bracket with no space is no separator'],
  ['card payment: Travel Visa -extra', 'unknown', 'a hyphen with no space after it is no separator'],
  ['card payment: Travel Visa (Invented ref XMBNA)', 'travelvisa', 'a card name inside another word is not that card'],
  ['card payment: Travel Visa - not the TD Cash Back Visa', 'unknown', 'a comment naming a different card'],
  ['card payment: TD Cash Back Visa (moved from MBNA)', 'unknown', 'a bracket comment naming a different card'],
  ['card payment: Travel Visa - TD  Cash Back Visa', 'unknown', 'a comment naming a different card with a doubled space'],
  ['card payment: Travel Visa (TD\tCash Back Visa)', 'unknown', 'a comment naming a different card with a tab'],
  ['card payment: Travel  Visa ...0870 - Invented memo', 'travelvisa', 'a doubled space inside the name counts as one'],
  ['card payment: TD Cash Back Visa - card payment: Travel Visa', 'unknown', 'a comment holding a second card note'],
  ['card payment: Travel Visa; card payment: TD Cash Back Visa', 'unknown', 'two segments naming different cards'],
  ['card payment: Travel Visa - Invented\ncard payment: Travel Visa ...0870', 'travelvisa', 'two segments, same card'],
  ['card payment: Invented Card - Invented memo', 'unknown', 'a name outside the table, with a comment'],
  ['card payment: - Invented memo', 'unknown', 'no name before the comment'],
  ['Invented memo - card payment: Travel Visa', null, 'a segment must start with "card payment:"'],
]) ok(dest(note) === want, `${why}: ${JSON.stringify(note)} -> ${want}`, String(dest(note)));

console.log('\n2. The page path: the suffixed note confirms the destination');
{
  const cash = notes => ['bills', 105, null, 'cash', { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C',
    category_name: 'Transfer', ...(notes ? { notes } : {}) }];
  const go = notes => {
    const s = run(world([['card', 80, null, 'purchase'], cash(notes)]));
    const debit = s.packet.transactions.find(t => t.amount === 105);
    return { s, stamp: debit.cardPaymentNoteDestination, available: s.period.fromTodayFunding.availableNow,
      leaked: JSON.stringify(s.packet).includes('owner decision') };
  };
  const plain = go('card payment: Travel Visa ...0870');
  const suffixed = go('card payment: Travel Visa ...0870 - owner decision 2026-11-18');
  const none = go(null), other = go('card payment: Travel Visa - not the TD Cash Back Visa');
  ok(plain.stamp === 'travelvisa' && plain.available === 325, 'control: the plain note pays the card, available now 325',
    JSON.stringify({ stamp: plain.stamp, available: plain.available }));
  ok(suffixed.stamp === 'travelvisa', 'the suffixed note stamps travelvisa in the packet', String(suffixed.stamp));
  ok(suffixed.s.coverage.status === 'ready' && suffixed.available === 325,
    'the suffixed note pays the card exactly as the plain note: available now 500 - 105 - 70 = 325', String(suffixed.available));
  ok(!suffixed.leaked && !JSON.stringify(suffixed.s.packet).includes('card payment:'), 'the note text never enters the packet');
  ok(none.available === 220, 'no note: no destination, the minimum and purchase still owed: 395 - 25 - 70 - 80 = 220', String(none.available));
  ok(other.stamp === 'unknown' && other.available === 220,
    'a comment naming a different card: unknown, nothing paid (220)', JSON.stringify({ stamp: other.stamp, available: other.available }));
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} card-payment note comment checks passed`);
process.exit(failures ? 1 : 0);
