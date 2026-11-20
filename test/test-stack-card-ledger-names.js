'use strict';
/* Stack card names come from the ledger (owner decision, Dale, 2026-11-20; Grok Bot, rule 17: Lunch Money is the one
 * home for names, and Atlas keeps no name map of its own).
 *
 *   1. The observation carries each Lunch Money account's name as ledgerName: display_name first (bank sync never
 *      overwrites it), else the provider's name, for bank-linked and manual accounts alike. The existing displayName
 *      (provider name first) is unchanged, because canonical-refresh sorts and prints rows by it.
 *   2. The live overlay serves it on the debt the account map names, by provider account id only, never by a name.
 *      Two accounts on one debt with different names give none, and a debt with no mapped account keeps no name.
 *   3. The Stack's waterfall credit rows and Credit card lines show ledgerName first, else their own label.
 *
 * Invented names, ids and amounts only.  `node test/test-stack-card-ledger-names.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const O = require('../scripts/provider-observe.js');
const L = require('../scripts/live-plan.js');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

console.log('1. The observation carries the Lunch Money name');
{
  const bank = O.normalizeLunchMoneyAccount({ id: 101, name: 'Invented Bank CARD 0001', display_name: 'Blue', type: 'credit' });
  ok(bank.ledgerName === 'Blue', 'a bank-linked account: its display_name', JSON.stringify(bank.ledgerName));
  ok(bank.displayName === 'Invented Bank CARD 0001', 'the existing displayName keeps the provider name first (canonical-refresh reads it)');
  const manual = O.normalizeLunchMoneyAccount({ id: 202, name: 'Invented Store Card', display_name: 'Green', type: 'credit' });
  ok(manual.ledgerName === 'Green', 'a manual account: its display_name the same way');
  ok(O.normalizeLunchMoneyAccount({ id: 303, name: 'Invented Plain Card' }).ledgerName === 'Invented Plain Card',
    'no display_name: the provider name');
  ok(O.normalizeLunchMoneyAccount({ id: 304, name: 'Invented', display_name: '   ' }).ledgerName === 'Invented', 'a blank display_name falls back');
  ok(O.normalizeLunchMoneyAccount({ id: 305, display_name: '  Two   words ' }).ledgerName === 'Two words', 'whitespace is collapsed and trimmed');
  ok(O.normalizeLunchMoneyAccount({ id: 306, display_name: 'x'.repeat(200) }).ledgerName.length === 60, 'a long name is capped at 60 characters');
  ok(O.normalizeLunchMoneyAccount({ id: 307, display_name: 7, name: null }).ledgerName === null, 'no text name: null, never a made-up one');
}

console.log('2. The overlay serves it by provider account id only');
{
  const debts = () => [{ id: 'cardA', label: 'Plan label A' }, { id: 'cardB', label: 'Blue' }, { id: 'cardC', label: 'Plan label C', ledgerName: 'Stale' }];
  const mapped = [
    { providerAccountId: '101', ledgerName: 'Blue', atlasId: 'cardA', collection: 'debts' },
    { providerAccountId: '202', ledgerName: 'Savings name', atlasId: 'savings1', collection: 'cash' },
  ];
  const d = debts();
  L.applyLedgerNames(d, { mapped });
  ok(d[0].ledgerName === 'Blue', 'the mapped debt gets its account\'s name');
  ok(!('ledgerName' in d[1]), 'a debt whose own label equals that name is untouched: nothing is matched by name');
  ok(!('ledgerName' in d[2]), 'a debt with no mapped account keeps no name (a stale one is removed)');
  ok(d.every(x => x.label && !x.label.startsWith('Savings')), 'a non-debt mapping names no debt');
  const two = debts();
  L.applyLedgerNames(two, { mapped: [{ ledgerName: 'One', atlasId: 'cardA', collection: 'debts' }, { ledgerName: 'Other', atlasId: 'cardA', collection: 'debts' }] });
  ok(!('ledgerName' in two[0]), 'two accounts on one debt with different names: none, never a guess');
  const same = debts();
  L.applyLedgerNames(same, { mapped: [{ ledgerName: 'One', atlasId: 'cardA', collection: 'debts' }, { ledgerName: 'One', atlasId: 'cardA', collection: 'debts' }] });
  ok(same[0].ledgerName === 'One', 'two accounts with the same name: that name');
  const none = debts();
  L.applyLedgerNames(none, null);
  ok(none.every(x => !('ledgerName' in x)), 'no report: no names, and stale ones removed');
  ok(d[0].label === 'Plan label A', 'the plan label itself never changes');
}

console.log('3. The Stack shows the ledger name first');
function load() {
  const ctx = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  const fns = {};
  const register = ctx.StackBlocks.register.bind(ctx.StackBlocks);
  ctx.StackBlocks.register = (name, fn) => { fns[name] = fn; register(name, fn); };
  vm.runInContext(read('public/stack-waterfall.js'), ctx);
  vm.runInContext(read('public/stack-credit.js'), ctx);
  return { win: ctx, fns };
}
const container = () => ({ innerHTML: '', addEventListener: () => {}, querySelector: () => null });
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
{
  const { win } = load();
  const data = { debts: [{ id: 'cardA', label: 'Plan A', ledgerName: 'Blue' }, { id: 'cardB', label: 'Plan B' }, { id: 'cardC', ledgerName: '  ' }] };
  const name = win.StackBlocks.cardName;
  ok(name(data, 'cardA', 'own') === 'Blue', 'cardName: the ledger name');
  ok(name(data, 'cardB', 'own') === 'own' && name(data, 'cardC', 'own') === 'own' && name(data, 'missing', 'own') === 'own'
    && name(null, 'cardA', 'own') === 'own', 'cardName: the block\'s own label when there is no ledger name');
}
{
  const { fns } = load();
  const view = { start: '2031-03-01', timelineRole: 'current',
    stackSummary: { bills: { mortgage: 0, cardMinimums: [{ debtId: 'cardA', amount: 25 }, { debtId: 'cardB', amount: 10 }, { debtId: 'cardZ', amount: 5 }], other: 0, trust: 'calculated' },
      surplus: { amount: 1, terms: { income: 1, bills: 0, household: 0, mortgage: 0, credit: 40 }, trust: 'calculated' } } };
  const el = container();
  fns.waterfall(el, { data: { debts: [{ id: 'cardA', label: 'Plan A', ledgerName: 'Blue' }, { id: 'cardB', label: 'Plan B' }] }, plan: {},
    recommendation: { payPeriodViews: [view] }, selectedPeriodKey: view.start, Forecast: null });
  const t = text(el.innerHTML);
  ok(/Blue \$25(?![\d.,])/.test(t) && !/Plan A/.test(t), 'waterfall: a credit row shows its ledger name', t);
  ok(/Plan B \$10(?![\d.,])/.test(t), 'waterfall: no ledger name, the plan label');
  ok(/cardZ \$5(?![\d.,])/.test(t), 'waterfall: no debt at all, the id (unchanged)');
}
{
  const { fns } = load();
  const fig = amount => ({ amount, trust: 'calculated', reasons: [] });
  const line = (id, label) => ({ id, label, paid: fig(1), spent: fig(1), net: fig(0), minimum: fig(1), toGo: fig(0), state: 'x', status: 'paid-back',
    minimumCovered: { value: true, trust: 'calculated', reasons: [] }, balance: fig(null), transactions: [] });
  const view = { start: '2031-03-01', end: '2031-03-14', stackSummary: { bills: {} } };
  const el = container();
  fns.credit(el, { data: { debts: [{ id: 'cardA', label: 'Plan A', ledgerName: 'Blue' }], meta: { asOf: '2031-03-10' }, liveOverlay: null }, plan: {},
    selectedPeriodKey: view.start, recommendation: { payPeriodViews: [view] },
    Forecast: { cardPeriodMovements: () => ({}), stackCreditLines: () => ({ lines: [line('cardA', 'Forecast A'), line('cardB', 'Forecast B')],
      totals: { paid: 2, spent: 2, trust: 'calculated', completeness: 'complete', excluded: [], reasons: [] } }) } });
  const t = text(el.innerHTML);
  ok(/Blue/.test(t) && !/Forecast A/.test(t), 'Credit card: a line shows its ledger name', t);
  ok(/Forecast B/.test(t), 'Credit card: no ledger name, Forecast\'s label');
}

console.log(`\nAll ${checks} stack card ledger name checks passed`);
