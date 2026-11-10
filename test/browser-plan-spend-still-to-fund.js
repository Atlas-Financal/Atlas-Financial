'use strict';
// Real Plan Spend page, invented HTTP data only. The negative case deliberately
// corrupts Forecast's publication at the renderer boundary; it does not claim
// the native allocator produces negative funding requirements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const before = process.argv.includes('--before');
const output = process.env.ATLAS_PLAN_SPEND_PROOF_DIR
  || path.join(require('node:os').tmpdir(), 'atlas-plan-spend-still-to-fund');
const data = require('./fixtures/budget-funding-data')();
data.meta.title = 'Invented Plan Spend publication proof';
data.plan.commitments = [
  { id: 'single', label: 'Invented single cost', date: '2026-09-10', amount: 150, confidence: 'confirmed' },
  { id: 'part-one', label: 'Invented first part', date: '2026-09-10', amount: 50,
    group: 'invented-group', confidence: 'confirmed' },
  { id: 'part-two', label: 'Invented second part', date: '2026-09-24', amount: 75,
    group: 'invented-group', confidence: 'confirmed' },
];
data.plan.groups = [{ id: 'invented-group', label: 'Invented grouped cost', planSpendSummary: true }];
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [];
  try {
    for (const width of [1440, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://plan-spend.test') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname))
          return route.fulfill({ json: null });
        const file = url.pathname === '/plan-spend.js' && process.env.ATLAS_PLAN_SPEND_SOURCE
          ? process.env.ATLAS_PLAN_SPEND_SOURCE : path.join(root, 'public', url.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css')
          ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      await page.goto('http://plan-spend.test/plan-spend.html');
      await page.locator('[data-plan-spend-id="single"]').waitFor();
      assert.equal(await page.evaluate(() => App.data.meta.title), data.meta.title);
      // Native positive controls, independently specified by invented targets.
      assert.match(await page.locator('[data-plan-spend-id="single"] [data-plan-spend-fact="remaining"]').first().innerText(), /\$150\.00/);
      assert.match(await page.locator('[data-plan-spend-id="invented-group"] [data-plan-spend-fact="remaining"]').first().innerText(), /\$125\.00/);
      const renderValue = async value => page.evaluate(value => {
        const original = Forecast.recommend;
        Forecast.recommend = (...args) => {
          const advice = original(...args);
          const schedule = advice.planSpendPaydayFunding;
          if (!schedule || schedule.status === 'unavailable' || !schedule.paydays.length)
            throw new Error('Invented native schedule must be available before fault injection');
          for (const row of [...schedule.paydays, ...schedule.costs, ...schedule.groups]) row.stillToFund = value;
          return advice;
        };
        try { renderPlanSpend(App.data, null); } finally { Forecast.recommend = original; }
      }, value);
      const printed = () => page.locator('dt').evaluateAll(nodes => nodes
        .filter(node => /^Still to fund/.test(node.textContent))
        .map(node => node.nextElementSibling.textContent.trim()));
      await renderValue(-25);
      for (const summary of await page.locator('#plan-spend-list details > summary').all()) {
        if (await summary.isVisible()) await summary.click();
      }
      for (const amount of await page.locator('[data-plan-spend-fact="remaining"] dd').all())
        assert.equal(await amount.isVisible(), true, 'cost, group and member remaining can be read');
      const negatives = await printed();
      assert.ok(negatives.length >= 5, 'hero, single, group and member publications are exercised');
      assert.ok(negatives.every(value => value === (before ? '−$25.00' : 'Not established')),
        'all still-to-fund surfaces reject a negative without creating $0');
      await page.locator('#plan-spend-lede').screenshot({ path: path.join(output, `${before ? 'before' : 'after'}-${width}.png`) });
      if (!before) {
        for (const [value, expected] of [[null, 'Not established'], [0, '$0.00'], [25.37, '$25.37']]) {
          await renderValue(value);
          assert.ok((await printed()).every(text => text === expected), 'unknown, zero and positive controls');
        }
        await page.evaluate(() => renderPlanSpend(App.data, null));
        assert.match(await page.locator('[data-plan-spend-id="single"]').innerText(), /\$150\.00/);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(`Plan Spend ${before ? 'before reproduction' : 'after proof'}: 1440, 390, 320px; native and publication-boundary controls passed.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
