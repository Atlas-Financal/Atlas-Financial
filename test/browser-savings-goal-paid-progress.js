'use strict';
// ATLAS-024: Savings goal Paid / Still to fund rows with a progress fill.
// Paid is Forecast's published commitmentCost fact. Under reviewed #808,
// Still to fund is the selected row's estimated Needed minus Saved,
// clamped at zero — never unpaidCost or a borrowed current schedule gap.
// Real App.boot and the
// real Budget renderer; only intercepted invented GETs, no external
// requests, no writes. Expected figures come from the hand-written
// oracles below, derived from the invented fixture inputs (pool 119
// backing goals chronologically; links per the fixture), not from the
// renderer or Forecast.
//
// #770 still qualifies A's full relief before the observation date. The
// current hand ledger is unchanged: A needs 0; B needs 80 - 20 = 60, backed
// 60 from the 119 pool; C needs 60, backed by the remaining 59. The gaps are
// 0, 0, 1, each explicitly estimated. Missing Paid configuration does not
// make known Needed/Saved unknown. In 'uncertain', B's reversal withholds
// its Needed and the allocation's Saved, so no gap is invented. Historical
// rows withhold their inputs; projected rows use their own close's backing.
//
// Two dates, never conflated: OBSERVATION_AS_OF is the packet's
// meta.asOf (2026-10-07, via the roster -> daily-consumer fixture chain);
// LINK_EFFECTIVE is the
// payment link's own effectiveDate / asOf (2026-10-05) that pins when the
// relief took effect. Both are hand-pinned below and checked against the
// fixture before any page loads.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { data: fixture, GOALS, GAP_GOALS } = require('./fixtures/savings-goal-paid-progress-data');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'public');
const out = process.env.ATLAS_PAID_PROGRESS_PROOF || path.join(require('node:os').tmpdir(), 'atlas-goal-paid-progress');
fs.mkdirSync(out, { recursive: true });
const ORIGIN = 'http://savings-goal-paid.test';
const served = {}, cases = [], errors = [], external = [], writes = [];
const OBSERVATION_AS_OF = '2026-10-07', LINK_EFFECTIVE = '2026-10-05';
const ESTIMATE_REASON = 'Estimate: Needed minus Saved. It is a planning gap, not an unpaid balance.';
const UNKNOWN_NEEDED = 'Still to fund is unavailable: the goal amount needed is not a known point value.';
const UNKNOWN_SAVED = 'Still to fund is unavailable: the amount saved for this goal is not known.';
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) <= 0.02, `${message}: expected ≈${expected}, got ${actual}`);

// Hand oracle per mode: printed Paid, printed Still to fund, block state,
// row-bar segment ratios (of the published original cost), and the
// visible-face bar fill ratio / band where the paid geometry publishes.
const EXPECT = {
  evidence: {
    'goal-a': { paid: '$40.00', stf: '$0.00', state: 'paid', paidRatio: 1, faceBand: 'is-paid', faceRatio: 1 },
    'goal-b': { paid: '$20.00', stf: '$0.00', state: 'funding', paidRatio: 0.25, savedRatio: 0.75, faceRatio: 1 },
    'goal-c': { paid: '$0.00', stf: '$1.00', state: 'funding', savedRatio: 59 / 60, faceRatio: 59 / 60 },
  },
  absent: {
    'goal-a': { paid: 'Unknown', stf: '$0.00', state: 'unknown' },
    'goal-b': { paid: 'Unknown', stf: '$1.00', state: 'unknown' },
    'goal-c': { paid: 'Unknown', stf: '$60.00', state: 'unknown' },
  },
  uncertain: {
    'goal-a': { paid: '$40.00', stf: 'Unknown', stfReason: UNKNOWN_SAVED, state: 'paid', paidRatio: 1, faceBand: 'is-paid', faceRatio: 1 },
    'goal-b': { paid: 'Unknown', stf: 'Unknown', stfReason: UNKNOWN_NEEDED, state: 'unknown' },
    'goal-c': { paid: '$0.00', stf: 'Unknown', stfReason: UNKNOWN_SAVED, state: 'funding' },
  },
  gap: {
    'goal-f': { paid: '$0.00', stf: '$0.00', state: 'funding', savedRatio: 1, faceRatio: 1 },
    'goal-d': { paid: '$20.00', stf: '$30.00', state: 'funding', paidRatio: 0.25, savedRatio: 0.375, faceRatio: 0.625 },
    'goal-e': { paid: '$0.00', stf: '$50.00', state: 'funding' },
  },
};
const MODE_GOALS = { evidence: GOALS, absent: GOALS, uncertain: GOALS, gap: GAP_GOALS };
const gapText = amount => amount === 'Unknown' ? amount : '≈ estimated ' + amount;
const faceGapText = amount => amount === 'Unknown' ? amount : '≈ ' + amount;
function assertGap(facts, amount, reason, where) {
  assert.equal(facts.stf, gapText(amount), `${where}: row-owned Still to fund with its qualification`);
  assert.equal(facts.stfReason, reason || ESTIMATE_REASON, `${where}: Still to fund explanation`);
  if (amount === 'Unknown') assert.equal(facts.stfStamp, null, `${where}: no still-to-fund stamp when unknown`);
  else {
    // Number(null) === 0 must not let a missing stamp masquerade as a real zero.
    assert.notEqual(facts.stfStamp, null, `${where}: still-to-fund stamp present for a published figure`);
    assert.equal(Number(facts.stfStamp), Number(amount.replace(/[$,]/g, '')), `${where}: still-to-fund stamp matches the hand oracle`);
  }
}

async function goalFacts(row) {
  return row.evaluate(li => {
    const box = n => n ? n.getBoundingClientRect().width : null;
    const block = li.querySelector('[data-budget-goal-paid-progress]');
    const track = li.querySelector('[data-budget-goal-bar]');
    const paidFill = li.querySelector('[data-budget-goal-bar-paid]');
    const savedFill = li.querySelector('[data-budget-goal-bar-saved]');
    const figures = li.querySelector('[data-budget-goal-paid-figures]');
    const stf = li.querySelector('[data-budget-goal-still-to-fund]')?.cloneNode(true);
    const reason = stf?.querySelector('[data-budget-goal-still-to-fund-reason]');
    const stfReason = reason?.textContent.trim() ?? null;
    reason?.remove();
    return {
      state: block ? block.getAttribute('data-budget-goal-paid-progress') : null,
      paid: li.querySelector('[data-budget-goal-paid]')?.textContent.trim() ?? null,
      stf: stf?.textContent.trim() ?? null, stfReason,
      stfStamp: block ? block.getAttribute('data-budget-goal-still-to-fund-amount') : null,
      paidLabel: li.querySelector('[data-budget-goal-paid]')?.parentElement?.textContent ?? '',
      track: box(track), paidWidth: box(paidFill), savedWidth: box(savedFill),
      paidColor: paidFill ? getComputedStyle(paidFill).backgroundColor : null,
      figuresOverflow: figures ? figures.scrollWidth > figures.clientWidth + 1 : null,
    };
  });
}

// Clean main view (owner direction 2026-11-09): Paid, Still to fund and its
// reason are no longer printed on the visible row. Each row's tap-to-explain
// window is opened and the same printed text is read there, in the form the
// row used to print it (screen-reader trust words removed, the ≈ mark kept).
// The bar facts still come from the visible row.
async function faceFacts(tile) {
  const page = tile.page();
  const rows = tile.locator('[data-blend-goals] .blend-goal-legend > li');
  const out = [];
  for (let i = 0, n = await rows.count(); i < n; i++) {
    const li = rows.nth(i);
    const bar = await li.evaluate(node => {
      const bar = node.querySelector('.blend-g-bar');
      if (!bar) return { band: null, ratio: null, fill: null };
      const before = getComputedStyle(bar, '::before');
      return {
        band: [...bar.classList].find(c => c.startsWith('is-')) || null,
        ratio: bar.getBoundingClientRect().width > 0
          ? parseFloat(before.width) / bar.getBoundingClientRect().width : null,
        fill: before.backgroundColor,
      };
    });
    const button = li.locator('button.blend-goal-row');
    if (!(await button.count())) { out.push({ ...bar, paid: null, stf: null, stfReason: null, row: null }); continue; }
    const row = await li.evaluate(node => node.textContent.replace(/\s+/g, ' ').trim());
    await button.evaluate(node => node.click());
    const explain = page.locator('dialog[data-blend-explain][open]');
    await explain.waitFor();
    const words = await explain.evaluate(dialog => {
      const printed = key => {
        const dd = dialog.querySelector(`[data-blend-explain-fact="${key}"] dd:not(.blend-explain-note)`);
        if (!dd) return null;
        const copy = dd.cloneNode(true);
        copy.querySelectorAll('.budget-cash-sr').forEach(hidden => hidden.remove());
        return copy.textContent.replace(/\s+/g, ' ').trim();
      };
      const paid = printed('paid'), stf = printed('still-to-fund');
      return { paid: paid == null ? null : ('Paid ' + paid).trim(), stf: stf == null ? null : 'Still to fund ' + stf,
        stfReason: dialog.querySelector('[data-blend-explain-note="still-to-fund"]')?.textContent.trim() ?? null };
    });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[data-blend-explain]')?.open);
    out.push({ ...bar, ...words, row });
  }
  return out;
}

// Date pins, checked against the invented fixture (not the renderer):
// the observation asOf and the link effective date are distinct facts.
for (const mode of ['evidence', 'uncertain', 'gap']) {
  const d = fixture(mode);
  assert.equal(d.meta.asOf, OBSERVATION_AS_OF, `${mode}: packet meta.asOf is the observation date`);
  for (const c of d.settlementEvidence.commitments) for (const l of c.links) {
    assert.equal(l.effectiveDate, LINK_EFFECTIVE, `${mode} ${c.goalId}: link effectiveDate`);
    assert.equal(l.asOf, LINK_EFFECTIVE, `${mode} ${c.goalId}: link asOf`);
  }
}
assert.notEqual(OBSERVATION_AS_OF, LINK_EFFECTIVE, 'observation asOf and link effective date are distinct');
assert.ok(LINK_EFFECTIVE <= OBSERVATION_AS_OF, 'relief is effective on or before the observation asOf');
assert.equal(fixture('absent').meta.asOf, OBSERVATION_AS_OF, 'absent: packet meta.asOf');
const rows = { A3: [], A4: [], A9: [] };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH
    || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    for (const width of [1440, 390]) for (const mode of ['evidence', 'absent', 'uncertain', 'gap']) {
      const goals = MODE_GOALS[mode], expect = EXPECT[mode];
      const data = fixture(mode);
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      await page.addInitScript(() => localStorage.setItem('hfd-plan-knobs-v1', JSON.stringify({ weeklyVariable: 0 })));
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) { external.push(url.origin); return route.abort(); }
        if (route.request().method() !== 'GET') { writes.push(route.request().method()); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        const body = fs.readFileSync(file);
        served[path.relative(root, file).replaceAll('\\', '/')] = crypto.createHash('sha256').update(body).digest('hex');
        return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto(ORIGIN + '/');
      const tile = page.locator('[data-budget-savings-goals]'); await tile.waitFor();
      const before = await page.evaluate(() => JSON.stringify(App.data));
      const keys = await tile.locator('[data-budget-savings-goal]').evaluateAll(rows =>
        rows.map(row => row.getAttribute('data-budget-savings-goal')));
      // Never hidden: every invented goal keeps its row in every mode, in
      // the published chronological order; this page never reorders. (The
      // uncertain packet is held unresolved by Forecast and its own order
      // is not re-sorted here.)
      assert.deepEqual([...keys].sort(), goals.map(g => g.key).sort(), `${mode} ${width}: every goal row present`);
      if (mode !== 'uncertain') assert.deepEqual(keys, goals.map(g => g.key), `${mode} ${width}: chronological order`);
      const face = await faceFacts(tile);
      const facts = {};
      for (const goal of goals) {
        const f = await goalFacts(tile.locator(`[data-budget-savings-goal="${goal.key}"]`));
        facts[goal.id] = f;
        const e = expect[goal.id], where = `${mode} ${width} ${goal.label}`;
        assert.ok(f.state, `${where}: paid progress block rendered`);
        assert.ok(f.track > 0, `${where}: progress track has width`);
        assert.equal(f.figuresOverflow, false, `${where}: figures fit their row`);
        assert.match(f.paidLabel, /Paid/, `${where}: Paid label`);
        assert.equal(f.state, e.state, `${where}: block state`);
        assert.equal(f.paid, e.paid, `${where}: Paid from published confirmedLinkedPaid`);
        // Cost 80 / paid 20 / saved 30 still requires gap 30, never the
        // unpaid cost 60. #808 adds qualification, not different arithmetic.
        assertGap(f, e.stf, e.stfReason, where);
        if (e.state === 'paid') {
          near(f.paidWidth / f.track, 1, `${where}: full paid fill`);
          assert.match(f.paidColor, /^rgb/, `${where}: paid fill painted`);
          assert.notEqual(f.paidColor, 'rgba(0, 0, 0, 0)', `${where}: paid fill not transparent`);
        } else if (e.state === 'unknown') {
          assert.ok(!f.paidWidth, `${where}: no paid fill without a paid fact`);
          assert.ok(!f.savedWidth, `${where}: no saved fill without paid geometry`);
        } else {
          if (e.paidRatio) near(f.paidWidth / f.track, e.paidRatio, `${where}: paid fill ratio`);
          else assert.ok(!f.paidWidth, `${where}: no paid fill at zero paid`);
          if (e.savedRatio) near(f.savedWidth / f.track, e.savedRatio, `${where}: saved fill ratio`);
          else if (e.savedRatio == null && mode !== 'uncertain') assert.ok(!f.savedWidth, `${where}: no saved fill at zero saved`);
          if (f.paidWidth && f.savedWidth) assert.ok(f.paidWidth + f.savedWidth <= f.track + 1, `${where}: fill stays in track`);
        }
        // Visible face (budget-blend.js paintGoals): a paid goal's bar is
        // full and green (is-paid); other published geometry fills by
        // paid + saved over the published original cost.
        const fb = face[keys.indexOf(goal.key)];
        // Read in the row's tap-to-explain window (moved behind the tap).
        assert.equal(fb.paid, 'Paid ' + e.paid, `${where}: window Paid matches the hand oracle`);
        assert.equal(fb.stf, 'Still to fund ' + faceGapText(e.stf), `${where}: window retains the estimate mark or Unknown`);
        assert.equal(fb.stfReason, e.stfReason || ESTIMATE_REASON, `${where}: window retains the planning-gap or unknown reason`);
        if (e.faceBand) {
          assert.equal(fb.band, e.faceBand, `${where}: face bar band`);
          near(fb.ratio, e.faceRatio, `${where}: face bar fill ratio`);
          assert.notEqual(fb.fill, 'rgba(0, 0, 0, 0)', `${where}: face bar fill painted`);
        } else if (e.faceRatio != null) {
          near(fb.ratio, e.faceRatio, `${where}: face bar fill ratio (paid + saved)`);
        }
        // A9 no false retirement / no false green: only a goal whose hand
        // oracle state is paid may render the paid band or paid state.
        if (e.state !== 'paid') {
          assert.notEqual(fb.band, 'is-paid', `${where}: no paid face band without qualified full relief`);
          assert.notEqual(f.state, 'paid', `${where}: not retired as paid`);
        }
        if (e.state === 'unknown') assert.ok(!f.paidWidth && !f.savedWidth, `${where}: unknown draws no fill`);
      }
      if (mode === 'evidence') {
        assert.ok(facts['goal-a'].paidWidth > facts['goal-b'].paidWidth, 'paid fill orders A over B');
      }
      if (mode === 'gap') {
        // The headline case, isolated: D's Still to fund is the planning
        // gap 30, and F's fully-saved bar is full without being paid.
        assert.equal(facts['goal-d'].stf, '≈ estimated $30.00', 'gap: D still to fund is the qualified planning gap');
        assert.equal(facts['goal-f'].state, 'funding', 'gap: F fully saved is not paid');
      }
      if (mode === 'gap' || mode === 'evidence') {
        // #808 replaces the old asOf-only schedule join with row-owned
        // period facts. Historical inputs stay Unknown. A projected gap
        // must match that close's independent ledger, even when Paid is
        // Unknown. Returning to current must restore today's own gap.
        // Wheel items outside the visible slot are not pointer-visible,
        // so selection dispatches the item's own click through the app's
        // delegated wheel handler — the same selection path a tap takes.
        const selectPeriod = async index => {
          const marker = await page.evaluate(() =>
            document.querySelector('[data-calendar-waterfalls]')?.getAttribute('data-selected-pay-period'));
          await page.evaluate(i => {
            document.querySelector(`[data-budget-wheel="period"] [data-wheel-index="${i}"]`).click();
          }, index);
          await page.waitForFunction(prev =>
            document.querySelector('[data-calendar-waterfalls]')?.getAttribute('data-selected-pay-period') !== prev,
            marker, { timeout: 10000 });
          await page.waitForTimeout(300);
        };
        const wheel = await page.evaluate(() => {
          const items = [...document.querySelectorAll('[data-budget-wheel="period"] [data-wheel-index]')];
          return { count: items.length, current: items.findIndex(b => b.hasAttribute('aria-current')) };
        });
        assert.ok(wheel.current > 0 && wheel.current + 2 < wheel.count,
          'gap: historical and projected periods are selectable');
        const factsById = async () => {
          const out = {};
          for (const g of goals) {
            const row = tile.locator(`[data-budget-savings-goal="${g.key}"]`);
            if (await row.count()) out[g.id] = await goalFacts(row);
          }
          return out;
        };
        // Hand ledger: Oct 16–29 still has the original 119 pool. A is
        // already paid and retired; F is still due Oct 30. At Nov 12 the
        // landed sweep (80 inherited Bills + 1000 receipt, #620) makes
        // 1199, or 1110 after F's 89 cost. B/D need60 and C/E need60/50,
        // so each remaining goal is fully backed. C's1 and D/E's30/50
        // must become0: a reintroduced current-gap join cannot pass.
        const PERIOD_GAPS = mode === 'gap' ? {
          historical: { 'goal-f': 'Unknown', 'goal-d': 'Unknown', 'goal-e': 'Unknown' },
          next: { 'goal-f': '$0.00', 'goal-d': '$30.00', 'goal-e': '$50.00' },
          future: { 'goal-d': '$0.00', 'goal-e': '$0.00' },
        } : {
          historical: { 'goal-a': 'Unknown', 'goal-b': 'Unknown', 'goal-c': 'Unknown' },
          next: { 'goal-b': '$0.00', 'goal-c': '$1.00' },
          future: { 'goal-b': '$0.00', 'goal-c': '$0.00' },
        };
        const expectPeriod = async period => {
          const factsNow = await factsById(), expected = PERIOD_GAPS[period];
          const tag = `${mode} ${width} ${period}`;
          assert.deepEqual(Object.keys(factsNow), Object.keys(expected), `${tag}: exact remaining roster, including paid/due retirement`);
          const periodKeys = await tile.locator('[data-budget-savings-goal]').evaluateAll(items =>
            items.map(item => item.getAttribute('data-budget-savings-goal')));
          const periodFace = await faceFacts(tile);
          for (const [id, amount] of Object.entries(expected)) {
            const f = factsNow[id];
            assert.equal(f.paid, 'Unknown', `${tag}: ${id} Paid withheld by the noncurrent packet`);
            assertGap(f, amount, period === 'historical' ? UNKNOWN_NEEDED : ESTIMATE_REASON, `${tag} ${id}`);
            assert.notEqual(f.state, 'paid', `${tag}: ${id} not shown retired as paid outside the current period`);
            const fb = periodFace[periodKeys.indexOf('commitment:' + id)];
            assert.equal(fb.paid, 'Paid Unknown', `${tag}: ${id} window does not borrow today's Paid`);
            assert.equal(fb.stf, 'Still to fund ' + faceGapText(amount), `${tag}: ${id} window prints that period's own gap`);
            assert.equal(fb.stfReason, period === 'historical' ? UNKNOWN_NEEDED : ESTIMATE_REASON, `${tag}: ${id} window keeps the reason`);
          }
        };
        await selectPeriod(wheel.current - 1);
        await expectPeriod('historical');
        await selectPeriod(wheel.current + 1);
        await expectPeriod('next');
        await selectPeriod(wheel.current + 2);
        await expectPeriod('future');
        await selectPeriod(wheel.current);
        const restored = await factsById();
        for (const goal of goals) {
          assertGap(restored[goal.id], expect[goal.id].stf, expect[goal.id].stfReason, `${mode} ${width} current restored: ${goal.id}`);
          assert.equal(restored[goal.id].state, expect[goal.id].state, `${mode} ${width} current restored: ${goal.id} state`);
        }
        rows.A9.push(`${mode} ${width}: historical gaps Unknown with no stamps; projected-next/future match independent period gaps and retirement; current restored`);
      }
      // Clean main view: the household-facing rows print the name and
      // Saved against Needed only. Still to fund, its estimate mark and its
      // sentence were read in each row's window above (fb.stf, fb.stfReason).
      const faceText = await tile.locator('[data-blend-goals]').evaluate(n => n.textContent.replace(/\s+/g, ' '));
      assert.doesNotMatch(faceText, /Still to fund|Estimate:|planning gap/, `${mode} ${width}: no explainer wording on the visible rows`);
      for (const goal of goals) {
        const fb = face[keys.indexOf(goal.key)];
        assert.ok(fb.row.startsWith(goal.label), `${mode} ${width} ${goal.label}: visible row is named`);
        // Only a goal whose hand-oracle state is paid may say Paid on its row.
        assert.equal(/Paid/.test(fb.row), expect[goal.id].state === 'paid', `${mode} ${width} ${goal.label}: Paid on the row only when paid`);
      }
      assert.equal(await page.evaluate(() => JSON.stringify(App.data)), before, `${mode} ${width}: App.data unchanged`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode} ${width}: no horizontal overflow`);
      await tile.screenshot({ path: path.join(out, `${mode}-${width}.png`), animations: 'disabled' });
      if (mode === 'evidence' || mode === 'gap') rows.A3.push(`${mode} ${width}: partial Paid + Saved join (${mode === 'evidence' ? 'B paid 0.25 + saved 0.75, STF $0.00' : 'D paid 0.25 + saved 0.375, STF $30.00'})`);
      if (mode === 'evidence') rows.A4.push(`${width}: A fully paid row fill 1.0 ${facts['goal-a'].paidColor}; face ${face[keys.indexOf('commitment:goal-a')].band} ratio ${face[keys.indexOf('commitment:goal-a')].ratio} ${face[keys.indexOf('commitment:goal-a')].fill}; STF $0.00`);
      if (mode === 'absent' || mode === 'uncertain') rows.A9.push(`${mode} ${width}: ${goals.map(g => g.id + ' ' + facts[g.id].paid + '/' + facts[g.id].stf + '/' + facts[g.id].state).join('; ')}`);
      cases.push({ width, mode, keys, facts });
      console.log('PASS ' + mode + ' ' + width);
      await page.close();
    }
    // Owner live walk (#821 6785886971 item 3): a goal Forecast publishes no
    // payment facts for. On the invented Budget-surface household neither
    // goal carries a Paid / Still-to-fund block, so the window says that in
    // words and prints neither line. No figure is invented.
    for (const width of [1440, 390]) {
      const data = require('./fixtures/budget-surface-data').served();
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) { external.push(url.origin); return route.abort(); }
        if (route.request().method() !== 'GET') { writes.push(route.request().method()); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto(ORIGIN + '/');
      const tile = page.locator('[data-budget-savings-goals]'); await tile.waitFor();
      const source = tile.locator('[data-budget-savings-goal]').first();
      assert.equal(await source.locator('[data-budget-goal-paid-progress]').count(), 0, `no-facts ${width}: the invented goal carries no payment block`);
      const row = tile.locator('button.blend-goal-row').first();
      await row.evaluate(node => node.click());
      const explain = page.locator('dialog[data-blend-explain][open]');
      await explain.waitFor();
      const text = (await explain.innerText()).replace(/\s+/g, ' ').trim();
      assert.match(text, /Paid and Still to fund are not tracked for this goal\./, `no-facts ${width}: the window says so in words`);
      assert.equal(await explain.locator('[data-blend-explain-fact="paid"], [data-blend-explain-fact="still-to-fund"]').count(), 0, `no-facts ${width}: no Paid or Still-to-fund line is printed`);
      assert.doesNotMatch(text, /\$\d/, `no-facts ${width}: no figure is invented where none is published`);
      assert.match(text, /Top-up this period Unavailable/, `no-facts ${width}: the unavailable top-up carries its own label`);
      await page.keyboard.press('Escape');
      console.log('PASS no-facts ' + width);
      await page.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  // A4 requires the 390px face/bar observation specifically.
  assert.ok(rows.A4.some(r => r.startsWith('390:')), 'A4: 390px fully paid face/bar observed');
  fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ head, synthetic: true, observationAsOf: OBSERVATION_AS_OF, linkEffective: LINK_EFFECTIVE, rows, served, cases, errors, external, writes }, null, 2) + '\n');
  for (const [row, list] of Object.entries(rows)) for (const r of list) console.log(`ROW ${row} PASS ${r}`);
  console.log('PASS all ' + cases.length + ' cases');
})().catch(e => { console.error(e); process.exitCode = 1; });
