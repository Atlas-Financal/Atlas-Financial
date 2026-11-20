'use strict';
/* Stack Wallet Bills card: paid / owed (Dale, 2026-11-20: "bills needs the paid/owed").
 *
 * Forecast publishes stackSummary.bills.paid: the Bills part ('other': no mortgage, no card minimums) that the
 * payment evidence confirms paid. One rule decides "confirmed paid" (stackBillPaidEvidence, today 'posted-equal'):
 * it sets each marked row's stackBillPaid, which the card's check reads, so paid is the sum of the checked rows by
 * construction. Trust (lead ruling, 2026-11-20): 0 'calculated' when no Bills row is checked; otherwise the weakest of
 * the paid rows' own amount trust; withheld (null, 'unavailable', a reason) when the split, the marks or a paid row's
 * trust is unpublished. The card head prints paid / owed and its bar fills through the shell's shared barWidth.
 *
 * Proof, independent of the publisher: invented acceptance-harness households with two Bills rows, hydro 90 and
 * internet 60, both in the Oct 9-22 period, their answers worked by hand; the Budget-surface household with a paid
 * mortgage (Bills paid stays 0); every invented figures input, through the real card; the trust rules on hand-built
 * periods; and mutants of the rule, the part filter, the trust and the card's check. Invented numbers only.
 *   node test/test-stack-bills-paid.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');
const fx = require('./fixtures/budget-surface-data');
const Snap = require('../scripts/figures-snapshot.js');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};
const cents = v => Math.round(v * 100);
const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const EXPORT = "  if (typeof module !== 'undefined' && module.exports) module.exports = Forecast;";
const replaceOnce = (text, from, to, label) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error('anchor not found exactly once: ' + label);
  return parts.join(to);
};
let compiled = 0;
function compile(text) {
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(text, FILE.replace(/\.js$/, '-bills-paid-' + (++compiled) + '.js'));
  return mod.exports;
}

// The cards as the Stack shell loads them (its trust rule and its one bar ratio).
const shellBox = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-shell.js'), 'utf8'), shellBox);
const shell = shellBox.window.StackBlocks;
const STACK = { register: () => {}, isEstimated: shell.isEstimated, estClass: shell.estClass, budgetTrust: shell.budgetTrust, barWidth: shell.barWidth, money: shell.money };
const CARDS_FILE = path.join(__dirname, '..', 'public', 'stack-cards.js');
function loadCards(source) {
  const box = { module: { exports: {} }, window: { StackBlocks: STACK }, StackBlocks: STACK };
  box.exports = box.module.exports;
  require('vm').runInNewContext(source, box);
  return box.module.exports.buildCardsHTML ? box.module.exports : box.window.StackCards;
}
const CARDS = loadCards(fs.readFileSync(CARDS_FILE, 'utf8'));
const billsCard = (view, cards = CARDS) => cards.buildCardsHTML({ data: {}, plan: {}, recommendation: { payPeriodViews: [view] },
  selectedPeriodKey: view.start, Forecast: {} }).split('data-stack-card="bills"')[1].split('</details>')[0];
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const headOf = h => { const sum = h.slice(h.indexOf('<summary'), h.indexOf('</summary>')); return text(sum.slice(sum.indexOf('>') + 1)); };
const barOf = h => (/<span class="sc-bar[^"]*" aria-hidden="true"><i style="width:([^%]*)%">/.exec(h.split('</summary>')[0]) || [])[1];
// The checked rows of a rendered Bills card, matched back to Forecast's rows by their sheet target.
const checkedCents = (view, h) => {
  const rows = (view.bills || []).filter(r => r && r.stackBillPart === 'other');
  return h.split('<li class="sc-row sc-bill').slice(1).map(x => x.split('</li>')[0]).reduce((sum, li, i) =>
    sum + (li.includes('class="sc-check"') ? cents(rows[i].stackBillAmount) : 0), 0);
};

// ---- 1. Invented households, answers by hand ----
console.log('1. Two Bills rows, hydro 90 (Oct 12) and internet 60 (Oct 13), in the Oct 9-22 period');
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const NET = { id: 'internet', label: 'Invented internet', amount: 60, frequency: 'monthly', day: 13, confidence: 'confirmed', payee: 'Invented internet' };
const pay = (payee, date, amount, extra = {}) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee, ...extra });
function world(Forecast, payments) {
  const w = H.baseWorld(); w.bills = [HYDRO, NET];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }), ...payments];
  const o = H.observe(w); if (o.error) throw o.error;
  const rec = Forecast.recommend(o.plan, w.asOf, { currentPeriodActuals: o.packet });
  return rec.payPeriodViews.find(v => v.start === '2026-10-09');
}
const CASES = [
  // [label, payments, paid, trust, checked rows]
  ['all paid: both posted at their planned amount', [pay('Invented hydro', '2026-10-12', 90), pay('Invented internet', '2026-10-13', 60)], 150, 'calculated', ['hydro', 'internet']],
  ['none paid: no payment seen (a known 0, calculated)', [], 0, 'calculated', []],
  ['some paid with one pending: hydro posted 90, internet pending 60', [pay('Invented hydro', '2026-10-12', 90), pay('Invented internet', '2026-10-13', 60, { pending: true })], 90, 'calculated', ['hydro']],
  ['a posted payment of another amount is not paid: hydro posted 40, internet posted 60', [pay('Invented hydro', '2026-10-12', 40), pay('Invented internet', '2026-10-13', 60)], 60, 'calculated', ['internet']],
];
function caseResult(Forecast, payments, cards = CARDS) {
  const v = world(Forecast, payments);
  const b = v && v.stackSummary && v.stackSummary.bills;
  const h = billsCard(v, cards);
  return { v, b, h, head: headOf(h), bar: barOf(h), checked: (v.bills || []).filter(r => r.stackBillPart === 'other' && r.stackBillPaid).map(r => r.id),
    checkedOnCard: checkedCents(v, h) };
}
for (const [label, payments, paid, trust, checked] of CASES) {
  const r = caseResult(F, payments);
  ok(r.b && r.b.other === 150 && r.b.paid === paid && r.b.paidTrust === trust && !('paidReason' in r.b),
    `${label}: paid ${paid} of 150, ${trust}`, JSON.stringify(r.b));
  ok(JSON.stringify(r.checked) === JSON.stringify(checked), `${label}: the checked rows are ${checked.join(', ') || 'none'}`, JSON.stringify(r.checked));
  ok(r.checkedOnCard === cents(paid), `${label}: paid is exactly the sum of the rows the card checks`, `${r.checkedOnCard / 100} / ${paid}`);
  const want = `Bills $${paid} / $150`;
  ok(r.head === want, `${label}: the head prints "${want}"`, r.head);
  ok(Number(r.bar) === paid / 150 * 100, `${label}: the bar fills ${paid}/150`, r.bar);
}

// ---- 2. A paid mortgage and a card minimum never enter Bills paid ----
console.log('2. The Budget-surface household: mortgage 1,400 paid, a card minimum; Bills is hydro 120 + internet 85');
{
  const d = fx.served({ mortgageObligation: true });
  const v = F.recommend(d.plan, d.meta.asOf, { debts: d.debts }).payPeriodViews.find(p => p.timelineRole === 'current');
  const b = v.stackSummary.bills, rows = v.bills.filter(r => r.stackBillPart);
  ok(b.other === 205 && b.paid === cents(rows.filter(r => r.stackBillPart === 'other' && r.stackBillPaid)
    .reduce((s, r) => s + r.stackBillAmount, 0)) / 100, 'Bills paid sums only its own checked rows', JSON.stringify(b));
  const outside = rows.filter(r => r.stackBillPart !== 'other');
  ok(outside.length >= 2 && b.paid === 0, 'the mortgage and the card minimum are not Bills paid (paid 0 of 205)',
    JSON.stringify(outside.map(r => [r.id, r.stackBillPart, r.stackBillPaymentEvidence, r.stackBillPaid])));
}

// ---- 3. Every invented figures input ----
console.log('3. Every invented figures input: paid is the checked Bills rows, or withheld');
{
  let periods = 0, published = 0, withheld = 0, bad = [];
  for (const input of Snap.loadInventedInputs()) {
    const data = input.doc.data;
    let rec;
    try { rec = F.recommend(data.plan, data.meta.asOf, { ...(data.liveOverlay || {}), debts: data.debts || [] }); } catch (_) { continue; }
    for (const v of rec.payPeriodViews || []) {
      const b = v.stackSummary && v.stackSummary.bills;
      if (!b) continue;
      periods++;
      const rows = (v.bills || []).filter(r => r.stackBillPart === 'other');
      if (b.paid === null) {
        withheld++;
        if (b.paidTrust !== 'unavailable' || typeof b.paidReason !== 'string') bad.push(input.id + ' ' + v.start + ' withheld shape');
        continue;
      }
      published++;
      const sum = rows.filter(r => r.stackBillPaid).reduce((s, r) => s + cents(r.stackBillAmount), 0);
      if (cents(b.paid) !== sum) bad.push(input.id + ' ' + v.start + ' sum');
      if (rows.some(r => r.stackBillPaid !== (r.stackBillPaymentEvidence === 'posted-equal'))) bad.push(input.id + ' ' + v.start + ' flag');
      if (checkedCents(v, billsCard(v)) !== cents(b.paid)) bad.push(input.id + ' ' + v.start + ' card');
    }
  }
  // No invented figures input withholds a split today; the withheld rules are proved on hand-built periods (section 4).
  ok(periods > 50 && published > 0 && bad.length === 0,
    `on ${periods} periods (${published} published, ${withheld} withheld) paid = the card's checked rows`, bad.slice(0, 5).join('; '));
}

// ---- 4. The trust rules, on hand-built periods ----
console.log('4. Trust rules on hand-built periods');
const exposed = compile(replaceOnce(SOURCE, EXPORT, '  Forecast.__billsPaid = stackBillsPaid;\n' + EXPORT, 'expose'));
const row = (id, amount, paid, trust) => ({ id, stackBillPart: 'other', stackBillAmount: amount, stackBillPaid: paid,
  ...(trust === undefined ? {} : { stackBillAmountTrust: trust }) });
const runPaid = (Forecast, rows, bills = { other: rows.reduce((s, r) => s + r.stackBillAmount, 0), trust: 'calculated' }) => {
  const b = { ...bills }; Forecast.__billsPaid({ bills: rows }, b); return b;
};
{
  const est = runPaid(exposed, [row('a', 30, true, 'calculated'), row('b', 20, true, 'estimated'), row('c', 50, false, 'calculated')]);
  ok(est.paid === 50 && est.paidTrust === 'estimated', 'the weakest paid row\'s trust (calculated + estimated = estimated)', JSON.stringify(est));
  const unpaidEst = runPaid(exposed, [row('a', 30, true, 'calculated'), row('b', 20, false, 'estimated')]);
  ok(unpaidEst.paid === 30 && unpaidEst.paidTrust === 'calculated', 'an unpaid row does not enter paid\'s trust', JSON.stringify(unpaidEst));
  const noWord = runPaid(exposed, [row('a', 30, true), row('b', 20, false, 'calculated')]);
  ok(noWord.paid === null && noWord.paidTrust === 'unavailable' && typeof noWord.paidReason === 'string',
    'a paid row with no trust word withholds paid (never defaulted to calculated)', JSON.stringify(noWord));
  const none = runPaid(exposed, [row('a', 30, false, 'estimated')]);
  ok(none.paid === 0 && none.paidTrust === 'calculated', 'nothing checked: a known 0, calculated', JSON.stringify(none));
  const unmarked = runPaid(exposed, [row('a', 30, false, 'calculated')], { other: 80, trust: 'calculated' });
  ok(unmarked.paid === null && unmarked.paidTrust === 'unavailable', 'marked rows short of the Bills total: withheld, never 0', JSON.stringify(unmarked));
  const split = runPaid(exposed, [], { other: null, trust: 'unavailable' });
  ok(split.paid === null && split.paidTrust === 'unavailable', 'a withheld split withholds paid', JSON.stringify(split));
  const flag = runPaid(exposed, [{ ...row('a', 30, true, 'calculated'), stackBillPaid: 'yes' }]);
  ok(flag.paid === null, 'a row without a boolean paid flag withholds paid', JSON.stringify(flag));
  const h = billsCard({ start: '2026-01-01', stackSummary: { bills: { other: 150, trust: 'calculated', paid: null, paidTrust: 'unavailable' } }, bills: [] });
  ok(/—/.test(headOf(h)) && !/\$0/.test(headOf(h)) && Number(barOf(h)) === 0, 'a withheld paid prints a dash and an empty bar, never $0', headOf(h));
}

// ---- 5. Mutants ----
console.log('5. Mutants');
{
  const PAID_FILTER = "    const paid = rows.filter(row => row.stackBillPaid);";
  const allRows = compile(replaceOnce(SOURCE, PAID_FILTER, '    const paid = rows;', 'all rows'));
  ok(caseResult(allRows, CASES[1][1]).b.paid === 150, 'counting every Bills row as paid is caught (none paid reads 150)');
  const pending = compile(replaceOnce(SOURCE, "    return evidence === 'posted-equal';\n", "    return evidence === 'posted-equal' || evidence === 'pending';\n", 'pending'));
  ok(caseResult(pending, CASES[2][1]).b.paid === 150, 'counting a pending payment as paid is caught (some paid reads 150)');
  const differs = compile(replaceOnce(SOURCE, "    return evidence === 'posted-equal';\n", "    return evidence !== 'none';\n", 'differs'));
  ok(caseResult(differs, CASES[3][1]).b.paid === 150, 'counting a differing payment as paid is caught (it reads 150)');
  const PART = "    const rows = (Array.isArray(view.bills) ? view.bills : []).filter(row => row && row.stackBillPart === 'other');";
  const anyPart = compile(replaceOnce(SOURCE, PART, "    const rows = (Array.isArray(view.bills) ? view.bills : []).filter(row => row && row.stackBillPart);", 'any part'));
  const d = fx.served({ mortgageObligation: true });
  const mv = anyPart.recommend(d.plan, d.meta.asOf, { debts: d.debts }).payPeriodViews.find(p => p.timelineRole === 'current');
  ok(mv.stackSummary.bills.paid !== 0, 'counting the mortgage or a card minimum in Bills paid is caught', JSON.stringify(mv.stackSummary.bills));
  const fixed = compile(replaceOnce(replaceOnce(SOURCE, EXPORT, '  Forecast.__billsPaid = stackBillsPaid;\n' + EXPORT, 'expose'),
    "    Object.assign(bills, { paid: cents / 100, paidTrust: trust });", "    Object.assign(bills, { paid: cents / 100, paidTrust: 'calculated' });", 'fixed trust'));
  ok(runPaid(fixed, [row('a', 30, true, 'calculated'), row('b', 20, true, 'estimated')]).paidTrust === 'calculated', 'a fixed calculated trust is caught (an estimated paid row reads calculated)');
  // The card checks from its own rule (every matched payment) instead of Forecast's flag.
  const ownRule = loadCards(replaceOnce(fs.readFileSync(CARDS_FILE, 'utf8'), "var exact = r.stackBillPaid === true;", "var exact = r.stackBillPaymentEvidence !== 'none';", 'card rule'));
  const r = caseResult(F, CASES[2][1], ownRule);
  ok(r.checkedOnCard !== cents(r.b.paid), 'a card check that is not Forecast\'s rule is caught (the checked rows no longer sum to paid)', `${r.checkedOnCard / 100} / ${r.b.paid}`);
}

console.log(failures ? `${failures} of ${checks} FAILED` : `All ${checks} Bills paid checks passed`);
process.exit(failures ? 1 : 0);
