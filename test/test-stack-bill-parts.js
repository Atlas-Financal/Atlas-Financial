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
  globalThis.StackBlocks = { register: () => {}, isEstimated: shell.isEstimated, estClass: shell.estClass, budgetTrust: shell.budgetTrust, barWidth: shell.barWidth, money: shell.money };
  const file = path.join(__dirname, '..', 'public', 'stack-cards.js');
  delete require.cache[require.resolve(file)];
  return require(file);
})();
const cardHtml = (view, kind) => cards.buildCardsHTML({ data: {}, plan: {}, recommendation: { payPeriodViews: [view] },
  selectedPeriodKey: view.start, Forecast: {} }).split('data-stack-card="' + kind + '"')[1].split('</details>')[0];
const pageHtml = view => cards.buildCardsHTML({ data: {}, plan: {}, recommendation: { payPeriodViews: [view] },
  selectedPeriodKey: view.start, Forecast: {} });
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// Each listed bill row's visible text (label and amount; a paid check shows as a check mark).
const rowLabels = h => h.split('<li class="sc-row sc-bill').slice(1).map(x => { const li = x.split('</li>')[0]; return text(li.slice(li.indexOf('>') + 1)); });
const headOf = h => { const sum = h.slice(h.indexOf('<summary'), h.indexOf('</summary>')); return text(sum.slice(sum.indexOf('>') + 1)); };
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
  const bills = cardHtml(v, 'bills');
  ok(headOf(bills) === 'Bills $0 / $205' && JSON.stringify(rowLabels(bills)) === JSON.stringify(['Hydro $120', 'Internet $85']),
    'Bills card: head $0 paid / $205 over Hydro $120 and Internet $85, neither checked (the card minimum is not here)', headOf(bills) + ' | ' + rowLabels(bills).join(' | '));
  // There is no Mortgage card: Forecast still places the mortgage row (above), the page prints it only in the waterfall.
  ok(!pageHtml(v).includes('data-stack-card="mortgage"') && !/mortgage/i.test(text(pageHtml(v))), 'no Mortgage card on the page, and no mortgage row on any card');
}

console.log('2. A plain bill named "mortgage" is not a mortgage payment');
{
  // The served fixture's mortgage is a plan bill, not an obligation: the split files its 1,400 under other,
  // so other = 1,400 + 120 + 85 = 1,605 and mortgage 0, and the cards follow the split.
  const v = current(F, {});
  ok(v.stackSummary.bills.mortgage === 0 && v.stackSummary.bills.other === 1605, 'split: mortgage 0, other 1,605');
  const bills = cardHtml(v, 'bills');
  ok(headOf(bills) === 'Bills $0 / $1,605' && JSON.stringify(rowLabels(bills)) === JSON.stringify(['Mortgage $1,400', 'Hydro $120', 'Internet $85']),
    'Bills card lists the lookalike with hydro and internet: 1,400 + 120 + 85 = its $1,605 head, none checked so $0 paid', headOf(bills) + ' | ' + rowLabels(bills).join(' | '));
  ok(!pageHtml(v).includes('data-stack-card="mortgage"'), 'no Mortgage card to show a $0 head');
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

console.log('3b. The check is a confirmed payment only; otherwise no check and the plan (Dale, #1465)');
// Owner (Dale, 2026-11-20, relayed by the lead on #1465): "a check for confirmed and no check for not confirmed I don't
// need an in between"; a pending payment is up to Grok Bot, who verifies posted rows only. So only a posted payment exactly
// the counted amount gets the check ("Paid $X"); pending, differing or unmatched show no check and "Planned $X".
const H = require('./acceptance/harness.js');
const sheetWin = (() => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const ctx = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx; ctx.globalThis = ctx;
  require('vm').createContext(ctx);
  for (const f of ['shell', 'waterfall', 'cards', 'credit', 'sheet']) require('vm').runInContext(read(`public/stack-${f}.js`), ctx);
  return ctx;
})();
function sheetOf(rec, date) {
  const v = rec.payPeriodViews.find(p => (p.bills || []).some(b => b.id === 'hydro' && b.date === date));
  const bill = v.bills.find(b => b.id === 'hydro' && b.date === date);
  return sheetWin.StackSheet.html({ recommendation: rec, selectedPeriodKey: v.start, data: { meta: { asOf: '2026-12-31' } }, Forecast: {} }, `bill:hydro@${date}`) || '';
}
function hydroWorld(Forecast, octoberPending, octoberOverpaid) {
  const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
  const pay = (date, amount, extra = {}) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro', ...extra });
  const w = H.baseWorld(); w.bills = [HYDRO];
  w.transactions = [pay('2026-08-12', 120), pay('2026-09-12', 90), octoberPending ? pay('2026-10-12', 90, { pending: true }) : pay('2026-10-12', octoberOverpaid ? 120 : 40)];
  const o = H.observe(w); if (o.error) throw o.error;
  return Forecast.recommend(o.plan, w.asOf, { currentPeriodActuals: o.packet });
}
function hydroCards(rec, render = cardHtml) {
  const out = {};
  for (const v of rec.payPeriodViews) {
    const b = (v.bills || []).find(r => r.id === 'hydro' && r.stackBillPart);
    if (!b) continue;
    const li = render(v, 'bills').split('<li class="sc-row sc-bill').slice(1).map(x => x.split('</li>')[0]).find(x => x.includes('Invented hydro')) || '';
    out[b.date] = { evidence: b.stackBillPaymentEvidence, shown: b.stackBillAmount, check: li.includes('sc-check'),
      name: (li.match(/class="sc-a[^"]*" aria-label="([^"]*)"/) || [])[1] || null,
      checkName: (li.match(/class="sc-check" role="img" aria-label="([^"]*)"/) || [])[1] || null,
      visible: li.replace(/ (aria-label|data-stack-sheet)="[^"]*"/g, ''), paidState: b.paidState };
  }
  return out;
}
{
  const rec = hydroWorld(F, false);
  const c = hydroCards(rec), sheet = new Map((rec.billHistory.hydro || []).map(e => [e.date, e.amount]));
  const got = ['2026-08-12', '2026-09-12', '2026-10-12'].map(d => [d, c[d] && c[d].evidence, c[d] && c[d].shown, c[d] && c[d].checkName, c[d] && c[d].name, sheet.get(d)]);
  ok(JSON.stringify(got) === JSON.stringify([
    ['2026-08-12', 'pending', 90, null, 'Planned $90', 120],
    ['2026-09-12', 'posted-equal', 90, 'Paid', 'Paid $90', 90],
    ['2026-10-12', 'posted-differs', 90, null, '$90, payment not confirmed', 40]]),
  'unconfirmed 120: plan, no check; posted 90 = 90: "Paid $90" + check; posted 40 vs 90: no check, not confirmed', JSON.stringify(got));
  // What a sighted reader sees (Atlas 7045795702): with the accessible names removed, the confirmed row has a check
  // and the pending and differing rows have none.
  ok(c['2026-09-12'].visible.includes('\u2713') && !c['2026-08-12'].visible.includes('\u2713') && !c['2026-10-12'].visible.includes('\u2713')
    && c['2026-09-12'].visible !== c['2026-08-12'].visible,
  'visibly: a check on the confirmed row only, none on the pending or differing row', JSON.stringify([c['2026-08-12'].visible, c['2026-09-12'].visible]));
  // Atlas's probe: a pending payment (status pending, actual null) the ledger matched: no check until it posts, the plan.
  const p = hydroCards(hydroWorld(F, true))['2026-10-12'];
  ok(p && p.evidence === 'pending' && p.paidState === 'paid' && p.check === false && p.name === 'Planned $90',
    'a pending matched payment: no check, the planned amount', JSON.stringify(p));
  // Owner (7046237901): a posted overpayment is compared with the PLAN, not the count that already took it up:
  // plan 90, posted 120, counted 120 is 'posted-differs', no check, until Grok Bot verifies it.
  const over = hydroCards(hydroWorld(F, false, true))['2026-10-12'];
  ok(over && over.evidence === 'posted-differs' && over.check === false && over.shown === 120 && over.name === '$120, payment not confirmed',
    'a posted overpayment (plan 90, posted 120): $120 counted, no check, named "$120, payment not confirmed" (never "Planned $120")', JSON.stringify(over && { e: over.evidence, shown: over.shown, check: over.check, name: over.name }));
  // The bill sheet's check follows the same rule (billHistory paidConfirmed): only Sep (posted 90 = plan 90).
  const sheetRec = hydroWorld(F, false, true);
  const conf = Object.fromEntries((sheetRec.billHistory.hydro || []).map(e => [e.date, e.paidConfirmed]));
  ok(conf['2026-08-12'] === false && conf['2026-09-12'] === true && conf['2026-10-12'] === false,
    'billHistory paidConfirmed: unconfirmed 120 no, posted 90 = plan yes, posted 120 over plan no', JSON.stringify(conf));
  const sheetHtml = sheetOf(sheetRec, '2026-10-12');
  const hist = sheetHtml.split('<li>').slice(1);
  ok(!sheetHtml.split('stack-sheet-hist')[0].includes('\u2713') && hist.length === 2
    && hist.filter(li => li.includes('\u2713')).length === 1 && hist.find(li => li.includes('\u2713')).includes('$90'),
    'bill sheet: no check on the over-plan headline or the unconfirmed past one; the confirmed $90 keeps its check', sheetHtml);
  // No matched payment: no check.
  const n = hydroCards(hydroWorld(F, false))['2026-11-12'] || hydroCards(hydroWorld(F, false))[Object.keys(hydroCards(hydroWorld(F, false))).pop()];
  ok(n && n.evidence === 'none' && n.check === false && n.name === 'Planned $90', 'no matched payment: the plan, no check', JSON.stringify(n));
}

console.log('4. Mutants are caught');
{
  // The one owner files every obligation under other: the split and the rows move together.
  const allOther = compile(replaceOnce(SOURCE, "    if (context.mortgageIds.has(id)) return { part: 'mortgage', debtId: null };\n", '', 'mortgage part'), 'all-other');
  const v1 = current(allOther, { mortgageObligation: true });
  ok(v1.stackSummary.bills.mortgage === 0 && v1.stackSummary.bills.other === 1605 && !pageHtml(v1).includes('data-stack-card="mortgage"')
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

{
  // The marker calls a differing posted payment equal: the plan would be named as the payment.
  const allEqual = compile(replaceOnce(SOURCE, "      return posted === cents && posted === stackBillPlannedCents(row) ? 'posted-equal' : 'posted-differs';", "      return 'posted-equal';", 'all equal'), 'all-equal');
  ok(hydroCards(hydroWorld(allEqual, false))['2026-10-12'].check === true, 'calling a differing payment equal is caught (the plan gets a check)');
  // The marker compares with the counted amount only: an overpayment the count took up gets the check.
  const countedOnly = compile(replaceOnce(SOURCE, "posted === cents && posted === stackBillPlannedCents(row) ?", "posted === cents ?", 'counted only'), 'counted-only');
  ok(hydroCards(hydroWorld(countedOnly, false, true))['2026-10-12'].check === true, 'comparing with the counted amount only is caught (an overpayment gets the check)');
  // The page checks every matched payment: the pending and differing rows gain a check.
  const file = path.join(__dirname, '..', 'public', 'stack-cards.js');
  const allCheck = replaceOnce(fs.readFileSync(file, 'utf8'), "'<span class=\"sc-ck\">' + (exact ?", "'<span class=\"sc-ck\">' + (r.stackBillPaymentEvidence !== 'none' ?", 'all check');
  const box = { module: { exports: {} }, window: { StackBlocks: globalThis.StackBlocks }, StackBlocks: globalThis.StackBlocks }; box.exports = box.module.exports;
  require('vm').runInNewContext(allCheck, box);
  const m = box.module.exports.buildCardsHTML ? box.module.exports : box.window.StackCards;
  const render = (view, kind) => m.buildCardsHTML({ data: {}, plan: {}, recommendation: { payPeriodViews: [view] },
    selectedPeriodKey: view.start, Forecast: {} }).split('data-stack-card="' + kind + '"')[1].split('</details>')[0];
  const mc = hydroCards(hydroWorld(F, true), render);
  ok(mc['2026-10-12'].check === true && mc['2026-08-12'].check === true, 'checking every matched payment is caught (pending and unconfirmed rows gain a check)');
}

{
  // The sheet checks every paid occurrence (paidState only): the unconfirmed past payment gains a check.
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const ctx = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx; ctx.globalThis = ctx;
  require('vm').createContext(ctx);
  for (const f of ['shell', 'waterfall', 'cards', 'credit']) require('vm').runInContext(read(`public/stack-${f}.js`), ctx);
  require('vm').runInContext(replaceOnce(read('public/stack-sheet.js'), '${ePaid && e.paidConfirmed === true ? CHECK', '${ePaid ? CHECK', 'sheet paid only'), ctx);
  const rec = hydroWorld(F, false, true);
  const v = rec.payPeriodViews.find(p => (p.bills || []).some(b => b.id === 'hydro' && b.date === '2026-10-12'));
  const html = ctx.StackSheet.html({ recommendation: rec, selectedPeriodKey: v.start, data: { meta: { asOf: '2026-12-31' } }, Forecast: {} }, 'bill:hydro@2026-10-12') || '';
  ok(html.split('<li>').slice(1).filter(li => li.includes('\u2713')).length === 2, 'a sheet that checks every paid occurrence is caught (the unconfirmed one gains a check)');
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} stack bill part checks passed`);
process.exit(failures ? 1 : 0);
