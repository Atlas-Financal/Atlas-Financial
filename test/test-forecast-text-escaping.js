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

function render(data, overrides = {}, periods = null) {
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
  page.get('renderPlan')(data, periods, null);
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
const REAL_FORECAST = require(path.join(ROOT, 'public', 'forecast.js'));
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
    // The Credit cards strip still renders with today's plan unavailable; the
    // pay-period payee and category rows do not.
    sections: { 'the Credit cards strip prints a card name': RENDERERS['the Credit cards strip prints a card name'],
      'a card activity panel names its card': RENDERERS['a card activity panel names its card'] },
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
  // No feasible weekly cap: the cap headline prints the cap's reason, which
  // names the failing constraint. The invented household never reaches a
  // computed-but-infeasible cap, so Forecast.recommend's verdict is forced to
  // 'infeasible' with a hostile constraint label (every other field is the
  // real recommendation), and an invented spending history lets
  // Forecast.budgetBreakdown publish the cap the headline belongs to.
  'no feasible cap (forced verdict)': {
    data: () => { const d = H.hostile(); d.plan.nextDollar = POLICY; return d; },
    overrides: { recommend: (...args) => Object.assign(REAL_FORECAST.recommend(...args),
      { mode: 'infeasible', weekly: 120, infeasible: { label: H.LABEL, date: '2026-09-01', shortfall: 250 } }) },
    periods: { periods: { ytd: { label: 'Invented YTD', months: 1,
      spending: [{ label: 'Groceries', total: 900 }, { label: 'Gas', total: 300 }, { label: 'Restaurants', total: 200 }] } } },
    reach: [],
    sections: { 'the cap headline prints the failing constraint as text':
      /class="cap-qual">There is no feasible weekly cap\. &quot;&gt;&lt;img src=x onerror=alert\(1\)&gt; fails/ },
  },
};

for (const [name, world] of Object.entries(worlds)) {
  test(`${name}: no Forecast text reaches the page as markup`, () => {
    const writes = render(world.data(), world.overrides, world.periods);
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

// ---- The Stack page (the default Budget page; C1 S4 batch 1) -------------------------------------------------------------
// The same proof against the Stack renderers: the hostile household and the poisoned Forecast (every string Forecast returns
// carries a live <img onerror>) are driven through the REAL Stack shell's input step and the page's own four registered
// blocks (waterfall, cards, credit, sheet) for every published pay period, then every sheet item each period lists, by the
// figures page capture (scripts/figures-page-capture.js, recordHtml), which records the markup each one wrote. A raw payload
// anywhere fails; each named Stack area must print its escaped payload (so a world that stops reaching it fails, rather than
// passing vacuously); and mutants that stop escaping in each block fail. The poisoned text leaves clean the keys the Stack
// blocks branch on (stackBillPart, stackBillPaymentEvidence, displayAmountBasis: 'part|evidence|basis'), as the default list
// leaves the classic page's discriminators clean.
const fs = require('node:fs');
const os = require('node:os');
const PageCapture = require('../scripts/figures-page-capture');

const STACK_SKIP = 'part|evidence|basis';
const clone = v => JSON.parse(JSON.stringify(v));
const INVENTED = Object.fromEntries(require('../scripts/figures-snapshot').loadInventedInputs().map(i => [i.id, i.doc.data]));
// The worlds the Stack page is driven through. Each is the invented household of a figures input, or the hostile Budget
// household, with hostile text where that world's named areas print it.
function cardsWorld() {
  // A card ledger the Credit card reads (its transactions), hostile payees on every posted card row, a hostile card name.
  const d = clone(INVENTED['stack-card-summary']);
  for (const t of d.liveOverlay.currentPeriodActuals.transactions) if (t.displayedPayee) t.displayedPayee = H.LABEL;
  d.debts.find(x => x.id === 'travelvisa').label = H.LABEL;
  return d;
}
function savingsWorld() {
  // Savings goals (the Savings card's rows), hostile goal labels.
  const d = clone(INVENTED['savings-fully-backed']);
  for (const group of d.plan.groups || []) if (typeof group.label === 'string') group.label = H.LABEL;
  return d;
}
// A world may force one Forecast answer a household cannot reach on its own, as the classic worlds above do: here every card
// minimum the waterfall lists carries a hostile debt id (Forecast only publishes the fixed credit-line ids, so the attribute
// cannot carry hostile text through the data alone).
const hostileIds = real => function (...args) {
  const out = real.apply(this, args);
  for (const view of (out && out.payPeriodViews) || []) {
    const rows = view && view.stackSummary && view.stackSummary.bills && view.stackSummary.bills.cardMinimums;
    if (Array.isArray(rows)) for (const row of rows) row.debtId = H.ID;
  }
  return out;
};
const STACK_WORLDS = {
  household: { data: H.hostileStack },
  cards: { data: cardsWorld },
  savings: { data: savingsWorld },
  'hostile card ids (forced)': { data: cardsWorld, recommend: hostileIds },
};
function stackMarkup(worldName, rootDir) {
  const world = STACK_WORLDS[worldName];
  const perturb = {};
  for (const [name, f] of Object.entries(REAL_FORECAST)) {
    if (typeof f !== 'function') continue;
    perturb[name] = real => {
      const poisoned = P.poisonedForecast({ f: real }, STACK_SKIP).f;
      return name === 'recommend' && world.recommend ? world.recommend(poisoned) : poisoned;
    };
  }
  const cap = PageCapture.withPerturbations(perturb, () => PageCapture.capturePages(world.data(), null, rootDir || ROOT, { recordHtml: true }));
  const chunks = [];
  for (const state of cap.stack.states) {
    for (const [name, html] of Object.entries(state.html.blocks)) chunks.push({ at: `${worldName}: ${state.id} ${name}`, kind: name, html });
    for (const [key, html] of Object.entries(state.html.sheets)) chunks.push({ at: `${worldName}: ${state.id} sheet ${key}`, kind: 'sheet:' + key.slice(0, key.indexOf(':')), html: html || '' });
  }
  return { world: worldName, status: cap.stack.status, states: cap.stack.states, chunks };
}
const LABEL_ESC = '&quot;&gt;&lt;img src=x onerror=alert\\(1\\)&gt;';
const POISON_ESC = '&lt;img src=z data-poisoned-forecast onerror=alert\\(9\\)&gt;';
const ID_ESC = 'x&quot; onmouseover=&quot;alert\\(1\\)&quot; data-x=&quot;';
// Each named Stack area must print an escaped payload in its world: the escaped text lands where the renderer writes that value.
const STACK_AREAS = {
  'the waterfall lists a card minimum under its (hostile) name': ['household', 'waterfall', new RegExp(`<li class="wf-card" data-row="card" data-debt-id="[^"]*"><span class="wf-name"><b>${LABEL_ESC}`)],
  'the Bills card lists a bill by a hostile id in its sheet attribute': ['household', 'cards', new RegExp(`data-stack-sheet="bill:${ID_ESC}`)],
  'the Bills card lists a bill by its (hostile) label': ['household', 'cards', new RegExp(`<span class="sc-n">${LABEL_ESC}`)],
  'the Budget card names a category': ['household', 'cards', new RegExp(`<b class="sc-n">Groceries${POISON_ESC}`)],
  'the Credit card names a card': ['household', 'credit', new RegExp(`<b>Travel${POISON_ESC}`)],
  'a bill sheet titles its bill': ['household', 'sheet:bill', new RegExp(`<h3 id="stack-sheet-title">${LABEL_ESC}`)],
  'a budget sheet titles its category': ['household', 'sheet:budget', new RegExp(`<h3 id="stack-sheet-title">Groceries${POISON_ESC}`)],
  'a card sheet titles its card': ['household', 'sheet:card', new RegExp(`<h3 id="stack-sheet-title">Travel${POISON_ESC}`)],
  // The reviewer's four gaps (#1515): card-sheet transactions, Savings goals, the waterfall's debt-id attribute.
  'a card sheet lists a transaction by its (hostile) payee': ['cards', 'sheet:card', new RegExp(`<span class="stack-sheet-txl">${LABEL_ESC}`)],
  'the Savings card names a goal by its (hostile) label': ['savings', 'cards', new RegExp(`<li class="sc-row sc-own"><span class="sc-n">${LABEL_ESC}`)],
  'the waterfall carries a hostile debt id in its row attribute': ['hostile card ids (forced)', 'waterfall', new RegExp(`<li class="wf-card" data-row="card" data-debt-id="${ID_ESC}"`)],
  'the waterfall names a card by a hostile debt id when no label is known': ['hostile card ids (forced)', 'waterfall', new RegExp(`data-debt-id="${ID_ESC}"><span class="wf-name"><b>${ID_ESC}`)],
};
const STACK_RAW = [P.PAYLOAD, ...H.PAYLOADS];
// What Stack runs prove: the raw payloads found, and the named areas (of the runs' worlds) that printed nothing escaped.
function stackProblems(runs) {
  const raw = runs.flatMap(run => run.chunks.filter(c => STACK_RAW.some(p => c.html.includes(p))).map(c => c.at));
  const missing = Object.entries(STACK_AREAS)
    .filter(([, [world]]) => runs.some(run => run.world === world))
    .filter(([, [world, kind, re]]) => !runs.filter(run => run.world === world).some(run => run.chunks.some(c => c.kind === kind && re.test(c.html))))
    .map(([label]) => label);
  return { raw, missing };
}

const stackBase = Object.keys(STACK_WORLDS).map(name => stackMarkup(name));
test('Stack page: no Forecast text or hostile household text reaches it as markup', () => {
  for (const run of stackBase) {
    assert.equal(run.status, 'rendered', `${run.world}: the Stack page was really driven (every block ok)`);
    assert.ok(run.states.length >= 4 && run.chunks.length > 100, `${run.world}: every pay period's blocks and sheet items were captured (${run.states.length} periods, ${run.chunks.length} chunks)`);
  }
  const { raw, missing } = stackProblems(stackBase);
  assert.deepEqual(raw, [], 'every Forecast and household string is escaped where the Stack page writes it');
  assert.deepEqual(missing, [], 'each named Stack area printed its escaped payload, so its branch ran');
});

test('Stack page: ordinary text with an apostrophe and an ampersand still displays exactly', () => {
  const html = stackBase.find(run => run.world === 'household').chunks.filter(c => c.kind === 'sheet:bill' || c.kind === 'cards').map(c => c.html).join('\n');
  assert.ok(html.includes('Tim&#39;s Café &amp; Bakery'), 'escaped once, not double-escaped');
  assert.ok(!html.includes('&amp;amp;') && !html.includes('&amp;#39;'), 'no double escaping');
});

// Mutants: a block that stops escaping a value fails, whether the hole is a property read (the static guard sees) or a call
// the static guard cannot see (String(...)). Each runs the Stack drive on a copy of public/, in the worlds that reach it.
function copyRoot(file, from, to) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-escape-'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  const target = path.join(dir, 'public', file);
  const text = fs.readFileSync(target, 'utf8');
  assert.ok(text.includes(from), `${file} carries the text to mutate: ${from}`);
  fs.writeFileSync(target, text.replace(from, to));
  return dir;
}
const MUTANTS = [
  ['the waterfall prints a card name unescaped', 'stack-waterfall.js', '<b>${escape(cardLabel(ctx, card && card.debtId))}</b>', '<b>${String(cardLabel(ctx, card && card.debtId))}</b>', ['household']],
  ['the waterfall prints a card row\'s debt id unescaped in its attribute', 'stack-waterfall.js', 'data-debt-id="${escape(card && card.debtId)}"', 'data-debt-id="${String(card && card.debtId)}"', ['hostile card ids (forced)']],
  ['the Credit card prints a card name unescaped', 'stack-credit.js', '<b>${esc(line.label)}</b>', '<b>${String(line.label)}</b>', ['household']],
  ['a card sheet prints a transaction name unescaped', 'stack-credit.js', '${t.pending ? PENDING_DOT : \'\'}${escape(t.name || \'\')}</span>', '${t.pending ? PENDING_DOT : \'\'}${String(t.name || \'\')}</span>', ['cards']],
  ['the Bills card prints a bill id unescaped in its attribute', 'stack-cards.js', `' data-stack-sheet="' + esc(target) + '"`, `' data-stack-sheet="' + String(target) + '"`, ['household']],
  ['the Savings card prints a goal label unescaped', 'stack-cards.js', `'<li class="sc-row sc-own"><span class="sc-n">' + esc(label) + '</span>'`, `'<li class="sc-row sc-own"><span class="sc-n">' + String(label) + '</span>'`, ['savings']],
  ['a sheet prints its title unescaped', 'stack-sheet.js', '<h3 id="stack-sheet-title">${esc(title)}</h3>', '<h3 id="stack-sheet-title">${String(title)}</h3>', ['household']],
];
for (const [label, file, from, to, worlds] of MUTANTS) {
  test(`Stack page mutant: ${label}`, () => {
    const dir = copyRoot(file, from, to);
    try {
      const { raw, missing } = stackProblems(worlds.map(world => stackMarkup(world, dir)));
      assert.ok(raw.length > 0 || missing.length > 0, 'the mutant is caught: a raw payload or an area that no longer prints its escaped payload');
      assert.ok(raw.length > 0, 'and the unescaped value reaches the markup as a raw payload: ' + raw.slice(0, 2).join('; '));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
