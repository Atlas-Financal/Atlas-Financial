'use strict';
// Real native selection while a mouse/touch gesture is still held. Synthetic
// fixture data only; expected dates come from native publications, not this port.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const riverHarnessHtml = theme => '<!doctype html><html data-theme="' + theme + '"><head><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/budget-blend.css"><link rel="stylesheet" href="/budget-gface.css"><script src="/app.js"></script><script src="/budget-river.js"></script></head><body></body></html>';

async function proveRiverPort({ open, capture }) {
  const cases = [];
  for (const width of [1440, 935, 390, 320]) for (const theme of ['light', 'dark']) {
    const data = width === 935 ? require('./fixtures/budget-surface-data').served() : null;
    if (data) for (let i = 0; i < 24; i++) data.plan.bills.push({id:'stress-bill-'+i,label:'Synthetic recurring bill '+i,
      frequency:'monthly',day:i+1,amount:12+i,confidence:'confirmed',payingAccount:'chequing-a'});
    const page = await open(width, theme, data ? { data } : {});
    // Opacity rounds to 1 before the finite entrance transform finishes.
    // Measure only the settled tile; keep the exact geometry assertions below.
    await page.waitForFunction(() => {
      const tile = document.querySelector('.t-river');
      return tile && Number(getComputedStyle(tile).opacity) === 1
        && tile.getAnimations().filter(a => a.effect && Number.isFinite(a.effect.getTiming().iterations))
          .every(a => a.playState === 'finished');
    }, null, { timeout: 5000 });
    const before = await page.evaluate(width => {
      const river = document.querySelector('.river');
      const selected = Number(river.getAttribute('aria-valuenow')) - 1;
      const rows = [...document.querySelector('ol[data-bad-timeline]').children];
      const target = rows[selected + 1];
      window.__heldRiverElement = river;
      window.__heldRiverLabels = [...river.querySelectorAll('.rv')];
      window.__heldAurora = document.querySelector('.blend-aurora');
      window.__heldFocusEvents = [];
      document.addEventListener('focusin', e => {
        if (e.target.closest('[data-budget-wheel]')) window.__heldFocusEvents.push(e.target.className);
      });
      const label = river.querySelector('.rv.is-sel').getBoundingClientRect();
      const rect = river.getBoundingClientRect(), mobile = rect.width < 640;
      const fit = (rect.width - (mobile ? 52 : 72)) / (rows.length - 1);
      const pan = fit < (mobile ? 44 : 52);
      return { selected, height: rect.height, radius: getComputedStyle(river.parentElement).borderRadius,
        theme: river.parentElement.dataset.riverTheme, start: target.dataset.badTimelineStart,
        period: target.dataset.badTimelinePeriod, range: target.dataset.badTimelineRangeLabel,
        x: label.left + label.width / 2, y: label.top + label.height / 2,
        spacing: pan ? (mobile ? 44 : 52) : fit, pan };
    }, width);
    // Owner-approved shorter tile (Atlas decision, 2026-10-10): 123px desktop /
  // 114px mobile. The prototype fixture below keeps the original 164/152.
  assert.equal(before.height, width < 760 ? 114 : 123, 'approved tile height');
    assert.equal(before.radius, width < 760 ? '24px' : '28px', 'source radius');
    assert.equal(before.theme, theme);
    await page.mouse.move(before.x, before.y); await page.mouse.down();
    // Original gesture directions differ between fitting and panning ranges.
    await page.mouse.move(before.x + (before.pan ? -before.spacing : before.spacing), before.y, { steps: 8 });
    await page.waitForFunction(start => document.querySelector('[data-budget-window-progress]')?.dataset.start === start, before.start);
    const held = await page.evaluate(() => ({
      start: document.querySelector('[data-budget-window-progress]').dataset.start,
      period: document.querySelector('.blend-hero [data-bad-terms]').dataset.badTermsPeriod,
      range: document.querySelector('.blend-hero-range').textContent.replace(/\s+/g, ' ').trim(),
      dragging: document.querySelector('.river').classList.contains('is-dragging'),
      sameElement: document.querySelector('.river') === window.__heldRiverElement,
      sameLabels: [...document.querySelectorAll('.river .rv')].every((node, i) => node === window.__heldRiverLabels[i]),
      sameAurora: document.querySelector('.blend-aurora') === window.__heldAurora,
      hiddenWheelFocus: window.__heldFocusEvents.length,
      opacity: Number(getComputedStyle(document.querySelector('.t-river')).opacity),
      nativeAmount: document.querySelector('.blend-hero [data-bad-term="balanceAfterDeductions"] [data-bad-term-amount]').textContent,
    }));
    assert.equal(held.start, before.start, 'native date changes before release');
    assert.equal(held.period, before.period, 'hero prints the selected native period before release');
    assert.equal(held.range.replace(/\s/g, ''), before.range.replace(/\s/g, ''), 'visible tile date agrees before release');
    assert.equal(held.dragging, true, 'gesture remains held across native remount');
    assert.equal(held.sameElement, true, 'original controller survives native remount');
    assert.equal(held.sameLabels, true, 'held selection retains the original label nodes without rebuilding the year');
    assert.equal(held.sameAurora, true, 'held selection retains the original WebGL canvas');
    assert.equal(held.hiddenWheelFocus, 0, 'held selection never focuses the hidden native chooser');
    assert.equal(held.opacity, 1, 'native remount does not replay the entrance while held');
    // Keep the same gesture held through a second native tile replacement.
    const second = await page.evaluate(i => {
      const row = document.querySelector('ol[data-bad-timeline]').children[i];
      return { start: row.dataset.badTimelineStart, period: row.dataset.badTimelinePeriod };
    }, before.selected + 2);
    await page.mouse.move(before.x + (before.pan ? -2 : 2) * before.spacing, before.y, { steps: 8 });
    await page.waitForFunction(start => document.querySelector('[data-budget-window-progress]')?.dataset.start === start, second.start);
    assert.equal(await page.evaluate(() => document.querySelector('.river') === window.__heldRiverElement && document.querySelectorAll('.g-river-wrap').length === 1), true);
    assert.equal(await page.locator('.t-river').evaluate(el=>Number(getComputedStyle(el).opacity)),1,'second held remount stays visible');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.river .rv')].every((node, i) => node === window.__heldRiverLabels[i])
      && document.querySelector('.blend-aurora') === window.__heldAurora && window.__heldFocusEvents.length === 0), true, 'second held update retains artwork and label nodes without hidden focus');
    // Cancellation aligns with the last actual native publication, without fling.
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.river').classList.contains('is-dragging'));
    assert.equal(await page.locator('[data-budget-window-progress]').getAttribute('data-start'), second.start);
    assert.equal(await page.evaluate(() => document.querySelector('.river') === document.activeElement), true, 'cancelled gesture keeps visible selector focus');
    await page.locator('.river').focus(); await page.keyboard.press('t');
    await page.waitForFunction(() => document.querySelector('ol[data-bad-timeline] > [data-bad-timeline-role="current"]')?.dataset.badTimelineStart === document.querySelector('[data-budget-window-progress]')?.dataset.start);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[data-blend-river-today]')?.classList.contains('on'));
    await page.locator('[data-blend-river-today]').click();
    await page.waitForFunction(() => !document.querySelector('[data-blend-river-today]')?.classList.contains('on'));
    let touch = null;
    if (width === 390) {
      await page.waitForFunction(() => document.querySelector('.river')?.dataset.riverMotion === 'settled');
      const point = await page.evaluate(() => {const river=document.querySelector('.river'),b=river.querySelector('.rv.is-sel').getBoundingClientRect(),rows=[...document.querySelector('ol[data-bad-timeline]').children],i=+river.getAttribute('aria-valuenow')-1;return{x:b.left+b.width/2,y:b.top+b.height/2,start:rows[i+1].dataset.badTimelineStart}});
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});
      await page.evaluate(()=>{window.__touchTrace=[];for(const type of ['pointerdown','pointermove','pointercancel','lostpointercapture'])window.addEventListener(type,e=>__touchTrace.push([type,e.pointerId,e.clientX,e.clientY,e.target.className]))});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});
      for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x-step*44/8,y:point.y}]});
      await page.waitForFunction(start=>document.querySelector('[data-budget-window-progress]')?.dataset.start===start,point.start);
      assert.equal(await page.locator('.river').evaluate(el=>el.classList.contains('is-dragging')),true,'touch updates before release: '+JSON.stringify(await page.evaluate(()=>__touchTrace)));
      await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
      await page.waitForFunction(()=>!document.querySelector('.river').classList.contains('is-dragging'));
      assert.equal(await page.locator('[data-budget-window-progress]').getAttribute('data-start'),point.start);
      await cdp.detach();touch={nativeBeforeRelease:true,cancelPreservesNative:true};
      await page.keyboard.press('t');
    }
    cases.push({ width, theme, dragFromAmount: true, beforeRelease: held, secondHeldPublication: second, cancelPreservesNative: true, returnCurrent: true, touch });
    await page.waitForFunction(() => document.querySelector('.river')?.dataset.riverMotion === 'settled');
    await page.evaluate(()=>window.scrollTo(0,0));
    if (capture) await capture(page, 'budget-river-port-' + width + '-' + theme + '.png');
    if (width === 935) {
      const beforeRefresh = await page.evaluate(() => {
        const labels = [...document.querySelectorAll('.river .rv')];
        window.__beforeRefreshLabels = labels;
        window.__beforeRefreshCanvas = document.querySelector('.river canvas');
        const old = labels.map(node => node.dataset.riverNativeValue).join('|');
        // Invented fixture change, passed through the real App -> Forecast ->
        // native printer path. Same dates must not make retained labels stale.
        App.data.plan.income[0].amount += 111.11;
        App.rerender(); return old;
      });
      await page.waitForFunction(old => [...document.querySelectorAll('.river .rv')].map(node => node.dataset.riverNativeValue).join('|') !== old, beforeRefresh);
      const refreshed = await page.evaluate(() => {
        const labels = [...document.querySelectorAll('.river .rv')];
        const rows = [...document.querySelector('ol[data-bad-timeline]').children];
        return { sameCanvas: document.querySelector('.river canvas') === window.__beforeRefreshCanvas,
          rebuiltLabels: labels.some((node,i) => node !== window.__beforeRefreshLabels[i]),
          faithful: labels.every((node,i) => (['calculated','estimated'].includes(rows[i]?.dataset.badTermTrust)
            ? rows[i].querySelector('[data-bad-term-amount]')?.textContent.replace(/\s+/g,' ').trim() : 'Unavailable') === node.dataset.riverNativeValue) };
      });
      assert.deepEqual(refreshed, { sameCanvas:true, rebuiltLabels:true, faithful:true }, 'new same-date native publication replaces stale labels without discarding the canvas');
      cases.at(-1).publicationRefresh = refreshed;
    }
    for(let cycle=0;cycle<3;cycle++) {
      await page.locator('[data-blend-theme]').click();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      if(await page.locator('.t-river').getAttribute('data-river-theme')!==theme)break;
    }
    await page.waitForFunction(theme=>document.querySelector('.t-river')?.dataset.riverTheme!==theme,theme);
    for(let cycle=0;cycle<3;cycle++) {
      await page.locator('[data-blend-theme]').click();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      if(await page.locator('.t-river').getAttribute('data-river-theme')===theme)break;
    }
    await page.waitForFunction(theme=>document.querySelector('.t-river')?.dataset.riverTheme===theme,theme);
    await page.evaluate(()=>document.documentElement.removeAttribute('data-theme'));
    await page.emulateMedia({colorScheme:theme==='dark'?'light':'dark'});
    await page.waitForFunction(theme=>document.querySelector('.t-river')?.dataset.riverTheme!==theme,theme);
    await page.close();
  }
  const paired = await proveOriginal({ open, capture });
  const yielded = await proveYieldedNeighbourReselect({ open });
  const displaced = await proveDisplacedLabelHitTargeting({ open });
  const heldPress = await proveHeldPressNonPanTargeting({ open });
  return { nativeLiveDrag: cases, originalComparison: paired, yieldedNeighbourReselect: yielded, displacedLabelHitTargeting: displaced, heldPressNonPanTargeting: heldPress };
}

// Regression (Systems Review 5480635465): place() skipped the selected label
// before clearing yielded opacity. Selecting the minimum faded the adjacent
// adjacent label to opacity 0; selecting that label next retained its node
// (mark/adopt keep the label nodes) but left it invisible — rectangle checks
// pass on invisible text, so this regression asserts COMPUTED opacity
// through the whole sequence: pointer, keyboard, reduced motion, and a
// retained-node adopt() remount.
async function proveYieldedNeighbourReselect({ open }) {
  // Retain a genuinely yielded neighbour after the ordinary short-label fix:
  // index 2 is deliberately wide enough to overlap the minimum's orb already.
  // The ordinary $150 case remains in the geometry proof and must stay visible.
  // Scientific notation keeps this synthetic amount distinct from identifier-shaped text.
  const bads = [300, -420, 8.888888888888888e15, -80, 640, -260, 90, 480, -150, 720, 210, -40];
  const MIN = 1, NEIGHBOUR = 2;
  const cases = [];
  const setup = async (width, theme, options = {}) => {
    const page = await open(width, theme, { riverHarness: true, ...options });
    await page.waitForFunction(() => typeof window.BudgetRiver !== 'undefined');
    await page.evaluate(bads => {
      document.body.innerHTML = '<main id="river-yield" style="padding:12px"></main>';
      const host = document.querySelector('main');
      const tree = '<nav class="tile t-river"><div class="river" tabindex="0"><canvas class="river-canvas"></canvas><div class="river-slide"><div class="river-vals"></div><div class="months"></div></div><div class="playhead"><div class="playhead-pill"><span>Test publication</span><b>$0.00</b></div><span class="playhead-beam"></span><span class="playhead-orb"></span></div></div></nav>';
      const section = document.createElement('section');
      section.className = 'budget-bento atlas-g';
      section.innerHTML = '<div class="g-river-wrap">' + tree + '</div>';
      host.appendChild(section);
      const fmt = v => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return a >= 999.5 ? s + '$' + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : s + '$' + Math.round(a); };
      const periods = bads.map((bad, i) => ({
        start: '2026-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '15' : '01'),
        end: '2026-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '28' : '14'),
        bad, state: bad < 0 ? 'short' : 'healthy', role: i < 4 ? 'past' : i === 4 ? 'current' : 'future',
      }));
      const el = section.querySelector('.river');
      const opts = {
        el, canvas: section.querySelector('canvas'), playhead: section.querySelector('.playhead'),
        pill: section.querySelector('.playhead-pill'), slide: section.querySelector('.river-slide'),
        monthsEl: section.querySelector('.months'), valsEl: section.querySelector('.river-vals'),
        periods, index: 4, cur: 4, enabled: true, dark: document.documentElement.dataset.theme === 'dark',
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, noIntro: true, fmt,
        knownRuns: [periods.map((_, i) => i)], onChange: () => {},
      };
      window.__yieldOpts = opts;
      window.__yieldRiver = BudgetRiver.create(opts);
      window.__yieldRiver.place(4);
    }, bads);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.t-river')).opacity === '1');
    await page.waitForFunction(() => window.__yieldRiver.head.settled && window.__yieldRiver.index === 4);
    return page;
  };
  const settledAt = (page, k) => page.waitForFunction(k => {
    const r = window.__yieldRiver; return r.index === k && r.head.settled;
  }, k, { timeout: 5000 });
  // Computed opacity is the assertion surface. Poll for the wanted value; on
  // timeout return the actual value so the failure message names it.
  const computedOpacity = async (page, k, want) => {
    await page.waitForFunction(([k, want]) => getComputedStyle(window.__yieldRiver.valEls[k]).opacity === want,
      [k, want], { timeout: 4000 }).catch(() => {});
    return page.evaluate(k => getComputedStyle(window.__yieldRiver.valEls[k]).opacity, k);
  };
  const clickLabel = async (page, k) => {
    const point = await page.evaluate(k => {
      const b = window.__yieldRiver.valEls[k].getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, k);
    await page.mouse.click(point.x, point.y);
    await settledAt(page, k);
  };
  const runSequence = async (page, select, label) => {
    await select(MIN);
    const hiddenNeighbour = await computedOpacity(page, NEIGHBOUR, '0');
    assert.equal(hiddenNeighbour, '0', label + ': selecting the minimum must yield (hide) the wide adjacent label; computed opacity ' + hiddenNeighbour);
    const minSelected = await computedOpacity(page, MIN, '1');
    assert.equal(minSelected, '1', label + ': the selected minimum label itself must be visible; computed opacity ' + minSelected);
    await select(NEIGHBOUR);
    const reselected = await computedOpacity(page, NEIGHBOUR, '1');
    assert.equal(reselected, '1', label + ': the newly selected label must compute opacity 1 after being yielded; got ' + reselected);
    const state = await page.evaluate(k => ({
      inline: window.__yieldRiver.valEls[k].style.opacity,
      yielded: window.__yieldRiver._yielded ? window.__yieldRiver._yielded.has(window.__yieldRiver.valEls[k]) : null,
    }), NEIGHBOUR);
    assert.equal(state.inline, '', label + ': the selected label inline opacity must be cleared');
    assert.equal(state.yielded, false, label + ': the selected label must be removed from the yielded set');
    return { afterMinSelectNeighbourComputed: hiddenNeighbour, afterReselectNeighbourComputed: reselected, inlineCleared: true, removedFromYielded: true };
  };
  for (const width of [390, 320]) for (const theme of ['dark', 'light']) {
    const page = await setup(width, theme);
    const pointer = await runSequence(page, k => clickLabel(page, k), 'yield/pointer/' + width + '/' + theme);
    // Keyboard: arrows step one period per press through the same go() path.
    await page.locator('.river').focus();
    await page.keyboard.press('ArrowLeft'); await settledAt(page, MIN);
    const kbHidden = await computedOpacity(page, NEIGHBOUR, '0');
    assert.equal(kbHidden, '0', 'yield/keyboard/' + width + '/' + theme + ': the minimum must re-yield the neighbour; computed opacity ' + kbHidden);
    await page.keyboard.press('ArrowRight'); await settledAt(page, NEIGHBOUR);
    const kbShown = await computedOpacity(page, NEIGHBOUR, '1');
    assert.equal(kbShown, '1', 'yield/keyboard/' + width + '/' + theme + ': the newly selected label must compute opacity 1; got ' + kbShown);
    const keyboard = { afterMinSelectNeighbourComputed: kbHidden, afterReselectNeighbourComputed: kbShown };
    // Retained-node remount: adopt() on the unchanged publication keeps the
    // canvas and every label node; the sequence must still restore opacity.
    await page.evaluate(() => { window.__yieldNodes = [...window.__yieldRiver.valEls]; });
    await page.evaluate(() => {
      const r = window.__yieldRiver;
      r.adopt({ ...window.__yieldOpts, index: r.index, cur: r.index });
    });
    await page.waitForFunction(() => window.__yieldRiver.head.settled);
    const remountSeq = await runSequence(page, k => clickLabel(page, k), 'yield/remount/' + width + '/' + theme);
    const retained = await page.evaluate(() => window.__yieldRiver.valEls.every((el, i) => el === window.__yieldNodes[i]));
    assert.equal(retained, true, 'yield/remount/' + width + '/' + theme + ': adopt() must retain the original label nodes');
    cases.push({ width, theme, pointer, keyboard, remount: { ...remountSeq, nodesRetainedAcrossAdopt: retained } });
    await page.close();
  }
  // Reduced motion: same sequence with an instant head (go() sets, no spring).
  {
    const page = await setup(390, 'dark', { reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => window.__yieldRiver.reduce), true, 'yield/reduced-motion: controller must be in reduced-motion mode');
    const reducedMotion = await runSequence(page, k => clickLabel(page, k), 'yield/reduced-motion/390/dark');
    cases.push({ width: 390, theme: 'dark', reducedMotion });
    await page.close();
  }
  return cases;
}

// Regression (Systems Review 5481562226, Codex discussion_r4239927349):
// place() steps a selected bottom-edge label sideways clear of the orb — on
// the mobile panning layout by ~30px, more than half the 44px period
// spacing — but tap and hover resolution mapped the raw coordinate through
// fOfScreen, so a pointer over the visibly displaced label resolved to the
// neighbouring period. The fix records the stepped label's visible box in
// place() and routes discrete resolution (tap, hover) through hitIndex().
// This regression works from the label's RENDERED box: it first asserts
// the displacement really enters the neighbour's raw hit region
// (dx > sp/2 — without that precondition the raw mapping would still
// resolve correctly and the regression would prove nothing), then asserts
// a mouse tap and a touch tap on the visible centre keep the label's own
// period selected, hover over it resolves to its own period, the
// neighbouring period stays selectable at its own centre (the point the
// stepped label's tail covers — the round-3 yield sequence's click), and
// the keyboard path is unaffected. On the pre-fix code the tap selects
// period 2 and hover reports 2.
async function proveDisplacedLabelHitTargeting({ open }) {
  // Same invented publication as the yield regression: index 1 is the
  // minimum (-420, on the band's bottom edge) whose selected label steps
  // aside; index 2 is the neighbour its visible centre lands on.
  const bads = [300, -420, 8.888888888888888e15, -80, 640, -260, 90, 480, -150, 720, 210, -40];
  const MIN = 1, NEIGHBOUR = 2;
  const cases = [];
  const setup = async (width, theme, options = {}) => {
    const page = await open(width, theme, { riverHarness: true, ...options });
    await page.waitForFunction(() => typeof window.BudgetRiver !== 'undefined');
    await page.evaluate(bads => {
      document.body.innerHTML = '<main id="river-hit" style="padding:12px"></main>';
      const host = document.querySelector('main');
      const tree = '<nav class="tile t-river"><div class="river" tabindex="0"><canvas class="river-canvas"></canvas><div class="river-slide"><div class="river-vals"></div><div class="months"></div></div><div class="playhead"><div class="playhead-pill"><span>Test publication</span><b>$0.00</b></div><span class="playhead-beam"></span><span class="playhead-orb"></span></div></div></nav>';
      const section = document.createElement('section');
      section.className = 'budget-bento atlas-g';
      section.innerHTML = '<div class="g-river-wrap">' + tree + '</div>';
      host.appendChild(section);
      const fmt = v => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return a >= 999.5 ? s + '$' + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : s + '$' + Math.round(a); };
      const periods = bads.map((bad, i) => ({
        start: '2026-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '15' : '01'),
        end: '2026-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '28' : '14'),
        bad, state: bad < 0 ? 'short' : 'healthy', role: i < 4 ? 'past' : i === 4 ? 'current' : 'future',
      }));
      const el = section.querySelector('.river');
      window.__hitChanges = [];
      window.__hitRiver = BudgetRiver.create({
        el, canvas: section.querySelector('canvas'), playhead: section.querySelector('.playhead'),
        pill: section.querySelector('.playhead-pill'), slide: section.querySelector('.river-slide'),
        monthsEl: section.querySelector('.months'), valsEl: section.querySelector('.river-vals'),
        periods, index: 4, cur: 4, enabled: true, dark: document.documentElement.dataset.theme === 'dark',
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, noIntro: true, fmt,
        knownRuns: [periods.map((_, i) => i)], onChange: (i, how) => window.__hitChanges.push({ i, how }),
      });
      window.__hitRiver.place(4);
    }, bads);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.t-river')).opacity === '1');
    await page.waitForFunction(() => window.__hitRiver.head.settled && window.__hitRiver.index === 4);
    return page;
  };
  const settledAt = (page, k) => page.waitForFunction(k => {
    const r = window.__hitRiver; return r.index === k && r.head.settled && r._lastF === k;
  }, k, { timeout: 5000 }).catch(() => {});
  const labelCentre = (page, k) => page.evaluate(k => {
    const b = window.__hitRiver.valEls[k].getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, k);
  // The displaced selected label's rendered centre vs its data centre.
  const displaced = async (page, label) => {
    const st = await page.evaluate(k => {
      const r = window.__hitRiver, elB = r.el.getBoundingClientRect(), b = r.valEls[k].getBoundingClientRect();
      return { index: r.index, pan: r.pan, sp: r.sp,
        cx: b.left + b.width / 2, cy: b.top + b.height / 2,
        dx: (b.left + b.width / 2) - (elB.left + r.xs[k] - r.off) };
    }, MIN);
    assert.equal(st.index, MIN, label + ': the minimum must be selected before its label can displace');
    assert.equal(st.pan, true, label + ': the fixture must be on the mobile panning layout');
    assert.ok(st.dx > st.sp / 2, label + ': the selected label must be displaced into the neighbouring hit region (dx ' + st.dx.toFixed(1) + 'px vs half-spacing ' + (st.sp / 2) + 'px)');
    return st;
  };
  const tapKeepsMin = async (page, tap, label) => {
    const st = await displaced(page, label);
    await page.evaluate(() => { window.__hitChanges = []; });
    await tap(st);
    await settledAt(page, MIN);
    const after = await page.evaluate(() => ({ index: window.__hitRiver.index, changes: window.__hitChanges.slice() }));
    assert.equal(after.index, MIN, label + ': tapping the displaced selected label must keep its own period selected; got index ' + after.index);
    assert.ok(after.changes.every(c => c.i === MIN), label + ': the tap must not publish another period ' + JSON.stringify(after.changes));
    return { displacementPx: Number(st.dx.toFixed(1)), spacingPx: st.sp };
  };
  for (const width of [390, 320]) for (const theme of ['dark', 'light']) {
    const page = await setup(width, theme);
    const label = 'hit/mouse/' + width + '/' + theme;
    // Select the minimum by clicking its (still undisplaced) label.
    const natural = await labelCentre(page, MIN);
    await page.mouse.click(natural.x, natural.y);
    await settledAt(page, MIN);
    assert.equal(await page.evaluate(() => window.__hitRiver.index), MIN, label + ': clicking the minimum label must select it');
    // Tap on the displaced label's visible centre keeps its own period.
    const tap = await tapKeepsMin(page, s => page.mouse.click(s.cx, s.cy), label + '/tap');
    // Hover over the displaced label resolves to its own period.
    const st = await displaced(page, label + '/hover');
    await page.mouse.move(st.cx, st.cy);
    await page.waitForFunction(k => window.__hitRiver.hover === k, MIN, { timeout: 4000 }).catch(() => {});
    const hover = await page.evaluate(() => ({ hover: window.__hitRiver.hover,
      marks: window.__hitRiver.valEls.map(e => e.classList.contains('is-hover')) }));
    assert.equal(hover.hover, MIN, label + ': hover over the displaced label must resolve to its own period; got ' + hover.hover);
    assert.ok(hover.marks[MIN] && !hover.marks[NEIGHBOUR], label + ': the displaced label itself must carry the hover mark ' + JSON.stringify(hover.marks));
    // The neighbouring period stays selectable at its own centre, even
    // though the stepped label's tail covers that point and its own label
    // is currently yielded: the neighbour's centre is nearer that point
    // than the stepped label's visible centre.
    const neighbourCentre = await labelCentre(page, NEIGHBOUR);
    await page.mouse.click(neighbourCentre.x, neighbourCentre.y);
    await settledAt(page, NEIGHBOUR);
    assert.equal(await page.evaluate(() => window.__hitRiver.index), NEIGHBOUR, label + ': clicking the neighbouring period centre must select it');
    // Keyboard: arrows still step one period each way from the selection.
    await page.locator('.river').focus();
    await page.keyboard.press('ArrowLeft'); await settledAt(page, MIN);
    assert.equal(await page.evaluate(() => window.__hitRiver.index), MIN, label + ': ArrowLeft must step back to the minimum');
    await page.keyboard.press('ArrowRight'); await settledAt(page, NEIGHBOUR);
    assert.equal(await page.evaluate(() => window.__hitRiver.index), NEIGHBOUR, label + ': ArrowRight must step to the neighbour');
    cases.push({ width, theme, input: 'mouse', displacementPx: tap.displacementPx, spacingPx: tap.spacingPx, tapKeptSelection: true, hoverResolvedToOwnPeriod: true, neighbourSelectableAtOwnCentre: true, keyboard: { left: MIN, right: NEIGHBOUR } });
    await page.close();
  }
  // Touch: a tap is pointerdown/pointerup with no move; the same end()
  // resolution must honour the displaced label's visible box.
  for (const [width, theme] of [[390, 'dark'], [320, 'light']]) {
    const page = await setup(width, theme, { hasTouch: true });
    const label = 'hit/touch/' + width + '/' + theme;
    const natural = await labelCentre(page, MIN);
    await page.touchscreen.tap(natural.x, natural.y);
    await settledAt(page, MIN);
    assert.equal(await page.evaluate(() => window.__hitRiver.index), MIN, label + ': tapping the minimum label must select it');
    const tap = await tapKeepsMin(page, s => page.touchscreen.tap(s.cx, s.cy), label);
    cases.push({ width, theme, input: 'touch', displacementPx: tap.displacementPx, spacingPx: tap.spacingPx, tapKeptSelection: true });
    await page.close();
  }
  // Reduced motion: instant head, same tap resolution.
  {
    const page = await setup(390, 'dark', { reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => window.__hitRiver.reduce), true, 'hit/reduced-motion: controller must be in reduced-motion mode');
    const label = 'hit/reduced-motion/390/dark';
    const natural = await labelCentre(page, MIN);
    await page.mouse.click(natural.x, natural.y);
    await settledAt(page, MIN);
    const tap = await tapKeepsMin(page, s => page.mouse.click(s.cx, s.cy), label);
    cases.push({ width: 390, theme: 'dark', reducedMotion: { displacementPx: tap.displacementPx, tapKeptSelection: true } });
    await page.close();
  }
  return cases;
}

// Regression (Systems Review 5481846544): round 4 fixed the IMMEDIATE tap
// on a displaced selected label, but a STATIONARY HELD PRESS in non-pan
// (fit) layouts still selected the neighbour. Mechanism: in a non-pan
// layout pointerdown aims the spring at the RAW fractional position
// (fOfScreen of the press point — 1.546 at the displaced centre here);
// the spring/place motion during the hold travels to that fraction, the
// selected label un-steps as the playhead leaves the band's bottom edge,
// and place() clears the stepped label's hit box; pointerup then
// re-resolved the release coordinate against the changed geometry and
// committed the neighbouring period. The round-4 regression runs on the
// panning layout (pan=true), where pointerdown never moves the spring,
// so it cannot see this path. This regression uses the same invented
// 12-point publication at 700px — element width 676, fit spacing ~54.9px
// >= the 52px desktop minimum, so the layout is non-pan (fit mode). It
// asserts the mis-target precondition from the RENDERED box (displaced
// centre's raw fraction rounds to the neighbour), holds the press for
// over a second while asserting the spring really travelled to the raw
// fraction and the hit box really cleared (the defect's mechanism, true
// before and after the fix), then asserts the release still commits the
// pressed label's own period — for mouse and touch, both themes. A
// held-press-then-drag case proves the continuous drag still takes over
// once movement begins: the release must commit the DRAG's resting
// period, not the press-time target. On the pre-fix code the held press
// commits index 2 and this regression fails on its first case.
async function proveHeldPressNonPanTargeting({ open }) {
  const bads = [300, -420, 8.888888888888888e15, -80, 640, -260, 90, 480, -150, 720, 210, -40];
  const MIN = 1, NEIGHBOUR = 2;
  const HOLD_MS = 1100;
  const cases = [];
  const setup = async (width, theme, options = {}) => {
    const page = await open(width, theme, { riverHarness: true, ...options });
    await page.waitForFunction(() => typeof window.BudgetRiver !== 'undefined');
    await page.evaluate(bads => {
      document.body.innerHTML = '<main id="river-held" style="padding:12px"></main>';
      const host = document.querySelector('main');
      const tree = '<nav class="tile t-river"><div class="river" tabindex="0"><canvas class="river-canvas"></canvas><div class="river-slide"><div class="river-vals"></div><div class="months"></div></div><div class="playhead"><div class="playhead-pill"><span>Test publication</span><b>$0.00</b></div><span class="playhead-beam"></span><span class="playhead-orb"></span></div></div></nav>';
      const section = document.createElement('section');
      section.className = 'budget-bento atlas-g';
      section.innerHTML = '<div class="g-river-wrap">' + tree + '</div>';
      host.appendChild(section);
      const fmt = v => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return a >= 999.5 ? s + '$' + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : s + '$' + Math.round(a); };
      const periods = bads.map((bad, i) => ({
        start: '2026-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '15' : '01'),
        end: '2026-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + '-' + (i % 2 ? '28' : '14'),
        bad, state: bad < 0 ? 'short' : 'healthy', role: i < 4 ? 'past' : i === 4 ? 'current' : 'future',
      }));
      const el = section.querySelector('.river');
      window.__heldChanges = [];
      window.__heldRiver = BudgetRiver.create({
        el, canvas: section.querySelector('canvas'), playhead: section.querySelector('.playhead'),
        pill: section.querySelector('.playhead-pill'), slide: section.querySelector('.river-slide'),
        monthsEl: section.querySelector('.months'), valsEl: section.querySelector('.river-vals'),
        periods, index: 4, cur: 4, enabled: true, dark: document.documentElement.dataset.theme === 'dark',
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, noIntro: true, fmt,
        knownRuns: [periods.map((_, i) => i)], onChange: (i, how) => window.__heldChanges.push({ i, how }),
      });
      window.__heldRiver.place(4);
    }, bads);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.t-river')).opacity === '1');
    await page.waitForFunction(() => window.__heldRiver.head.settled && window.__heldRiver.index === 4);
    return page;
  };
  const settledAt = (page, k) => page.waitForFunction(k => {
    const r = window.__heldRiver; return r.index === k && r.head.settled;
  }, k, { timeout: 5000 }).catch(() => {});
  const labelCentre = (page, k) => page.evaluate(k => {
    const b = window.__heldRiver.valEls[k].getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, k);
  // Select the minimum, then measure its displaced label from the rendered
  // box and assert the fit-mode mis-target precondition.
  const displacedFit = async (page, label) => {
    const natural = await labelCentre(page, MIN);
    await page.mouse.click(natural.x, natural.y);
    await settledAt(page, MIN);
    const st = await page.evaluate(k => {
      const r = window.__heldRiver, elB = r.el.getBoundingClientRect(), b = r.valEls[k].getBoundingClientRect();
      const cxEl = (b.left + b.width / 2) - elB.left;
      return { index: r.index, pan: r.pan, sp: r.sp, cx: b.left + b.width / 2, cy: b.top + b.height / 2,
        dx: (b.left + b.width / 2) - (elB.left + r.xs[k] - r.off), rawF: r.fOfScreen(cxEl) };
    }, MIN);
    assert.equal(st.index, MIN, label + ': the minimum must be selected before its label can displace');
    assert.equal(st.pan, false, label + ': the 700px/12-point fixture must be a non-pan (fit) layout');
    assert.ok(st.dx > st.sp / 2, label + ': the selected label must be displaced into the neighbouring hit region (dx ' + st.dx.toFixed(1) + 'px vs half-spacing ' + (st.sp / 2).toFixed(1) + 'px)');
    assert.equal(Math.round(st.rawF), NEIGHBOUR, label + ': the displaced centre raw fraction must round to the neighbouring period (rawF ' + st.rawF.toFixed(3) + ')');
    return st;
  };
  const duringHold = async (page, label) => {
    const during = await page.evaluate(() => { const r = window.__heldRiver;
      return { index: r.index, dragging: r.dragging, headTarget: r.head.target, headX: r.head.x, stepBox: r._stepBox }; });
    assert.equal(during.dragging, true, label + ': the press must still be held');
    assert.equal(during.index, MIN, label + ': nothing may commit during a stationary hold; got index ' + during.index);
    assert.ok(during.headTarget > 1.5, label + ': the non-pan press must have aimed the spring at the raw fractional position (target ' + during.headTarget.toFixed(3) + ')');
    assert.ok(Math.abs(during.headX - during.headTarget) < 0.01, label + ': the spring must have travelled to the raw fraction during the hold (head ' + during.headX.toFixed(3) + ' vs target ' + during.headTarget.toFixed(3) + ')');
    assert.equal(during.stepBox, null, label + ': spring/place motion during the hold must have cleared the stepped hit box (the mechanism under repair)');
    return during;
  };
  const releasedKeepsMin = async (page, label) => {
    await settledAt(page, MIN);
    const after = await page.evaluate(() => ({ index: window.__heldRiver.index, changes: window.__heldChanges.slice() }));
    assert.equal(after.index, MIN, label + ': a stationary held press on the displaced selected label must keep its own period selected; got index ' + after.index);
    assert.ok(after.changes.every(c => c.i === MIN), label + ': the held press must not publish another period ' + JSON.stringify(after.changes));
    return after;
  };
  // Mouse held presses, both themes.
  for (const theme of ['dark', 'light']) {
    const page = await setup(700, theme);
    const label = 'held/mouse/700/' + theme;
    const st = await displacedFit(page, label);
    await page.evaluate(() => { window.__heldChanges = []; });
    await page.mouse.move(st.cx, st.cy);
    await page.mouse.down();
    await page.waitForTimeout(HOLD_MS);
    const during = await duringHold(page, label);
    await page.mouse.up();
    await releasedKeepsMin(page, label);
    cases.push({ width: 700, theme, input: 'mouse', layout: 'fit (non-pan)', holdMs: HOLD_MS,
      displacementPx: Number(st.dx.toFixed(1)), spacingPx: Number(st.sp.toFixed(1)), rawFractionAtCentre: Number(st.rawF.toFixed(3)),
      springTargetDuringHold: Number(during.headTarget.toFixed(3)), hitBoxClearedDuringHold: true, heldPressKeptSelection: true });
    await page.close();
  }
  // Touch held presses, both themes (CDP touch, the native input path).
  for (const theme of ['dark', 'light']) {
    const page = await setup(700, theme, { hasTouch: true });
    const label = 'held/touch/700/' + theme;
    const st = await displacedFit(page, label);
    await page.evaluate(() => { window.__heldChanges = []; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: st.cx, y: st.cy }] });
    await page.waitForTimeout(HOLD_MS);
    const during = await duringHold(page, label);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await releasedKeepsMin(page, label);
    await cdp.detach();
    cases.push({ width: 700, theme, input: 'touch', layout: 'fit (non-pan)', holdMs: HOLD_MS,
      displacementPx: Number(st.dx.toFixed(1)), spacingPx: Number(st.sp.toFixed(1)), rawFractionAtCentre: Number(st.rawF.toFixed(3)),
      springTargetDuringHold: Number(during.headTarget.toFixed(3)), hitBoxClearedDuringHold: true, heldPressKeptSelection: true });
    await page.close();
  }
  // Held press, THEN drag: once movement begins the continuous drag must
  // take over — the release commits the drag's resting period, not the
  // press-time target.
  for (const theme of ['dark', 'light']) {
    const page = await setup(700, theme);
    const label = 'held-then-drag/mouse/700/' + theme;
    const st = await displacedFit(page, label);
    await page.evaluate(() => { window.__heldChanges = []; });
    await page.mouse.move(st.cx, st.cy);
    await page.mouse.down();
    await page.waitForTimeout(700);
    const during = await duringHold(page, label);
    await page.mouse.move(st.cx + 2 * st.sp, st.cy, { steps: 10 });
    await page.waitForTimeout(300); // outlast the fling freshness window while still held
    const drag = await page.evaluate(() => { const r = window.__heldRiver;
      return { index: r.index, headTarget: r.head.target, changes: window.__heldChanges.slice() }; });
    assert.equal(drag.index, 4, label + ': the drag must scrub to the period under the pointer; got index ' + drag.index + ' (target ' + drag.headTarget.toFixed(3) + ')');
    assert.ok(drag.changes.some(c => c.how === 'scrub'), label + ': the drag must publish live scrub selections ' + JSON.stringify(drag.changes));
    await page.mouse.up();
    await settledAt(page, 4);
    const after = await page.evaluate(() => ({ index: window.__heldRiver.index, changes: window.__heldChanges.slice() }));
    assert.equal(after.index, 4, label + ': the release after a drag must commit the drag resting period, not the press-time target; got index ' + after.index);
    assert.equal(after.changes.at(-1).i, 4, label + ': the final commit must be the drag resting period ' + JSON.stringify(after.changes));
    cases.push({ width: 700, theme, input: 'mouse', layout: 'fit (non-pan)', holdMs: 700,
      displacementPx: Number(st.dx.toFixed(1)), spacingPx: Number(st.sp.toFixed(1)),
      springTargetDuringHold: Number(during.headTarget.toFixed(3)), dragTookOver: true, releaseCommittedDragPeriod: 4 });
    await page.close();
  }
  return cases;
}

async function proveOriginal({ open, capture }) {
  const originalJs = fs.readFileSync(path.join(__dirname, 'fixtures/g-blend-river-original.js'), 'utf8');
  const originalCss = fs.readFileSync(path.join(__dirname, 'fixtures/g-blend-river-original.css'), 'utf8');
  const results = [];
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    const page = await open(width, theme, { riverHarness: true });
    await page.addScriptTag({ content: originalJs });
    await page.addStyleTag({ content: originalCss + '\n.original-reference {--r-tile:28px;--river-bg:#0b0c10;--rx:0deg;--ry:0deg;--ease:cubic-bezier(.2,.8,.2,1);--ease-out:cubic-bezier(.16,1,.3,1);--ease-spring:cubic-bezier(.34,1.4,.64,1); } .original-reference .tile {border:0} @keyframes tile-in{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:rotateX(var(--rx)) rotateY(var(--ry))}} @media(max-width:759px){.original-reference .tile.t-river{height:152px;--r-tile:24px}}' });
    const setup = await page.evaluate(() => {
      // Fixed invented publications only. Never import the mockup's data.js or calculators.
      const periods = [
        ['2026-08-14','2026-08-27',1200,'healthy'], ['2026-08-28','2026-09-10',-420,'short'],
        ['2026-09-11','2026-09-24',0,'healthy'], ['2026-09-25','2026-10-08',700,'healthy'],
        ['2026-10-09','2026-10-22',-80,'short'], ['2026-10-23','2026-11-05',1500,'healthy'],
        ['2026-11-06','2026-11-19',300,'healthy'], ['2026-11-20','2026-12-03',900,'healthy'],
      ].map(([start,end,bad,state], i) => ({start,end,bad,state,role:i<2?'past':i===2?'current':'future'}));
      document.body.innerHTML = '<main id="river-pair"></main>';
      const tree = '<nav class="tile t-river"><div class="river" tabindex="0"><canvas class="river-canvas"></canvas><div class="river-slide"><div class="river-vals"></div><div class="months"></div></div><div class="playhead"><div class="playhead-pill"><span>Test publication</span><b>$0.00</b></div><span class="playhead-beam"></span><span class="playhead-orb"></span></div></div></nav>';
      const host = document.querySelector('main'); host.style.padding = '12px';
      const original = document.createElement('section'); original.className = 'original-reference'; original.innerHTML = '<p>Original source (dark river in both themes)</p>' + tree; host.appendChild(original);
      const candidate = document.createElement('section'); candidate.className = 'budget-bento atlas-g'; candidate.innerHTML = '<p>Atlas source port (' + document.documentElement.dataset.theme + ')</p><div class="g-river-wrap">' + tree + '</div>'; host.appendChild(candidate);
      const fmt = v => {const a=Math.abs(v),s=v<0?'−':'';return a>=999.5?s+'$'+(a/1000).toFixed(1).replace(/\.0$/,'')+'k':s+'$'+Math.round(a)};
      const events = {original:[],port:[]};
      const options = (section, kind) => ({el:section.querySelector('.river'),canvas:section.querySelector('canvas'),playhead:section.querySelector('.playhead'),pill:section.querySelector('.playhead-pill'),slide:section.querySelector('.river-slide'),monthsEl:section.querySelector('.months'),valsEl:section.querySelector('.river-vals'),periods:periods.map(p=>({...p})),index:2,cur:2,reduce:false,noIntro:false,fmt,onChange:(i,how)=>events[kind].push({i,how})});
      River.init(options(original,'original'));
      const port = BudgetRiver.create({...options(candidate,'port'),enabled:true,dark:document.documentElement.dataset.theme==='dark',knownRuns:[periods.map((_,i)=>i)]});
      window.__riverPair={original:River,port,events};
      const geometry = r => ({W:r.W,H:r.H,pad:r.padL,sp:r.sp,pan:r.pan,top:r.top,bot:r.bot,xs:r.xs,ys:r.ys,ms:r.ms,parts:r.parts.length,samples:[0,.5,1.5,3.2,6.6,7].map(f=>r.yAt(f))});
      return {original:geometry(River),port:geometry(port)};
    });
    // The port no longer shares the prototype's vertical geometry: Atlas
    // approved a ~25% shorter tile with rebalanced insets (2026-10-10), and
    // the fixture keeps the original 164/152px geometry. Horizontal layout,
    // run structure and behaviour must still match the prototype exactly, and
    // every vertical position of the port must be the prototype's position
    // affinely remapped from the old band onto the new band — the same value
    // domain through different insets, not a new curve.
    const { original, port } = setup;
    assert.deepEqual(
      { W: port.W, pad: port.pad, sp: port.sp, pan: port.pan, xs: port.xs, parts: port.parts },
      { W: original.W, pad: original.pad, sp: original.sp, pan: original.pan, xs: original.xs, parts: original.parts },
      'horizontal geometry and run structure at ' + width + '/' + theme);
    const portMobileJs = port.W < 640;
    assert.equal(port.H, width < 760 ? 114 : 123, 'approved port tile height at ' + width);
    assert.equal(port.top, portMobileJs ? 36 : 38, 'approved port top inset at ' + width);
    assert.equal(port.bot, port.H - (portMobileJs ? 49 : 51), 'approved port bottom inset at ' + width);
    assert.equal(original.top, 52, 'prototype top inset unchanged at ' + width);
    assert.equal(original.bot, original.H - (original.W < 640 ? 50 : 52), 'prototype bottom inset unchanged at ' + width);
    const remapY = y => port.top + (y - original.top) * (port.bot - port.top) / (original.bot - original.top);
    const remapped = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.05,
      label + ' at ' + width + '/' + theme + ': ' + actual + ' vs affine remap ' + expected);
    port.ys.forEach((y, i) => { if (y != null && original.ys[i] != null) remapped(y, remapY(original.ys[i]), 'curve y[' + i + ']'); });
    port.samples.forEach((y, i) => remapped(y, remapY(original.samples[i]), 'yAt sample[' + i + ']'));
    const slopeRatio = (port.bot - port.top) / (original.bot - original.top);
    port.ms.forEach((m, i) => assert.ok(Math.abs(m - original.ms[i] * slopeRatio) < 0.05,
      'slope m[' + i + '] at ' + width + '/' + theme + ': ' + m + ' vs scaled ' + (original.ms[i] * slopeRatio)));
    await page.waitForFunction(() => window.__riverPair.port.reveal === 1 && window.__riverPair.original.reveal === 1);
    // The canvases now have different heights, so a cross-canvas pixel diff is
    // meaningless. Pixel proof is the port's own determinism: a settled frame
    // redrawn at the same fixed time must reproduce exactly, and moving the
    // camera to another settled position must change the frame.
    const pixelProof = await page.evaluate(() => {
      const { port } = window.__riverPair;
      port.reduce = true; port.place(2); port.draw(12, 2);
      const grab = () => port.ctx.getImageData(0, 0, port.canvas.width, port.canvas.height).data;
      const a = grab(); port.place(2); port.draw(12, 2); const b = grab();
      let selfDifferences = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) selfDifferences++;
      port.place(3); port.draw(12, 3); const c = grab();
      let movedDifferences = 0; for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) movedDifferences++;
      port.place(2); port.draw(12, 2);
      return { selfDifferences, movedDifferences };
    });
    assert.equal(pixelProof.selfDifferences, 0, 'port static frame is deterministic at ' + width + '/' + theme);
    assert.ok(pixelProof.movedDifferences > 0, 'port frame changes with the camera at ' + width + '/' + theme);
    const staticPixels = pixelProof.selfDifferences;
    const pixels = { differences: pixelProof.movedDifferences };
    const input = async kind => {
      const rect = await page.evaluate(kind => {const r=window.__riverPair[kind],b=r.el.getBoundingClientRect();return{x:b.left+r.xc(2)-r.off,y:b.bottom-38,dx:r.pan?-r.sp:r.sp}},kind);
      await page.mouse.move(rect.x,rect.y);await page.mouse.down();await page.mouse.move(rect.x+rect.dx,rect.y,{steps:8});
      const held=await page.evaluate(kind=>({dragging:window.__riverPair[kind].dragging,events:window.__riverPair.events[kind]}),kind);
      assert.equal(held.dragging,true);assert.deepEqual(held.events.at(-1),{i:3,how:'scrub'});
      await page.mouse.up();return held;
    };
    const originalHeld=await input('original'),portHeld=await input('port');
    assert.deepEqual(portHeld,originalHeld,'matched held pointer inputs');
    // Use identical position springs, independently sampled from each actual controller.
    const spring=await page.evaluate(()=>{const{original,port}=window.__riverPair;original.head.set(0);port.head.set(0);original.head.target=port.head.target=7;const a=[],b=[];for(let i=0;i<80;i++){a.push(original.head.step(.016));b.push(port.head.step(.016))}return{a,b}});
    assert.deepEqual(spring.b,spring.a,'original spring sequence');
    await page.setViewportSize({width:width===1440?390:1440,height:1000});
    await page.waitForFunction(() => __riverPair.original.W===__riverPair.port.W);
    assert.equal(await page.evaluate(()=>__riverPair.original.sp===__riverPair.port.sp&&__riverPair.original.pan===__riverPair.port.pan),true,'resize agrees with original');
    await page.setViewportSize({width,height:1000});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>__riverPair.port.reduce);
    assert.equal(await page.evaluate(()=>__riverPair.port.head.settled&&__riverPair.port.reveal===1),true);
    assert.equal(await page.locator('.budget-bento .t-river').evaluate(el=>Number(getComputedStyle(el).opacity)),1,'reduced-motion selector stays visible');
    // Resize resets a canvas. Repaint both at the same fixed camera/time for
    // the paired capture; the original itself does not invalidate a settled reduced frame.
    await page.evaluate(()=>{for(const r of [__riverPair.original,__riverPair.port]){r.layout();r.head.set(3);r.index=3;r.mark(3);r.place(3);r.reveal=1;r.draw(12,3);r.pill.querySelector('b').textContent='$700.00'}});
    results.push({width,theme,geometryComparison:'horizontal identical; vertical affine remap onto approved insets',originalLiveInput:originalHeld,portLiveInput:portHeld,staticPixelDifferences:staticPixels,movingPixelDifferences:pixels.differences,springIdentical:true,resize:true,reducedMotion:true});
    if(capture)await capture(page,'budget-river-pair-'+width+'-'+theme+'.png');
    await page.close();
  }
  return results;
}

module.exports = { proveRiverPort, riverHarnessHtml };

if (require.main === module) {
  (async () => {
    const { chromium } = require('playwright');
    const root = path.resolve(__dirname, '..'), fx = require('./fixtures/budget-surface-data');
    // Optional recorded result (Systems Review 5480338180): with
    // RIVER_RESULT_JSON=<path>, the run's structured results are written to
    // that path, source-bound via test/proof-source-binding.js — the PASS is
    // then evidence in the receipt, not prose in a packet.
    const receiptPath = process.env.RIVER_RESULT_JSON || null;
    let binding = null, verifyBinding = null;
    if (receiptPath) {
      const sbl = require('./proof-source-binding');
      binding = sbl.captureSourceBinding(root, [
        'public/budget-river.js', 'public/budget-gface.css', 'public/budget-blend.css', 'public/budget-blend.js',
        'public/styles.css', 'public/fonts.css', 'public/index.html', 'public/plan.js', 'public/forecast.js',
        'test/browser-budget-river-port.js', 'test/proof-source-binding.js', 'test/fixtures/budget-surface-data.js',
      ], process.env.PROOF_BASE_SHA || null);
      verifyBinding = sbl.verifySourceBinding;
    }
    // Match the readability runner's renderer so pixel readbacks do not switch
    // between accelerated and software canvas output during the comparison.
    const renderer = { canvas: 'software', args: ['--disable-accelerated-2d-canvas'] };
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: renderer.args });
    try {
      const errors = [];
      const open = async (width, theme, options = {}) => {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: options.reducedMotion || 'no-preference', hasTouch: !!options.hasTouch });
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(chosen => localStorage.setItem('hfd-theme', chosen), theme);
        await page.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== 'http://budget.test') return route.abort();
          if (url.pathname === '/' && options.riverHarness) return route.fulfill({ body:riverHarnessHtml(theme),contentType:'text/html' });
          if (url.pathname === '/data.json') return route.fulfill({ json: options.data || fx.served(options) });
          if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
          const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
          const contentType = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html';
          return route.fulfill({ body: fs.readFileSync(file), contentType });
        });
        await page.goto('http://budget.test/'); if(!options.riverHarness)await page.locator('.river').waitFor();
        await page.evaluate(() => document.fonts.ready);
        return page;
      };
      const capture = process.env.RIVER_DEV_SHOTS ? async (page,file) => {fs.mkdirSync(process.env.RIVER_DEV_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.RIVER_DEV_SHOTS,file),fullPage:true,animations:'disabled'})} : null;
      const result = await proveRiverPort({ open, capture }); assert.deepEqual(errors, []);
      if (receiptPath) {
        verifyBinding(root, binding);
        fs.writeFileSync(receiptPath, JSON.stringify({
          proof: 'timeline-geometry-native-harness',
          harness: 'test/browser-budget-river-port.js',
          syntheticOnly: true,
          runtime: { node: process.version, chromium: await browser.version(), renderer },
          sourceBinding: { ...binding, unchangedAfterRun: true },
          results: result,
          pageErrors: errors,
          failures: [],
        }, null, 2));
      }
      console.log('PASS native river live drag: ' + result.nativeLiveDrag.length + ' viewport/theme cases, amount-label starts and retained controller across native remounts');
    } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
