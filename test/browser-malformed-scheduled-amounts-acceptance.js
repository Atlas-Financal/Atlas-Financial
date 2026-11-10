'use strict';
// Real-browser acceptance proof for Issue #726 (ATLAS-077):
// Reject malformed bill, commitment, and obligation amounts across the live
// App boot and recompute path (`App.boot()` / `App.rerender()` -> `Forecast`
// -> visible DOM surfaces on `/`, `/bills.html`, `/credit.html`,
// `/plan-spend.html`, and `/planning.html`).
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
//   Bills page: Valid monthly equivalent = 1,400 + 120 + 85 = 1,605.00; without internet = 1,520.00
//   Credit:     travelvisa balance = 2,000.00, limit = 5,000.00, available = 3,000.00,
//               rate = 19.99%, next minimum = 60.00 on August 22, 2026
//   Plan Spend: school-trip = 400.00 (2026-09-12), winter-tires = 900.00 (2026-10-15)
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
  billsMonthlyTotalValid: 1605,
  billsMonthlyTotalWithoutInternet: 1520,
  cardBalance: 2000,
  cardLimit: 5000,
  cardAvailable: 3000,
  cardRate: 19.99,
  cardMin: 60,
  schoolTrip: 400,
  winterTires: 900,
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
    billsTransitions: [],
    creditTransitions: [],
    planSpendTransitions: [],
    planningTransitions: [],
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
    await page.goto(origin + '/');
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
    //     (dependency precision), while Upcoming Costs & Savings payday panel updates
    //     across valid (400) -> malformed ("abc") -> negative (-400) -> invalid authored 0 -> restored (400).
    const readBudgetPaydayFundingPanel = async () => {
      const goalsDetails = page.locator('.blend-goals-panel');
      if (await goalsDetails.count()) {
        const isOpen = await goalsDetails.evaluate(el => el.open);
        if (!isOpen) await page.locator('[data-budget-savings-goals] .blend-tile-head').click();
      }
      const paydayTab = page.locator('[data-budget-funding-tab="payday"]');
      if (await paydayTab.count()) await paydayTab.click();
      return assertVisible(page, '[data-budget-funding-panel="payday"]');
    };

    {
      const validPaydayPanel = await readBudgetPaydayFundingPanel();
      assert.match(validPaydayPanel, /Proposed this payday[\s\S]*\$400\.00/);
      assert.match(validPaydayPanel, /School trip[\s\S]*\$400\.00/);

      // Unparseable commitment `"abc"` on `/`:
      servedData = fx.served();
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = 'abc';
      await rerenderInPlace(page, servedData);
      await checkBudgetValidBaseline('commitment-abc-preserves-current-period-waterfall');
      const abcPaydayPanel = await readBudgetPaydayFundingPanel();
      assert.doesNotMatch(abcPaydayPanel, /Proposed this payday[\s\S]*\$400\.00/);
      assert.doesNotMatch(abcPaydayPanel, /School trip[\s\S]*\$400\.00/);

      // Negative commitment `-400` on `/`:
      servedData = fx.served();
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = -400;
      await rerenderInPlace(page, servedData);
      await checkBudgetValidBaseline('commitment-neg400-preserves-current-period-waterfall');
      const negPaydayPanel = await readBudgetPaydayFundingPanel();
      assert.match(negPaydayPanel, /Proposed this payday Unavailable/);
      assert.match(negPaydayPanel, /Still to fund after this proposal Unavailable/);
      assert.match(negPaydayPanel, /A scheduled amount or date is missing or invalid/);
      assert.doesNotMatch(negPaydayPanel, /\$400\.00/);

      // Authored zero commitment retains the same Unknown dependency.
      servedData = fx.served();
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = 0;
      await rerenderInPlace(page, servedData);
      await checkBudgetValidBaseline('commitment-zero-preserves-current-period-waterfall');
      const zeroPaydayPanel = await readBudgetPaydayFundingPanel();
      assert.match(zeroPaydayPanel, /Proposed this payday Unavailable/);
      assert.match(zeroPaydayPanel, /Still to fund after this proposal Unavailable/);
      assert.match(zeroPaydayPanel, /A scheduled amount or date is missing or invalid/);
      assert.doesNotMatch(zeroPaydayPanel, /School trip[\s\S]*\$0\.00/);

      // Restored `400` commitment on `/`:
      servedData = fx.served();
      await rerenderInPlace(page, servedData);
      const restoredPaydayPanel = await readBudgetPaydayFundingPanel();
      assert.match(restoredPaydayPanel, /Proposed this payday[\s\S]*\$400\.00/);
      assert.match(restoredPaydayPanel, /School trip[\s\S]*\$400\.00/);
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

    // =========================================================================
    // 2. BILLS SURFACE (`/bills.html`) — Real App.boot() + in-place transitions
    //    valid (85) -> malformed (all shapes + amountSchedule) -> invalid authored 0 -> restored (85)
    // =========================================================================
    servedData = fx.served();
    await page.goto(origin + '/bills.html');
    await page.locator('[data-bill-id="internet"]').waitFor();

    const checkBillsValid = async label => {
      const mortgage = await assertVisible(page, '[data-bill-id="mortgage"]');
      const hydro = await assertVisible(page, '[data-bill-id="hydro"]');
      const internet = await assertVisible(page, '[data-bill-id="internet"]');
      const total = await assertVisible(page, '#bills-total');
      assert.match(mortgage, /Mortgage[\s\S]*\$1,400\.00/);
      assert.match(hydro, /Hydro[\s\S]*\$120\.00/);
      assert.match(internet, /Internet[\s\S]*\$85\.00[\s\S]*Monthly equivalent[\s\S]*\$85\.00/i);
      assert.doesNotMatch(internet, /Unknown/i);
      assert.match(total, /\$1,605\.00/);
      assert.doesNotMatch(total, /not in this total/i);
      receipt.billsTransitions.push({ state: label, internet, total });
    };

    await checkBillsValid('bills-valid-initial');

    for (const [shapeLabel, rawVal] of [
      ['"abc"', 'abc'],
      ['null', null],
      ['NaN', NaN],
      ['"1,900"', '1,900'],
      ['"$85"', '$85'],
      ['"-$85"', '-$85'],
      ['"-1,900"', '-1,900'],
      ['Infinity', Infinity],
      ['missing', undefined],
    ]) {
      servedData = fx.served();
      applyScheduledAmount(servedData.plan.bills.find(b => b.id === 'internet'), rawVal);
      await rerenderInPlace(page, servedData);
      const mortgage = await assertVisible(page, '[data-bill-id="mortgage"]');
      const hydro = await assertVisible(page, '[data-bill-id="hydro"]');
      const internet = await assertVisible(page, '[data-bill-id="internet"]');
      const total = await assertVisible(page, '#bills-total');

      // Stale $85.00 and $1,605.00 are removed; malformed row prints Unknown:
      assert.match(internet, /Internet[\s\S]*Amount[\s\S]*Unknown[\s\S]*Monthly equivalent[\s\S]*Unknown/i);
      assert.doesNotMatch(internet, /\$85\.00|\$0\.00/);
      assert.match(total, /\$1,520\.00/);
      assert.match(total, /1 bill with an unknown or one-time cadence is listed above and is not in this total/);
      assert.doesNotMatch(total, /\$1,605\.00/);

      // Sibling valid bills remain visible:
      assert.match(mortgage, /Mortgage[\s\S]*\$1,400\.00/);
      assert.match(hydro, /Hydro[\s\S]*\$120\.00/);
      receipt.billsTransitions.push({ state: `bills-malformed-${shapeLabel}`, internet, total });
    }

    // Malformed / negative bill amountSchedule terms on `/bills.html`:
    for (const [schedLabel, schedVal] of [['amountSchedule-"abc"', 'abc'], ['amountSchedule-null', null], ['amountSchedule-NaN', NaN], ['amountSchedule-""', ''], ['amountSchedule-"1,900"', '1,900'], ['amountSchedule-true', true], ['amountSchedule-[85]', [85]], ['amountSchedule--85', -85], ['amountSchedule-"-85"', '-85']]) {
      servedData = fx.served();
      servedData.plan.bills.find(b => b.id === 'internet').amountSchedule = [
        { from: '2026-08-01', until: '2026-09-01', amount: schedVal },
      ];
      await rerenderInPlace(page, servedData);
      const internet = await assertVisible(page, '[data-bill-id="internet"]');
      const total = await assertVisible(page, '#bills-total');
      assert.match(internet, /Internet[\s\S]*Amount[\s\S]*Unknown[\s\S]*Monthly equivalent[\s\S]*Unknown/i);
      assert.doesNotMatch(internet, /\$85\.00|\$0\.00|-\$85\.00/);
      assert.match(total, /\$1,520\.00/);
      assert.match(total, /not in this total/);
      receipt.billsTransitions.push({ state: `bills-${schedLabel}`, internet, total });
    }

    // Authored zero bill and promo price both remain Unknown on `/bills.html`.
    servedData = fx.served();
    servedData.plan.bills.find(b => b.id === 'internet').amount = 0;
    await rerenderInPlace(page, servedData);
    {
      const internet = await assertVisible(page, '[data-bill-id="internet"]');
      const total = await assertVisible(page, '#bills-total');
      assert.match(internet, /Internet[\s\S]*Amount[\s\S]*Unknown[\s\S]*Monthly equivalent[\s\S]*Unknown/i);
      assert.doesNotMatch(internet, /\$0\.00/i);
      assert.match(total, /\$1,520\.00/);
      assert.match(total, /not in this total/i);
      receipt.billsTransitions.push({ state: 'bills-authored-zero-invalid', internet, total });
    }

    servedData = fx.served();
    servedData.plan.bills.find(b => b.id === 'internet').amountSchedule = [
      { from: '2026-08-01', until: '2026-09-01', amount: 0 },
    ];
    await rerenderInPlace(page, servedData);
    {
      const internet = await assertVisible(page, '[data-bill-id="internet"]');
      assert.match(internet, /Internet[\s\S]*Amount[\s\S]*Unknown[\s\S]*Monthly equivalent[\s\S]*Unknown/i);
      assert.doesNotMatch(internet, /\$0\.00/i);
      receipt.billsTransitions.push({ state: 'bills-promo-authored-zero-invalid', internet });
    }

    // Restore valid `internet.amount = 85` in-place and across reload:
    servedData = fx.served();
    await rerenderInPlace(page, servedData);
    await checkBillsValid('bills-restored-in-place');
    await page.reload();
    await page.locator('[data-bill-id="internet"]').waitFor();
    await checkBillsValid('bills-restored-reload');

    // =========================================================================
    // 3. CREDIT SURFACE (`/credit.html`) — Real App.boot() + in-place transitions
    //    valid (60) -> malformed & negative -> Ruling C replacement -> invalid authored 0 -> restored (60)
    // =========================================================================
    servedData = fx.served();
    await page.goto(origin + '/credit.html');
    await page.locator('[data-credit-id="travelvisa"]').waitFor();

    const checkCreditValid = async label => {
      const card = await assertVisible(page, '[data-credit-id="travelvisa"]');
      assert.match(card, /Posted balance[\s\S]*\$2,000\.00/i);
      assert.match(card, /Credit limit[\s\S]*\$5,000\.00/i);
      assert.match(card, /Available credit[\s\S]*\$3,000\.00/i);
      assert.match(card, /Interest rate[\s\S]*19\.99%/i);
      assert.match(card, /Minimum payment[\s\S]*\$60\.00/i);
      assert.match(card, /Due date[\s\S]*August 22, 2026/i);
      assert.doesNotMatch(card, /Minimum payment[\s\S]*Unknown/i);
      receipt.creditTransitions.push({ state: label, card });
    };

    await checkCreditValid('credit-valid-initial');

    for (const [shapeLabel, rawVal] of [...UNPARSEABLE_SHAPES, ['-60', -60], ['"-60"', '-60']]) {
      servedData = fx.served();
      applyScheduledAmount(servedData.plan.obligations.find(o => o.id === 'card-minimum'), rawVal);
      await rerenderInPlace(page, servedData);
      const card = await assertVisible(page, '[data-credit-id="travelvisa"]');

      // Stale $60.00 minimum and August 22, 2026 due date are removed; Unknown is rendered:
      assert.match(card, /Minimum payment[\s\S]*Unknown/i);
      assert.match(card, /Due date[\s\S]*Unknown/i);
      assert.doesNotMatch(card, /\$60\.00|-\$60\.00|August 22, 2026/);

      // Independent card facts remain visible:
      assert.match(card, /Posted balance[\s\S]*\$2,000\.00/i);
      assert.match(card, /Credit limit[\s\S]*\$5,000\.00/i);
      assert.match(card, /Available credit[\s\S]*\$3,000\.00/i);
      assert.match(card, /Interest rate[\s\S]*19\.99%/i);
      receipt.creditTransitions.push({ state: `credit-malformed-${shapeLabel}`, card });
    }

    // Ruling C on `/credit.html`: malformed `amount: "1,900"` replaced for 2026-08-22 by confirmed statement minimum 60:
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
      await checkCreditValid('credit-ruling-c-statement-minimum-60');
    }

    // Genuine numeric 0 obligation (`card-minimum.amount = 0`) on `/credit.html`:
    // Existing contract emits no positive payment occurrence (`nextPayment = null`),
    // withholding Minimum payment as Unknown while preserving card balances:
    servedData = fx.served();
    servedData.plan.obligations.find(o => o.id === 'card-minimum').amount = 0;
    await rerenderInPlace(page, servedData);
    {
      const card = await assertVisible(page, '[data-credit-id="travelvisa"]');
      assert.match(card, /Posted balance[\s\S]*\$2,000\.00/i);
      assert.match(card, /Credit limit[\s\S]*\$5,000\.00/i);
      assert.match(card, /Available credit[\s\S]*\$3,000\.00/i);
      assert.match(card, /Interest rate[\s\S]*19\.99%/i);
      assert.match(card, /Minimum payment[\s\S]*Unknown/i);
      assert.doesNotMatch(card, /\$60\.00/);
      receipt.creditTransitions.push({ state: 'credit-genuine-0', card });
    }

    // Restore valid `card-minimum.amount = 60` in-place and across reload:
    servedData = fx.served();
    await rerenderInPlace(page, servedData);
    await checkCreditValid('credit-restored-in-place');
    await page.reload();
    await page.locator('[data-credit-id="travelvisa"]').waitFor();
    await checkCreditValid('credit-restored-reload');

    // =========================================================================
    // 4. PLAN SPEND SURFACE (`/plan-spend.html`) & FORECAST (`/planning.html`)
    //    valid (400) -> malformed & negative -> Ruling B preserves -> invalid authored 0 -> restored (400)
    // =========================================================================
    servedData = fx.served();
    await page.goto(origin + '/plan-spend.html');
    await page.locator('#plan-spend-lede').waitFor();

    const checkPlanSpendValid = async label => {
      const lede = await assertVisible(page, '#plan-spend-lede');
      const school = await assertVisible(page, '[data-plan-spend-id="school-trip"]');
      const tires = await assertVisible(page, '[data-plan-spend-id="winter-tires"]');
      assert.match(lede, /August 28, 2026[\s\S]*Set aside:\s*\$400\.00[\s\S]*School trip\s*\$400\.00[\s\S]*Still to fund\s*\$900\.00/i);
      assert.match(school, /School trip[\s\S]*\$400\.00[\s\S]*FEASIBLE IN CURRENT PLAN[\s\S]*Still to fund in this plan[\s\S]*\$400\.00/i);
      assert.match(tires, /Winter tires[\s\S]*\$900\.00[\s\S]*FEASIBLE IN CURRENT PLAN[\s\S]*Next contribution[\s\S]*\$900\.00 on September 25, 2026/i);
      assert.doesNotMatch(lede, /missing or invalid|no valid base requirement/i);
      receipt.planSpendTransitions.push({ state: label, lede, school, tires });
    };

    await checkPlanSpendValid('plan-spend-valid-initial');

    for (const [shapeLabel, rawVal] of UNPARSEABLE_SHAPES) {
      servedData = fx.served();
      applyScheduledAmount(servedData.plan.commitments.find(c => c.id === 'school-trip'), rawVal);
      await rerenderInPlace(page, servedData);
      const lede = await assertVisible(page, '#plan-spend-lede');
      const tires = await assertVisible(page, '[data-plan-spend-id="winter-tires"]');
      const mainText = norm(await page.locator('#plan-spend').innerText());

      // Stale $400.00 set-aside and FEASIBLE IN CURRENT PLAN claims are removed:
      assert.match(lede, /A scheduled amount or date is missing or invalid, so the totals and spending claims that depend on it are unknown\./);
      assert.doesNotMatch(lede, /Set aside:\s*\$400\.00|\$0\.00/);
      const schoolCount = await page.locator('[data-plan-spend-id="school-trip"]').count();
      if (schoolCount > 0) {
        const school = await assertVisible(page, '[data-plan-spend-id="school-trip"]');
        assert.match(school, /STATUS UNAVAILABLE[\s\S]*Funding schedule unavailable for this cost\./i);
        assert.doesNotMatch(school, /\$400\.00|FEASIBLE IN CURRENT PLAN/i);
      }
      assert.doesNotMatch(mainText, /Set aside:\s*\$400\.00|FEASIBLE IN CURRENT PLAN|Next contribution[\s\S]*September 25, 2026/);

      // Sibling commitment preserves its $900.00 requirement while its schedule status is unavailable:
      assert.match(tires, /Winter tires[\s\S]*\$900\.00[\s\S]*STATUS UNAVAILABLE[\s\S]*Funding schedule unavailable for this cost\./i);
      receipt.planSpendTransitions.push({ state: `plan-spend-malformed-${shapeLabel}`, lede, tires });
    }

    // Negative finite commitment shapes (`-400`, `"-400"`) on `/plan-spend.html`:
    for (const [negLabel, negVal] of [['-400', -400], ['"-400"', '-400']]) {
      servedData = fx.served();
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = negVal;
      await rerenderInPlace(page, servedData);
      const lede = await assertVisible(page, '#plan-spend-lede');
      const school = await assertVisible(page, '[data-plan-spend-id="school-trip"]');
      const tires = await assertVisible(page, '[data-plan-spend-id="winter-tires"]');
      const mainText = norm(await page.locator('#plan-spend').innerText());

      assert.match(lede, /A scheduled amount or date is missing or invalid/);
      assert.doesNotMatch(lede, /Set aside:\s*\$400\.00/);
      assert.doesNotMatch(mainText, /FEASIBLE IN CURRENT PLAN/);
      assert.match(school, /STATUS UNAVAILABLE[\s\S]*Funding schedule unavailable for this cost\./i);
      assert.match(tires, /Winter tires[\s\S]*\$900\.00[\s\S]*STATUS UNAVAILABLE[\s\S]*Funding schedule unavailable for this cost\./i);
      receipt.planSpendTransitions.push({ state: `plan-spend-negative-${negLabel}`, lede, school, tires });
    }

    // Ruling B preserves on `/plan-spend.html`:
    // (1) Valid amountMin/amountMax range when `.amount` is null
    servedData = fx.served();
    {
      const c = servedData.plan.commitments.find(r => r.id === 'school-trip');
      c.amount = null;
      c.amountMin = 300;
      c.amountMax = 400;
      await rerenderInPlace(page, servedData);
      const lede = await assertVisible(page, "#plan-spend-lede");
      const school = await assertVisible(page, "[data-plan-spend-id=\"school-trip\"]");
      const tires = await assertVisible(page, "[data-plan-spend-id=\"winter-tires\"]");
      assert.match(lede, /Set aside:\s*\$300\.00/i);
      assert.match(school, /School trip[\s\S]*\$300\.00–\$400\.00 cost range[\s\S]*Still to fund in this plan\s*\$300\.00[\s\S]*Next contribution\s*\$300\.00 on August 28, 2026/i);
      assert.doesNotMatch(school, /STATUS UNAVAILABLE/i);
      assert.match(tires, /Winter tires[\s\S]*\$900\.00[\s\S]*FEASIBLE IN CURRENT PLAN/i);
      receipt.planSpendTransitions.push({ state: 'plan-spend-ruling-b-range', lede, school });
    }
    // (2) Optional commitment with null amount
    servedData = fx.served();
    {
      const c = servedData.plan.commitments.find(r => r.id === 'school-trip');
      c.amount = null;
      c.flexibility = 'optional';
      await rerenderInPlace(page, servedData);
      const lede = await assertVisible(page, '#plan-spend-lede');
      const tires = await assertVisible(page, '[data-plan-spend-id="winter-tires"]');
      assert.doesNotMatch(lede, /missing or invalid/i);
      assert.match(tires, /Winter tires[\s\S]*\$900\.00[\s\S]*FEASIBLE IN CURRENT PLAN/i);
      receipt.planSpendTransitions.push({ state: 'plan-spend-ruling-b-optional', lede, tires });
    }
    // (3) Settled commitment with null amount
    servedData = fx.served();
    {
      const c = servedData.plan.commitments.find(r => r.id === 'school-trip');
      c.amount = null;
      c.settledOn = '2026-08-18';
      await rerenderInPlace(page, servedData);
      const lede = await assertVisible(page, '#plan-spend-lede');
      const tires = await assertVisible(page, '[data-plan-spend-id="winter-tires"]');
      assert.doesNotMatch(lede, /missing or invalid/i);
      assert.match(tires, /Winter tires[\s\S]*\$900\.00[\s\S]*FEASIBLE IN CURRENT PLAN/i);
      receipt.planSpendTransitions.push({ state: 'plan-spend-ruling-b-settled', lede, tires });
    }

    // Transition from malformed `"abc"` to an invalid authored zero.
    servedData = fx.served();
    servedData.plan.commitments.find(c => c.id === 'school-trip').amount = 'abc';
    await rerenderInPlace(page, servedData);
    assert.match(await assertVisible(page, '#plan-spend-lede'), /missing or invalid/);

    servedData = fx.served();
    servedData.plan.commitments.find(c => c.id === 'school-trip').amount = 0;
    await rerenderInPlace(page, servedData);
    {
      const lede = await assertVisible(page, '#plan-spend-lede');
      const school = await assertVisible(page, '[data-plan-spend-id="school-trip"]');
      const tires = await assertVisible(page, '[data-plan-spend-id="winter-tires"]');
      assert.match(lede, /A scheduled amount or date is missing or invalid/);
      assert.doesNotMatch(lede, /Set aside:\s*\$0\.00|No new protection needed/i);
      assert.match(school, /STATUS UNAVAILABLE[\s\S]*Funding schedule unavailable for this cost\./i);
      assert.match(tires, /Winter tires[\s\S]*\$900\.00[\s\S]*STATUS UNAVAILABLE/i);
      assert.doesNotMatch(school, /\$0\.00|FEASIBLE IN CURRENT PLAN/i);
      receipt.planSpendTransitions.push({ state: 'plan-spend-authored-zero-invalid', lede, school, tires });
    }

    // Restore valid `school-trip.amount = 400` in-place and across reload:
    servedData = fx.served();
    await rerenderInPlace(page, servedData);
    await checkPlanSpendValid('plan-spend-restored-in-place');
    await page.reload();
    await page.locator('#plan-spend-lede').waitFor();
    await checkPlanSpendValid('plan-spend-restored-reload');

    // Forecast / Road Ahead page (`/planning.html`) transition check:
    servedData = fx.served();
    await page.goto(origin + '/planning.html');
    await page.waitForFunction(() => (document.querySelector('#planning')?.innerText || '').length > 50);
    {
      const validPlanning = await assertVisible(page, '#planning');
      assert.doesNotMatch(validPlanning, /A scheduled amount or date is missing or invalid/);

      servedData = fx.served();
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = 'abc';
      await rerenderInPlace(page, servedData);
      const malformedPlanning = await assertVisible(page, '#planning');
      assert.match(malformedPlanning, /A scheduled amount or date is missing or invalid, so the totals and spending claims that depend on it are unknown\./);

      servedData = fx.served();
      servedData.plan.commitments.find(c => c.id === 'school-trip').amount = 0;
      await rerenderInPlace(page, servedData);
      const zeroPlanning = await assertVisible(page, '#planning');
      assert.match(zeroPlanning, /A scheduled amount or date is missing or invalid/);

      servedData = fx.served();
      await rerenderInPlace(page, servedData);
      const restoredPlanning = await assertVisible(page, '#planning');
      assert.doesNotMatch(restoredPlanning, /A scheduled amount or date is missing or invalid/);
      receipt.planningTransitions.push({
        validClean: true,
        malformedHoldRendered: true,
        authoredZeroHeld: true,
        restoredClean: true,
      });
    }

    assert.deepEqual(mutations, []);
    assert.deepEqual(external, []);
    assert.deepEqual(receipt.pageErrors, []);
    fs.writeFileSync(
      path.join(out, 'receipt.json'),
      JSON.stringify({ ...receipt, mutations, external }, null, 2) + '\n'
    );
    console.log(
      `PASS browser-malformed-scheduled-amounts-acceptance: ${receipt.budgetTransitions.length} Budget, `
      + `${receipt.billsTransitions.length} Bills, ${receipt.creditTransitions.length} Credit, `
      + `${receipt.planSpendTransitions.length} Plan Spend, ${receipt.planningTransitions.length} Planning transitions (${out})`
    );
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
