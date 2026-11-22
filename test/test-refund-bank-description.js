'use strict';
/* Only a linked category refund may carry its bounded bank description in the
 * observed packet. The Stack category sheet prints the signed refund amount
 * and the published payee. The assistant and figures snapshot exclude bank text.
 * All data in this suite is invented. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRefundPeriod, assertRefundCategory } = require('./lib/stack-refund-period');
const O = require('../scripts/provider-observe.js');
const H = require('./acceptance/harness.js');

const ok = (condition, label, detail = '') => assert.ok(condition, label + (detail ? ' — ' + detail : ''));

const DESC = 'INVENTED REFUND CO 4471';
const payroll = () => H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
  payee: 'Invented employer' });
function run(refundRaw, extra = []) {
  const w = H.baseWorld();
  w.transactions = [payroll(),
    H.lm({ date: '2026-10-10', amount: 60, category: 'Restaurants', payee: 'Invented diner' }),
    // A Lunch Money group parent links the refund to the category purchase (#1234).
    H.lm({ date: '2026-10-12', amount: -25, category: 'Restaurants', raw: { is_group_parent: true, ...refundRaw } }),
    ...extra];
  H.resetCaptures();
  const r = H.dataOf(w);
  if (r.error) throw r.error;
  const refund = r.packet.transactions.find(t => t.amount === -25);
  const spend = r.packet.transactions.find(t => t.amount === 60);
  const income = r.packet.transactions.find(t => t.amount === -1400);
  return { r, refund, spend, income };
}

test('Only the linked refund carries bank text, and its signed amount appears in the Stack sheet', async () => {
  const s = run({ payee: '', original_name: DESC });
  ok(s.refund && s.refund.bankDescription === DESC, 'the packet refund row carries the bank description as written',
    JSON.stringify(s.refund && s.refund.bankDescription));
  ok(s.refund && !('displayedPayee' in s.refund) && !('originalMerchant' in s.refund),
    'the refund row still carries no payee or merchant identity');
  ok(s.spend && !('bankDescription' in s.spend), 'a spend row carries no bank description');
  ok(s.income && !('bankDescription' in s.income), 'an income row carries no bank description');
  const stack = await loadRefundPeriod(s.r.data);
  const recon = stack.category('restaurants').recon;
  const html = assertRefundCategory(stack, 'restaurants', {
    spent: 35, headline: '$35', transactions: [['', '−$25'], ['Invented diner', '$60']],
  });
  ok(!html.includes(DESC), 'the linked bank description stays out of the sheet');
  ok(recon.some(t => t.amount === -25 && t.bankDescription === DESC), 'Forecast passes it to the refund recon row only',
    JSON.stringify(recon.map(t => [t.amount, t.bankDescription || null])));
  ok(recon.filter(t => t.bankDescription).length === 1, 'no other recon row gains one');
});

test('Only a category refund keeps it: other credits never carry the bank text', () => {
  // An uncategorised deposit (an e-transfer from a person, say) and a credit in a non-budget category are
  // classified as refunds but are not a named category's refund: their bank text must never be published.
  const s = run({ payee: '', original_name: DESC }, [
    H.lm({ date: '2026-10-13', amount: -40, payee: '', raw: { original_name: 'INVENTED PERSON E-TRANSFER' } }),
    H.lm({ date: '2026-10-13', amount: -9, category: 'Gifts', payee: '', raw: { original_name: 'INVENTED GIFT CREDIT' } }),
  ]);
  const deposit = s.r.packet.transactions.find(t => t.amount === -40);
  const gift = s.r.packet.transactions.find(t => t.amount === -9);
  ok(deposit && !('bankDescription' in deposit), 'an uncategorised deposit carries no bank description');
  ok(gift && !('bankDescription' in gift), 'a credit in a non-budget category carries no bank description');
  const blob = JSON.stringify(s.r.packet);
  ok(!blob.includes('INVENTED PERSON E-TRANSFER') && !blob.includes('INVENTED GIFT CREDIT'),
    'neither bank text appears anywhere in the packet');
  ok(s.refund && s.refund.bankDescription === DESC, 'positive control: the category refund still carries it');
});

test('A blank bank description leaves the refund name empty', async () => {
  const s = run({ payee: '', original_name: '   ' });
  ok(s.refund && !('bankDescription' in s.refund), 'a blank description is not kept');
  const stack = await loadRefundPeriod(s.r.data);
  assertRefundCategory(stack, 'restaurants', {
    spent: 35, headline: '$35', transactions: [['', '−$25'], ['Invented diner', '$60']],
  });
});

test('Bounded: control characters stripped, 60-character cap', () => {
  const s = run({ payee: '', original_name: 'INVENTED\u0007 REFUND\n' + 'X'.repeat(80) });
  const text = s.refund && s.refund.bankDescription;
  ok(typeof text === 'string' && !/[\u0000-\u001f\u007f]/.test(text), 'no control characters', JSON.stringify(text));
  ok(typeof text === 'string' && Array.from(text).length === 60 && text.endsWith('…'), 'capped at 60 with an ellipsis',
    String(text && Array.from(text).length));
});

test('The assistant packet and the figures snapshot exclude bank descriptions', () => {
  const s = run({ payee: '', original_name: DESC });
  const Assistant = require('../scripts/assistant-packet.js');
  let packet = null, error = null;
  try { packet = Assistant.buildPacket({ data: s.r.data, periods: [], questionsMarkdown: '' }); } catch (e) { error = e; }
  ok(packet && !error, 'positive control: the assistant packet builds from the same served data', error && error.message);
  const blob = JSON.stringify(packet || {});
  ok(!/bankDescription/.test(blob) && !blob.includes(DESC), 'the assistant / MCP current-state packet carries no bank description');
  const Snapshot = require('../scripts/figures-snapshot.js');
  let snap = null, snapError = null;
  try { snap = Snapshot.buildFiguresSnapshot(s.r.data, []); } catch (e) { snapError = e; }
  ok(snap && !snapError, 'positive control: the figures snapshot builds from the same served data', snapError && snapError.message);
  const snapBlob = JSON.stringify(snap || {});
  ok(!/bankDescription/.test(snapBlob) && !snapBlob.includes(DESC), 'the figures snapshot carries no bank description');
});

test('The sanitizer still rejects a bank description on any other row', () => {
  const s = run({ payee: '', original_name: DESC });
  ok(O.currentPeriodActualsLooksSanitized(s.r.packet), 'positive control: the observed packet is sanitized');
  const spendWith = { ...s.spend, bankDescription: 'INVENTED SHOP' };
  ok(O.transactionLooksSanitized(s.refund) && !O.transactionLooksSanitized(spendWith),
    'a debit carrying a bank description is unsanitized; the refund is fine');
  ok(!O.transactionLooksSanitized({ ...s.refund, bankDescription: 'X'.repeat(61) }), 'an over-long description is unsanitized');
  ok(!O.transactionLooksSanitized({ ...s.refund, bankDescription: 'A\u0007B' }), 'a control character is unsanitized');
  ok(!O.transactionLooksSanitized({ ...s.refund, bankDescription: 42 }), 'a non-string is unsanitized');
});
