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
    { id: 'hydro', date: '2026-01-05', label: 'Hydro', amount: 111.11, paidState: 'paid' },
    { id: 'phone', date: '2026-01-07', label: 'Phone', amount: 222.22, paidState: 'not-paid' },
    { id: 'old', label: 'Carried one', amount: 999.99, paidState: 'carried' },
    { id: 'mortgage', date: '2026-01-02', debtId: 'mortgage', label: 'Mortgage', amount: 1234.56, paidState: 'not-paid' },
    { id: 'cardmin', debtId: 'card-a', label: 'Card A minimum', amount: 77.77, paidState: 'paid' },
  ],
  budgetProgress: { household: { actual: { amount: 333.33 }, planned: { amount: 666.66 } } },
  householdBudget: [
    { id: 'groceries', label: 'Groceries', spent: 123.45, planned: 400 },
    { id: 'fun', label: 'Fun <money>', spent: 10.1, planned: 50.5 },
    { label: 'Hidden', informational: true, spent: 5, planned: 5 },
  ],
};
const ctx = (v, key) => ({ data: {}, plan: {}, recommendation: { payPeriodViews: [v] }, selectedPeriodKey: key === undefined ? '2026-01-01' : key, Forecast: {} });

let registered = {};
global.window = undefined;
// B5: the cards read the shell's one trust rule, so the stub carries the real shell's rule and budget reader.
const shell = (() => {
  const sandbox = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
  require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-shell.js'), 'utf8'), sandbox);
  return sandbox.window.StackBlocks;
})();
globalThis.StackBlocks = { register: (n, f) => { registered[n] = f; }, isEstimated: shell.isEstimated, estClass: shell.estClass,
  budgetTrust: shell.budgetTrust, barWidth: shell.barWidth };
delete require.cache[require.resolve(file)];
const mod = require(file);
assert.strictEqual(typeof registered.cards, 'function', 'registers as cards');
const { buildCardsHTML } = mod;

const fmt = n => { const w = Math.round(Math.abs(n) * 100) % 100 === 0; return (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: w ? 0 : 2, maximumFractionDigits: w ? 0 : 2 }); };
const amounts = html => (html.replace(/<[^>]+>/g, ' ').match(/−?\$[\d,]+(?:\.\d\d)?/g) || []);

// 1. every printed amount equals a published value it names; nothing computed
const html = buildCardsHTML(ctx(view));
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-cards.css'), 'utf8');
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
// rows: item, amount, and a green check only when paidState says paid; no status word anywhere (owner direction)
const CHECK = '<span class="sc-check" role="img" aria-label="Paid">\u2713</span>';
const rowOf = (h, label) => h.split('<li class="sc-row sc-bill"').slice(1).map(x => x.split('</li>')[0]).find(x => x.includes('>' + label + '<'));
assert(rowOf(card('bills'), 'Hydro').includes(CHECK), 'a paid row shows the check');
assert(!rowOf(card('bills'), 'Phone').includes('sc-check') && !rowOf(card('bills'), 'Phone').includes('\u2713'), 'an unpaid row shows no mark');
assert(!rowOf(card('mortgage'), 'Mortgage').includes('sc-check'), 'an unpaid mortgage shows no mark');
for (const k of ['bills', 'mortgage', 'budget']) {
  const visible = card(k).replace(/<[^>]+>/g, ' ');
  assert(!/paid|Paid|Not paid/.test(visible), 'no status word is visible on ' + k);
}
assert(!/ of \d+ paid|paid \/ total/.test(html), 'no paid count or descriptor on the strips');
assert(rowOf(card('bills'), 'Hydro').includes(fmt(111.11)) && rowOf(card('bills'), 'Phone').includes(fmt(222.22)), 'the amount stays');
{
  const mp = JSON.parse(JSON.stringify(view)); mp.bills[3].paidState = 'paid';
  const m = buildCardsHTML(ctx(mp)).split('data-stack-card="mortgage"')[1].split('</details>')[0];
  assert(m.includes(CHECK) && !m.replace(/<[^>]+>/g, ' ').match(/paid/i), 'a paid mortgage row shows the check and no word');
  const unk = JSON.parse(JSON.stringify(view)); unk.bills[0].paidState = 'maybe'; unk.bills[3].paidState = 'maybe';
  const u = buildCardsHTML(ctx(unk));
  assert(!u.includes('sc-check') && !u.includes('\u2713'), 'an unknown paidState renders no check');
  const nul = JSON.parse(JSON.stringify(view)); nul.bills[0].amount = null;
  const n = buildCardsHTML(ctx(nul)).split('data-stack-card="bills"')[1].split('</details>')[0];
  assert(rowOf(n, 'Hydro').includes('<span class="sc-a">\u2014</span>') && !/[$]0/.test(n), 'an unpublished amount is a dash, never a zero');
}
// category rows read spent of planned; markup is escaped
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
assert(/class="sc-f">\u2014</.test(h2), 'an unpublished headline is a dash'); assert(!/[$]0(\.00)?\b/.test(h2));
assert(!h2.includes('sc-check') && !h2.includes('\u2713'), 'no check without paidState');
const none = { start: '2026-01-01' }; // no stackSummary at all (#1426 not merged)
assert.strictEqual(amounts(buildCardsHTML(ctx(none))).length, 0);
assert.strictEqual(buildCardsHTML(ctx(view, 'zzz')), '', 'unknown period renders nothing');
assert.strictEqual(buildCardsHTML(null), '');
// a published zero is a real value and prints
const z = JSON.parse(JSON.stringify(view)); z.stackSummary.bills.other = 0;
assert(buildCardsHTML(ctx(z)).includes('$0<'));

// card colours: every kind's variable is defined in the CSS file
['bills', 'budget', 'mortgage', 'savings'].forEach(k => assert(css.includes('--sc-' + k + ':'), 'css var missing: ' + k));
// both themes: fixed fills with dark ink, so no theme-dependent rule is needed; every selector is scoped
assert(css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g).every(s => s.split(',').every(x => x.trim().startsWith('html.stack-view '))), 'selectors scoped');

// Savings card (final A5 shape, invented values): nothing until published
assert(!html.includes('data-stack-card="savings"'), 'savings renders nothing until published');
const withSavings = s => { const v = JSON.parse(JSON.stringify(view)); v.stackSummary.savings = s; return v; };
const savingsOf = v => { const h = buildCardsHTML(ctx(v)); const p = h.split('data-stack-card="savings"')[1]; return p ? p.split('</details>')[0] : null; };
const txt = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// current period: moved of entitlement this period; rows still to set aside; no bars, no Funded words
const cur = savingsOf(withSavings({
  items: [{ id: 'r', label: 'Rainy day', saved: null, needed: 40, reasons: ['net-of-period-transfers', 'no-per-goal-attribution'] },
    { id: 'c', label: 'Car <fund>', saved: null, needed: null, reasons: ['planned-unavailable'] }],
  totals: { saved: 20.5, needed: null, entitlement: 130.25, completeness: 'pool-level', excluded: ['c'], reasons: ['pool-level', 'planned-incomplete'] } }));
assert(cur.includes(fmt(20.5) + '<i> of ' + fmt(130.25) + '</i>'), 'current header: numbers only');
assert(!/moved|this period|entitlement/.test(cur.replace(/<[^>]+>/g, ' ')), 'no word labels around the Savings strip figures');
assert(!cur.includes('sc-mini') && !/Funded|excludes|still to set aside|needs/i.test(cur.replace(/<[^>]+>/g, ' ')));
assert((cur.match(/<span class="sc-a">\u2014<\/span>/g) || []).length === 2, 'no published saved figure: a dash, the net amount is not printed');
amounts(cur).forEach(a => assert([20.5, 130.25].map(fmt).includes(a), 'unpublished amount ' + a));

// current period, transfer figure withheld: no header figure
const nt = savingsOf(withSavings({ items: [{ id: 'r', label: 'Rainy day', saved: null, needed: 40, reasons: ['net-of-period-transfers'] }],
  totals: { saved: null, needed: 40, entitlement: null, completeness: 'none', excluded: [], reasons: ['pool-transfer-unavailable'] } }));
assert(nt && /class="sc-f">\u2014</.test(nt) && /<span class="sc-a">\u2014<\/span>/.test(nt), 'current period, transfer withheld: the card stays, a dash header and dash rows (an unknown is not "nothing due")');

// future period: planned total in the header, rows "planned this period", never a moved figure or $0
const fut = savingsOf(withSavings({ items: [{ id: 'r', label: 'Rainy day', saved: null, needed: 40, reasons: ['future-period'] }],
  totals: { saved: null, needed: 40, entitlement: null, completeness: 'none', excluded: [], reasons: ['future-period'] } }));
assert(fut.includes(fmt(40) + '</span>') && fut.includes('<span class="sc-a">' + fmt(40) + '</span>') && !/planned/.test(txt(fut)), 'a future period shows only its planned amount');
assert(!/moved|\$0/.test(txt(fut)));

// past period: everything null, no amounts
const pastView = withSavings({ items: [{ id: 'r', label: 'Rainy day', saved: null, needed: null, reasons: ['past-period'] }],
  totals: { saved: null, needed: null, entitlement: null, completeness: 'none', excluded: [], reasons: ['past-period'] } });
pastView.timelineRole = 'past';
const past = savingsOf(pastView);
assert(past === null, 'a past period with nothing to print shows no Savings card, not names and dashes');
{
  const same = role => { const v = JSON.parse(JSON.stringify(pastView)); v.timelineRole = role; return savingsOf(v); };
  ['current', 'next', 'future'].forEach(role => assert(same(role) !== null && /class="sc-f">\u2014</.test(same(role)), 'a ' + role + ' period with nothing published keeps its card, with a dash header'));
  assert(same(undefined) !== null, 'an unknown role is not treated as past');
}

// current period with per-goal saved (nearest due first): "$saved of $periodTarget", full-width bar, $0 with an empty bar
const per = savingsOf(withSavings({ items: [
  { id: 'club', label: 'Club', saved: 30, needed: 50, periodTarget: 80, savedTrust: 'calculated', reasons: ['net-of-period-transfers', 'owner-rule:nearest-due-first'] },
  { id: 'home', label: 'Home', saved: 0, needed: 20, periodTarget: 20, reasons: ['net-of-period-transfers'] },
  { id: 'over', label: 'Topped', saved: 90, needed: 0, periodTarget: 90, reasons: [] },
  { id: 'nope', label: 'No attribution', saved: null, needed: 15, periodTarget: null, reasons: ['net-of-period-transfers', 'no-per-goal-attribution'] }],
  totals: { saved: 120, needed: 85, entitlement: 190, completeness: 'pool-level', excluded: [], reasons: ['pool-level'] } }));
assert(per.includes('<span class="sc-a">' + fmt(30) + '<i> of ' + fmt(80) + '</i></span>'));
assert(per.includes('<span class="sc-a">$0<i> of ' + fmt(20) + '</i></span>') && per.includes('<i style="width:0%">'));
assert(per.includes(fmt(90) + '<i> of ' + fmt(90)) && per.includes('width:100%'), 'a topped-up goal reads full, not capped differently');
assert((per.match(/sc-full/g) || []).length === 3, 'bar only on goals with saved');
assert(per.includes('<span class="sc-a">\u2014</span>') && !per.includes(fmt(15)), 'no attribution: a dash');
assert(!per.includes(fmt(50)), 'needed is not printed on a row with its own saved');
amounts(per).forEach(a => assert([30, 80, 0, 20, 90, 120, 190].map(fmt).includes(a), 'unpublished amount ' + a));
assert(savingsOf(withSavings({ items: [], totals: { saved: null, entitlement: null } })) === null, 'empty savings renders nothing');

// card colours: every kind's variable is defined in the CSS file
['bills', 'budget', 'mortgage', 'savings'].forEach(k => assert(css.includes('--sc-' + k + ':'), 'css var missing: ' + k));
// both themes: fixed fills with dark ink, so no theme-dependent rule is needed; every selector is scoped
assert(css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g).every(s => s.split(',').every(x => x.trim().startsWith('html.stack-view '))), 'selectors scoped');

// strips are numbers only: Budget reads the spent figure, then "of" the budget figure in the muted style, no words
{
  const b = card('budget');
  assert(b.includes('<span class="sc-f">' + fmt(333.33) + '<i> of ' + fmt(666.66) + '</i></span>'), 'Budget strip: X of Y');
  assert(!/spent|budget/i.test(b.split('<summary>')[1].split('</summary>')[0].replace(/<[^>]+>/g, ' ').replace('Budget', '')), 'no spent or budget label on the strip');
  assert(!/<span class="sc-s">/.test(html), 'no subtitle on Bills, Budget or Mortgage');
}

// 2b. sheet contract: each published row carries the right attribute, is focusable and a button; no savings rows
const attr = (h, v) => h.includes('data-stack-sheet="' + v + '" role="button" tabindex="0"');
assert(attr(card('bills'), 'bill:hydro@2026-01-05') && attr(card('bills'), 'bill:phone@2026-01-07'));
assert(!card('bills').includes('mortgage:') && !card('bills').includes('bill:old@'));
assert(attr(card('budget'), 'budget:groceries') && attr(card('budget'), 'budget:fun'));
assert(attr(card('mortgage'), 'mortgage:mortgage@2026-01-02'));
const noId = JSON.parse(JSON.stringify(view)); delete noId.bills[0].date; delete noId.householdBudget[0].id;
const nh = buildCardsHTML(ctx(noId));
assert(!nh.includes('bill:hydro') && !nh.includes('budget:groceries'), 'no attribute without the ids');
assert(!savingsOf(withSavings({ items: [{ id: 'r', label: 'Rainy', saved: 1, needed: 2, reasons: [] }], totals: { saved: 1, entitlement: 2, reasons: [] } })).includes('data-stack-sheet'));
// Enter / Space act as a click
{
  let handler = null, clicked = 0;
  const cont = { addEventListener: (n, f) => { if (n === 'keydown') handler = f; }, innerHTML: '' };
  require(file).render(cont, ctx(view));
  assert(handler && cont.innerHTML.includes('data-stack-sheet'));
  const row = { getAttribute: () => 'bill:hydro@2026-01-05', click: () => clicked++ };
  ['Enter', ' ', 'a'].forEach(key => handler({ key, target: row, preventDefault() {} }));
  assert.strictEqual(clicked, 2, 'Enter and Space click; other keys do not');
}

// 2c. trust: estimated figures are drawn softer (class stack-est); the word never appears; calculated ones carry no class
{
  const e = JSON.parse(JSON.stringify(view));
  e.budgetProgress.household.actual.trust = 'estimated';
  e.householdBudget[0].plannedTrust = 'estimated';
  e.stackSummary.bills.trust = 'estimated';
  const eh = buildCardsHTML(ctx(e)), cardOf = k => eh.split('data-stack-card="' + k + '"')[1].split('</details>')[0];
  assert(/class="sc-f stack-est"/.test(cardOf('budget')) && /class="sc-bar stack-est"/.test(cardOf('budget')), 'budget headline and bar drawn soft');
  assert((cardOf('budget').match(/class="stack-est"/g) || []).length === 1 && /<i class="stack-est"> of /.test(cardOf('budget')),
    'only the estimated amount (the first row\'s plan) is soft');
  assert(/class="sc-f stack-est"/.test(cardOf('bills')) && /class="sc-f stack-est"/.test(cardOf('mortgage')));
  assert(!/estimated/i.test(eh), 'the word estimated never appears in the DOM');
  assert(!html.includes('stack-est'), 'calculated figures carry no class');
  const se = withSavings({ items: [{ id: 'r', label: 'Rainy', saved: 5, needed: 3, periodTarget: 8, savedTrust: 'estimated', reasons: [] }],
    totals: { saved: 5, entitlement: 8, trust: 'calculated', entitlementTrust: 'estimated', reasons: [] } });
  const sh = savingsOf(se);
  assert(/class="sc-f stack-est"/.test(sh) && /sc-a stack-est/.test(sh) && /sc-mini sc-full stack-est/.test(sh) && !/estimated/i.test(sh));
  assert(!/moved \/ entitlement/.test(sh), 'no jargon subtitle');
  assert(/stack-est/.test(css), 'the css draws the soft style');
}
// 2d. a completed period whose original plan Forecast withholds: no category denominator, no progress bar
{
  const h = JSON.parse(JSON.stringify(view));
  h.budgetProgress.household.planned = { amount: null, trust: 'unavailable' };
  const hh = buildCardsHTML(ctx(h)), b = hh.split('data-stack-card="budget"')[1].split('</details>')[0];
  assert(!b.includes(fmt(400)) && !b.includes(fmt(50.5)) && !b.includes('sc-mini'), 'withheld plan not printed or drawn');
  assert(b.includes(fmt(123.45)), 'spent still printed');
}

// 2f. the bar fill comes from the shell's shared StackBlocks.barWidth; no local ratio helper
assert(!/drawWidth/.test(fs.readFileSync(file, 'utf8')), 'local drawWidth removed');
{
  const wide = JSON.parse(JSON.stringify(view)); wide.householdBudget[0].spent = 200; wide.householdBudget[0].planned = 400;
  const b = buildCardsHTML(ctx(wide)).split('data-stack-card="budget"')[1];
  assert(b.includes('style="width:' + shell.barWidth(200, 400) * 100 + '%"'), 'row bar = barWidth(spent, planned)');
  const zero = JSON.parse(JSON.stringify(view)); zero.householdBudget[0].planned = 0;
  assert(buildCardsHTML(ctx(zero)).split('data-stack-card="budget"')[1].includes('width:0%'), 'no whole: empty bar');
}

// 2g. no explanatory words anywhere on the cards (owner rule): names, numbers, bars and the check only
{
  const all = withSavings({ items: [{ id: 'club', label: 'Club', saved: 30, needed: 50, periodTarget: 80, reasons: ['net-of-period-transfers'] },
    { id: 'x', label: 'Extra', saved: null, needed: 15, reasons: ['future-period'] }],
    totals: { saved: 30, needed: 65, entitlement: 80, completeness: 'pool-level', excluded: ['x'], reasons: ['pool-level'] } });
  all.stackSummary.bills.trust = 'estimated'; all.budgetProgress.household.actual.trust = 'estimated';
  all.bills[0].paidState = 'paid'; all.bills[3].paidState = 'paid';
  const visible = buildCardsHTML(ctx(all)).replace(/<[^>]+>/g, ' ');
  assert(!/needs|set aside|planned|spent|estimated|projected|confirm|excludes|moved|entitlement|paid|period/i.test(visible), 'a word label is visible: ' + visible);
}

// 3. no money arithmetic in the page code
const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
assert(!/\.reduce\(/.test(src), 'no reduce over money');

// 4. no-flag: nothing outside this file loads it, and without a shell nothing renders
const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// B1's index.html loads the file after the shell; without ?view=stack the shell never calls a renderer, and
// loading the file itself only registers a function (no element, style, listener or fetch).
assert(index.indexOf('/stack-shell.js') < index.indexOf('/stack-cards.js'), 'cards file loads after the shell');
assert(!/document\.(createElement|write)|addEventListener\('(DOMContentLoaded|load)/.test(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('function render')[0]), 'no load-time side effects');
registered = {}; delete globalThis.StackBlocks; delete require.cache[require.resolve(file)];
require(file); // loads inertly with no StackBlocks
assert.deepStrictEqual(registered, {});
console.log('test-stack-cards: ok');


