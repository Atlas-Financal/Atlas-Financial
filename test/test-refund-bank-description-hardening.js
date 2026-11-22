'use strict';
/* The observer strips invisible direction and zero-width characters from a
 * linked refund's bank description while preserving its visible text. Stack
 * lists the refund with its signed amount and keeps bank text out of the sheet.
 * A standalone refund is separately reported and leaves category spend intact.
 * All data in this suite is invented. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRefundPeriod, assertRefundCategory } = require('./lib/stack-refund-period');
const O = require('../scripts/provider-observe.js');
const H = require('./acceptance/harness.js');

const ok = (condition, label, detail = '') => assert.ok(condition, label + (detail ? ' — ' + detail : ''));

const payroll = (raw) => H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
  payee: 'Invented employer', raw });
// The refund is the ledger-linked form (a Lunch Money group parent), the form that prints in a category's Spent list.
function run(originalName, extra = [], payrollRaw, { linked = true } = {}) {
  const w = H.baseWorld();
  w.transactions = [payroll(payrollRaw),
    H.lm({ date: '2026-10-10', amount: 60, category: 'Restaurants', payee: 'Invented diner' }),
    H.lm({ date: '2026-10-12', amount: -25, category: 'Restaurants',
      raw: { ...(linked ? { is_group_parent: true } : {}), payee: '', original_name: originalName } }),
    ...extra];
  H.resetCaptures();
  const r = H.dataOf(w);
  if (r.error) throw r.error;
  const refund = r.packet.transactions.find(t => t.amount === -25);
  return { r, refund };
}

const PLAIN = 'Invented Refund Co., #4471 (Online) - Thank you!';

test('A linked refund preserves the original bank text in the packet and keeps it off the Stack sheet', async () => {
  const s = run(PLAIN);
  ok(s.refund && s.refund.bankDescription === PLAIN, 'the packet keeps the bank text exactly: case and punctuation',
    JSON.stringify(s.refund && s.refund.bankDescription));
  const stack = await loadRefundPeriod(s.r.data);
  const html = assertRefundCategory(stack, 'restaurants', {
    spent: 35, headline: '$35', transactions: [['', '−$25'], ['Invented diner', '$60']],
  });
  ok(!html.includes(PLAIN), 'the purchase keeps its own payee and the refund discloses no bank text');
});

test('Grok (2): only invisible text-direction and zero-width characters are removed', async () => {
  const INVISIBLE = { ALM: '؜', ZWSP: '​', ZWNJ: '‌', ZWJ: '‍', LRM: '‎', RLM: '‏',
    LRE: '‪', RLE: '‫', PDF: '‬', LRO: '‭', RLO: '‮', WJ: '⁠',
    LRI: '⁦', RLI: '⁧', FSI: '⁨', PDI: '⁩', BOM: '﻿' };
  for (const [name, ch] of Object.entries(INVISIBLE)) {
    // Inside a word, between words and at both ends: removed outright, never replaced by a space.
    const s = run(ch + 'Invented Re' + ch + 'fund Co.,' + ch + ' #4471' + ch);
    ok(s.refund && s.refund.bankDescription === 'Invented Refund Co., #4471', name + ' (U+'
      + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + ') is removed and nothing else changes',
    JSON.stringify(s.refund && s.refund.bankDescription));
  }
  // A right-to-left override would make "Invented refund 4471" read backwards on the page.
  const spoof = run('Invented refund ‮1744‬');
  ok(spoof.refund.bankDescription === 'Invented refund 1744', 'the override is removed from the published text');
  const sheet = assertRefundCategory(await loadRefundPeriod(spoof.r.data), 'restaurants', {
    spent: 35, headline: '$35', transactions: [['', '−$25'], ['Invented diner', '$60']],
  });
  ok(!sheet.includes('1744'), 'the sanitized bank text stays off the sheet');
  // Visible non-ASCII stays: accents, symbols, other scripts and an ordinary space are not invisible characters.
  const visible = 'Café Invented — Remboursement №7 ½ Ünïcødé';
  ok(run(visible).refund.bankDescription === visible, 'visible accents, dashes and symbols are kept as written');
  // Only invisible characters: the observed row keeps no bank description.
  const blank = run('​‮﻿');
  ok(blank.refund && !('bankDescription' in blank.refund), 'text made only of invisible characters is absent');
  // The cap counts visible characters after removal: 60 visible characters are not cut short by hidden ones.
  const sixty = 'X'.repeat(60);
  const capped = run(sixty.split('').join('​'));
  ok(capped.refund && capped.refund.bankDescription === sixty, 'the 60-character cap counts the text after removal',
    String(capped.refund && Array.from(capped.refund.bankDescription || '').length));
});

test('A standalone refund has no bank text and stays out of category spend', async () => {
  const s = run(PLAIN, [], undefined, { linked: false });
  ok(s.refund && !('bankDescription' in s.refund), 'a standalone category refund carries no bank description',
    JSON.stringify(s.refund && s.refund.bankDescription));
  ok(!JSON.stringify(s.r.packet).includes('Invented Refund Co.'), 'its bank text appears nowhere in the packet');
  const stack = await loadRefundPeriod(s.r.data);
  const html = assertRefundCategory(stack, 'restaurants', {
    spent: 60, headline: '$60', transactions: [['Invented diner', '$60']],
  });
  ok(!stack.category('restaurants').recon.some(t => t.amount === -25), 'the refund is excluded from category activity');
  const u = stack.period.unlinkedRefunds;
  ok(u && u.total === 25 && u.recon.length === 1, 'the selected Stack period reports one standalone refund');
  ok(!html.includes(PLAIN), 'the sheet does not disclose the standalone bank text');
  const linked = run(PLAIN);
  const linkedStack = await loadRefundPeriod(linked.r.data);
  ok(linked.refund && linked.refund.bankDescription === PLAIN && !linkedStack.period.unlinkedRefunds,
    'the linked refund keeps its bank text in the packet and is absent from the standalone total');
});

test('Sanitizer boundary', () => {
  const s = run(PLAIN);
  ok(O.currentPeriodActualsLooksSanitized(s.r.packet), 'positive control: the observed packet is sanitized');
  ok(O.transactionLooksSanitized(s.refund), 'positive control: the refund row is sanitized');
  for (const ch of ['؜', '​', '‍', '‏', '‮', '⁠', '⁧', '﻿']) {
    ok(!O.transactionLooksSanitized({ ...s.refund, bankDescription: 'Invented' + ch + 'refund' }),
      'a bank description holding U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + ' is unsanitized');
  }
  const debit = s.r.packet.transactions.find(t => t.amount === 60);
  ok(!O.transactionLooksSanitized({ ...debit, bankDescription: 'Invented shop' }), 'a bank description on a debit is unsanitized');
  // Non-refund credits: payroll, an uncategorised deposit and a non-budget credit, each with bank text
  // that holds hidden characters. None carries a bank description, and none of the text reaches the packet.
  const t = run(PLAIN, [
    H.lm({ date: '2026-10-13', amount: -40, payee: '', raw: { original_name: 'INVENTED​ PERSON E-TRANSFER' } }),
    H.lm({ date: '2026-10-13', amount: -9, category: 'Gifts', payee: '', raw: { original_name: 'INVENTED‮ GIFT' } }),
  ], { original_name: 'INVENTED‍ PAYROLL' });
  const credits = t.r.packet.transactions.filter(x => x.amount < 0 && x.amount !== -25);
  ok(credits.length === 3 && credits.every(x => !('bankDescription' in x)), 'no non-refund credit carries a bank description',
    JSON.stringify(credits.map(x => [x.amount, x.bankDescription || null])));
  const blob = JSON.stringify(t.r.packet);
  ok(!/E-TRANSFER|GIFT|PAYROLL/.test(blob), 'none of their bank text appears anywhere in the packet');
  ok(t.refund && t.refund.bankDescription === PLAIN, 'positive control: the linked category refund still carries its text');
});
