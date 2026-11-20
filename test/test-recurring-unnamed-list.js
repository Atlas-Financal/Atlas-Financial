'use strict';
/* The assistant packet lists the reviewed Lunch Money recurring items no identity rule names (lead dispatch,
 * 2026-11-20), so the team can write the lunchMoneyRecurringIds links: uncertainty.recurringScheduleRefusals.unnamed.
 * Each entry carries the numeric id (a string of digits), granularity, quantity, anchor, start and end dates, the Atlas
 * role of the item's account and the dates of the transactions Lunch Money found for it, and nothing else. An item whose
 * schedule did not read is listed as unavailable (its id only), never guessed. A named item and a suggestion are not listed.
 *
 * Invented data only: test/acceptance/harness.js (band-room bill). By hand, on the invented payload below:
 *   7123458  reviewed, no rule names it, monthly x1, anchor 2026-01-20, start 2026-01-01, found on 09-20 (twice) and 08-20
 *            -> listed, foundDates [2026-08-20, 2026-09-20], account role household-cash (provider account 9001).
 *   7123459  reviewed, no rule names it, biweekly (week x2), no start/end, no account, nothing found -> listed, dates [].
 *   7123457  reviewed and named by the band rule -> not listed (it is applied or refused, never here).
 *   7123460  a suggestion (not reviewed) -> not listed.
 *   7123461  reviewed, unnamed, granularity 'fortnight' (not one of day/week/month/year) -> listed unavailable.
 *   7123462  reviewed, unnamed, criteria marked unavailable by the read -> listed unavailable.
 *   'rec-abc' reviewed, unnamed, but its id is not a Lunch Money recurring id -> not listed (counted only).
 *
 *   node test/test-recurring-unnamed-list.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const Assistant = require('../scripts/assistant-packet');
const O = require('../scripts/provider-observe.js');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NAMED = '7123457';
const BILL = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 20, firstDue: '2026-10-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
// What must never reach the packet, present in the input on purpose.
const SECRETS = ['Invented Payee Co', 'invented description text', 'invented note text', 'Invented Category', '123.4500', '98765', '9001', '610002', '610003', 'cad'];
const privacy = extra => ({ payee: 'Invented Payee Co', description: 'invented description text', notes: 'invented note text',
  category: 'Invented Category', ...extra });
const item = (id, status, { criteria = {}, matches = {}, unavailableFields = [], extra = {} } = {}) => ({
  providerId: id, status, unavailableFields, ...privacy(extra),
  criteria: { startDate: '2026-01-01', endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-01-20', amount: '123.4500',
    currency: 'CAD', plaidAccountId: '9001', manualAccountId: null, ...privacy(), ...criteria },
  matches: { expectedOccurrenceDates: ['2026-10-20'], foundTransactions: [], missingTransactionDates: ['2026-10-20'], ...matches } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-11-14' }, items } });
const rule = (eventId, ids) => ({ eventId, lunchMoneyRecurringIds: ids, atlasAccountId: 'chequing-a',
  direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted',
  postingDateRule: 'covers-early-or-due-on-or-before-posting' });

function serve(recurringItems, { rules = [rule('band', [NAMED])] } = {}, observer = O) {
  const w = H.baseWorld('2026-10-14');
  w.bills = [BILL];
  w.identityRules = w.identityRules.concat(rules);
  w.transactions = [H.lm({ id: 659999, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)),
    payload: { ...H.rawPayload(w), recurringItems }, accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  return r.data;
}
const packetOf = data => Assistant.buildPacket({ data, periods: { periods: {} }, questionsMarkdown: '', env: {}, now: '2026-10-14T19:00:00Z' });
const listOf = data => packetOf(data).uncertainty.recurringScheduleRefusals.unnamed;

const PAYLOAD = () => read([
  item(NAMED, 'reviewed', { matches: { foundTransactions: [{ date: '2026-10-01', transactionId: 610002 }] } }),
  item('7123458', 'reviewed', { matches: { foundTransactions: [{ date: '2026-09-20', transactionId: 610002 },
    { date: '2026-08-20', transactionId: 610003 }, { date: '2026-09-20', transactionId: 98765 }] } }),
  item('7123459', 'reviewed', { criteria: { granularity: 'week', quantity: 2, startDate: null, plaidAccountId: null, anchorDate: '2026-10-02' } }),
  item('7123460', 'suggested'),
  item('7123461', 'reviewed', { criteria: { granularity: 'fortnight' } }),
  item('7123462', 'reviewed', { unavailableFields: ['criteria'] }),
  item('rec-abc', 'reviewed'),
]);

console.log('1. The list: ids, cadence, dates and the account role only; the named item, the suggestion and a non-id are out');
const data = serve(PAYLOAD());
const list = listOf(data);
{
  ok(list.status === 'ok' && list.count === 4 && list.listed === 4 && list.complete === true,
    'four unnamed reviewed items are listed (7123458, 7123459, 7123461, 7123462)', JSON.stringify([list.count, list.listed]));
  const byId = Object.fromEntries(list.items.map(i => [i.recurringId, i]));
  ok(same(list.items.map(i => i.recurringId), ['7123458', '7123459', '7123461', '7123462']), 'ordered by numeric id');
  ok(same(byId['7123458'], { recurringId: '7123458', status: 'read', granularity: 'month', quantity: 1, anchorDate: '2026-01-20',
    startDate: '2026-01-01', endDate: null, accountRole: 'household-cash', foundDates: ['2026-08-20', '2026-09-20'] }),
  '7123458: cadence, anchor, start, account role and the found dates (sorted, one per day)', JSON.stringify(byId['7123458']));
  ok(same(byId['7123459'], { recurringId: '7123459', status: 'read', granularity: 'week', quantity: 2, anchorDate: '2026-10-02',
    startDate: null, endDate: null, accountRole: null, foundDates: [] }),
  '7123459: no start date, no account role and nothing found read as null / empty, not guessed', JSON.stringify(byId['7123459']));
  ok(!(NAMED in byId) && !('7123460' in byId) && !('rec-abc' in byId), 'the named item, the suggestion and a non-numeric id are not listed');
}

console.log('2. Malformed items are listed unavailable, with their id only');
{
  const byId = Object.fromEntries(list.items.map(i => [i.recurringId, i]));
  for (const id of ['7123461', '7123462']) {
    ok(same(byId[id], { recurringId: id, status: 'unavailable', reason: 'schedule-unreadable' }), id + ': unavailable, its id and one closed reason');
  }
  const bad = serve(read([item('7123470', 'reviewed', { criteria: { quantity: 0 } }), item('7123471', 'reviewed', { criteria: { anchorDate: '2026-02-30' } }),
    item('7123472', 'reviewed', { criteria: { startDate: 'tomorrow' } }), item('7123473', 'reviewed', { matches: { foundTransactions: [{ date: '2026-13-01', transactionId: 1 }] } }),
    item('7123474', 'reviewed', { matches: { foundTransactions: null } })]));
  ok(listOf(bad).items.length === 5 && listOf(bad).items.every(i => i.status === 'unavailable'),
    'quantity 0, a day that does not exist, a start that is not a date, a found date that is not a date and a missing found list are all unavailable',
    JSON.stringify(listOf(bad).items.map(i => i.recurringId + ':' + i.status)));
}

console.log('3. Nothing but the closed fields reaches the packet (payee, description, notes, category, amount, currency, ids)');
{
  const text = JSON.stringify(packetOf(data));
  for (const secret of SECRETS) ok(!text.includes(secret), 'the packet never carries "' + secret + '", though the input does');
  ok(!/foundTransactionLocalIds|expectedDates|transactionId|plaidAccountId|manualAccountId/.test(JSON.stringify(list)), 'no local or provider transaction id, expected date list or provider account id in the list');
  for (const entry of list.items) {
    ok(Object.keys(entry).every(k => ['recurringId', 'status', 'granularity', 'quantity', 'anchorDate', 'startDate', 'endDate', 'accountRole', 'foundDates', 'reason'].includes(k)),
      entry.recurringId + ': only closed keys', Object.keys(entry).join(','));
  }
  // A polluted block (a stored or replayed one) cannot widen the packet: the projection copies the closed fields one by one.
  const polluted = JSON.parse(JSON.stringify(data));
  const block = polluted.liveOverlay.currentPeriodActuals.lunchMoneyRecurring;
  block.unnamed[0] = { ...block.unnamed[0], payee: 'Invented Payee Co', amount: '123.4500', description: 'invented description text' };
  const pollutedText = JSON.stringify(listOf(polluted));
  ok(!/Invented Payee Co|123\.4500|invented description text/.test(pollutedText), 'extra fields on a stored entry never reach the packet (copied field by field)');
  // The block's own sanitizer refuses an entry with an extra field, so a polluted one cannot be stored either.
  ok(!O.currentPeriodActualsLooksSanitized({ ...data.liveOverlay.currentPeriodActuals, lunchMoneyRecurring: block }),
    'the observation sanitizer rejects an unnamed entry carrying a payee, amount or description');
  ok(O.currentPeriodActualsLooksSanitized(data.liveOverlay.currentPeriodActuals), 'control: the real block passes the sanitizer');
}

console.log('4. Counts and neighbours: the old drop counts and the refusals are untouched');
{
  const refusals = packetOf(data).uncertainty.recurringScheduleRefusals;
  ok(refusals.notApplied.notNamed === 5 && refusals.notApplied.notReviewed === 1 && refusals.notApplied.scheduleInvalid === 0,
    'notApplied still counts every unnamed reviewed item (including the non-id), every suggestion and nothing twice', JSON.stringify(refusals.notApplied));
  ok(refusals.status === 'ok' && Array.isArray(refusals.items), 'the refusals list is still served beside the unnamed list');
  ok(listOf(serve(read([item(NAMED, 'reviewed')]))).count === 0 && listOf(serve(read([item(NAMED, 'reviewed')]))).complete === true,
    'only a named item: the unnamed list is empty, not missing');
  const failed = packetOf(serve({ status: 'unavailable', reason: 'recurring-read-failed' })).uncertainty.recurringScheduleRefusals;
  ok(failed.status === 'unavailable', 'a failed recurring read is unavailable as before, with no list');
}

console.log('5. MUTANTS: the sanitizer and the projection each keep a leaked field out');
{
  const file = require.resolve('../scripts/provider-observe.js');
  const src = fs.readFileSync(file, 'utf8');
  const load = mutated => {
    const m = new Module(file, null);
    m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(mutated, file);
    return m.exports;
  };
  const leak = "foundDates: Array.from(new Set(found.map(f => f && f.date))).sort() };";
  ok(src.includes(leak), 'the mutant targets the entry builder');
  // The builder also copies the item's amount: the strict check turns the entry unavailable, so the amount never leaves.
  const withAmount = load(src.replace(leak, "foundDates: Array.from(new Set(found.map(f => f && f.date))).sort(), amount: c.amount };"));
  ok(typeof withAmount.sanitizedRecurringEvidence === 'function', 'the mutated module loads and exports the sanitizer');
  const entries = withAmount.sanitizedRecurringEvidence(PAYLOAD(), { identityRules: [rule('band', [NAMED])],
    accountMap: H.accountMapOf(H.baseWorld('2026-10-14')), existingLocalId: () => null, refused: [] }).unnamed;
  ok(entries.length === 4 && entries.every(e => e.status === 'unavailable') && !JSON.stringify(entries).includes('123.4500'),
    'MUTANT: an entry builder that copies the amount fails its own closed-shape check, so every entry reads unavailable and no amount leaves',
    JSON.stringify(entries.map(e => e.recurringId + ':' + e.status)));
  // A validator that lets any key through: a polluted entry would pass the observation sanitizer, so this check must fail it.
  const lax = src.replace("entry.status === 'read' && keysAre(entry, RECURRING_UNNAMED_READ_KEYS)", "entry.status === 'read'");
  ok(lax !== src, 'the second mutant targets the closed-keys check');
  const laxO = load(lax);
  const block = JSON.parse(JSON.stringify(data.liveOverlay.currentPeriodActuals));
  block.lunchMoneyRecurring.unnamed[0] = { ...block.lunchMoneyRecurring.unnamed[0], amount: '123.4500' };
  ok(laxO.currentPeriodActualsLooksSanitized(block) === true && O.currentPeriodActualsLooksSanitized(block) === false,
    'MUTANT: without the closed-keys check an entry with an amount passes the sanitizer; the real one rejects it');
}

console.log(failures ? `\n${failures} failure(s)` : `\nAll recurring unnamed-list checks passed (${checks}).`);
process.exit(failures ? 1 : 0);
