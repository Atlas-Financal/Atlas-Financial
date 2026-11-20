'use strict';
/* Stack Wallet bill sheet: Forecast publishes each bill's past occurrences once, as billHistory (owner ask, Dale,
 * 2026-11-20; lead ruling: one authority, the page does no cross-period join).
 *
 *   billHistory[id] = [{ date, amount, amountBasis, trust, paidState }], newest first, for every occurrence in the
 *   published pay periods (past, current and future). amount follows the row's own displayAmountBasis: a posted or
 *   unconfirmed linked payment is |actual| (the Lunch Money ledger's own link, read and never matched here, rule 17);
 *   otherwise the scheduled amount, basis 'schedule', with its own trust. Never a scheduled amount called paid.
 *
 * Proof, independent of the publisher:
 *   1. hand-derived worlds (invented raw Lunch Money -> observer -> Forecast.recommend): the expected entries are
 *      written by hand from the world's own payments;
 *   2. the publisher on hand-built results (an exposed copy): carried copies, future dates, unknown amounts, unknown
 *      trust words, rows without an id, ordering;
 *   3. every invented figures input: the authorized-additions proof holds, and every other field is byte-equal to a
 *      copy that does not publish billHistory;
 *   4. mutants are caught.
 * Invented numbers only.  `node test/test-stack-bill-history.js`
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');
const Snap = require('../scripts/figures-snapshot.js');
const { withoutAuthorizedAdditions } = require('./forecast-authorized-additions');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};

const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const replaceOnce = (text, from, to, label) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error('anchor not found exactly once: ' + label);
  return parts.join(to);
};
function compile(text, name) {
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(text, FILE.replace(/\.js$/, '-' + name + '.js'));
  return mod.exports;
}
const EXPOSE = '  function publishBillHistory(result) {';
const copies = {
  without: compile(replaceOnce(SOURCE, 'return publishBillHistory(publishBillPaidStates(publishStackSummary(recommend(plan, asOf, opts), plan, asOf, opts)));',
    'return publishBillPaidStates(publishStackSummary(recommend(plan, asOf, opts), plan, asOf, opts));', 'pass off'), 'without'),
  exposed: compile(replaceOnce(SOURCE, EXPOSE, '  globalThis.__publishBillHistory = publishBillHistory;\n' + EXPOSE, 'expose'), 'exposed'),
  scheduleAlways: compile(replaceOnce(SOURCE, '    const raw = actual ? row.actual : row.amount;', '    const raw = row.amount;', 'schedule always'), 'schedule-always'),
  oldestFirst: compile(replaceOnce(SOURCE, '(a.date < b.date ? 1 : a.date > b.date ? -1 : 0)', '(a.date < b.date ? -1 : a.date > b.date ? 1 : 0)', 'oldest first'), 'oldest-first'),
  futureDropped: compile(replaceOnce(SOURCE, "        if (typeof row.date !== 'string' || row.paidState === 'carried') continue;",
    "        if (typeof row.date !== 'string' || row.paidState === 'carried' || view.timelineRole === 'future') continue;", 'future dropped'), 'future-dropped'),
};
const publish = globalThis.__publishBillHistory;
delete globalThis.__publishBillHistory;

const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const pay = (date, amount, extra = {}) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro', ...extra });
function world(bill, txs, Fx = F) {
  const w = H.baseWorld();
  w.bills = [bill];
  w.transactions = txs;
  const r = H.observe(w);
  if (r.error) throw r.error;
  return { w, r, rec: Fx.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet }) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('1. Hand-derived worlds (as of 2026-10-14)');
// A 90 monthly hydro bill due on the 12th. September's 90 posted; October's 40 posted (a partial payment, which the
// paid word counts as paid: payment evidence was seen); nothing seen for August. November and December are still to
// come: every published occurrence is listed (the sheet's headline and history read one source), newest first, a
// not-yet-due one at its schedule.
const PAID = [pay('2026-09-12', 90), pay('2026-10-12', 40)];
const HAND = [
  { date: '2026-12-12', amount: 90, amountBasis: 'schedule', trust: 'calculated', paidState: 'not-paid' },
  { date: '2026-11-12', amount: 90, amountBasis: 'schedule', trust: 'calculated', paidState: 'not-paid' },
  { date: '2026-10-12', amount: 40, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid' },
  { date: '2026-09-12', amount: 90, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid' },
  { date: '2026-08-12', amount: 90, amountBasis: 'schedule', trust: 'calculated', paidState: 'not-paid' },
];
{
  const { w, rec } = world(HYDRO, PAID);
  ok(w.asOf === '2026-10-14', 'the harness date the hand values assume', w.asOf);
  ok(same(rec.billHistory.hydro, HAND), 'two to come at the schedule, the paid 40 of 90 in October and 90 in September, then the unpaid August at its schedule',
    JSON.stringify(rec.billHistory.hydro));
  ok(Object.keys(rec.billHistory).length === 1, 'one bill, one history');
}
{
  // October's payment still pending: Paid, but no linked amount yet, so the entry is October's scheduled 90 with
  // basis 'schedule' (the schedule's own trust), never a paid amount.
  const { rec } = world(HYDRO, [pay('2026-09-12', 90), pay('2026-10-12', 90, { pending: true })]);
  const oct = rec.billHistory.hydro.find(e => e.date === '2026-10-12');
  ok(same(oct, { date: '2026-10-12', amount: 90, amountBasis: 'schedule', trust: 'calculated', paidState: 'paid' }),
    'a pending payment: Paid, at the scheduled 90, labelled schedule', JSON.stringify(oct));
}
{
  // An estimated bill with no payment seen: the schedule's own trust, estimated.
  const { rec } = world({ ...HYDRO, confidence: 'estimated' }, []);
  ok(rec.billHistory.hydro.every(e => e.amountBasis === 'schedule' && e.amount === 90 && e.trust === 'estimated' && e.paidState === 'not-paid'),
    'an estimated bill, nothing paid: every occurrence is its scheduled 90, estimated, not paid', JSON.stringify(rec.billHistory.hydro));
}

console.log('2. The publisher on hand-built results');
{
  const view = (role, bills) => ({ timelineRole: role, bills });
  const row = (date, extra = {}) => ({ id: 'b', date, amount: 50, actual: null, displayAmountBasis: 'schedule',
    displayAmountTrust: 'calculated', paidState: 'not-paid', ...extra });
  const r = publish({ payPeriodViews: [
    view('past', [row('2026-08-01'), row('2026-09-01', { paidState: 'carried' }), { date: '2026-09-02', amount: 5 }, row('2026-08-20', { id: '' })]),
    view('current', [row('2026-09-01', { displayAmountBasis: 'posted-actual', actual: -50.005, paidState: 'paid' }),
      row('2026-09-10', { amount: null, displayAmountTrust: 'calculated' }), row('2026-09-30')]),
    view('future', [row('2026-10-01')]),
  ] }, '2026-09-15');
  const list = r.billHistory.b;
  ok(same(list.map(e => e.date), ['2026-10-01', '2026-09-30', '2026-09-10', '2026-09-01', '2026-08-01']),
    'newest first, future periods included; the carried copy and the rows without an id or date are not listed', JSON.stringify(list.map(e => e.date)));
  ok(list[0].amountBasis === 'schedule' && list[0].trust === 'calculated' && list[0].paidState === 'not-paid',
    'a future occurrence is present at its schedule, with its own trust and paid word', JSON.stringify(list[0]));
  ok(list[3].amount === 50.01 && list[3].amountBasis === 'posted-actual', 'a linked actual is its absolute amount, to the cent', JSON.stringify(list[3]));
  ok(list[2].amount === null && list[2].trust === 'unavailable', 'an amount that is not a number is null and unavailable', JSON.stringify(list[2]));
  const odd = publish({ payPeriodViews: [view('past', [row('2026-08-01', { displayAmountTrust: 'verified' }), row('2026-08-15', { displayAmountTrust: null })])] }, '2026-09-15');
  ok(odd.billHistory.b.every(e => e.trust === 'unknown'), 'a trust word outside calculated / estimated is unknown, never upgraded', JSON.stringify(odd.billHistory.b));
  ok(same(publish({}, '2026-09-15').billHistory, {}), 'no pay periods: an empty history');
  // A saved close keeps its unpaid row (marked alsoCarriedToCurrent) while the current period carries the same
  // occurrence, now paid: one entry, the newest period's.
  const twice = publish({ payPeriodViews: [
    view('past', [row('2026-09-05', { alsoCarriedToCurrent: true })]),
    view('current', [row('2026-09-05', { displayAmountBasis: 'posted-actual', actual: 50, paidState: 'paid' })]),
  ] }, '2026-09-15');
  ok(same(twice.billHistory.b, [{ date: '2026-09-05', amount: 50, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid' }]),
    'an occurrence a saved close kept and the current period carries is listed once, as the current period has it', JSON.stringify(twice.billHistory.b));
}

console.log('3. Every invented figures input');
{
  const inputs = Snap.loadInventedInputs();
  let periods = 0, entries = 0, equal = 0;
  for (const inp of inputs) {
    const data = structuredClone(inp.doc.data);
    const opts = () => Snap.pageOptions(data, inp.doc.periods == null ? null : structuredClone(inp.doc.periods));
    const rec = F.recommend(data.plan, data.meta.asOf, opts());
    entries += Object.values(rec.billHistory).reduce((n, list) => n + list.length, 0);
    periods += rec.payPeriodViews.length;
    let proved = true;
    try { withoutAuthorizedAdditions(structuredClone(rec)); } catch (e) { proved = false; ok(false, (inp.name || inp.file) + ': authorized-additions proof', e.message); }
    const without = copies.without.recommend(data.plan, data.meta.asOf, opts());
    const stripped = structuredClone(rec);
    delete stripped.billHistory;
    if (proved && same(stripped, without)) equal++;
    else ok(false, (inp.name || inp.file) + ': every other field byte-equal');
  }
  ok(entries > 0 && periods > 0, `the corpus publishes ${entries} history entries across ${periods} periods`);
  ok(equal === inputs.length, `every other field is byte-equal without billHistory on all ${inputs.length} inputs, and the proof holds`);
}

console.log('4. Mutants are caught');
{
  ok(!same(world(HYDRO, PAID, copies.scheduleAlways).rec.billHistory.hydro, HAND), 'the scheduled amount published for a paid occurrence is caught');
  ok(!same(world(HYDRO, PAID, copies.oldestFirst).rec.billHistory.hydro, HAND), 'oldest first is caught');
  ok(!same(world(HYDRO, PAID, copies.futureDropped).rec.billHistory.hydro, HAND), 'dropping the occurrences still to come is caught');
  const exposeWith = (text, name) => {
    compile(replaceOnce(text, EXPOSE, '  globalThis.__p = publishBillHistory;\n' + EXPOSE, 'expose ' + name), name);
    const fn = globalThis.__p;
    delete globalThis.__p;
    return fn;
  };
  const carried = { payPeriodViews: [{ timelineRole: 'past', bills: [{ id: 'b', date: '2026-08-01', amount: 5,
    displayAmountBasis: 'schedule', displayAmountTrust: 'calculated', paidState: 'carried' }] }] };
  const withCarried = exposeWith(replaceOnce(SOURCE, " || row.paidState === 'carried') continue;", ') continue;', 'carried included'), 'carried-included');
  ok((withCarried(carried, '2026-09-15').billHistory.b || []).length === 1, 'a carried copy listed is caught');
  const noDedupe = exposeWith(replaceOnce(SOURCE, "        latest.set(row.id + '\\u0000' + row.date, row);", "        latest.set(latest.size, row);", 'no dedupe'), 'no-dedupe');
  const kept = { payPeriodViews: [
    { timelineRole: 'past', bills: [{ id: 'b', date: '2026-09-05', amount: 50, displayAmountBasis: 'schedule', displayAmountTrust: 'calculated', paidState: 'not-paid', alsoCarriedToCurrent: true }] },
    { timelineRole: 'current', bills: [{ id: 'b', date: '2026-09-05', amount: 50, displayAmountBasis: 'schedule', displayAmountTrust: 'calculated', paidState: 'not-paid' }] }] };
  ok(noDedupe(kept, '2026-09-15').billHistory.b.length === 2 && publish(structuredClone(kept), '2026-09-15').billHistory.b.length === 1,
    'one occurrence listed twice (saved close and current) is caught');
  const unmarked = { payPeriodViews: [{ timelineRole: 'past', bills: [{ id: 'b', date: '2026-08-01', amount: 5,
    displayAmountBasis: 'schedule', displayAmountTrust: null, paidState: 'not-paid' }] }] };
  const defaulted = exposeWith(replaceOnce(SOURCE, "BILL_HISTORY_TRUST.has(row.displayAmountTrust) ? row.displayAmountTrust : 'unknown'",
    "row.displayAmountTrust || 'calculated'", 'trust defaulted'), 'trust-defaulted');
  ok(defaulted(unmarked, '2026-09-15').billHistory.b[0].trust === 'calculated'
    && publish(structuredClone(unmarked), '2026-09-15').billHistory.b[0].trust === 'unknown',
    'an unmarked trust defaulted to calculated is caught (the shipped copy says unknown)');
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} bill history checks passed`);
process.exit(failures ? 1 : 0);
