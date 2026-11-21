'use strict';
/* An "item:" note replaces the bank payee wherever Atlas displays a purchase.
 * `node test/test-item-note-display-name.js`
 *
 * Display only. Bill matching, classification and Forecast keep reading the
 * original payee and descriptor. Invented data only; no provider calls.
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
const D = require('../public/display-name.js');
const CardPeriod = require('../public/forecast-card-period.js');
const shaw = require('./fixtures/shaw-posted-identity');
const configured = require('../docs/connectivity/transaction-identity.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const grab = (src, re, label) => { const m = re.exec(src); if (!m) throw new Error('missing ' + label); return m[0]; };
const clone = x => JSON.parse(JSON.stringify(x));

console.log('\n=== 1. the shared helper ===');
{
  const base = { displayedPayee: 'PAYPAL MSP', originalMerchant: 'PAYPAL *MSP 0001' };
  ok(D.displayName({ ...base, displayedNote: 'Disney+' }) === 'Disney+', 'item text replaces the payee');
  ok(D.displayName(base) === 'PAYPAL MSP', 'no note: the payee as shown today');
  ok(D.displayName({ originalMerchant: 'ORIG' }) === 'ORIG', 'no displayed payee: the original merchant, as today');
  ok(D.displayName({}, 'Card transaction') === 'Card transaction' && D.displayName(null) === '', 'fallbacks');
  ok(D.displayName({ ...base, displayedNote: '   ' }) === 'PAYPAL MSP', 'empty item text falls back to the payee');
  ok(D.displayName({ ...base, displayedNote: { a: 1 } }) === 'PAYPAL MSP', 'non-string note is ignored');
  ok(D.displayName({ ...base, displayedNote: 'x'.repeat(100) }) === 'x'.repeat(59) + '…', 'long text is capped at 60');
  ok(D.displayName({ ...base, displayedNote: 'A\u0001  B' }) === 'A B', 'control characters and runs of spaces collapse');
  const row = { ...base, displayedNote: 'Disney+' }, before = JSON.stringify(row);
  D.displayName(row); D.itemName(row);
  ok(JSON.stringify(row) === before, 'the helper never rewrites the row');
  const pending = { id: 'p', pending: true, ...base, displayedNote: 'Movie - Dune' };
  const posted = { id: 'q', pending: false, ...base, displayedNote: 'Movie - Dune' };
  ok(D.displayName(pending) === D.displayName(posted), 'pending and posted versions of one purchase show the same name');
}

console.log('\n=== 2. matching ignores the note: a debit with an item note still settles its bill ===');
const identity = () => ({ schema: configured.schema, rules: clone(configured.rules.filter(r => r.eventId === 'shaw')) });
function observe(notes, extraTxs) {
  const x = { ...shaw('04', 'Shaw'), identity: identity() };
  x.payload.transactions[0].notes = notes;
  if (extraTxs) x.payload.transactions.push(...extraTxs);
  if (extraTxs) x.payload.categories.push({ id: 9912, name: 'Groceries', is_income: false, is_group: false,
    archived: false, exclude_from_budget: false, exclude_from_totals: false });
  const live = Live.fromObservation(x);
  const packet = live.data.liveOverlay.currentPeriodActuals;
  const advice = F.recommend(live.data.plan, x.asOf, { debts: [], currentPeriodActuals: packet, weeklyVariable: 0 });
  const period = advice.payPeriodViews.find(p => p.start <= x.asOf && p.end >= x.asOf);
  return { x, live, packet, advice, period };
}
const stripDisplay = v => JSON.stringify(v, (k, val) => (k === 'displayedNote' ? undefined : val));
{
  const without = observe(null);
  const withItem = observe('item: Invented Cable Plan');
  const wBill = without.period.bills.find(b => b.id === 'shaw');
  const nBill = withItem.period.bills.find(b => b.id === 'shaw');
  ok(wBill.status === 'PAID' && nBill.status === 'PAID' && nBill.settlement === wBill.settlement,
    'the bill settles exactly as without the note');
  ok(stripDisplay(withItem.packet) === stripDisplay(without.packet),
    'the packet is identical with and without the note (a bill-settling row is published with no name at all)');
  ok(stripDisplay(withItem.advice) === stripDisplay(without.advice),
    'Forecast output is identical with and without the note (figures: 0 changed)');
  ok(JSON.stringify(withItem.live.report.representedEventCandidates) === JSON.stringify(without.live.report.representedEventCandidates),
    'the settlement candidates are identical');
}

// Section 3 (the classic Spent breakdown printed the item, never the payee) retired with the classic page
// (C1 S4 batch B1, owner ruling: V1-only behaviour retires). Sections 1-2 and 4-6 keep the Forecast and
// observer-level facts: the item is carried, the payee and descriptor are untouched, matching never reads it.

console.log('\n=== 4. end to end from the observer: item shown in recon, payee kept for matching ===');
{
  const extra = { id: 'invented-paypal-1', account_id: 3001, date: '2031-04-13', amount: 9.99, currency: 'cad',
    is_pending: false, category_id: 9912, payee: 'PAYPAL MSP', original_name: 'PAYPAL *MSP 0001',
    notes: 'item: Disney+\nsecond line stays hidden' };
  const r = observe(null, [extra]);
  const recon = r.period.householdBudget.flatMap(row => row.recon || []);
  const row = recon.find(t => t.displayedPayee === 'PAYPAL MSP');
  ok(row && row.displayedNote === 'Disney+' && D.displayName(row) === 'Disney+' && row.originalMerchant === 'PAYPAL *MSP 0001',
    'recon row: displayName is the item; payee and descriptor are untouched');
  ok(!/second line/.test(JSON.stringify(r.packet)), 'other note text is still never published');
  const bill = r.period.bills.find(b => b.id === 'shaw');
  ok(bill && bill.status === 'PAID', 'the bill still settles beside it');
}

console.log('\n=== 5. card movements carry the item beside the unchanged payee ===');
{
  const src = read('public/forecast-card-period.js');
  const cm = read('public/budget-card-movements.js');
  ok(/DisplayName\.itemName\(tx\)/.test(src) && /payee: typeof tx\.displayedPayee === 'string'/.test(src),
    'published movement keeps `payee` and adds `displayName` only through the helper');
  ok(/tx\.displayName[\s\S]{0,40}tx\.payee/.test(cm), 'the card movement list shows displayName, else the payee');
  ok(CardPeriod && typeof CardPeriod.publish === 'function', 'card period module loads with the helper');
}

console.log('\n=== 6. matching code never reads the display name or note ===');
{
  const fsrc = read('public/forecast.js');
  ok(!/DisplayName|displayName|itemName/.test(fsrc), 'forecast.js does not call the display helper');
  const obs = read('scripts/provider-observe.js');
  ok(!/DisplayName|display-name/.test(obs), 'the observer does not call the display helper');
  const plansrc = read('public/plan.js');
  const uses = plansrc.split('\n').filter(l => /DisplayName/.test(l));
  ok(uses.length > 0 && uses.every(l => /payeeRaw =|aLabel =|bLabel =|label: tx &&|^\s*\/\//.test(l)),
    'plan.js uses the helper only for display text and ordering');
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll item note display-name checks passed.');
