'use strict';
/* Budget category transactions (owner ask, Dale, 2026-11-20; lead ruling on CARDS' #1450): Forecast publishes one
 * boolean per household budget row, Other spending included, reconMatchesSpent, so a page may list a row's recon only
 * when that list is exactly what its Spent counts, without doing money arithmetic itself (L-001).
 *
 *   true   the cents of the row's recon rows, less the pending twin of a posted transaction
 *          (pendingPostedDuplicate && pending && !pendingAmountEstimated), equal round(Spent x 100);
 *   false  otherwise (including a listed row whose amount is not a number);
 *   absent when Spent is not a number.
 *
 * Proof, independent of the publisher: hand-built rows with the expected answer written by hand (an exposed copy of
 * the publisher); every invented figures input through Forecast.recommend (the flag sits only beside a numeric Spent,
 * and every other field is byte-equal to a copy that does not publish it); mutants. Invented numbers only.
 * `node test/test-budget-recon-matches-spent.js`
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const F = require('../public/forecast.js');
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
const EXPOSE = '  function publishReconMatchesSpent(result) {';
const exposeWith = (text, name) => {
  compile(replaceOnce(text, EXPOSE, '  globalThis.__p = publishReconMatchesSpent;\n' + EXPOSE, 'expose ' + name), name);
  const fn = globalThis.__p;
  delete globalThis.__p;
  return fn;
};
const publish = exposeWith(SOURCE, 'exposed');
const WRAP = 'return publishReconMatchesSpent(publishBillPaidStates(publishStackSummary(recommend(plan, asOf, opts), plan, asOf, opts)));';
const without = compile(replaceOnce(SOURCE, WRAP, 'return publishBillPaidStates(publishStackSummary(recommend(plan, asOf, opts), plan, asOf, opts));', 'pass off'), 'without');

const tx = (amount, extra = {}) => ({ id: 't' + amount, date: '2026-10-12', amount, pending: false, pendingPostedDuplicate: false, ...extra });
const flag = (spent, recon, extra = {}) => {
  const row = { id: 'groceries', spent, recon, ...extra };
  publish({ payPeriodViews: [{ householdBudget: [row] }] });
  return Object.hasOwn(row, 'reconMatchesSpent') ? row.reconMatchesSpent : 'absent';
};

console.log('1. Hand-built rows (the expected answer by hand)');
// Transactions of 10 and 1.005: each recon row is rounded on its own (10.00 and 1.00) while a Spent that sums the
// unrounded amounts rounds once, to 11.01. The list misses the Spent by a cent.
ok(flag(11.01, [tx(10), tx(1)]) === false, '10 + 1.005: rows 10.00 + 1.00 beside Spent 11.01 do not reconcile');
ok(flag(11.01, [tx(10), tx(1.01)]) === true, '10 + 1.01: rows 10.00 + 1.01 reconcile to Spent 11.01');
ok(flag(25, [tx(10), tx(15)]) === true, 'whole-cent control: 10 + 15 is 25');
ok(flag(25, [tx(10), tx(15), tx(15, { id: 'twin', pending: true, pendingPostedDuplicate: true })]) === true,
  'the pending twin of a posted transaction is not counted, exactly as Spent does not count it');
ok(flag(40, [tx(10), tx(15), tx(15, { id: 'est', pending: true, pendingPostedDuplicate: true, pendingAmountEstimated: true })]) === true,
  'a pending twin with an estimated amount is counted, as Spent counts it');
ok(flag(20, [tx(25), tx(-5)]) === true, 'a refund row is negative and nets');
ok(flag(0, []) === true, 'no rows beside a Spent of 0 reconcile');
ok(flag(10, [tx(10), { id: 'bad', amount: null }]) === false, 'a listed row with no amount does not reconcile');
ok(flag(null, [tx(10)]) === 'absent' && flag(undefined, [tx(10)]) === 'absent' && flag(NaN, [tx(10)]) === 'absent',
  'no numeric Spent: no flag at all');
{
  const row = { id: 'g', spent: null, recon: [], reconMatchesSpent: true };
  publish({ payPeriodViews: [{ householdBudget: [row] }] });
  ok(!Object.hasOwn(row, 'reconMatchesSpent'), 'a stale flag on a row whose Spent is withheld is removed');
}
ok(flag(11.01, [tx(10), tx(1.01)], { id: 'other-spending', otherSpending: true }) === true, 'Other spending is flagged the same way');

console.log('2. Every invented figures input');
{
  const inputs = Snap.loadInventedInputs();
  let flagged = 0, numeric = 0, equal = 0;
  for (const inp of inputs) {
    const data = structuredClone(inp.doc.data);
    const opts = () => Snap.pageOptions(data, inp.doc.periods == null ? null : structuredClone(inp.doc.periods));
    const rec = F.recommend(data.plan, data.meta.asOf, opts());
    for (const view of rec.payPeriodViews) {
      for (const row of view.householdBudget || []) {
        const isNumber = typeof row.spent === 'number' && Number.isFinite(row.spent);
        if (isNumber) numeric++;
        if (Object.hasOwn(row, 'reconMatchesSpent')) flagged++;
        if (isNumber !== Object.hasOwn(row, 'reconMatchesSpent')) ok(false, `${inp.file || inp.name} ${view.start} ${row.id}: flag exactly beside a numeric Spent`);
      }
    }
    let proved = true;
    try { withoutAuthorizedAdditions(structuredClone(rec)); } catch (e) { proved = false; ok(false, `${inp.file || inp.name}: authorized-additions proof`, e.message); }
    const stripped = JSON.parse(JSON.stringify(rec, (k, v) => (k === 'reconMatchesSpent' ? undefined : v)));
    if (proved && JSON.stringify(stripped) === JSON.stringify(without.recommend(data.plan, data.meta.asOf, opts()))) equal++;
    else ok(false, `${inp.file || inp.name}: every other field byte-equal`);
  }
  ok(numeric > 0 && flagged === numeric, `every one of ${numeric} rows with a numeric Spent carries the flag, and no other row does`);
  ok(equal === inputs.length, `every other field is byte-equal without the flag on all ${inputs.length} inputs, and the proof holds`);
}

console.log('3. Mutants are caught');
{
  const twinCounted = exposeWith(replaceOnce(SOURCE, '      if (!reconRowCounted(r)) continue;\n', '', 'twin counted'), 'twin-counted');
  const r1 = { id: 'g', spent: 25, recon: [tx(10), tx(15), tx(15, { id: 'twin', pending: true, pendingPostedDuplicate: true })] };
  twinCounted({ payPeriodViews: [{ householdBudget: [r1] }] });
  ok(r1.reconMatchesSpent === false, 'counting the pending twin is caught');
  const unrounded = exposeWith(replaceOnce(SOURCE, '    return cents === Math.round(row.spent * 100);', '    return cents / 100 === row.spent || Math.abs(cents / 100 - row.spent) < 0.011;', 'tolerant'), 'tolerant');
  const r2 = { id: 'g', spent: 11.01, recon: [tx(10), tx(1)] };
  unrounded({ payPeriodViews: [{ householdBudget: [r2] }] });
  ok(r2.reconMatchesSpent === true, 'a one-cent tolerance (which would call the mismatch a match) is caught by the 10 + 1.005 case');
  const nullAsFalse = exposeWith(replaceOnce(SOURCE, "    if (!row || typeof row.spent !== 'number' || !Number.isFinite(row.spent)) return undefined;",
    "    if (!row || typeof row.spent !== 'number' || !Number.isFinite(row.spent)) return false;", 'null false'), 'null-false');
  const r3 = { id: 'g', spent: null, recon: [] };
  nullAsFalse({ payPeriodViews: [{ householdBudget: [r3] }] });
  ok(r3.reconMatchesSpent === false, 'a flag published beside a withheld Spent is caught');
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} reconMatchesSpent checks passed`);
process.exit(failures ? 1 : 0);
