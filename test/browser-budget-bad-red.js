'use strict';
// Negative Balance After Deductions renders in the established critical
// red on the Budget blend hero face. The face's sign comes only from
// Forecast's typed publication: plan.js stamps data-sign="negative" on
// a period's [data-bad-timeline] row iff that period's published BAD
// term is known and < 0. The blend painter propagates that sign — for
// the terms block's own period only — to the .blend-bad slot as
// is-negative; budget-blend.css colours it var(--critical) in both
// themes (the token budget-surface.css already applies to
// [data-sign="negative"] faces). The printed amount text is never
// parsed, and the Q07 step value's own data-sign is never read: it
// keys off the after-funding figure, a different number. A trusted
// $0.00 carries no sign and is never red; an unavailable term is
// muted, never red. Plan-side faces (.budget-step-value outside the
// bento, .budget-period-result-value) already render red through
// budget-surface.css and are cascade-proved below on plan.js's own
// rendered HTML — no producer change anywhere.
// Invented fixtures (other-period-target + two invented bills):
//   A: Other 900.00 → current BAD −$187.34 (calculated), next +$174.45.
//   B: rent 800.00  → current BAD −$493.73, next −$413.21 (estimated).
//   C: Other 712.66 → current BAD exactly $0.00.
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-budget-bad-red.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const fx = require('./fixtures/other-period-target');
const Forecast = require('../public/forecast');
const root = path.join(__dirname, '..');

const CRITICAL = { light: 'rgb(199, 55, 55)', dark: 'rgb(224, 82, 82)' }; // --critical #c73737 / #e05252
const INK = { light: 'rgb(11, 12, 16)', dark: 'rgb(245, 246, 248)' }; // --blend-ink

function withBills(f, rent) {
  f.plan.bills = [
    { id: 'invented-rent', label: 'Invented rent', frequency: 'biweekly', anchor: '2026-09-30', amount: rent, confidence: 'confirmed', payingAccount: 'chequing-a' },
    { id: 'invented-hydro', label: 'Invented hydro', frequency: 'monthly', day: 15, amount: 88.21, confidence: 'estimated', payingAccount: 'chequing-a' }];
  return f;
}
const dataA = () => withBills(fx.build(900), 212.34).data;
const dataB = () => withBills(fx.build(618.73), 800).data;
const dataC = () => withBills(fx.build(712.66), 212.34).data;

// plan.js's own non-compact render for fixture A's current period,
// produced with the same vm harness as test-bad-terms-print.js. Used
// only for the plan-side cascade proof; nothing here is hand-written
// markup.
function planFaceHtml() {
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context;
  context.matchMedia = () => ({ matches: false, addEventListener() {} });
  const script = name => fs.readFileSync(path.join(root, 'public', name + '.js'), 'utf8');
  vm.runInContext(script('app'), context);
  vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
  const f = withBills(fx.build(900), 212.34);
  const advice = Forecast.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet });
  const cur = advice.payPeriodViews.find(v => v.timelineRole === 'current');
  assert.equal(cur.balanceAfterDeductions, -187.34, 'fixture A current BAD is the invented −$187.34');
  context.period = cur; context.plan = f.plan; context.compact = false;
  const html = vm.runInContext('calendarWaterfallHtml(period,null,null,plan,compact)', context);
  assert.match(html, /<p class="budget-period-result-value" data-sign="negative">/, 'producer stamps the period-result face');
  assert.match(html, /data-operating-question="07"[^]*?<span class="budget-step-value" data-sign="negative">/, 'producer stamps the Q07 face');
  // The sheet wrapper budget-surface.js emits around the period surface.
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/budget-surface.css">'
    + '<link rel="stylesheet" href="/budget-blend.css"></head><body>'
    + '<div class="payday-operating-sheet budget-surface" data-budget-surface="pay-period">'
    + html + '</div></body></html>';
}

async function serve(page, data, planHtml) {
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://budget.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: data });
    if (u.pathname === '/__planface') return route.fulfill({ body: planHtml, contentType: 'text/html' });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) {
      return route.fulfill({ json: null });
    }
    if (u.pathname !== '/' && !/\.(js|css|woff2|png|svg)$/.test(u.pathname)) {
      return route.fulfill({ status: 404, body: '' });
    }
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: file.endsWith('.js') ? 'application/javascript'
        : file.endsWith('.css') ? 'text/css' : 'text/html',
    });
  });
}

async function open(browser, data, { theme = 'light', planHtml = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
  await page.addInitScript(chosen => {
    try { localStorage.setItem('hfd-theme', chosen); } catch (e) {}
  }, theme);
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await serve(page, data, planHtml);
  await page.goto('http://budget.test/?view=classic');
  await page.locator('[data-budget-surface]').waitFor();
  await page.locator('[data-blend-term="balanceAfterDeductions"]').waitFor();
  return { page, errors };
}

const readFace = page => page.evaluate(() => {
  const slot = document.querySelector('[data-blend-term="balanceAfterDeductions"]');
  const block = document.querySelector('[data-bad-terms]');
  return {
    text: slot ? slot.textContent : '',
    negative: !!slot && slot.classList.contains('is-negative'),
    unavailable: !!slot && slot.classList.contains('is-unavailable'),
    estimated: !!slot && slot.classList.contains('is-estimated'),
    color: slot ? getComputedStyle(slot).color : '',
    period: block ? block.getAttribute('data-bad-terms-period') : '',
    pill: !!document.querySelector('[data-operating-question="07"] .blend-est'),
  };
});

const moveRiver = async (page, direction) => {
  const before = await page.locator('[data-budget-window-range]').textContent();
  await page.locator('.river').focus();
  await page.keyboard.press(direction < 0 ? 'ArrowLeft' : 'ArrowRight');
  await page.waitForFunction(p => (document.querySelector('[data-budget-window-range]')?.textContent || '') !== p, before);
  await page.waitForTimeout(300);
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
  try {
    // A, light: negative current is red; the sign follows the SELECTED
    // period both ways; a past period's withheld term is muted, not red.
    {
      const { page, errors } = await open(browser, dataA(), { theme: 'light' });
      let face = await readFace(page);
      assert.equal(face.period, 'this-pay-period');
      assert.ok(face.text.includes('−$187.34'), 'minus sign and amount print: ' + face.text);
      assert.equal(face.negative, true, 'negative BAD marks the face');
      assert.equal(face.color, CRITICAL.light, 'negative BAD renders --critical (light)');
      assert.equal(face.unavailable, false);
      await moveRiver(page, 1);
      face = await readFace(page);
      assert.equal(face.period, 'next-pay-period');
      assert.ok(face.text.includes('$174.45'), 'next period amount: ' + face.text);
      assert.equal(face.negative, false, 'positive selected period is not marked');
      assert.equal(face.color, INK.light, 'positive BAD keeps the ink colour');
      await moveRiver(page, -1);
      face = await readFace(page);
      assert.equal(face.period, 'this-pay-period');
      assert.equal(face.negative, true, 'returning to the negative period marks it again');
      assert.equal(face.color, CRITICAL.light);
      await moveRiver(page, -1);
      face = await readFace(page);
      assert.equal(face.text, 'Unavailable', 'withheld past term prints Unavailable');
      assert.equal(face.unavailable, true);
      assert.equal(face.negative, false, 'unavailable is never marked negative');
      assert.notEqual(face.color, CRITICAL.light, 'withheld amounts have no deficit warning');
      assert.deepEqual(errors, []);
      await page.close();
    }
    // A, dark: the same negative face renders the dark --critical.
    {
      const { page, errors } = await open(browser, dataA(), { theme: 'dark' });
      const face = await readFace(page);
      assert.equal(face.negative, true);
      assert.equal(face.color, CRITICAL.dark, 'negative BAD renders --critical (dark)');
      assert.deepEqual(errors, []);
      await page.close();
    }
    // B, light: an estimated negative term uses the same ink as another negative
    // while rendering red.
    {
      const { page, errors } = await open(browser, dataB(), { theme: 'light' });
      let face = await readFace(page);
      assert.ok(face.text.includes('−$493.73'), 'current amount: ' + face.text);
      assert.equal(face.color, CRITICAL.light);
      await moveRiver(page, 1);
      face = await readFace(page);
      assert.equal(face.period, 'next-pay-period');
      assert.ok(face.text.includes('−$413.21'), 'estimated negative amount: ' + face.text);
      assert.equal(face.negative, true, 'estimated negative term marks the face');
      assert.doesNotMatch(face.text, /≈|estimated|est\./i);
      const copy = await page.evaluate(() => {
        const amount = document.querySelector('[data-blend-term="balanceAfterDeductions"]');
        return {
          trust: document.querySelector('[data-bad-term="balanceAfterDeductions"]').dataset.badTermTrust,
          opacity: getComputedStyle(amount).opacity,
          underline: getComputedStyle(amount).textDecorationLine,
          accessibleText: [amount, ...amount.querySelectorAll('[aria-label],[title]')]
            .map(node => [node.getAttribute('aria-label'), node.title].join(' ')).join(' '),
        };
      });
      assert.equal(copy.trust, 'estimated', 'the published figure keeps its trust');
      assert.equal(copy.opacity, '1');
      assert.equal(copy.underline, 'none');
      assert.doesNotMatch(copy.accessibleText, /≈|estimat/i);
      assert.equal(face.estimated, false, 'no trust-specific class');
      assert.equal(face.pill, false, 'the negative amount has no estimate pill');
      assert.equal(face.color, CRITICAL.light, 'estimated negative renders --critical');
      assert.deepEqual(errors, []);
      await page.close();
    }
    // C, light: a trusted $0.00 is known, prints $0.00, and is not red.
    {
      const { page, errors } = await open(browser, dataC(), { theme: 'light' });
      const face = await readFace(page);
      assert.equal(face.period, 'this-pay-period');
      assert.ok(face.text.includes('$0.00'), 'zero prints as $0.00: ' + face.text);
      assert.equal(face.negative, false, 'zero is not a deficit and never marks');
      assert.equal(face.color, INK.light, 'zero keeps the ink colour');
      assert.equal(face.unavailable, false, 'zero is known, not unavailable');
      assert.deepEqual(errors, []);
      await page.close();
    }
    // Plan-side faces: plan.js's own rendered HTML under the real
    // stylesheets — the signed faces already render var(--critical)
    // through budget-surface.css (no bento ancestor, so the blend
    // hero's ink rule does not apply). No producer change was needed.
    {
      const html = planFaceHtml();
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
        await page.addInitScript(chosen => {
          try { localStorage.setItem('hfd-theme', chosen); } catch (e) {}
        }, theme);
        await serve(page, dataA(), html);
        await page.goto('http://budget.test/__planface');
        const faces = await page.evaluate(() => {
          const result = document.querySelector('.budget-period-result-value');
          const q07 = document.querySelector('[data-operating-question="07"] .budget-step-value');
          const plain = [...document.querySelectorAll('.budget-step-value')].find(el => !el.hasAttribute('data-sign'));
          return {
            resultSign: result?.getAttribute('data-sign'), resultColor: result ? getComputedStyle(result).color : '',
            q07Sign: q07?.getAttribute('data-sign'), q07Color: q07 ? getComputedStyle(q07).color : '',
            plainColor: plain ? getComputedStyle(plain).color : '',
          };
        });
        assert.equal(faces.resultSign, 'negative');
        assert.equal(faces.resultColor, CRITICAL[theme], `period-result face renders --critical (${theme})`);
        assert.equal(faces.q07Sign, 'negative');
        assert.equal(faces.q07Color, CRITICAL[theme], `Q07 face outside the bento renders --critical (${theme})`);
        assert.notEqual(faces.plainColor, CRITICAL[theme], 'unsigned step values are not red');
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log('PASS budget BAD red: negative terms render var(--critical) in light and dark on the selected period only; estimated negative keeps its sign and colour; trusted $0.00 and unavailable stay unmarked; plan-side signed faces already render var(--critical)');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
