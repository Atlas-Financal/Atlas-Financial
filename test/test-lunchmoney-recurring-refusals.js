'use strict';
/* Part (b) (lead dispatch 2026-11-17, Option S ruling): each reviewed Lunch
 * Money recurring item Atlas did not apply is recorded where the one review
 * refuses it, served as {billId, obligationId, reasonCode} (Atlas plan row
 * ids or null, one closed code), and published by the assistant packet as a
 * fixed sentence. No Lunch Money id, amount, payee or date; nothing renders
 * it on the page; replay memory reproduces it.
 *
 * Invented data only: test/acceptance/harness.js (band-room bill) and
 * test/fixtures/card-backfill-data (card minimum).
 *
 *   node test/test-lunchmoney-recurring-refusals.js
 */
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe.js');
const Assistant = require('../scripts/assistant-packet');
const ObservationMemory = require('../scripts/server-observation-memory.js');
const cardSource = require('./fixtures/card-backfill-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ID = '7123457', ID2 = '7123458', AMOUNT = '80.0000';
const BILL = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 20, firstDue: '2026-10-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
const item = ({ id = ID, granularity = 'month', quantity = 1, anchorDate = '2026-01-20', startDate = '2026-01-01',
  expected = ['2026-10-20'], amount = AMOUNT } = {}) => ({
  providerId: id, status: 'reviewed', unavailableFields: [],
  criteria: { startDate, endDate: null, granularity, quantity, anchorDate, amount, currency: 'CAD', plaidAccountId: '9001', manualAccountId: null },
  matches: { expectedOccurrenceDates: expected, foundTransactions: [], missingTransactionDates: expected } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-11-14' }, items } });
const rule = (eventId, ids) => ({ eventId, linkedFrom: '2026-01-01', lunchMoneyRecurringIds: ids, atlasAccountId: 'chequing-a',
  direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
  postingDateRule: 'covers-early-or-due-on-or-before-posting' });

function serve(recurringItems, { bill = {}, rules = [rule('band', [ID])], replay = false } = {}) {
  const w = H.baseWorld('2026-10-14');
  w.bills = [{ ...BILL, ...bill }];
  w.identityRules = w.identityRules.concat(rules);
  w.transactions = [H.lm({ id: 659999, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (replay) recurringItems = ObservationMemory.sourceInputs({ provider: 'lunchmoney', fetchedAt: '2026-10-14T18:00:00.000Z',
    accounts: [], categories: [], tags: [], transactions: [],
    transactionWindow: { startDate: '2026-09-30', endDate: '2026-10-14', complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, hasMore: false, truncated: false, basis: 'is_pending-unbounded' },
    recurringItems }).recurringItems;
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)),
    payload: { ...H.rawPayload(w), recurringItems }, accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const block = r.data.liveOverlay.currentPeriodActuals && r.data.liveOverlay.currentPeriodActuals.lunchMoneyRecurring;
  return { data: r.data, block, bill: r.data.plan.bills.find(b => b.id === 'band') };
}
const packetOf = data => Assistant.buildPacket({ data, periods: { periods: {} }, questionsMarkdown: '', env: {}, now: '2026-10-14T19:00:00Z' });
const refusalsOf = data => packetOf(data).uncertainty.recurringScheduleRefusals;
const band = code => [{ billId: 'band', obligationId: null, reasonCode: code }];

console.log('1. An applied item is not refused; each refused bill item is served with its plan row and one code');
{
  const applied = serve(read([item({ anchorDate: '2026-01-04', expected: ['2026-10-04'] })]));
  ok(applied.bill.day === 4 && applied.bill.dateConfidence === 'confirmed', 'control: the day leads');
  ok(same(applied.block.refused, []), 'control: nothing refused', JSON.stringify(applied.block.refused));
  const cases = [
    ['cadence-unmapped', read([item({ granularity: 'week', quantity: 1, anchorDate: '2026-10-06', expected: ['2026-10-06', '2026-10-13'] })])],
    ['cadence-amount-unconfirmed', read([item({ granularity: 'week', quantity: 2, anchorDate: '2026-10-16', expected: ['2026-10-02', '2026-10-16'], amount: '40.0000' })])],
    ['expected-dates-mismatch', read([item({ granularity: 'week', quantity: 2, anchorDate: '2026-10-16', expected: ['2026-10-09'] })])],
    ['date-invalid', read([item({ granularity: 'week', quantity: 2, anchorDate: '2026-02-30', expected: [] })])],
    ['not-started', read([item({ startDate: '2026-11-01' })])],
  ];
  for (const [code, rd] of cases) {
    const s = serve(rd);
    ok(same(s.block.refused, band(code)), code + ': served as band and its code', JSON.stringify(s.block.refused));
    ok(s.bill.day === 20 && s.bill.dateConfidence === 'estimated', code + ': the plan\'s schedule stands');
    const p = refusalsOf(s.data);
    ok(p.status === 'ok' && p.count === 1 && p.complete === true && same(p.items, [{ key: 'refused-1', billId: 'band',
      obligationId: null, reasonClass: Assistant.RECURRING_REFUSALS[code][0], reason: Assistant.RECURRING_REFUSALS[code][1] }]),
    code + ': the packet reads its fixed sentence', JSON.stringify(p.items));
  }
  ok(same(serve(read([item()]), { bill: { frequency: 'once', date: '2026-10-20' } }).block.refused, band('once-bill')), 'once-bill');
  ok(same(serve(read([item()]), { bill: { payingAccount: 'reserve' } }).block.refused, band('account-mismatch')), 'account-mismatch');
  ok(same(serve(read([item(), item({ id: ID2 })]), { rules: [rule('band', [ID, ID2])] }).block.refused,
    band('several-items').concat(band('several-items'))), 'several-items: both items, each with the bill');
}

console.log('2. When no single plan row is named, the row reads null');
{
  const two = serve(read([item()]), { rules: [rule('band', [ID]), rule('other-bill', [ID])] });
  ok(same(two.block.refused, [{ billId: null, obligationId: null, reasonCode: 'several-rules' }]), 'several-rules: null', JSON.stringify(two.block.refused));
  const ghost = serve(read([item()]), { rules: [rule('ghost-bill', [ID])] });
  ok(same(ghost.block.refused, [{ billId: null, obligationId: null, reasonCode: 'no-plan-row' }]), 'no-plan-row: null', JSON.stringify(ghost.block.refused));
}

console.log('3. A card minimum refused by the obligation path names its obligation');
{
  const ID3 = '7123470';
  const card = (criteria, expected) => {
    const x = cardSource('triangle', 'triangle');
    x.asOf = '2026-10-05';
    x.data.meta.asOf = '2026-10-02'; x.data.plan.opening.asOf = '2026-10-02'; x.data.plan.windowDays = 28;
    x.data.plan.income[0].anchor = '2026-10-02';
    x.data.plan.obligations[0] = { id: 'triangle', debtId: 'triangle', effect: 'payment', label: 'Invented card minimum',
      frequency: 'monthly', day: 7, firstDue: '2026-10-07', amount: 88.88, confidence: 'estimated', payingAccount: 'chequing-a',
      statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08', minimum: 91.23, currency: 'cad', confidence: 'confirmed' }] };
    x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
    x.payload.transactionWindow = { startDate: '2026-10-02', endDate: x.asOf, complete: true, hasMore: false, truncated: false };
    x.payload.transactions = [];
    x.payload.accounts.forEach(a => { a.updated_at = x.asOf + 'T17:00:00Z'; a.balance_last_update = x.asOf + 'T17:00:00Z'; });
    x.identity = { ...x.identity, rules: x.identity.rules.map(r => r.eventId === 'triangle' ? { ...r, lunchMoneyRecurringIds: [ID3] } : r) };
    x.payload.recurringItems = { status: 'read', read: { unexpectedPaginationEvidence: false,
      requestedWindow: { startDate: '2026-10-02', endDate: '2026-11-05' },
      items: [{ providerId: ID3, status: 'reviewed', unavailableFields: [],
        criteria: { startDate: '2026-01-01', endDate: null, granularity: 'month', quantity: 1, amount: '88.8800',
          currency: 'CAD', plaidAccountId: '3001', manualAccountId: null, ...criteria },
        matches: { expectedOccurrenceDates: expected, foundTransactions: [], missingTransactionDates: expected } }] } };
    return Live.fromObservation(x).data;
  };
  const tri = code => [{ billId: null, obligationId: 'triangle', reasonCode: code }];
  const late = card({ anchorDate: '2026-01-09' }, ['2026-10-09']);
  ok(same(late.liveOverlay.currentPeriodActuals.lunchMoneyRecurring.refused, tri('day-after-statement-due')),
    'day 9, past the statement\'s due day 8', JSON.stringify(late.liveOverlay.currentPeriodActuals.lunchMoneyRecurring.refused));
  const ended = card({ anchorDate: '2026-01-05', endDate: '2026-12-31' }, ['2026-10-05']);
  ok(same(ended.liveOverlay.currentPeriodActuals.lunchMoneyRecurring.refused, tri('item-ended')), 'an ended item');
  ok(same(refusalsOf(ended).items.map(i => [i.billId, i.obligationId]), [[null, 'triangle']]), 'the packet names the obligation');
}

console.log('4. Negative: no Lunch Money id, amount or raw code reaches the packet');
{
  const s = serve(read([item({ granularity: 'week', quantity: 2, anchorDate: '2026-10-16', expected: ['2026-10-02', '2026-10-16'], amount: '40.0000' })]));
  const blob = JSON.stringify(packetOf(s.data));
  for (const v of [ID, '40.0000', '40.00', '"cadence-amount-unconfirmed"']) ok(!blob.includes(v), 'packet has no ' + v);
  ok(!JSON.stringify(s.block.refused).match(/\d{5,}|40/), 'the served refusals hold no provider id or amount');
  ok(Assistant.looksSanitized(packetOf(s.data)), 'the packet still passes its sanitization check');
}

console.log('5. The served shape check rejects anything outside the closed shape');
{
  const s = serve(read([item({ granularity: 'week', quantity: 1, anchorDate: '2026-10-06', expected: ['2026-10-06', '2026-10-13'] })]));
  const packet = s.data.liveOverlay.currentPeriodActuals;
  const check = refused => O.currentPeriodActualsLooksSanitized({ ...packet, lunchMoneyRecurring: { ...packet.lunchMoneyRecurring, refused } });
  ok(check(packet.lunchMoneyRecurring.refused) === true, 'the served block passes');
  ok(check([]) === true, 'an empty list passes');
  const bad = {
    'an LM recurring id as the bill': [{ billId: ID, obligationId: null, reasonCode: 'cadence-unmapped' }],
    'an amount slipping in': [{ billId: 'band', obligationId: null, reasonCode: 'cadence-unmapped', amount: 80 }],
    'a recurring id field': [{ billId: 'band', obligationId: null, reasonCode: 'cadence-unmapped', recurringId: ID }],
    'an unknown code': [{ billId: 'band', obligationId: null, reasonCode: 'payee was ACME' }],
    'both ids': [{ billId: 'band', obligationId: 'triangle', reasonCode: 'cadence-unmapped' }],
    'free text as an id': [{ billId: 'Invented band room', obligationId: null, reasonCode: 'cadence-unmapped' }],
    'a missing field': [{ billId: 'band', reasonCode: 'cadence-unmapped' }],
    'not a list': { billId: 'band' },
  };
  for (const [why, refused] of Object.entries(bad)) ok(check(refused) === false, 'rejects ' + why);
  const { refused: _, ...withoutList } = packet.lunchMoneyRecurring;
  ok(O.currentPeriodActualsLooksSanitized({ ...packet, lunchMoneyRecurring: withoutList }) === false, 'rejects a read block with no list');
}

console.log('6. The packet closes every field and says unavailable without a review');
{
  const s = serve(read([item({ granularity: 'week', quantity: 1, anchorDate: '2026-10-06', expected: ['2026-10-06', '2026-10-13'] })]));
  const forged = JSON.parse(JSON.stringify(s.data));
  forged.liveOverlay.currentPeriodActuals.lunchMoneyRecurring.refused = [
    { billId: 'not-in-plan', obligationId: null, reasonCode: 'PLANTED-CODE' }];
  const p = refusalsOf(forged);
  ok(same(p.items, [{ key: 'refused-1', billId: null, obligationId: null, reasonClass: 'other', reason: 'Atlas did not apply its schedule.' }]),
    'an id outside the plan reads null; an unknown code reads the default', JSON.stringify(p.items));
  ok(!JSON.stringify(p).includes('PLANTED'), 'nothing forged passes through');
  ok(same(refusalsOf(s.data).notApplied, { notReviewed: 0, notNamed: 0, scheduleInvalid: 0 }), 'the set-aside counts are published');
  const none = JSON.parse(JSON.stringify(s.data));
  delete none.liveOverlay.currentPeriodActuals.lunchMoneyRecurring;
  ok(refusalsOf(none).status === 'unavailable', 'no review: unavailable, never an empty ok');
  ok(refusalsOf(serve(undefined).data).status === 'unavailable', 'no recurring read: unavailable');
}

console.log('7. Replay memory reproduces the refusals: the replayed served data is deep-equal');
{
  const mk = () => read([item({ granularity: 'week', quantity: 2, anchorDate: '2026-10-16', expected: ['2026-10-02', '2026-10-16'], amount: '40.0000' })]);
  const live = serve(mk()), replayed = serve(mk(), { replay: true });
  ok(same(live.block.refused, band('cadence-amount-unconfirmed')) && same(replayed.block.refused, live.block.refused), 'both refuse the same way');
  ok(isDeepStrictEqual(live.data, replayed.data), 'the replayed served data is deep-equal (memory would be stored)');
}

console.log('8. Nothing on the page or in the figures snapshot reads it');
for (const file of ['public/plan.js', 'public/app.js', 'public/budget-surface.js', 'scripts/figures-snapshot.js']) {
  const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  ok(!/lunchMoneyRecurring|recurringScheduleRefusals|reasonCode/.test(text), file + ' never reads the refusals');
}

console.log('9. One bad plan id fails only its own entry, never the whole block (lead follow-up to #1300)');
{
  // A plan id outside the served plan-id shape (capitals, an underscore).
  const odd = serve(read([item({ granularity: 'week', quantity: 1, anchorDate: '2026-10-06', expected: ['2026-10-06', '2026-10-13'] })]),
    { bill: { id: 'Band_Room' }, rules: [rule('Band_Room', [ID])] });
  ok(odd.block && odd.block.status === 'read', 'the recurring block is still read, not replaced with unavailable',
    JSON.stringify(odd.block && odd.block.status));
  ok(odd.block && odd.block.items.length === 1, 'its reviewed item is still served');
  ok(odd.block && same(odd.block.refused, [{ billId: null, obligationId: null, reasonCode: 'cadence-unmapped' }]),
    'that entry keeps its reason, with the id read as null', JSON.stringify(odd.block && odd.block.refused));
  ok(!JSON.stringify(odd.data.liveOverlay.currentPeriodActuals.lunchMoneyRecurring.refused).includes('Band_Room'),
    'the bad id is not served');
  const p = refusalsOf(odd.data);
  ok(p.status === 'ok' && p.count === 1 && p.items[0].billId === null, 'the packet lists it with no row', JSON.stringify(p.items));
  // The served check itself stays strict.
  const packet = odd.data.liveOverlay.currentPeriodActuals;
  ok(O.currentPeriodActualsLooksSanitized({ ...packet, lunchMoneyRecurring: { ...packet.lunchMoneyRecurring,
    refused: [{ billId: 'Band_Room', obligationId: null, reasonCode: 'cadence-unmapped' }] } }) === false,
  'a served entry with that id is still rejected');
}

console.log('10. The observer\'s codes and the packet\'s sentences are one closed list (#1300 follow-up)');
{
  const codes = [...O.RECURRING_REFUSAL_CODES].sort();
  const sentences = Object.keys(Assistant.RECURRING_REFUSALS).sort();
  ok(same(codes, sentences), 'every served code has exactly one sentence, and every sentence a served code',
    JSON.stringify({ onlyServed: codes.filter(c => !sentences.includes(c)), onlySentence: sentences.filter(c => !codes.includes(c)) }));
  const texts = Object.values(Assistant.RECURRING_REFUSALS).map(([, text]) => text);
  ok(texts.every(t => typeof t === 'string' && t.trim().length > 0) && new Set(texts).size === texts.length,
    'each sentence is non-empty and distinct');
}

console.log('11. An entry without a closed code is left out; the rest of the block is served (#1311 follow-up)');
{
  const raw = read([item()]);
  const block = O.sanitizedRecurringEvidence(raw, { identityRules: [rule('band', [ID])], accountMap: { provider: 'lunchmoney', mappings: [] },
    existingLocalId: () => null, refused: [
      { billId: 'band', obligationId: null, reasonCode: 'PLANTED unknown code' },
      { billId: 'band', obligationId: null },
      { billId: 'band', obligationId: null, reasonCode: 'cadence-unmapped' }] });
  ok(block.status === 'read' && block.items.length === 1, 'the block is still read and its item served');
  ok(same(block.refused, [{ billId: 'band', obligationId: null, reasonCode: 'cadence-unmapped' }]),
    'only the entry with a closed code is served', JSON.stringify(block.refused));
  ok(!JSON.stringify(block).includes('PLANTED'), 'nothing from the dropped entry is served');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Lunch Money recurring refusal checks passed.');
