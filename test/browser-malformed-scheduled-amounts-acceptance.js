'use strict';
// Real-browser acceptance proof for Issue #726 (ATLAS-077):
// Reject malformed bill, commitment, and obligation amounts across the live
// App boot and recompute path (`App.boot()` / `App.rerender()` -> `Forecast`
// -> visible DOM surfaces on the Budget page `/`).
//
// NODE_PATH=<playwright packages> CHROME_PATH=<Chromium> node test/browser-malformed-scheduled-amounts-acceptance.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/budget-surface-data');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'public');
const origin = 'http://malformed-scheduled-amounts.test';
const out = process.env.ATLAS_MALFORMED_AMOUNTS_PROOF_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-malformed-scheduled-amounts-'));

// Independent hand-computed expectations from the synthetic fixture inputs in
// test/fixtures/budget-surface-data.js (never copied from Forecast output):
//   Pay period: 2026-08-14 .. 2026-08-27, asOf: 2026-08-20, opening: 2026-08-13
//   Income:     2,600 (payroll, Aug 14, received) + 1,450 (partner, Aug 25) = 4,050.00
//   Bills:      1,400 (mortgage, Aug 15, paid) + 120 (hydro, Aug 18)
//               + 85 (internet, Aug 24) + 60 (card-minimum, Aug 22) = 1,665.00
//   Household:  450 (groceries) + 160 (fuel) + 120 (restaurants) + 22.99 (unassigned) = 752.99
//               Planned categories: 450 + 160 + 120 = 730.00
//               Actual spent: 212.40 + 96.15 + 74.20 + 38.75 + 22.99 = 444.49
//   Cash:       Observed bills account (chequing-a) = 1,215.00; spending (chequing-b) = 160.00
//               Canonical dated opening = 15 + 604.49 = 619.49
//   Result:     Valid Balance After Deductions = 4,050 - 1,665 - 752.99 = 1,632.01
//               Invalid authored 0 would falsely yield bill load = 1,400 + 120 + 0 + 60 = 1,580.00 -> BAD = 1,717.01
//               Genuine 0 card-minimum load  = 1,400 + 120 + 85 + 0 = 1,605.00 -> BAD = 1,692.01
//               Invalid authored 0 both would falsely yield  = 1,400 + 120 + 0 + 0  = 1,520.00 -> BAD = 1,777.01
const EXPECT = Object.freeze({
  asOf: '2026-08-20',
  openingAsOf: '2026-08-13',
  incomeTotal: 4050,
  incomeReceived: 2600,
  billsTotal: 1665,
  billsZeroInternet: 1580,
  billsZeroObligation: 1605,
  billsZeroBoth: 1520,
  householdHold: 752.99,
  householdPlanned: 730,
  householdActual: 444.49,
  observedBillsCash: 1215,
  datedChequingOpening: 619.49,
  finalValid: 1632.01,
  finalZeroInternet: 1717.01,
  finalZeroObligation: 1692.01,
  finalZeroBoth: 1777.01,
});

// Recorded unparseable / missing scheduled-amount shapes from Issue #726 and
// Atlas review 6485110773 (including "abc", formatted strings, signed strings,
// non-finite numbers, booleans, arrays, null, and missing property).
const UNPARSEABLE_SHAPES = Object.freeze([
  ['"abc"', 'abc'],
  ['null', null],
  ['NaN', NaN],
  ['""', ''],
  ['"   "', '   '],
  ['"1,900"', '1,900'],
  ['"$85"', '$85'],
  ['"-$85"', '-$85'],
  ['"-1,900"', '-1,900'],
  ['Infinity', Infinity],
  ['true', true],
  ['[85]', [85]],
  ['missing', undefined],
]);

// Recorded negative finite shapes from Issue #726 and Atlas review 6485110773,
// asserting what the existing Forecast/consumer contract already does.
const NEGATIVE_FINITE_SHAPES = Object.freeze([
  ['-85', -85],
  ['"-85"', '-85'],
]);

function applyScheduledAmount(row, rawValue) {
  if (rawValue === undefined) {
    delete row.amount;
  } else {
    row.amount = rawValue;
  }
}

function contentType(file) {
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  return 'text/html; charset=utf-8';
}

function norm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function verifyFixtureOracle() {
  const raw = fx.canonical();
  const d = fx.served();
  const sum = xs => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  assert.equal(d.meta.asOf, EXPECT.asOf);
  assert.equal(raw.plan.opening.asOf, EXPECT.openingAsOf);
  assert.equal(sum(raw.plan.startingCash.breakdown.filter(a => a.id.startsWith("chequing-")).map(a => a.value)), EXPECT.datedChequingOpening);
  assert.equal(sum(d.plan.income.map(r => r.amount)), EXPECT.incomeTotal);
  assert.equal(
    sum(d.plan.bills.map(r => r.amount)) + sum(d.plan.obligations.map(r => r.amount)),
    EXPECT.billsTotal
  );
  assert.equal(sum(d.plan.budget.categories.map(r => r.plannedPayday)), EXPECT.householdPlanned);
  assert.equal(
    sum(d.liveOverlay.currentPeriodActuals.transactions.filter(t => t.atlasAccountId === 'chequing-b').map(t => t.amount)),
    EXPECT.householdActual
  );
  assert.equal(
    d.liveOverlay.observedCash.accounts.find(a => a.id === 'chequing-a').value,
    EXPECT.observedBillsCash
  );
  assert.equal(
    Math.round((EXPECT.incomeTotal - EXPECT.billsTotal - EXPECT.householdHold) * 100) / 100,
    EXPECT.finalValid
  );
  assert.equal(
    Math.round((EXPECT.incomeTotal - EXPECT.billsZeroInternet - EXPECT.householdHold) * 100) / 100,
    EXPECT.finalZeroInternet
  );
  assert.equal(
    Math.round((EXPECT.incomeTotal - EXPECT.billsZeroObligation - EXPECT.householdHold) * 100) / 100,
    EXPECT.finalZeroObligation
  );
  assert.equal(
    Math.round((EXPECT.incomeTotal - EXPECT.billsZeroBoth - EXPECT.householdHold) * 100) / 100,
    EXPECT.finalZeroBoth
  );
}

async function assertVisible(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 5000 });
  const info = await locator.evaluate(node => {
    for (let cur = node; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const style = getComputedStyle(cur);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return null;
      if (cur.classList.contains("blend-clip")) return null;
    }
    const r = node.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return {
      width: Math.round(r.width),
      height: Math.round(r.height),
      text: (node.innerText || "").replace(/\s+/g, " ").trim(),
    };
  });
  assert.ok(info, `Expected rendered non-zero box for ${selector}`);
  return info.text;
}

function encodeSpecialNumbers(obj) {
  return JSON.parse(JSON.stringify(obj, (_k, v) => {
    if (typeof v === "number" && Number.isNaN(v)) return "__ATLAS_NAN__";
    if (v === Infinity) return "__ATLAS_INF__";
    if (v === -Infinity) return "__ATLAS_NEGINF__";
    return v;
  }));
}

async function rerenderInPlace(page, nextData) {
  const payload = encodeSpecialNumbers(nextData);
  const unchanged = await page.evaluate(next => {
    const revive = val => {
      if (val === "__ATLAS_NAN__") return NaN;
      if (val === "__ATLAS_INF__") return Infinity;
      if (val === "__ATLAS_NEGINF__") return -Infinity;
      if (Array.isArray(val)) return val.map(revive);
      if (val && typeof val === "object") {
        for (const k of Object.keys(val)) val[k] = revive(val[k]);
      }
      return val;
    };
    App.data.plan = revive(next.plan);
    const snap = v => JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? String(x) : x));
    const before = snap(App.data);
    App.rerender();
    return snap(App.data) === before;
  }, payload);
  assert.equal(unchanged, true, "App.rerender() must not mutate App.data");
}

(async () => {
  verifyFixtureOracle();

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const mutations = [];
  const external = [];
  const receipt = {
    issue: 726,
    code: 'ATLAS-077',
    out,
    syntheticOnly: true,
    oracle: EXPECT,
    viewports: [],
    budgetTransitions: [],
    pageErrors: [],
  };

  try {
    let servedData = fx.served();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });

    await context.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (!['GET', 'HEAD'].includes(req.method())) {
        mutations.push(`${req.method()} ${req.url()}`);
        return route.abort();
      }
      if (url.origin !== origin) {
        external.push(req.url());
        return route.abort();
      }
      if (url.pathname === '/data.json') return route.fulfill({ json: servedData });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) {
        return route.fulfill({ json: null });
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.resolve(assets, '.' + rel);
      if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return route.fulfill({ status: 404, body: 'not found' });
      }
      return route.fulfill({ body: fs.readFileSync(file), contentType: contentType(file) });
    });

    const page = await context.newPage();
    page.on('pageerror', err => receipt.pageErrors.push(String(err)));

    // =========================================================================
    // 1. ACTIVE BUDGET SURFACE (`/`) — Real App.boot() + in-place transitions
    //    across bill, obligation, commitment, and all-3 combined (1440px & 390px)
    // =========================================================================
    servedData = fx.served();
    await page.goto(origin + '/?view=classic');
    await page.locator('[data-budget-cash-hero]').waitFor();

    const checkBudgetValidBaseline = async label => {
      const cashHero = await assertVisible(page, "[data-budget-cash-hero]");
      const incomeTerm = await assertVisible(page, "[data-blend-term=\"periodIncome\"]");
      const billsTerm = await assertVisible(page, "[data-blend-term=\"assignedBills\"]");
      const householdTerm = await assertVisible(page, "[data-blend-term=\"householdBudgetHold\"]");
      const periodResult = await assertVisible(page, "[data-budget-period-result]");
      const phValue = await assertVisible(page, "[data-ph-value]");
      const billsRatio = norm(await page.locator("[data-budget-ratio=\"bills\"]").first().textContent());
      const householdRatio = norm(await page.locator("[data-budget-ratio=\"household\"]").first().textContent());
      const badTerm = await assertVisible(page, "[data-blend-term=\"balanceAfterDeductions\"]");
      const cardToggle = await assertVisible(page, "[data-budget-card-toggle=\"travelvisa\"]");

      assert.match(cashHero, /\$1,215\.00/);
      assert.match(incomeTerm, /\$4,050\.00/);
      assert.match(billsTerm, /\$1,665\.00/);
      assert.match(householdTerm, /\$752\.99/);
      assert.match(periodResult, /\$1,632\.01/);
      assert.match(badTerm, /\$1,632\s*\.01/);
      assert.match(phValue, /\$1,632\.01/);
      assert.match(billsRatio, /\$1,400\.00[\s\S]*\$1,665\.00/);
      assert.match(householdRatio, /\$444\.49[\s\S]*\$730\.00/);
      assert.match(cardToggle, /\$2,000\.00/);
      receipt.budgetTransitions.push({ state: label, billsTerm, periodResult, phValue, cashHero });
    };

    await checkBudgetValidBaseline("valid-initial-boot");

    const checkBudgetBillsWithheldAndStaleRemoved = async (stateLabel, forbiddenZeroBadRe) => {
      const cashHero = await assertVisible(page, "[data-budget-cash-hero]");
      const incomeRatio = norm(await page.locator("[data-budget-ratio=\"income\"]").first().textContent());
      const billsTerm = await assertVisible(page, "[data-blend-term=\"assignedBills\"]");
      const periodResult = await assertVisible(page, "[data-budget-period-result]");
      const phValue = await assertVisible(page, "[data-ph-value]");
      const billsRatio = norm(await page.locator("[data-budget-ratio=\"bills\"]").first().textContent());
      const householdRatio = norm(await page.locator("[data-budget-ratio=\"household\"]").first().textContent());
      const badTerm = await assertVisible(page, "[data-blend-term=\"balanceAfterDeductions\"]");
      const cardToggle = await assertVisible(page, "[data-budget-card-toggle=\"travelvisa\"]");
      const surfaceText = norm(await page.locator("[data-budget-surface]").innerText());

      // Dependent claims fail closed to Unavailable:
      assert.match(billsTerm, /Unavailable/);
      assert.match(periodResult, /Unavailable/);
      assert.match(badTerm, /Unavailable/);
      assert.match(phValue, /Unavailable/);

      // Stale visible claims ($1,665.00 bill total and $1,632.01 BAD) and
      // fabricated zero-amount claims must not appear anywhere on the surface:
      assert.doesNotMatch(billsTerm, /\$1,665\.00|\$1,580\.00|\$1,605\.00|\$1,520\.00/);
      assert.doesNotMatch(periodResult, /\$1,632\.01|\$1,717\.01|\$1,692\.01|\$1,777\.01|\$0\.00/);
      assert.doesNotMatch(phValue, /\$1,632\.01|\$1,717\.01|\$1,692\.01|\$1,777\.01|\$0\.00/);
      assert.doesNotMatch(billsRatio, /\$1,665\.00/);
      assert.doesNotMatch(surfaceText, /\$1,665\.00|\$1,632\.01/);
      if (forbiddenZeroBadRe) assert.doesNotMatch(surfaceText, forbiddenZeroBadRe);

      // Independent facts remain visibly published:
      assert.match(cashHero, /\$1,215\.00/);
      assert.match(incomeRatio, /\$2,600\.00[\s\S]*\$4,050\.00/);
      assert.match(householdRatio, /\$444\.49[\s\S]*\$730\.00/);
      assert.match(cardToggle, /\$2,000\.00/);

      receipt.budgetTransitions.push({ state: stateLabel, billsTerm, periodResult, phValue, cashHero });
    };

    // 1A. Bill carrier (`internet`) on `/`: valid -> malformed (all shapes + negative + amountSchedule) -> invalid authored 0 -> restored
    for (const [shapeLabel, rawVal] of UNPARSEABLE_SHAPES) {
      servedData = fx.served();
      applyScheduledAmount(servedData.plan.bills.find(b => b.id === 'internet'), rawVal);
      await rerenderInPlace(page, servedData);
      await checkBudgetBillsWithheldAndStaleRemoved(`bill-internet-${shapeLabel}`, /\$1,717\.01/, { checkClipRatio: true });
    }
    for (const [shapeLabel, rawVal] of NEGATIVE_FINITE_SHAPES) {
      servedData = fx.served();
      applyScheduledAmount(servedData.plan.bills.find(b => b.id === 'internet'), rawVal);
      await rerenderInPlace(page, servedData);
      await checkBudgetBillsWithheldAndStaleRemoved(`bill-internet-negative-${shapeLabel}`, /\$1,717\.01/, { checkClipRatio: false });
    }
    for (const [schedLabel, schedVal] of [['amountSchedule-"abc"', 'abc'], ['amountSchedule--85', -85]]) {
      servedData = fx.served();
      const bill = servedData.plan.bills.find(b => b.id === 'internet');
      bill.amountSchedule = [{ from: '2026-08-01', until: '2026-09-01', amount: schedVal }];
      await rerenderInPlace(page, servedData);
      await checkBudgetBillsWithheldAndStaleRemoved(`bill-internet-${schedLabel}`, /\$1,717\.01/);
    }

    // Authored zero bill is invalid; explicit waivers are a separate contract.
    servedData = fx.served();
    servedData.plan.bills.find(b => b.id === 'internet').amount = 0;
    await rerenderInPlace(page, servedData);
    {
      const billsTerm = await assertVisible(page, '[data-blend-term="assignedBills"]');
      const periodResult = await assertVisible(page, '[data-budget-period-result]');
      const phValue = await assertVisible(page, '[data-ph-value]');
      assert.match(billsTerm, /Unavailable/);
      assert.match(periodResult, /Unavailable/);
      assert.match(phValue, /Unavailable/);
      assert.doesNotMatch(periodResult, /\$1,717\.01|\$1,632\.01|\$0\.00/);
      receipt.budgetTransitions.push({ state: 'bill-internet-authored-zero-invalid', billsTerm, periodResult, phValue });
    }

    // Restore valid bill (`internet.amount = 85`) in-place and across reload:
    servedData = fx.served();
    await rerenderInPlace(page, servedData);
    await checkBudgetValidBaseline('bill-internet-restored-in-place');
    await page.reload();
    await page.locator('[data-budget-cash-hero]').waitFor();
    await checkBudgetValidBaseline('bill-internet-restored-reload');

    // 1B. Obligation carrier (`card-minimum`) on `/`: valid -> malformed -> Ruling C replacement -> invalid authored 0 -> restored
    for (const [shapeLabel, rawVal] of UNPARSEABLE_SHAPES) {
      servedData = fx.served();
      applyScheduledAmount(servedData.plan.obligations.find(o => o.id === 'card-minimum'), rawVal);
      await rerenderInPlace(page, servedData);
      await checkBudgetBillsWithheldAndStaleRemoved(`obligation-card-minimum-${shapeLabel}`, /\$1,692\.01/);
    }

    // Negative finite obligation (`-60`, `"-60"`): existing contract skips non-positive
    // scheduled payment in expandEvents (resulting in $1,605.00 bills / $1,692.01 BAD on Budget
    // while withholding nextPayment on Credit page, verified in Section 3 below):
    for (const [negLabel, negVal] of [['-60', -60], ['"-60"', '-60']]) {
      servedData = fx.served();
      servedData.plan.obligations.find(o => o.id === 'card-minimum').amount = negVal;
      await rerenderInPlace(page, servedData);
      const billsTerm = await assertVisible(page, '[data-blend-term="assignedBills"]');
      const periodResult = await assertVisible(page, '[data-budget-period-result]');
      assert.match(billsTerm, /\$1,605\.00/);
      assert.match(periodResult, /\$1,692\.01/);
      receipt.budgetTransitions.push({ state: `obligation-card-minimum-${negLabel}`, billsTerm, periodResult });
    }

    // Ruling C on `/`: malformed obligation `amount: "1,900"` replaced for 2026-08-22
    // by confirmed `statementOccurrences` minimum `60`:
    servedData = fx.served();
    {
      const obl = servedData.plan.obligations.find(o => o.id === 'card-minimum');
      obl.amount = '1,900';
      obl.statementOccurrences = [{
        scheduledDate: '2026-08-22',
        dueDate: '2026-08-22',
        minimum: 60,
        currency: 'cad',
        confidence: 'confirmed',
      }];
      await rerenderInPlace(page, servedData);
      const billsTerm = await assertVisible(page, '[data-blend-term="assignedBills"]');
      const periodResult = await assertVisible(page, '[data-budget-period-result]');
      const phValue = await assertVisible(page, '[data-ph-value]');
      assert.match(billsTerm, /\$1,665\.00/);
      assert.match(periodResult, /\$1,632\.01/);
      assert.match(phValue, /\$1,632\.01/);
      receipt.budgetTransitions.push({ state: 'obligation-ruling-c-statement-minimum-60', billsTerm, periodResult });
    }

    // Transition back to malformed obligation `"abc"` first, then to genuine numeric `0`
    // so the direct malformed -> genuine 0 transition is proven on `/`:
    servedData = fx.served();
    servedData.plan.obligations.find(o => o.id === 'card-minimum').amount = 'abc';
    await rerenderInPlace(page, servedData);
    await checkBudgetBillsWithheldAndStaleRemoved('obligation-pre-zero-abc', /\$1,692\.01/);

    servedData = fx.served();
    servedData.plan.obligations.find(o => o.id === 'card-minimum').amount = 0;
    await rerenderInPlace(page, servedData);
    {
      const billsTerm = await assertVisible(page, '[data-blend-term="assignedBills"]');
      const periodResult = await assertVisible(page, '[data-budget-period-result]');
      const phValue = await assertVisible(page, '[data-ph-value]');
      assert.match(billsTerm, /\$1,605\.00/);
      assert.match(periodResult, /\$1,692\.01/);
      assert.match(phValue, /\$1,692\.01/);
      assert.doesNotMatch(periodResult, /Unavailable|\$1,632\.01/);
      receipt.budgetTransitions.push({ state: 'obligation-card-minimum-genuine-0', billsTerm, periodResult, phValue });
    }

    // Restore valid obligation (`card-minimum.amount = 60`):
    servedData = fx.served();
    await rerenderInPlace(page, servedData);
    await checkBudgetValidBaseline('obligation-card-minimum-restored');

    // 1C. Commitment carrier (`school-trip`) on `/`:
    //     Current-period waterfall ($1,665.00 bills, $1,632.01 BAD) stays published
    //     (dependency precision) across valid (400) -> malformed ("abc") ->
    //     negative (-400) -> invalid authored 0 -> restored (400). The old
    //     Upcoming Costs & Savings payday-proposal panel this section also read
    //     left the live page (owner decision, 2026-11-11; Grok audit item A), so
    //     each state now proves it is absent rather than reading its figures.
    const assertFundingPanelGone = async state => {
      const left = await page.evaluate(() => document.querySelectorAll('[data-budget-funding-section], [data-budget-funding-panel]').length);
      assert.equal(left, 0, `${state}: the removed funding-proposal panel is not on the page`);
    };

    {
      await assertFundingPanelGone('commitment-valid');

      // Unparseable commitment `"abc"` on `/`:
      servedData = fx.served();
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = 'abc';
      await rerenderInPlace(page, servedData);
      await checkBudgetValidBaseline('commitment-abc-preserves-current-period-waterfall');
      await assertFundingPanelGone('commitment-abc');

      // Negative commitment `-400` on `/`:
      servedData = fx.served();
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = -400;
      await rerenderInPlace(page, servedData);
      await checkBudgetValidBaseline('commitment-neg400-preserves-current-period-waterfall');
      await assertFundingPanelGone('commitment-neg400');

      // Authored zero commitment retains the same Unknown dependency.
      servedData = fx.served();
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = 0;
      await rerenderInPlace(page, servedData);
      await checkBudgetValidBaseline('commitment-zero-preserves-current-period-waterfall');
      await assertFundingPanelGone('commitment-zero');

      // Restored `400` commitment on `/`:
      servedData = fx.served();
      await rerenderInPlace(page, servedData);
      await checkBudgetValidBaseline('commitment-restored');
      await assertFundingPanelGone('commitment-restored');
    }

    // 1D. Combined 3-carrier transition across Desktop (1440px) and Mobile (390px):
    //     valid -> all 3 malformed -> invalid authored bill/commitment 0 (obligation 0 remains valid) -> restored valid
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      servedData = fx.served();
      await rerenderInPlace(page, servedData);
      await checkBudgetValidBaseline(`combined-valid-${width}px`);

      servedData = fx.served();
      servedData.plan.bills.find(b => b.id === 'internet').amount = 'abc';
      servedData.plan.obligations.find(o => o.id === 'card-minimum').amount = '1,900';
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = null;
      await rerenderInPlace(page, servedData);
      await checkBudgetBillsWithheldAndStaleRemoved(
        `combined-all-3-malformed-${width}px`,
        /\$1,717\.01|\$1,692\.01|\$1,777\.01/
      );

      servedData = fx.served();
      servedData.plan.bills.find(b => b.id === 'internet').amount = 0;
      servedData.plan.obligations.find(o => o.id === 'card-minimum').amount = 0;
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = 0;
      await rerenderInPlace(page, servedData);
      {
        const billsTerm = await assertVisible(page, '[data-blend-term="assignedBills"]');
        const periodResult = await assertVisible(page, '[data-budget-period-result]');
        const phValue = await assertVisible(page, '[data-ph-value]');
        assert.match(billsTerm, /Unavailable/);
        assert.match(periodResult, /Unavailable/);
        assert.match(phValue, /Unavailable/);
        assert.doesNotMatch(periodResult, /\$1,777\.01|\$1,632\.01|\$0\.00/);
        receipt.viewports.push({ width, state: 'combined-authored-zero-bill-commitment-invalid', billsTerm, periodResult });
      }

      servedData = fx.served();
      await rerenderInPlace(page, servedData);
      await checkBudgetValidBaseline(`combined-restored-${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    assert.deepEqual(mutations, []);
    assert.deepEqual(external, []);
    assert.deepEqual(receipt.pageErrors, []);
    fs.writeFileSync(
      path.join(out, 'receipt.json'),
      JSON.stringify({ ...receipt, mutations, external }, null, 2) + '\n'
    );
    console.log(
      `PASS browser-malformed-scheduled-amounts-acceptance: ${receipt.budgetTransitions.length} Budget transitions (${out})`
    );
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
