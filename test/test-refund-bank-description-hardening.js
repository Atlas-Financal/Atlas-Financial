'use strict';
/* #1219 hardening (lead ask 2026-11-16; Grok Bot, rule 17, 2026-11-17): the
 * bank description shown on a refund is stripped of invisible text-direction
 * and zero-width characters, and nothing else changes.
 *
 * Grok Bot's conditions proved here:
 *   (1) the "Refunds not linked" line shows the count and "Review in Lunch
 *       Money", and an unlinked refund is never netted into spending;
 *   (2) ONLY the invisible text-direction marks (ALM, LRM, RLM, U+202A-202E,
 *       U+2066-2069) and zero-width characters (U+200B-200D, U+2060, U+FEFF)
 *       are removed, outright and never replaced; case and punctuation stay
 *       exactly as the bank wrote them;
 *   (3) a ledger-linked refund that shows a name today shows exactly the same
 *       name, through the page's real DisplayName.
 * Plus the lead's narrowing: the bank description is kept only on a
 * ledger-linked category refund, the only refund the page lists by name; a
 * standalone refund keeps none. And the sanitizer boundary: a bank description carrying any of those
 * characters, or sitting on a debit, is unsanitized; and no non-refund credit
 * ever carries one, whatever its bank text holds.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> packet -> Forecast.recommend -> the real Spent printer
 * (plan.js householdBudgetMetric) with public/display-name.js loaded. Every
 * expected value is hand-written. Invented data only.
 *
 * `node test/test-refund-bank-description-hardening.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const grab = (src, re, name) => {
  const m = src.match(re);
  if (!m) throw new Error('printer ' + name + ' not found');
  return m[0];
};
const appSrc = read('public/app.js');
const planSrc = read('public/plan.js');
// The page's real DisplayName is loaded first, so the printer takes the same branch the browser takes.
const printer = vm.runInNewContext([
  read('public/display-name.js'),
  grab(appSrc, /^const money = .*$/m, 'money'),
  grab(appSrc, /^const money2 = .*$/m, 'money2'),
  grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
  grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
  grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
  grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
  grab(planSrc, /^const budgetBrowseKnown = .*$/m, 'budgetBrowseKnown'),
  grab(planSrc, /^function budgetBrowseMoney\([\s\S]*?\n\}$/m, 'budgetBrowseMoney'),
  grab(planSrc, /^ {2}function budgetUnlinkedRefundsBrowseHtml\([\s\S]*?\n {2}\}$/m, 'budgetUnlinkedRefundsBrowseHtml'),
].join('\n') + '\n({ householdBudgetMetric, budgetUnlinkedRefundsBrowseHtml,'
  + ' hasDisplayName: typeof DisplayName !== "undefined" });', { Forecast: F });
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const payees = html => [...html.matchAll(/household-budget-tx-payee">([^<]*)/g)].map(m => m[1]);
const unescape = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

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
  const r = H.dataOf(w);
  if (r.error) throw r.error;
  const refund = r.packet.transactions.find(t => t.amount === -25);
  const rec = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: r.packet, debts: r.data.debts });
  const period = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
  const row = (period.householdBudget || []).find(b => b && b.id === 'restaurants');
  const recon = (row && row.recon) || [];
  const html = printer.householdBudgetMetric('Spent', 35, { recon, id: 'restaurants' });
  return { r, refund, recon, html, names: payees(html).map(unescape), period, row };
}

ok(printer.hasDisplayName === true, 'positive control: the printer runs with the real DisplayName loaded');

const PLAIN = 'Invented Refund Co., #4471 (Online) - Thank you!';

console.log('Grok (3): a linked refund that shows a name today shows exactly the same name');
{
  const s = run(PLAIN);
  ok(s.refund && s.refund.bankDescription === PLAIN, 'the packet keeps the bank text exactly: case and punctuation',
    JSON.stringify(s.refund && s.refund.bankDescription));
  ok(s.names.includes('Bank description: ' + PLAIN), 'the Spent list prints it unchanged', JSON.stringify(s.names));
  ok(s.names.includes('Invented diner'), 'positive control: the purchase keeps its payee');
  // A refund that carries a display name showing that name, not the bank text, was a classic-page rule;
  // it retired with the classic page (C1 S4 batch B1). The Stack sheet prints Lunch Money's own name only.
}

console.log('Grok (2): only invisible text-direction and zero-width characters are removed');
{
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
  ok(spoof.names.includes('Bank description: Invented refund 1744'), 'an override cannot reorder what the page prints',
    JSON.stringify(spoof.names));
  // Visible non-ASCII stays: accents, symbols, other scripts and an ordinary space are not invisible characters.
  const visible = 'Café Invented — Remboursement №7 ½ Ünïcødé';
  ok(run(visible).refund.bankDescription === visible, 'visible accents, dashes and symbols are kept as written');
  // Only invisible characters: nothing left to show, so the row keeps none and reads Merchant unavailable.
  const blank = run('​‮﻿');
  ok(blank.refund && !('bankDescription' in blank.refund) && blank.names.includes('Merchant unavailable'),
    'text that was only invisible characters is not kept', JSON.stringify(blank.names));
  // The cap counts visible characters after removal: 60 visible characters are not cut short by hidden ones.
  const sixty = 'X'.repeat(60);
  const capped = run(sixty.split('').join('​'));
  ok(capped.refund && capped.refund.bankDescription === sixty, 'the 60-character cap counts the text after removal',
    String(capped.refund && Array.from(capped.refund.bankDescription || '').length));
}

console.log('Narrowing and Grok (1): a standalone refund keeps no bank text and prints only on its own line');
{
  const s = run(PLAIN, [], undefined, { linked: false });
  ok(s.refund && !('bankDescription' in s.refund), 'a standalone category refund carries no bank description',
    JSON.stringify(s.refund && s.refund.bankDescription));
  ok(!JSON.stringify(s.r.packet).includes('Invented Refund Co.'), 'its bank text appears nowhere in the packet');
  ok(s.row && Math.abs(s.row.spent - 60) < 0.005, 'it is never netted: Restaurants spent stays 60',
    String(s.row && s.row.spent));
  ok(!s.recon.some(t => t.amount === -25), 'it is not in the Restaurants Spent list');
  const u = s.period.unlinkedRefunds;
  ok(u && Math.abs(u.total - 25) < 0.005 && u.recon.length === 1, 'it is listed once as not linked, total 25');
  const line = text(printer.budgetUnlinkedRefundsBrowseHtml(s.period));
  ok(line === 'Refunds not linked $25.00 1 refund · Review in Lunch Money',
    'the line shows the total, the count and "Review in Lunch Money"', line);
  ok(!/Bank description|Invented Refund/.test(line), 'the line prints no bank text');
  const linked = run(PLAIN);
  ok(linked.refund && linked.refund.bankDescription === PLAIN && !linked.period.unlinkedRefunds,
    'positive control: the linked refund keeps its text and is not listed as not linked');
}

console.log('Sanitizer boundary');
{
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
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll refund bank description hardening checks passed.');
