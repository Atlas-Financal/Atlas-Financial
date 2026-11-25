'use strict';
/* An ordinary bill is paid in full at the amount that actually left (owner, Dale, #821 7168507103: "bills aren't paid in
 * portions ... when the bill is posted and paid ... It should be able to just pivot, post that amount, and call it paid";
 * "one good piece of evidence tied to the bill ... should be enough"; a pending charge counts).
 * Rule 17 (Grok Bot, Plan #6 thread, 2026-11-25 09:46 and 09:50 MST): the tie is the row's Lunch Money recurring-item
 * match, or the backup note line "bill paid: <exact recurring item name>". Grok Bot (10:13 MST): the match lives on the
 * recurring item (matches.foundTransactions), so it is read from there as well as from a row's recurring_id. A pending
 * row is tied by the note line alone (lead 13).
 * A category alone is not enough, and neither is a payee pattern or an amount: Atlas builds no matching of its own.
 *
 *   1. The note line (observer): exactly "bill paid:" at the start of a line; case-sensitive prefix, name compared as the
 *      "item:" note's names are.
 *   2. A tied posted payment below or above the plan: paid at the posted amount, checked on the Stack Bills card, summed in
 *      stackSummary.bills.paid at the posted payment's trust, and Balance After Deductions moves by plan minus posted.
 *   2b. Tied from the item's side (the row carries no recurring id): found under the rule's item is tied; under another
 *      item, under two items, twice under one, with pagination doubt, or with no read, is not.
 *   3. A tied fixed bill (amountFixed, D2) keeps no remainder; an untied one keeps it.
 *   4. A pending payment tied by the note line: paid on the card, marked pending, estimated at most, counted at the plan; gone once the
 *      pending row is gone.
 *   5. Controls: an untied payee-only payment of another amount stays unpaid at the plan; a category-only link stays
 *      unpaid; an untied payment equal to the plan is still checked (unchanged); a card minimum is unchanged.
 *   6. Mutants: the exact-amount-only rule restored, the D2 remainder restored for a tied bill, and the item-side tie
 *      dropped, each fail.
 *
 * Invented world: test/acceptance/harness.js as of 2026-10-14, one invented hydro bill of $90 due Oct 12, recurring item
 * id 777 (invented). Every expectation is written by hand. `node test/test-bill-paid-in-full-posted-amount.js`
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const H = require('./acceptance/harness.js');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
const SOURCE = read('public/forecast.js');
function compile(text, name) {
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(text, FILE.replace(/\.js$/, '-' + name + '.js'));
  return mod.exports;
}
const swap = (text, from, to, label) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error('anchor not found exactly once: ' + label);
  return parts.join(to);
};
const cards = (() => {
  const sandbox = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
  vm.runInNewContext(read('public/stack-shell.js'), sandbox);
  const shell = sandbox.window.StackBlocks;
  globalThis.StackBlocks = { register: () => {}, isEstimated: shell.isEstimated, estClass: shell.estClass, budgetTrust: shell.budgetTrust, barWidth: shell.barWidth, money: shell.money };
  return require('../public/stack-cards.js');
})();

const RECURRING = '777';
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro',
  rule: { lunchMoneyRecurringIds: [RECURRING], lunchMoneyItemNames: ['Invented hydro'] } };
const pay = (date, amount, extra = {}) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro', ...extra });
const tied = { raw: { recurring_id: Number(RECURRING) } };
// Lunch Money's recurring-item read, with the item's own matches (Grok Bot, 10:13 MST: rows carry no recurring id;
// the match lives on the item, under matches.foundTransactions).
const itemRead = (items, extra = {}) => ({ status: 'read', read: { unexpectedPaginationEvidence: false, ...extra,
  requestedWindow: { startDate: '2026-09-01', endDate: '2026-10-14' },
  items: items.map(([providerId, ids]) => ({ providerId, status: 'reviewed', unavailableFields: [],
    matches: { expectedOccurrenceDates: [], missingTransactionDates: [], foundTransactions: ids.map(id => ({ date: '2026-10-12', transactionId: id })) } })) } });
function run(october, { bill = HYDRO, fixed = false, packet = p => p, recurring = null } = {}, Fx = F) {
  const w = H.baseWorld();
  w.bills = [bill];
  if (recurring) w.recurringItems = recurring;
  w.transactions = [pay('2026-09-12', 90), ...october];
  if (fixed) w.amountHistory = { transactions: ['2026-07-12', '2026-08-12', '2026-09-12'].map(d => pay(d, 90)).concat(october) };
  const o = H.observe(w);
  if (o.error) throw o.error;
  return Fx.recommend(o.plan, w.asOf, { currentPeriodActuals: packet(JSON.parse(JSON.stringify(o.packet))) });
}
function october(rec) {
  const view = rec.payPeriodViews.find(v => (v.bills || []).some(b => b.id === 'hydro' && b.date === '2026-10-12'));
  const row = view.bills.find(b => b.id === 'hydro' && b.date === '2026-10-12');
  const html = cards.buildCardsHTML({ data: {}, plan: {}, recommendation: { payPeriodViews: [view] }, selectedPeriodKey: view.start, Forecast: {} });
  const bills = html.split('data-stack-card="bills"')[1] || '';
  const li = bills.split('<li class="sc-row sc-bill').slice(1).map(x => x.split('</li>')[0]).find(x => x.includes('Invented hydro')) || '';
  return { view, row, evidence: row.stackBillPaymentEvidence, counted: row.stackBillAmount, check: li.includes('sc-check'),
    trust: row.stackBillAmountTrust, paid: view.stackSummary.bills.paid, paidTrust: view.stackSummary.bills.paidTrust,
    bad: view.balanceAfterDeductions, remaining: row.remaining, partly: row.paymentState === 'partly-paid', li };
}

console.log('1. The "bill paid:" note line (observer)');
{
  const n = O.billPaidNoteNames;
  ok(JSON.stringify(n('bill paid: Invented hydro')) === '["invented hydro"]', 'the line names the item, compared as the item note is');
  ok(JSON.stringify(n('ref 1\nmatched to statement\nbill paid: Invented hydro')) === '["invented hydro"]', 'on any line');
  ok(['Bill paid: Invented hydro', ' bill paid: Invented hydro', 'bill paid:', 'bill paid', 'not bill paid: x', '', null, 42].every(v => n(v).length === 0),
    'near misses name nothing: capital B, a leading space, no name, no colon, a prefix, empty, non-strings');
}

console.log('2. A tied posted payment is paid in full at what was posted (plan 90)');
{
  const below = october(run([pay('2026-10-12', 84, tied)]));
  const untied = october(run([pay('2026-10-12', 84)]));
  ok(below.evidence === 'posted-verified' && below.counted === 84 && below.check && below.trust === 'calculated',
    'recurring-tied 84: paid, counted 84, checked, calculated', JSON.stringify([below.evidence, below.counted, below.check, below.trust]));
  ok(below.paid === 84 && below.paidTrust === 'calculated', 'stackSummary.bills.paid is 84, calculated', JSON.stringify([below.paid, below.paidTrust]));
  ok(Math.round((below.bad - untied.bad) * 100) === 600, 'Balance After Deductions is 90 − 84 = 6.00 higher than the untied reading', JSON.stringify([untied.bad, below.bad]));
  ok(!below.partly && below.remaining === 0, 'no "Partly paid" and nothing remaining', JSON.stringify([below.row.paymentState, below.remaining]));
  ok(/Paid \$84/.test(below.li), 'the card names what was paid, "Paid $84"');
  const above = october(run([pay('2026-10-12', 120, tied)]));
  ok(above.evidence === 'posted-verified' && above.counted === 120 && above.check && above.paid === 120,
    'recurring-tied 120: paid, counted 120, checked, summed 120', JSON.stringify([above.evidence, above.counted, above.check, above.paid]));
  const note = october(run([pay('2026-10-12', 84, { notes: 'statement ref 4\nbill paid: Invented hydro' })]));
  ok(note.evidence === 'posted-verified' && note.counted === 84 && note.check && note.paid === 84,
    'tied by the "bill paid:" note line alone (no recurring match): paid at 84', JSON.stringify([note.evidence, note.counted, note.check]));
}

console.log('2b. Tied from the recurring item\'s side: the row carries no recurring id');
{
  const row = () => pay('2026-10-12', 84, { id: 880001 });
  const found = october(run([row()], { recurring: itemRead([[RECURRING, [880001]]]) }));
  ok(found.evidence === 'posted-verified' && found.counted === 84 && found.check && found.paid === 84,
    'found under item 777 (the rule names it): paid at 84', JSON.stringify([found.evidence, found.counted, found.check, found.paid]));
  const other = october(run([row()], { recurring: itemRead([['999', [880001]]]) }));
  ok(other.evidence === 'posted-differs' && other.counted === 90 && !other.check, 'found under an item the rule does not name: no tie', JSON.stringify([other.evidence, other.counted]));
  const two = october(run([row()], { recurring: itemRead([[RECURRING, [880001]], ['999', [880001]]]) }));
  ok(two.evidence === 'posted-differs' && two.counted === 90, 'listed under two items: no tie', JSON.stringify([two.evidence, two.counted]));
  const twice = october(run([row()], { recurring: itemRead([[RECURRING, [880001, 880001]]]) }));
  ok(twice.evidence === 'posted-differs' && twice.counted === 90, 'listed twice under one item: no tie', JSON.stringify([twice.evidence, twice.counted]));
  const doubt = october(run([row()], { recurring: itemRead([[RECURRING, [880001]]], { unexpectedPaginationEvidence: true }) }));
  ok(doubt.evidence === 'posted-differs' && doubt.counted === 90, 'a read with pagination doubt: no tie', JSON.stringify([doubt.evidence, doubt.counted]));
  const unread = october(run([row()], { recurring: { status: 'unavailable' } }));
  ok(unread.evidence === 'posted-differs' && unread.counted === 90, 'no recurring read: no tie', JSON.stringify([unread.evidence, unread.counted]));
}

console.log('3. A tied fixed bill keeps no remainder (D2); an untied one keeps it');
{
  const tiedFixed = october(run([pay('2026-10-12', 40, tied)], { fixed: true }));
  const untiedFixed = october(run([pay('2026-10-12', 40)], { fixed: true }));
  ok(untiedFixed.row.partlyPaidRemainder === true && untiedFixed.remaining === 50,
    'control: untied 40 on the fixed 90 bill keeps its 50 remainder (D2, unchanged)', JSON.stringify([untiedFixed.row.partlyPaidRemainder, untiedFixed.remaining]));
  ok(tiedFixed.row.partlyPaidRemainder !== true && tiedFixed.remaining === 0 && tiedFixed.row.status === 'PAID'
    && tiedFixed.evidence === 'posted-verified' && tiedFixed.counted === 40 && tiedFixed.check,
    'tied 40 on the fixed 90 bill: PAID at 40, nothing remaining, checked', JSON.stringify([tiedFixed.row.status, tiedFixed.remaining, tiedFixed.counted]));
}

console.log('4. A tied pending payment counts as paid, marked pending, estimated at most');
{
  const p = october(run([pay('2026-10-12', 84, { pending: true, notes: 'bill paid: Invented hydro' })]));
  ok(p.evidence === 'pending-tied' && p.check && p.trust === 'estimated' && p.counted === 90,
    'pending tied by the note line: paid on the card, estimated, counted at the plan 90 until it posts', JSON.stringify([p.evidence, p.check, p.trust, p.counted]));
  ok(p.paid === 90 && p.paidTrust === 'estimated', 'summed in bills.paid at estimated', JSON.stringify([p.paid, p.paidTrust]));
  ok(p.row.status === 'pending', 'the row itself still reads pending: settlement and totals unchanged', p.row.status);
  const recPending = october(run([pay('2026-10-12', 84, { pending: true, ...tied })]));
  ok(recPending.evidence === 'pending' && !recPending.check && recPending.paid === 0, 'a pending row with a recurring id is not tied (the note line alone ties a pending row)', recPending.evidence);
  const foundPending = october(run([pay('2026-10-12', 84, { id: 880002, pending: true })], { recurring: itemRead([[RECURRING, [880002]]]) }));
  ok(foundPending.evidence === 'pending' && !foundPending.check, 'a pending row listed under the item is not tied either', foundPending.evidence);
  const untiedPending = october(run([pay('2026-10-12', 84, { pending: true })]));
  ok(untiedPending.evidence === 'pending' && !untiedPending.check && untiedPending.paid === 0, 'control: an untied pending payment is pending, not paid');
  const gone = october(run([]));
  ok(gone.evidence === 'none' && !gone.check && gone.paid === 0, 'once the pending row is gone with no posted twin, nothing is counted');
}

console.log('5. Controls: no tie, no change');
{
  const differs = october(run([pay('2026-10-12', 84)]));
  ok(differs.evidence === 'posted-differs' && differs.counted === 90 && !differs.check && differs.paid === 0,
    'an untied (payee-only) 84: unpaid, counted at the plan 90', JSON.stringify([differs.evidence, differs.counted, differs.check]));
  const equal = october(run([pay('2026-10-12', 90)]));
  ok(equal.evidence === 'posted-equal' && equal.check && equal.counted === 90, 'an untied 90 equal to the plan: checked, as before');
  // A single-bill category link (the harness's invented Utilities category, id 104); its payee pattern matches nothing.
  const categoryBill = { ...HYDRO, payee: 'Invented payee that matches nothing', rule: { lunchMoneyCategoryIds: [{ id: '104', name: 'Utilities' }] } };
  const linked = october(run([pay('2026-10-12', 90)], { bill: categoryBill }));
  ok(linked.evidence === 'posted-equal' && linked.check, 'positive control: the category link does link (equal 90 is checked)', JSON.stringify([linked.evidence]));
  const category = october(run([pay('2026-10-12', 84)], { bill: categoryBill }));
  ok(category.evidence === 'posted-differs' && !category.check && category.counted === 90,
    'a category-only link of another amount: unpaid at the plan (a category is not the tie)', JSON.stringify([category.evidence, category.check, category.counted]));
  const otherItem = october(run([pay('2026-10-12', 84, { raw: { recurring_id: 999 } })]));
  ok(otherItem.evidence !== 'posted-verified' && !otherItem.check, 'a recurring id the rule does not name is no tie');
  // A card minimum: the 'cardMinimum' rows of the split are byte-equal with and without a tied hydro payment.
  const mins = rec => JSON.stringify(october(rec).view.stackSummary.bills.cardMinimums);
  ok(mins(run([pay('2026-10-12', 84, tied)])) === mins(run([pay('2026-10-12', 84)])), 'the card minimums are unchanged');
}

console.log('6. Mutants');
{
  const exactOnly = compile(swap(SOURCE, "(link.verified || (link.tied && row.kind === 'bill' && row.cardPaid !== true))", 'link.verified', 'verified'), 'exact-only');
  const m1 = october(run([pay('2026-10-12', 84, tied)], {}, exactOnly));
  ok(!(m1.evidence === 'posted-verified' && m1.counted === 84), 'MUTANT (exact-amount-only restored): the tied 84 is unpaid at the plan again, which section 2 rejects',
    JSON.stringify([m1.evidence, m1.counted]));
  const d2 = compile(swap(SOURCE, '    if (ordinaryBillPaidTie(event, observed)) return null;\n', '', 'd2'), 'd2-remainder');
  const m2 = october(run([pay('2026-10-12', 40, tied)], { fixed: true }, d2));
  ok(m2.row.partlyPaidRemainder === true && m2.remaining === 50, 'MUTANT (D2 remainder restored for a tied bill): 50 remains again, which section 3 rejects',
    JSON.stringify([m2.row.partlyPaidRemainder, m2.remaining]));
  // The observer: drop the item-side tie. live-plan calls the observer through its exports object, so the mutant's
  // exports stand in for the real ones for this one run, then the real ones are put back.
  const OFILE = path.join(__dirname, '..', 'scripts', 'provider-observe.js');
  const OSOURCE = read('scripts/provider-observe.js');
  const omod = new Module(OFILE, module);
  omod.filename = OFILE;
  omod.paths = Module._nodeModulePaths(path.dirname(OFILE));
  omod._compile(swap(OSOURCE, '    if (foundUnder && rules.some(rule => ruleLunchMoneyRecurringIds(rule).includes(foundUnder))) return true;\n', '', 'item side'),
    OFILE.replace(/\.js$/, '-no-item-side.js'));
  const real = { ...O };
  Object.assign(O, omod.exports);
  let m3;
  try {
    m3 = october(run([pay('2026-10-12', 84, { id: 880003 })], { recurring: itemRead([[RECURRING, [880003]]]) }));
  } finally { Object.assign(O, real); }
  ok(!(m3.evidence === 'posted-verified' && m3.counted === 84), 'MUTANT (item-side tie dropped): a row found under item 777 is unpaid at the plan again, which section 2b rejects',
    JSON.stringify([m3.evidence, m3.counted]));
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} bill paid in full at the posted amount (${checks - failures}/${checks})`);
if (failures) process.exit(1);
