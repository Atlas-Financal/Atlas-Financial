// Stack page B3: Bills, Budget and Mortgage cards. Invented figures only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'stack-cards.js');

// --- invented published view (shapes from #1426 stackSummary, #1429 paidState, existing budgetProgress) ---
const view = {
  start: '2026-01-01',
  stackSummary: { bills: { mortgage: 1234.56, cardMinimums: [{ debtId: 'card-a', amount: 77.77 }], other: 888.88, trust: 'calculated' } },
  bills: [
    { id: 'hydro', label: 'Hydro', amount: 111.11, paidState: 'paid' },
    { id: 'phone', label: 'Phone', amount: 222.22, paidState: 'not-paid' },
    { id: 'old', label: 'Carried one', amount: 999.99, paidState: 'carried' },
    { id: 'mortgage', debtId: 'mortgage', label: 'Mortgage', amount: 1234.56, paidState: 'not-paid' },
    { id: 'cardmin', debtId: 'card-a', label: 'Card A minimum', amount: 77.77, paidState: 'paid' },
  ],
  budgetProgress: { household: { actual: { amount: 333.33 }, planned: { amount: 666.66 } } },
  householdBudget: [
    { label: 'Groceries', spent: 123.45, planned: 400 },
    { label: 'Fun <money>', spent: 10.1, planned: 50.5 },
    { label: 'Hidden', informational: true, spent: 5, planned: 5 },
  ],
};
const ctx = (v, key) => ({ data: {}, plan: {}, recommendation: { payPeriodViews: [v] }, selectedPeriodKey: key === undefined ? '2026-01-01' : key, Forecast: {} });

let registered = {};
global.window = undefined;
globalThis.StackBlocks = { register: (n, f) => { registered[n] = f; } };
delete require.cache[require.resolve(file)];
const mod = require(file);
assert.strictEqual(typeof registered.cards, 'function', 'registers as cards');
const { buildCardsHTML } = mod;

const fmt = n => (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amounts = html => (html.replace(/<[^>]+>/g, ' ').match(/−?\$[\d,]+\.\d\d/g) || []);

// 1. every printed amount equals a published value it names; nothing computed
const html = buildCardsHTML(ctx(view));
const allowed = new Set([888.88, 1234.56, 111.11, 222.22, 333.33, 666.66, 123.45, 400, 10.1, 50.5].map(fmt));
const printed = amounts(html);
assert(printed.length > 0);
printed.forEach(a => assert(allowed.has(a), 'unpublished amount printed: ' + a));
// each card's headline is exactly its published value
const card = k => html.split('data-stack-card="' + k + '"')[1].split('</details>')[0];
assert(card('bills').includes(fmt(888.88)), 'bills headline = stackSummary.bills.other');
assert(card('budget').includes(fmt(333.33)) && card('budget').includes(fmt(666.66)));
assert(card('mortgage').includes(fmt(1234.56)));
// excluded: mortgage, card minimum and carried rows are not in Bills; their amounts never appear there
['Mortgage', 'Card A minimum', 'Carried one'].forEach(n => assert(!card('bills').includes(n), n + ' leaked into Bills'));
assert(!card('bills').includes(fmt(77.77)) && !card('bills').includes(fmt(999.99)));
assert(!html.includes(fmt(999.99)) && !html.includes('Hidden'));
// rows read Paid / Not paid from paidState
assert(/Hydro<\/b><small class="sc-st sc-paid">Paid</.test(card('bills')));
assert(/Phone<\/b><small class="sc-st">Not paid</.test(card('bills')));
assert(/Mortgage<\/b><small class="sc-st">Not paid</.test(card('mortgage')));
// category rows read spent / planned; markup is escaped
assert(card('budget').includes(fmt(123.45)) && card('budget').includes(fmt(400)));
assert(card('budget').includes('Fun &lt;money&gt;'));
// closed strips: native <details>, no `open` attribute
assert(!/<details[^>]* open/.test(html));

// 2. not published => nothing, never $0
const bare = JSON.parse(JSON.stringify(view));
bare.stackSummary.bills = { mortgage: null, cardMinimums: null, other: null, trust: 'unavailable' };
bare.budgetProgress.household = { actual: { amount: null }, planned: { amount: null } };
bare.bills.forEach(b => delete b.paidState);
bare.householdBudget = [{ label: 'X', spent: null }];
const h2 = buildCardsHTML(ctx(bare));
assert(!/\$0(\.00)?\b/.test(h2) && amounts(h2).length === 0, 'unpublished figure printed');
assert(!h2.includes('Not paid') && !h2.includes('>Paid<'), 'state printed without paidState');
const none = { start: '2026-01-01' }; // no stackSummary at all (#1426 not merged)
assert.strictEqual(amounts(buildCardsHTML(ctx(none))).length, 0);
assert.strictEqual(buildCardsHTML(ctx(view, 'zzz')), '', 'unknown period renders nothing');
assert.strictEqual(buildCardsHTML(null), '');
// a published zero is a real value and prints
const z = JSON.parse(JSON.stringify(view)); z.stackSummary.bills.other = 0;
assert(buildCardsHTML(ctx(z)).includes('$0.00'));

// card colours: every kind's variable is defined in the CSS file
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-cards.css'), 'utf8');
['bills', 'budget', 'mortgage'].forEach(k => assert(css.includes('--sc-' + k + ':'), 'css var missing: ' + k));
assert(/prefers-color-scheme:dark/.test(css) && /data-theme="dark"/.test(css));

// 3. no money arithmetic in the page code
const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
assert(!/\.reduce\(/.test(src), 'no reduce over money');

// 4. no-flag: nothing outside this file loads it, and without a shell nothing renders
const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
assert(!index.includes('stack-cards'), 'index.html must not load the cards file');
registered = {}; delete globalThis.StackBlocks; delete require.cache[require.resolve(file)];
require(file); // loads inertly with no StackBlocks
assert.deepStrictEqual(registered, {});
console.log('test-stack-cards: ok');

