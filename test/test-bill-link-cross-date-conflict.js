'use strict';
/* Disagreeing deliberate links leave neither bill the winner, whatever their due dates.
 * Grok Bot (#1206, 6928328181): a recurring link and an "item:" note naming DIFFERENT
 * bills leave neither the winner (To confirm). Astra's audit (#821 6934483625, observation
 * 2) showed the outstanding-before-upcoming preference picked one when the two bills fall
 * due on different days. Astra's invented repro, scaled to this fixture: Power due Nov 1,
 * Water due Nov 2, both accepting early payment; a Nov 1 debit carries Water's recurring
 * id and "item: Power". Each expected outcome is stated per case, not read back.
 *
 * `node test/test-bill-link-cross-date-conflict.js`
 */
const fs = require('fs');
const path = require('path');
const O = require('../scripts/provider-observe.js');

const ROOT = path.join(__dirname, '..');
const load = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const clone = v => JSON.parse(JSON.stringify(v));
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const POWER = 'invented-power';
const WATER = 'invented-water';
const WATER_LINK = '5550002';
const POWER_DUE = '2026-11-01';
const WATER_DUE = '2026-11-02';
const canonical = load('data.json');
const accountMap = load('docs/connectivity/fixtures/provider-account-map.json');
const baseIdentity = load('docs/connectivity/transaction-identity.json');

function bill(id, day, due) {
  return { id, label: id, frequency: 'monthly', day, firstDue: due, amount: 80,
    confidence: 'confirmed', householdObligation: true, payingAccount: 'chequing-a' };
}
function rule(eventId, payeePatterns, extra) {
  return Object.assign({ eventId, payeePatterns, atlasAccountId: 'chequing-a', direction: 'debit',
    requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
    postingDateRule: 'covers-early-or-due-on-or-before-posting', note: 'invented' }, extra || {});
}
const data = clone(canonical);
data.plan.bills = data.plan.bills.concat([bill(POWER, 1, POWER_DUE), bill(WATER, 2, WATER_DUE)]);
const ident = clone(baseIdentity);
ident.rules = ident.rules.concat([
  rule(POWER, ['ACME POWER'], { lunchMoneyItemNames: ['Power'] }),
  rule(WATER, ['ACME WATER'], { lunchMoneyRecurringIds: [WATER_LINK] }),
]);
function payload(txs) {
  const base = load('docs/connectivity/fixtures/automatic-payment-settlement.json');
  base.accounts = base.accounts.map(a => Object.assign(a, {
    updated_at: '2026-11-03T15:55:00.000Z', balance_last_update: '2026-11-03T15:55:00.000Z' }));
  return Object.assign(base, {
    fetchedAt: '2026-11-03T16:00:00.000Z',
    source: 'Invented cross-date link-conflict fixture. Not a live institution pull.',
    transactionWindow: { startDate: '2026-10-25', endDate: '2026-11-03', complete: true, hasMore: false, truncated: false },
    transactions: txs,
  });
}
function row(extra) {
  return Object.assign({ id: 8800101, account_id: 1001, date: POWER_DUE, amount: 80, currency: 'cad',
    is_pending: false, payee: 'Invented Utilities', original_name: 'UTIL 0099', recurring_id: null, notes: null }, extra || {});
}
const observe = txs => O.observe({ provider: 'lunchmoney', payload: payload(txs), accountMap, data: clone(data), identity: ident });
const settled = (report, id) => (report.representedEventCandidates || []).filter(c => c && c.id === id);

console.log('\n=== Astra repro: Water recurring link + "item: Power", due on different days ===');
{
  const report = observe([row({ recurring_id: Number(WATER_LINK), notes: 'item: Power' })]);
  ok(settled(report, POWER).length === 0, 'Power is not settled by it', JSON.stringify(settled(report, POWER).map(c => c.date)));
  ok(settled(report, WATER).length === 0, 'Water is not settled by it', JSON.stringify(settled(report, WATER).map(c => c.date)));
  const tx = (report.currentPeriodActuals.transactions || []).find(t => t.date === POWER_DUE && t.amount === 80);
  ok(tx && tx.representedBill === false, 'the payment is represented by no bill (To confirm)', JSON.stringify(tx && tx.representedBill));
}

console.log('\n=== controls ===');
{
  const same = clone(data);
  const sameDay = O.observe({ provider: 'lunchmoney', payload: payload([row({ recurring_id: Number(WATER_LINK), notes: 'item: Power' })]),
    accountMap, data: Object.assign(same, { plan: Object.assign(same.plan, {
      bills: same.plan.bills.map(b => b.id === WATER ? bill(WATER, 1, POWER_DUE) : b) }) }), identity: ident });
  ok(settled(sameDay, POWER).length === 0 && settled(sameDay, WATER).length === 0,
    'same due date: neither settles (unchanged)');
  const recurringOnly = observe([row({ recurring_id: Number(WATER_LINK) })]);
  ok(settled(recurringOnly, WATER).length === 1 && settled(recurringOnly, POWER).length === 0,
    'the recurring link alone: Water settles');
  const itemOnly = observe([row({ notes: 'item: Power' })]);
  ok(settled(itemOnly, POWER).length === 1 && settled(itemOnly, WATER).length === 0, 'the item note alone: Power settles');
  const agreeing = clone(ident);
  agreeing.rules.find(r => r.eventId === WATER).lunchMoneyItemNames = ['Water'];
  const both = O.observe({ provider: 'lunchmoney', payload: payload([row({ recurring_id: Number(WATER_LINK), notes: 'item: Water' })]),
    accountMap, data: clone(data), identity: agreeing });
  ok(settled(both, WATER).length === 1 && settled(both, POWER).length === 0, 'both links naming Water agree: Water settles once');
  // The outstanding-before-upcoming preference itself is untouched when the deliberate links do not
  // disagree: both bills naming the same recurring id is one link source, and the outstanding Power wins.
  const sharedIdent = clone(baseIdentity);
  sharedIdent.rules = sharedIdent.rules.concat([rule(POWER, ['ACME POWER'], { lunchMoneyRecurringIds: [WATER_LINK] }),
    rule(WATER, ['ACME WATER'], { lunchMoneyRecurringIds: [WATER_LINK] })]);
  const shared = O.observe({ provider: 'lunchmoney', payload: payload([row({ recurring_id: Number(WATER_LINK) })]),
    accountMap, data: clone(data), identity: sharedIdent });
  ok(settled(shared, POWER).length === 1 && settled(shared, WATER).length === 0,
    'links that do not disagree: the incumbent outstanding-before-upcoming preference still applies (Power)',
    JSON.stringify([settled(shared, POWER).map(c => c.date), settled(shared, WATER).map(c => c.date)]));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
