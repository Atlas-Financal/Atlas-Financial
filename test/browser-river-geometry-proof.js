'use strict';
// Executable browser proof for the owner-approved shorter Budget timeline
// tile (Atlas decision + hold lift, Slack thread 1791643517.522249, 2026-10-10;
// Systems Review 5479984271 required this proof to be committed and re-runnable).
//
// Run from a clean checkout of the head under test:
//   CHROME_PATH=<chromium> [PROOF_OUTPUT_DIR=<outside checkout>] node test/browser-river-geometry-proof.js
// (playwright or playwright-core must be resolvable.)
//
// Synthetic timelines only. The script binds the exercised sources to the
// checkout's Git blobs (test/proof-source-binding.js), asserts the approved
// geometry (123px desktop / 114px mobile, balanced band insets, unchanged
// value domain), captures the after-state screenshots, and writes a receipt
// with source bindings, runtime, per-case results and screenshot hashes to
// docs/proof/browser/timeline-geometry-receipt.json. The before-state set was
// captured against the pre-change geometry and is recorded in
// docs/proof/browser/timeline-geometry-before.json.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { captureSourceBinding, verifySourceBinding } = require('./proof-source-binding');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }

const root = path.join(__dirname, '..');
const outDir = process.env.PROOF_OUTPUT_DIR ? path.resolve(process.env.PROOF_OUTPUT_DIR) : path.join(root, 'docs/proof/browser');
if (process.env.PROOF_OUTPUT_DIR) assert.ok(path.isAbsolute(process.env.PROOF_OUTPUT_DIR)
  && !outDir.startsWith(root + path.sep), 'Requested external evidence stays outside the checkout.');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const BOUND_SOURCES = [
  'public/app.js', 'public/budget-river.js', 'public/budget-gface.css', 'public/budget-blend.css',
  'public/styles.css', 'public/fonts.css',
  'test/browser-river-geometry-proof.js', 'test/proof-source-binding.js',
];

// Approved geometry: [form] -> tile height, band top inset, band bottom inset.
const SPEC = {
  desktop: { height: 123, top: 38, bottomInset: 51 },
  mobile: { height: 114, top: 36, bottomInset: 49 },
};
const PILL_BOTTOM = 31;           // pill top 7 + height 24
const VALS_TOP_FROM_BOTTOM = 44;  // vals bottom 28 + height 16

const SCENARIOS = {
  positive: { bads: [400, 850, 1200, 300, 950, 2100, 600, 1500, 750, 1100, 500, 900] },
  negative: { bads: [300, -420, 150, -80, 640, -260, 90, 480, -150, 720, 210, -40] },
  gap: { bads: [500, 700, null, null, null, 900, 1100, 650, 800, 450, 950, 1050], known: [[0, 1], [5, 6, 7, 8, 9, 10, 11]] },
  pan: { bads: [200, 1450, 350, 1250, 500, 1600, 275, 1350, 625, 1150, 425, 1550] },
};

// In-page controller setup. Serialized into the page via toString(), so it
// must only reference window.__SCENARIOS and page globals.
const scenarioInit = (key, index, reduce) => {
  const s = window.__SCENARIOS[key];
  const periods = s.bads.map((bad, i) => ({
    start: '2026-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '15' : '01'),
    end: '2026-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '28' : '14'),
    bad, state: bad == null ? 'unknown' : bad < 0 ? 'short' : 'healthy',
    role: i < 4 ? 'past' : i === 4 ? 'current' : 'future',
  }));
  const knownRuns = s.known || [periods.map((_, i) => i)];
  const changes = [];
  // Mirrors the shipped formatter (budget-blend.js compactRiverAmount): a
  // non-finite (unknown) value renders as '—', never as a number.
  const fmt = v => { if (!Number.isFinite(v)) return '—'; const a = Math.abs(v), sign = v < 0 ? (s.asciiMinus ? '-' : '−') : ''; return a >= 999.5 ? sign + '$' + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : sign + '$' + Math.round(a); };
  const el = document.querySelector('.river');
  const river = BudgetRiver.create({
    el, canvas: el.querySelector('canvas'), playhead: el.querySelector('.playhead'),
    pill: el.querySelector('.playhead-pill'), slide: el.querySelector('.river-slide'),
    monthsEl: el.querySelector('.months'), valsEl: el.querySelector('.river-vals'),
    periods, index, cur: index, reduce: !!reduce, noIntro: true, fmt, knownRuns,
    enabled: true, dark: document.documentElement.dataset.theme === 'dark',
    onChange: (i, how) => changes.push({ i, how }),
  });
  window.__river = river; window.__changes = changes; window.__periods = periods;
  river.place(index); river.draw(1500, index);
  return river;
};
const SCENARIO_INIT = 'window.__SCENARIOS = ' + JSON.stringify(SCENARIOS)
  + ';\nwindow.__scenarioInit = ' + scenarioInit.toString() + ';';

const pageHtml = (theme, narrowWrapper) => '<!doctype html><html data-theme="' + theme + '"><head><meta charset="utf-8">'
  + '<link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css">'
  + '<link rel="stylesheet" href="/budget-blend.css"><link rel="stylesheet" href="/budget-gface.css">'
  + '<style>body{margin:0}main{padding:12px}</style></head>'
  + '<body><main>' + (narrowWrapper ? '<div style="width:500px">' : '')
  + '<section class="budget-bento atlas-g"><div class="g-river-wrap"><nav class="tile t-river" aria-label="Timeline proof"><div class="river" tabindex="0" role="slider" aria-label="Timeline proof" aria-valuemin="0" aria-valuemax="11" aria-valuenow="0" aria-valuetext=""><canvas class="river-canvas"></canvas><div class="river-slide"><div class="river-vals"></div><div class="months"></div></div><div class="playhead"><div class="playhead-pill"><span>Period</span><b>$0.00</b></div><span class="playhead-beam"></span><span class="playhead-orb"></span></div></div></nav></section>'
  + (narrowWrapper ? '</div>' : '') + '</main>'
  // index.html loads /app.js (escapeHtml and the other page helpers) before /budget-river.js.
  + '<script src="/app.js"></script><script src="/budget-river.js"></script></body></html>';

(async () => {
  assert.ok(process.env.CHROME_PATH, 'CHROME_PATH must name the Chromium executable.');
  const binding = captureSourceBinding(root, BOUND_SOURCES, process.env.PROOF_BASE_SHA || null);
  fs.mkdirSync(outDir, { recursive: true });
  const failures = [];
  const check = (cond, label) => { if (!cond) failures.push(label); return !!cond; };
  const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
  const cases = [];
  const shots = [];
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const runtime = { node: process.version, chromium: await browser.version() };
  try {
    const settleTile = async (page, label) => {
      // Opacity rounds to 1 before the finite entrance transform completes.
      // Await that transform rather than relaxing the exact geometry guards.
      await page.waitForFunction(() => {
        const tile = document.querySelector('.tile.t-river');
        return getComputedStyle(tile).opacity === '1' && tile.getAnimations()
          .filter(a => a.effect && Number.isFinite(a.effect.getTiming().iterations))
          .every(a => a.playState === 'finished');
      }, null, { timeout: 5000 }).catch(() => check(false, label + ': tile entrance never settled'));
    };
    const open = async (width, theme, { narrowWrapper = false, reduce = false } = {}) => {
      const page = await browser.newPage({
        viewport: { width, height: 500 }, colorScheme: theme,
        reducedMotion: reduce ? 'reduce' : 'no-preference',
      });
      page.on('pageerror', e => failures.push('pageerror: ' + e.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://proof.test') return route.abort();
        if (url.pathname === '/') return route.fulfill({ body: pageHtml(theme, narrowWrapper), contentType: 'text/html' });
        const file = path.join(root, 'public', url.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'font/woff2';
        return route.fulfill({ body: fs.readFileSync(file), contentType: type });
      });
      await page.goto('http://proof.test/?view=classic');
      await page.addScriptTag({ content: SCENARIO_INIT });
      await page.evaluate(() => document.fonts.ready);
      // The tile's entrance animation transforms it for ~1s; the controller
      // measures the tile box at layout time, so proof pages settle the
      // animation before any controller is created.
      await settleTile(page, 'page');
      return page;
    };
    const capture = async (page, name) => {
      await settleTile(page, 'capture ' + name);
      await page.locator('.tile.t-river').screenshot({ path: path.join(outDir, name), animations: 'disabled' });
      shots.push(name);
    };
    const readGeometry = page => page.evaluate(() => {
      const r = window.__river, tile = document.querySelector('.tile.t-river');
      const cs = getComputedStyle(tile);
      const orbEl = r.playhead.querySelector('.playhead-orb');
      const orb = orbEl.getBoundingClientRect();
      const pill = r.pill.getBoundingClientRect();
      const tileBox = tile.getBoundingClientRect();
      const selEl = r.valEls && r.valEls[r.index] ? r.valEls[r.index] : null;
      const sel = selEl ? selEl.getBoundingClientRect() : null;
      const orbRect = orb.width ? { left: orb.left - tileBox.left, right: orb.right - tileBox.left, top: orb.top - tileBox.top, bottom: orb.bottom - tileBox.top } : null;
      const label = sel ? { left: sel.left - tileBox.left, right: sel.right - tileBox.left, top: sel.top - tileBox.top, bottom: sel.bottom - tileBox.top, text: selEl.textContent } : null;
      const labelOrbDisjoint = orbRect && label
        ? orbRect.right <= label.left || label.right <= orbRect.left || orbRect.bottom <= label.top || label.bottom <= orbRect.top
        : null;
      // A visible (not yielded) neighbouring label must not mesh with the
      // selected label either; yielded labels carry inline opacity '0'.
      let neighborOverlap = null;
      if (sel && r.valEls) {
        neighborOverlap = false;
        r.valEls.forEach((el, k) => {
          if (k === r.index || el.style.opacity === '0') return;
          const b = el.getBoundingClientRect();
          if (b.left < sel.right && sel.left < b.right && b.top < sel.bottom && sel.top < b.bottom) neighborOverlap = true;
        });
      }
      const beam = getComputedStyle(r.playhead.querySelector('.playhead-beam'));
      const knownYs = r.ys.filter(y => y != null);
      return {
        tileHeight: parseFloat(cs.height), elW: r.W, elH: r.H, top: r.top, bot: r.bot,
        band: r.bot - r.top, beamTopVar: r.playhead.style.getPropertyValue('--beam-top'),
        beamTopCss: beam.top, beamBottomCss: beam.bottom, particles: r.parts.length,
        zeroY: r.y0, yOfMinBad: r.yOf(Math.min(...window.__periods.map(p => p.bad).filter(Number.isFinite))),
        panMode: r.pan, nullYs: r.ys.map((y, i) => y == null ? i : -1).filter(i => i >= 0),
        runCount: new Set(r.runIds.filter(id => id != null)).size,
        minY: Math.min(...knownYs), maxY: Math.max(...knownYs),
        index: r.index, reduced: r.reduce, settled: r.head.settled,
        ariaNow: r.el.getAttribute('aria-valuenow'),
        runIds: r.runIds.slice(),
        orb: { cx: orb.left + orb.width / 2 - tileBox.left, cy: orb.top + orb.height / 2 - tileBox.top, w: orb.width, h: orb.height },
        orbRect, label, labelOrbDisjoint, neighborOverlap,
        pill: { top: pill.top - tileBox.top, bottom: pill.bottom - tileBox.top },
      };
    });
    const assertBand = (g, form, label) => {
      const spec = SPEC[form];
      check(near(g.tileHeight, spec.height, 0.1), label + ': tile height ' + g.tileHeight + ' != ' + spec.height);
      check(near(g.top, spec.top, 0.1), label + ': band top ' + g.top + ' != ' + spec.top);
      check(near(g.bot, spec.height - spec.bottomInset, 0.1), label + ': band bottom ' + g.bot + ' != ' + (spec.height - spec.bottomInset));
      check(near(g.top - PILL_BOTTOM, (spec.height - VALS_TOP_FROM_BOTTOM) - g.bot, 0.1),
        label + ': clearances not balanced (' + (g.top - PILL_BOTTOM) + ' vs ' + ((spec.height - VALS_TOP_FROM_BOTTOM) - g.bot) + ')');
      check(g.beamTopVar === '30px' && g.beamTopCss === '30px' && g.beamBottomCss === '51px',
        label + ': beam offsets ' + g.beamTopVar + '/' + g.beamTopCss + '/' + g.beamBottomCss);
      check(near(g.minY, g.top, 0.6) && near(g.maxY, g.yOfMinBad, 0.6), label + ': known extremes do not map to the band/domain edges (minY ' + g.minY + ' vs top ' + g.top + '; maxY ' + g.maxY + ' vs yOf(min) ' + g.yOfMinBad + ')');
    };

    // 1) Geometry + screenshot matrix.
    for (const key of Object.keys(SCENARIOS)) {
      for (const width of [1280, 390, 320]) for (const theme of ['dark', 'light']) {
        const form = width > 759 ? 'desktop' : 'mobile';
        const page = await open(width, theme);
        await page.evaluate(([k]) => window.__scenarioInit(k, 2, false), [key]);
        const g = await readGeometry(page);
        const label = key + '/' + width + '/' + theme;
        assertBand(g, form, label);
        if (g.labelOrbDisjoint != null) check(g.labelOrbDisjoint, label + ': selected label overlaps the orb (orb ' + JSON.stringify(g.orbRect) + ', label ' + JSON.stringify(g.label) + ')');
        if (g.neighborOverlap != null) check(g.neighborOverlap === false, label + ': selected label meshes with a visible neighbouring label ' + JSON.stringify(g.label));
        if (key === 'negative') check(g.zeroY > g.top && g.zeroY < g.bot, label + ': mixed-sign zero line not strictly inside the band (' + g.zeroY + ')');
        if (key === 'positive') check(near(g.zeroY, g.bot, 0.6), label + ': all-positive zero line must sit at the band bottom edge (' + g.zeroY + ' vs ' + g.bot + ')');
        if (key === 'gap') {
          check(g.runCount === 2 && JSON.stringify(g.nullYs) === '[2,3,4]', label + ': gap run structure runs=' + g.runCount + ' nullYs=' + JSON.stringify(g.nullYs));
          check(JSON.stringify(g.runIds) === '[0,0,null,null,null,1,1,1,1,1,1,1]', label + ': known runs must cover indices 0-1 and 5-11 exactly, runIds=' + JSON.stringify(g.runIds));
          check(g.label && g.label.text === '—', label + ': unknown selected value must render as the river unknown glyph —, not a number (got ' + (g.label && g.label.text) + ')');
          await page.evaluate(() => { const r = window.__river; r.head.set(3); r.place(3); r.draw(1500, 3); });
          const hidden = await page.evaluate(() => ({
            orb: document.querySelector('.playhead-orb').hidden,
            beam: document.querySelector('.playhead-beam').hidden,
            orbDisplay: getComputedStyle(document.querySelector('.playhead-orb')).display,
            beamDisplay: getComputedStyle(document.querySelector('.playhead-beam')).display,
          }));
          check(hidden.orb === true && hidden.beam === true && hidden.orbDisplay === 'none' && hidden.beamDisplay === 'none', label + ': orb/beam not hidden over the gap ' + JSON.stringify(hidden));
          await page.evaluate(() => { const r = window.__river; r.head.set(2); r.place(2); r.draw(1500, 2); });
        }
        if (key === 'pan') check(g.panMode === (width <= 390), label + ': pan mode ' + g.panMode + ' at element width ' + g.elW);
        cases.push({ scenario: key, width, theme, ...g });
        await capture(page, 'after-' + key + '-' + width + '-' + theme + '.png');
        await page.close();
      }
    }

    // 2) Selected minima/maxima visual proof: the 20px orb centred on a band
    // extreme extends past the 5-7px centreline clearances; these captures are
    // the visual evidence that the pill and value labels stay unobstructed.
    const extremes = [];
    for (const [key, index, kind, viewports] of [
      ['positive', 5, 'max', [[1280, 'dark'], [1280, 'light'], [390, 'dark']]],
      ['negative', 1, 'min', [[1280, 'dark'], [1280, 'light'], [390, 'dark'], [390, 'light'], [320, 'dark'], [320, 'light']]],
    ]) {
      for (const [width, theme] of viewports) {
        const page = await open(width, theme);
        await page.evaluate(([k, i]) => window.__scenarioInit(k, i, false), [key, index]);
        const g = await readGeometry(page);
        const label = 'selected-' + kind + '/' + key + '/' + width + '/' + theme;
        check(near(g.orb.cy, kind === 'max' ? g.top : g.bot, 0.6), label + ': orb centre ' + g.orb.cy + ' not on the band ' + kind + ' edge');
        check(g.orb.w === 20 && g.orb.h === 20, label + ': orb size ' + g.orb.w + 'x' + g.orb.h);
        check(g.labelOrbDisjoint === true, label + ': selected label overlaps the orb (orb ' + JSON.stringify(g.orbRect) + ', label ' + JSON.stringify(g.label) + ')');
        check(g.neighborOverlap === false, label + ': selected label meshes with a visible neighbouring label ' + JSON.stringify(g.label));
        extremes.push({ kind, scenario: key, index, width, theme, orb: g.orb, orbRect: g.orbRect, label: g.label, labelOrbDisjoint: g.labelOrbDisjoint, neighborOverlap: g.neighborOverlap, pill: g.pill, bandTop: g.top, bandBot: g.bot, tileHeight: g.tileHeight });
        await capture(page, 'after-selected-' + kind + '-' + width + '-' + theme + '.png');
        await page.close();
      }
    }

    // A bottom-band selected value must not erase either adjacent period's
    // otherwise visible target. Measure real paint and send browser pointer
    // events across the text, rather than using hitIndex as the oracle.
    const adjacentTargets = [];
    for (const width of [320, 390, 1280]) for (const theme of ['dark', 'light']) {
      const page = await open(width, theme, { reduce: true });
      await page.evaluate(() => window.__scenarioInit('negative', 1, true));
      await page.waitForTimeout(350); // settle the existing opacity transition
      const before = await page.evaluate(() => {
        const r = window.__river, bounds = r.el.getBoundingClientRect();
        return { index: r.index, pitch: r.sp, input: JSON.stringify(window.__periods),
          geometry: JSON.stringify({ xs: r.xs, ys: r.ys, top: r.top, bot: r.bot, W: r.W, H: r.H }),
          labels: r.valEls.map((el, i) => {
            const b = el.getBoundingClientRect(), style = getComputedStyle(el);
            return { i, text: el.textContent, title: el.title, state: el.dataset.state,
              native: el.dataset.riverNativeValue || null, estimated: el.classList.contains('is-est'),
              left: b.left - bounds.left, right: b.right - bounds.left,
              opacity: Number(style.opacity), visibility: style.visibility };
          }) };
      });
      const label = 'bottom-band-targets/' + width + '/' + theme;
      for (const i of [0, 1, 2]) {
        const value = before.labels[i];
        check(value.visibility !== 'hidden' && value.opacity > 0,
          label + ': period ' + i + ' label must remain visible ' + JSON.stringify(value));
        check(value.left >= 0 && value.right <= width - 24,
          label + ': period ' + i + ' label is clipped ' + JSON.stringify(value));
      }
      const geometry = await readGeometry(page);
      check(geometry.labelOrbDisjoint && !geometry.neighborOverlap, label + ': labels remain disjoint from orb and neighbors');
      const clearOtherText = await page.evaluate(() => {
        const r = window.__river, selected = r.valEls[r.index].getBoundingClientRect();
        return [r.pill, ...r.monthsEl.children].filter(el => getComputedStyle(el).visibility !== 'hidden').every(el => {
          const b = el.getBoundingClientRect();
          return selected.right <= b.left || b.right <= selected.left || selected.bottom <= b.top || b.bottom <= selected.top;
        });
      });
      check(clearOtherText, label + ': selected value stays clear of pill and month text');
      await capture(page, 'after-bottom-targets-' + width + '-' + theme + '.png');
      const clicks = [];
      for (const target of [0, 1, 2]) for (const fraction of [0.1, 0.5, 0.9]) {
        const point = await page.evaluate(([target, fraction]) => {
          const r = window.__river;
          r.go(1, true); r.place(1); r.draw(1500, 1); window.__changes.length = 0;
          const b = r.valEls[target].getBoundingClientRect();
          return { x: b.left + b.width * fraction, y: b.top + b.height / 2 };
        }, [target, fraction]);
        await page.mouse.click(point.x, point.y);
        const result = await page.evaluate(() => ({ index: window.__river.index, changes: window.__changes.slice() }));
        check(result.index === target && result.changes.length === 1
          && result.changes[0].i === target && result.changes[0].how === 'commit',
          label + ': click ' + target + '/' + fraction + ' selects its own period ' + JSON.stringify(result));
        clicks.push({ target, fraction, ...point, ...result });
      }
      const after = await page.evaluate(() => {
        const r = window.__river;
        return { input: JSON.stringify(window.__periods),
          geometry: JSON.stringify({ xs: r.xs, ys: r.ys, top: r.top, bot: r.bot, W: r.W, H: r.H }),
          labels: r.valEls.map(el => ({ text: el.textContent, title: el.title, state: el.dataset.state,
            native: el.dataset.riverNativeValue || null, estimated: el.classList.contains('is-est') })) };
      });
      check(before.input === after.input && before.geometry === after.geometry,
        label + ': source inputs, curve geometry and domain stay unchanged');
      check(JSON.stringify(before.labels.map(({ text, title, state, native, estimated }) => ({ text, title, state, native, estimated })))
        === JSON.stringify(after.labels), label + ': signs, publication text and qualifiers stay unchanged');
      adjacentTargets.push({ width, theme, before, clicks });
      await page.close();
    }

    // Wide selected text keeps the existing horizontal displacement/hit box.
    // Pin the independently measured base click results, including its right
    // edge's existing nearest-period result; do not change selection semantics.
    const wideSelected = [];
    for (const width of [320, 390]) for (const theme of ['dark', 'light']) {
      const page = await open(width, theme, { reduce: true });
      await page.evaluate(() => {
        window.__SCENARIOS.wideSelected = {
          bads: [1, -1234567, 1, -80, 640, -260, 90, 480, -150, 720, 210, -40], asciiMinus: true,
        };
        window.__scenarioInit('wideSelected', 1, true);
      });
      await page.waitForTimeout(350);
      const label = 'wide-selected/' + width + '/' + theme;
      const before = await page.evaluate(() => {
        const r = window.__river, el = r.valEls[1], b = el.getBoundingClientRect();
        return { text: el.textContent, width: b.width, spacing: r.sp, transform: el.style.transform,
          stepBox: r._stepBox, input: JSON.stringify(window.__periods) };
      });
      check(before.text === '-$1234.6k' && before.width > before.spacing,
        label + ': fixture exercises selected text wider than its period');
      check(before.stepBox?.i === 1 && !before.transform.includes('translateY'),
        label + ': wide selected text retains its horizontal hit box ' + JSON.stringify(before));
      const clicks = [];
      for (const [fraction, expected] of [[0.1, 1], [0.5, 1], [0.9, 2]]) {
        const point = await page.evaluate(fraction => {
          const r = window.__river;
          r.go(1, true); r.place(1); r.draw(1500, 1); window.__changes.length = 0;
          const b = r.valEls[1].getBoundingClientRect();
          return { x: b.left + b.width * fraction, y: b.top + b.height / 2 };
        }, fraction);
        await page.mouse.click(point.x, point.y);
        const result = await page.evaluate(() => ({ index: window.__river.index, changes: window.__changes.slice(),
          input: JSON.stringify(window.__periods) }));
        check(result.index === expected && result.changes.length === 1
          && result.changes[0].i === expected && result.changes[0].how === 'commit',
          label + ': click ' + fraction + ' preserves base period ' + expected + ' ' + JSON.stringify(result));
        check(result.input === before.input, label + ': native publications stay unchanged');
        clicks.push({ fraction, expected, ...point, ...result });
      }
      wideSelected.push({ width, theme, before, clicks });
      await page.close();
    }

    // 3) Held-drag visual proof: mid-gesture captures with the drag state live.
    const heldDrag = [];
    for (const width of [1280, 390]) {
      const page = await open(width, 'dark');
      await page.evaluate(() => window.__scenarioInit('positive', 2, false));
      const box = await page.evaluate(() => {
        const r = window.__river, b = r.el.getBoundingClientRect();
        return { x: b.left + r.xc(r.index), y: b.top + r.yAt(window.__periods[r.index].bad), sp: r.sp };
      });
      await page.mouse.move(box.x, box.y); await page.mouse.down();
      await page.mouse.move(box.x + box.sp * 0.55, box.y, { steps: 10 });
      await page.waitForTimeout(200);
      const mid = await page.evaluate(() => ({
        dragging: window.__river.el.classList.contains('is-dragging'),
        orbTransform: getComputedStyle(document.querySelector('.playhead-orb')).transform,
        changes: window.__changes.slice(),
      }));
      check(mid.dragging, 'held-drag/' + width + ': tile not in drag state mid-gesture');
      check(mid.changes.length > 0 && mid.changes.every(c => c.how === 'scrub'), 'held-drag/' + width + ': no live scrub publications ' + JSON.stringify(mid.changes));
      heldDrag.push({ width, ...mid });
      await capture(page, 'after-held-drag-' + width + '-dark.png');
      await page.mouse.up();
      await page.close();
    }

    // 4) Breakpoint divergence: the JS form factor reads the ELEMENT width
    // (<640); the CSS height reads the VIEWPORT width (<=759). Both mixed
    // combinations must stay internally consistent.
    const divergence = [];
    {
      const page = await open(700, 'dark'); // viewport <=759 -> CSS mobile height; element 676 >= 640 -> JS desktop insets
      await page.evaluate(() => window.__scenarioInit('positive', 2, false));
      const g = await readGeometry(page);
      check(near(g.tileHeight, SPEC.mobile.height, 0.1) && near(g.top, SPEC.desktop.top, 0.1) && near(g.bot, SPEC.mobile.height - SPEC.desktop.bottomInset, 0.1),
        'divergence/viewport700: H=' + g.tileHeight + ' top=' + g.top + ' bot=' + g.bot);
      check(near(g.top - PILL_BOTTOM, (SPEC.mobile.height - VALS_TOP_FROM_BOTTOM) - g.bot, 0.1), 'divergence/viewport700: clearances not balanced');
      divergence.push({ case: 'viewport-700-full-width', ...g });
      await capture(page, 'after-breakpoint-700-dark.png');
      await page.close();
    }
    {
      const page = await open(800, 'dark', { narrowWrapper: true }); // viewport >759 -> CSS desktop height; element 500 < 640 -> JS mobile insets
      await page.evaluate(() => window.__scenarioInit('positive', 2, false));
      const g = await readGeometry(page);
      check(near(g.tileHeight, SPEC.desktop.height, 0.1) && near(g.top, SPEC.mobile.top, 0.1) && near(g.bot, SPEC.desktop.height - SPEC.mobile.bottomInset, 0.1),
        'divergence/viewport800-narrow: H=' + g.tileHeight + ' top=' + g.top + ' bot=' + g.bot);
      check(near(g.top - PILL_BOTTOM, (SPEC.desktop.height - VALS_TOP_FROM_BOTTOM) - g.bot, 0.1), 'divergence/viewport800-narrow: clearances not balanced');
      divergence.push({ case: 'viewport-800-tile-500', ...g });
      await capture(page, 'after-breakpoint-narrow800-dark.png');
      await page.close();
    }

    // 5) Resize transitions across both breakpoints keep geometry + selection.
    const transitions = [];
    {
      const page = await open(1280, 'dark');
      await page.evaluate(() => window.__scenarioInit('positive', 3, false));
      for (const [width, height, top, bottomInset] of [
        [1280, 123, 38, 51], [700, 114, 38, 51], [664, 114, 38, 51], [663, 114, 36, 49],
        [390, 114, 36, 49], [760, 123, 38, 51], [1280, 123, 38, 51],
      ]) {
        await page.setViewportSize({ width, height: 500 });
        await page.waitForTimeout(200);
        const g = await readGeometry(page);
        check(near(g.tileHeight, height, 0.1) && near(g.top, top, 0.1) && near(g.bot, height - bottomInset, 0.1) && g.index === 3,
          'transition/to-' + width + ': H=' + g.tileHeight + ' top=' + g.top + ' bot=' + g.bot + ' index=' + g.index);
        transitions.push({ width, tileHeight: g.tileHeight, top: g.top, bot: g.bot, index: g.index });
      }
      await page.close();
    }

    // 6) Behaviour: live drag publication, keyboard traversal, remount
    // continuity, reduced-motion rendering.
    const behavior = {};
    {
      const page = await open(1280, 'dark');
      await page.evaluate(() => window.__scenarioInit('positive', 2, false));
      const box = await page.evaluate(() => {
        const r = window.__river, b = r.el.getBoundingClientRect();
        return { x: b.left + r.xc(r.index), y: b.top + r.yAt(window.__periods[r.index].bad), sp: r.sp };
      });
      await page.mouse.move(box.x, box.y); await page.mouse.down();
      await page.mouse.move(box.x + box.sp, box.y, { steps: 6 });
      const during = await page.evaluate(() => ({ changes: window.__changes.slice(), index: window.__river.index, dragging: window.__river.el.classList.contains('is-dragging') }));
      await page.mouse.up();
      behavior.dragScrub = during;
      check(during.dragging && during.changes.length > 0 && during.changes.every(c => c.how === 'scrub') && during.index === 3,
        'behaviour: drag scrub did not publish live selection ' + JSON.stringify(during));

      // Keyboard is measured as a delta from wherever the drag's own fling
      // settled — that resting index is the frozen gesture behaviour, not
      // something this proof pins.
      await page.waitForTimeout(700);
      const beforeKeys = await page.evaluate(() => window.__river.index);
      await page.evaluate(() => { window.__river.el.focus(); });
      for (let n = 0; n < 3; n++) await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowLeft');
      const keys = await page.evaluate(() => ({ index: window.__river.index, aria: window.__river.el.getAttribute('aria-valuenow'), changes: window.__changes.slice(-4) }));
      behavior.keyboard = { beforeKeys, ...keys };
      check(keys.index === beforeKeys + 2 && keys.changes.length === 4 && keys.changes.every(c => c.how === 'commit')
        && JSON.stringify(keys.changes.map(c => c.i)) === JSON.stringify([beforeKeys + 1, beforeKeys + 2, beforeKeys + 3, beforeKeys + 2]),
        'behaviour: keyboard traversal ' + JSON.stringify(keys));

      const beforeRemount = await readGeometry(page);
      await page.evaluate(() => {
        const r = window.__river;
        window.__river2 = BudgetRiver.create({
          el: r.el, canvas: r.canvas, playhead: r.playhead, pill: r.pill, slide: r.slide,
          monthsEl: r.monthsEl, valsEl: r.valsEl, periods: window.__periods, index: r.index, cur: r.index,
          reduce: r.reduce, noIntro: true, fmt: r.fmt, knownRuns: r.knownRuns, enabled: true,
          dark: true, onChange: (i, how) => window.__changes.push({ i, how }),
        });
        window.__river2.adopt(r);
      });
      const afterRemount = await page.evaluate(() => {
        const r = window.__river2;
        return { H: r.H, top: r.top, bot: r.bot, index: r.index };
      });
      behavior.remount = { before: { H: beforeRemount.elH, top: beforeRemount.top, bot: beforeRemount.bot, index: beforeRemount.index }, after: afterRemount };
      check(afterRemount.H === beforeRemount.elH && afterRemount.top === beforeRemount.top && afterRemount.bot === beforeRemount.bot && afterRemount.index === beforeRemount.index,
        'behaviour: remount continuity ' + JSON.stringify(behavior.remount));
      await page.close();
    }
    {
      const page = await open(390, 'dark', { reduce: true });
      await page.evaluate(() => window.__scenarioInit('negative', 4, true));
      const g = await readGeometry(page);
      behavior.reducedMotion = g;
      check(g.reduced === true && g.settled === true && near(g.tileHeight, 114, 0.1) && near(g.top, 36, 0.1),
        'behaviour: reduced-motion render ' + JSON.stringify(g));
      await capture(page, 'after-reduced-motion-390-dark.png');
      await page.close();
    }

    // Receipt + report.
    verifySourceBinding(root, binding);
    fs.writeFileSync(path.join(outDir, 'timeline-geometry-after.json'), JSON.stringify({ cases, extremes, adjacentTargets, wideSelected, heldDrag, divergence, transitions }, null, 2));
    const receipt = {
      proof: 'timeline-geometry',
      syntheticOnly: true,
      runtime,
      sourceBinding: { ...binding, unchangedAfterProof: true },
      geometrySpec: { ...SPEC, pillBottomEdge: PILL_BOTTOM, valsTopEdgeFromBottom: VALS_TOP_FROM_BOTTOM, beamTop: 30, beamBottomInset: 51 },
      caseCount: cases.length,
      extremes,
      adjacentTargets,
      wideSelected,
      behavior,
      screenshotSha256: Object.fromEntries(shots.map(name => [name, sha256(path.join(outDir, name))])),
      failures,
    };
    fs.writeFileSync(path.join(outDir, 'timeline-geometry-receipt.json'), JSON.stringify(receipt, null, 2));
    if (failures.length) { console.error('FAILURES:\n' + failures.join('\n')); process.exit(1); }
    console.log('PASS timeline geometry proof: ' + cases.length + ' geometry cases, ' + extremes.length + ' selected-extreme captures, '
      + heldDrag.length + ' held-drag captures, ' + divergence.length + ' breakpoint-divergence cases, ' + transitions.length
      + ' resize transitions; ' + shots.length + ' screenshots; sources unchanged after proof.');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
