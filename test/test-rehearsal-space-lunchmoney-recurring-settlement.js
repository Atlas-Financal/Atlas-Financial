'use strict';
/* Band rehearsal space settles from the Lunch Money recurring link alone
 * (owner 2026-11-11, Dale via Money 8:02 PM PT: "the band rehearsal money is
 * a bill, so we can mark the bill as paid").
 *
 * Synthetic provider rows and synthetic amounts only. Expected outcomes are
 * stated per row, not read back from the matcher under change (L-002).
 *
 * `node test/test-rehearsal-space-lunchmoney-recurring-settlement.js`
 */
const fs = require('fs');
const path = require('path');
const O = require('../scripts/provider-observe.js');
const Live = require('../scripts/live-plan.js');

const ROOT = path.join(__dirname, '..');
const load = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const clone = v => JSON.parse(JSON.stringify(v));
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const ID = 'rehearsal-space';
const RECURRING = 3667755;
const TX_ID = 2530010553;
const DUE = '2026-11-01';
const canonicalText = fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8');
const canonical = JSON.parse(canonicalText);
const accountMap = load('docs/connectivity/fixtures/provider-account-map.json');
const identity = load('docs/connectivity/transaction-identity.json');
const bill = canonical.plan.bills.find(b => b && b.id === ID);
const SCHEDULED = Number(bill && bill.amount);

function payload(txs) {
  const base = load('docs/connectivity/fixtures/automatic-payment-settlement.json');
  base.accounts = base.accounts.map(a => Object.assign(a, {
    updated_at: '2026-11-03T15:55:00.000Z', balance_last_update: '2026-11-03T15:55:00.000Z' }));
  return Object.assign(base, {
    fetchedAt: '2026-11-03T16:00:00.000Z',
    source: 'Synthetic rehearsal-space recurring settlement fixture. Not a live institution pull.',
    transactionWindow: { startDate: '2026-10-25', endDate: '2026-11-03', complete: true, hasMore: false, truncated: false },
    transactions: txs,
  });
}
function row(extra) {
  return Object.assign({ id: TX_ID, account_id: 1001, date: DUE, amount: SCHEDULED, currency: 'cad',
    is_pending: false, payee: 'Send E-Tfr', original_name: 'SEND E-TFR ***ABC', recurring_id: RECURRING }, extra || {});
}
function observe(txs, ident) {
  return O.observe({ provider: 'lunchmoney', payload: payload(txs), accountMap, data: clone(canonical),
    identity: ident || identity });
}
const hits = (report, id) => (report.representedEventCandidates || []).filter(c => c && c.id === (id || ID));

console.log('\n=== configuration ===');
{
  const rules = identity.rules.filter(r => r && r.eventId === ID);
  ok(rules.length === 1 && JSON.stringify(rules[0].lunchMoneyRecurringIds) === JSON.stringify([String(RECURRING)])
      && rules[0].atlasAccountId === 'chequing-a' && rules[0].direction === 'debit'
      && rules[0].requiredPostingEvidence === 'posted' && rules[0].requiredCurrency === 'cad'
      && !rules[0].payeePattern && !rules[0].payeePatterns && !rules[0].originalNamePatterns && !rules[0].settlesWhen,
    'one rehearsal-space rule: recurring id only, BILLS debit, posted CAD; no payee, descriptor or amount identity');
  const others = identity.rules.filter(r => r && r.eventId !== ID && Object.hasOwn(r, 'lunchMoneyRecurringIds'));
  ok(others.length === 0, 'no other rule is configured with a recurring id');
  ok(bill && bill.frequency === 'monthly' && bill.firstDue === DUE, 'rehearsal-space bill is monthly from 2026-11-01 (unchanged)');
}

console.log('\n=== the recurring link settles the Nov occurrence ===');
const linked = observe([row()]);
{
  const h = hits(linked);
  ok(h.length === 1 && h[0].date === DUE && h[0].providerTransactionId === String(TX_ID),
    'tx 2530010553 with recurring 3667755 identifies the 2026-11-01 occurrence', JSON.stringify(h.map(x => [x.date, x.providerTransactionId, x.identity])));
  const result = Live.overlayLiveState({ data: clone(canonical), report: linked });
  const rep = ((result.data.plan.opening || {}).representedEvents || []).filter(e => e && e.id === ID);
  ok(rep.some(e => e.date === DUE), 'live overlay marks rehearsal-space 2026-11-01 represented (Paid)', JSON.stringify(rep));
  ok(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8') === canonicalText, 'canonical data.json is not mutated');
}

console.log('\n=== nothing but the link settles it ===');
{
  ok(hits(observe([row({ recurring_id: null })])).length === 0, 'the same row without the recurring link does not settle it');
  ok(hits(observe([row({ recurring_id: 9999999 })])).length === 0, 'a different recurring id does not settle it');
  ok(hits(observe([row({ id: 7001, recurring_id: null, payee: 'Interac e-Transfer', original_name: 'SEND E-TFR ***XYZ' })])).length === 0,
    'a generic e-transfer of the same amount without the link does not settle it');
  ok(hits(observe([row({ recurring_id: null, notes: 'Band rehearsal space', payee: 'Band rehearsal space' })])).length === 0,
    'notes and a payee that read "Band rehearsal space" are ignored without the link');
  const noteVaried = hits(observe([row({ notes: 'anything else entirely' })]));
  ok(noteVaried.length === 1 && noteVaried[0].date === DUE, 'with the link, notes text does not matter');
  ok(hits(observe([row({ is_pending: true })])).length === 0, 'a pending linked row does not settle it');
  ok(hits(observe([row({ account_id: 1002 })])).length === 0, 'a linked row on another account does not settle it');
  ok(hits(observe([row({ amount: -SCHEDULED })])).length === 0, 'a linked credit does not settle it');
}

console.log('\n=== other bills are unchanged ===');
{
  const noRule = clone(identity);
  noRule.rules = noRule.rules.filter(r => r.eventId !== ID);
  const strip = r => JSON.stringify((r.representedEventCandidates || []).filter(c => c.id !== ID));
  const fixtureTxs = load('docs/connectivity/fixtures/automatic-payment-settlement.json').transactions;
  ok(strip(observe(fixtureTxs.concat([row()]))) === strip(observe(fixtureTxs.concat([row()]), noRule)),
    'every other bill candidate is identical with or without the rehearsal-space rule');
  ok(hits(observe([row()]), 'bell').length === 0 && hits(observe([row()]), 'shaw').length === 0,
    'the linked row settles no other bill');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
