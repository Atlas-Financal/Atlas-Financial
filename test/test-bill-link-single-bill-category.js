'use strict';
/* A bill's single-bill Lunch Money category sits alongside its payee rule
 * (Grok rule 4, link order 3 of 3). Opt-in and empty until Dale confirms each
 * category; duplicates refused; the id is the identity and a rename since Dale confirmed
 * the name reads To confirm (Grok Bot, #1207 6927147873). Invented bills, payees, ids and amounts only.
 * Each expected outcome is stated per row, not read back from the matcher.
 *
 * `node test/test-bill-link-single-bill-category.js`
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
const CAT = '7770001';
const OTHER_CAT = '7770999';
// The category as Dale confirmed it: id plus name (Grok Bot, #1207 6927147873: a rename reads To confirm).
const CAT_NAME = 'Invented Power Bill';
const CATE = { id: CAT, name: CAT_NAME };
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
    source: 'Invented single-bill category fixture. Not a live institution pull.',
    categories: (base.categories || []).concat([{ id: Number(CAT), name: CAT_NAME }, { id: Number(OTHER_CAT), name: 'Invented Other' }]),
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

const named = identityWith({ lunchMoneyCategoryIds: [CATE] });
const payeeOnly = identityWith();
const renamed = extra => row(Object.assign({ payee: 'Renamed Utility', original_name: 'UTIL 0042' }, extra));
const links = (r, ident, id) => hits(observe([r], ident || named), id || POWER).length;

console.log('\n=== the configured category id links, alongside the payee rule ===');
ok(links(renamed({ category_id: Number(CAT) })) === 1, 'renamed row in the configured category links');
// Grok Bot (recorded on #1207, 6927147873): a category renamed in Lunch Money reads To confirm; it never links,
// and never moves to another bill (WATER's payee or any other rule cannot take it either).
ok(links(renamed({ category_id: CAT, category_name: 'Anything Renamed' })) === 0, 'a renamed category (same id) links nothing: To confirm');
ok(links(row({ category_id: CAT, category_name: 'Anything Renamed' })) === 0,
  'a renamed category links nothing even when the payee matches (no fallback)');
ok(links(row({ category_id: CAT, category_name: 'Anything Renamed', payee: 'ACME WATER', original_name: 'ACME WATER PAP' }), named, WATER) === 0,
  'a renamed category never moves to another bill');
ok(links(renamed({ category_id: CAT, category_name: '  invented   POWER bill ' })) === 1, 'case and spacing alone are not a rename');
ok(links(renamed({ category_id: CAT }), identityWith({ lunchMoneyCategoryIds: [CAT] })) === 0,
  'an entry with no confirmed name cannot be checked, so it never links (fail closed)');
ok(links(row({ category_id: null })) === 1, 'no category: the existing payee rule still links it');
ok(links(row({ category_id: OTHER_CAT })) === 1, 'another category does not remove the payee link');
ok(links(renamed({ category_id: CAT }), payeeOnly) === 0, 'control: without the configured id the renamed row does not link');
ok(links(renamed({ category_id: OTHER_CAT, category_name: 'Acme Power' })) === 0,
  'a different category id carrying a matching name does not link (ids, not names)');

console.log('\n=== the incumbent gates still apply to a category-linked row ===');
ok(links(renamed({ category_id: CAT, is_pending: true })) === 0, 'pending: no link');
ok(links(renamed({ category_id: CAT, account_id: 1002 })) === 0, 'other account: no link');
ok(links(renamed({ category_id: CAT, amount: -63.21 })) === 0, 'credit: no link');
ok(links(renamed({ category_id: CAT, currency: 'usd' })) === 0, 'other currency: no link');

console.log('\n=== a category named by two bills is refused ===');
{
  const dup = identityWith({ lunchMoneyCategoryIds: [CATE] }, { lunchMoneyCategoryIds: [CATE] });
  ok(JSON.stringify([...O.duplicatedRuleCategoryIds(dup.rules)]) === JSON.stringify([CAT]), 'the duplicate is detected');
  const report = observe([renamed({ category_id: CAT })], dup);
  ok(hits(report, POWER).length === 0 && hits(report, WATER).length === 0, 'neither bill takes the doubly claimed row');
  ok(((report.currentPeriodActuals || {}).transactions || []).every(t => t.representedBill !== true),
    'the row is not marked as a bill payment');
  // Codex P2 on ecf3e435: the duplicate is refused before matching, so a
  // bill whose rival fails another gate (here its paying account) still
  // cannot take the row by the shared category.
  const otherAccount = identityWith({ lunchMoneyCategoryIds: [CATE] },
    { lunchMoneyCategoryIds: [CATE], atlasAccountId: 'chequing-b' });
  const lone = observe([renamed({ category_id: CAT })], otherAccount);
  ok(hits(lone, POWER).length === 0 && hits(lone, WATER).length === 0,
    'a shared category links neither bill even when only one bill passes its other gates');
  ok(links(row({ category_id: CAT }), otherAccount) === 1,
    'the refused category does not remove the payee link');
}

console.log('\n=== a rule never stamped from its rule set links by no category ===');
{
  const lonely = rule(POWER, [], { lunchMoneyCategoryIds: [CATE] });
  const tx = { payee: 'Renamed', originalName: 'X', categoryId: CAT, pending: false, savingsPostingEvidence: 'posted' };
  ok(O.ruleMatchesTransactionIdentity(tx, lonely) === false, 'unstamped rule: the category does not link (fail closed)');
}

console.log('\n=== Grok\'s order: recurring link, item note, category, payee last ===');
{
  // A recurring link to another bill outranks the category.
  const r = identityWith({ lunchMoneyCategoryIds: [CATE] }, { lunchMoneyRecurringIds: ['5550001'] });
  const a = observe([renamed({ category_id: CAT, recurring_id: '5550001' })], r);
  ok(hits(a, WATER).length === 1 && hits(a, POWER).length === 0, 'recurring link beats a different bill\'s category');
  // An item note naming another bill outranks the category.
  const i = identityWith({ lunchMoneyCategoryIds: [CATE] }, { lunchMoneyItemNames: ['Acme Water'] });
  const b = observe([renamed({ category_id: CAT, notes: 'item: Acme Water' })], i);
  ok(hits(b, WATER).length === 1 && hits(b, POWER).length === 0, 'item note beats a different bill\'s category');
  // The category outranks a different bill's payee rule (POWER's payee matches).
  const c = identityWith({}, { lunchMoneyCategoryIds: [CATE] });
  const d = observe([row({ category_id: CAT })], c);
  ok(hits(d, WATER).length === 1 && hits(d, POWER).length === 0, 'category beats a different bill\'s payee match');
  ok(((d.currentPeriodActuals || {}).transactions || []).filter(t => t.representedBill === true).length === 1,
    'counted once');
  // A refused (duplicated) category outranks nothing: the payee rule still applies.
  const dup = identityWith({}, { lunchMoneyCategoryIds: [CATE] });
  dup.rules.push(rule('invented-third', ['NOBODY'], { lunchMoneyCategoryIds: [CATE] }));
  ok(hits(observe([row({ category_id: CAT })], dup), POWER).length === 1,
    'a refused duplicate category blocks no payee link');
}

console.log('\n=== the shipped config starts empty ===');
ok(baseIdentity.rules.every(r => !Object.hasOwn(r, 'lunchMoneyCategoryIds')),
  'no rule in transaction-identity.json names a category id (each waits for Dale)');
ok(O.duplicatedRuleCategoryIds(baseIdentity.rules).size === 0, 'transaction-identity.json names no category id twice');

console.log('\n=== a rule with category ids only reads the category alone ===');
{
  const catOnly = clone(baseIdentity);
  catOnly.rules = catOnly.rules.concat([rule(POWER, [], { lunchMoneyCategoryIds: [CATE] })]);
  ok(links(renamed({ category_id: CAT }), catOnly) === 1, 'category-only rule: the category links');
  ok(links(row({ category_id: null }), catOnly) === 0, 'category-only rule: payee text alone does not link');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
