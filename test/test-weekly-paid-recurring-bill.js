'use strict';
/* A bill tied by Lunch Money's own recurring match (or the `bill paid:` note) is paid from either household chequing
 * account (owner, Dale, #821 7168507103: bills paid from Weekly spend use the same tie as Bills; Grok Bot, rule 17,
 * 7169173042). Before: the bill's identity rule pinned atlasAccountId 'chequing-a', so a Weekly spend (chequing-b) debit
 * that Lunch Money matched to the bill's recurring item was refused on account, and the bill read unverified.
 *   1. A recurring-linked bill paid from Weekly spend links and is paid (by the row's recurring_id, by the item's
 *      foundTransactions, and by the `bill paid:` note); the Bills-paid control is unchanged.
 *   2. Still refused: a debit from a non-chequing account (Savings) or a card account; a payee-only rule (no tie) paid
 *      from Weekly; a card-minimum rule; a credit rule.
 *   3. Mutant: restoring the account pin makes the Weekly-paid bill unverified again.
 * Invented world: test/acceptance/harness.js as of 2026-10-14, one invented streaming bill of $25 due Oct 12, recurring
 * item 555 (invented), its rule naming Bills (chequing-a). Expectations are written by hand.
 * `node test/test-weekly-paid-recurring-bill.js` */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const H = require('./acceptance/harness.js');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};

const RECURRING = '555';
const STREAM = { id: 'stream', label: 'Invented streaming', amount: 25, frequency: 'monthly', day: 12, confidence: 'confirmed',
  payee: 'Invented streaming', rule: { lunchMoneyRecurringIds: [RECURRING], lunchMoneyItemNames: ['Invented streaming'] } };
const CARD = { id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 200 };
const pay = (account, extra = {}) => H.lm({ date: '2026-10-12', amount: 25, category: 'Internet', account, payee: 'Invented streaming', ...extra });
const tied = { raw: { recurring_id: Number(RECURRING) } };
const itemRead = ids => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-01', endDate: '2026-10-14' },
  items: [{ providerId: RECURRING, status: 'reviewed', unavailableFields: [],
    matches: { expectedOccurrenceDates: [], missingTransactionDates: [], foundTransactions: ids.map(id => ({ date: '2026-10-12', transactionId: id })) } }] } });

function run(october, { bill = STREAM, recurring = null, card = false, extraRules = [] } = {}) {
  const w = H.baseWorld();
  w.bills = [bill];
  if (card) {
    w.accounts.push(CARD);
    w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 200, pending: 0, rate: 0.2, limit: 3000 }];
  }
  if (recurring) w.recurringItems = recurring;
  w.identityRules = (w.identityRules || []).concat(extraRules);
  w.transactions = [pay('chequing-a', { date: '2026-09-12', ...tied }), ...october];
  const o = H.observe(w);
  if (o.error) throw o.error;
  const rec = F.recommend(o.plan, w.asOf, { currentPeriodActuals: JSON.parse(JSON.stringify(o.packet)) });
  const view = rec.payPeriodViews.find(v => (v.bills || []).some(b => b.id === bill.id && b.date === '2026-10-12'));
  const row = view.bills.find(b => b.id === bill.id && b.date === '2026-10-12');
  const linked = (o.packet.representedActuals || []).some(r => r.id === bill.id && r.date === '2026-10-12');
  return { row, linked, evidence: row.stackBillPaymentEvidence, status: row.status, settlement: row.settlement };
}

console.log('1. A recurring-linked bill paid from Weekly spend is paid');
{
  const bills = run([pay('chequing-a', tied)]);
  ok(bills.linked && bills.status === 'PAID' && bills.evidence === 'posted-verified', 'control: paid from Bills, linked and paid (unchanged; tied, so posted-verified per #1643)',
    JSON.stringify([bills.linked, bills.status, bills.evidence]));
  const weekly = run([pay('chequing-b', tied)]);
  ok(weekly.linked && weekly.status === 'PAID' && weekly.settlement === 'represented',
    'paid from Weekly with the row\'s recurring id: linked and PAID', JSON.stringify([weekly.linked, weekly.status, weekly.settlement]));
  const found = run([pay('chequing-b', { id: 990001 })], { recurring: itemRead([990001]) });
  ok(found.linked && found.status === 'PAID', 'paid from Weekly, listed under the item (foundTransactions): linked and PAID',
    JSON.stringify([found.linked, found.status]));
  const note = run([pay('chequing-b', { notes: 'bill paid: Invented streaming' })]);
  ok(note.linked && note.status === 'PAID', 'paid from Weekly with the `bill paid:` note: linked and PAID', JSON.stringify([note.linked, note.status]));
  const differs = run([pay('chequing-b', { amount: 27, ...tied })]);
  ok(differs.linked && differs.evidence === 'posted-verified' && differs.row.stackBillAmount === 27,
    'paid from Weekly at another amount: #1643 paid in full at the posted 27', JSON.stringify([differs.evidence, differs.row.stackBillAmount]));
}

console.log('2. Still refused');
{
  const savings = run([pay('savings', tied)]);
  ok(!savings.linked && savings.status !== 'PAID', 'a debit from Savings (not chequing) is refused', JSON.stringify([savings.linked, savings.status]));
  const card = run([pay('travelvisa', tied)], { card: true });
  ok(!card.linked && card.status !== 'PAID', 'a debit from a card account is refused', JSON.stringify([card.linked, card.status]));
  const payeeOnly = run([pay('chequing-b')], { bill: { ...STREAM, rule: {} } });
  ok(!payeeOnly.linked && payeeOnly.status !== 'PAID', 'a payee-only rule (no tie) paid from Weekly keeps its pin: refused',
    JSON.stringify([payeeOnly.linked, payeeOnly.status]));
  const otherItem = run([pay('chequing-b', { raw: { recurring_id: 999 } })]);
  ok(!otherItem.linked, 'a Weekly debit matched to another recurring item is refused');
  // The helper itself, for the rule kinds the world above does not carry.
  const plan = { bills: [{ id: 'stream' }] };
  const tx = { recurringId: RECURRING, pending: false };
  const accepts = O.__ruleAccountAccepts;
  ok(typeof accepts === 'function', 'the account rule is exposed for this check');
  if (typeof accepts === 'function') {
    const bill = { eventId: 'stream', atlasAccountId: 'chequing-a', direction: 'debit', lunchMoneyRecurringIds: [RECURRING] };
    ok(accepts(bill, 'chequing-b', tx, plan) === true && accepts(bill, 'chequing-a', tx, plan) === true, 'a tied bill rule accepts either household chequing');
    ok(accepts({ ...bill, eventId: 'card-minimum' }, 'chequing-b', tx, plan) === false, 'a card-minimum (not a plan bill) rule keeps its pin');
    ok(accepts({ ...bill, direction: 'credit' }, 'chequing-b', tx, plan) === false, 'a credit rule keeps its pin');
    ok(accepts({ ...bill, transactionKind: 'transfer' }, 'chequing-b', tx, plan) === false, 'a transfer rule keeps its pin');
    ok(accepts({ ...bill, atlasAccountId: 'savings' }, 'chequing-b', tx, plan) === false, 'a rule pinned to a non-chequing account keeps it');
    ok(accepts(bill, 'chequing-b', { ...tx, recurringId: null }, plan) === false, 'an untied debit keeps the pin');
    ok(accepts(bill, 'chequing-b', { ...tx, pending: true }, plan) === false, 'a pending row tied only by recurring id is not tied (#1643): pin kept');
  }
}

console.log('3. Mutant: the account pin restored');
{
  const FILE = path.join(__dirname, '..', 'scripts', 'provider-observe.js');
  const source = fs.readFileSync(FILE, 'utf8');
  // Both linking paths (the posted hit loop and collectIdentityHits) read the one helper; restore the pin in both.
  const anchor = '!ruleAccountAccepts(rule, mapping.canonical.id, tx, input.plan)';
  if (source.split(anchor).length !== 3) throw new Error('mutant anchor not found exactly twice');
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(source.split(anchor).join('(rule.atlasAccountId && mapping.canonical.id !== rule.atlasAccountId)'),
    FILE.replace(/\.js$/, '-pin-restored.js'));
  const real = { ...O };
  Object.assign(O, mod.exports);
  let m;
  try { m = run([pay('chequing-b', tied)]); } finally { Object.assign(O, real); }
  ok(!m.linked && m.status !== 'PAID', 'MUTANT (pin restored): the Weekly-paid bill is unverified again, which section 1 rejects',
    JSON.stringify([m.linked, m.status]));
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} Weekly-paid recurring bill (${checks - failures}/${checks})`);
if (failures) process.exit(1);
