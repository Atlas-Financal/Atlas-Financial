'use strict';
// Native viewport proof using invented served-plan fixtures plus explicitly
// identified river-component publication controls. No signed-in browser, live
// data, provider request, financial arithmetic or device/zoom acceptance.
// NODE_PATH=<external modules> CHROME_PATH=<Edge/Chromium> PROOF_OUTPUT_DIR=<outside repo>
// [PROOF_BASELINE=<before receipt>] [RIVER_PORT_PROOF=1] node test/browser-budget-river-readability.js
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
let chromium;
let playwrightPackage = 'playwright/package.json'; // the receipt names the version of the module that actually loaded
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); playwrightPackage = 'playwright-core/package.json'; }
const { captureSourceBinding, verifySourceBinding } = require('./proof-source-binding');
const { proveRiverPort, riverHarnessHtml } = require('./browser-budget-river-port');
const fixture = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..'), out = process.env.PROOF_OUTPUT_DIR;
assert.ok(out && path.isAbsolute(out) && !path.resolve(out).startsWith(root + path.sep), 'Evidence stays outside checkout');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const diagnosticNumber = (_key, value) => typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(6)) : value;
const source = fs.readFileSync(path.join(root, 'public/budget-river.js'), 'utf8');
const section = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'Frozen source section found: ' + start); return hash(source.slice(a, b)); };
const frozen = {
  spring: section('  class Spring {', '  const clamp'),
  lifecycle: section('    init(o) {', '    layout() {'),
  geometryAndCurve: section('    layout() {', '    labels() {'),
  coordinateAndHitMapping: section('    xc(f)', '    bind() {'),
  input: section('    bind() {', '    hoverVal()'),
  selection: section('    go(i, instant)', '    place(f) {'),
  frameAndPaint: section('    frame(dt, t)', '  const api ='),
};
const invented = key => {
  const data = fixture.served();
  if (key !== 'january-negative') return data;
  const shifted = JSON.parse(JSON.stringify(data).replace(/\d{4}-\d{2}-\d{2}/g,
    s => new Date(Date.parse(s + 'T00:00:00Z') + 140 * 86400000).toISOString().slice(0, 10)));
  shifted.plan.bills.push({ id: 'synthetic-levy', label: 'Synthetic levy', frequency: 'monthly',
    day: 3, amount: 1234567.89, confidence: 'confirmed', payingAccount: 'chequing-a' });
  return shifted;
};
// Already published component records, not injected Forecast input or a second
// financial formatter. These expose selected edge clipping independent of the
// native integration's incomplete historical coverage.
const COMPONENT = [
  { bad: -1234567.89, compact: '-$1234.6k', label: '-$1,234,567.89' },
  { bad: -5000000.01, compact: '-$5000k', label: '-$5,000,000.01' },
  { bad: 800, compact: '$800', label: '$800.00' },
  { bad: 0, compact: '$0', label: '$0.00' },
  { bad: 200, compact: '$200', label: '$200.00' },
  { bad: null, compact: '-', label: 'Unavailable' },
  { bad: null, compact: '-', label: 'Unavailable' },
  { bad: 700, compact: '$700', label: '$700.00' },
  { bad: 400, compact: '$400', label: '$400.00' },
  { bad: 1000, compact: '$1k', label: '$1,000.00' },
  { bad: -1250.01, compact: '-$1.3k', label: '-$1,250.01' },
  { bad: -1234567.89, compact: '-$1234.6k', label: '-$1,234,567.89' },
];

(async () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'public', 'scripts/*.js', 'test/fixtures',
    'test/browser-budget-river-readability.js', 'test/browser-budget-river-port.js',
    'test/browser-river-geometry-proof.js', 'test/proof-source-binding.js', 'package.json', 'package-lock.json'],
  { cwd: root }).toString().split('\0').filter(Boolean);
  const binding = captureSourceBinding(root, files);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true,
    args: ['--disable-accelerated-2d-canvas'] });
  const failures = [], errors = [], external = [], records = [], screenshots = {}, hatchCases = [];
  const check = (truth, message) => { if (!truth) failures.push(message); };
  const settle = async page => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => {
      const r = document.querySelector('.river'), selected = r?.querySelector('.rv.is-sel');
      if (!selected || r.dataset.riverMotion !== 'settled') return false;
      const offset = new DOMMatrixReadOnly(getComputedStyle(r.querySelector('.river-slide')).transform).m41;
      const head = new DOMMatrixReadOnly(getComputedStyle(r.querySelector('.playhead')).transform).m41;
      return Math.abs(parseFloat(selected.style.left) + offset - head) < 0.15;
    });
    // Existing yielded neighbours fade via CSS after the spring has settled.
    // Capture their completed paint state without changing that transition.
    await page.waitForFunction(() => [...document.querySelectorAll('.river .rv')]
      .every(el => el.style.opacity !== '0' || Number(getComputedStyle(el).opacity) === 0));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  const open = async (width, theme, options = {}) => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1,
      colorScheme: theme, reducedMotion: options.reducedMotion || 'no-preference', hasTouch: !!options.hasTouch });
    await page.addInitScript(t => localStorage.setItem('hfd-theme', t), theme);
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
      if (u.pathname === '/' && options.riverHarness) return route.fulfill({ body: riverHarnessHtml(theme), contentType: 'text/html' });
      if (u.pathname === '/data.json') return route.fulfill({ json: options.data || fixture.served(options) });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
      const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const bytes = fs.readFileSync(file), key = path.relative(root, file).split(path.sep).join('/');
      assert.equal(hash(bytes), binding.files[key]?.sha256, 'Served bytes equal bound source: ' + key);
      return route.fulfill({ body: bytes, contentType: ({ '.css': 'text/css', '.js': 'application/javascript', '.woff2': 'font/woff2' })[path.extname(file)] || 'text/html' });
    });
    await page.goto('http://budget.test/?view=classic'); await page.evaluate(() => document.fonts.ready);
    if (!options.riverHarness) await page.waitForSelector('#operating-surface');
    return page;
  };
  const read = async page => {
    const result = await page.locator('.river').evaluate(el => {
      const tile = el.parentElement.getBoundingClientRect();
      const label = (node, type) => {
        const b = node.getBoundingClientRect(), s = getComputedStyle(node);
        const range = document.createRange(); range.selectNodeContents(node); const g = range.getBoundingClientRect();
        return { type, text: node.textContent, native: node.dataset.riverNativeValue || null,
          title: node.title, state: node.dataset.state || null, selected: node.classList.contains('is-sel'),
          estimated: node.classList.contains('is-est'), left: b.left - tile.left, right: b.right - tile.left,
          glyphLeft: g.left - tile.left, glyphRight: g.right - tile.left,
          visibility: s.visibility, opacity: Number(s.opacity), transform: node.style.transform };
      };
      const native = document.querySelector('ol[data-bad-timeline]');
      return { tile: { width: tile.width, height: tile.height },
        slider: Object.fromEntries(['role', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].map(k => [k, el.getAttribute(k)])),
        labels: [...el.querySelectorAll('.rv')].map(n => label(n, 'amount')),
        months: [...el.querySelectorAll('.months span')].map(n => label(n, 'month')),
        pill: el.querySelector('.playhead-pill').textContent,
        pillHtml: el.querySelector('.playhead-pill').innerHTML,
        slide: el.querySelector('.river-slide').style.transform,
        playhead: el.querySelector('.playhead').style.transform,
        nativeHtml: native?.outerHTML || null,
        selectedStart: document.querySelector('[data-budget-window-progress]')?.dataset.start || null,
        heroAmount: document.querySelector('.blend-hero .blend-bad')?.textContent || null,
        heroDollars: document.querySelector('.blend-hero .blend-dollars')?.textContent || null,
        heroCents: document.querySelector('.blend-hero .blend-cents')?.textContent || null,
        canvas: el.querySelector('canvas').toDataURL('image/png').split(',')[1],
        componentGeometry: window.__readabilityRiver ? { xs: __readabilityRiver.xs, ys: __readabilityRiver.ys,
          top: __readabilityRiver.top, bot: __readabilityRiver.bot, y0: __readabilityRiver.y0,
          sp: __readabilityRiver.sp, off: __readabilityRiver.off, pan: __readabilityRiver.pan,
          runIds: __readabilityRiver.runIds } : null };
    });
    result.canvasSha256 = hash(Buffer.from(result.canvas, 'base64')); delete result.canvas; return result;
  };
  const record = async (page, id, metadata, capture) => {
    await settle(page); const state = await read(page);
    const painted = [...state.labels, ...state.months].filter(x => x.visibility !== 'hidden' && x.opacity > 0);
    for (const item of painted) if (item.glyphRight > 0 && item.glyphLeft < state.tile.width)
      check(item.glyphLeft >= -0.1 && item.glyphRight <= state.tile.width + 0.1, id + ': painted ' + item.type + ' complete: ' + item.text);
    const amounts = painted.filter(x => x.type === 'amount' && x.glyphRight > 0 && x.glyphLeft < state.tile.width)
      .sort((a, b) => a.glyphLeft - b.glyphLeft);
    for (let i = 1; i < amounts.length; i++) check(amounts[i].glyphLeft >= amounts[i - 1].glyphRight - 0.1,
      id + ': painted amounts stay separate: ' + amounts[i - 1].text + ' / ' + amounts[i].text);
    const selected = state.labels.find(x => x.selected);
    check(!!selected && selected.visibility !== 'hidden' && selected.opacity > 0, id + ': selected amount is painted');
    check(selected.glyphLeft >= -0.1 && selected.glyphRight <= state.tile.width + 0.1, id + ': selected amount is complete');
    check(state.tile.height === (metadata.width < 760 ? 114 : 123), id + ': approved tile height');
    if (capture) { const file = id + '.png'; await page.locator('.t-river').screenshot({ path: path.join(out, file), animations: 'disabled' }); screenshots[file] = hash(fs.readFileSync(path.join(out, file))); }
    records.push({ id, ...metadata, ...state });
  };
  let incumbentPort = null;
  try {
    for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
      for (const fixtureKey of ['ordinary', 'january-negative']) {
        console.log('Native fixture ' + fixtureKey + '/' + width + '/' + theme);
        const page = await open(width, theme, { data: invented(fixtureKey), reducedMotion: 'reduce' });
        await page.waitForSelector('.river .rv.is-sel');
        for (const position of ['current', 'Home', 'End', 'Home-again']) {
          if (position !== 'current') { await page.locator('.river').focus(); await page.keyboard.press(position === 'Home-again' ? 'Home' : position); }
          const id = `native-${fixtureKey}-${width}-${theme}-${position}`;
          await record(page, id, { kind: 'native', fixtureKey, width, theme, position },
            fixtureKey === 'january-negative' && position !== 'Home-again' && (position === 'Home' || width === 320));
        }
        await page.close();
      }
      const page = await open(width, theme, { riverHarness: true, reducedMotion: 'reduce' });
      await page.evaluate(contracts => {
        document.body.innerHTML = '<main style="padding:12px"><section class="budget-bento atlas-g"><div class="g-river-wrap"><nav class="tile t-river"><div class="river" role="slider" tabindex="0"><canvas class="river-canvas"></canvas><div class="river-slide"><div class="river-vals"></div><div class="months"></div></div><div class="playhead"><div class="playhead-pill"><span>Period</span><b></b></div><span class="playhead-beam"></span><span class="playhead-orb"></span></div></div></nav></div></section></main>';
        const periods = contracts.map((p, i) => ({ ...p, start: '2027-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '15' : '01'),
          end: '2027-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '28' : '14'),
          state: p.bad == null ? 'unknown' : p.bad < 0 ? 'short' : 'healthy', role: i < 2 ? 'past' : i === 2 ? 'current' : 'future',
          fullLabel: p.label + ', synthetic publication ' + i }));
        const el = document.querySelector('.river');
        const publish = i => { el.setAttribute('aria-valuenow', String(i + 1)); el.setAttribute('aria-valuetext', periods[i].fullLabel);
          el.querySelector('.playhead-pill b').textContent = periods[i].label; };
        el.setAttribute('aria-valuemin', '1'); el.setAttribute('aria-valuemax', String(periods.length));
        window.__readabilityRiver = BudgetRiver.create({ el, canvas: el.querySelector('canvas'), playhead: el.querySelector('.playhead'),
          pill: el.querySelector('.playhead-pill'), slide: el.querySelector('.river-slide'), monthsEl: el.querySelector('.months'), valsEl: el.querySelector('.river-vals'),
          periods, knownRuns: [[0, 1, 2, 3, 4], [7, 8, 9, 10, 11]], index: 0, cur: 2, enabled: true,
          dark: document.documentElement.dataset.theme === 'dark', reduce: true, noIntro: true,
          fmt: (_value, i) => periods[i].compact, onChange: i => publish(i) }); publish(0);
      }, COMPONENT);
      for (const position of ['Home', 'End', 'Home-again']) {
        await page.locator('.river').focus(); await page.keyboard.press(position === 'Home-again' ? 'Home' : position);
        await record(page, `component-${width}-${theme}-${position}`, { kind: 'component-publication-control', width, theme, position }, width === 320 && position === 'Home');
      }
      await page.close();
    }
    // Native hatch diagnostic, not an invented hatch or a readability PASS:
    // inspect actual computed paint in five legitimate synthetic page states.
    for (const theme of ['dark', 'light']) for (const [key, options] of [
      ['ordinary', {}], ['zero-income', { zeroIncome: true }], ['no-scale', { zeroIncomeWithoutSpend: true }],
      ['unknown-savings', { withheldSavings: true }], ['unavailable', { unavailablePlan: true }],
    ]) {
      const page = await open(390, theme, { data: fixture.served(options), reducedMotion: 'reduce' });
      await page.waitForFunction(() => typeof App !== 'undefined' && App.data?.meta?.asOf);
      if (key !== 'unavailable') await page.waitForSelector('.river .rv.is-sel');
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const state = await page.evaluate(() => ({ river: !!document.querySelector('.river'),
        repeatedGradientPaint: [...document.querySelectorAll('#operating-surface *')].flatMap(el => {
          const b = el.getBoundingClientRect(); if (!b.width || !b.height) return [];
          return ['', '::before', '::after'].flatMap(pseudo => { const s = getComputedStyle(el, pseudo || null);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.backgroundImage.includes('repeating-linear')
              ? [{ className: typeof el.className === 'string' ? el.className : 'svg', pseudo, image: s.backgroundImage }] : []; });
        }) }));
      hatchCases.push({ key, theme, ...state }); await page.close();
    }
    if (process.env.RIVER_PORT_PROOF === '1') incumbentPort = await proveRiverPort({ open });
    if (process.env.PROOF_BASELINE) {
      const before = JSON.parse(fs.readFileSync(process.env.PROOF_BASELINE, 'utf8'));
      check(JSON.stringify(frozen) === JSON.stringify(before.frozen), 'Spring, lifecycle, geometry, curve, mapping, input, selection and canvas paint source unchanged');
      const stable = r => ({ id: r.id, slider: r.slider, tile: r.tile, pill: r.pill, pillHtml: r.pillHtml,
        labels: r.labels.map(x => ({ text: x.text, native: x.native, title: x.title, state: x.state, estimated: x.estimated, selected: x.selected })),
        months: r.months.map(x => x.text), slide: r.slide, playhead: r.playhead, nativeHtml: r.nativeHtml,
        selectedStart: r.selectedStart, heroAmount: r.heroAmount, heroDollars: r.heroDollars, heroCents: r.heroCents,
        canvasSha256: r.canvasSha256, componentGeometry: r.componentGeometry });
      check(JSON.stringify(records.map(stable), diagnosticNumber) === JSON.stringify(before.records.map(stable), diagnosticNumber), 'Native dates, amounts/signs/cents, labels, unknown states, selection, diagnostic geometry and exact canvas pixels unchanged');
      check(JSON.stringify(hatchCases) === JSON.stringify(before.hatchCases), 'Hatch/unknown paint diagnostic unchanged');
      if (incumbentPort && before.incumbentPort) check(Object.keys(incumbentPort).every(key => incumbentPort[key].length === before.incumbentPort[key].length), 'All incumbent native drag/cancel/reselect/touch/fling/prototype case counts unchanged; original strict assertions execute in both phases');
    }
    check(errors.length === 0 && external.length === 0, 'No page errors or external requests');
    verifySourceBinding(root, binding);
    const receipt = { binding, frozen, status: failures.length ? 'FAIL' : 'PASS', failures, records, hatchCases, incumbentPort,
      screenshots, errors, external, runtime: { node: process.version, browser: await browser.version(), playwright: require(playwrightPackage).version, scale: 1, renderer: 'headless Edge; --disable-accelerated-2d-canvas' },
      measurementPrecision: 'Diagnostic numbers stored at six decimal places; assertions use unrounded measurements. Monetary strings, bindings and PNG bytes stay exact.',
      limits: 'Native synthetic local App/Forecast plus declared component publication controls; no authenticated production tab or physical-device acceptance. No hatch repair claimed when no native hatch paint is reproduced.' };
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, diagnosticNumber, 2) + '\n');
    console.log(JSON.stringify({ status: receipt.status, cases: records.length, nativeCases: records.filter(x => x.kind === 'native').length,
      componentCases: records.filter(x => x.kind !== 'native').length, hatchCases: hatchCases.length, incumbentPort: !!incumbentPort, failures, errors, external }));
    process.exitCode = failures.length ? 1 : 0;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
