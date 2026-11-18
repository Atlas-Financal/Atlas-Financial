'use strict';
// Stored-XSS proof: Forecast's published text never reaches the page as markup.
//
// The failure it catches: a page renderer writes a Forecast reason, note or
// household name into innerHTML without escaping it (found on main: the
// "Extra on focus debt" block printed debtPriority's reason and the focus
// debt's label raw, so a card label could run script). The release decision
// it changes is "may this renderer merge".
//
// How: the real public/app.js + public/plan.js and the page modules render
// the invented hostile household (fixtures/hostile-page-text.js) through
// renderPlan, with Forecast swapped for test/lib/poisoned-forecast.js, which
// appends a live <img onerror> to every text field Forecast returns. Every
// innerHTML the page writes is captured. A raw payload anywhere fails. Each
// world also names the areas the payload must reach (escaped), so a world
// that stops exercising its branch fails instead of passing vacuously.
// The diagnostics section (#road-ahead) is shown, so its renders run too.
// Invented data only.
//
// `node test/test-forecast-text-escaping.js`
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadBudgetPage } = require('./lib/budget-page-harness');
const H = require('./fixtures/hostile-page-text');
const P = require('./lib/poisoned-forecast');

const ROOT = path.join(__dirname, '..');
const mod = name => require(path.join(ROOT, 'public', name));
// Escaped forms that prove a branch ran: the poisoned Forecast text, or the
// fixture's household note (plan-owned text such as plan.nextDollar.summary).
const ESCAPED = ['&lt;img src=z data-poisoned-forecast', '&lt;script&gt;alert(2)'];
const RAW_PAYLOADS = [P.PAYLOAD, ...H.PAYLOADS];

function render(data, overrides = {}) {
  const writes = [];
  const element = id => ({ id, hidden: false, inert: false, dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, addEventListener() {},
    appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    set innerHTML(html) { writes.push([id, String(html)]); this._html = html; }, get innerHTML() { return this._html || ''; },
    textContent: '' });
  const byId = {};
  const document = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    getElementById: id => byId[id] || (byId[id] = element(id)), createElement: () => element(null),
    createElementNS: () => element(null), createTextNode: text => ({ textContent: text }),
    body: element('body'), documentElement: { dataset: {}, style: { setProperty() {} } } };
  const poisoned = P.poisonedForecast(require(path.join(ROOT, 'public', 'forecast.js')));
  // A world may force one Forecast answer to reach a branch the invented
  // household cannot reach on its own; every other call is the real one.
  const forecast = new Proxy(poisoned, { get: (target, prop) => (Object.hasOwn(overrides, prop) ? overrides[prop] : target[prop]) });
  const page = loadBudgetPage({ Forecast: forecast,
    globals: { document, getComputedStyle: () => ({ getPropertyValue: () => '' }),
      BudgetSurface: mod('budget-surface.js'), BudgetCardMovements: mod('budget-card-movements.js'),
      SavingsInventory: mod('savings-inventory.js'), BalanceHistory: mod('balance-history.js'),
      BillDetail: mod('bill-detail.js'), DisplayName: mod('display-name.js') } });
  page.get('renderPlan')(data, null, null);
  return writes;
}

// Renderers inside an area that must each print the escaped poisoned text.
// A poisoned branch discriminator that makes one of them reject its input or
// take another branch (and print nothing) then fails, instead of passing on
// the strength of some other renderer in the same area.
const M = '&lt;img src=z data-poisoned-forecast';
const CARD_TITLE = new RegExp(`class="card-movement-title">[^<]*${M}`);
const RENDERERS = {
  'the Credit cards strip prints a card name': CARD_TITLE,
  'a card activity panel names its card': new RegExp(`class="card-movement-panel"[^>]*aria-label="[^"]*${M}`),
  'the current pay period lists a transaction payee': new RegExp(`class="household-budget-tx-payee">[^<]*${M}`),
  'the household budget names a category': new RegExp(`class="household-budget-name">[^<]*${M}`),
};
const POLICY = { policy: 'true-surplus-highest-interest', provenance: 'owner-stated', summary: H.NOTE };
const worlds = {
  // A revolving hostile card under the owner's highest-interest policy: the
  // Extra on focus debt block, and the 61-90 day phase that prints the summary.
  'debt policy': {
    data: () => { const d = H.hostile(); d.debts[0].structure = 'Revolving'; d.plan.nextDollar = POLICY; return d; },
    reach: ['operating-surface-body', 'phases', 'nextmove-card', 'status-band', 'cal-months', 'cal-agenda'],
    // Named renderers inside an area, so a poisoned discriminator that makes
    // a renderer reject its publication (and print nothing) cannot pass.
    sections: RENDERERS,
  },
  // Unknown chequing opening: every "Current plan unavailable" note.
  'plan unavailable': {
    data: () => { const d = H.hostile(); d.debts[0].structure = 'Revolving'; d.plan.nextDollar = POLICY;
      (d.plan.startingCash.breakdown || []).forEach(row => { row.value = null; }); return d; },
    reach: ['status-band', 'transfer-note', 'nextmove-card', 'operating-surface-body', 'payday-answer-body'],
  },
  // Free cash left after the buffer and reserves: the priorities note prints
  // plan.nextDollar.summary. The invented household never confirms card
  // coverage, so Forecast.unallocatedCash's verdict is forced to 'leftover'.
  'leftover cash (forced verdict)': {
    data: () => { const d = H.hostile(); d.plan.nextDollar = POLICY; return d; },
    overrides: { unallocatedCash: () => ({ id: 'leftover', ending: 5000, buffer: 500, reserves: 100,
      cardPurchaseCash: 0, amount: 4400, negative: false }) },
    reach: ['priorities-note'],
    sections: RENDERERS,
  },
};

for (const [name, world] of Object.entries(worlds)) {
  test(`${name}: no Forecast text reaches the page as markup`, () => {
    const writes = render(world.data(), world.overrides);
    const raw = writes.filter(([, html]) => RAW_PAYLOADS.some(p => html.includes(p)));
    assert.deepEqual(raw.map(([id, html]) => `${id}: …${html.slice(Math.max(0, html.indexOf('<img') - 80), html.indexOf('<img') + 60)}`), [],
      'every Forecast string is escaped where it is written');
    const reached = new Set(writes.filter(([, html]) => ESCAPED.some(e => html.includes(e))).map(([id]) => id));
    for (const id of world.reach) assert.ok(reached.has(id), `the poisoned text reaches #${id} (escaped), so its branch ran`);
    for (const [label, re] of Object.entries(world.sections || {})) {
      assert.ok(writes.some(([, html]) => re.test(html)), `${label} (escaped), so that renderer ran`);
    }
  });
}

test('the leftover note keeps its own emphasis and escapes the plan summary', () => {
  const page = loadBudgetPage();
  const html = page.get('UNALLOCATED_NOTE').leftover(H.NOTE);
  assert.ok(html.startsWith('<b>This is not spending money.</b>'), 'the note\'s own markup is kept');
  assert.ok(!html.includes(H.NOTE) && html.includes('&#39;&gt;&lt;script&gt;alert(2)'), 'the summary prints as text');
});

test('a future-plan card prints an unrecognised flexibility value as text', () => {
  const page = loadBudgetPage();
  const html = page.get('futurePlanCardHtml')({ id: 'invented-plan', label: 'Invented plan', flexibility: H.LABEL,
    verdict: 'funded', amount: 100, date: '2026-09-15', confidence: 'confirmed' }, null, false);
  assert.ok(!html.includes('<IMG SRC=X') && html.includes('&quot;&gt;&lt;IMG SRC=X ONERROR=ALERT(1)&gt;'),
    'the fallback chip escapes the upper-cased value');
});
