'use strict';
/* LEDGER A item 3 (Grok Bot, rule 17; lead option A, 2026-11-16): a refund nets
 * against its purchase's category only when the ledger links them. Lunch Money
 * returns a grouped purchase and refund as one group-parent row, which nets as
 * before. A standalone refund is unlinked: it never nets into its category or
 * into Other spending, and it is listed on its own ("Refunds not linked").
 * A refund in a hidden category stays hidden with its category, a pending
 * refund is not listed, and an unlinked refund still never settles expected
 * income (#927).
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> packet -> Forecast.recommend -> the real Budget line printer.
 * Every expected value is hand-written. Invented numbers only.
 *
 * `node test/test-refund-unlinked-own-line.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const grab = (src, re, name) => { const m = src.match(re); if (!m) throw new Error('printer ' + name + ' not found'); return m[0]; };
const appSrc = read('public/app.js'), planSrc = read('public/plan.js');
const printer = vm.runInNewContext([
  grab(appSrc, /^const money2 = .*$/m, 'money2'),
  grab(planSrc, /^const budgetBrowseKnown = .*$/m, 'budgetBrowseKnown'),
  grab(planSrc, /^function budgetBrowseMoney\([\s\S]*?\n\}$/m, 'budgetBrowseMoney'),
  grab(planSrc, /^ {2}function budgetUnlinkedRefundsBrowseHtml\([\s\S]*?\n {2}\}$/m, 'budgetUnlinkedRefundsBrowseHtml'),
].join('\n') + '\n({ budgetUnlinkedRefundsBrowseHtml });', {});
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const payroll = () => H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' });
function run(txs, patch) {
  const w = H.baseWorld();
  w.categories.push({ id: 120, name: 'Hidden things', exclude_from_budget: true });
  w.transactions = [payroll(), ...txs];
  if (patch) patch(w);
  const r = H.dataOf(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: r.packet, debts: r.data.debts });
  const period = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
  const cat = id => (period.householdBudget || []).find(b => b && b.id === id) || null;
  return { w, r, rec, period, cat };
}
const buy = (amount, category = 'Restaurants') => H.lm({ date: '2026-10-10', amount, category, payee: 'Invented diner' });
const refund = (amount, category = 'Restaurants', raw) => H.lm({ date: '2026-10-12', amount: -amount, category, payee: 'Invented diner', raw });

console.log('A standalone refund never nets; it is listed on its own');
{
  const s = run([buy(60), refund(25)]);
  ok(s.cat('restaurants') && near(s.cat('restaurants').spent, 60), 'Restaurants spent stays 60 (no netting)',
    String(s.cat('restaurants') && s.cat('restaurants').spent));
  const other = (s.period.householdBudget || []).find(b => b && b.otherSpending);
  ok(!other || !(other.recon || []).some(t => t.amount === -25), 'the refund is not in Other spending');
  const u = s.period.unlinkedRefunds;
  ok(u && near(u.total, 25) && u.trust === 'calculated' && u.recon.length === 1 && u.recon[0].amount === -25
    && u.recon[0].includeReason === 'refund-unlinked', 'Forecast lists it once as refund-unlinked, total 25', JSON.stringify(u && { t: u.total, n: u.recon.length }));
  const line = text(printer.budgetUnlinkedRefundsBrowseHtml(s.period));
  ok(line === 'Refunds not linked $25.00 1 refund · Review in Lunch Money', 'the Budget prints one line', line);
}

console.log('A ledger-linked refund (Lunch Money group parent) nets as before');
{
  const s = run([buy(60), refund(25, 'Restaurants', { is_group_parent: true })]);
  ok(s.cat('restaurants') && near(s.cat('restaurants').spent, 35), 'Restaurants spent 60 − 25 = 35',
    String(s.cat('restaurants') && s.cat('restaurants').spent));
  ok(!s.period.unlinkedRefunds, 'nothing is listed as unlinked');
  ok(printer.budgetUnlinkedRefundsBrowseHtml(s.period) === '', 'and no line prints');
}

console.log('A grouped pair counts once, as the group-parent row, never parent plus child (Grok Bot condition 1)');
{
  // Lunch Money returns only the group parent by default: one row, the pair's net. It nets once.
  const parentOnly = run([refund(25, 'Restaurants', { is_group_parent: true, id: 880100 })]);
  ok(near(parentOnly.cat('restaurants') && parentOnly.cat('restaurants').spent, -25) && !parentOnly.period.unlinkedRefunds,
    'the group-parent row alone nets once, -25, and is not listed as unlinked',
    String(parentOnly.cat('restaurants') && parentOnly.cat('restaurants').spent));
  // If the pair's member rows ever arrive beside their parent (the default fetch does not return them), the
  // parent is never counted alongside them (the incumbent split-parent skip). Until option B links members,
  // they follow option A: the purchase counts and the refund member is listed as unlinked. Net once: 60 − 25.
  const both = run([H.lm({ date: '2026-10-12', amount: 35, category: 'Restaurants', payee: 'Invented diner', raw: { is_group_parent: true, id: 880200 } }),
    H.lm({ date: '2026-10-12', amount: 60, category: 'Restaurants', payee: 'Invented diner', raw: { id: 880201, parent_id: 880200 } }),
    H.lm({ date: '2026-10-12', amount: -25, category: 'Restaurants', payee: 'Invented diner', raw: { id: 880202, parent_id: 880200 } })]);
  ok(both.r.packet.transactionCoverage === 'complete', 'positive control: a consistent parent and members keep coverage complete');
  ok(near(both.cat('restaurants') && both.cat('restaurants').spent, 60)
    && near(both.period.unlinkedRefunds && both.period.unlinkedRefunds.total, 25),
  'parent plus members: the parent (35) is not counted; the purchase counts 60 and the refund member is listed once (25)',
  JSON.stringify({ spent: both.cat('restaurants') && both.cat('restaurants').spent, unlinked: both.period.unlinkedRefunds && both.period.unlinkedRefunds.total }));
}

console.log('Hidden category, pending and unidentified refunds are not listed');
{
  const hidden = run([refund(9, 'Hidden things')]);
  ok(!hidden.period.unlinkedRefunds, 'a refund in a hidden category stays hidden with its category');
  const pending = run([buy(60), H.lm({ date: '2026-10-12', amount: -25, category: 'Restaurants', payee: 'Invented diner', pending: true })]);
  ok(!pending.period.unlinkedRefunds && near(pending.cat('restaurants').spent, 60), 'a pending refund is neither listed nor netted');
  const none = run([buy(60), H.lm({ date: '2026-10-12', amount: -25, payee: 'Invented diner' })]);
  ok(!none.period.unlinkedRefunds, 'an uncategorised credit is not a category refund, as on main');
}

console.log('Two unlinked refunds add up; the figures move only by the un-netted refunds');
{
  const s = run([buy(60), buy(40, 'Groceries'), refund(25), refund(7, 'Groceries')]);
  ok(near(s.period.unlinkedRefunds && s.period.unlinkedRefunds.total, 32), 'total 25 + 7 = 32');
  ok(near(s.cat('restaurants').spent, 60) && near(s.cat('groceries').spent, 40), 'each category keeps its full purchase');
  ok(text(printer.budgetUnlinkedRefundsBrowseHtml(s.period)) === 'Refunds not linked $32.00 2 refunds · Review in Lunch Money',
    'the line counts both');
  const linked = run([buy(60), buy(40, 'Groceries'), refund(25, 'Restaurants', { is_group_parent: true }),
    refund(7, 'Groceries', { is_group_parent: true })]);
  const hold = p => (p.householdBudget || []).reduce((sum, b) => sum + (Number(b && b.hold) || 0), 0);
  ok(hold(s.period) >= hold(linked.period), 'un-netting never lowers the household hold',
    `${hold(s.period)} vs ${hold(linked.period)}`);
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll unlinked refund checks passed.');
