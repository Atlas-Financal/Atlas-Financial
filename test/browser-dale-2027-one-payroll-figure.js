'use strict';
// One 2027 Dale payroll figure on the rendered page.
// Real App boot of `/` in Chromium over an invented packet (no server, no
// provider, no household figure). The page's own Forecast.recommend call is
// captured, the page steps to the Jan 1 2027 pay period, and the rendered
// Budget income line is compared with the weekly-cap walk, the Plan chart
// sim and the next-period view from that same call.
//
// The 2027 estimate comes from Forecast's salary evidence, a household fact,
// so it is never printed: every check is an equality or a trust tag.
// Hand facts from the invented inputs: the stream is 1,400 biweekly,
// anchor 2026-12-04, so Dec 18 2026 is a 1,400 confirmed payday and
// Jan 1 2027 is the next payday after the household date Dec 24.
//
// NODE_PATH=<playwright packages> CHROME_PATH=<Chromium> node test/browser-dale-2027-one-payroll-figure.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'public');
const origin = 'http://dale-2027-payroll.test';
const AS_OF = '2026-12-24';
const STREAM = 1400;

function packet() {
  return {
    meta: { asOf: AS_OF, title: 'Synthetic 2027 payroll' },
    accounts: [], revolvingExtra: [], debts: [],
    plan: {
      defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
      windowDays: 91,
      startingCash: { breakdown: [
        { id: 'chequing-a', label: 'Synthetic bills account', value: 3000 },
        { id: 'chequing-b', label: 'Synthetic spending account', value: 0 },
      ] },
      opening: { asOf: AS_OF },
      budget: { categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'],
          plannedPayday: 200, confidence: 'confirmed' },
      ] },
      obligations: [],
      bills: [{ id: 'rent', label: 'Rent', frequency: 'monthly', day: 5, amount: 900,
        confidence: 'confirmed', payingAccount: 'chequing-a' }],
      commitments: [{ id: 'roof', label: 'Invented roof', date: '2027-05-20', amount: 9000,
        confidence: 'confirmed' }],
      income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: '2026-12-04', amount: STREAM, confidence: 'confirmed' }],
      payrollPlanningAssumptions: { salaryRaiseFactor: 1, bonusRate: 0, authorizedThroughYear: 2027 },
    },
  };
}

const failures = [];
const pageErrors = [];
const external = [];
function check(label, verify) {
  try { verify(); console.log('  PASS  ' + label); } catch (error) {
    failures.push(label);
    console.log('  FAIL  ' + label);
  }
}
const settle = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));
const cents = text => {
  const m = String(text || '').replace(/[\s,]/g, '').match(/-?\$?(\d+(?:\.\d{1,2})?)/);
  return m ? Math.round(Number(m[1]) * 100) : null;
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce', serviceWorkers: 'block' });
    const data = packet();
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) return route.abort();
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (url.pathname === '/data.json') return route.fulfill({ json: data });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) {
        return route.fulfill({ json: null });
      }
      const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css'
        : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin + '/');
    await page.locator('[data-pay-period-swipe]').waitFor();
    // Capture the page's own recommend() result, then repaint through it.
    await page.evaluate(() => {
      const original = Forecast.recommend;
      Forecast.recommend = function () {
        const advice = original.apply(this, arguments);
        window.__daleAdvice = advice;
        window.__daleArgs = Array.from(arguments);
        return advice;
      };
      App.rerender();
    });
    await settle(page);
    const before = await page.locator('[data-pay-period-swipe]').getAttribute('data-selected-pay-period');
    await page.locator('.river').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(previous => document.querySelector('[data-pay-period-swipe]')
      ?.getAttribute('data-selected-pay-period') !== previous, before);
    await settle(page);

    const line = page.locator('[data-period-income="payroll"]').first();
    await line.waitFor({ state: 'attached' });
    const rendered = {
      status: await line.getAttribute('data-income-status'),
      // The period's planned income: this invented world has one income
      // stream, so the Jan 1–14 period's income is that one cheque.
      amountText: await page.locator('[data-budget-ratio="income"]').first()
        .getAttribute('data-budget-planned-amount'),
      range: await page.evaluate(() => document.body.innerText.includes('Jan 1 – Jan 14')),
    };
    const fromPage = await page.evaluate(() => {
      const advice = window.__daleAdvice;
      const [plan, asOf, opts] = window.__daleArgs;
      const isDale = e => e && e.kind === 'income' && e.id === 'payroll';
      const cap = Forecast.simulate(plan, asOf, Object.assign({}, advice.simOptions, {
        weeklyVariable: advice.weekly, horizonDays: advice.knowledge.days,
        viewDays: advice.knowledge.days, viewStart: asOf,
      })).events.filter(isDale);
      const chart = (advice.sim.events || []).filter(isDale);
      const next = [];
      const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 6) return;
        if (o.kind === 'income' && o.id === 'payroll' && o.date === '2027-01-01') next.push(o);
        for (const k of Object.keys(o)) walk(o[k], depth + 1);
      };
      walk(advice.nextPeriodView, 0);
      const strip = e => ({ date: e.date, cents: Math.round(e.amount * 100), confidence: e.confidence });
      // Cap oracle: the same page call with no 2027 regime and a hand-written
      // caller adjustment that writes the Budget's 2027 figures into the walk.
      const bare = Object.assign({}, plan);
      delete bare.payrollPlanningAssumptions;
      const jan1 = cap.find(e => e.date === '2027-01-01');
      // 2027 figures read from the Budget timeline rows (payPeriodViews),
      // the path the rendered Budget period prints, not from the walk.
      const byDate = new Map();
      for (const view of advice.payPeriodViews || []) {
        for (const row of (view && view.income) || []) {
          if (isDale(row) && row.date >= '2027-01-01') byDate.set(row.date, row.amount);
        }
      }
      const oracle = Forecast.recommend(bare, asOf, Object.assign({}, opts, {
        incomeOccurrenceAdjust: (stream, date) => stream.id !== 'payroll' || date < '2027-01-01' ? null
          : byDate.has(date) ? { amount: byDate.get(date), confidence: 'estimated' } : { omit: true },
      }));
      return {
        cap: cap.map(strip), chart: chart.map(strip), next: next.map(r => ({
          cents: Math.round(r.planned * 100), confidence: r.confidence })),
        nextStart: advice.nextPeriodView && advice.nextPeriodView.periodStart,
        jan1Cents: jan1 ? Math.round(jan1.amount * 100) : null,
        capEqualsOracle: oracle.weekly === advice.weekly,
      };
    });

    const renderedCents = cents(rendered.amountText);
    check('rendered period is Jan 1 2027', () => assert.equal(rendered.range, true));
    check('rendered Jan 1 Budget payroll line is tagged estimated',
      () => assert.equal(rendered.status, 'estimated'));
    check('rendered Jan 1 figure is not the plain 1,400 stream',
      () => assert.notEqual(renderedCents, STREAM * 100));
    check('weekly-cap walk Jan 1 cheque equals the rendered Budget figure',
      () => assert.equal(fromPage.jan1Cents, renderedCents));
    check('weekly-cap walk 2027 cheques are all tagged estimated', () => {
      const rows = fromPage.cap.filter(e => e.date >= '2027-01-01');
      assert.ok(rows.length > 0);
      assert.ok(rows.every(e => e.confidence === 'estimated'));
    });
    check('Plan chart sim Jan 1 cheque equals the rendered figure, estimated', () => {
      const row = fromPage.chart.find(e => e.date === '2027-01-01');
      assert.ok(row);
      assert.equal(row.cents, renderedCents);
      assert.equal(row.confidence, 'estimated');
    });
    check('next-period view opens Jan 1 and its cheque equals the rendered figure, estimated', () => {
      assert.equal(fromPage.nextStart, '2027-01-01');
      assert.ok(fromPage.next.length > 0);
      assert.ok(fromPage.next.every(r => r.cents === renderedCents && r.confidence === 'estimated'));
    });
    check('2026 cheques in the walk stay 1,400 confirmed', () => {
      assert.ok(fromPage.cap.filter(e => e.date < '2027-01-01')
        .every(e => e.cents === STREAM * 100 && e.confidence === 'confirmed'));
    });
    check('page weekly cap equals a walk fed the 2027 figures by hand',
      () => assert.equal(fromPage.capEqualsOracle, true));
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  failures.push('browser execution: ' + (error && error.message));
  console.error(error && error.message);
}).finally(() => {
  check('no page errors', () => assert.deepEqual(pageErrors, []));
  check('no external requests', () => assert.deepEqual(external, []));
  console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall passed');
  process.exitCode = failures.length ? 1 : 0;
});
