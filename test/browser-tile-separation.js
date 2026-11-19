'use strict';
// Fixture-only browser proof for mobile tile separation (UI task 1).
// No live site, no provider, no money arithmetic: the board renders from
// the synthetic budget-surface fixture, exactly as in
// test/browser-budget-blend-proof.js, and only presentation facts are
// read back — the computed background of .blend-board, the hero tile's
// glass / border / shadow / radius and the board gap (18px when this
// proof was written for #572; the 2026-10-11 tile-spacing amendment
// repins it to 9px at <=759px and keeps 18px on desktop), and
// rendered pixels in a tile gap and a tile corner cutout versus the
// page margin. The hero is the only tile whose computed style is
// sampled; the amendment additionally measures every stacked tile's
// box geometry (rendered gaps, horizontal overflow, clipping).
//
// CHROME_PATH=<Chromium> node test/browser-tile-separation.js --label before
// CHROME_PATH=<Chromium> node test/browser-tile-separation.js --label=after
//
// Both "--label before" and "--label=before" forms are accepted.
// Arguments are parsed strictly: a missing, misspelled, duplicated, or
// unrecognized argument fails loudly before anything runs, so a proof
// can never silently execute under the wrong label. Optional
// --source-head <sha> / --source-tree <sha> record the source the run
// claims to test; when given, the script asserts the checkout's tree
// equals the claimed tree before stamping the run into report.json.
//
// "before" asserts the baseline (board paints its flat --blend-bg at
// every sampled width). "after" asserts the agreed outcome: at
// <= 759px the board background is transparent in both themes so the
// page background shows through the gaps and corner cutouts, while at
// desktop width the board background and the hero tile's measured
// facts are unchanged from "before". The "after" run also computes
// the before/after pixel diff and a same-tree rerun noise control,
// and stamps report.json "bindings" (source head/tree, fixture and
// script hashes, runtime, PNG hashes) so the committed report is
// reproducible from this script plus the fixture alone.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const USAGE = 'usage: CHROME_PATH=<Chromium> node test/browser-tile-separation.js '
  + '--label before|after [--source-head <sha> --source-tree <sha>]';

function fail(message) {
  console.error(`browser-tile-separation: ${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const parsed = { label: null, sourceHead: null, sourceTree: null };
  const keys = { '--label': 'label', '--source-head': 'sourceHead', '--source-tree': 'sourceTree' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let name = null;
    let value = null;
    for (const candidate of Object.keys(keys)) {
      if (arg === candidate) {
        name = candidate;
        if (i + 1 >= argv.length) fail(`${candidate} needs a value`);
        value = argv[++i];
        break;
      }
      if (arg.startsWith(candidate + '=')) {
        name = candidate;
        value = arg.slice(candidate.length + 1);
        break;
      }
    }
    if (name === null) fail(`unrecognized argument: ${arg}`);
    const key = keys[name];
    if (parsed[key] !== null) fail(`${name} given twice`);
    parsed[key] = value;
  }
  if (parsed.label === null) fail('--label is required (before|after)');
  if (parsed.label !== 'before' && parsed.label !== 'after') {
    fail(`--label must be before or after, got ${JSON.stringify(parsed.label)}`);
  }
  if ((parsed.sourceHead === null) !== (parsed.sourceTree === null)) {
    fail('--source-head and --source-tree must be given together');
  }
  for (const key of ['sourceHead', 'sourceTree']) {
    if (parsed[key] !== null && !/^[0-9a-f]{40}$/.test(parsed[key])) {
      fail(`--${key === 'sourceHead' ? 'source-head' : 'source-tree'} must be a full 40-hex SHA`);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const label = args.label;
if (!process.env.CHROME_PATH) fail('CHROME_PATH is required (path to a Chromium executable)');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs/proof/tile-separation-2026-10-10');
const fx = require('./fixtures/budget-surface-data');

const WIDTHS = [320, 390, 1280];
const THEMES = ['light', 'dark'];

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function md5File(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}
function git(argv) {
  try {
    return execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

async function samplePixels(browser, pngBuffer, points) {
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  const rgb = await page.evaluate(async ({ b64, points }) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = 'data:image/png;base64,' + b64;
    });
    const canvas = document.getElementById('c');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return points.map(p => {
      const d = ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  }, { b64: pngBuffer.toString('base64'), points });
  await page.close();
  return rgb;
}

// Full-image per-pixel max RGB channel delta between two PNG buffers,
// decoded in a Chromium canvas exactly as the samples above. When
// bandRows [y0, y1] is given, also reports the max delta outside those
// rows, so a known noise band can be separated from real change.
async function diffPngBuffers(browser, aBuffer, bBuffer, bandRows) {
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  const result = await page.evaluate(async ({ a64, b64, band }) => {
    const load = src => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = 'data:image/png;base64,' + src;
    });
    const ia = await load(a64);
    const ib = await load(b64);
    if (ia.naturalWidth !== ib.naturalWidth || ia.naturalHeight !== ib.naturalHeight) {
      return { sizeMismatch: [ia.naturalWidth, ia.naturalHeight, ib.naturalWidth, ib.naturalHeight] };
    }
    const canvas = document.getElementById('c');
    canvas.width = ia.naturalWidth;
    canvas.height = ia.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(ia, 0, 0);
    const da = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(ib, 0, 0);
    const db = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let differing = 0;
    let maxDelta = 0;
    let maxDeltaOutsideBand = 0;
    let hot = 0;
    let hotBox = null;
    for (let p = 0, i = 0; p < da.length / 4; p++, i += 4) {
      const d = Math.max(
        Math.abs(da[i] - db[i]),
        Math.abs(da[i + 1] - db[i + 1]),
        Math.abs(da[i + 2] - db[i + 2]),
      );
      if (d === 0) continue;
      differing++;
      const x = p % canvas.width;
      const y = Math.floor(p / canvas.width);
      if (d > maxDelta) maxDelta = d;
      if (band && (y < band[0] || y > band[1]) && d > maxDeltaOutsideBand) maxDeltaOutsideBand = d;
      if (d > 20) {
        hot++;
        if (!hotBox) hotBox = [x, y, x, y];
        else {
          if (x < hotBox[0]) hotBox[0] = x;
          if (y < hotBox[1]) hotBox[1] = y;
          if (x > hotBox[2]) hotBox[2] = x;
          if (y > hotBox[3]) hotBox[3] = y;
        }
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      differing,
      maxDelta,
      maxDeltaOutsideBand: band ? maxDeltaOutsideBand : null,
      hot,
      hotBox,
    };
  }, { a64: aBuffer.toString('base64'), b64: bBuffer.toString('base64'), band: bandRows || null });
  await page.close();
  return result;
}

async function captureCombo(browser, theme, width) {
  const page = await browser.newPage({
    viewport: { width, height: 1000 },
    colorScheme: theme,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  await page.addInitScript(chosen => {
    try { localStorage.setItem('hfd-theme', chosen); } catch (e) {}
  }, theme);
  // Pin the page clock to a fixed instant on the fixture's own
  // calendar day so the before/after pair differs only by the CSS
  // under proof — the surface renders current-time text that would
  // otherwise drift between the two runs.
  await page.clock.setFixedTime(new Date('2026-10-10T19:00:00Z'));
  const data = fx.served({});
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://budget.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: data });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) {
      return route.fulfill({ json: null });
    }
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css'
      : file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.png') ? 'image/png'
      : file.endsWith('.woff2') ? 'font/woff2'
      : file.endsWith('.woff') ? 'font/woff' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
  await page.goto('http://budget.test/?view=classic');
  await page.locator('[data-budget-surface]').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForTimeout(150);

  const probe = await page.evaluate(() => {
    const board = document.querySelector('.budget-bento.atlas-g > .blend-board');
    const hero = document.querySelector('.budget-bento.atlas-g .blend-hero');
    const cs = getComputedStyle(board);
    const hs = getComputedStyle(hero);
    const doc = el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top + window.scrollY, width: r.width, height: r.height };
    };
    // The first in-board sibling that stacks below the hero on mobile
    // is found by geometry, not by class assumptions.
    let below = null;
    for (const el of board.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.top + window.scrollY >= doc(hero).top + doc(hero).height + 8 && r.width >= doc(hero).width * 0.9) {
        if (!below || r.top < below.top) below = { el, top: r.top + window.scrollY, left: r.left };
      }
    }
    // Tile boxes for the tile-spacing amendment's rendered-delta,
    // overflow and clipping facts: geometry only — the hero remains
    // the only tile whose computed style is sampled.
    const tileSelectors = [
      ['hero', '.blend-hero'],
      ['bills', '[data-budget-browse="bills"]'],
      ['spending', '[data-budget-browse="spending"]'],
      ['cards', '.budget-blend-card-movements'],
      ['savings', '[data-budget-savings-goals]'],
    ];
    const tiles = [];
    for (const [tileKey, selector] of tileSelectors) {
      const el = board.querySelector(selector);
      if (!el) continue;
      const g = doc(el);
      if (!(g.height > 0)) continue;
      tiles.push({
        key: tileKey,
        top: g.top,
        bottom: g.top + g.height,
        clip: el.scrollHeight - el.clientHeight,
      });
    }
    tiles.sort((a, b) => a.top - b.top);
    return {
      boardBg: cs.backgroundColor,
      boardGap: cs.gap,
      tiles,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      heroBg: hs.backgroundColor,
      heroBorder: hs.borderTopWidth + ' ' + hs.borderTopStyle + ' ' + hs.borderTopColor,
      heroShadow: hs.boxShadow,
      heroRadius: hs.borderTopLeftRadius,
      hero: doc(hero),
      belowTop: below ? below.top : null,
    };
  });

  const shot = await page.screenshot({ fullPage: true });

  // Pixel samples: centre of the hero-to-next-tile gap, the hero's
  // top-left corner cutout (2px inside the tile box, outside its
  // rounded corner), and the page's left margin at the gap's height.
  let pixels = null;
  if (probe.belowTop != null) {
    const gapY = (probe.hero.top + probe.hero.height + probe.belowTop) / 2;
    const points = [
      { name: 'gap', x: probe.hero.left + probe.hero.width / 2, y: gapY },
      { name: 'corner', x: probe.hero.left + 2, y: probe.hero.top + 2 },
      { name: 'margin', x: 6, y: gapY },
    ];
    const rgbs = await samplePixels(browser, shot, points);
    pixels = Object.fromEntries(points.map((p, i) => [p.name, rgbs[i]]));
    pixels.maxGapMarginDelta = Math.max(...pixels.gap.map((v, i) => Math.abs(v - pixels.margin[i])));
  }
  const facts = { ...probe, belowTop: undefined, pixels };
  await page.close();
  return { facts, shot };
}

(async () => {
  const checkoutHead = git(['rev-parse', 'HEAD']);
  const checkoutTree = git(['rev-parse', 'HEAD^{tree}']);
  if (args.sourceTree !== null) {
    assert.equal(
      checkoutTree,
      args.sourceTree,
      `checkout tree ${checkoutTree} does not match the claimed source tree ${args.sourceTree}; refusing to bind this run to that source`,
    );
  }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const runtimeVersion = await browser.version();
  const facts = {};
  const shots = {};
  let noiseControl = null;
  try {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const { facts: comboFacts, shot } = await captureCombo(browser, theme, width);
        const file = path.join(outDir, `${width}-${theme}-${label}.png`);
        fs.writeFileSync(file, shot);
        shots[`${width}-${theme}`] = shot;
        facts[`${width}-${theme}`] = comboFacts;
        const probe = comboFacts;
        console.log(`${width}/${theme}: boardBg=${probe.boardBg} gap=${probe.boardGap} heroBg=${probe.heroBg}`
          + (probe.pixels ? ` gapPx=${probe.pixels.gap} marginPx=${probe.pixels.margin} maxDelta=${probe.pixels.maxGapMarginDelta}` : ' (no stacked sibling found)'));
      }
    }
    if (label === 'after') {
      // Noise control: capture the first combo a second time on this
      // identical tree and diff the two renders. Any band that moves
      // between these two renders is run-to-run noise, not change.
      const rerun = await captureCombo(browser, THEMES[0], WIDTHS[0]);
      const control = await diffPngBuffers(browser, shots[`${WIDTHS[0]}-${THEMES[0]}`], rerun.shot, null);
      assert.ok(!control.sizeMismatch, 'noise control renders differ in size');
      noiseControl = { control, key: `${WIDTHS[0]}-${THEMES[0]}` };
    }
  } finally {
    await browser.close();
  }

  const reportPath = path.join(outDir, 'report.json');
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : {};
  report[label] = facts;

  // Bindings: what this run actually executed against, stamped from
  // the checkout and the files themselves, never typed by hand.
  report.bindings = report.bindings || {};
  report.bindings.runs = report.bindings.runs || {};
  report.bindings.pngSha256 = report.bindings.pngSha256 || {};
  for (const key of Object.keys(shots)) {
    report.bindings.pngSha256[`${key}-${label}.png`] = sha256File(path.join(outDir, `${key}-${label}.png`));
  }

  if (label === 'after' && report.before) {
    // Pixel diff of the committed before/after PNG pairs, plus the
    // noise control, computed from the files on disk.
    const band = noiseControl && noiseControl.control.hotBox
      ? [Math.max(0, noiseControl.control.hotBox[1] - 2), noiseControl.control.hotBox[3] + 2]
      : null;
    const browser2 = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    try {
      const pixelDiff = {
        method: 'before vs after full-page PNGs decoded in Chromium canvas (ImageData), per-pixel max RGB channel delta; desktop files additionally md5-compared; computed by this script during the after run',
      };
      for (const key of Object.keys(facts)) {
        const beforeFile = path.join(outDir, `${key}-before.png`);
        const afterFile = path.join(outDir, `${key}-after.png`);
        const d = await diffPngBuffers(browser2, fs.readFileSync(beforeFile), fs.readFileSync(afterFile), band);
        if (d.sizeMismatch) {
          // A per-pixel diff needs equal sizes. Two things break
          // that here: the committed before PNGs are the pre-#572
          // baseline rendered on an older tree (page content has
          // moved since), and at <=759px the tile-spacing amendment
          // itself shortens the stacked page (four gaps of 9px
          // instead of 18px). A diff across different heights would
          // measure translation and baseline drift, not this change,
          // so record the sizes and let the computed/rendered
          // assertion set below carry the spacing evidence. (For a
          // same-tree before/after pair the strict diff above still
          // applies unchanged.)
          pixelDiff[key] = {
            sizeMismatch: d.sizeMismatch,
            note: 'before/after page sizes differ (pre-#572 baseline from an older tree; at <=759px the stacked page is also shorter with 9px gaps); pixel diff not computed for this pair',
          };
          continue;
        }
        const entry = {
          size: `${d.width}x${d.height}`,
          differingPixels: d.differing,
          differingPct: Math.round((d.differing / (d.width * d.height)) * 10000) / 100,
          maxChannelDelta: d.maxDelta,
        };
        if (band) entry.maxDeltaOutsideNoiseBand = d.maxDeltaOutsideBand;
        if (d.differing === 0) entry.md5Identical = md5File(beforeFile) === md5File(afterFile);
        if (band && d.maxDelta > 14 && d.maxDeltaOutsideBand <= 14) {
          entry.maxDeltaNote = `max sits in the river-label noise band at y~${band[0]}-${band[1]} (see noiseControl); every board-area delta in this pair is <=14, as in the clean pairs`;
        }
        pixelDiff[key] = entry;
      }
      if (noiseControl) {
        const c = noiseControl.control;
        const bandRows = c.hotBox ? `y~${c.hotBox[1]}-${c.hotBox[3]}` : 'no hot band observed';
        const mobileKeys = Object.keys(facts).filter(k => Number(k.split('-')[0]) <= 759);
        const allAccounted = band && mobileKeys.every(k => {
          const e = pixelDiff[k];
          // Pairs recorded as sizeMismatch carry no channel deltas
          // (see above); they are accounted for by their own note.
          return e.maxChannelDelta === undefined || e.maxChannelDelta <= 14 || e.maxDeltaOutsideNoiseBand <= 14;
        });
        pixelDiff.noiseControl = {
          experiment: `two --label after renders of ${noiseControl.key} on the identical tree within one proof run, diffed the same way`,
          differingPixels: c.differing,
          maxChannelDelta: c.maxDelta,
          hotPixelsOver20: c.hot,
          hotBbox: c.hotBox,
          finding: c.maxDelta === 0
            ? 'the two control renders were pixel-identical in this run; no run-to-run noise band observed'
            : allAccounted
              ? `the river (timeline) canvas label-brightness band at ${bandRows} varies between runs on an unchanged tree (animation-settle timing), independent of this change; it inflates differing-pixel counts slightly and accounts for every >14 max delta in the mobile pairs`
              : `the river (timeline) canvas label-brightness band at ${bandRows} varies between runs on an unchanged tree (animation-settle timing), independent of this change; NOTE: not every >14 delta in the mobile pairs falls inside this band — see maxDeltaOutsideNoiseBand per pair`,
        };
      }
      report.pixelDiff = pixelDiff;
    } finally {
      await browser2.close();
    }
  }

  report.bindings.runs[label] = {
    source: args.sourceHead ? { head: args.sourceHead, tree: args.sourceTree } : null,
    checkoutHead,
    checkoutTree,
    css: { path: 'public/budget-gface.css', sha256: sha256File(path.join(root, 'public/budget-gface.css')) },
    fixture: { path: 'test/fixtures/budget-surface-data.js', sha256: sha256File(path.join(root, 'test/fixtures/budget-surface-data.js')) },
    script: { path: 'test/browser-tile-separation.js', sha256: sha256File(__filename) },
    runtime: {
      browser: 'Chromium',
      browserVersion: runtimeVersion,
      executable: path.basename(process.env.CHROME_PATH),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    at: new Date().toISOString(),
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  // Assertions for this label.
  for (const [key, f] of Object.entries(facts)) {
    const width = Number(key.split('-')[0]);
    assert.notEqual(f.heroBg, 'rgba(0, 0, 0, 0)', `${key}: tile glass must stay painted`);
    // Tile-spacing amendment (2026-10-11, owner-directed via Atlas):
    // the stacked board gap is 9px at <=759px; desktop keeps 18px.
    // The amendment supersedes the value this proof pinned for #572,
    // not the separation invariant asserted around it.
    const expectedGap = width <= 759 ? '9px' : '18px';
    assert.equal(f.boardGap, expectedGap, `${key}: board gap must be ${expectedGap}`);
    if (width <= 759) {
      // Rendered spacing: the five stacked tiles in reading order,
      // each adjacent pair separated by exactly the board gap.
      assert.deepEqual(
        f.tiles.map(t => t.key),
        ['hero', 'bills', 'spending', 'cards', 'savings'],
        `${key}: stacked tile order changed`,
      );
      for (let i = 1; i < f.tiles.length; i++) {
        const delta = f.tiles[i].top - f.tiles[i - 1].bottom;
        assert.ok(
          Math.abs(delta - 9) <= 0.6,
          `${key}: rendered gap before ${f.tiles[i].key} is ${delta}, expected 9`,
        );
      }
      assert.equal(
        f.overflowX,
        0,
        `${key}: horizontal overflow (scrollWidth - innerWidth = ${f.overflowX})`,
      );
      // No tile content clipped by the tighter spacing: each tile's
      // scrollable overflow (scrollHeight - clientHeight) equals the
      // pristine-main baseline measured on 2921aa62 at these widths
      // (the spending tile carries a 9px internal overflow allowance
      // by design; every other tile is 0). The board gap sits outside
      // the tiles' boxes, so any change here is spacing-caused.
      const baselineClip = { hero: 0, bills: 0, spending: 9, cards: 0, savings: 0 };
      for (const t of f.tiles) {
        assert.equal(
          t.clip,
          baselineClip[t.key],
          `${key}: ${t.key} tile clipping changed (${t.clip} vs baseline ${baselineClip[t.key]})`,
        );
      }
    }
    if (label === 'before') {
      assert.notEqual(f.boardBg, 'rgba(0, 0, 0, 0)', `${key}: baseline board must be opaque`);
    } else if (width <= 759) {
      assert.equal(f.boardBg, 'rgba(0, 0, 0, 0)', `${key}: mobile board must be transparent after the fix`);
    } else {
      assert.notEqual(f.boardBg, 'rgba(0, 0, 0, 0)', `${key}: desktop board must stay opaque`);
    }
  }
  if (label === 'after' && report.before) {
    for (const key of Object.keys(facts)) {
      const b = report.before[key];
      const a = facts[key];
      assert.equal(a.heroBg, b.heroBg, `${key}: tile glass changed`);
      assert.equal(a.heroBorder, b.heroBorder, `${key}: tile border changed`);
      assert.equal(a.heroShadow, b.heroShadow, `${key}: tile shadow changed`);
      assert.equal(a.heroRadius, b.heroRadius, `${key}: tile radius changed`);
      if (Number(key.split('-')[0]) > 759) {
        assert.equal(a.boardBg, b.boardBg, `${key}: desktop board background changed`);
      }
    }
  }
  console.log(`tile-separation proof (${label}) OK — shots + facts in ${path.relative(root, outDir)}`);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
