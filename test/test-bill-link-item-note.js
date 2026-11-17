'use strict';
/* A bill's Lunch Money item note ("item: <name>") sits alongside its payee
 * rule (Grok rule 4, link order 2 of 3: recurring link, then item note, then
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

const named = identityWith({ lunchMoneyItemNames: ['Acme Power'] });
const payeeOnly = identityWith();
const renamed = extra => row(Object.assign({ payee: 'Renamed Utility', original_name: 'UTIL 0042' }, extra));
const links = (r, ident, id) => hits(observe([r], ident || named), id || POWER).length;

console.log('\n=== the item note links, alongside the payee rule ===');
ok(links(renamed({ notes: 'item: Acme Power' })) === 1, 'renamed row with "item: Acme Power" links by the note');
ok(links(renamed({ notes: '  ITEM:   acme   power  ' })) === 1, 'prefix in any case, name ignoring case and spaces');
ok(links(renamed({ notes: 'sorting fix 2026-11-13 - receipt; item: Acme Power' })) === 1, 'one ;-separated part is the item');
ok(links(row({ notes: null })) === 1, 'no note: the existing payee rule still links it');
ok(links(row({ notes: 'item: Something Else' })) === 1, 'a note naming another item does not remove the payee link');
ok(links(renamed({ notes: 'item: Acme Power' }), payeeOnly) === 0, 'control: without the configured name the renamed row does not link');

console.log('\n=== only a deliberate, single, exact item part counts ===');
ok(links(renamed({ notes: 'Acme Power' })) === 0, 'a note without the prefix (e.g. an auto-copied recurring description) does not count');
ok(links(renamed({ notes: 'item: Acme Power Plus' })) === 0, 'a longer name does not count (exact, not substring)');
ok(links(renamed({ notes: 'item: Acme' })) === 0, 'a shorter name does not count');
ok(links(renamed({ notes: 'paid item: Acme Power' })) === 0, 'the prefix must start the part');
ok(links(renamed({ notes: 'item: Acme Power; item: Acme Water' })) === 0, 'two item parts: the note links nothing');
ok(links(renamed({ notes: 'item: Acme Power; item: Acme Water' }), identityWith({ lunchMoneyItemNames: ['Acme Power'] },
  { lunchMoneyItemNames: ['Acme Water'] }), WATER) === 0, 'two item parts: neither named bill links by the note');

console.log('\n=== the incumbent gates still apply to a note-linked row ===');
ok(links(renamed({ notes: 'item: Acme Power', is_pending: true })) === 0, 'pending: no link');
ok(links(renamed({ notes: 'item: Acme Power', account_id: 1002 })) === 0, 'other account: no link');
ok(links(renamed({ notes: 'item: Acme Power', amount: -63.21 })) === 0, 'credit: no link');
ok(links(renamed({ notes: 'item: Acme Power', currency: 'usd' })) === 0, 'other currency: no link');

console.log('\n=== a rule with item names only reads the note alone ===');
{
  const noteOnly = clone(baseIdentity);
  noteOnly.rules = noteOnly.rules.concat([rule(POWER, [], { lunchMoneyItemNames: ['Acme Power'] })]);
  ok(links(renamed({ notes: 'item: Acme Power' }), noteOnly) === 1, 'note-only rule: the note links');
  ok(links(row({ notes: null }), noteOnly) === 0, 'note-only rule: payee text alone does not link');
}

console.log('\n=== a recurring link and an item note naming DIFFERENT bills: neither wins, To confirm ===');
{
  // Grok (Plan #6, 2026-11-16 12:33 MST): order is recurring link, item note,
  // single-bill category, payee last; except when the recurring link and the
  // item note name different bills, neither wins and the row reads To confirm.
  const ident = identityWith({ lunchMoneyItemNames: ['Acme Power'] }, { lunchMoneyRecurringIds: ['5550001'] });
  const report = observe([renamed({ notes: 'item: Acme Power', recurring_id: '5550001' })], ident);
  ok(hits(report, POWER).length === 0 && hits(report, WATER).length === 0, 'neither bill is settled by the conflicting row');
  ok(((report.currentPeriodActuals || {}).transactions || []).every(t => t.representedBill !== true),
    'the row is not counted as either bill\'s payment');
  // The hit grouping holds the row ambiguous between both bills (the
  // incumbent consumed-twice path the bill ledger reads as To confirm).
  const groups = O.representedEventHitGroups({ transactions: report.collapsedTransactions, accountMap,
    plan: Object.assign({}, data.plan, { debts: data.debts || [] }), identityRules: ident.rules,
    transactionWindow: report.transactionWindow, asOf: '2026-11-03' });
  const amb = (groups.ambiguous || []).filter(a => a.reason === 'transaction-consumed-twice');
  ok(amb.length === 1 && JSON.stringify((amb[0].hits || []).map(h => h.id).sort()) === JSON.stringify([POWER, WATER].sort()),
    'both bills hold the row ambiguous (To confirm), not paid and not silently unlinked',
    JSON.stringify(amb.map(a => (a.hits || []).map(h => h.id))));
  const plain = observe([renamed({ notes: 'item: Acme Power' })], ident);
  ok(hits(plain, POWER).length === 1 && hits(plain, WATER).length === 0, 'without the recurring link the note links');
  const recurringOnly = observe([renamed({ recurring_id: '5550001' })], ident);
  ok(hits(recurringOnly, WATER).length === 1 && hits(recurringOnly, POWER).length === 0, 'without the note the recurring link links');
  const agree = observe([renamed({ notes: 'item: Acme Water', recurring_id: '5550001' })],
    identityWith({}, { lunchMoneyRecurringIds: ['5550001'], lunchMoneyItemNames: ['Acme Water'] }));
  ok(hits(agree, WATER).length === 1, 'recurring link and item note naming the SAME bill: that bill, counted once');
}

console.log('\n=== an item note outranks a different bill\'s payee match, counted once ===');
{
  // POWER's payee rule matches "ACME POWER"; WATER's item name is on the note.
  const ident = identityWith({}, { lunchMoneyItemNames: ['Acme Water'] });
  const report = observe([row({ notes: 'item: Acme Water' })], ident);
  ok(hits(report, WATER).length === 1 && hits(report, POWER).length === 0,
    'the item-noted bill takes the row; the payee-matched bill does not');
  ok(((report.currentPeriodActuals || {}).transactions || []).filter(t => t.representedBill === true).length === 1,
    'one bill payment, counted once');
  const twoItems = observe([row({ notes: 'item: Acme Water; item: Other' })], ident);
  ok(hits(twoItems, POWER).length === 1 && hits(twoItems, WATER).length === 0,
    'a note with two item parts links nothing by note, so the payee rule still applies');
}

console.log('\n=== the rehearsal-space recurring rule is unchanged ===');
ok(require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'test-rehearsal-space-lunchmoney-recurring-settlement.js')]).status === 0,
  'test-rehearsal-space-lunchmoney-recurring-settlement passes');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
