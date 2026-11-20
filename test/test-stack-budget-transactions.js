'use strict';
/* Stack page: tap a household budget category, see the transactions Forecast counted into its Spent (Dale,
 * 2026-11-20). The list is the row's published recon[] less the pending copy of a posted transaction, newest
 * first: name (Lunch Money's own), date, amount, nothing else. It shows only when Spent is proven for this exact
 * period; otherwise nothing at all.
 *
 *   1. hand-built invented rows: exact text, order, refund sign, the pending/posted pair, name fallback, escaping;
 *   2. each of the four no-list cases shows no list and no words: a saved close, an unpublished Spent, a withheld
 *      category, a projected period;
 *   3. independent reconciliation on every invented figures input: for each row that passes the four conditions,
 *      the cents of the listed amounts sum to the published Spent (arithmetic that lives in this test, not the page),
 *      the corpus shows at least one list, and the pending twin is hidden;
 *   4. the page does no money arithmetic and adds no heading or word.
 *
 * Invented data only. `node test/test-stack-budget-transactions.js` */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

function load() {
  const ctx = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  vm.runInContext(read('public/stack-sheet.js'), ctx);
  return ctx;
}
const win = load();
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const sheet = (view, id) => win.StackSheet.html({ recommendation: { payPeriodViews: [view] }, selectedPeriodKey: view.start }, 'budget:' + id);
const rowsOf = html => [...html.matchAll(/<li><span class="stack-sheet-txd">([^<]*)<\/span><span class="stack-sheet-txl">([^<]*)<\/span><span class="stack-sheet-txa stack-n">([^<]*)<\/span><\/li>/g)]
  .map(m => ({ date: m[1], name: m[2], amount: m[3] }));
const centsOf = printed => { const n = Math.round(Number(printed.replace(/[−-]/, '').replace(/[$,]/g, '')) * 100); return /^[−-]/.test(printed) ? -n : n; };

const RECON = [
  { date: '2031-03-02', amount: 40, displayedPayee: 'Corner Grocer', originalMerchant: 'CORNER GROCER 12', pending: false },
  { date: '2031-03-09', amount: 25.5, displayedPayee: null, originalMerchant: 'Fish & Chips', pending: false },
  { date: '2031-03-09', amount: -10, displayedPayee: 'Corner Grocer', originalMerchant: 'x', pending: false },          // a refund, same day
  { date: '2031-03-07', amount: 12.25, displayedPayee: 'Cafe', pending: true, pendingPostedDuplicate: true },            // pending twin of a posted row: hidden
  { date: '2031-03-07', amount: 12.25, displayedPayee: 'Cafe', pending: false },                                         // its posted row
  { date: '2031-03-11', amount: 8, displayedPayee: '<b>Bad</b>', pending: true, pendingAmountEstimated: true, pendingPostedDuplicate: true }, // estimated pending: counted
];
const view = (over = {}) => Object.assign({ start: '2031-03-01', householdBudget: [
  { id: 'groceries', label: 'Groceries', spent: 75.75, reconMatchesSpent: true, planned: 500, remaining: 424.25, overspend: 0, recon: RECON }] }, over);

console.log('1. The list');
{
  const html = sheet(view(), 'groceries');
  const rows = rowsOf(html);
  ok(rows.length === 5, 'every counted row is listed; the pending twin is not', JSON.stringify(rows));
  ok(JSON.stringify(rows.map(r => r.name)) === JSON.stringify(['&lt;b&gt;Bad&lt;/b&gt;', 'Fish &amp; Chips', 'Corner Grocer', 'Cafe', 'Corner Grocer']),
    'names in newest-first order, escaped', JSON.stringify(rows.map(r => r.name)));
  ok(rows[0].date === 'Mar 11' && rows[1].date === 'Mar 9' && rows[2].date === 'Mar 9' && rows[3].date === 'Mar 7' && rows[4].date === 'Mar 2', 'newest first, ties keep their published order',
    rows.map(r => r.date).join());
  ok(rows[1].name === 'Fish &amp; Chips', 'a row with no displayed name uses the original merchant, escaped', rows[1].name);
  ok(rows[2].amount === '−$10', 'a refund prints negative', rows[2].amount);
  ok(/&lt;b&gt;Bad&lt;\/b&gt;/.test(html) && !/<b>Bad/.test(html), 'a name is never markup');
  ok(!/Transactions|Pending|pending/.test(text(html)), 'no heading and no status word');
  ok(rows.filter(r => r.name === 'Cafe').length === 1, 'the posted copy is listed once');
  ok(html.indexOf('<ul class="stack-sheet-tx">') > html.indexOf('</dl>'), 'the list sits under the figures');
  const dts = [...html.matchAll(/<dt>([^<]*)<\/dt>/g)].map(m => m[1]);
  ok(JSON.stringify(dts) === JSON.stringify(['Left']), 'the sheet has one row, Left (no Spent or Budget row)', JSON.stringify(dts));
  ok(/^Budget Groceries \$75.75 \/ \$500 Left \$424.25 /.test(text(html)), 'the headline still shows spent and budget, then Left', text(html).slice(0, 60));
  const noPlan = sheet(view({ householdBudget: [{ id: 'groceries', label: 'Groceries', spent: 75.75, planned: null, remaining: null, overspend: 0, recon: [] }] }), 'groceries');
  ok(/^Budget Groceries \$75.75 \/ —/.test(text(noPlan)) && /stack-sheet-big stack-n"><span[^>]*>\$75.75<\/span><i[^>]*> \/ <span role="img" aria-label="not available">\u2014<\/span><\/i>/.test(noPlan),
    'an unpublished plan shows a dash after the spent figure, not nothing and not $0', text(noPlan).slice(0, 60));
  const overHtml = sheet(view({ householdBudget: [{ id: 'groceries', label: 'Groceries', spent: 600, planned: 500, remaining: 0, overspend: 100, recon: [] }] }), 'groceries');
  ok(JSON.stringify([...overHtml.matchAll(/<dt>([^<]*)<\/dt>/g)].map(m => m[1])) === JSON.stringify(['Over']), 'an overspent category shows one row, Over');
}

console.log('2. No list');
{
  const none = html => !/stack-sheet-tx/.test(html) && /Groceries/.test(html);
  ok(none(sheet(view({ capturedClose: { source: 'period-history' } }), 'groceries')), 'a saved close borrows recon: no list');
  const mut = patch => view({ householdBudget: [Object.assign({ id: 'groceries', label: 'Groceries', planned: 500, recon: RECON, spent: 75.75, reconMatchesSpent: true }, patch)] });
  ok(none(sheet(mut({ spent: null, reconMatchesSpent: undefined }), 'groceries')), 'Spent unpublished: no list');
  ok(none(sheet(mut({ reconMatchesSpent: false }), 'groceries')), 'Forecast says the rows do not reconcile to Spent: no list');
  ok(none(sheet(mut({ reconMatchesSpent: undefined }), 'groceries')), 'flag absent: fails closed, no list');
  ok(none(sheet(mut({ withheldReason: 'coverage lost' }), 'groceries')), 'a withheld category (a lower bound only): no list');
  ok(none(sheet(mut({ projected: true }), 'groceries')), 'a projected period: no list');
  ok(none(sheet(mut({ recon: [] }), 'groceries')) && none(sheet(mut({ recon: undefined }), 'groceries')), 'no rows, or no recon: no list');
  ok(!/stack-sheet-txh|Transactions/.test(sheet(mut({ spent: null, reconMatchesSpent: undefined }), 'groceries')), 'and no explanation');
  const other = view({ householdBudget: [{ id: 'other-spending', label: 'Other spending', otherSpending: true, spent: 22.99, reconMatchesSpent: true, planned: 0, withheldReason: null,
    recon: [{ date: '2031-03-04', amount: 22.99, displayedPayee: 'Hardware', pending: false }] }] });
  ok(rowsOf(sheet(other, 'other-spending')).length === 1, 'the Other spending row lists its own recon');
}

console.log('3. Reconciliation on the invented figures inputs');
{
  const F = require('../public/forecast.js');
  const Snap = require('../scripts/figures-snapshot.js');
  const inputs = Snap.loadInventedInputs();
  let listed = 0, hidden = 0, twinsSeen = 0;
  for (const inp of inputs) {
    const data = structuredClone(inp.doc.data);
    const rec = F.recommend(data.plan, data.meta.asOf, Snap.pageOptions(data, inp.doc.periods == null ? null : structuredClone(inp.doc.periods)));
    for (const v of rec.payPeriodViews) {
      for (const item of Array.isArray(v.householdBudget) ? v.householdBudget : []) {
        if (!item || item.id == null) continue;
        const html = win.StackSheet.html({ recommendation: { payPeriodViews: [JSON.parse(JSON.stringify(v))] }, selectedPeriodKey: v.start }, 'budget:' + item.id);
        if (html == null) continue;
        const proven = !v.capturedClose && item.reconMatchesSpent === true && !item.withheldReason && item.projected !== true;
        const rows = rowsOf(html);
        if (!proven) { ok(rows.length === 0, 'not proven: no list for ' + item.id + '@' + v.start); hidden++; continue; }
        const counted = (Array.isArray(item.recon) ? item.recon : []).filter(r => r && !(r.pendingPostedDuplicate === true && r.pending === true && r.pendingAmountEstimated !== true));
        twinsSeen += (Array.isArray(item.recon) ? item.recon.length : 0) - counted.length;
        if (!counted.length) continue;
        const sum = rows.reduce((s, r) => s + centsOf(r.amount), 0);
        assert.strictEqual(sum, Math.round(item.spent * 100), `${inp.id} ${v.start} ${item.id}: listed ${sum} cents vs Spent ${Math.round(item.spent * 100)}`);
        listed++;
      }
    }
  }
  ok(listed > 0, 'at least one list reconciles to the published Spent, to the cent (' + listed + ' lists, ' + hidden + ' correctly hidden)');
  console.log('        corpus pending twins excluded: ' + twinsSeen + ' (the hand case in section 1 covers the pair)');
}

console.log('3b. End to end: Forecast publishes the flag, the page obeys it');
{
  const F = require('../public/forecast.js');
  const Snap = require('../scripts/figures-snapshot.js');
  const fx = require('./fixtures/budget-surface-data.js');
  const otherRow = (a, b) => {
    const data = fx.served(); const packet = data.liveOverlay.currentPeriodActuals;
    const t = packet.transactions.find(x => x.id === 'tx-7');
    t.amount = a; packet.transactions.push({ ...t, id: 'tx-8', amount: b, displayedPayee: 'Synthetic second store' });
    const rec = F.recommend(data.plan, fx.AS_OF, Snap.pageOptions(data, null));
    const v = rec.payPeriodViews.find(x => x.timelineRole === 'current');
    const row = (v.householdBudget || []).find(r => r.otherSpending);
    return { v: JSON.parse(JSON.stringify(v)), row };
  };
  const show = ({ v, row }) => rowsOf(win.StackSheet.html({ recommendation: { payPeriodViews: [v] }, selectedPeriodKey: v.start }, 'budget:' + row.id));
  const bad = otherRow(10, 1.005);
  ok(bad.row.reconMatchesSpent === false, 'sub-cent amounts that cannot reconcile: Forecast publishes false', String(bad.row.reconMatchesSpent));
  ok(show(bad).length === 0, 'and the page shows no list');
  const good = otherRow(10, 1.01);
  ok(good.row.reconMatchesSpent === true, 'whole-cent amounts: Forecast publishes true');
  const rows = show(good);
  const base = otherRow(10, 0);
  ok(rows.length > 0, 'and the page lists the rows');
  ok(rows.reduce((s, r) => s + centsOf(r.amount), 0) === Math.round(good.row.spent * 100), 'the listed cents equal the published Spent (independent sum)');
  ok(base.row.reconMatchesSpent === true, 'a plain whole-cent case also reconciles');
  // Pending copies of a posted purchase, through Forecast's own matching (same date, account, amount and name).
  const twin = estimated => {
    const data = fx.served(); const packet = data.liveOverlay.currentPeriodActuals;
    const posted = packet.transactions.find(x => x.id === 'tx-7');
    if (estimated) posted.distinctPendingId = 'tx-7p';
    packet.transactions.push({ ...posted, id: 'tx-7p', pending: true, pendingTreatment: 'pending', savingsPostingEvidence: 'pending' });
    const rec = F.recommend(data.plan, fx.AS_OF, Snap.pageOptions(data, null));
    const v = rec.payPeriodViews.find(x => x.timelineRole === 'current');
    return { v: JSON.parse(JSON.stringify(v)), row: v.householdBudget.find(r => r.otherSpending) };
  };
  const dup = twin(false), dupRows = show(dup);
  ok(dup.row.recon.length === 2 && dup.row.recon.some(r => r.pending === true && r.pendingPostedDuplicate === true && r.pendingAmountEstimated !== true),
    'Forecast publishes the suppressed pending twin in recon (not counted in Spent)');
  ok(dup.row.reconMatchesSpent === true && dupRows.length === 1, 'the sheet lists the posted purchase once, not its pending twin', String(dupRows.length));
  ok(dupRows.reduce((s, r) => s + centsOf(r.amount), 0) === Math.round(dup.row.spent * 100), 'and the listed cents equal the published Spent');
  const est = twin(true), estRows = show(est);
  ok(est.row.recon.some(r => r.pending === true && r.pendingAmountEstimated === true), 'Forecast keeps a linked pending amount as an estimate and counts it');
  ok(est.row.reconMatchesSpent === true && estRows.length === 2, 'the sheet lists both rows', String(estRows.length));
  ok(estRows.reduce((s, r) => s + centsOf(r.amount), 0) === Math.round(est.row.spent * 100), 'and the listed cents equal the published Spent');
}

console.log('4. The page adds nothing');
{
  const src = read('public/stack-sheet.js');
  const fn = src.slice(src.indexOf('{', src.indexOf('function budgetTransactionsHtml')), src.indexOf('// A credit line'));
  ok(!/\.reduce\(|\bsum\b|\+=/.test(fn), 'the list does no money arithmetic');
  ok(!/Transactions|Pending/.test(fn), 'no heading or word in the list');
}

console.log('\n' + checks + ' checks passed');
