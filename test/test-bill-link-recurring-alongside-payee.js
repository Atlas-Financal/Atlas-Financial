'use strict';
/* A bill's Lunch Money recurring link sits alongside its payee rule
 * (Grok rule 4, link order 1 of 3: recurring link, then item note, then
 * single-bill category). Invented bills, payees, ids and amounts only.
 * Each expected outcome is stated per row, not read back from the matcher.
 *
 * `node test/test-bill-link-recurring-alongside-payee.js`
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

const DUE = '2026-11-01';
const POWER = 'invented-power';
const WATER = 'invented-water';
const LINK = '5550001';
const OTHER_LINK = '5550999';
const canonical = load('data.json');
const accountMap = load('docs/connectivity/fixtures/provider-account-map.json');
const baseIdentity = load('docs/connectivity/transaction-identity.json');

function bill(id, amount) {
  return { id, label: id, frequency: 'monthly', day: 1, firstDue: DUE, amount,
    confidence: 'confirmed', householdObligation: true, payingAccount: 'chequing-a' };
}
function rule(eventId, payeePatterns, extra) {
  return Object.assign({ eventId, payeePatterns, atlasAccountId: 'chequing-a', direction: 'debit',
    requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
    postingDateRule: 'covers-early-or-due-on-or-before-posting', note: 'invented' }, extra || {});
}
const data = clone(canonical);
data.plan.bills = data.plan.bills.concat([bill(POWER, 63.21), bill(WATER, 63.21)]);

function identityWith(powerExtra, waterExtra) {
  const ident = clone(baseIdentity);
  ident.rules = ident.rules.concat([
    rule(POWER, ['ACME POWER'], powerExtra),
    rule(WATER, ['ACME WATER'], waterExtra),
  ]);
  return ident;
}
function payload(txs) {
  const base = load('docs/connectivity/fixtures/automatic-payment-settlement.json');
  base.accounts = base.accounts.map(a => Object.assign(a, {
    updated_at: '2026-11-03T15:55:00.000Z', balance_last_update: '2026-11-03T15:55:00.000Z' }));
  return Object.assign(base, {
    fetchedAt: '2026-11-03T16:00:00.000Z',
    source: 'Invented recurring-link fixture. Not a live institution pull.',
    transactionWindow: { startDate: '2026-10-25', endDate: '2026-11-03', complete: true, hasMore: false, truncated: false },
    transactions: txs,
  });
}
function row(extra) {
  return Object.assign({ id: 8800001, account_id: 1001, date: DUE, amount: 63.21, currency: 'cad',
    is_pending: false, payee: 'ACME POWER', original_name: 'ACME POWER PAP', recurring_id: null }, extra || {});
}
const observe = (txs, ident) => O.observe({ provider: 'lunchmoney', payload: payload(txs), accountMap,
  data: clone(data), identity: ident });
const hits = (report, id) => (report.representedEventCandidates || []).filter(c => c && c.id === id);

const withLink = identityWith({ lunchMoneyRecurringIds: [LINK] });
const payeeOnly = identityWith();

console.log('\n=== recurring link and payee rule side by side ===');
{
  const both = hits(observe([row({ recurring_id: LINK })], withLink), POWER);
  ok(both.length === 1 && both[0].date === DUE, 'linked row whose payee also matches: links once');
  const renamed = hits(observe([row({ recurring_id: LINK, payee: 'Renamed Utility', original_name: 'UTIL 0042' })], withLink), POWER);
  ok(renamed.length === 1 && renamed[0].date === DUE, 'linked row whose payee no longer matches: the recurring link alone links it');
  const unlinked = hits(observe([row()], withLink), POWER);
  ok(unlinked.length === 1, 'row with no recurring link: the existing payee rule still links it');
  ok(hits(observe([row({ recurring_id: OTHER_LINK })], withLink), POWER).length === 1,
    'row linked to a different recurring item whose payee matches: the payee rule still links it (adding a link removes none)');
  ok(hits(observe([row({ recurring_id: LINK, payee: 'Renamed', original_name: 'X' })], payeeOnly), POWER).length === 0,
    'control: without the configured id the renamed row does not link (the new link source is what links it)');
}

console.log('\n=== the incumbent gates still apply to a linked row ===');
{
  const r = { recurring_id: LINK, payee: 'Renamed', original_name: 'X' };
  ok(hits(observe([row(Object.assign({}, r, { is_pending: true }))], withLink), POWER).length === 0, 'pending: no link');
  // A card account is still refused; Weekly spend (1002), the other household chequing account, is accepted for a tied bill
  // (Dale, #821 7168507103).
  ok(hits(observe([row(Object.assign({}, r, { account_id: 2001 }))], withLink), POWER).length === 0, 'card account: no link');
  ok(hits(observe([row(Object.assign({}, r, { amount: -63.21 }))], withLink), POWER).length === 0, 'credit: no link');
  ok(hits(observe([row(Object.assign({}, r, { currency: 'usd' }))], withLink), POWER).length === 0, 'other currency: no link');
}

console.log('\n=== payee-only rules are unchanged ===');
{
  ok(hits(observe([row({ recurring_id: OTHER_LINK })], payeeOnly), POWER).length === 1,
    'a rule with no recurring ids reads its payee rule whatever recurring_id the row carries (as on main)');
  ok(hits(observe([row()], payeeOnly), POWER).length === 1, 'payee-only rule, unlinked row: links (as on main)');
}

console.log('\n=== the recurring link wins over another bill\'s payee match, counted once ===');
{
  // Grok (via the lead, 2026-11-16): while payee rules and recurring links run
  // side by side, a payment both link counts once; if they point to different
  // bills, the recurring link wins and the payee rule's match is dropped.
  const ident = identityWith({}, { lunchMoneyRecurringIds: [LINK] });
  const report = observe([row({ recurring_id: LINK })], ident);
  const p = hits(report, POWER);
  const w = hits(report, WATER);
  ok(w.length === 1 && w[0].date === DUE, 'the bill whose recurring link the row carries takes it', JSON.stringify(w.map(x => x.date)));
  ok(p.length === 0, 'the other bill\'s payee match is dropped', JSON.stringify(p.map(x => x.date)));
  const cp = report.currentPeriodActuals || {};
  ok((cp.transactions || []).filter(t => t.representedBill === true).length === 1,
    'the row is one bill payment, counted once');
  const unlinked = observe([row()], ident);
  ok(hits(unlinked, POWER).length === 1 && hits(unlinked, WATER).length === 0,
    'without the recurring link the payee rule still takes it (nothing else changes)');
  const otherItem = observe([row({ recurring_id: OTHER_LINK })], ident);
  ok(hits(otherItem, POWER).length === 1 && hits(otherItem, WATER).length === 0,
    'a recurring id no rule names does not block the payee rule');
}

console.log('\n=== the same bill linked both ways counts once ===');
{
  const report = observe([row({ recurring_id: LINK })], withLink);
  ok(hits(report, POWER).length === 1, 'one representation for the bill');
  ok(((report.currentPeriodActuals || {}).transactions || []).filter(t => t.representedBill === true).length === 1,
    'one bill payment in the actuals');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
