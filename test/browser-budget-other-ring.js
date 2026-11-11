'use strict';
// Other Spending is a ring (spent/plan fill, amber identity), never the
// retired footer chip. Face layout (owner amendment, superseding the
// R1 amount-only centre): the ring centre carries the category NAME
// and the category's published Actual / Planned pair prints beneath
// the circle; the tile's combined published Actual / Planned pair is
// the Household tile's bottom totals; the Still planned / From today
// cell lives in the sheet evidence body, not the tile header.
// Whole-dollar face (follow-on amendment; Option B after Systems
// BLOCK 5484530088): the beneath-circle pairs and the bottom totals
// render in whole dollars — each figure rounded UP once (magnitude
// ceiling) from its own typed published value, read from the
// canonical amount plan.js stamps on the row / ratio span (the total
// from the publication's own pair, never a sum of rounded categories;
// a known zero prints $0; unknown prints its published word). The
// source meta, the accessible names and the sheet evidence keep
// exact cents, and the assertions below pin that split deliberately.
// Overflow (approved boundary, ts 1791699806.567609): past 100% of
// plan the ring laps — red on BOTH laps (correction 1), the second
// lap drawn exactly through 200% with a fixed budget-limit marker at
// the lap origin and a distinct tip, and a display-only "2x+" label
// beside the pair only past 200% (correction 2). No percentage is
// ever printed; unknown / no-plan rings grow no overflow artefacts.
// Repair (Systems Review 5482743628): the personal rings' VISUAL
// centres read exactly Dale / Amanda (full published labels stay in
// the accessible names); a missing pair side prints explicitly
// Unavailable in Actual / Planned order (paired missing-actual /
// missing-plan regressions below); a TRUE zero plan ($0.00
// published) is covered separately from a missing plan.
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-budget-other-ring.js
// ATLAS_OTHER_RING_ROOT may point at a pristine tree for before-shots;
// ATLAS_OTHER_RING_SHOTS_ONLY=1 captures screenshots without assertions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fx = require('./fixtures/other-period-target');
const root = process.env.ATLAS_OTHER_RING_ROOT || path.join(__dirname, '..');
const shotsOnly = process.env.ATLAS_OTHER_RING_SHOTS_ONLY === '1';
const out = process.env.ATLAS_OTHER_RING_SHOTS_DIR
  || path.join(require('node:os').tmpdir(), 'other-ring-browser');
fs.mkdirSync(out, { recursive: true });

const CIRC = 2 * Math.PI * 44;

async function open(browser, data, { width = 1440, theme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
  // This suite proves the Rings view. Bars, the default since #821's
  // Refined design, is proved in browser-budget-house-bars.js.
  await page.addInitScript(() => { try { localStorage.setItem('atlas-house-view', 'rings'); } catch (e) { /* default view */ } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://budget.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: data });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) {
      return route.fulfill({ json: null });
    }
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: file.endsWith('.js') ? 'application/javascript'
        : file.endsWith('.css') ? 'text/css' : 'text/html',
    });
  });
  await page.goto('http://budget.test/');
  await page.locator('[data-budget-surface]').waitFor();
  await page.locator('[data-blend-rings]').waitFor();
  return { page, errors };
}

const readFace = page => page.evaluate(() => {
  const section = document.querySelector('[data-budget-browse="spending"]');
  const ring = section.querySelector('.blend-ring[data-blend-cat="other-spending"]');
  const arc = ring?.querySelector('.rg-arc');
  const dash = (arc?.getAttribute('stroke-dasharray') || '').split(/\s+/).map(Number);
  const header = section.querySelector('header');
  const visibleText = el => {
    if (!el) return '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts = [];
    for (let node; (node = walker.nextNode());) {
      const host = node.parentElement;
      const style = host && getComputedStyle(host);
      if (!style || style.display === 'none' || style.visibility === 'hidden') continue;
      if (host.closest('.budget-cash-sr, [aria-hidden="true"], dialog')) continue;
      const box = host.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      parts.push(node.textContent);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const totals = section.querySelector('.blend-house-totals');
  const before = (el, pseudo) => el ? getComputedStyle(el, pseudo).content.replace(/^"|"$/g, '') : '';
  const liquid = ring?.querySelector('.blend-ring-liquid');
  let liquidInfo = null;
  if (liquid) {
    const wr = liquid.querySelector('.blend-ring-water').getBoundingClientRect();
    const gr = ring.querySelector('.rg-glass').getBoundingClientRect();
    liquidInfo = {
      display: getComputedStyle(liquid).display,
      waterTop: +(wr.top - gr.top).toFixed(1),
      glassHeight: +gr.height.toFixed(1),
    };
  }
  return {
    actualLabel: before(totals?.querySelector('[data-budget-ratio-actual]'), '::before'),
    planLabel: before(totals?.querySelector('[data-budget-ratio-plan]'), '::before'),
    chip: !!section.querySelector('.blend-other, .other-chip, .blend-need-badge'),
    ringPresent: !!ring,
    ringClass: ring?.className || '',
    ringColour: ring ? getComputedStyle(ring).color : '',
    centre: (ring?.querySelector('.blend-ring-v')?.textContent || '').replace(/\s+/g, ' ').trim(),
    label: (ring?.querySelector('.blend-ring-l')?.textContent || '').replace(/\s+/g, ' ').trim(),
    pair: (ring?.querySelector('.blend-ring-pair')?.textContent || '').replace(/\s+/g, ' ').trim(),
    overflow: (() => {
      const lap2 = ring?.querySelector('.rg-lap2');
      const marker = ring?.querySelector('.rg-limit-marker');
      const tip = ring?.querySelector('.rg-tip');
      const lap1 = ring?.querySelector('.rg-arc');
      const overProbe = document.createElement('span');
      overProbe.style.color = 'var(--blend-over)';
      document.body.appendChild(overProbe);
      const overColour = getComputedStyle(overProbe).color;
      overProbe.remove();
      return {
        lap2Drawn: lap2 ? +(lap2.getAttribute('stroke-dasharray') || '').split(/\s+/)[0] : null,
        lap1Stroke: lap1 ? getComputedStyle(lap1).stroke : '',
        lap2Stroke: lap2 ? getComputedStyle(lap2).stroke : '',
        overColour,
        marker: marker ? [+marker.getAttribute('x1'), +marker.getAttribute('y1'), +marker.getAttribute('x2'), +marker.getAttribute('y2')] : null,
        tip: tip ? [+tip.getAttribute('cx'), +tip.getAttribute('cy')] : null,
        badge: (ring?.querySelector('.blend-ring-x2')?.textContent || '').trim(),
      };
    })(),
    ariaLabel: ring?.getAttribute('aria-label') || '',
    arcDrawn: arc ? dash[0] : null,
    trackDotted: !!ring?.querySelector('.rg-track.is-dotted'),
    pill: (ring?.querySelector('.blend-over-pill')?.textContent || '').replace(/\s+/g, ' ').trim(),
    headerText: visibleText(header),
    totalsText: (totals?.textContent || '').replace(/\s+/g, ' ').trim(),
    left: ring ? ring.style.getPropertyValue('--left') : '',
    liquidPresent: !!liquid,
    liquidInfo,
    totalsAfterRings: !!(totals && (section.querySelector('[data-blend-rings]')
      .compareDocumentPosition(totals) & Node.DOCUMENT_POSITION_FOLLOWING)),
    faceBadges: [...section.querySelectorAll('.blend-face-badge')].map(el => el.textContent.trim()),
    projected: !!section.querySelector('.budget-category-row[data-budget-category-open="other-spending"].blend-category-projected'),
  };
});

// The unified ring treatment read for an ordinary category ring
// (Systems Review 5481323065 R1/R2): same fields as readFace's ring.
const readOrdinary = (page, cat) => page.evaluate(id => {
  const ring = document.querySelector('.blend-ring[data-blend-cat="' + id + '"]');
  if (!ring) return null;
  const arc = ring.querySelector('.rg-arc');
  const dash = (arc?.getAttribute('stroke-dasharray') || '').split(/\s+/).map(Number);
  const liquid = ring.querySelector('.blend-ring-liquid');
  let liquidInfo = null;
  if (liquid) {
    const wr = liquid.querySelector('.blend-ring-water').getBoundingClientRect();
    const gr = ring.querySelector('.rg-glass').getBoundingClientRect();
    liquidInfo = {
      display: getComputedStyle(liquid).display,
      waterTop: +(wr.top - gr.top).toFixed(1),
      glassHeight: +gr.height.toFixed(1),
    };
  }
  return {
    ringClass: ring.className,
    centre: (ring.querySelector('.blend-ring-v')?.textContent || '').replace(/\s+/g, ' ').trim(),
    pair: (ring.querySelector('.blend-ring-pair')?.textContent || '').replace(/\s+/g, ' ').trim(),
    overflow: (() => {
      const lap2 = ring.querySelector('.rg-lap2');
      const marker = ring.querySelector('.rg-limit-marker');
      const tip = ring.querySelector('.rg-tip');
      const lap1 = ring.querySelector('.rg-arc');
      const overProbe = document.createElement('span');
      overProbe.style.color = 'var(--blend-over)';
      document.body.appendChild(overProbe);
      const overColour = getComputedStyle(overProbe).color;
      overProbe.remove();
      return {
        lap2Drawn: lap2 ? +(lap2.getAttribute('stroke-dasharray') || '').split(/\s+/)[0] : null,
        lap1Stroke: lap1 ? getComputedStyle(lap1).stroke : '',
        lap2Stroke: lap2 ? getComputedStyle(lap2).stroke : '',
        overColour,
        marker: marker ? [+marker.getAttribute('x1'), +marker.getAttribute('y1'), +marker.getAttribute('x2'), +marker.getAttribute('y2')] : null,
        tip: tip ? [+tip.getAttribute('cx'), +tip.getAttribute('cy')] : null,
        badge: (ring.querySelector('.blend-ring-x2')?.textContent || '').trim(),
      };
    })(),
    ariaLabel: ring.getAttribute('aria-label') || '',
    arcDrawn: arc ? dash[0] : null,
    trackDotted: !!ring.querySelector('.rg-track.is-dotted'),
    pill: (ring.querySelector('.blend-over-pill')?.textContent || '').replace(/\s+/g, ' ').trim(),
    left: ring.style.getPropertyValue('--left'),
    liquidPresent: !!liquid,
    liquidInfo,
  };
}, cat);

// Computed liquid fullness (R2): at a full share the water surface sits
// at or above the glass top; at a partial share it sits mid-glass.
function assertLiquidFull(info, what) {
  assert.ok(info, what + ': liquid present');
  assert.notEqual(info.display, 'none', what + ': liquid visible');
  assert.ok(info.waterTop <= 2, what + ': water surface at/above glass top, got ' + info.waterTop);
}
function assertLiquidPartial(info, what) {
  assert.ok(info, what + ': liquid present');
  assert.notEqual(info.display, 'none', what + ': liquid visible');
  assert.ok(info.waterTop > 0.2 * info.glassHeight && info.waterTop < 0.9 * info.glassHeight,
    what + ': water surface mid-glass, got ' + info.waterTop + ' of ' + info.glassHeight);
}

// Overflow decomposition (approved boundary, Atlas corrections
// applied): the second lap exists only past 100% of plan; the red
// treatment covers lap 1 AND the overflow lap; the overflow fraction
// is share − 1 drawn exactly through 200%; the budget-limit marker
// sits at the lap origin; the "2x+" label appears only past 200%.
const RING_CIRC = 2 * Math.PI * 44;
function redDominant(colour) {
  const nums = (String(colour).match(/[\d.]+/g) || []).map(Number);
  return nums.length >= 3 && nums[0] > nums[1] && nums[1] > nums[2];
}
function assertNoOverflow(face, what) {
  assert.equal(face.overflow.lap2Drawn, null, what + ': no overflow lap');
  assert.equal(face.overflow.marker, null, what + ': no budget-limit marker');
  assert.equal(face.overflow.tip, null, what + ': no overflow tip');
  assert.equal(face.overflow.badge, '', what + ': no 2x+ label');
}
function assertOverflow(face, fraction, what) {
  assert.ok(face.overflow.lap2Drawn != null, what + ': overflow lap present');
  assert.ok(Math.abs(face.overflow.lap2Drawn - fraction * RING_CIRC) < 0.6,
    what + ': overflow lap fraction is share − 1 (' + fraction + '), got ' + face.overflow.lap2Drawn);
  assert.equal(face.overflow.lap1Stroke, face.overflow.overColour,
    what + ': correction 1 — lap 1 carries the red treatment');
  assert.ok(redDominant(face.overflow.lap2Stroke), what + ': overflow lap is in the red treatment: ' + face.overflow.lap2Stroke);
  assert.notEqual(face.overflow.lap2Stroke, face.overflow.lap1Stroke,
    what + ': overflow lap stays visually distinct within the red treatment');
  const m = face.overflow.marker;
  assert.ok(m && m[0] === 50 && m[2] === 50 && m[1] < 2 && m[3] > 10,
    what + ': budget-limit marker ticks the lap origin, got ' + JSON.stringify(m));
  const angle = Math.min(1, fraction) * 2 * Math.PI;
  const ex = 50 + 44 * Math.sin(angle), ey = 50 - 44 * Math.cos(angle);
  assert.ok(face.overflow.tip && Math.hypot(face.overflow.tip[0] - ex, face.overflow.tip[1] - ey) < 1.6,
    what + ': tip sits at the overflow lap end (' + ex.toFixed(1) + ',' + ey.toFixed(1) + '), got ' + JSON.stringify(face.overflow.tip));
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    // Partial spend: the primary state. Other spent 137.26 of plan 450;
    // household Actual 247.63 (groceries 110.37 + other 137.26), plan 925.
    {
      const { page, errors } = await open(browser, fx.build(137.26).data);
      const face = await readFace(page);
      if (!shotsOnly) {
        assert.equal(face.chip, false, 'no Other chip or needs-category badge on the face');
        assert.equal(face.ringPresent, true, 'Other Spending renders as a ring');
        assert.match(face.ringClass, /blend-ring-other/);
        assert.match(face.ringClass, /is-known/);
        assert.ok(Math.abs(face.arcDrawn - (137.26 / 450) * CIRC) < 0.6,
          'arc fills with spent/plan, got dash ' + face.arcDrawn);
        assert.equal(face.centre, 'Other spending', 'centre is the published category name: ' + face.centre);
        assert.equal(face.pair, 'Spent $138 / of planned $450',
          'beneath the circle: the published Actual / Planned pair in whole dollars: ' + face.pair);
        assert.match(face.ariaLabel, /\$137\.26/, 'accessible name keeps the printed amounts');
        assert.doesNotMatch(face.ariaLabel, /planned Unavailable/,
          'known-plan control (Systems Review 5483272344): no synthesized '
          + 'unavailable-plan qualification is added when the plan is published: '
          + face.ariaLabel);
        assert.equal(face.pill, '', 'no over-plan pill at partial spend');
        assert.doesNotMatch(face.headerText, /Still planned|From today/,
          'header carries no From-today sentence: ' + face.headerText);
        assert.equal(face.actualLabel, 'Actual ', 'bottom totals visibly label the actual');
        assert.match(face.totalsText, /\$248/, 'bottom totals print the published household actual '
          + 'rounded UP once from its own stamped value ($247.63 -> $248) — never the sum of the '
          + 'rounded category actuals ($111 + $138 = $249, above the total by design)');
        assert.equal(face.planLabel, 'Planned ', 'bottom totals visibly label the plan');
        assert.match(face.totalsText, /\$925/, 'bottom totals print the published household plan in whole dollars');
        assert.equal(face.totalsAfterRings, true, 'totals sit at the tile bottom, below the rings');
        assert.deepEqual(face.faceBadges.filter(t => /needs a category/i.test(t)), [],
          'no needs-a-category face badge is stamped on the Other ring');
        assert.deepEqual(errors, [], 'no page errors');
        // R2: the liquid level is the spent share — mid-glass here.
        assertLiquidPartial(face.liquidInfo, 'partial Other liquid');
        assertNoOverflow(face, 'partial Other (share < 1)');
        // R1: ordinary rings carry the same spent treatment. Groceries
        // spent 110.37 of 220 (partial); fuel is a known zero.
        const groceries = await readOrdinary(page, 'groceries');
        assert.match(groceries.ringClass, /is-known/);
        assert.equal(groceries.centre, 'Groceries', 'groceries centre is the published name: ' + groceries.centre);
        assert.equal(groceries.pair, 'Spent $111 / of planned $220',
          'groceries beneath-circle pair is the published Actual / Planned in whole dollars: ' + groceries.pair);
        assertNoOverflow(groceries, 'partial groceries (share < 1)');
        assert.ok(Math.abs(groceries.arcDrawn - (110.37 / 220) * CIRC) < 0.6,
          'groceries arc = spent/plan, got ' + groceries.arcDrawn);
        assert.ok(Math.abs(parseFloat(groceries.left) - 110.37 / 220) < 0.001, 'groceries --left = spent share');
        assertLiquidPartial(groceries.liquidInfo, 'groceries liquid');
        assert.match(groceries.ariaLabel, /\$109\.63 left/,
          'groceries accessible name keeps the full printed status: ' + groceries.ariaLabel);
        const fuel = await readOrdinary(page, 'fuel');
        assert.match(fuel.ringClass, /is-known/);
        assert.equal(fuel.centre, 'Fuel', 'fuel centre is the published name: ' + fuel.centre);
        assert.equal(fuel.pair, 'Spent $0 / of planned $85',
          'fuel pair prints the known-zero actual as $0: ' + fuel.pair);
        assert.equal(fuel.arcDrawn, null, 'fuel zero draws no arc');
        assert.equal(fuel.liquidPresent, false, 'R2: no liquid element at a known zero (no sliver)');
        // The personal categories: the VISUAL centre is exactly the
        // approved short label (Systems Review 5482743628) — Dale /
        // Amanda — while the accessible name keeps the source row's
        // full published label ("Dale guilt-free spending" /
        // "Amanda guilt-free spending") and the pair prints beneath.
        const dale = await readOrdinary(page, 'dale-guilt-free');
        assert.equal(dale.centre, 'Dale',
          'Dale visual centre is exactly the approved label: ' + dale.centre);
        assert.match(dale.ariaLabel, /Dale guilt-free spending/,
          'Dale accessible name keeps the full published label: ' + dale.ariaLabel);
        assert.equal(dale.pair, 'Spent $0 / of planned $35', 'Dale pair: ' + dale.pair);
        const amanda = await readOrdinary(page, 'amanda-guilt-free');
        assert.equal(amanda.centre, 'Amanda',
          'Amanda visual centre is exactly the approved label: ' + amanda.centre);
        assert.match(amanda.ariaLabel, /Amanda guilt-free spending/,
          'Amanda accessible name keeps the full published label: ' + amanda.ariaLabel);
        assert.equal(amanda.pair, 'Spent $0 / of planned $45', 'Amanda pair: ' + amanda.pair);
      }
      // The ring opens the native Other Spending detail panel, and the
      // evidence body holds the Still planned / From today cell.
      if (!shotsOnly) {
        const ring = page.locator('.blend-ring[data-blend-cat="other-spending"]');
        await ring.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open);
        const panel = await page.evaluate(() => {
          const body = document.querySelector('[data-budget-detail-body]');
          const other = body?.querySelector('[data-budget-category="other-spending"]');
          const remain = document.querySelector('.blend-house-body [data-budget-browse-remaining]');
          return {
            otherText: (other?.textContent || '').replace(/\s+/g, ' ').trim(),
            remainParent: remain ? (remain.closest('.blend-house-remain')?.textContent || '').replace(/\s+/g, ' ').trim() : '',
          };
        });
        assert.match(panel.otherText, /Not yet assigned to a budget category/,
          'needs-category status lives in the detail panel: ' + panel.otherText);
        assert.match(panel.remainParent, /Still planned/, 'From-today cell moved into the evidence body');
        assert.match(panel.remainParent, /From today/);
        assert.match(panel.remainParent, /(\$[\d,]|Unavailable)/,
          'the cell keeps its published amount or its published unavailability: ' + panel.remainParent);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('[data-budget-detail-sheet]')?.open);
        await page.waitForFunction(() => document.activeElement
          === document.querySelector('.blend-ring[data-blend-cat="other-spending"]'));
      }
      await page.close();
    }
    // Known zero: empty arc (no segment), solid track, name centre and
    // the published $0.00 printed as $0 in the pair — a known zero is a
    // printed value, not an unknown ring.
    {
      const { page } = await open(browser, fx.build(0).data);
      const face = await readFace(page);
      if (!shotsOnly) {
        assert.equal(face.ringPresent, true);
        assert.equal(face.arcDrawn, null, 'known zero draws no arc segment');
        assert.equal(face.trackDotted, false, 'known zero keeps the solid track');
        assert.doesNotMatch(face.ringClass, /is-unknown/);
        assert.equal(face.centre, 'Other spending', 'zero: centre is the category name');
        assert.equal(face.pair, 'Spent $0 / of planned $450',
          'zero: the pair prints the known-zero actual as $0: ' + face.pair);
        assert.equal(face.left, '0', 'zero: --left is 0');
        assert.equal(face.liquidPresent, false,
          'R2: no liquid element at a known zero — the interior is visibly empty, no wave sliver');
        assertNoOverflow(face, 'known zero');
      }
      await page.close();
    }
    // Exact plan: full arc.
    {
      const { page } = await open(browser, fx.build(450).data);
      const face = await readFace(page);
      if (!shotsOnly) {
        assert.ok(Math.abs(face.arcDrawn - CIRC) < 0.6, 'exact plan fills the arc: ' + face.arcDrawn);
        assert.equal(face.centre, 'Other spending', 'exact: centre is the category name');
        assert.equal(face.pair, 'Spent $450 / of planned $450', 'exact pair: ' + face.pair);
        assertLiquidFull(face.liquidInfo, 'R2 exact Other liquid stays full');
        assertNoOverflow(face, 'exact 100%: full lap, no overflow, no marker');
      }
      await page.close();
    }
    // Overspend: geometry caps at the full ring; the pair still shows
    // the published spent amount, and the over state stays visible in
    // the pill.
    {
      const { page } = await open(browser, fx.build(618.73).data);
      const face = await readFace(page);
      if (!shotsOnly) {
        assert.ok(Math.abs(face.arcDrawn - CIRC) < 0.6, 'overspend caps the arc: ' + face.arcDrawn);
        assert.equal(face.centre, 'Other spending', 'over: centre is the category name: ' + face.centre);
        assert.equal(face.pair, 'Spent $619 / of planned $450',
          'over: the pair prints spent (not the overage) against plan, in whole dollars: ' + face.pair);
        assert.match(face.ringClass, /is-over/);
        assert.match(face.pill, /Over plan/);
        assert.match(face.ariaLabel, /168\.73 over/, 'accessible name keeps the over status');
        assertLiquidFull(face.liquidInfo, 'R2 overspent Other liquid stays full (never drained)');
        assertOverflow(face, 618.73 / 450 - 1, 'overspent Other (137%)');
        assert.equal(face.overflow.badge, '', '137%: no 2x+ label below 200%');
      }
      await page.close();
    }
    // Overflow at 125% (approved decomposition): one full lap plus a
    // quarter lap, red on BOTH laps, marker at the lap origin, tip at
    // the quarter point, no "2x+" — for Other AND an ordinary category
    // (groceries 275.00 of 220 via an extra fixture transaction).
    {
      const { page } = await open(browser, fx.build(562.50, fx.asOf, {
        extraTx: [{ amount: 164.63, categoryLabel: 'Groceries' }],
      }).data);
      if (!shotsOnly) {
        const face = await readFace(page);
        assert.equal(face.pair, 'Spent $563 / of planned $450', '125% pair (562.50 rounds up): ' + face.pair);
        assert.ok(Math.abs(face.arcDrawn - CIRC) < 0.6, '125%: lap 1 is a complete lap');
        assertOverflow(face, 0.25, 'Other at 125%');
        assert.equal(face.overflow.badge, '', '125%: no 2x+ label');
        assert.match(face.totalsText, /\$838/, '125%: bottom totals print the publication pair in whole dollars ($837.50 -> $838)');
        const groceries = await readOrdinary(page, 'groceries');
        assert.equal(groceries.pair, 'Spent $275 / of planned $220', 'groceries 125% pair: ' + groceries.pair);
        assertOverflow(groceries, 0.25, 'groceries at 125%');
        assert.equal(groceries.overflow.badge, '', 'groceries 125%: no 2x+ label');
        const fuel = await readOrdinary(page, 'fuel');
        assertNoOverflow(fuel, 'fuel at a known zero beside overflow rings');
      }
      await page.close();
    }
    // Overflow at exactly 200%: the second lap completes precisely;
    // the tip returns to the lap origin; the marker stays; NO "2x+"
    // (the label belongs only above 200%).
    {
      const { page } = await open(browser, fx.build(900).data);
      const face = await readFace(page);
      if (!shotsOnly) {
        assert.equal(face.pair, 'Spent $900 / of planned $450', '200% pair: ' + face.pair);
        assertOverflow(face, 1, 'Other at exactly 200%');
        assert.equal(face.overflow.badge, '', 'exactly 200%: no 2x+ label');
      }
      await page.close();
    }
    // Overflow above 200%: two complete red laps stay, the marker
    // stays legible at the origin, and the display-only "2x+" label
    // appears beside the pair — never in the accessible name, which
    // keeps the published over status.
    {
      const { page } = await open(browser, fx.build(990, fx.asOf, {
        extraTx: [{ amount: 373.63, categoryLabel: 'Groceries' }],
      }).data);
      if (!shotsOnly) {
        const face = await readFace(page);
        assert.equal(face.pair, 'Spent $990 / of planned $450', '220% pair: ' + face.pair);
        assertOverflow(face, 1, 'Other above 200% (geometry stays two full laps)');
        assert.equal(face.overflow.badge, '2x+', 'above 200%: the 2x+ label prints beside the pair');
        assert.match(face.ariaLabel, /540\.00 over/, 'accessible name keeps the published over status');
        assert.doesNotMatch(face.ariaLabel, /2x\+/, 'the 2x+ label never enters the accessible name');
        const groceries = await readOrdinary(page, 'groceries');
        assert.equal(groceries.pair, 'Spent $484 / of planned $220', 'groceries 220% pair: ' + groceries.pair);
        assertOverflow(groceries, 1, 'groceries above 200%');
        assert.equal(groceries.overflow.badge, '2x+', 'groceries above 200%: the 2x+ label prints');
      }
      await page.close();
    }
    // Ordinary exact + overspend (R1), via extra fixture transactions:
    // fuel spent exactly its 85 plan; groceries spent 260.37 of 220.
    {
      const { page } = await open(browser, fx.build(137.26, fx.asOf, {
        extraTx: [{ amount: 85, categoryLabel: 'Fuel' }],
      }).data);
      if (!shotsOnly) {
        const fuel = await readOrdinary(page, 'fuel');
        assert.equal(fuel.centre, 'Fuel', 'R1 fuel exact: centre is the published name');
        assert.equal(fuel.pair, 'Spent $85 / of planned $85', 'R1 fuel exact pair: ' + fuel.pair);
        assert.ok(Math.abs(fuel.arcDrawn - CIRC) < 0.6, 'R1 fuel exact: full arc');
        assertLiquidFull(fuel.liquidInfo, 'R1 fuel exact liquid full');
      }
      await page.close();
    }
    {
      const { page } = await open(browser, fx.build(137.26, fx.asOf, {
        extraTx: [{ amount: 150, categoryLabel: 'Groceries' }],
      }).data);
      if (!shotsOnly) {
        const groceries = await readOrdinary(page, 'groceries');
        assert.equal(groceries.centre, 'Groceries', 'R1 groceries over: centre is the published name');
        assert.equal(groceries.pair, 'Spent $261 / of planned $220',
          'R1 groceries over pair: ' + groceries.pair);
        assert.ok(Math.abs(groceries.arcDrawn - CIRC) < 0.6, 'R1 groceries over: arc caps full');
        assert.match(groceries.pill, /Over plan/, 'R1 groceries over: pill visible');
        assertLiquidFull(groceries.liquidInfo, 'R1 groceries over liquid full');
      }
      await page.close();
    }
    // Missing actual (truncated coverage): unknown ring — dotted track,
    // no arc, name in the centre, the pair prints the actual as
    // Unavailable, never a zero.
    {
      const f = fx.build(137.26);
      f.packet.transactionCoverage = 'truncated';
      const { page } = await open(browser, f.data);
      const face = await readFace(page);
      if (!shotsOnly) {
        assert.equal(face.ringPresent, true);
        assert.match(face.ringClass, /is-unknown/);
        assert.equal(face.arcDrawn, null);
        assert.equal(face.trackDotted, true, 'unknown actual gets the dotted track');
        assert.equal(face.centre, 'Other spending', 'unknown: centre is the category name: ' + face.centre);
        assert.equal(face.pair, 'Spent Unavailable / of planned $450',
          'unknown actual prints as Unavailable in the pair, never as zero: ' + face.pair);
        assert.equal(face.liquidPresent, false, 'unknown: no liquid');
        const groceries = await readOrdinary(page, 'groceries');
        assert.match(groceries.ringClass, /is-unknown/, 'R1: unknown treatment reaches ordinary rings');
        assert.equal(groceries.centre, 'Groceries', 'R1: unknown ordinary centre is the category name');
        assert.equal(groceries.pair, 'Spent Unavailable / of planned $220',
          'paired missing-side regression (missing actual): the Actual side prints '
          + 'explicitly Unavailable and the published Planned side is preserved, never a zero: '
          + groceries.pair);
        assert.equal(groceries.liquidPresent, false, 'R1 unknown ordinary: no liquid');
        assertNoOverflow(face, 'unknown actual: no decomposition, no marker, no label');
        assertNoOverflow(groceries, 'unknown ordinary: no overflow artefacts');
      }
      await page.close();
    }
    // Missing plan (completed period, original plan withheld): no
    // geometry is invented, and the beneath-circle pair still prints
    // in Actual / Planned order — the known spent side preserved (in
    // whole dollars), the withheld plan side explicitly Unavailable, never
    // a lone amount and never an invented zero (Systems Review
    // 5482743628). Other's row publishes no pair (its meta is the
    // unassigned note and its status carries the spent amount); the
    // ordinary rows publish the pair with the plan side already
    // printed Unavailable. The accessible name carries the
    // unassigned status from the row meta — and, for Other alone,
    // the synthesized unavailable-plan qualification (Systems
    // Review 5483272344): the source row text carries no plan side
    // at all, so without the synthesis the button's focus
    // announcement omitted the qualification the visible pair
    // prints. The assertions below read the button's explicit
    // aria-label — the effective accessible name a screen reader
    // announces on focus — not the pair's descendant text.
    {
      const { page } = await open(browser, fx.build(137.26, '2026-10-18').data);
      // The blend face visually supersedes the native window arrows (they
      // render 0x0), so the step is driven through the native control
      // itself; the subject is the completed period's ring, not the arrow.
      await page.evaluate(() => document.querySelector('[data-budget-window-step="-1"]').click());
      await page.locator('[data-blend-rings]').waitFor();
      const face = await readFace(page);
      if (!shotsOnly) {
        assert.equal(face.ringPresent, true, 'Other ring renders for the completed period');
        assert.equal(face.arcDrawn, null, 'no plan, no invented arc');
        assert.equal(face.centre, 'Other spending', 'no-plan: centre is the category name: ' + face.centre);
        assert.equal(face.pair, 'Spent $138 / of planned Unavailable',
          'paired missing-side regression (missing plan): the published spent side is '
          + 'preserved (rendered in whole dollars) and the missing Planned side prints '
          + 'explicitly Unavailable: ' + face.pair);
        assert.match(face.ariaLabel, /Not yet assigned to a budget category/,
          'accessible name carries the unassigned status: ' + face.ariaLabel);
        assert.match(face.ariaLabel, /\$137\.26/,
          'effective accessible name keeps the actual amount (Systems Review '
          + '5483272344): ' + face.ariaLabel);
        assert.match(face.ariaLabel, /planned Unavailable/,
          'effective accessible name carries the synthesized unavailable-plan '
          + 'qualification the visible pair prints (Systems Review 5483272344): '
          + face.ariaLabel);
        assert.match(face.totalsText, /Unknown/, 'withheld plan prints as unknown in the totals');
        assertNoOverflow(face, 'no plan: no decomposition, no marker, no label');
        const groceries = await readOrdinary(page, 'groceries');
        assert.equal(groceries.pair, 'Spent $111 / of planned Unavailable',
          'missing plan on an ordinary ring: published pair keeps the spent side and '
          + 'prints the plan side Unavailable: ' + groceries.pair);
        assert.match(groceries.ariaLabel, /\$110\.37/,
          'ordinary-ring control: its accessible name keeps its actual amount from '
          + 'its own source row, unchanged by the Other-only synthesis: '
          + groceries.ariaLabel);
        assert.match(groceries.ariaLabel, /Unavailable/,
          'ordinary-ring control: its source row already prints the plan side '
          + 'Unavailable, so its accessible name already carries it — unchanged: '
          + groceries.ariaLabel);
        assertNoOverflow(groceries, 'missing plan, ordinary ring: no overflow artefacts');
      }
      await page.close();
    }
    // True zero plan (BLOCKER 3): a category whose plan is published
    // as $0.00 is NOT a missing plan — both pair sides print as known
    // values ($0 / $0 in whole dollars, never Unavailable), and the established handling
    // holds: no published share exists for a zero denominator, so no
    // arc, no liquid, no percentage and no overflow decomposition.
    {
      const { page } = await open(browser, fx.build(137.26, fx.asOf, { zeroPlan: ['pets'] }).data);
      if (!shotsOnly) {
        const pets = await readOrdinary(page, 'pets');
        assert.equal(pets.centre, 'Dog food', 'zero-plan: centre is the category name: ' + pets.centre);
        assert.equal(pets.pair, 'Spent $0 / of planned $0',
          'zero-plan: the published pair prints both known sides, '
          + 'the zero plan as $0 — not Unavailable, not a lone amount: ' + pets.pair);
        assert.match(pets.ringClass, /is-unknown/,
          'zero-plan: no share is published for a zero denominator (established handling)');
        assert.equal(pets.arcDrawn, null, 'zero-plan: no arc is invented');
        assert.equal(pets.liquidPresent, false, 'zero-plan: no liquid');
        assert.equal(pets.left, '', 'zero-plan: no --left share is published');
        assertNoOverflow(pets, 'zero-plan: no decomposition, no marker, no label');
        const other = await readFace(page);
        assert.equal(other.pair, 'Spent $138 / of planned $450',
          'zero-plan on a sibling leaves the Other pair untouched: ' + other.pair);
      }
      await page.close();
    }
    // Screenshots: every ring state at desktop + 390/320, both themes.
    // Names: other-ring-<state>-<width>-<theme>.png. The no-plan state is
    // the completed period reached through the native window step, as in
    // the assertion pass above.
    const shotStates = [
      ['partial', () => fx.build(137.26).data, false],
      ['zero', () => fx.build(0).data, false],
      ['over', () => fx.build(618.73).data, false],
      ['over125', () => fx.build(562.50).data, false],
      ['over200', () => fx.build(900).data, false],
      ['over2x', () => fx.build(990).data, false],
      ['unknown', () => { const f = fx.build(137.26); f.packet.transactionCoverage = 'truncated'; return f.data; }, false],
      ['noplan', () => fx.build(137.26, '2026-10-18').data, true],
      ['zeroplan', () => fx.build(137.26, fx.asOf, { zeroPlan: ['pets'] }).data, false],
    ];
    // ATLAS_OTHER_RING_BEFORE=1 (with SHOTS_ONLY against a pristine root)
    // captures only the partial state: the retired-chip comparison set.
    const activeStates = process.env.ATLAS_OTHER_RING_BEFORE === '1'
      ? shotStates.filter(([state]) => state === 'partial') : shotStates;
    for (const [state, make, step] of activeStates) {
      for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
        const { page } = await open(browser, make(), { width, theme });
        if (step) {
          await page.evaluate(() => document.querySelector('[data-budget-window-step="-1"]').click());
          await page.locator('[data-blend-rings]').waitFor();
        }
        const tile = page.locator('[data-budget-browse="spending"]');
        await tile.scrollIntoViewIfNeeded();
        await tile.screenshot({ path: path.join(out, `other-ring-${state}-${width}-${theme}.png`), animations: 'disabled' });
        // Well close-ups at desktop width for the pixel-level liquid
        // evidence (R2): other-well-<state>-<theme>.png.
        if (width === 1440 && process.env.ATLAS_OTHER_RING_BEFORE !== '1') {
          const well = page.locator('.blend-ring[data-blend-cat="other-spending"] .blend-ring-g');
          await well.screenshot({ path: path.join(out, `other-well-${state}-${theme}.png`), animations: 'disabled' });
        }
        await page.close();
      }
    }
    console.log('PASS other ring: all Household rings share the spent/plan fill (R1) with the category name in the centre and the published Actual / Planned pair beneath the circle (owner amendment); overflow laps red on both laps past plan with the marker at the lap origin, the second lap exact through 200% and the 2x+ label only past 200%; liquid visibly empty at zero, full at full/overspend (R2); chip retired; unknown stays unknown; totals at tile bottom; From-today sentence in the evidence body');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
