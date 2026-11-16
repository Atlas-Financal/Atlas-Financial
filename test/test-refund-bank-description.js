'use strict';
/* #962 C1 (Grok Bot, rule 17; lead conditions 2026-11-16): a refund whose display
 * name gives nothing shows the bank's own description, marked as the bank's
 * text ("Bank description: …"). Blank too: "Merchant unavailable". Never the
 * category. Display only: nothing is written to the ledger and no figure moves.
 *
 * Lead conditions proved here:
 *   1. bankDescription is kept only on rows Forecast classifies as refunds:
 *      original_name as written, control characters stripped, 60-character
 *      cap, no payee or category fallback;
 *   2. it never reaches the assistant / MCP current-state packet or the
 *      figures snapshot;
 *   3. the sanitizer still rejects it on any other row.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> packet -> Forecast.recommend -> the real Spent printer
 * (plan.js householdBudgetMetric). Every expected value is hand-written.
 *
 * `node test/test-refund-bank-description.js`
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
const printer = vm.runInNewContext([
  grab(appSrc, /^const money = .*$/m, 'money'),
  grab(appSrc, /^const money2 = .*$/m, 'money2'),
  grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
  grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
  grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
  grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
].join('\n') + '\n({ householdBudgetMetric });', { Forecast: F });
const payees = html => [...html.matchAll(/household-budget-tx-payee">([^<]*)/g)].map(m => m[1]);

const DESC = 'INVENTED REFUND CO 4471';
const payroll = () => H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
  payee: 'Invented employer' });
function run(refundRaw, extra = []) {
  const w = H.baseWorld();
  w.transactions = [payroll(),
    H.lm({ date: '2026-10-10', amount: 60, category: 'Restaurants', payee: 'Invented diner' }),
    H.lm({ date: '2026-10-12', amount: -25, category: 'Restaurants', raw: refundRaw }),
    ...extra];
  const r = H.dataOf(w);
  if (r.error) throw r.error;
  const refund = r.packet.transactions.find(t => t.amount === -25);
  const spend = r.packet.transactions.find(t => t.amount === 60);
  const income = r.packet.transactions.find(t => t.amount === -1400);
  const rec = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: r.packet, debts: r.data.debts });
  const period = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
  const row = (period.householdBudget || []).find(b => b && b.id === 'restaurants');
  const recon = (row && row.recon) || [];
  const html = printer.householdBudgetMetric('Spent', 35, { recon, id: 'restaurants' });
  return { w, r, refund, spend, income, recon, html, rec };
}

console.log('A refund with no display name shows the bank description, marked as the bank\'s text');
{
  const s = run({ payee: '', original_name: DESC });
  ok(s.refund && s.refund.bankDescription === DESC, 'the packet refund row carries the bank description as written',
    JSON.stringify(s.refund && s.refund.bankDescription));
  ok(s.refund && !('displayedPayee' in s.refund) && !('originalMerchant' in s.refund),
    'the refund row still carries no payee or merchant identity');
  ok(s.spend && !('bankDescription' in s.spend), 'a spend row carries no bank description');
  ok(s.income && !('bankDescription' in s.income), 'an income row carries no bank description');
  ok(s.recon.some(t => t.amount === -25 && t.bankDescription === DESC), 'Forecast passes it to the refund recon row only',
    JSON.stringify(s.recon.map(t => [t.amount, t.bankDescription || null])));
  ok(s.recon.filter(t => t.bankDescription).length === 1, 'no other recon row gains one');
  ok(payees(s.html).includes('Bank description: ' + DESC), 'the Spent list prints "Bank description: …"',
    JSON.stringify(payees(s.html)));
  ok(payees(s.html).includes('Invented diner'), 'positive control: the purchase keeps its payee');
}

console.log('No bank description: Merchant unavailable, never the category');
{
  const s = run({ payee: '', original_name: '   ' });
  ok(s.refund && !('bankDescription' in s.refund), 'a blank description is not kept');
  const names = payees(s.html);
  ok(names.includes('Merchant unavailable') && !names.includes('Restaurants') && !names.some(n => /Bank description/.test(n)),
    'the refund reads Merchant unavailable', JSON.stringify(names));
}

console.log('Bounded: control characters stripped, 60-character cap');
{
  const s = run({ payee: '', original_name: 'INVENTED\u0007 REFUND\n' + 'X'.repeat(80) });
  const text = s.refund && s.refund.bankDescription;
  ok(typeof text === 'string' && !/[\u0000-\u001f\u007f]/.test(text), 'no control characters', JSON.stringify(text));
  ok(typeof text === 'string' && Array.from(text).length === 60 && text.endsWith('…'), 'capped at 60 with an ellipsis',
    String(text && Array.from(text).length));
}

console.log('The bank description stays on the Budget page only');
{
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
}

console.log('The sanitizer still rejects a bank description on any other row');
{
  const s = run({ payee: '', original_name: DESC });
  ok(O.currentPeriodActualsLooksSanitized(s.r.packet), 'positive control: the observed packet is sanitized');
  const spendWith = { ...s.spend, bankDescription: 'INVENTED SHOP' };
  ok(O.transactionLooksSanitized(s.refund) && !O.transactionLooksSanitized(spendWith),
    'a debit carrying a bank description is unsanitized; the refund is fine');
  ok(!O.transactionLooksSanitized({ ...s.refund, bankDescription: 'X'.repeat(61) }), 'an over-long description is unsanitized');
  ok(!O.transactionLooksSanitized({ ...s.refund, bankDescription: 'A\u0007B' }), 'a control character is unsanitized');
  ok(!O.transactionLooksSanitized({ ...s.refund, bankDescription: 42 }), 'a non-string is unsanitized');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll refund bank description checks passed.');
