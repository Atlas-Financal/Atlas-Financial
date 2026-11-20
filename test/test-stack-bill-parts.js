'use strict';
/* Stack Wallet bill cards (DISPLAY design audit, lead 2026-11-20): each card's rows add up to its head.
 * Forecast publishes, on each bill row its period's bills split counts, that row's place in the split
 * (stackBillPart 'mortgage' | 'cardMinimum' | 'other'), the amount it adds there (stackBillAmount) and, for a
 * card minimum, its line (stackBillDebtId). The Bills and Mortgage cards list exactly their part's rows, so a
 * head (stackSummary.bills.other / .mortgage) never sits over rows that add up to something else.
 *
 * Proof, independent of the publisher: the invented Budget-surface household with its answer worked by hand,
 * through Forecast and the rendered cards; a plain bill named "mortgage" (a lookalike) that stays in Bills;
 * every invented figures input (each part's rows add up to that part, in cents); mutants of the one owner
 * (stackBillPartOf) and of the marker. Invented numbers only.  `node test/test-stack-bill-parts.js`
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const F = require('../public/forecast.js');
const fx = require('./fixtures/budget-surface-data');
const Snap = require('../scripts/figures-snapshot.js');

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

// The cards, as the Stack shell loads them (its trust rule and bar width).
const cards = (() => {
  const sandbox = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
  require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-shell.js'), 'utf8'), sandbox);
  const shell = sandbox.window.StackBlocks;
  globalThis.StackBlocks = { register: () => {}, isEstimated: shell.isEstimated, estClass: shell.estClass, budgetTrust: shell.budgetTrust, barWidth: shell.barWidth };
  const file = path.join(__dirname, '..', 'public', 'stack-cards.js');
  delete require.cache[require.resolve(file)];
  return require(file);
})();
const cardHtml = (view, kind) => cards.buildCardsHTML({ data: {}, plan: {}, recommendation: { payPeriodViews: [view] },
  selectedPeriodKey: view.start, Forecast: {} }).split('data-stack-card="' + kind + '"')[1].split('</details>')[0];
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// Each listed bill row's visible text (label and amount; a paid check shows as a check mark).
const rowLabels = h => h.split('<li class="sc-row sc-bill"').slice(1).map(x => { const li = x.split('</li>')[0]; return text(li.slice(li.indexOf('>') + 1)); });
const headOf = h => text(h.split('</summary>')[0].slice(h.indexOf('<summary>') + '<summary>'.length));
const CHECK = '\u2713';

const current = (Forecast, opts) => {
  const d = fx.served(opts);
  return Forecast.recommend(d.plan, d.meta.asOf, { debts: d.debts }).payPeriodViews.find(v => v.timelineRole === 'current');
};
const placed = view => (view.bills || []).filter(r => r.stackBillPart).map(r => [r.id, r.stackBillPart, r.stackBillAmount, r.stackBillDebtId || null]);

console.log('1. The invented household, mortgage as a mortgage payment (the answer by hand)');
{
  // Aug 14-27: mortgage 1,400 (paid), hydro 120, card minimum 60 (travelvisa), internet 85. Load 1,665.
  // Mortgage 1,400; card minimum 60; other = 120 + 85 = 205.
  const v = current(F, { mortgageObligation: true });
  ok(JSON.stringify([v.stackSummary.bills.mortgage, v.stackSummary.bills.other, v.stackSummary.bills.cardMinimums]) ===
    JSON.stringify([1400, 205, [{ debtId: 'travelvisa', amount: 60 }]]), 'split: mortgage 1,400, other 205, travelvisa minimum 60', JSON.stringify(v.stackSummary.bills));
  ok(JSON.stringify(placed(v)) === JSON.stringify([['mortgage', 'mortgage', 1400, null], ['hydro', 'other', 120, null],
    ['card-minimum', 'cardMinimum', 60, 'travelvisa'], ['internet', 'other', 85, null]]), 'each row is placed once, with its amount', JSON.stringify(placed(v)));
  const bills = cardHtml(v, 'bills'), mortgage = cardHtml(v, 'mortgage');
  ok(headOf(bills) === 'Bills $205' && JSON.stringify(rowLabels(bills)) === JSON.stringify(['Hydro $120', 'Internet $85']),
    'Bills card: head $205 over Hydro $120 and Internet $85 (the card minimum is not here)', headOf(bills) + ' | ' + rowLabels(bills).join(' | '));
  ok(headOf(mortgage) === 'Mortgage $1,400' && JSON.stringify(rowLabels(mortgage)) === JSON.stringify(['Mortgage $1,400 ' + CHECK]),
    'Mortgage card: head $1,400 over its paid $1,400 row', headOf(mortgage) + ' | ' + rowLabels(mortgage).join(' | '));
}

console.log('2. A plain bill named "mortgage" is not a mortgage payment');
{
  // The served fixture's mortgage is a plan bill, not an obligation: the split files its 1,400 under other,
  // so other = 1,400 + 120 + 85 = 1,605 and mortgage 0, and the cards follow the split.
  const v = current(F, {});
  ok(v.stackSummary.bills.mortgage === 0 && v.stackSummary.bills.other === 1605, 'split: mortgage 0, other 1,605');
  const bills = cardHtml(v, 'bills'), mortgage = cardHtml(v, 'mortgage');
  ok(headOf(bills) === 'Bills $1,605' && JSON.stringify(rowLabels(bills)) === JSON.stringify(['Mortgage $1,400 ' + CHECK, 'Hydro $120', 'Internet $85']),
    'Bills card lists the lookalike with hydro and internet: 1,400 + 120 + 85 = its $1,605 head', headOf(bills) + ' | ' + rowLabels(bills).join(' | '));
  ok(headOf(mortgage) === 'Mortgage $0' && rowLabels(mortgage).length === 0, 'Mortgage card: head $0 and no row', headOf(mortgage));
}

console.log('3. Every invented figures input: each part\'s rows add up to that part');
const cents = v => Math.round(v * 100);
function corpus(Forecast) {
  const out = { periods: 0, mismatched: 0, unmarkedPublished: 0, markedWithheld: 0, counted: 0, differs: 0 };
  for (const inp of Snap.loadInventedInputs()) {
    const d = structuredClone(inp.doc.data);
    const rec = Forecast.recommend(d.plan, d.meta.asOf, Snap.pageOptions(d, inp.doc.periods == null ? null : structuredClone(inp.doc.periods)));
    for (const v of rec.payPeriodViews) {
      const b = v.stackSummary.bills, rows = (v.bills || []).filter(r => r.stackBillPart);
      if (b.other === null) { if (rows.length) out.markedWithheld++; continue; }
      out.periods++;
      if (!rows.length && (v.bills || []).length) { out.unmarkedPublished++; continue; }
      out.counted += rows.length;
      out.differs += rows.filter(r => cents(r.stackBillAmount) !== cents(Math.abs(Number(r.amount) || 0))).length;
      const sum = part => rows.filter(r => r.stackBillPart === part).reduce((t, r) => t + cents(r.stackBillAmount), 0);
      const lines = {};
      for (const r of rows.filter(r => r.stackBillPart === 'cardMinimum')) lines[r.stackBillDebtId] = (lines[r.stackBillDebtId] || 0) + cents(r.stackBillAmount);
      const want = {}; for (const c of b.cardMinimums) want[c.debtId] = cents(c.amount);
      if (sum('other') !== cents(b.other) || sum('mortgage') !== cents(b.mortgage)
        || JSON.stringify(Object.entries(lines).sort()) !== JSON.stringify(Object.entries(want).sort())) out.mismatched++;
    }
  }
  return out;
}
{
  const c = corpus(F);
  ok(c.periods > 50 && c.mismatched === 0, `on ${c.periods} periods with a published split, the rows of each part add up to it`, `${c.mismatched} mismatched`);
  ok(c.unmarkedPublished === 0, 'every published split marks its rows', `${c.unmarkedPublished} unmarked`);
  ok(c.markedWithheld === 0, 'a withheld split marks no row', `${c.markedWithheld} marked`);
}
// A row can count an amount other than its own (a scheduled fee counts its periodCost; an overpaid bill its
// actual): no invented input has one today, so a hand-built period carries both.
const EXPORT = "  if (typeof module !== 'undefined' && module.exports) module.exports = Forecast;";
const exposeMarks = text => compile(replaceOnce(text, EXPORT,
  '  Forecast.__marks = { publishStackBillParts, periodAssignedBillParts, periodBillLoadPartsByPeriod };\n' + EXPORT, 'expose'), 'marks-' + checks);
function handPeriod(Forecast) {
  const M = Forecast.__marks;
  const plan = { obligations: [{ id: 'inv-mortgage', debtId: 'mortgage', effect: 'payment' }] };
  const view = { bills: [
    { id: 'fees', kind: 'bill', planned: 5, amount: 5, scheduledFeeAllowance: { periodCost: 8 } },
    { id: 'gas', kind: 'bill', planned: 40, amount: 40, actual: 47.5, status: 'PAID' },
    { id: 'inv-mortgage', kind: 'obligation', planned: 300, amount: 300 },
  ] };
  // 8 + 47.50 (paid above plan) + 300 = 355.50.
  const parts = M.periodAssignedBillParts(view.bills, row => (row.actual > row.planned ? row.actual : row.planned), plan, 355.5);
  M.periodBillLoadPartsByPeriod.set(view, parts);
  M.publishStackBillParts(view, { mortgage: parts.mortgage, cardMinimums: parts.cardMinimums, other: parts.other, trust: 'calculated' });
  return { view, parts };
}
{
  const { view, parts } = handPeriod(exposeMarks(SOURCE));
  ok(parts.other === 55.5 && parts.mortgage === 300
    && JSON.stringify(view.bills.map(r => [r.id, r.stackBillPart, r.stackBillAmount])) === JSON.stringify([['fees', 'other', 8], ['gas', 'other', 47.5], ['inv-mortgage', 'mortgage', 300]]),
  'a scheduled fee is marked at its periodCost and an overpaid bill at what it counts (8 + 47.50 = other 55.50)', JSON.stringify(view.bills.map(r => r.stackBillAmount)));
}

console.log('3b. Known limit (lead ruling, option a): a card row is what the split counts, its sheet what was paid');
{
  // A 90 monthly hydro, paid 120 in August (unconfirmed), 90 in September and 40 in October (partly paid).
  // The split counts billAssignedAmount (the plan, or a larger observed payment), so every month adds 90 to
  // its period's bills and the card row prints 90; the bill's sheet (billHistory) shows the payment the ledger
  // has, 120 and 40. Pinned so a change to either side is deliberate; whether a partly paid bill should count
  // 90 or 40 is an owner question, not this code's.
  const H = require('./acceptance/harness.js');
  const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
  const pay = (date, amount) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' });
  const w = H.baseWorld(); w.bills = [HYDRO];
  w.transactions = [pay('2026-08-12', 120), pay('2026-09-12', 90), pay('2026-10-12', 40)];
  const o = H.observe(w); if (o.error) throw o.error;
  const rec = F.recommend(o.plan, w.asOf, { currentPeriodActuals: o.packet });
  const card = new Map(), sheet = new Map((rec.billHistory.hydro || []).map(e => [e.date, e.amount]));
  for (const v of rec.payPeriodViews) for (const b of v.bills || []) if (b.id === 'hydro' && b.stackBillPart) card.set(b.date, b.stackBillAmount);
  const pairs = ['2026-08-12', '2026-09-12', '2026-10-12'].map(d => [d, card.get(d), sheet.get(d)]);
  ok(JSON.stringify(pairs) === JSON.stringify([['2026-08-12', 90, 120], ['2026-09-12', 90, 90], ['2026-10-12', 90, 40]]),
    'card row 90 / sheet 120 (unconfirmed overpayment), 90 / 90, 90 / 40 (partly paid)', JSON.stringify(pairs));
}

console.log('4. Mutants are caught');
{
  // The one owner files every obligation under other: the split and the rows move together.
  const allOther = compile(replaceOnce(SOURCE, "    if (context.mortgageIds.has(id)) return { part: 'mortgage', debtId: null };\n", '', 'mortgage part'), 'all-other');
  const v1 = current(allOther, { mortgageObligation: true });
  ok(v1.stackSummary.bills.mortgage === 0 && v1.stackSummary.bills.other === 1605 && rowLabels(cardHtml(v1, 'mortgage')).length === 0
    && rowLabels(cardHtml(v1, 'bills')).length === 3, 'removing the mortgage part moves the split and the rows together (one owner)');
  // The marker stamps the row's own amount, not the counted one: some part no longer adds up.
  const ownAmount = exposeMarks(replaceOnce(SOURCE, '      mark.row.stackBillAmount = mark.cents / 100;', '      mark.row.stackBillAmount = mark.row.amount;', 'own amount'));
  const own = handPeriod(ownAmount).view.bills;
  ok(own[0].stackBillAmount === 5 && own[0].stackBillAmount + own[1].stackBillAmount !== 55.5, 'marking the row\'s own amount is caught: the other rows stop adding up to other');
  // The marker forgets to clear a stale mark: a withheld split would keep it.
  const EXPORT = "  if (typeof module !== 'undefined' && module.exports) module.exports = Forecast;";
  const expose = replaceOnce(SOURCE, EXPORT, '  Forecast.__marks = publishStackBillParts;\n' + EXPORT, 'expose');
  const CLEAR = "    for (const row of rows) if (row && typeof row === 'object') for (const key of STACK_BILL_MARKS) delete row[key];\n";
  const shipped = compile(expose, 'marks'), stale = compile(replaceOnce(expose, CLEAR, '', 'stale'), 'stale');
  const withheld = () => ({ bills: [{ id: 'x', stackBillPart: 'other', stackBillAmount: 5 }] });
  const a = withheld(), b = withheld();
  shipped.__marks(a, { other: null, trust: 'unavailable' });
  stale.__marks(b, { other: null, trust: 'unavailable' });
  ok(!Object.hasOwn(a.bills[0], 'stackBillPart') && Object.hasOwn(b.bills[0], 'stackBillPart'),
    'a stale mark under a withheld split is cleared, and keeping it is caught');
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} stack bill part checks passed`);
process.exit(failures ? 1 : 0);
