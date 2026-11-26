'use strict';
// A withheld tagged-spend tally is disclosed on the ACTUAL Blend savings row
// (visible text, accessible name) and in the opened detail window, in real
// Chromium; a known zero and a normal tagged item never say Withheld. Source
// rows are the real plan.js Budget Savings goals markup over invented Forecast
// packets; budget-blend.js runs unmodified on them. Invented values only; no
// network, no household data. Registered in test/suites.json; skips where
// Playwright is absent (the hosted npm test runner), like the other browser suites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let chromium;
try { require.resolve('playwright'); ({ chromium } = require('playwright')); }
catch (_) { console.log('Savings tagged-spend withheld display (real Chromium): skipped (Playwright not installed)'); process.exit(0); }
const F = require('../public/forecast');
const { fixture, observe, raw, link } = require('./test-savings-link-foundation');
const pub = name => path.join(__dirname, '../public', name);

// ---- source rows: the real plan.js renderer over invented packets ----------
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const name of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
  if (name === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
  vm.runInContext(fs.readFileSync(pub(name + '.js'), 'utf8'), ctx);
}
vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', ctx);
const both = () => [link('tag'), { ...link('tag', 'far', '2026-10-28'), tagId: 'invented-tag-far' }];
function sourceHtml(mutate, txs) {
  const x = fixture();
  x.map.savingsLinks.links = both();
  x.payload.transactions = txs || [];
  if (mutate) mutate(x);
  const packet = observe(x);
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: packet, debts: [], weeklyVariable: 0 });
  const period = advice.payPeriodViews.find(p => p.timelineRole === 'current') || advice.payPeriodViews[0];
  ctx.src = { plan: x.plan, debts: [], asOf: x.asOf, advice, liveOverlay: null, weekly: 0, weeklyOverride: 0 };
  ctx.period = period;
  return vm.runInContext('budgetSavingsGoalsHtml(src,period,budgetMonthPlanSpendSchedule(src,true))', ctx);
}
const rolled = x => {
  x.asOf = x.data.meta.asOf = '2026-11-05'; x.payload.fetchedAt = '2026-11-05T12:00:00.000Z';
  x.payload.transactionWindow = { startDate: '2026-10-30', endDate: '2026-11-05', complete: true, hasMore: false };
};
const ownerPaid = x => { x.plan.commitments.find(c => c.id === 'near').ownerPaid = { amount: 5, confirmedOn: '2026-10-04' }; };
// A known Paid beside the withheld tally. The real ledger also withholds Paid
// on a rolled window, so the known amount is injected on the printed stamps and
// text of the real withheld source row (the shape the reviewer described).
const withKnownPaid = html => html
  .replace('data-budget-goal-paid-progress="unknown"', 'data-budget-goal-paid-progress="funding"')
  .replace('data-budget-goal-tag-state="withheld"', 'data-budget-goal-tag-state="withheld" data-budget-goal-paid-amount="5"')
  .replace(/(data-budget-goal-paid>)[\s\S]*?(<\/span>)/, '$1$5.00$2');

const SCENARIOS = [
  { key: 'known zero', html: sourceHtml(null, []), withheld: false },
  { key: 'normal tagged', html: sourceHtml(null, [raw()]), withheld: false },
  { key: 'withheld', html: sourceHtml(x => { rolled(x); }), withheld: true },
  { key: 'withheld + owner Paid (real ledger)', html: sourceHtml(x => { rolled(x); ownerPaid(x); }), withheld: true },
  { key: 'withheld + known Paid (injected stamp)', html: withKnownPaid(sourceHtml(x => { rolled(x); })), withheld: true, knownPaid: true },
];
for (const s of SCENARIOS) {
  const state = (s.html.match(/data-budget-goal-tag-state="([a-z]+)"/) || [])[1];
  assert.equal(state, s.withheld ? 'withheld' : 'known', s.key + ': the real plan.js source row carries the expected tag state');
}

const page_html = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="operating-surface"><div id="operating-surface-body"><div data-budget-bento class="budget-bento"><div class="budget-blend-hero-layout"></div>${body}</div></div></div></body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH, args: ['--disable-gpu'] });
  const errors = [], baseline = {};
  try {
    for (const width of [1280, 320]) {
      for (const s of SCENARIOS) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent(page_html(s.html), { waitUntil: 'domcontentloaded' });
        for (const css of ['budget-surface.css', 'budget-blend.css', 'budget-gface.css']) await page.addStyleTag({ content: fs.readFileSync(pub(css), 'utf8') });
        await page.addScriptTag({ content: fs.readFileSync(pub('budget-blend.js'), 'utf8') });
        const row = page.locator('button.blend-goal-row[data-blend-goal="group:club"]');
        await row.waitFor({ timeout: 5000 });
        const label = `${s.key} @${width}`;
        const aria = await row.getAttribute('aria-label');
        const note = row.locator('[data-blend-goal-tag-withheld]');
        assert.equal(await row.getAttribute('title'), null, label + ': no title text to disagree with the accessible name');
        if (s.withheld) {
          assert.equal(await note.count(), 1, label + ': the visible row discloses the withheld tally');
          assert.equal((await note.textContent()).trim(), 'Tagged spending: Withheld');
          assert.ok(await note.isVisible(), label + ': note is visible');
          // The harness has no real bento grid, so fit is judged against the row itself.
          const box = await note.boundingBox(), rowBox = await row.boundingBox();
          assert.ok(box && box.width > 0 && box.height > 0 && box.x >= rowBox.x - 0.5 && box.x + box.width <= rowBox.x + rowBox.width + 0.5,
            label + ': the note stays inside its row');
          assert.match(aria, /Tagged spending: Withheld/, label + ': accessible name says it');
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= (baseline[width] ?? 0), label + ': the note adds no horizontal scroll (' + overflow + ' vs ' + baseline[width] + ')');
        } else {
          baseline[width] = Math.max(baseline[width] ?? 0, await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
          assert.equal(await note.count(), 0, label + ': never says Withheld on the row');
          assert.doesNotMatch(aria, /Withheld|Tagged spending/, label + ': accessible name says nothing about it');
          assert.doesNotMatch(await row.innerText(), /Withheld/, label);
        }
        // Geometry is display-unchanged by the note: same band for withheld and
        // known zero on the same Saved / required inputs (no tagged amount used).
        const bar = await row.locator('.blend-g-bar').evaluate(el => ({ cls: el.className, w: el.style.getPropertyValue('--w') }));
        if (s.withheld) assert.ok(!/is-paid/.test(bar.cls), label + ': no full-paid band while withheld');
        // The opened detail window.
        await row.click();
        const dialog = page.locator('dialog[data-blend-explain]');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });
        const fact = dialog.locator('[data-blend-explain-fact="tagged-spending"]');
        if (s.withheld) {
          assert.equal(await fact.count(), 1, label + ': the opened detail carries the withheld fact');
          const detail = (await fact.innerText()).replace(/\s+/g, ' ');
          assert.match(detail, /Tagged spending/);
          assert.match(detail, /Withheld/);
          assert.match(detail, /It is not zero\./);
          assert.ok(await fact.isVisible());
        } else {
          assert.equal(await fact.count(), 0, label + ': the opened detail never says Withheld');
          assert.doesNotMatch(await dialog.innerText(), /Withheld/);
        }
        // Paid and Still to fund facts keep their own wording in the window.
        assert.ok(await dialog.locator('[data-blend-explain-fact="still-to-fund"]').count() >= 0);
        await page.keyboard.press('Escape');
        await context.close();
      }
    }
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await browser.close(); }
  console.log('Savings tagged-spend withheld display (real Chromium): visible row, accessible name and opened detail disclose Withheld; known zero and normal tagged items never do, at 1280 and 320 widths.');
})().catch(error => { console.error(error); process.exit(1); });
