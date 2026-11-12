'use strict';
// Synthetic full-page proof: node test/browser-budget-signed-cents.js
// Uses the installed Playwright (or playwright-core) and its browser; set
// CHROME_PATH to use another Chromium. Evidence goes to PROOF_OUTPUT_DIR when
// set (absolute, outside the checkout), else to a temporary directory.
// Exits nonzero on the unpatched source, while still writing its evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const { captureSourceBinding, verifySourceBinding } = require('./proof-source-binding');
const fixture = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');
const out = process.env.PROOF_OUTPUT_DIR
  || path.join(require('node:os').tmpdir(), 'atlas-budget-signed-cents');
assert.ok(out && path.isAbsolute(out), 'PROOF_OUTPUT_DIR must be an absolute evidence directory outside the checkout');
assert.ok(!path.resolve(out).startsWith(root + path.sep), 'proof output stays outside the checkout');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function dataFor(c) {
  // Move the invented Aug 14-27 period forward exactly 140 calendar days.
  const data = JSON.parse(JSON.stringify(fixture.served()).replace(/\d{4}-\d{2}-\d{2}/g,
    s => new Date(Date.parse(s + 'T00:00:00Z') + 140 * 86400000).toISOString().slice(0, 10)));
  if (c.large) {
    // The independently reported clipping fixture, without an old payroll
    // snapshot or observed spending that could change this separate oracle.
    delete data.liveOverlay; delete data.refreshTrust; delete data.plan.opening.paydaySnapshot;
    data.plan.opening.representedEvents = []; data.plan.opening.notReliedUponEvents = [];
    data.plan.income = [{ id: 'payroll', label: 'Synthetic Seaspan payroll', frequency: 'biweekly',
      anchor: '2027-01-01', amount: c.income, confidence: 'confirmed' }];
    data.plan.bills = [];
    data.plan.obligations = []; data.plan.commitments = [];
    data.plan.budget.categories = [100.01, 200.02, 300.03].map((amount, i) => ({
      id: ['groceries', 'fuel', 'restaurants'][i], label: 'Synthetic category ' + i,
      class: 'essential', from: [], plannedPayday: amount, confidence: 'confirmed' }));
  }
  // A $0 bill is not a valid bill (#1016), so a zero levy omits the bill:
  // the same 2,600 - 0 - 752.99 identity, with no invalid input.
  if (c.levy) data.plan.bills.push({ id: 'synthetic-january-levy', label: 'Synthetic January levy',
    frequency: 'monthly', day: 3, amount: c.levy, confidence: 'confirmed', payingAccount: 'chequing-a' });
  return data;
}
const cases = [
  // Independent fixture identity: 2,600 income - levy - 752.99 household hold.
  { name: 'positive', levy: 0, expected: '$1,847.01' },
  { name: 'zero', levy: 1847.01, expected: '$0.00' },
  { name: 'negative', levy: 5000, expected: '−$3,152.99' },
  { name: 'negative-cent', levy: 1847.02, expected: '−$0.01' },
  // 4,444.44 - 1,234,567.89 - (100.01 + 200.02 + 300.03).
  { name: 'large-negative', large: true, income: 4444.44, levy: 1234567.89, expected: '−$1,230,723.51' },
  { name: 'large-positive', large: true, income: 1234567.89, levy: 4444.44, expected: '$1,229,523.39' },
  { name: 'unavailable', levy: 0, unavailable: true, expected: 'Unavailable' },
];

(async () => {
  const files = require('node:child_process').execFileSync('git', ['ls-files', '-z', '--', 'public',
    'scripts/*.js', 'test/fixtures', 'test/proof-source-binding.js',
    'test/browser-budget-signed-cents.js', 'package.json', 'package-lock.json'], { cwd: root })
    .toString().split('\0').filter(Boolean);
  const binding = captureSourceBinding(root, files);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true,
    args: ['--disable-accelerated-2d-canvas'] });
  const failures = [], results = [], screenshots = {}, external = [], errors = [];
  const check = (truth, label) => { if (!truth) failures.push(label); };
  try {
    for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) for (const c of cases) {
      const name = `${c.name}-${width}-${theme}`;
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript(chosen => localStorage.setItem('hfd-theme', chosen), theme);
      page.on('pageerror', e => errors.push(name + ': ' + e.message));
      const data = dataFor(c);
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        const bytes = fs.readFileSync(file), relative = path.relative(root, file).split(path.sep).join('/');
        assert.equal(sha256(bytes), binding.files[relative]?.sha256, 'served bytes match bound source: ' + relative);
        const types = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
        return route.fulfill({ body: bytes, contentType: types[path.extname(file)] || 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.waitForSelector('.blend-hero .blend-bad');
      await page.evaluate(() => document.fonts.ready);
      if (c.unavailable) {
        await page.locator('.river').focus();
        await page.keyboard.press('ArrowLeft');
        await page.waitForSelector('.blend-hero .blend-bad.is-unavailable');
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const readState = () => {
        const face = document.querySelector('.blend-hero .blend-bad');
        const block = document.querySelector('[data-bad-terms]');
        const row = [...document.querySelectorAll('ol[data-bad-timeline]>li')]
          .find(el => el.dataset.badTimelinePeriod === block?.dataset.badTermsPeriod);
        const native = row?.querySelector('[data-bad-term-amount]');
        const dollars = face.querySelector('.blend-dollars'), prefix = face.querySelector('.blend-term-prefix');
        const cents = face.querySelector('.blend-cents'), slot = face.closest('.budget-step-value');
        const rect = el => el && { x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y,
          width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
        const glyphRect = el => {
          if (!el) return null;
          const range = document.createRange(); range.selectNodeContents(el);
          const box = range.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        const hatches = [...document.querySelectorAll('.budget-waterfall-track.is-unknown')].map(el => ({
          class: el.className, image: getComputedStyle(el).backgroundImage, rect: rect(el) }));
        // A CSS-only unknown-track control: the same native hatch selector,
        // with a box so its unchanged paint can be captured independently.
        const control = document.querySelector('[data-signed-cents-hatch-control]') || document.createElement('div');
        control.className = 'budget-waterfall-track is-unknown';
        control.style.cssText = 'display:block;width:240px;height:12px;margin:12px';
        control.dataset.signedCentsHatchControl = '';
        document.body.appendChild(control);
        return { native: native?.textContent, text: face.textContent, dollars: dollars?.textContent,
          prefix: prefix?.textContent || '', face: rect(face), dollarRect: rect(dollars), prefixRect: rect(prefix),
          centsRect: glyphRect(cents), dollarGlyphRect: glyphRect(dollars), slot: rect(slot), hero: rect(face.closest('.blend-hero')),
          fontSize: getComputedStyle(dollars || face).fontSize,
          protectedContent: [...slot.querySelectorAll('.blend-clip, .blend-est, .budget-cash-sr')].map(el => el.outerHTML),
          triggerLabel: slot.closest('summary')?.getAttribute('aria-label') || null,
          color: getComputedStyle(dollars || face).color, heroBackground: getComputedStyle(face.closest('.blend-hero')).backgroundColor,
          hatches, hatchControl: getComputedStyle(control).backgroundImage,
          range: document.querySelector('.blend-hero-range')?.textContent.replace(/\s+/g, ' ').trim() };
      };
      const read = await page.evaluate(readState);
      check(read.native === (c.unavailable ? '' : c.expected), name + ': independent fixture amount');
      check(read.text === c.expected, name + ': visible text equals unchanged native amount or withholding');
      check(read.dollars === (c.unavailable ? undefined : c.expected.slice(0, -3)), name + ': sign grouped with dollar digits');
      check(read.prefix === '', name + ': no isolated minus prefix');
      if (!c.unavailable) check(read.range.includes('Jan 1') && read.range.includes('Jan 14'), name + ': reported January range');
      check(read.hatchControl.includes('repeating-linear-gradient'), name + ': unknown hatch retained');
      if (!c.unavailable) check(read.color === (c.expected.startsWith('−') ? (theme === 'dark' ? 'rgb(224, 82, 82)' : 'rgb(199, 55, 55)')
        : theme === 'dark' ? 'rgb(245, 246, 248)' : 'rgb(11, 12, 16)'), name + ': original readable amount color');
      const checkContainment = (value, label) => {
        for (const [part, box] of [['dollars', value.dollarGlyphRect], ['cents', value.centsRect]]) if (box) {
          check(box.x >= value.slot.x - 0.5 && box.x + box.width <= value.slot.x + value.slot.width + 0.5,
            label + ': complete ' + part + ' fit the available amount row');
          check(box.x >= value.hero.x - 0.5 && box.x + box.width <= value.hero.x + value.hero.width + 0.5,
            label + ': complete ' + part + ' stay inside the clipped hero');
        }
        if (value.dollarRect && value.centsRect) check(value.centsRect.y < value.dollarRect.y + value.dollarRect.height / 2,
          label + ': cents stay on the amount line');
      };
      checkContainment(read, name);
      if (c.large && width === 390) {
        read.reflows = [];
        for (const nextWidth of [720, 390]) {
          await page.setViewportSize({ width: nextWidth, height: 1000 });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const resized = await page.evaluate(readState);
          checkContainment(resized, name + '/resize-' + nextWidth);
          check(resized.text === c.expected, name + '/resize-' + nextWidth + ': full text retained');
          check(JSON.stringify(resized.protectedContent) === JSON.stringify(read.protectedContent)
            && resized.triggerLabel === read.triggerLabel, name + '/resize-' + nextWidth + ': accessibility content retained');
          read.reflows.push({ width: nextWidth, ...resized });
        }
      }
      if ((width === 390 && c.name === 'negative') || (c.name === 'large-negative' && width <= 390)) {
        const file = name + '.png';
        await page.locator('.blend-hero').screenshot({ path: path.join(out, file), animations: 'disabled' });
        screenshots[file] = sha256(fs.readFileSync(path.join(out, file)));
        const hatchFile = 'hatch-' + theme + '.png';
        await page.locator('[data-signed-cents-hatch-control]').screenshot({ path: path.join(out, hatchFile) });
        screenshots[hatchFile] = sha256(fs.readFileSync(path.join(out, hatchFile)));
      }
      results.push({ name, ...read });
      await page.close();
    }
    check(external.length === 0, 'no external requests');
    check(errors.length === 0, 'no page errors');
    verifySourceBinding(root, binding);
    const receipt = { binding, runtime: { node: process.version, browser: await browser.version(),
      playwright: (() => { try { return require('playwright/package.json').version; } catch { return require('playwright-core/package.json').version; } })(), renderer: 'headless Edge; --disable-accelerated-2d-canvas' },
      results, screenshots, external, errors, failures, unchangedAfterRun: true,
      status: failures.length ? 'FAIL' : 'PASS',
      limits: 'Synthetic local intercepted full Budget HTML. Unknown hatch also exercised as an explicit CSS control. No original report screenshot, signed-in/live site, provider or physical-device proof.' };
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ status: receipt.status, cases: results.length, failures, external, errors }));
    process.exitCode = failures.length ? 1 : 0;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
