'use strict';
// A saved (closed) pay period never says its plan is "Unavailable" beside plan
// amounts it shows, on the real Budget page, reached the way a person reaches
// it: the Pay period slider (keyboard ArrowLeft), then each sheet opened from
// its own control. The node manifest proves the same wording through the page's
// renderers (test/test-saved-close-plan-labels.js); this is the browser path.
//
// Invented data only (test/fixtures/private-period-history-input: cycle
// Feb 1-14 2030, groceries 40, income 200, an invented $30 bill; the close is
// saved Feb 16 and read on Feb 20, after the groceries target was raised to
// 80). Every expectation is written by hand.
// `node test/browser-saved-close-plan-labels.js`
// (Playwright browser suite; not part of the node manifest, see test/test.js).
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, NEXT, input } = require('./fixtures/private-period-history-input');

const root = path.join(__dirname, '..');
const bill = () => [{ id: 'invented-bill', label: 'Invented bill', frequency: 'monthly', day: 10, amount: 30,
  confidence: 'confirmed', payingAccount: 'chequing-a' }];
const closeRaw = input({ day: '2030-02-16', kind: 'closing', periodStart: START, bills: bill() });
delete closeRaw.kind; delete closeRaw.periodStart;
const capturedAt = closeRaw.capturedAt; delete closeRaw.capturedAt;
const record = Pg.project(History.captureClosing(JSON.parse(JSON.stringify(closeRaw)), { now: () => new Date(capturedAt) }));
const today = input({ day: '2030-02-20', kind: 'first-observed', periodStart: NEXT, bills: bill() }).data;
today.plan.budget.categories.find(row => row.id === 'groceries').plannedPayday = 80;

const WHOLE_PLAN_UNAVAILABLE = /Historical original plan unavailable|Original plan: Unavailable|Actual and plan unknown|Exact-period amounts and their evidence are unavailable/;
// The close saved its period totals and prints them, so none may be called missing.
const TOTAL_MISSING = /Total not saved|no period totals|Plan total: Not saved|Actual total: Not saved/;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    for (const width of [1440, 390]) for (const savedClose of [true, false]) {
      const data = { ...today, periodHistory: savedClose ? [record] : [] };
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const errors = [], external = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file),
          contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.locator('.river').waitFor();
      const start = () => page.evaluate(() => document.querySelector('[data-budget-window-progress]')?.dataset.start || null);
      for (let i = 0; i < 6 && await start() !== START; i++) {
        const was = await start();
        await page.locator('.river').focus();
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction(s => document.querySelector('[data-budget-window-progress]')?.dataset.start !== s, was, { timeout: 5000 });
      }
      const tag = `${width}px ${savedClose ? 'saved close' : 'uncaptured'}`;
      assert.equal(await start(), START, `${tag}: the slider reaches the closed period Feb 1-14`);

      const body = page.locator('[data-budget-detail-body]');
      // `whole` also reads what sits behind a closed disclosure in the sheet.
      const sheet = async (number, whole = false) => {
        const trigger = page.locator(`[data-operating-question="${number}"] > details > summary`);
        await trigger.focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open);
        const text = (whole ? await body.evaluate(el => el.textContent) : await body.innerText()).replace(/\s+/g, ' ');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('[data-budget-detail-sheet]')?.open);
        return text;
      };
      const household = await sheet('06'), income = await sheet('02'), bills = await sheet('04', true);
      const tile = (await page.locator('[data-budget-browse-hold]:visible').first().innerText()).replace(/\s+/g, ' ');

      if (savedClose) {
        // The saved planned amounts print, each beside its saved spending.
        assert.match(household, /GROCERIES[\s\S]*Planned \$40\.00 Spent \$12\.34[\s\S]*FUEL[\s\S]*Planned \$15\.00 Spent \$0\.00/i,
          `${tag}: the Household sheet prints the saved plan (groceries 40.00, fuel 15.00)`);
        assert.match(household, /Whether it was an estimate was not saved\./, `${tag}: an untagged saved plan says its trust word was not saved`);
        assert.match(household, /Household Budget Total Actual \/ Planned Comparison not saved/i, `${tag}: the Household total names the missing comparison`);
        assert.match(income, /\+\$200\.00[\s\S]*Payday balance \$200\.00[\s\S]*Actual against plan Comparison: Not saved with this close\./i,
          `${tag}: the Income sheet names the missing comparison beside the saved 200.00`);
        assert.match(bills, /Comparison not saved[\s\S]*\$30\.00 this period/, `${tag}: the Bills sheet says "Comparison not saved" beside the saved $30.00 this period`);
        assert.match(tile, /Comparison not saved/, `${tag}: the Household tile reads "Comparison not saved"`);
        for (const [name, text] of [['Household sheet', household], ['Income sheet', income], ['Bills sheet', bills], ['Household tile', tile]]) {
          assert.doesNotMatch(text, WHOLE_PLAN_UNAVAILABLE, `${tag}: the ${name} never calls the whole plan unavailable or unknown`);
          assert.doesNotMatch(text, TOTAL_MISSING, `${tag}: the ${name} never says a total it prints was not saved`);
          assert.doesNotMatch(text, /\$80(\.00)?\b/, `${tag}: today's groceries target (80) is nowhere on the ${name}`);
        }
      } else {
        // Control: with no saved close the category targets are today's, not
        // that period's plan, so the cautious wording stands.
        assert.match(household, /Historical original plan unavailable\./, `${tag}: the Household sheet keeps "Historical original plan unavailable"`);
        assert.doesNotMatch(household, /Planned \$\d/, `${tag}: today's groceries target (80) is not printed as that period's plan`);
        assert.match(household, /Actual and plan unknown/, `${tag}: the Household total keeps "Actual and plan unknown"`);
        assert.doesNotMatch(household + income + bills + tile, /Comparison not saved|not saved with this close|was not saved\./, `${tag}: no saved-close wording appears`);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await page.close();
      console.log(`PASS ${tag}`);
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
